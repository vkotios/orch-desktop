# CHO-03 — Durable sessions and recovery

Status: in progress. S1 store (`f0b4f72`), S2a project/chat/draft records (`247f43d`) and S2b native bindings/producer fences (`f202eeb`) implemented and verified locally. Application consumers remain in memory.
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

## Accepted foundation

1. `docs/contracts/SESSION_STORAGE.md`: versioned project/conversation/
   native-ref/turn/event/operation/draft/clarification records, concrete
   schema, DB-identity admission, CAS ownership fence, cursor/poll/crash/draft
   rules, close semantics, S1 I/O-error contracts and acceptance, later-slice scope.
2. `apps/desktop/server/session-store-schema.mjs`: exact accepted v1 DDL.
3. `apps/desktop/server/session-store.mjs`: file admission, atomic initialization,
   full schema checking, guarded synchronous transactions and close.
4. `apps/desktop/src/session-store.test.mjs`: 20 real SQLite lifecycle and
   transaction tests. No host/UI consumer, native resume or migration yet.

Verification on `f0b4f72`: all 408 package tests (44 shared, 364 desktop), type
checking and web build pass. Controller and independent GLM 5.3 high/Vibe
review found no remaining High or Medium issue. Separate bundled Node 24.22.2
fixtures establish commit across process restart, rollback after abrupt exit,
WAL reopening without SHM, bounded contention, schema rejection with unchanged
file bytes, and SQLite pager-FULL rollback. No provider call or native artifact
rebuild was needed for this unconsumed module. This establishes the store core;
it does not establish chat or draft persistence in the application.

Decisions: SQLite default via `node:sqlite` on bundled Node 24.22.2; first
implementation a standalone store module exposing only
`openSessionStore({ databasePath })`, `transaction(fn)`, `close()` — no
records CRUD, poll/draft/native claims, UI/IPC/provider wiring, or provider
start; fixed module application id (no caller app id); bounds are 65536 UTF-16
code units; transcript imports never invent native ids and create no
`native_refs` rows; all unfinished work after a crash is unknown/
recovery-required unless a proven not-sent fact exists — never replayed, never
auto-resent, never auto-granted; pending approvals/questions become historical
and unactionable after generation loss; close is interrupt-and-close only.

## Project/chat records and drafts

S2a adds the [session records API](../contracts/SESSION_RECORDS.md): explicit
project/chat creation, bounded lists, literal title search, rename/archive,
version-checked draft saves, immutable stale-save conflicts and durable save
receipts. Project checks, mutations and receipts share one SQLite transaction.
An exact retry returns its original receipt without replacing a newer draft.
Native configuration/identities remain untouched; conflict lists return metadata
and individual reads return text. NUL and unpaired-surrogate input rejects
explicitly; accepted text retains whitespace, newlines and Unicode.

Source `247f43d` passes all 428 package tests (44 shared, 384 desktop), including
20 record tests, type checking and web build. Separate installed/bundled Node
process fixtures verify persisted drafts/receipts, two-connection stale saves,
receipt-failure rollback and text bounds. Independent GLM review and controller
validation leave no High or Medium issue. Non-BMP fidelity is verified against
actual Git source and direct runtime roundtrips. No host/UI consumer or new
native artifact is claimed.

## Producer fences and native bindings

S2b adds [SESSION_BINDINGS](../contracts/SESSION_BINDINGS.md): generation-checked
producer ownership, verified release/death transitions and immutable native
references. Held fences cannot transfer by age or manual override; a new token
can reclaim a terminal fence only at the next generation. Claude requests remain
distinct from matching observed native associations. Codex references preserve
the observed thread ID; binding leaves model/role/provenance fields untouched.

Source `f202eeb` passes 20 focused tests, all 448 package tests (44 shared,
404 desktop), type checking and web build. Actual installed/bundled Node process
fixtures establish reopening, stale-owner rejection, rollback and uniqueness;
simultaneous child claims produce one owner. Independent GLM review completed
all seven passes on retry; controller validation leaves no High or Medium issue.
Injected proof callbacks are synthetic in these fixtures. Actual host process
identity/proof freshness, provider observation and runtime consumers remain S3
work; there is no native supervision or application recovery claim here.

## Implementation sequence

- S1 — Complete locally. Store core only: file lifecycle/DB-identity admission, v1 schema,
  `user_version`, guarded synchronous transaction boundary, one serialized
  writer, finite 100ms busy behavior. No consumers, no records CRUD/poll/draft/
  native claims, no runtime/recovery claims, no destructive migration.
  Exact I/O/error contracts and machine checks live in SESSION_STORAGE §7.
- S2a — Complete locally: projects/conversations and draft saves/conflicts/receipts.
- S2b — Complete locally: producer fences and native reference/request binding.
- S2 remaining — Next: turns, execution operations, clarifications and bounded
  large bodies; same-project/controller/turn binding, generation checks inside
  each mutation transaction and native-configuration pinning. Complete
  explicit draft-conflict resolution before its UI workflow. No credentials or
  raw provider payloads enter normalized records.
- S3 — Host/native event coupling: durable event+projection+outcome commits,
  replay-by-cursor poll replacing destructive drain, ownership checks, paged
  resync, interrupt-and-close with persisted Stop intent, visible
  disk-full/corruption handling.
- S4 — UI drafts/history: CAS drafts with per-save-id immutable conflicts,
  bounded history/list reads, rename/archive/search onto the store, one producer
  per conversation at a time.
- S5 — Resume/import/export/restore: restart reconciliation with unknown states,
  atomic idempotent browser transcript import, redacted export, explicit
  restore/clone with identity rotation. Native resume is S5 work, not S1.

## Exit and review

Exit: sessions and drafts survive restart; recovery never silently replays an
execution; close/reopen with rendered recovery actually tested before any
production-ready claim. Storage/migration slices get two-family review (root
independent review plus GLM); no fabricated CLI receipts for API work. CHO-03
stays in progress until S1–S5 land.

Remaining unknowns: exact poll replay shape against the host protocol (02-a
envelopes); conversation-list budget and large-body chunk tuning (128KiB poll).

Low follow-ups: correct the ignored extension option in the raw test fixture
(product connections use `allowExtension: false`); await child exit on fixture
timeout; consolidate rare corrupt-path/transient-I/O error classification and
failed rollback/close retirement before S3 host integration. POSIX path policy
belongs to future platform qualification. These do not block the isolated S1 core.

S2a Low follow-ups: avoid timestamp changes on no-op rename/archive before S4;
code the defensive CAS failure and validate malformed stored receipt JSON/shape
before S3 consumers. Current API writes valid receipts under one writer lock.

S2b Low follow-ups before host/restore consumers: validate stored native-reference
shape and requested/observed consistency, including already-set idempotent
requests; align trusted-clock exceptions with host-facing error policy; review
proof-before-collision error ordering if calls become externally exposed. Improve
the factory no-I/O fixture when refactoring. Current API writes valid bindings and
never mutates without verified ownership.
