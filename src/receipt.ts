import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Analysis, ContractResult, Receipt } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function digestReceipt(receipt: Omit<Receipt, 'integrity'> | Receipt): string {
  const { integrity: _, ...payload } = receipt as Receipt;
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
export function createReceipt(analysis: Analysis, results: ContractResult[], mode: Receipt['execution']['mode'], seed: number, durationMs: number): Receipt {
  const failed = results.filter(r => r.status === 'failed').length;
  const passed = results.filter(r => r.status === 'passed').length;
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'error').length;
  const receipt: Receipt = {
    schemaVersion: 1, id: `pp-${analysis.headSha.slice(0, 8)}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(), tool: { name: 'proofpatch', version: '0.1.0' }, analysis,
    execution: { mode, seed, durationMs: Math.round(durationMs), results },
    summary: { verdict: failed ? 'regression' : mode === 'static' || skipped || !results.length || analysis.findings.some(f => f.severity !== 'info') ? 'review' : 'passed', contracts: results.length, passed, failed, skipped, cases: results.reduce((s, r) => s + r.cases, 0) },
    integrity: { algorithm: 'sha256', digest: '' },
    limitations: [...analysis.limitations, 'Passing finite test cases is evidence, not a proof of correctness or security.', 'A preserve contract flags behavioral differences; an intentional change may require a new explicit contract.', 'Contracts are supplied or reviewed by a person. Mined candidates are suggestions, not established requirements.', 'Only recorded return values and thrown errors are compared. Filesystem, network, timing, database and other side effects are not verified.', mode === 'local' ? 'Local execution runs trusted repository code with your user privileges. A child process is not a security sandbox.' : mode === 'docker' ? 'Docker reduces exposure but is not a guarantee against hostile code or kernel vulnerabilities.' : 'Static analysis only: no behavioral contracts were executed.'],
  };
  receipt.integrity.digest = digestReceipt(receipt);
  return receipt;
}
export function signReceipt(receipt: Receipt, privateKey: string): Receipt {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Receipt signing requires an Ed25519 private key.');
  receipt.integrity.digest = digestReceipt(receipt);
  receipt.integrity.signature = sign(null, Buffer.from(receipt.integrity.digest, 'hex'), key).toString('base64');
  receipt.integrity.publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  return receipt;
}
export function verifyReceipt(receipt: Receipt, trustedPublicKey?: string): { valid: boolean; signed: boolean; trusted: boolean; message: string } {
  if (receipt?.schemaVersion !== 1 || receipt.integrity?.algorithm !== 'sha256') return { valid: false, signed: false, trusted: false, message: 'Unsupported receipt format.' };
  if (digestReceipt(receipt) !== receipt.integrity.digest) return { valid: false, signed: false, trusted: false, message: 'Digest mismatch: the receipt was changed or is corrupt.' };
  if (!receipt.integrity.signature) return { valid: !trustedPublicKey, signed: false, trusted: false, message: trustedPublicKey ? 'A trusted signature was required, but this receipt is unsigned.' : 'SHA-256 digest matches. This unsigned receipt does not authenticate an author.' };
  try {
    const key = trustedPublicKey || receipt.integrity.publicKey;
    if (!key) throw new Error('No public key.');
    const ok = verify(null, Buffer.from(receipt.integrity.digest, 'hex'), key, Buffer.from(receipt.integrity.signature, 'base64'));
    return { valid: ok, signed: ok, trusted: ok && !!trustedPublicKey, message: ok ? trustedPublicKey ? 'Digest and signature verified against your trusted public key.' : 'Digest and embedded signature match. Author identity has not been independently trusted.' : 'Signature verification failed.' };
  } catch { return { valid: false, signed: false, trusted: false, message: 'Invalid signature or public key.' }; }
}
export async function renderHtml(receipt: Receipt): Promise<string> {
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const [html, css, js] = await Promise.all([readFile(join(web, 'index.html'), 'utf8'), readFile(join(web, 'style.css'), 'utf8'), readFile(join(web, 'app.js'), 'utf8')]);
  const data = JSON.stringify(JSON.stringify(receipt)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return html.replace(/<link\b[^>]*href=["'](?:\.\/)?style\.css["'][^>]*>/, () => `<style>${css}</style>`).replace(/<script\b[^>]*src=["'](?:\.\/)?app\.js["'][^>]*>\s*<\/script>/, '').replace('</body>', () => `<script>window.PROOFPATCH_RECEIPT=JSON.parse(${data});</script><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body>`);
}
export function renderMarkdown(receipt: Receipt): string {
  const { summary: s, analysis: a } = receipt;
  const escape = (v: string) => v.replace(/[\r\n|]/g, ' ').replace(/`/g, "'");
  return `## ProofPatch · ${s.verdict.toUpperCase()}\n\n\`${a.baseSha.slice(0, 8)} → ${a.headSha.slice(0, 8)}\` · ${a.changes.length} changed files · ${s.cases} recorded cases\n\n| Contract | Status | Cases |\n|:--|:--|--:|\n${receipt.execution.results.map(r => `| ${escape(r.title)} | ${r.status} | ${r.cases} |`).join('\n')}\n\n${receipt.execution.mode === 'static' ? '**Static only. No target code executed.**' : 'Passing cases are finite evidence, not a proof of correctness.'}\n\nSHA-256: \`${receipt.integrity.digest}\`\n`;
}
export async function writeReceipt(receipt: Receipt, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'), writeFile(join(directory, 'index.html'), await renderHtml(receipt)), writeFile(join(directory, 'summary.md'), renderMarkdown(receipt))]);
}
