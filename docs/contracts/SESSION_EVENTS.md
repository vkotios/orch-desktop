# Durable event API — CHO-03 S3a

Source checkpoint: `b104e83`. Standalone trusted internal storage only;
native producers and poll RPC still use the existing in-memory mailbox. This
does not establish application persistence, restart recovery or native delivery.

`createSessionEvents({ store, verifyOwnerEvidence, now = Date.now })` returns a
frozen API without I/O. The caller owns the S1 store lifetime. Every public data
call uses one synchronous transaction. `inTransaction(tx)` exposes the three data
methods on an active transaction from the same database lineage; its results
remain provisional until outer commit. No native effects belong in that callback.

| Method | Result |
| --- | --- |
| `appendEvent({ ...scope, eventKey, kind, payload, expectedSeq, projection })` | `{ created, event, cursor }`, after the event and snapshot commit together. |
| `pollEvents({ projectId, conversationId, cursor = null, limit = 32, maxBytes = 131072 })` | `{ events, cursor, tip, hasMore }`, with no deletion or acknowledgement write. |
| `getSnapshot({ projectId, conversationId })` | Current five-field summary, or null for an empty stream. |

Mutation scope is `{ projectId, conversationId, ownerToken, ownerGeneration,
hostGeneration, evidence }`. All appends, including duplicate-key retries, use
the shared strict producer verifier inside the write transaction. Evidence is
opaque and excluded from storage. Reads check project/chat binding and need no
live producer proof; they grant no execution permission. Future host access,
trust, process identity and generation validation remain separate work.

Fresh append requires expectedSeq equal to the committed tip. Each conversation
starts at zero; new facts get tip + 1. Same eventKey, kind and canonical payload
return the original event/sequence without updating the snapshot, even when
expectedSeq is now stale. The projection argument is ignored on that retry.
Changed kind/payload conflicts. Keys are scoped to the conversation. No pruning,
coalescing or automatic provider replay exists.

Event records are `{ seq, eventKey, kind, payload, createdAtMs }`; the global
SQLite row ID is not a cursor. Keys are exact strings of 1–512 UTF-16 units.
Kinds match `[a-z][a-z0-9_]{0,63}`. Payload roots must be plain JSON objects.
Canonicalization sorts object keys, preserves arrays/text and safely handles
prototype-like own keys. It rejects accessors without invoking them, unsafe
values, sparse arrays, NUL and unpaired surrogates. Limits: depth 16, 4096 nodes,
32768 aggregate string units, and 32KiB final UTF-8 JSON. Oversize rejects rather
than truncates. The trusted caller must supply normalized, appropriately redacted
facts; this core does not recognize provider secrets or raw-wire semantics.

Fresh projection input is `{ state, bodyRefs }`, with a plain JSON state object
and at most 64 unique body UUIDs belonging to the same chat. The stored/returned
summary is exactly `{ version: 1, conversationId, lastSeq, bodyRefs, state }`,
capped at 32KiB including the wrapper. The future typed reducer supplies state;
this storage layer does not prove its semantic correctness. Large content stays
in [body storage](SESSION_BODIES.md), read separately in bounded chunks.
Snapshot, event and future journal/outcome/body changes can share an outer
transaction. Any failure rolls back the event and snapshot together.

Cursors are `{ instanceId, conversationId, seq }`. Null starts at zero. Wrong
instance/chat, negative or beyond-tip cursors reject without reset or clamping.
Poll returns a contiguous prefix after the input sequence. Its cursor advances
only through returned events, with `hasMore` indicating remaining facts.
Repeating a cursor replays committed facts without consuming them.

Poll limit is 1–32. maxBytes is 4096–131072 and includes the actual serialized
reply plus a reserved 2048-byte envelope margin. A head event that cannot fit
raises `ERR_EVENT_PAGE_TOO_SMALL`; it never returns an endlessly empty page.
Poll excludes snapshots and full bodies. These are internal response bounds;
native IPC/composer capacity is unchanged. No durable ACK/display claim is made
until host producers and consumers are coupled to commits.
Cursor null intentionally means sequence zero. For limit and maxBytes, defaults
apply only to omitted/undefined arguments; explicit null is invalid.

Errors are static: `ERR_EVENT_KEY_CONFLICT`, `ERR_EVENT_VERSION_CONFLICT`,
`ERR_CURSOR_INSTANCE`, `ERR_CURSOR_SCOPE`, `ERR_CURSOR_RANGE`,
`ERR_EVENT_PAGE_TOO_SMALL`, invalid-record, missing-target, version-limit and
storage errors, plus shared producer/S1 errors. Detected gaps or malformed
stored facts fail closed; the module does not repair or qualify imported or
arbitrarily corrupted databases. Safe clocks and fresh timestamp ordering are
required; exact retries add no new timestamp.

Verification: S3a source `b104e83` adds canonical durable events, per-chat sequence cursors
and atomic bounded snapshots. Expected-sequence checks prevent stale summary
writes; duplicate keys replay the original fact without double projection.
Reads are non-destructive, count/byte bounded and advance only returned facts.
All 674 package tests, including 10 event tests, type checking and web
build pass. Installed/bundled Node child-process probes establish reopen, a
single concurrent sequence winner, exact replay/byte budgets/cursor errors and
ABORT/IGNORE snapshot-fault plus outer body/event rollback. Controller and
complete GLM 5.3 high/Vibe review leave no unresolved High or Medium issue.
The native mailbox, host polling and UI remain unwired to this store.
