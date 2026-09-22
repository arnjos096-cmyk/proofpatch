import { build, type Plugin } from 'esbuild';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Constitution, Contract, ContractResult, Counterexample, ExecutionOptions, Json, Observation, SymbolInfo } from './types.js';

function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function jsonValue(v: unknown, depth = 0): v is Json {
  if (depth > 20) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 1000 && v.every(x => jsonValue(x, depth + 1));
  return object(v) && Object.keys(v).length <= 1000 && Object.values(v).every(x => jsonValue(x, depth + 1));
}
export function validateConstitution(value: unknown): Constitution {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.contracts) || value.contracts.length > 100) throw new Error('Expected { version: 1, contracts: [...] } with at most 100 contracts.');
  const ids = new Set<string>();
  for (const raw of value.contracts) {
    if (!object(raw)) throw new Error('Every contract must be an object.');
    for (const field of ['id', 'title', 'file', 'export']) if (typeof raw[field] !== 'string' || !raw[field] || raw[field].length > 500) throw new Error(`Contract ${field} must be a nonempty string of at most 500 characters.`);
    const file = raw.file as string;
    if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes('\\') || file.includes('\0') || file.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Contract file must be a safe relative path.');
    if (ids.has(raw.id as string)) throw new Error(`Duplicate contract id: ${raw.id}`);
    ids.add(raw.id as string);
    if (!Array.isArray(raw.arguments) || raw.arguments.length > 12 || !raw.arguments.every(d => Array.isArray(d) && d.length > 0 && d.length <= 100 && d.every(x => jsonValue(x)))) throw new Error(`Contract ${raw.id}: arguments must contain up to 12 nonempty JSON domains (maximum 100 values each).`);
    if (JSON.stringify(raw.arguments).length > 256 * 1024) throw new Error('Contract input domains exceed 256 KiB.');
    if (!object(raw.oracle) || !['preserve', 'equals', 'type', 'does-not-throw'].includes(String(raw.oracle.kind))) throw new Error(`Contract ${raw.id}: invalid oracle.`);
    if (raw.oracle.kind === 'equals' && !jsonValue(raw.oracle.value)) throw new Error('equals oracle requires a JSON value.');
    if (raw.oracle.kind === 'type' && !['string', 'number', 'boolean', 'object', 'array', 'null'].includes(String(raw.oracle.value))) throw new Error('type oracle requires a supported JSON type.');
    if (raw.maxCases !== undefined && (!Number.isSafeInteger(raw.maxCases) || Number(raw.maxCases) < 1 || Number(raw.maxCases) > 1000)) throw new Error('maxCases must be an integer from 1 to 1000.');
  }
  return value as unknown as Constitution;
}
export function generateConstitution(symbols: SymbolInfo[]): Constitution {
  return { version: 1, contracts: symbols.filter(s => s.exported && !/\.(test|spec)\./.test(s.file) && s.parameters.every(p => p.values.length > 0)).slice(0, 100).map((s, i) => ({ id: `preserve-${i + 1}-${s.name}`, title: `Review: preserve ${s.name} behavior on representative inputs`, file: s.file, export: s.name, arguments: s.parameters.map(p => p.values), oracle: { kind: 'preserve' } })) };
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function caseInputs(domains: Json[][], limit: number, seed: number): Json[][] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  let total = 1; for (const d of domains) total *= d.length;
  const results: Json[][] = [], seen = new Set<string>();
  const add = (args: Json[]) => { const key = stable(args); if (!seen.has(key) && results.length < limit) { seen.add(key); results.push(args); } };
  if (total <= limit) {
    const expand = (index: number, args: Json[]) => { if (index === domains.length) add(args); else for (const value of domains[index]) expand(index + 1, [...args, value]); };
    expand(0, []);
    // Seed affects order, never coverage, when the whole domain fits the budget.
    for (let i = results.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [results[i], results[j]] = [results[j], results[i]]; }
  } else {
    add(domains.map(d => d[0])); add(domains.map(d => d[d.length - 1]));
    for (let i = 0; i < limit * 50 && results.length < limit; i++) add(domains.map(d => d[Math.floor(random() * d.length)]));
  }
  return results;
}

const WORKER = `import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const safeError = e => { try { return String(e?.name || 'Error') + ': ' + String(e?.message || e); } catch { return 'Unprintable error'; } };
const emit = value => { writeFileSync(1, JSON.stringify(value)); process.exit(0); };
for (const key of ['log', 'info', 'debug', 'warn', 'error']) console[key] = () => {};
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 524288) emit({kind:'error',message:'Input too large'}); }
const { file, name, args } = JSON.parse(input);
let module; try { module = await import(pathToFileURL(file).href); } catch(e) { emit({kind:'error',message:'Module load failed: ' + safeError(e)}); }
if (typeof module[name] !== 'function') emit({kind:'error',message:'Named export is not a function: ' + name});
let result; try { result = await module[name](...args); } catch(e) { emit({kind:'throw',message:safeError(e)}); }
function check(v, seen = new Set(), depth = 0) {
 if (depth > 30) throw new Error('Result exceeds JSON depth limit');
 if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
 if (typeof v === 'number' && Number.isFinite(v)) return;
 if (typeof v !== 'object' || seen.has(v)) throw new Error('Result is not a finite, acyclic JSON value');
 if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Result has an unsupported object type');
 if (Object.getOwnPropertySymbols(v).length) throw new Error('Result contains symbol keys');
 seen.add(v);
 if (Array.isArray(v)) { for (let i=0;i<v.length;i++) check(v[i],seen,depth+1); }
 else { for (const key of Object.keys(v)) { const d=Object.getOwnPropertyDescriptor(v,key); if (!d || d.get || d.set) throw new Error('Result contains accessors'); check(d.value,seen,depth+1); } }
 seen.delete(v);
}
try { check(result); emit({kind:'return',value:result}); } catch(e) { emit({kind:'error',message:'Unsupported result: ' + safeError(e)}); }
`;

async function bundle(snapshot: string, file: string, output: string): Promise<void> {
  const root = await realpath(snapshot);
  const confined = async (filePath: string) => { const actual = await realpath(filePath); if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error('Module path escapes the committed snapshot.'); return actual; };
  const entry = await confined(path.resolve(root, file));
  const builtins = new Set([...builtinModules, ...builtinModules.map(x => 'node:' + x)]);
  const guard: Plugin = { name: 'snapshot-boundary', setup(api) {
    api.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.checked) return;
      if (builtins.has(args.path)) return { path: args.path, external: true };
      if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !path.isAbsolute(args.path)) return { errors: [{ text: `External package '${args.path}' is unavailable in the committed snapshot. Vendor a self-contained adapter.` }] };
      const resolution = await api.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { checked: true } });
      if (resolution.errors.length) return { errors: resolution.errors };
      try { return { path: await confined(resolution.path) }; } catch (e) { return { errors: [{ text: String(e) }] }; }
    });
  } };
  await build({ entryPoints: [entry], outfile: output, absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [guard], tsconfigRaw: { compilerOptions: {} }, sourcemap: false });
}

async function observe(directory: string, file: string, name: string, args: Json[], options: ExecutionOptions): Promise<Observation> {
  const container = `proofpatch-${randomUUID()}`;
  const docker = options.mode === 'docker';
  const command = docker ? 'docker' : process.execPath;
  const argv = docker ? ['run', '--rm', '--pull=never', '--name', container, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--cpus=1', '--user=65534:65534', '--mount', `type=bind,src=${directory},dst=/work,readonly`, '--workdir=/work', '-i', options.dockerImage || 'node:22-alpine', 'node', '--max-old-space-size=64', '/work/worker.mjs'] : ['--max-old-space-size=96', path.join(directory, 'worker.mjs')];
  return new Promise(resolve => {
    let finished = false, stdout = '', stderr = '', bytes = 0;
    const child = spawn(command, argv, { cwd: directory, detached: !docker && process.platform !== 'win32', env: { PATH: process.env.PATH || '/usr/bin:/bin', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => { try { if (!docker && process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
    const finish = (observation: Observation) => {
      if (finished) return; finished = true; clearTimeout(timer); kill();
      if (docker) { const cleanup = spawn('docker', ['rm', '-f', container], { stdio: 'ignore' }); cleanup.on('error', () => {}); cleanup.unref(); }
      resolve(observation);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout', message: `Execution exceeded ${options.timeoutMs} ms` }), options.timeoutMs);
    child.on('error', e => finish({ kind: 'error', message: `${command} failed: ${e.message}` }));
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) finish({ kind: 'error', message: 'Execution output exceeded 256 KiB' }); else stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) finish({ kind: 'error', message: 'Execution output exceeded 256 KiB' }); else stderr += chunk.toString(); });
    child.on('close', code => {
      if (finished) return;
      if (code !== 0) { finish({ kind: 'error', message: `Runtime exited ${code}: ${stderr.slice(0, 2000)}` }); return; }
      try {
        const value: unknown = JSON.parse(stdout);
        if (!object(value) || !['return', 'throw', 'error'].includes(String(value.kind)) || (value.kind === 'return' && !jsonValue(value.value)) || (value.kind !== 'return' && typeof value.message !== 'string')) throw new Error('Invalid observation');
        finish(value as unknown as Observation);
      } catch { finish({ kind: 'error', message: 'Runtime did not produce a valid JSON observation (possibly unexpected stdout).' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ file: docker ? '/work/' + path.basename(file) : file, name, args }));
  });
}
function compare(before: Observation, after: Observation, contract: Contract): 'pass' | 'fail' | 'error' {
  if (['error', 'timeout'].includes(before.kind) || ['error', 'timeout'].includes(after.kind)) return 'error';
  if (contract.oracle.kind === 'preserve') return stable(before) === stable(after) ? 'pass' : 'fail';
  if (after.kind !== 'return') return 'fail';
  if (contract.oracle.kind === 'does-not-throw') return 'pass';
  if (contract.oracle.kind === 'equals') return stable(after.value) === stable(contract.oracle.value) ? 'pass' : 'fail';
  const type = after.value === null ? 'null' : Array.isArray(after.value) ? 'array' : typeof after.value;
  return type === contract.oracle.value ? 'pass' : 'fail';
}
function complexity(value: Json): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number') return Math.abs(value);
  if (typeof value === 'string') return value.length;
  return JSON.stringify(value).length;
}
export async function runContracts(baseDir: string, headDir: string, constitution: Constitution, options: ExecutionOptions): Promise<ContractResult[]> {
  validateConstitution(constitution);
  if (!['local', 'docker'].includes(options.mode) || !Number.isSafeInteger(options.maxCases) || options.maxCases < 1 || options.maxCases > 1000 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000 || !Number.isSafeInteger(options.seed)) throw new Error('Invalid execution options.');
  const directory = await mkdtemp(path.join(tmpdir(), 'proofpatch-run-'));
  // Docker runs as an unprivileged user and needs to traverse only this generated directory.
  const { chmod } = await import('node:fs/promises'); await chmod(directory, 0o755);
  const results: ContractResult[] = [];
  const cache = new Map<string, Promise<[string, string]>>();
  try {
    await writeFile(path.join(directory, 'worker.mjs'), WORKER);
    for (const contract of constitution.contracts) {
      const started = performance.now();
      const result: ContractResult = { id: contract.id, title: contract.title, file: contract.file, export: contract.export, oracle: contract.oracle, status: 'passed', cases: 0, passed: 0, failed: 0, durationMs: 0 };
      try {
        if (!cache.has(contract.file)) { const index = cache.size; cache.set(contract.file, (async () => { const before = path.join(directory, `base-${index}.mjs`), after = path.join(directory, `head-${index}.mjs`); await bundle(baseDir, contract.file, before); await bundle(headDir, contract.file, after); return [before, after] as [string, string]; })()); }
        const [beforeFile, afterFile] = await cache.get(contract.file)!;
        const run = async (args: Json[]): Promise<Counterexample> => ({ arguments: args, before: await observe(directory, beforeFile, contract.export, args, options), after: await observe(directory, afterFile, contract.export, args, options), minimized: false });
        const cases = caseInputs(contract.arguments, Math.min(options.maxCases, contract.maxCases || options.maxCases), options.seed);
        for (const args of cases) {
          const observed = await run(args); result.cases++;
          const verdict = compare(observed.before, observed.after, contract);
          if (verdict === 'error') { result.status = 'error'; result.reason = [observed.before, observed.after].filter(o => o.kind === 'error' || o.kind === 'timeout').map(o => o.message).join('; '); break; }
          if (verdict === 'pass') result.passed++;
          else { result.failed++; result.counterexample ||= observed; }
        }
        if (result.failed) {
          result.status = 'failed';
          let counterexample = result.counterexample!, budget = 24;
          for (let parameter = 0; parameter < counterexample.arguments.length && budget > 0; parameter++) {
            const values = contract.arguments[parameter].filter(v => complexity(v) < complexity(counterexample.arguments[parameter])).sort((a, b) => complexity(a) - complexity(b));
            for (const value of values) {
              if (budget-- <= 0) break;
              const args = [...counterexample.arguments]; args[parameter] = value;
              const candidate = await run(args);
              if (compare(candidate.before, candidate.after, contract) === 'fail') { counterexample = { ...candidate, minimized: true }; break; }
            }
          }
          result.counterexample = counterexample;
        }
      } catch (e) { result.status = 'error'; result.reason = e instanceof Error ? e.message.slice(0, 2000) : String(e); }
      result.durationMs = Math.round(performance.now() - started); results.push(result);
    }
    return results;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
