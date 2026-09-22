import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { analyzeRepository, materializeSnapshot } from './analyzer.js';
import { runContracts, validateConstitution } from './engine.js';
import { createReceipt, writeReceipt } from './receipt.js';
import type { Receipt } from './types.js';

export async function runDemo(out: string): Promise<Receipt> {
  const temp = await mkdtemp(join(tmpdir(), 'proofpatch-demo-'));
  const example = fileURLToPath(new URL('../examples/auth-service/', import.meta.url));
  const repo = join(temp, 'auth-service');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=ProofPatch Demo', '-c', 'user.email=demo@proofpatch.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await mkdir(repo); git('init', '-b', 'main');
    await cp(join(example, 'base'), repo, { recursive: true });
    for (const name of ['routes.ts', 'auth.test.ts', 'proofpatch.contracts.json']) await cp(join(example, name), join(repo, name));
    await writeFile(join(repo, 'README.md'), '# Session service\n\nDisabled accounts must never refresh a session. Retry delays must never be negative.\n');
    git('add', '.'); git('commit', '-m', 'Establish session invariants');
    const base = git('rev-parse', 'HEAD');
    await cp(join(example, 'head'), repo, { recursive: true });
    git('add', '.'); git('commit', '-m', 'Optimize refresh tokens and retry scheduling');
    const head = git('rev-parse', 'HEAD');
    const started = performance.now();
    const analysis = await analyzeRepository(repo, base, head);
    analysis.repository = 'demo/auth-service'; analysis.base = 'before-optimization'; analysis.head = 'after-optimization';
    const before = join(temp, 'before'), after = join(temp, 'after');
    await materializeSnapshot(repo, base, before); await materializeSnapshot(repo, head, after);
    const contracts = validateConstitution(JSON.parse(await readFile(join(example, 'proofpatch.contracts.json'), 'utf8')));
    const results = await runContracts(before, after, contracts, { mode: 'local', timeoutMs: 2000, maxCases: 64, seed: 42 });
    const receipt = createReceipt(analysis, results, 'local', 42, performance.now() - started);
    await writeReceipt(receipt, out);
    return receipt;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
