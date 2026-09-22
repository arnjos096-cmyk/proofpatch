import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runContracts, validateConstitution } from '../src/engine.js';
import type { Contract, ExecutionOptions } from '../src/types.js';

const options: ExecutionOptions = { mode: 'local', timeoutMs: 2000, maxCases: 64, seed: 42 };
const contract: Contract = { id: 'check', title: 'Preserve behavior', file: 'entry.ts', export: 'f', arguments: [[false, true]], oracle: { kind: 'preserve' } };
async function fixture(before: string, after: string, fn: (base: string, head: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'proofpatch-engine-test-'));
  const base = join(root, 'base'), head = join(root, 'head');
  try { await mkdir(base); await mkdir(head); await writeFile(join(base, 'entry.ts'), before); await writeFile(join(head, 'entry.ts'), after); await fn(base, head, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('finds an authentication regression, preserves harmless refactors, and supports async exports', async () => {
  await fixture('export async function f(active:boolean, valid:boolean){return active && valid}', 'export async function f(active:boolean, valid:boolean){return valid}', async (base, head) => {
    const [r] = await runContracts(base, head, { version: 1, contracts: [{ ...contract, arguments: [[false, true], [false, true]] }] }, options);
    assert.equal(r.status, 'failed'); assert.equal(r.cases, 4); assert.equal(r.failed, 1); assert.deepEqual(r.counterexample?.arguments, [false, true]);
  });
  await fixture('export const f=(x:boolean)=>x ? 1 : 0', 'export const f=(x:boolean)=>Number(x)', async (base, head) => {
    assert.equal((await runContracts(base, head, { version: 1, contracts: [contract] }, options))[0].status, 'passed');
  });
});
test('supports equals, type and does-not-throw without treating unsupported values as passes', async () => {
  await fixture('export const f=()=>false', 'export const f=()=>true', async (base, head) => {
    const checks: Contract[] = [{ ...contract, id: 'equals', arguments: [], oracle: { kind: 'equals', value: false } }, { ...contract, id: 'type', arguments: [], oracle: { kind: 'type', value: 'boolean' } }, { ...contract, id: 'returns', arguments: [], oracle: { kind: 'does-not-throw' } }];
    assert.deepEqual((await runContracts(base, head, { version: 1, contracts: checks }, options)).map(r => r.status), ['failed', 'passed', 'passed']);
  });
  for (const source of ['export const f=()=>undefined', 'export const f=()=>NaN', 'export const f=()=>1n', 'export const f=()=>new Date()', 'export const f=()=>{const x:any={};x.self=x;return x}']) {
    await fixture(source, source, async (base, head) => { const [r] = await runContracts(base, head, { version: 1, contracts: [{ ...contract, arguments: [] }] }, options); assert.equal(r.status, 'error', source); });
  }
});
test('equal thrown errors preserve behavior, different thrown errors fail', async () => {
  await fixture('export function f(){throw new Error("bad")}', 'export function f(){throw new Error("bad")}', async (base, head) => {
    assert.equal((await runContracts(base, head, { version: 1, contracts: [{ ...contract, arguments: [] }] }, options))[0].status, 'passed');
  });
  await fixture('export function f(){throw new Error("old")}', 'export function f(){throw new Error("new")}', async (base, head) => {
    assert.equal((await runContracts(base, head, { version: 1, contracts: [{ ...contract, arguments: [] }] }, options))[0].status, 'failed');
  });
});
test('a timeout and excess stdout are explicit runner errors', async () => {
  for (const source of ['export function f(){while(true){}}', 'export async function f(){await new Promise(r=>process.stdout.write("x".repeat(300000),r));return true}']) {
    await fixture('export const f=()=>true', source, async (base, head) => {
      const [r] = await runContracts(base, head, { version: 1, contracts: [{ ...contract, arguments: [] }] }, { ...options, timeoutMs: 500 });
      assert.equal(r.status, 'error'); assert.match(r.reason!, /exceeded/);
    });
  }
});
test('enforces finite case budgets and returns a within-domain minimized counterexample', async () => {
  await fixture('export const f=(n:number)=>Math.max(0,n)', 'export const f=(n:number)=>n', async (base, head) => {
    const c = { ...contract, arguments: [[-100, -10, -1, 0, 1]], maxCases: 1 };
    const [r] = await runContracts(base, head, { version: 1, contracts: [c] }, options);
    assert.equal(r.cases, 1); assert.equal(r.status, 'failed'); assert.deepEqual(r.counterexample?.arguments, [-1]); assert.equal(r.counterexample?.minimized, true);
  });
});
test('bundles relative TS modules and rejects symlink/import escapes and missing exports', async () => {
  const source = 'import {v} from "./dep.js"; export const f=()=>v';
  await fixture(source, source, async (base, head, root) => {
    await writeFile(join(base, 'dep.ts'), 'export const v=true'); await writeFile(join(head, 'dep.ts'), 'export const v=true');
    assert.equal((await runContracts(base, head, { version: 1, contracts: [contract] }, options))[0].status, 'passed');
    await writeFile(join(root, 'outside.ts'), 'export const f=()=>true');
    await symlink(join(root, 'outside.ts'), join(head, 'escape.ts'));
    const escape = { ...contract, file: 'escape.ts' };
    await symlink(join(root, 'outside.ts'), join(base, 'escape.ts'));
    const [r] = await runContracts(base, head, { version: 1, contracts: [escape] }, options); assert.equal(r.status, 'error'); assert.match(r.reason!, /escapes/);
    const [missing] = await runContracts(base, head, { version: 1, contracts: [{ ...contract, export: 'noSuchExport' }] }, options); assert.equal(missing.status, 'error');
  });
});
test('rejects malformed contracts, duplicate IDs, dangerous paths, and invalid execution options', async () => {
  for (const value of [null, {}, { version: 2, contracts: [] }, { version: 1, contracts: [contract, contract] }, { version: 1, contracts: [{ ...contract, file: '../secret.ts' }] }, { version: 1, contracts: [{ ...contract, arguments: [[]] }] }, { version: 1, contracts: [{ ...contract, oracle: { kind: 'eval' } }] }]) assert.throws(() => validateConstitution(value));
  await assert.rejects(() => runContracts('.', '.', { version: 1, contracts: [] }, { ...options, maxCases: 0 }));
});
