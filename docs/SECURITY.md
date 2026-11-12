# Security notes (v0.1)

- The packaged host allowlists commands; orch mutations are further admitted in
  `apps/desktop/server/host.mjs` (`admitOrchArgs`). Renderer-supplied
  `ownerApprovedModel`, `allow`, and unconstrained `force`/`dir` are rejected or
  re-derived from host-owned association records.
- Production CSP is set in `apps/desktop/src-tauri/tauri.conf.json` (no `csp: null`).
- Capabilities remain narrow (`capabilities/default.json` → `core:default`).
- Native effects stay outside SQLite transactions; ownership fences require
  process identity / liveness evidence for reclaim.
- Do not treat durable history as authority to replay permissions, clarification
  answers, Stop, or user turns after restart.
