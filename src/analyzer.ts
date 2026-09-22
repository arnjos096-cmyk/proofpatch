import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import type { Analysis, Candidate, FileChange, Json, Parameter, StaticFinding, SymbolInfo } from './types.js';

const execFileAsync = promisify(execFile);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST = /(?:^|\/)(?:__tests__|tests?|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
interface Entry { mode: string; type: string; sha: string; file: string }
interface Module { file: string; text: string; ast: ts.SourceFile; symbols: SymbolInfo[]; guards: Map<string, string[]>; imports: string[] }

/** Git always receives an argument array; neither revisions nor file names enter a shell. */
async function git(repo: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return result.stdout;
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(`Git ${args[0]} failed: ${(detail.stderr || detail.message).trim()}`);
  }
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (!ref || ref.includes('\0') || ref.length > 1024) throw new Error('A non-empty Git revision of at most 1024 characters is required.');
  const sha = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`Revision did not resolve to a commit: ${ref}`);
  return sha;
}

async function tree(repo: string, sha: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for (const record of (await git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0')) {
    if (!record) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Unexpected Git tree entry.');
    entries.set(match[4], { mode: match[1], type: match[2], sha: match[3], file: match[4] });
  }
  return entries;
}

function regular(entry: Entry | undefined): entry is Entry { return !!entry && entry.type === 'blob' && /^(100644|100755)$/.test(entry.mode); }
async function blob(repo: string, entry: Entry | undefined): Promise<string> {
  if (!regular(entry)) return '';
  const size = Number((await git(repo, ['cat-file', '-s', entry.sha])).trim());
  if (size > MAX_TEXT_BYTES) return '';
  const text = await git(repo, ['cat-file', 'blob', entry.sha], MAX_TEXT_BYTES + 1024);
  return text.includes('\0') ? '' : text;
}

/** Extract committed regular files without executing hooks, tar, or following tree symlinks. */
export async function materializeSnapshot(repo: string, ref: string, destination: string): Promise<void> {
  const sha = await resolveCommit(repo, ref);
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(root)).length !== 0) throw new Error('Snapshot destination must be an empty, non-symlink directory.');
  const entries = await tree(repo, sha);
  if (entries.size > 20000) throw new Error('Snapshot exceeds the 20,000-file execution limit.');
  let total = 0;
  for (const entry of entries.values()) {
    if (!regular(entry)) continue;
    const segments = entry.file.split('/');
    if (path.isAbsolute(entry.file) || entry.file.includes('\\') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) throw new Error(`Unsafe path in Git tree: ${entry.file}`);
    const target = path.resolve(root, ...segments);
    if (!target.startsWith(root + path.sep)) throw new Error(`Snapshot path escapes its destination: ${entry.file}`);
    const size = Number((await git(repo, ['cat-file', '-s', entry.sha])).trim());
    total += size;
    if (size > 16 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error('Snapshot exceeds the 16 MiB per-file or 128 MiB total execution limit.');
    const { stdout } = await execFileAsync('git', ['-C', repo, 'cat-file', 'blob', entry.sha], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 + 1024 });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, stdout, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
}

function printed(node: ts.Node, ast: ts.SourceFile): string { return printer.printNode(ts.EmitHint.Unspecified, node, ast).trim(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function id(value: string): string { return hash(value).slice(0, 16); }
function line(ast: ts.SourceFile, node: ts.Node): number { return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1; }
function hasExport(node: ts.Node): boolean { return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword); }
function hasDefault(node: ts.Node): boolean { return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword); }
function unique(values: Json[]): Json[] { return [...new Map(values.map(value => [JSON.stringify(value), value])).values()].slice(0, 32); }

function literalValue(node: ts.Expression): Json | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return node.operator === ts.SyntaxKind.MinusToken ? -Number(node.operand.text) : Number(node.operand.text);
  return undefined;
}

function domain(type: ts.TypeNode | undefined, aliases: Map<string, ts.TypeNode>, depth = 0): Json[] {
  if (!type || depth > 4) return [];
  if (ts.isParenthesizedTypeNode(type)) return domain(type.type, aliases, depth + 1);
  if (ts.isUnionTypeNode(type)) return unique(type.types.flatMap(member => domain(member, aliases, depth + 1)));
  if (ts.isLiteralTypeNode(type)) { const value = literalValue(type.literal); return value === undefined ? [] : [value]; }
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return [false, true];
  if (type.kind === ts.SyntaxKind.NumberKeyword) return [0, 1, -1, 2, 0.5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
  if (type.kind === ts.SyntaxKind.StringKeyword) return ['', 'a', 'test', ' ', '0', 'é'];
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && aliases.has(type.typeName.text)) return domain(aliases.get(type.typeName.text), aliases, depth + 1);
  if (ts.isArrayTypeNode(type)) {
    const values = domain(type.elementType, aliases, depth + 1);
    return values.length ? [[], [values[0]], values.slice(0, 3)] : [[]];
  }
  if (ts.isTypeLiteralNode(type)) {
    const value: Record<string, Json> = {};
    const variants: Json[] = [];
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) return [];
      const values = domain(member.type, aliases, depth + 1);
      if (!values.length) { if (member.questionToken) continue; return []; }
      value[member.name.text] = values[0];
    }
    variants.push(value);
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) continue;
      for (const variant of domain(member.type, aliases, depth + 1).slice(1, 4)) variants.push({ ...value, [member.name.text]: variant });
    }
    return unique(variants);
  }
  return [];
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

function parseModule(file: string, text: string): Module {
  const kind = /\.[cm]?jsx?$/i.test(file) ? (file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : (file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const aliases = new Map<string, ts.TypeNode>();
  const exports = new Map<string, string[]>();
  const imports: string[] = [];
  const symbols: SymbolInfo[] = [];
  const guards = new Map<string, string[]>();
  for (const statement of ast.statements) {
    if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type);
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
      const local = (element.propertyName || element.name).text;
      exports.set(local, [...(exports.get(local) || []), element.name.text]);
    }
  }
  const add = (localName: string, fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, owner: ts.Node, direct: boolean) => {
    if (!fn.body) return;
    const names = [...(direct ? [hasDefault(owner) ? 'default' : localName] : []), ...(exports.get(localName) || [])];
    const parameters: Parameter[] = fn.parameters.map(parameter => ({ name: parameter.name.getText(ast), type: parameter.type?.getText(ast) || (parameter.initializer ? typeof literalValue(parameter.initializer) : 'unknown'), optional: !!parameter.questionToken || !!parameter.initializer, values: parameter.dotDotDotToken ? [] : parameter.type ? domain(parameter.type, aliases) : parameter.initializer ? domainFromInitializer(parameter.initializer) : [] }));
    const functionGuards: string[] = [];
    const visitGuards = (node: ts.Node) => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        let exits = false;
        const inspect = (child: ts.Node) => { if (ts.isThrowStatement(child) || ts.isReturnStatement(child)) exits = true; if (!ts.isFunctionLike(child)) ts.forEachChild(child, inspect); };
        inspect(node.thenStatement);
        if (exits) functionGuards.push(printed(node.expression, ast));
      }
      if (ts.isCallExpression(node) && /^(?:assert|invariant|assert\.[\w]+)$/.test(node.expression.getText(ast))) functionGuards.push(printed(node, ast));
      ts.forEachChild(node, visitGuards);
    };
    visitGuards(fn.body);
    for (const name of new Set(names)) {
      const signature = `${name}${fn.typeParameters ? `<${fn.typeParameters.map(p => printed(p, ast)).join(', ')}>` : ''}(${fn.parameters.map(p => printed(p, ast)).join(', ')}): ${fn.type ? printed(fn.type, ast) : 'inferred'}`;
      symbols.push({ name, file, line: line(ast, owner), signature, exported: true, parameters, returnType: fn.type?.getText(ast) || 'inferred', bodyHash: hash(printed(fn.body, ast)) });
      guards.set(name, functionGuards);
    }
  };
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) add(statement.name?.text || 'default', statement, statement, hasExport(statement));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) add(declaration.name.text, initializer, statement, hasExport(statement));
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrap(statement.expression);
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) add('default', expression, statement, true);
    }
  }
  const visitImports = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visitImports);
  };
  visitImports(ast);
  return { file, text, ast, symbols, guards, imports: [...new Set(imports)] };
}

function domainFromInitializer(expression: ts.Expression): Json[] {
  const value = literalValue(expression);
  if (typeof value === 'boolean') return [false, true];
  if (typeof value === 'number') return unique([value, 0, 1, -1, 2]);
  if (typeof value === 'string') return unique([value, '', 'a', ' ']);
  return value === null ? [null] : [];
}

function resolveImport(file: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const candidates = [stem];
  if (/\.[cm]?jsx?$/.test(stem)) candidates.push(stem.replace(/\.js$/, '.ts'), stem.replace(/\.js$/, '.tsx'), stem.replace(/\.jsx$/, '.tsx'), stem.replace(/\.mjs$/, '.mts'), stem.replace(/\.cjs$/, '.cts'));
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(stem + extension, stem + '/index' + extension);
  return candidates.find(candidate => files.has(candidate));
}

function testCandidates(module: Module): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(?:it|test)(?:\.(?:only|skip|todo|concurrent))?$/.test(node.expression.getText(module.ast)) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const title = node.arguments[0].text;
      candidates.push({ id: id(`${module.file}:test:${node.pos}:${title}`), file: module.file, symbol: '', title, source: 'test', evidence: node.getText(module.ast).slice(0, 600), line: line(module.ast, node), status: 'suggested' });
    }
    ts.forEachChild(node, visit);
  };
  visit(module.ast);
  return candidates;
}

export async function analyzeRepository(repo: string, base: string, head: string): Promise<Analysis> {
  const repository = path.resolve(repo);
  const [baseSha, headSha] = await Promise.all([resolveCommit(repository, base), resolveCommit(repository, head)]);
  const [beforeTree, afterTree] = await Promise.all([tree(repository, baseSha), tree(repository, headSha)]);
  const findings: StaticFinding[] = [];
  const limitations = [
    'Static findings and mined candidates are review suggestions, not proof of correctness. No confidence percentage is inferred.',
    'Analysis reads committed snapshots only; uncommitted working-tree changes are excluded.',
    'The impact graph resolves relative literal imports and re-exports. Package aliases, tsconfig paths, computed imports, and runtime dependency injection are not resolved.',
    'Callable extraction supports top-level exported functions and function-valued variables; classes, CommonJS exports, higher-order wrappers, and re-exported callable signatures are not modeled.',
    'Input domains are representative JSON values, not exhaustive. Undefined, bigint, symbols, functions, cyclic objects, and many complex TypeScript types are not generated.',
    'Binary files and text blobs larger than 2 MiB are not analyzed. Git symlinks and submodules are neither followed nor extracted for execution.',
    'Existing test descriptions are mined as suggestions; the repository test suite is not automatically executed.',
  ];
  const allPaths = new Set([...beforeTree.keys(), ...afterTree.keys()]);
  const changed = [...allPaths].filter(file => beforeTree.get(file)?.sha !== afterTree.get(file)?.sha || beforeTree.get(file)?.mode !== afterTree.get(file)?.mode).sort();
  const needed = [...allPaths].filter(file => SOURCE.test(file) || /(?:^|\/)README(?:\.[^/]*)?$/i.test(file) || changed.includes(file));
  if (needed.length > 5000) throw new Error('Repository exceeds the 5,000 source/changed-file analysis limit. Narrow the repository before analysis.');
  const beforeTexts = new Map<string, string>();
  const afterTexts = new Map<string, string>();
  // Batches keep process count bounded even in a large repository.
  for (let offset = 0; offset < needed.length; offset += 12) await Promise.all(needed.slice(offset, offset + 12).map(async file => {
    const beforeEntry = beforeTree.get(file), afterEntry = afterTree.get(file);
    const before = await blob(repository, beforeEntry);
    const after = beforeEntry?.sha === afterEntry?.sha ? before : await blob(repository, afterEntry);
    if (changed.includes(file) && ((!before && regular(beforeEntry)) || (!after && regular(afterEntry)))) {
      const skipped = ((!before && regular(beforeEntry) && Number((await git(repository, ['cat-file', '-s', beforeEntry.sha])).trim()) > 0) || (!after && regular(afterEntry) && Number((await git(repository, ['cat-file', '-s', afterEntry.sha])).trim()) > 0));
      if (skipped) findings.push({ id: id(`${file}:skipped`), severity: 'warning', title: 'Changed content omitted from text analysis', detail: 'At least one version is binary or exceeds the 2 MiB text-analysis limit.', file });
    }
    beforeTexts.set(file, before); afterTexts.set(file, after);
  }));
  const beforeModules = new Map<string, Module>();
  const afterModules = new Map<string, Module>();
  for (const file of needed) if (SOURCE.test(file)) {
    if (regular(beforeTree.get(file))) beforeModules.set(file, parseModule(file, beforeTexts.get(file) || ''));
    if (regular(afterTree.get(file))) afterModules.set(file, parseModule(file, afterTexts.get(file) || ''));
  }
  for (const [snapshot, modules] of [['base', beforeModules], ['head', afterModules]] as const) for (const module of modules.values()) {
    const diagnostics = (module.ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) findings.push({ id: id(`${snapshot}:${module.file}:parse`), severity: 'warning', title: `Syntax could not be fully parsed (${snapshot})`, detail: ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' '), file: module.file });
  }
  const changes: FileChange[] = [];
  for (const file of changed) {
    const before = beforeTexts.get(file) || '', after = afterTexts.get(file) || '';
    const oldSymbols = beforeModules.get(file)?.symbols || [], newSymbols = afterModules.get(file)?.symbols || [];
    const names = new Set([...oldSymbols.map(s => s.name), ...newSymbols.map(s => s.name)]);
    const changedSymbols = [...names].filter(name => {
      const previous = oldSymbols.find(s => s.name === name), current = newSymbols.find(s => s.name === name);
      return !previous || !current || previous.signature !== current.signature || previous.bodyHash !== current.bodyHash;
    });
    const patch = await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3', baseSha, headSha, '--', `:(literal)${file}`]);
    let additions = 0, deletions = 0;
    for (const diffLine of patch.split('\n')) {
      if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) additions++;
      if (diffLine.startsWith('-') && !diffLine.startsWith('---')) deletions++;
    }
    changes.push({ path: file, status: !beforeTree.has(file) ? 'A' : !afterTree.has(file) ? 'D' : 'M', additions, deletions, patch: patch.slice(0, 150000), before, after, symbols: changedSymbols });
    for (const name of changedSymbols) {
      const previous = oldSymbols.find(s => s.name === name), current = newSymbols.find(s => s.name === name);
      if (previous && !current) findings.push({ id: id(`${file}:${name}:removed`), severity: 'warning', title: `Export removed: ${name}`, detail: 'Callers importing this callable may break. A renamed or moved export appears as a removal and addition.', file, line: previous.line });
      if (previous && current && previous.signature !== current.signature) findings.push({ id: id(`${file}:${name}:signature`), severity: 'warning', title: `Signature changed: ${name}`, detail: `${previous.signature} → ${current.signature}`, file, line: current.line });
      if (previous && current) {
        const newGuards = afterModules.get(file)?.guards.get(name) || [];
        const missingGuards = (beforeModules.get(file)?.guards.get(name) || []).filter(guard => !newGuards.includes(guard));
        if (missingGuards.length) findings.push({ id: id(`${file}:${name}:guard`), severity: 'warning', title: `Guard changed or removed: ${name}`, detail: `Previous early-exit conditions/assertions are absent or modified: ${missingGuards.join('; ')}. This is a syntactic signal; review whether behavior was intentionally relaxed.`, file, line: current.line });
      }
    }
    if (path.posix.basename(file) === 'package.json') {
      try {
        const oldPackage = before ? JSON.parse(before) : {}, newPackage = after ? JSON.parse(after) : {};
        for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const oldDeps = oldPackage[group] || {}, newDeps = newPackage[group] || {};
          for (const dependency of new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)])) if (oldDeps[dependency] !== newDeps[dependency]) findings.push({ id: id(`${file}:${group}:${dependency}`), severity: 'info', title: `Dependency changed: ${dependency}`, detail: `${group}: ${String(oldDeps[dependency] ?? '(absent)')} → ${String(newDeps[dependency] ?? '(absent)')}. Dependency behavior is not verified by static analysis.`, file });
        }
      } catch { findings.push({ id: id(`${file}:invalid-json`), severity: 'warning', title: 'Package manifest could not be parsed', detail: 'Dependency changes could not be inspected because a snapshot contains invalid JSON.', file }); }
    }
  }
  const graphPaths = new Set([...beforeModules.keys(), ...afterModules.keys(), ...changed]);
  const edgeMap = new Map<string, { source: string; target: string }>();
  for (const modules of [beforeModules, afterModules]) {
    const files = new Set(modules.keys());
    for (const module of modules.values()) for (const specifier of module.imports) {
      const target = resolveImport(module.file, specifier, files);
      if (target) edgeMap.set(`${module.file}\0${target}`, { source: module.file, target });
    }
  }
  const edges = [...edgeMap.values()];
  const impacted = new Set(changed);
  const queue = [...changed];
  const callers = new Map<string, string[]>();
  for (const edge of edges) callers.set(edge.target, [...(callers.get(edge.target) || []), edge.source]);
  while (queue.length) for (const caller of callers.get(queue.shift()!) || []) if (!impacted.has(caller)) { impacted.add(caller); queue.push(caller); }
  const impactedTests = [...impacted].filter(file => TEST.test(file) && afterModules.has(file)).sort();
  const candidates: Candidate[] = [];
  for (const change of changes) {
    const module = afterModules.get(change.path);
    if (!module) continue;
    for (const symbol of module.symbols.filter(s => change.symbols.includes(s.name))) {
      if (symbol.returnType !== 'inferred' && symbol.returnType !== 'void' && symbol.returnType !== 'never') candidates.push({ id: id(`${symbol.file}:${symbol.name}:type`), file: symbol.file, symbol: symbol.name, title: `${symbol.name} should honor its declared return type`, source: 'type', evidence: symbol.signature, line: symbol.line, status: 'suggested' });
      for (const guard of module.guards.get(symbol.name) || []) candidates.push({ id: id(`${symbol.file}:${symbol.name}:${guard}`), file: symbol.file, symbol: symbol.name, title: `Review the guard contract in ${symbol.name}`, source: 'assertion', evidence: guard, line: symbol.line, status: 'suggested' });
    }
  }
  for (const file of impactedTests) candidates.push(...testCandidates(afterModules.get(file)!));
  for (const [file, text] of afterTexts) {
    if (!/(?:^|\/)README(?:\.[^/]*)?$/i.test(file) && !changed.includes(file)) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const evidence = lines[index].trim();
      const docLine = /(?:^|\/)README(?:\.[^/]*)?$/i.test(file) || /^(?:\/\/|\/\*|\*)/.test(evidence);
      if (docLine && /\b(?:must|should|never)\b/i.test(evidence) && evidence.length >= 12 && evidence.length <= 600) candidates.push({ id: id(`${file}:doc:${index}`), file, symbol: '', title: evidence.replace(/^(?:\/\/|\/\*|\*|#+)\s*/, ''), source: 'documentation', evidence, line: index + 1, status: 'suggested' });
    }
  }
  if (candidates.length > 300) limitations.push('Only the first 300 mined candidate contracts are included.');
  if ([...beforeTree.values(), ...afterTree.values()].some(entry => !regular(entry))) limitations.push('This repository contains symlinks or submodules; those entries were skipped.');
  if (changes.some(change => change.patch.length >= 150000)) limitations.push('Some diff previews were truncated at 150,000 characters.');
  return { repository, base, head, baseSha, headSha, changes, symbols: [...afterModules.values()].flatMap(module => module.symbols), graph: { nodes: [...graphPaths].sort().map(file => ({ id: file, label: path.posix.basename(file), kind: TEST.test(file) ? 'test' : SOURCE.test(file) ? 'source' : 'config', changed: changed.includes(file), impacted: impacted.has(file) })), edges }, candidates: candidates.slice(0, 300), findings, impactedTests, limitations };
}
