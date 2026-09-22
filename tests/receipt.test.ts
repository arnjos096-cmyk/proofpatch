import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, createReceipt, digestReceipt, renderHtml, signReceipt, verifyReceipt, writeReceipt } from '../src/receipt.js';
import { serveReport } from '../src/server.js';
import type { Analysis, ContractResult } from '../src/types.js';

const analysis: Analysis = { repository: 'example/repo', base: 'base', head: 'head', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), changes: [], symbols: [], graph: { nodes: [], edges: [] }, candidates: [], findings: [], impactedTests: [], limitations: [] };
const passed: ContractResult = { id: 'one', title: 'One contract', file: 'src/f.ts', export: 'f', oracle: { kind: 'preserve' }, status: 'passed', cases: 2, passed: 2, failed: 0, durationMs: 1 };

test('canonical payloads sort object keys recursively while preserving array order', () => {
  assert.equal(canonical({ z: { b: 2, a: 1 }, a: [3, 2] }), '{"a":[3,2],"z":{"a":1,"b":2}}');
  const receipt = createReceipt(analysis, [passed], 'local', 42, 2);
  const reordered = Object.fromEntries(Object.entries(receipt).reverse()) as typeof receipt;
  assert.equal(verifyReceipt(receipt).valid, true);
  receipt.integrity.signature = 'metadata is excluded';
  assert.equal(digestReceipt(receipt), receipt.integrity.digest);
  assert.equal(digestReceipt(reordered), receipt.integrity.digest);
});

test('static, no contracts, errors, warnings and failures never become misleading passes', () => {
  assert.equal(createReceipt(analysis, [], 'static', 42, 1).summary.verdict, 'review');
  assert.equal(createReceipt(analysis, [], 'local', 42, 1).summary.verdict, 'review');
  assert.equal(createReceipt(analysis, [{ ...passed, status: 'error', reason: 'timeout' }], 'local', 42, 1).summary.verdict, 'review');
  assert.equal(createReceipt({ ...analysis, findings: [{ id: 'x', severity: 'warning', title: 'Removed guard', detail: 'Review', file: 'f.ts' }] }, [passed], 'local', 42, 1).summary.verdict, 'review');
  assert.equal(createReceipt(analysis, [{ ...passed, status: 'failed', failed: 1 }], 'local', 42, 1).summary.verdict, 'regression');
  assert.equal(createReceipt(analysis, [passed], 'local', 42, 1).summary.verdict, 'passed');
});

test('changing a receipt breaks its digest and changing a digest breaks a trusted signature', () => {
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const wrong = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const receipt = signReceipt(createReceipt(analysis, [passed], 'local', 42, 2), keys.privateKey);
  assert.deepEqual([verifyReceipt(receipt, keys.publicKey).valid, verifyReceipt(receipt, keys.publicKey).trusted], [true, true]);
  assert.equal(verifyReceipt(receipt).trusted, false);
  assert.equal(verifyReceipt(receipt, wrong.publicKey).valid, false);
  receipt.summary.cases += 1;
  assert.equal(verifyReceipt(receipt, keys.publicKey).valid, false);
  receipt.integrity.digest = digestReceipt(receipt);
  assert.equal(verifyReceipt(receipt, keys.publicKey).valid, false);
  assert.equal(verifyReceipt(createReceipt(analysis, [], 'static', 42, 0), keys.publicKey).valid, false);
});

test('standalone HTML embeds data safely without depending on external style/script files', async () => {
  const receipt = createReceipt({ ...analysis, repository: '</script><img src=x onerror=alert(1)>' }, [passed], 'local', 42, 2);
  const html = await renderHtml(receipt);
  assert.ok(html.includes('window.PROOFPATCH_RECEIPT='));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!/src=["'](?:\.\/)?app\.js/.test(html));
  assert.ok(!/href=["'](?:\.\/)?style\.css/.test(html));
});

test('report server serves only report files and never exposes sibling files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proofpatch-report-test-'));
  const receipt = createReceipt(analysis, [], 'static', 42, 0);
  await writeReceipt(receipt, dir);
  const server = await serveReport(dir, 0);
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const response = await fetch(url);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.equal((await fetch(`${url}/receipt.json`)).status, 200);
    assert.equal((await fetch(`${url}/../package.json`)).status, 404);
    assert.equal((await fetch(`${url}/%2e%2e%2fpackage.json`)).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    assert.match(await readFile(join(dir, 'summary.md'), 'utf8'), /Static only/);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await rm(dir, { recursive: true, force: true }); }
});
