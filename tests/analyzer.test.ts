import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { analyzeRepository, materializeSnapshot, resolveCommit } from '../src/analyzer.js';

test('analyzes committed behavior, import impact and mined promises without reading dirty edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofpatch-analysis-test-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    await writeFile(join(repo, 'auth.ts'), 'export function allowed(active:boolean, role:"admin"|"member"):boolean { if (!active) return false; return role === "admin"; }\nexport const removed=()=>1;');
    await writeFile(join(repo, 'route.ts'), 'import {allowed} from "./auth.js"; export const route=allowed;');
    await writeFile(join(repo, 'route.test.ts'), 'import {route} from "./route.js"; test("disabled users must never authenticate",()=>route(false,"admin"));');
    await writeFile(join(repo, 'README.md'), 'Accounts must never authenticate when disabled.');
    git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'auth.ts'), 'export function allowed(active:boolean, role:"admin"|"member"):boolean { return role === "admin"; }');
    git('add', '.'); git('commit', '-m', 'head'); const head = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'auth.ts'), 'DIRTY WORKTREE SHOULD NEVER APPEAR');
    const result = await analyzeRepository(repo, base, head);
    assert.equal(result.changes.length, 1); assert.equal(result.changes[0].path, 'auth.ts'); assert.ok(!result.changes[0].after.includes('DIRTY'));
    assert.ok(result.findings.some(f => f.title.includes('Export removed'))); assert.ok(result.findings.some(f => f.title.includes('Guard')));
    assert.ok(result.graph.edges.some(e => e.source === 'route.ts' && e.target === 'auth.ts'));
    assert.ok(result.graph.nodes.find(n => n.id === 'route.ts')?.impacted); assert.deepEqual(result.impactedTests, ['route.test.ts']);
    assert.ok(result.candidates.some(c => c.source === 'test')); assert.ok(result.candidates.some(c => c.source === 'type'));
    const symbol = result.symbols.find(s => s.name === 'allowed')!; assert.deepEqual(symbol.parameters[0].values, [false, true]); assert.deepEqual(symbol.parameters[1].values, ['admin', 'member']);
    await materializeSnapshot(repo, base, join(root, 'snapshot'));
    assert.match(await readFile(join(root, 'snapshot', 'auth.ts'), 'utf8'), /if \(!active\)/);
    await assert.rejects(() => materializeSnapshot(repo, base, join(root, 'snapshot')), /empty/);
    await assert.rejects(() => resolveCommit(repo, '--help'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('empty diffs stay empty and Git symlinks are not materialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofpatch-symlink-test-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); await writeFile(join(repo, 'x.ts'), 'export const f=()=>1'); await symlink('/etc/passwd', join(repo, 'outside')); git('add', '.'); git('commit', '-m', 'fixture');
    const a = await analyzeRepository(repo, 'HEAD', 'HEAD'); assert.equal(a.changes.length, 0); assert.ok(a.limitations.some(l => l.includes('symlinks')));
    await materializeSnapshot(repo, 'HEAD', join(root, 'out')); await assert.rejects(readFile(join(root, 'out', 'outside')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
