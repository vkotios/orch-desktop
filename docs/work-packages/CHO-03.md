# CHO-03 — Durable sessions and recovery

Status: in progress (contract slice only, no product source changes).
Authority: [implementation plan](../IMPLEMENTATION_PLAN.md) (CHO-03),
[product spec](../PRODUCT_SPEC.md) (SESSION-01–06, RUN-04/06, AC-03/04/07/13),
[CHO-04 milestones](CHO-04.md), storage contract: [SESSION_STORAGE](../contracts/SESSION_STORAGE.md).

## Entry facts

Chats, drafts, native thread/session ids, and the event mailbox are in-memory
only (`server/native-chat.mjs`, `server/claude-chat-actor.mjs`,
`server/event-mailbox.mjs`, `src/lib/native-chat-state.ts`,
`src/components/NativeChat.tsx`). Draft is component state; poll is a
destructive `mailbox.drain()`; restart loses threads, drafts, and cursors.
Established identities to persist: Codex thread/turn/item ids, Claude session
UUID with per-turn input UUIDs, plus asked/answered clarification history.
Rust already owns an app-local state root (`app_local_data_dir()/host-state`).

## This slice (docs only)

1. `docs/contracts/SESSION_STORAGE.md`: versioned project/conversation/
   native-ref/turn/event/operation/draft/clarification records, concrete
   schema, DB-identity admission, CAS ownership fence, cursor/poll/crash/draft
   rules, S1 I/O-error contracts, acceptance/fault matrix.
2. This work package: bounded implementation sequence for later slices.
   Native resume and store migration are NOT implemented in this slice.

Decisions: SQLite default via `node:sqlite` on bundled Node 24.22.2; first
implementation a standalone store module (no UI/IPC/provider wiring or
provider start); transcript imports never invent native ids; all unfinished
work after a crash is unknown/recovery-required unless a proven not-sent fact
exists — never replayed, never auto-resent, never auto-granted; pending
approvals/questions become historical and unactionable after generation loss.

## Implementation sequence (later slices, in order)

- S1 — Store core only: file lifecycle/DB-identity admission, v1 schema,
  `user_version`, transaction boundary, one serialized writer, finite busy
  behavior. No consumers, no runtime/recovery claims, no destructive migration.
  Exact I/O/error contracts and machine checks live in SESSION_STORAGE §7.
- S2 — Normalized records: projects/conversations/native-refs/turns/drafts
  with ownership, uniqueness, and immutability rules; redaction boundary (no
  credentials or raw provider payloads).
- S3 — Host/native event coupling: durable event+snapshot commits,
  replay-by-cursor poll replacing destructive drain, ownership checks,
  paginated resync, visible disk-full/corruption handling.
- S4 — UI drafts/history: CAS drafts with immutable conflicts, bounded
  history/list reads, rename/archive/search onto the store, one producer
  per conversation at a time.
- S5 — Resume/import/export: restart reconciliation with unknown states,
  atomic idempotent browser transcript import, redacted export.
  Native resume is S5 work, not S1.

## Exit and review

Exit: sessions and drafts survive restart; recovery never silently replays an
execution; close/reopen with rendered recovery actually tested before any
production-ready claim. Storage/migration slices get two-family review (root
independent review plus GLM); no fabricated CLI receipts for API work. CHO-03
stays in progress until S1–S5 land.

Remaining unknowns: exact poll replay shape against the current host protocol
(02-a envelopes); retention/erase policy for transcripts and diagnostics;
conversation-list performance budget on large stores; large-body chunk size
tuning against the 128KiB poll total.
