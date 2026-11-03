# Session Stop API — CHO-03 S2e

Source checkpoint: `7a6131e`. This internal API stores one Stop intent and
its dispatch journal per turn. No host, UI or provider consumes it yet. See
[SESSION_STORAGE](SESSION_STORAGE.md) and [SESSION_TURNS](SESSION_TURNS.md).

`createSessionStops({ store, verifyOwnerEvidence, now = Date.now })` returns a
frozen API without I/O. Each public data method uses one synchronous S1
transaction; the caller owns the store and close. Mutation scope is
`{ projectId, conversationId, turnId, operationId, ownerToken, ownerGeneration,
hostGeneration, evidence }`. Every mutation, including retries, checks the live
fence/proof and the parent handoff plus Stop owner/host provenance in that same
transaction. A new current owner cannot adopt old journals. Reads remain
available without live proof after release or generation change.

| Method | Behavior |
| --- | --- |
| `requestStop({ ...scope, reason = 'user' })` | Atomically insert a Stop intent, or return `{ created: false, stop }` for an exact retry. Reason is user or close. |
| `beginStopDispatch({ ...scope })` | Commit one-shot queued → dispatching admission and derive the native target from stored identities. Repeats never grant another permission. |
| `recordStopWritten({ ...scope, dispatchTarget })` | Record an actual interrupt transport write with the exact admitted target. This is not acknowledgement. |
| `settleStop({ ...scope, outcome, dispatchTarget = null })` | Settle as acknowledged, unknown or not_needed with exact terminal retry semantics. Never settles the turn. |
| `getStop({ projectId, conversationId, turnId })` | Full record or null if no Stop, after project/chat validation. |
| `inTransaction(tx)` | The same five methods on an active transaction from the same store lineage. Results are provisional until the outer commit. |

A record contains id, conversationId, turnId, reason, state, outcome,
dispatchTarget, ownerGeneration, hostGeneration, createdAtMs, settledAtMs and
history. There is at most one Stop operation for a turn's lifetime, regardless
of caller operation ID. Changed payload/kind/chat cannot reuse an operation ID;
a different Stop ID cannot create a second interrupt for the same turn. Exact
request retries return the current record without writes, including after the
turn ends. No reset, overwrite, automatic retry or re-arm API exists.

The host must commit beginStopDispatch before any native interrupt effect.
Codex requires the persisted observed native thread and turn IDs. Claude requires
a confirmed written/observed input and its persisted input UUID; the requested
session UUID is sufficient after a write if observation has not yet arrived.
A later matching observed binding confirms that snapshot without rewriting it.
No native reference is fabricated. A queued intent alone cannot dispatch an
interrupt, and a terminal target cannot newly dispatch one through this API.
The future host must coordinate Stop requests with pending turn submission.

The target is exactly `{ controller, nativeIdentity, nativeTurnId,
claudeInputUuid, identitySource }`. Codex uses observed source, opaque thread/turn
IDs and null input UUID. Claude uses requested or observed source, its session
and input UUIDs, and null nativeTurnId. Written/acknowledgement callbacks must
match the admitted snapshot and compatible current identities. Target turns may
already have settled when a late callback arrives.

Acknowledged means only a matching interrupt-request acknowledgement; it is not
proof of an interrupted turn, stopped process or completed cleanup. A command's
`cancelling: true` admission alone is insufficient. Only a matching native outcome
may mark the turn interrupted through SESSION_TURNS; uncertain teardown leaves
the turn unknown. A Stop may settle as unknown from any pending state and never
revives. Not_needed is limited to a queued Stop whose target has
settled completed/failed/interrupted; unknown target state is insufficient.
Terminal retries must match both outcome and the original supplied target/null.

UUIDs are canonical lowercase; opaque native IDs are exact, nonempty, at most
512 UTF-16 units and reject NUL/unpaired surrogates. History and receipts are
bounded to 8KiB each, with normalized facts only and no prompts, credentials,
proof evidence or raw provider payloads. Static error codes are
`ERR_INVALID_RECORD`, `ERR_NOT_FOUND`, `ERR_IDEMPOTENCY_CONFLICT`,
`ERR_STOP_CONFLICT`, `ERR_DISPATCH_CONFLICT`, `ERR_STOP_STATE` and `ERR_STORAGE`,
plus the existing fence/proof errors. S1 busy, closed and expired-transaction
errors propagate. Detected corruption is not repaired.

Future S3 Stop/event/projection/outcome writes must compose in one outer
transaction. Never perform provider effects in that callback or act on a
provisional dispatch result. Actual host proof, native interruption/cleanup,
approval and clarification journals, body-reference integration, UI persistence
and restart reconciliation remain separate work.
