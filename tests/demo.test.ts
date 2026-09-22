import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../src/demo.js';
import { verifyReceipt } from '../src/receipt.js';

test('end-to-end demo analyzes real commits, executes contracts, and emits a valid portable receipt', { timeout: 120000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'proofpatch-demo-test-'));
  try {
    const receipt = await runDemo(output);
    assert.equal(receipt.summary.verdict, 'regression');
    assert.equal(receipt.summary.failed, 3);
    assert.equal(receipt.summary.passed, 3);
    assert.equal(receipt.summary.skipped, 0);
    assert.notEqual(receipt.analysis.baseSha, receipt.analysis.headSha);
    assert.equal(receipt.analysis.changes.length, 2);
    assert.ok(receipt.analysis.impactedTests.includes('auth.test.ts'));
    const auth = receipt.execution.results.find(r => r.id === 'disabled-session')!;
    assert.deepEqual(auth.counterexample?.arguments, [false, true]);
    assert.equal(auth.counterexample?.before.value, false);
    assert.equal(auth.counterexample?.after.value, true);
    assert.equal(verifyReceipt(JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))).valid, true);
    assert.match(await readFile(join(output, 'index.html'), 'utf8'), /window.PROOFPATCH_RECEIPT=/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
