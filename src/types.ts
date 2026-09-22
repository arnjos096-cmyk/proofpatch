export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Parameter { name: string; type: string; optional: boolean; values: Json[] }
export interface SymbolInfo { name: string; file: string; line: number; signature: string; exported: boolean; parameters: Parameter[]; returnType: string; bodyHash: string }
export interface FileChange { path: string; status: string; additions: number; deletions: number; patch: string; before: string; after: string; symbols: string[] }
export interface GraphNode { id: string; label: string; kind: 'source' | 'test' | 'config'; changed: boolean; impacted: boolean }
export interface GraphEdge { source: string; target: string }
export interface Candidate { id: string; file: string; symbol: string; title: string; source: 'type' | 'test' | 'assertion' | 'documentation'; evidence: string; line: number; status: 'suggested' }
export interface StaticFinding { id: string; severity: 'info' | 'warning' | 'error'; title: string; detail: string; file: string; line?: number }
export interface Analysis { repository: string; base: string; head: string; baseSha: string; headSha: string; changes: FileChange[]; symbols: SymbolInfo[]; graph: { nodes: GraphNode[]; edges: GraphEdge[] }; candidates: Candidate[]; findings: StaticFinding[]; impactedTests: string[]; limitations: string[] }
export interface Contract { id: string; title: string; file: string; export: string; arguments: Json[][]; oracle: { kind: 'preserve' } | { kind: 'equals'; value: Json } | { kind: 'type'; value: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' } | { kind: 'does-not-throw' }; maxCases?: number }
export interface Constitution { version: 1; contracts: Contract[] }
export interface Observation { kind: 'return' | 'throw' | 'timeout' | 'error'; value?: Json; message?: string }
export interface Counterexample { arguments: Json[]; before: Observation; after: Observation; minimized: boolean }
export interface ContractResult { id: string; title: string; file: string; export: string; oracle: Contract['oracle']; status: 'passed' | 'failed' | 'skipped' | 'error'; cases: number; passed: number; failed: number; durationMs: number; counterexample?: Counterexample; reason?: string }
export interface ExecutionOptions { mode: 'local' | 'docker'; timeoutMs: number; maxCases: number; seed: number; dockerImage?: string }
export interface Receipt { schemaVersion: 1; id: string; createdAt: string; tool: { name: 'proofpatch'; version: string }; analysis: Analysis; execution: { mode: 'static' | 'local' | 'docker'; seed: number; durationMs: number; results: ContractResult[] }; summary: { verdict: 'regression' | 'review' | 'passed'; contracts: number; passed: number; failed: number; skipped: number; cases: number }; integrity: { algorithm: 'sha256'; digest: string; signature?: string; publicKey?: string }; limitations: string[] }
