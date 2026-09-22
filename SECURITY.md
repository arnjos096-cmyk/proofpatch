# Execution and trust model

`inspect` defaults to static analysis of committed files. It does not install the target repository's dependencies or run its test suite, lifecycle hooks, or code. `mine` writes a reviewable draft and does not execute it.

`--execute local` explicitly runs the selected modules, including their top-level code, with the current user's privileges. Timeouts, output limits, a reduced environment, and fresh processes improve predictability; they are not a security sandbox. Only use local mode for trusted code. The bundled demo executes only the included example modules.

`--execute docker` uses the Docker daemon and a Node image. Bundles are mounted read-only; networking is disabled, capabilities are dropped, and resource limits are set. Do not mount credentials, source trees, Docker sockets, or host home directories into the target container. Container isolation does not establish that hostile code is safe. Bundling happens on the host and is also part of the trusted computing base.

Receipts contain source snippets, paths, inputs, return values, and error messages. Review them before sharing a private repository's report. The viewer has no telemetry, remote scripts, or server-side upload endpoint; imported files remain in the browser.

A SHA-256 digest detects changes relative to the recorded digest; anyone can recompute it. Ed25519 signatures authenticate a holder of a private key only when the verifier supplies a separately trusted public key. An embedded public key alone does not establish identity. No signature proves that an execution environment or target program was honest.

The first release targets JSON-serializable function behavior. It does not verify database state, external APIs, filesystem effects, time, random behavior, all program paths, or complete application security.

Report vulnerabilities through GitHub private vulnerability reporting if enabled, or contact the maintainer via their GitHub profile before posting exploit details publicly.
