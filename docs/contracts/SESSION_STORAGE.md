# SESSION_STORAGE — durable session/event store contract (CHO-03)

Status: contract v1, design only. No implementation in this slice.
Authority: PRODUCT_SPEC SESSION-01–06, RUN-04/06, §9; IMPLEMENTATION_PLAN CHO-03; CHO-04 clarification milestone.
Runtime: `node:sqlite` `DatabaseSync` (synchronous execution) on bundled Node 24.22.2.
Official reference: [Node.js v24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
First implementation is one standalone Node store module: schema/lifecycle plus a
guarded synchronous transaction boundary. No UI, IPC, provider wiring, or provider start.

## 1. Records and schema (v1)

UI ids are generated UUIDs (`TEXT`). Real Codex thread ids and Claude session/input
UUIDs live only in `native_refs`/`turns`, never as UI ids. Raw credentials and raw
provider payloads are never stored. All lengths below are UTF-16 code units
(`String.length`), not code points.

```sql
PRAGMA journal_mode = WAL;            -- verified by read-back, not fire-and-forget
PRAGMA foreign_keys = ON;             -- verified by read-back
PRAGMA synchronous = FULL;            -- verified by read-back
PRAGMA busy_timeout = 100;            -- 100ms default for the interactive store
CREATE TABLE meta(application_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL,
  schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path_canonical TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
CREATE TABLE conversations(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', controller TEXT NOT NULL CHECK(controller IN ('codex','claude')),
  model_requested TEXT, model_reported TEXT NULL, served_verified TEXT NULL,
  effort TEXT, role TEXT, parent_conversation_id TEXT NULL REFERENCES conversations(id),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  UNIQUE(id, project_id), UNIQUE(id, project_id, controller));
CREATE INDEX conv_project_updated ON conversations(project_id, updated_at_ms);
CREATE TABLE native_refs(
  conversation_id TEXT NOT NULL, project_id TEXT NOT NULL,
  controller TEXT NOT NULL CHECK(controller IN ('codex','claude')),
  native_thread_id TEXT NULL, native_session_uuid TEXT NULL,
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, controller),
  FOREIGN KEY (conversation_id, project_id, controller) REFERENCES conversations(id, project_id, controller) ON DELETE CASCADE,
  CHECK((controller='codex' AND native_thread_id IS NOT NULL AND native_session_uuid IS NULL)
     OR (controller='claude' AND native_session_uuid IS NOT NULL AND native_thread_id IS NULL)));
CREATE UNIQUE INDEX native_thread_once ON native_refs(native_thread_id) WHERE native_thread_id IS NOT NULL;
CREATE UNIQUE INDEX native_session_once ON native_refs(native_session_uuid) WHERE native_session_uuid IS NOT NULL;
CREATE TABLE turns(
  id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, prompt_text TEXT NOT NULL, prompt_ref TEXT NULL,
  model_requested TEXT, effort TEXT, role TEXT, claude_input_uuid TEXT NULL,
  intent_state TEXT NOT NULL CHECK(intent_state IN
    ('queued','written','observed','completed','failed','interrupted','unknown')),
  native_turn_id TEXT NULL, outcome TEXT NULL CHECK(outcome IN ('completed','failed','interrupted','unknown')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, id), UNIQUE(conversation_id, seq));
CREATE UNIQUE INDEX turn_claude_input_once ON turns(claude_input_uuid) WHERE claude_input_uuid IS NOT NULL;
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(conversation_id, seq), UNIQUE(conversation_id, event_key));
CREATE INDEX events_cursor ON events(conversation_id, seq);
CREATE TABLE snapshots(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL, projection_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE large_bodies(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  byte_len INTEGER NOT NULL, sha256_hex TEXT NOT NULL, body_text TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE operations(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','clarification_answer','stop','handoff','draft_save')),
  owner_generation INTEGER NOT NULL, host_generation TEXT NULL, native_request_id_text TEXT NULL,
  native_request_id_type TEXT NULL CHECK(native_request_id_type IN ('number','string')),
  decision TEXT NULL, state TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
  payload_hash TEXT NULL, result_json TEXT NULL,
  created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, turn_id) REFERENCES turns(conversation_id, id) ON DELETE CASCADE);
CREATE TABLE clarifications(id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  native_question_id TEXT NOT NULL, question_json TEXT NOT NULL, status TEXT NOT NULL
  CHECK(status IN ('pending','answered','invalid','unactionable')),
  answer_json TEXT NULL, answered_at_ms INTEGER NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, turn_id) REFERENCES turns(conversation_id, id) ON DELETE CASCADE);
CREATE TABLE drafts(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL, version INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE draft_conflicts(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_save_id TEXT NOT NULL, base_version INTEGER NOT NULL, text TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'open' CHECK(resolution IN ('open','kept','dropped')),
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, client_save_id));
CREATE TABLE imports(source TEXT NOT NULL, source_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  import_batch_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (source, source_key));
CREATE TABLE producer_fences(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  owner_token TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL
  CHECK(state IN ('held','released','dead')) DEFAULT 'held', updated_ms INTEGER NOT NULL);
```

Rules (all S2 record behavior except where noted). `model_requested` (asked) vs
`model_reported` (native claim) vs `served_verified` (independently verified, NULL
until proven) stay separate; reported never overwrites requested. Model/role may be
edited until native binding or uncertain dispatch, then pinned: after a native ref
is bound or a turn leaves `queued`, controller/model/role/effort-scope changes open
a new parent-linked conversation with context passed via a `handoff` operation,
never an in-place edit. Codex `effort` applies per turn; Claude `effort` is pinned
to the native session. A Codex `turn/started` signal establishes observed activation;
`written` means bytes reached native transport (not an ACK) and `observed` means the
controller's own observation semantics (Claude observed input/assistant identities
are its own semantics). Native lifecycle: store the returned Codex thread id before
turn/start; persist the requested Claude session UUID as requested before launch,
then bind the actually observed control UUID as the `native_refs` native ref; a
crash before binding leaves the native side unknown/orphan — never an invented
association, replay, or auto-grant. Same-project binding: the composite
`(conversation_id, project_id, controller)` FK on `native_refs` keeps a native ref
on its conversation's project and controller; parent
linkage stays same-project via composite parent columns plus composite FK, or via
explicit required transactional S2 validation where the schema FK cannot reach.
`operations` carry `(conversation_id, turn_id)` FKs; approval, clarification-answer
and Stop require a turn; `draft_save` and handoff may have NULL turn ids. The integer
`owner_generation` is the writer-fence counter, distinct from the actual host UUID
in `host_generation`; local draft saves use counter 0 and NULL host generation.
Every Claude turn carries a nonnull unique `claude_input_uuid`;
`native_turn_id` stays distinct from UI `turns.id`. The native request id is typed
(canonical JSON with `native_request_id_type`, so numeric `0` and string `"0"`
differ); `history_json` retains approval outcomes and is never deleted.
`clarifications` keep `question_json`/`answer_json`; rows go `unactionable` after
generation loss and are never revived. Every non-terminal turn found after a crash
becomes `unknown`/recovery-required unless a proven not-sent fact exists.
Large-body rule: any large normalized class (prompt/tool/clarification/text) over
the per-event cap uses bounded body refs/chunks or an explicit reject — never
truncation, never a stored raw provider payload. Each commit writes its
`large_bodies` rows, `events` rows, matching `snapshots` row, and operation outcome
in one SQLite transaction (atomic); `seq` is per-conversation, assigned at commit,
immutable afterwards. Bounds: prompt and draft at most 65536 UTF-16 code units
(matches today's composer limit); oversized bodies persist in `large_bodies`
(byte-exact, verified by `sha256_hex`) with events carrying `{body_ref, chunks}`.
Empty-draft edits need not create a chat. Imports create conversations/turns/events
only, with NULL native ids and no `native_refs` rows — never fabricated native
associations. Draft idempotency: each save carries a stable save/mutation id plus a
payload hash, and the ACK returns the prior result receipt on retry (a generic
`operations` row with kind `draft_save` may serve as the receipt record). A missing
draft with expected version 0 creates v1 on first save; same id + same payload
returns the prior receipt; same id + changed payload is a key conflict; distinct
stale save ids each persist their own immutable `draft_conflicts` row — no single
overwritten conflict text. Draft save/record behavior is S2, draft UI is S4. There
is no retention watermark and no pruning in v1.

## 2. Path, DB identity, one writer, ownership fence

The DB file lives under the trusted Rust app-local state root
(`app_local_data_dir()/host-state`), e.g. `<state_root>/cho-store/cho-sessions.sqlite3`
(plus WAL sidecars). The store core accepts an explicit absolute path only; it never
derives paths from repo, cwd, or browser input. There is no caller-defined app id:
one fixed module application id (`cho.sessions.v1`) is the only admitted value.
Admission: inspect existing nonempty files through a read-only connection first;
only an absent/zero-length path is eligible for initialization. Schema, `meta` row (`instance_uuid`, `schema_version`), and
`PRAGMA user_version` initialize in one transaction, and identity/version/schema are
rechecked under the write lock to close the two-process initialize race. Before ANY
WAL/DDL/`user_version`/data write, refuse a foreign `meta.application_id`, a
`user_version` of 0 on a nonempty file, a newer `schema_version` than the running
code, or a malformed/corrupt header — bytes untouched. `meta` is a singleton row
whose schema/version must stay consistent. `meta.instance_uuid` is logical lineage,
not a clone detector: the explicit S5 restore/clone path rotates identity before
serving; no guarantee is claimed for arbitrary manual file copies. The existing Rust
host may later enforce one app-wide owner; that is separate from this module.
One `DatabaseSync` connection per host process; all writes go through one serialized
queue in that process. Per-transaction SQLite serialization is NOT producer
exclusivity: SQLite serializes transactions, while `producer_fences` serializes which
live owner may produce for a conversation (fence behavior is S2+S3). Fence rule:
the first claim INSERTs the absent row as `held` at generation 1 (unique conflict
refuses); the same owner token/generation may renew; a `released`/`dead` fence
returns to `held` only by CAS on the expected generation with an increment and a new
token, matching `state IN ('released','dead')` — never by matching `held`. A
`held`/ambiguous owner NEVER transfers by time or manual override: only a verified
host release/death write sets `released`/`dead`; there is no TTL takeover and no
PID-only death proof. New work starts only after process identity/liveness is
established. Startup with an ambiguous fence refuses the producer plus a
user-visible recovery path (verify death via host liveness, verified
`released`/`dead` write after verified process identity/death). `busy_timeout` 100ms:
`SQLITE_BUSY` surfaces as a bounded visible error, never a silent
provider-side-effect retry. No JSON sidecar is authoritative state. The named
module-level `import { backup } from 'node:sqlite'` exists on pinned 24.22.2; there
is no destructive migration or backup API in S1.

## 3. Events, cursors, snapshots, poll bounds (S3)

Durable cursor is `(instance_uuid, conversation_id, seq)`. Normalized facts are
recorded before any durable ACK or display. Append is idempotent on caller-stable
`event_key` with canonical `payload_json`: same key + same canonical payload returns
the existing `seq` with no double projection; same key + different payload is a key
conflict. Cursor checks reject wrong-conversation/project, negative, beyond-tip, and
other-instance cursors with defined errors. Poll is replay-by-cursor
(`SELECT ... WHERE conversation_id=? AND seq>? ORDER BY seq`), not a destructive
drain. One poll returns at most 32 events AND at most 128KiB TOTAL serialized bytes
including a fixed 2KiB envelope/overhead margin; each event payload is capped (32KiB
default), stopping before either bound trips, with caller limits applied inside the
bounds. Oversized bodies and projections are paged via `large_bodies`/snapshot
pages, never one unbounded `projection_json` in a poll. Bounded history/list reads
are separate (conversation lists at most 100 rows; history windows bounded by caller
limit, default 50, max 200); they are not poll bounds. Disk-full, corruption, or
write failure aborts the transaction, advances no cursor, and surfaces a visible
store error; the provider effect is never retried automatically (§4). Cursor
ownership (generation/project token) is checked by the host before serving.

## 4. Crash windows and close (RUN06; future S3/S4)

User intent is persisted (`turns` row in `queued`) before any native side effect.
Exactly-once provider execution and dispatch ownership after a crash cannot be
proven, so §1's unknown rule applies. No automatic resend, auto-grant, transcript
replay, or provider resume on startup. A pending approval/clarification whose
generation is gone is marked `unactionable` (historical record only, outcome kept in
`operations.history_json`). New work or recovery requires explicit fresh project
trust plus native revalidation (re-resume the native session and confirm continuity,
else start a new conversation with a handoff). Close in v1 is interrupt-and-close
only — no detach. With active work, the UI explicitly chooses cancel-close or
interrupt-close. The Stop intent is persisted, followed by a bounded graceful wait
and then owned cleanup; only an actually observed native interrupted fact marks a
turn `interrupted` — forced or uncertain teardown stays `unknown`. S1 does not
spawn, interrupt, or resume providers.

## 5. Drafts, text fidelity, imports (S2 records, S4 UI, S5 transport)

One `drafts` row per conversation. Saves use CAS:
`UPDATE drafts SET ... WHERE conversation_id=? AND version=?`; the save ACK is
returned only after commit, with the receipt rule in §1. A stale save never
overwrites: each distinct save id inserts its own immutable
`draft_conflicts(conversation_id, client_save_id)` row holding the full conflicting
text; conflicts are listed/resolved explicitly (`resolution`, version CAS on
resolve) and prior conflicting text survives resolution; no silent deletion.
Message, answer, and draft text are stored byte-exact (no trimming). Titles,
archive, search, and export are future consumers of these same tables, not separate
stores. Transcript imports are atomic per batch and idempotent via
`imports(source, source_key)`; they create conversations/turns/events only, with
NULL native ids and no `native_refs` rows.

## 6. Versions and migration

`PRAGMA user_version` mirrors `meta.schema_version` (v1). Fresh setup creates the
schema above and stamps it in the same transaction (§2). Newer-than-code versions
fail closed per §2 admission. Legacy browser data enters only as a transcript import
(S5, §5), distinct from native resume (S5, not implemented here). No destructive
migration in S1; any future destructive migration is a separately reviewed
implementation with backup-then-migrate-then-verify. Checkpoint on clean close;
readers tolerate WAL sidecars.

## 7. Slice scope, S1 API, errors, acceptance

S1 is ONLY the standalone SQLite schema/lifecycle plus the guarded synchronous
transaction boundary. Its entire surface is
`openSessionStore({ databasePath })` → metadata `{ instanceId, schemaVersion }`,
`transaction(fn)` for trusted internal code, and `close()`. `transaction` passes
callback-scoped guarded `run`/`get`/`all` helpers; no raw DB handle or prepared
statement escapes the callback. The callback must be synchronous: a returned
thenable forces rollback and expires the helpers, and no async write after return
is admitted. There is no external/IPC SQL endpoint and no records CRUD, poll,
draft, or native-binding claims in S1. Bounded busy (100ms), no nested transaction,
no close-inside-transaction; calls after close reject. S1 errors (each with a
stable code and message): `ERR_BAD_PATH` (missing/non-absolute path),
`ERR_FOREIGN_DB` (foreign application id), `ERR_FUTURE_VERSION` (newer schema than
code), `ERR_SCHEMA_MISMATCH` (corrupt header, version-0-nonempty, or meta/singleton
divergence), `ERR_BUSY` (bounded busy timeout incl. competing initializer),
`ERR_STORAGE` (I/O, disk-full, integrity failure), `ERR_CLOSED` (use after close),
`ERR_INVALID_TX` (nested transaction, close-in-tx, async write after return, or
thenable callback). S1 machine checks: fresh open then reopen keeps the same
instance id; PRAGMA WAL/FULL/FK read-back; malformed/foreign/future files preserved
byte-identical; commit persists, rollback and thenable-callback discard, nested and
close-in-tx and post-close and async-after-return reject; real-busy and competing
initializer surface `ERR_BUSY` without writes by the losing attempt (the winning
writer may advance the shared DB). Later slices own the
rest: S2 records/native refs/turns/operations/clarifications/large bodies/drafts/
mutation receipts/fences; S3 durable host event coupling and close; S4 UI
history/drafts; S5 explicit resume/import/export/restore (incl. identity rotation).
No S1 check implies imported-transcript or native-recovery coverage. Two-family
review where data-loss risk exists. No production-ready claim until native
close/reopen with rendered recovery is tested.
