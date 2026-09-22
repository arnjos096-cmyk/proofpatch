# Architecture and design decisions

ProofPatch has two independent evidence paths: static facts about committed files, and executed observations under reviewed contracts. They meet in a receipt but never silently substitute for each other.

## 1. Snapshot analysis

Git refs resolve to commit object IDs before reading blobs. Analysis inspects tracked files from those commits rather than the current working tree. TypeScript's parser identifies exported callable declarations, signatures, parameters and bodies. Relative imports form a directed file graph, and reverse reachability finds callers affected by changed dependencies. Both snapshots contribute edges so deletions retain impact information.

Candidate promises carry a source file, line, category, and evidence. They are suggestions. Draft execution contracts use representative values for supported parameter types and a preserve oracle; a person must decide whether that old behavior should remain.

## 2. Behavioral experiments

The JSON constitution is data, not arbitrary assertion code. Each parameter has a finite domain. The engine chooses combinations deterministically within a declared case budget, bundles target modules using esbuild, and invokes the named export in a fresh runtime. Before and after observations include values or explicit errors.

The runner bounds runtime and output. The Docker option adds a restricted container. Missing dependencies are not installed implicitly. Unsupported serialization does not collapse into a successful `null` result. A failed case can be shrunk only when a simpler allowed input reproduces a meaningful failure in a rerun. Shrinking is bounded and does not claim mathematical global minimality.

## 3. Evidence and integrity

The receipt contains the compared commits, changes, graph, candidates, findings, runtime settings, each contract result, observed counterexamples, and limitations. Its verdict is derived from those results: a failed contract produces `regression`; absent, static, incomplete or warning-bearing evidence produces `review`; completed passing contracts without selected static warnings produce `passed`.

Canonical serialization recursively sorts object keys, preserves array order, and excludes the top-level `integrity` object. The SHA-256 digest covers that payload. Ed25519 signs the digest bytes. Verifying against a supplied public key establishes a trust decision that is separate from checking an embedded key.

## 4. Portable presentation

The HTML report embeds CSS, JavaScript, and escaped receipt data. It has no external runtime dependencies. JSON values are rendered as text, not interpreted as HTML. The localhost server exposes only the known report files and binds to loopback by default. The browser can import another receipt without uploading it.

## Deliberate boundaries

No probabilistic confidence score: the number would imply calibration we have not established. No automatic adoption of mined requirements: old behavior can be a bug. No LLM dependency for finding the demo regression: evidence remains reproducible without a model account. No claim that a signature proves execution honesty. No claiming that a subprocess isolates hostile code.
