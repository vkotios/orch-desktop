# Session turns API — CHO-03 S2c

Source checkpoint: `c853ef0`. This trusted internal Node module persists turn
intents and their dispatch journals for existing conversations. The application
host and UI do not consume it yet. See [SESSION_STORAGE](SESSION_STORAGE.md),
[SESSION_RECORDS](SESSION_RECORDS.md) and [SESSION_BINDINGS](SESSION_BINDINGS.md).

## Transaction and ownership boundary

`createSessionTurns({ store, verifyOwnerEvidence, now = Date.now })` returns a
frozen API. Construction opens no files and starts no provider; the caller owns
the store and its close operation. Each public data method uses one synchronous
S1 transaction. Every mutation checks the project/chat binding, held producer
token/generation, trusted proof and paired operation provenance in that same
transaction, including idempotent retries.

Mutation scope is `{ projectId, conversationId, ownerToken, ownerGeneration,
hostGeneration, evidence }`. The fence counter `ownerGeneration` and UUID
`hostGeneration` are distinct. The trusted synchronous verifier receives frozen
facts `{ action: 'live', projectId, conversationId, ownerToken,
generation: ownerGeneration, hostGeneration, evidence }`. Only strict `true`
authorizes; false, other values, exceptions and asynchronous results reject with
`ERR_OWNER_UNVERIFIED`. Evidence is opaque and never stored or logged.

The future host must prove process identity, token association, liveness,
freshness and the association of hostGeneration with that owner. The callback
evaluates previously obtained facts, without SQL, IPC or provider effects.
Synthetic callbacks in tests establish storage behavior only. A new current
owner cannot adopt a previous owner's journal through this API.

## API

All mutation methods additionally take `turnId` and `operationId`. Read methods
need projectId/conversationId, with turnId for an individual turn.

| Method | Behavior |
| --- | --- |
| `queueTurn({ ...scope, turnId, operationId, prompt, claudeInputUuid = null, effort })` | Atomically insert a queued turn and one paired handoff operation; return `{ created, turn }`. |
| `beginDispatch({ ...scope, turnId, operationId })` | One-shot queued → dispatching admission. For valid stored data, repeats reject `ERR_DISPATCH_CONFLICT`; malformed native refs fail `ERR_STORAGE` first. |
| `recordWritten({ ...scope, turnId, operationId })` | Record an actual transport write after dispatch admission. This is not acknowledgement or completion. |
| `recordObserved({ ...scope, turnId, operationId, nativeFact })` | Validate a native observation against the persisted observed binding and turn correlation. |
| `settleTurn({ ...scope, turnId, operationId, outcome, nativeFact = null })` | Atomically settle turn, operation, receipt and history as completed/failed/interrupted/unknown. |
| `getTurn({ projectId, conversationId, turnId })` | Full record, or null if the turn is absent after project/chat validation. |
| `listTurns({ projectId, conversationId, limit = 50, offset = 0 })` | Sequence-ordered metadata; omit prompt and history. Limit 1–100, nonnegative safe-integer offset. |
| `inTransaction(tx)` | The same data methods on an active S1 transaction from the same store lineage, without nesting. |

Full records contain id, conversationId, operationId, seq, prompt, controller,
modelRequested, role, effort, claudeInputUuid, nativeTurnId, intentState, outcome,
dispatchState, ownerGeneration, hostGeneration, createdAtMs, settledAtMs and
history. Historical reads require no live proof. Returned metadata is not
permission to dispatch.

Controller/model/role come from the conversation. Codex effort may be supplied
per turn; Claude effort remains pinned. Claude requires a globally unique input
UUID; Codex requires null. Queue retries use a stable hash including exact text,
configuration and ownership provenance. An exact retry returns `created: false`
with the current record and no writes, including after dispatch or settlement.
That retry currently skips native-ref revalidation; subsequent dispatch admission
validates the ref and fails closed on corruption. Eager retry validation is tracked.
Different payload/owner/kind/chat cannot reuse the operation ID. A second
operation cannot replace an existing turn. Other operation kinds may coexist on
the turn; exactly one handoff journal is required.

## Dispatch and native facts

The host must commit `beginDispatch` before **any** provider effect, including
thread creation, process launch and input writes. The turn intent remains queued
while dispatchState is dispatching; queued intent alone is not proof of not-sent.
Repeated begin never grants a second dispatch.

`nativeFact` has exactly `{ nativeIdentity, nativeTurnId, claudeInputUuid }`.
Codex requires the bound thread identity and a real opaque native turn ID, with
null input UUID. Claude requires the persisted observed session UUID and the
stored input UUID, with null nativeTurnId. Observed and terminal facts cannot
use only a requested Claude session UUID. Only `recordWritten` permits that
prelaunch request while the observed ref is still absent. Codex requires its
bound thread before recording a write.

Observation may precede the local write callback. A late write appends its fact
without regressing observed state. Duplicate facts do not grow the journal.
Native turn identity is bound once and cannot change. Completed/interrupted
require a matching native fact after dispatch admission. Failed before dispatch
may omit a fact; after admission it requires one, otherwise use unknown. Exact
terminal retries must match both outcome and the original fact tuple, including
null. Unknown stays terminal and never authorizes automatic replay; it does not
establish that the native process has stopped. Stop and recovery remain separate
work.

`inTransaction` results are provisional until the **outer** transaction commits.
Future event/projection/outcome writes must compose in one outer transaction.
Never perform provider effects in that callback or act on a provisional dispatch
result. Separate successful public calls do not establish a joint atomic commit.

## Bounds, errors and remaining work

UUIDs are canonical lowercase. Prompt text is nonempty and bounded by both
65536 UTF-16 units and 32768 UTF-8 bytes. NUL and unpaired surrogates reject;
accepted text is preserved exactly. Oversize rejects without truncation; bounded
large-body records are deferred. History is normalized facts, at most one per
kind and 8KiB JSON; receipts are at most 2KiB. Raw provider payloads, credentials
and proof evidence do not belong in these records.

Errors: `ERR_INVALID_RECORD`, `ERR_NOT_FOUND`, `ERR_FENCE_CONFLICT`,
`ERR_OWNER_UNVERIFIED`, `ERR_IDEMPOTENCY_CONFLICT`, `ERR_RECORD_CONFLICT`,
`ERR_DISPATCH_CONFLICT`, `ERR_TURN_STATE`, `ERR_TURN_CONFLICT`,
`ERR_VERSION_LIMIT` and `ERR_STORAGE`. S1 busy/closed/expired-transaction errors
propagate. Messages do not echo prompts, evidence or parser/SQL diagnostics.
A missing/multiple handoff pair or detected malformed stored journal rejects;
this API does not repair corruption.

The current list bounds returned metadata but internally loads full prompt/history
and sibling operation rows. SQL projection/filtering and exhaustive imported
journal validation remain follow-ups before large histories/restore. Execution
operations beyond the turn journal, clarification records, large bodies, durable
events, actual host proof, UI history and recovery are not implemented here.
Conversation model/role edits are not exposed today. Any future edit API must
reconcile existing immutable queued snapshots before changing conversation config.
