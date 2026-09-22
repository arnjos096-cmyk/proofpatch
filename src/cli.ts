#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { analyzeRepository, materializeSnapshot } from './analyzer.js';
import { runContracts, validateConstitution, generateConstitution } from './engine.js';
import { createReceipt, signReceipt, verifyReceipt, writeReceipt } from './receipt.js';
import { serveReport } from './server.js';
import { runDemo } from './demo.js';
import type { Receipt } from './types.js';

const HELP = `
  PROOFPATCH  /  executable evidence for every diff

  proofpatch demo [--serve]                  Run the real, deliberately broken demo
  proofpatch inspect BASE..HEAD [options]    Analyze committed snapshots
  proofpatch mine BASE..HEAD [--out FILE]    Draft contracts for human review
  proofpatch serve [--out DIRECTORY]        Explore a saved receipt on localhost
  proofpatch verify RECEIPT [--public-key FILE]
  proofpatch keygen --out DIRECTORY         Create an Ed25519 signing key pair

  --repo PATH              Repository (default: current directory)
  --base REF --head REF     Alternative to BASE..HEAD (default: HEAD~1 / HEAD)
  --contracts FILE         Reviewed version-1 constitution JSON
  --execute local|docker   Explicitly execute target code; default is static only
  --out DIRECTORY          Receipt output (default: .proofpatch)
  --serve                  Open local report server after inspecting
  --port NUMBER            Server port (default: 4317)
  --seed NUMBER            Reproducible case ordering (default: 42)
  --max-cases NUMBER       Per-contract input budget (default: 64, maximum: 1000)
  --timeout NUMBER         Per-execution timeout in ms (default: 2000)
  --sign FILE              Sign receipt with an Ed25519 private PEM key
  --fail-on-review         Exit 2 when analysis is incomplete or needs review

  Local execution is for trusted code. Passing finite cases is not formal proof.
  Exit codes: 0 complete/no regression; 1 regression; 2 error/review gate.
`;

function integer(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Expected an integer between 1 and ${max}, received ${value}`);
  return n;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, contracts: { type: 'string' }, execute: { type: 'string' }, out: { type: 'string' }, serve: { type: 'boolean' }, port: { type: 'string' }, seed: { type: 'string' }, timeout: { type: 'string' }, 'max-cases': { type: 'string' }, sign: { type: 'string' }, 'public-key': { type: 'string' }, 'fail-on-review': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  const [command, range] = positionals;
  if (v.version) { console.log('proofpatch 0.1.0'); return 0; }
  if (v.help || !command) { console.log(HELP); return 0; }
  const out = resolve(v.out || '.proofpatch');
  const startServer = async () => { const port = integer(v.port, 4317, 65535); await serveReport(out, port, process.env.PROOFPATCH_HOST || '127.0.0.1'); console.log(`\n  Evidence explorer → http://127.0.0.1:${port}\n  Press Ctrl+C to stop.\n`); };
  if (command === 'serve') { await startServer(); return 0; }
  if (command === 'verify') {
    if (!range) throw new Error('Usage: proofpatch verify path/to/receipt.json [--public-key key.pem]');
    const result = verifyReceipt(JSON.parse(await readFile(resolve(range), 'utf8')), v['public-key'] ? await readFile(resolve(v['public-key']), 'utf8') : undefined);
    console.log(result.message); return result.valid ? 0 : 2;
  }
  if (command === 'keygen') {
    if (!v.out) throw new Error('Choose a private key directory using --out. Keep it outside your repository.');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await mkdir(out, { recursive: true, mode: 0o700 });
    await writeFile(join(out, 'private.pem'), privateKey, { flag: 'wx', mode: 0o600 });
    await writeFile(join(out, 'public.pem'), publicKey, { flag: 'wx' });
    console.log(`Keys created in ${out}. Share public.pem; keep private.pem private.`); return 0;
  }
  let receipt: Receipt;
  if (command === 'demo') {
    console.log('\n  Running the bundled authentication regression experiment…');
    receipt = await runDemo(out);
  } else if (command === 'inspect' || command === 'mine') {
    const repo = resolve(v.repo || '.');
    let base = v.base || 'HEAD~1', head = v.head || 'HEAD';
    if (range) { if (range.includes('...') || range.split('..').length !== 2 || range.split('..').some(x => !x)) throw new Error('Use a two-dot range BASE..HEAD, or --base and --head.'); [base, head] = range.split('..'); }
    if (v.execute && v.execute !== 'local' && v.execute !== 'docker') throw new Error('--execute must be local or docker');
    const started = performance.now();
    console.log(`\n  Reading committed snapshots ${base} → ${head}…`);
    const analysis = await analyzeRepository(repo, base, head);
    if (command === 'mine') {
      const changed = new Set(analysis.changes.flatMap(f => f.symbols.map(s => `${f.path}:${s}`)));
      const draft = generateConstitution(analysis.symbols.filter(s => changed.has(`${s.file}:${s.name}`)));
      const file = resolve(v.out || 'proofpatch.contracts.draft.json'); await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' });
      console.log(`Drafted ${draft.contracts.length} candidate contracts → ${file}\nReview domains and intent before execution. Existing behavior may itself be wrong.`); return 0;
    }
    const seed = integer(v.seed, 42, 2147483647), maxCases = integer(v['max-cases'], 64, 1000), timeoutMs = integer(v.timeout, 2000, 60000);
    let results: Receipt['execution']['results'] = [];
    if (v.execute) {
      if (!v.contracts) throw new Error('Execution requires --contracts FILE with reviewed domains and oracles. Run mine to create a draft.');
      const constitution = validateConstitution(JSON.parse(await readFile(resolve(v.contracts), 'utf8')));
      if (v.execute === 'local') console.log('  Local mode: running trusted code with your user privileges.');
      const temp = await mkdtemp(join(tmpdir(), 'proofpatch-inspect-'));
      try {
        const before = join(temp, 'base'), after = join(temp, 'head');
        await materializeSnapshot(repo, analysis.baseSha, before); await materializeSnapshot(repo, analysis.headSha, after);
        results = await runContracts(before, after, constitution, { mode: v.execute as 'local' | 'docker', seed, maxCases, timeoutMs });
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    receipt = createReceipt(analysis, results, v.execute as 'local' | 'docker' || 'static', seed, performance.now() - started);
    if (v.sign) signReceipt(receipt, await readFile(resolve(v.sign), 'utf8'));
    await writeReceipt(receipt, out);
  } else throw new Error(`Unknown command: ${command}. Use --help.`);
  const s = receipt.summary;
  console.log(`\n  ${s.verdict.toUpperCase()} · ${s.passed} passed · ${s.failed} failed · ${s.skipped} incomplete · ${s.cases} cases\n  Receipt → ${join(out, 'index.html')}\n  SHA-256 → ${receipt.integrity.digest}\n`);
  if (v.serve) await startServer();
  return command === 'demo' ? 0 : s.failed ? 1 : s.skipped || (v['fail-on-review'] && s.verdict === 'review') ? 2 : 0;
}

main().then(code => { process.exitCode = code; }).catch((error: unknown) => { console.error(`\n  ProofPatch: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
