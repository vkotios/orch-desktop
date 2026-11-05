# Reuse audit — grok-build-desktop × cli-agentic-coordinator

Date: 2026-11-05. Branch: `codex/cho-v01-foundation`.  
Companion: [CURRENT_HANDOFF.md](../CURRENT_HANDOFF.md), [CHO-03](work-packages/CHO-03.md), next slice [S3d handoff](work-packages/CHO-03-s3d-tool-lifecycle-handoff.md).

## Verdict

CHO correctly reused **orch as the coordinator** and **Grok’s shell architecture idea** (Tauri + React + host bridge + ACP framing package). It did **not** wrongly fail to lift Grok’s JSONL session store — that store belongs to the Grok Build agent runtime, not a multi-CLI Codex/Claude + orch product.

The real drift is **effort allocation**: a large verified SQLite stack (`session-*.mjs`) and native preview exist, but the running app still uses memory/localStorage, and native host admits almost no orch mutations. Stop inventing parallel coordination or persistence; consume what exists.

## Upstream roles

| Source | Reuse as | Do not treat as |
| --- | --- | --- |
| [vkotios/cli-agentic-coordinator](https://github.com/vkotios/cli-agentic-coordinator) | Bundled `orch/` engine, adapters, claim/run/review/gate/scope/worktree/ledger | Desktop chat store or native process ownership |
| [RapidAI/grok-build-desktop](https://github.com/RapidAI/grok-build-desktop) (Apache-2.0) | Layout/scaffold inspiration; small framing helpers | Agent runtime, JSONL persistence, Rust ACP host as line-copy source |

Root LICENSE is MIT. **No RapidAI/SpaceXAI NOTICE** yet (PRODUCT_SPEC §12). `orch/THIRD_PARTY.md` covers other ports, not RapidAI.

## Classification

### Reuse as-is

- Entire `orch/` (not forked for desktop concerns).
- Coordinator kit: `ORCHESTRATOR.md`, `skills/`, `templates/`, `roles/`, `hooks/`.
- Bridge `orch_*` command map in `apps/desktop/server/bridge.mjs` (claim through quota).
- Browser orch dashboard UX in `App.tsx` + `src/lib/agent-task.ts` as CHO-05 starting surface.

### Adapt only

| Path | Note |
| --- | --- |
| `packages/acp-client/src/index.ts` | Same package role as `@grok-desktop/acp-client`; CHO expanded into multi-harness normalizer. Diff + attribute. |
| `apps/desktop/src/main.tsx` | Near-identical Vite bootstrap. |
| `apps/desktop/src/lib/api.ts` | Same Tauri invoke/listen pattern; CHO command surface differs. |
| `App.tsx` / `styles.css` / Vite / Tauri scaffold | Shell-inspired, heavily rewritten. |
| Native host allowlist | Today: `ping`, `shutdown`, `discover_harnesses`, `orch_dashboard`, native chat only. Admit selected bridge `orch_*` mutations with ownership gates for CHO-05. |
| Bridge stream parsing | Still duplicates `acp-client`; consolidate when touching bridge. |

### Net-new CHO (keep; do not replace with Grok lifts)

- Native host: `server/host.mjs`, `protocol.mjs`, `src-tauri/src/host_{runtime,wire,job}.rs`.
- Codex/Claude native chat, RPC, clarification, mailbox, UI.
- Full SQLite CHO-03 stack and `docs/contracts/SESSION_*.md`.

### Triple stack — freeze growth

| Stack | Status | Rule |
| --- | --- | --- |
| Browser `App.tsx` + `bridge.mjs` + localStorage | Orch studio prototype | Do not deepen localStorage durability |
| Native chat + in-memory mailbox | Working debug preview | Wire SQLite here |
| `session-*.mjs` (~8.7k LOC) | Verified, mostly unconsumed | No new modules without a named consumer path |

## Provenance diffs still owed (pre-publication)

Pin a RapidAI SHA, then compare:

1. `packages/acp-client/src/index.ts` (+ package.json naming)
2. `apps/desktop/src/main.tsx`
3. `apps/desktop/src/lib/api.ts` (pattern only)
4. `apps/desktop/src/App.tsx`, `styles.css`
5. `apps/desktop/{package.json,vite.config.ts,tsconfig.json,index.html}`
6. `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json,capabilities/default.json,build.rs,src/main.rs}`

Do not treat `server/**` (except conceptual bridge role), `NativeChat*`, `host_*.rs`, or `session-*.mjs` as lifts without evidence.

## CHO-05 — what not to reinvent

Already available via orch + bridge:

`orch_dashboard`, `orch_claim`, `orch_release`, `orch_worktree_create`, `orch_pick`, `orch_run`, `orch_run_detail`, `orch_cancel`, `orch_scope`, `orch_review`, `orch_review_finish`, `orch_gate_status`, `orch_gate_record`, `orch_record`, `orch_cleanup`, `orch_finish`, `orch_adopt`, `orch_usage`, `orch_quota`.

Must still build (CHO-specific): conversation↔claim/worktree/run associations, recoverable stage transitions around those ops, native admission, accept/integrate/discard UI with no hidden Git. Prefer wrapping orch over modifying orch internals ([IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) CHO-05).

## Stop inventing

1. Another coordination/review engine.
2. Grok-style JSONL session store for CHO chats.
3. Unconsumed `session-*` APIs beyond the named next consumer slice.
4. Parallel durable browser localStorage.
5. A second orch dashboard rewritten from scratch for native.

## Recommended sequence

1. **S3d** — typed tool lifecycle facts + body summaries (minimum storage for actors); see [handoff](work-packages/CHO-03-s3d-tool-lifecycle-handoff.md).
2. Wire store into native producers/poll (replace destructive mailbox drain; real owner proofs).
3. Admit orch mutations on native host using the existing bridge map.
4. CHO-05 recoverable wrapper + associations.
5. Attribution NOTICE after scaffold diffs; then release/public work.

This audit does not authorize push, visibility change, or release publication.
