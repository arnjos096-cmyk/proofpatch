import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runContracts } from '../src/engine.js';

test('Docker runner reproduces a regression with its hardened container options', { skip: process.env.PROOFPATCH_DOCKER_TEST !== '1', timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofpatch-docker-test-'));
  try {
    const before = join(root, 'before'), after = join(root, 'after'); await mkdir(before); await mkdir(after);
    await writeFile(join(before, 'auth.ts'), 'export const allowed=(active:boolean,valid:boolean)=>active && valid;');
    await writeFile(join(after, 'auth.ts'), 'export const allowed=(active:boolean,valid:boolean)=>valid;');
    const [result] = await runContracts(before, after, { version: 1, contracts: [{ id: 'auth', title: 'Disabled accounts are rejected', file: 'auth.ts', export: 'allowed', arguments: [[false], [true]], oracle: { kind: 'equals', value: false } }] }, { mode: 'docker', timeoutMs: 15000, maxCases: 1, seed: 42 });
    assert.equal(result.status, 'failed', result.reason); assert.equal(result.counterexample?.before.value, false); assert.equal(result.counterexample?.after.value, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
