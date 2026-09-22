import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

test('CLI mines drafts, respects static mode, gates regressions, and verifies signed receipts', { timeout: 60000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'proofpatch-cli-test-'));
  const project = fileURLToPath(new URL('../', import.meta.url));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: project, encoding: 'utf8', timeout: 20000 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'ignore' });
  try {
    git('init'); await writeFile(join(repo, 'auth.ts'), 'export const allowed=(active:boolean):boolean=>active;'); git('add', '.'); git('commit', '-m', 'base');
    await writeFile(join(repo, 'auth.ts'), 'export const allowed=(active:boolean):boolean=>true;'); git('add', '.'); git('commit', '-m', 'regression');
    const draft = join(repo, 'draft.json'), out = join(repo, 'receipt');
    const mine = cli('mine', 'HEAD~1..HEAD', '--repo', repo, '--out', draft); assert.equal(mine.status, 0, mine.stderr); assert.equal(JSON.parse(await readFile(draft, 'utf8')).contracts.length, 1);
    const staticRun = cli('inspect', 'HEAD~1..HEAD', '--repo', repo, '--out', out); assert.equal(staticRun.status, 0, staticRun.stderr); assert.equal(JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8')).execution.mode, 'static');
    const executeWithoutContracts = cli('inspect', 'HEAD~1..HEAD', '--repo', repo, '--execute', 'local'); assert.equal(executeWithoutContracts.status, 2); assert.match(executeWithoutContracts.stderr, /requires --contracts/);
    const keys = join(repo, 'keys'); assert.equal(cli('keygen', '--out', keys).status, 0);
    const execution = cli('inspect', 'HEAD~1..HEAD', '--repo', repo, '--execute', 'local', '--contracts', draft, '--out', out, '--sign', join(keys, 'private.pem')); assert.equal(execution.status, 1, execution.stderr);
    const verify = cli('verify', join(out, 'receipt.json'), '--public-key', join(keys, 'public.pem')); assert.equal(verify.status, 0, verify.stderr); assert.match(verify.stdout, /trusted public key/);
    const noOverwrite = cli('mine', 'HEAD~1..HEAD', '--repo', repo, '--out', draft); assert.equal(noOverwrite.status, 2);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
