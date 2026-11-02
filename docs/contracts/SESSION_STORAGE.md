# SESSION_STORAGE — durable session/event store contract (CHO-03)

Status: contract v1, design only. No implementation in this slice.
Authority: PRODUCT_SPEC SESSION-01–06, RUN-04/06, §9; IMPLEMENTATION_PLAN CHO-03; CHO-04 clarification milestone.
Runtime: `node:sqlite` `DatabaseSync` (synchronous execution) on bundled Node 24.22.2.
Official reference: [Node.js v24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
First implementation is one standalone Node store module. No UI, IPC, provider wiring, or provider start.

## 1. Records and schema (v1)

UI ids are generated UUIDs (`TEXT`). Real Codex thread ids and Claude session/input
UUIDs live only in `native_refs`/`turns`, never as UI ids. Imports carry NULL native
ids, never invented ones. Raw credentials and raw provider payloads are never stored.
Parent/child links are nullable future linkage for delegation (CHO-05).

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
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
CREATE INDEX conv_project_updated ON conversations(project_id, updated_at_ms);
CREATE TABLE native_refs(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  controller TEXT NOT NULL CHECK(controller IN ('codex','claude')),
  native_thread_id TEXT NULL, native_session_uuid TEXT NULL,
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, controller),
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
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(conversation_id, seq), UNIQUE(conversation_id, event_key));
CREATE INDEX events_cursor ON events(conversation_id, seq);
CREATE TABLE snapshots(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL, projection_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE large_bodies(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  byte_len INTEGER NOT NULL, sha256_hex TEXT NOT NULL, body_text TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE operations(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NULL, kind TEXT NOT NULL CHECK(kind IN ('approval','clarification_answer','stop','handoff')),
  owner_generation INTEGER NOT NULL, native_request_id_text TEXT NULL,
  native_request_id_type TEXT NULL CHECK(native_request_id_type IN ('number','string')),
  decision TEXT NULL, state TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER NULL);
CREATE TABLE clarifications(
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  native_question_id TEXT NOT NULL, question_json TEXT NOT NULL, status TEXT NOT NULL
  CHECK(status IN ('pending','answered','invalid','unactionable')),
  answer_json TEXT NULL, answered_at_ms INTEGER NULL);
CREATE TABLE drafts(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL, version INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE draft_conflicts(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_save_id TEXT NOT NULL, base_version INTEGER NOT NULL, text TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'open' CHECK(resolution IN ('open','kept','dropped')),
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, client_save_id));
CREATE TABLE imports(
  source TEXT NOT NULL, source_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  import_batch_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (source, source_key));
CREATE TABLE producer_fences(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  owner_token TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL
  CHECK(state IN ('held','released','dead')) DEFAULT 'held', updated_ms INTEGER NOT NULL);
```

Rules: `conversations.controller/model_requested/role/effort` are immutable after
creation for BOTH controllers (schema trigger or required transactional check
rejects updates); a model or controller change opens a new conversation
(parent-linked, context passed via a `handoff` operation), never an in-place edit.
`model_requested` (asked) vs `model_reported` (native claim) vs `served_verified`
(independently verified, NULL until proven) are separate columns; reported never
overwrites requested. One real native id is owned by at most one conversation in
this DB (`native_thread_once`/`native_session_once` plus `(project_id,
conversation_id, controller)` binding, enforced in schema and re-checked in the
owning transaction). A Claude turn carries its per-turn `claude_input_uuid`;
`native_turn_id` stays distinct from the UI `turns.id`. `operations` rows carry
their `turn_id` and the `owner_generation` that issued them; the native request id
is typed: canonical JSON encoding with `native_request_id_type` so numeric `0`
and string `"0"` are distinct values; `history_json` retains the approval outcome
history and is never deleted. `clarifications` retain the original
`question_json`/`answer_json`; rows go `unactionable` after generation loss and
are never revived. `written` means bytes reached native transport, NOT an ACK;
`observed` means a native turn/started signal was seen; activation alone is not
observation. Every non-terminal turn (`queued`/`written`/`observed`, including
queued intent with no transport proof) found after a crash becomes `unknown`/
recovery-required unless a proven not-sent fact exists for it.

## 2. Path, DB identity, one writer, ownership fence

The DB file lives under the trusted Rust app-local state root
(`app_local_data_dir()/host-state`), e.g. `<state_root>/cho-store/cho-sessions.sqlite3`
(plus WAL sidecars). The store core accepts an explicit absolute path only; it never
derives paths from repo, cwd, or browser input. Admission: open the path read-only
first; initialize a new DB only when the file is absent/zero-length. Before ANY
WAL/DDL/`user_version` write, refuse: foreign `meta.application_id`, a
`user_version` of 0 on a nonempty file, or a newer `schema_version` than the running
code (`ERR_FOREIGN_DB` / `ERR_FUTURE_VERSION`, bytes untouched). `meta.instance_uuid`
identifies this DB copy; cursors carry it (§3). The existing Rust host may later
enforce one app-wide owner; that is separate from this module.
One `DatabaseSync` connection per host process; all writes go through one serialized
queue in that process. This per-transaction write serialization is NOT producer
exclusivity: SQLite serializes transactions, while `producer_fences` serializes
which live owner may produce for a conversation. Claim is atomic CAS:
`UPDATE producer_fences SET owner_token=?, generation=generation+1 ... WHERE
conversation_id=? AND owner_token=? AND generation=? AND state='held'`; exactly one
row changed wins, zero means conflict. There is no TTL takeover: a paused process
may still be writing, so expiry alone never transfers ownership. Startup with an
ambiguous fence (`held` by a token whose death/release is unverified) refuses the
producer with `ERR_AMBIGUOUS_OWNER` plus a user-visible recovery path (verify death
via host liveness, verified `released`/`dead` write, or explicit operator release).
`busy_timeout` 100ms: `SQLITE_BUSY` surfaces as a bounded visible error, never a
silent provider-side-effect retry. No JSON sidecar is authoritative state.

## 3. Events, cursors, snapshots, poll bounds

Durable cursor is `(instance_uuid, conversation_id, seq)`. Normalized facts are
recorded before any durable ACK or display. Append is idempotent on caller-stable
`event_key` with canonical `payload_json`: same key + same canonical payload returns
the existing `seq` with no double projection; same key + different payload is
`ERR_KEY_CONFLICT`. Each commit writes its `events` rows and the matching
`snapshots` row in one SQLite transaction (atomic); `seq` is per-conversation,
assigned at commit, immutable afterwards. No event pruning in v1. Cursor checks
reject `ERR_WRONG_OWNER` (other conversation/project), negative (`ERR_BAD_CURSOR`),
beyond tip (`ERR_FUTURE_CURSOR`), and other-instance (`ERR_WRONG_INSTANCE`) cursors.
Poll is replay-by-cursor
(`SELECT ... WHERE conversation_id=? AND seq>? ORDER BY seq`), not a destructive
drain. One poll returns at most 32 events AND at most 128KiB TOTAL serialized bytes
including cursor/envelope overhead: reserve a fixed nonzero 2KiB envelope margin and
cap each event payload at 32KiB, stopping before either bound trips. Large prompts
(up to 65536 Unicode chars, counted in code points) and streamed history stay exact:
bodies over the per-event cap persist in `large_bodies` (byte-exact, no trimming,
verified by `sha256_hex`) and events carry `{body_ref, chunks}` with bounded chunks,
never the oversized full body or a full snapshot in one poll. Resync is paginated
against `snapshots`+`events`, never one unbounded `projection_json`. Bounded
history/list reads are specified separately (conversation lists at most 100 rows;
history windows bounded by caller limit, default 50, max 200); they are not poll
bounds. Disk-full, corruption, or write failure aborts the transaction, advances no
cursor, and surfaces a visible store error; the provider effect is never retried
automatically (§4). Cursor ownership (generation/projectToken) is checked by the host
before serving; a cursor below the retention watermark returns an explicit resync
signal with the paged snapshot, never silent loss.

## 4. Crash windows

User intent is persisted (`turns` row in `queued`) before any native side effect.
Exactly-once provider execution and dispatch ownership after a crash cannot be
proven, so §1's unknown rule applies. There is no automatic resend, auto-grant,
transcript replay, or provider resume on startup. A pending approval/clarification
whose generation is gone is marked `unactionable` (historical record only, outcome
kept in `operations.history_json`). New work or recovery requires explicit fresh
project trust plus native revalidation (re-resume the native session and confirm
continuity, else start a new conversation with a handoff).

## 5. Drafts, text fidelity, imports

One `drafts` row per conversation. Saves use CAS:
`UPDATE drafts SET ... WHERE conversation_id=? AND version=?`; the save ACK is
returned only after commit. A stale save never overwrites: it inserts an immutable
`draft_conflicts(conversation_id, client_save_id)` row (repeat `client_save_id`
dedupes to the same row) holding the full conflicting text; conflicts are listed/
resolved explicitly (`resolution`, version CAS on resolve) and prior conflicting text
survives resolution; no silent deletion (retention-bounded only with a stated bound
and query path). Message, answer, and draft text are stored byte-exact (no trimming).
Bounds: prompt and draft at most 65536 Unicode chars (matches today's composer
limit); large bodies persist via §3 references. Titles, archive, search, and export
are future consumers of these same tables, not separate stores. Transcript imports
are atomic per batch and idempotent via `imports(source, source_key)`; they create
conversations/turns/events only, with NULL native ids and no fabricated native
associations.

## 6. Versions and migration

`PRAGMA user_version` mirrors `meta.schema_version` (v1). Fresh setup creates the
schema above and stamps it. Newer-than-code versions fail closed per §2 admission.
Legacy browser data enters only as a transcript import (§5), distinct from native
resume (S5, not implemented). Backup means the online `backup()` API to a
timestamped file — copying only the main DB file of a live WAL database does NOT
back up data. No destructive migration in S1; any future destructive migration is a
separately reviewed implementation with backup-then-migrate-then-verify. Checkpoint
on clean close; readers tolerate WAL sidecars.

## 7. S1 contracts and acceptance (machine-checkable)

S1 scope: file lifecycle + DB-identity admission + v1 schema + transaction boundary
only. Accepted inputs: absolute DB path; `init(app_id)`; `append(conversation,
event_key, kind, canonical_payload_json)`; `poll(cursor)`; `saveDraft(cas)`.
Outputs: `seq`, paged events, `(instance_uuid, seq)` cursors, explicit errors
(`ERR_FOREIGN_DB`, `ERR_FUTURE_VERSION`, `ERR_BAD_CURSOR`, `ERR_FUTURE_CURSOR`,
`ERR_WRONG_INSTANCE`, `ERR_WRONG_OWNER`, `ERR_KEY_CONFLICT`, `ERR_VERSION_MISMATCH`,
`ERR_AMBIGUOUS_OWNER`, `ERR_BUSY`). Checks with fake boundaries, no live providers:
reopen keeps native refs/history; cross-project reads never leak; immutability
update rejected; duplicate native id rejected; same key+payload dedupes to same seq;
same key+different payload conflicts; event+snapshot commit atomic on injected
failure; cursor replay monotonic; wrong-owner/negative/future/wrong-instance cursors
rejected; poll never exceeds 32 events or 128KiB total; 65536-char Unicode body
round-trips exact via reference; ambiguous fence refuses startup; stale draft CAS
creates an immutable conflict row and repeat `client_save_id` dedupes; foreign
appid / user_version-0-nonempty / future version refused before any write; newer DB
refused byte-preserving; `integrity_check` errors surface; imports idempotent and
native-free; exports redacted. Two-family review where data-loss risk exists. No
production-ready claims until native close/reopen with rendered recovery is tested.
