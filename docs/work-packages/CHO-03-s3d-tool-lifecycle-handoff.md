# CHO-03 S3d — orch worker handoff

Controller-prepared 2026-11-05. Work package CHO-03 remains claimed; do not
finish/release the claim. See [REUSE_AUDIT](../REUSE_AUDIT.md): this slice is
the minimum typed tool storage for a later native consumer — not host/UI wiring
and not a second persistence design.

```
TASK: Implement CHO-03 S3d typed tool lifecycle facts with optional body-backed summaries and a bounded lastToolTurn snapshot reducer, matching SESSION_TOOL_FACTS.md and mirroring session-message-deltas.mjs.
WORK PACKAGE / SLICE: CHO-03 / s3d-tool-lifecycle    SIZE: M
ATTEMPT: 1 of 3
FILES YOU MAY EDIT:
  apps/desktop/server/session-tool-facts.mjs
  apps/desktop/src/session-tool-facts.test.mjs
  docs/contracts/SESSION_TOOL_FACTS.md
  docs/work-packages/CHO-03.md
  docs/IMPLEMENTATION_STATUS.md
  TASKS.md
FILES YOU MAY READ:
  docs/contracts/SESSION_TOOL_FACTS.md
  docs/contracts/SESSION_MESSAGE_DELTAS.md
  docs/contracts/SESSION_EVENTS.md
  docs/contracts/SESSION_BODIES.md
  docs/contracts/SESSION_TURNS.md
  docs/contracts/SESSION_TURN_OUTCOMES.md
  docs/REUSE_AUDIT.md
  apps/desktop/server/session-message-deltas.mjs
  apps/desktop/server/session-turn-outcomes.mjs
  apps/desktop/server/session-events.mjs
  apps/desktop/server/session-bodies.mjs
  apps/desktop/server/session-turns.mjs
  apps/desktop/server/session-producer-transaction.mjs
  apps/desktop/server/session-store.mjs
  apps/desktop/src/session-message-deltas.test.mjs
  packages/acp-client/src/codex-app-server.ts
  packages/acp-client/src/claude-stream.ts
  packages/acp-client/src/index.ts
MIRROR THIS FILE: apps/desktop/server/session-message-deltas.mjs
DO NOT: explore other files; add dependencies; run git write commands, installs, database or deploy commands; delete or move anything you did not create; edit native-chat, mailbox, bridge, host, UI, approvals, clarifications, or schema DDL unless SESSION_TOOL_FACTS explicitly requires a documented no-DDL composition (prefer no schema change — compose bodies/events like S3c); invent permission facts, transcript readers, or mailbox replacement
CONTEXT:
  - Contract: docs/contracts/SESSION_TOOL_FACTS.md (authoritative).
  - Factory: createSessionToolFacts({ store, verifyOwnerEvidence, now = Date.now }) -> frozen { appendToolFact, inTransaction }.
  - appendToolFact scope + turnId, operationId, factId, toolCallId, phase ("started"|"completed"), toolTitle, toolStatus ("inProgress"|"completed"|"failed"|"declined"), optional summaryText, optional nativeMessageId, expectedSeq.
  - started <=> inProgress; completed <=> completed|failed|declined.
  - Event key tool_fact:<factId>, kind tool_fact; payload exactly as contract; body id = factId only when summaryText !== undefined.
  - Preserve state.lastTurnOutcome and state.lastMessageTurn; only update state.lastToolTurn marker (8-field shape parallel to lastMessageTurn); do not grow snapshot bodyRefs with tool summary bodies.
  - Observed nonterminal turn + paired handoff + live owner proof required; exact retries idempotent; missing body on body-backed retry => ERR_STORAGE no repair.
  - Native effects outside DB transactions; inTransaction results provisional until outer commit.
  - Ground titles/statuses in existing Codex/Claude normalizer enums; do not parse raw provider envelopes here.
  - Reuse audit: do not replace mailbox.push with a DB call in this slice; do not lift Grok JSONL.
ACCEPTANCE CRITERIA:
  - New module + tests cover: Codex-like command started/completed, Claude-like tool_call/tool_result with nativeMessageId, declined/failed statuses, optional/empty summary bodies, Unicode, exact retry after terminal, competing sequence winner with losing-body rollback, ABORT/IGNORE body/event/snapshot faults, proof denial, outer observation rollback, dangling-body rejection, lastMessageTurn/lastTurnOutcome preservation across many tool facts, phase/status mismatch rejection.
  - Installed Node and bundled Node child-process probes for reopen + one concurrent winner (mirror S3c style; synthetic owner proofs OK).
  - `npm run typecheck` passes; `npm test` passes with new tests included; `npm run build` passes.
  - CHO-03.md / IMPLEMENTATION_STATUS.md / TASKS.md record S3d as locally verified storage-only; explicitly state mailbox/host/UI still memory.
  - No unresolved product High/Medium by inspection against the contract; leave Low consumer holds listed, do not expand scope.
COMMANDS YOU MAY RUN:
  npm run typecheck
  npm test
  npm run build
  node --test apps/desktop/src/session-tool-facts.test.mjs
MAX DIFF: ≈300 changed lines of product code in session-tool-facts.mjs (tests may be larger); docs updates focused
IF BLOCKED OR A DECISION IS NEEDED: stop and output a block starting with NEEDS-DECISION:
REPORT: files changed; raw command output; what you did not verify; follow-ups noticed (do not do them)
```

## Controller notes (not for the worker)

- Preferred implementer: Muse when available; else Aider XS/S only if the slice is further split. Independent review: GLM 5.3 high / Vibe.
- After convergence: do **not** finish CHO-03. Next consumer work is actor wiring / poll — separate handoff.
- Before host/error-UI: still address S3c corrupt observed-journal `ERR_STORAGE` reclassification and listed negative tests.
