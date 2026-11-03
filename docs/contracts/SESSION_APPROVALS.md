# Session approval API — CHO-03 S2f

Source checkpoint: `3a90601`. This internal API persists approval
incarnations, offered decisions and one-shot response journals. Its host, UI and
native consumers remain unwired. Application chats still use memory. See
[SESSION_STORAGE](SESSION_STORAGE.md) and [SESSION_TURNS](SESSION_TURNS.md).

`createSessionApprovals({ store, verifyOwnerEvidence, verifyPendingApproval,
now = Date.now })` returns a frozen API without I/O. Both verifiers are mandatory.
The caller owns the store and close. Each public data call uses one synchronous
S1 transaction. Mutation scope is `{ projectId, conversationId, turnId,
operationId, ownerToken, ownerGeneration, hostGeneration, evidence }`.
Every mutation, including exact retries, checks the current fence, live owner
proof and parent/operation owner and host provenance in that same transaction.
A new owner cannot adopt an old owner's request. Historical reads need no live
proof and compare stored provenance to the parent journal.

| Method | Behavior |
| --- | --- |
| `registerApproval({ ...scope, nativeRequestId, connectionId, nativeItemId, approvalType, decisions, pendingEvidence })` | Insert an observed pending request, or return `{ created: false, approval }` for an exact retry. |
| `decideApproval({ ...scope, decision, pendingEvidence })` | Persist one offered decision before response admission. An exact decision retry returns the current record without new execution permission. |
| `beginApprovalDispatch({ ...scope, pendingEvidence })` | Commit one-shot decided → dispatching admission. Every repeated begin rejects. |
| `settleApproval({ ...scope, outcome, request = null })` | Record written, not_sent, unknown or unactionable. Never changes the parent turn's outcome. |
| `getApproval({ projectId, conversationId, operationId })` | Return the record or null after project/chat validation; historical reads do not authorize a response. |
| `inTransaction(tx)` | Expose the same five methods on an active transaction from the same persisted database lineage. Results remain provisional until outer commit. |

There can be many approvals on one turn. `operationId` is the UI approval UUID,
which identifies one incoming request incarnation. The native request ID alone
does not: numeric `0` and string `"0"` differ, and either can be reused after a
prior response is written or the request is conclusively retired. A new
incarnation gets a new UI UUID. An old UUID never gains a second dispatch right.
Pending, decided, dispatching and unknown requests block ambiguous reuse on the
same host generation, connection and typed native ID. Written, not_sent and
unactionable records retain their history while permitting a genuinely new
incarnation. The host must persist the old transport-write fact before admitting
a same-ID reuse that arrives before the response promise continuation runs.

Registration derives an observed native tuple from persisted rows. Codex needs
its bound thread and observed native turn ID; Claude needs its matching
requested/observed session and observed input UUID. A requested-only Claude
session is insufficient for an approval. The immutable request is exactly
`{ controller, nativeIdentity, nativeTurnId, claudeInputUuid, nativeItemId,
nativeRequestId, connectionId, approvalType, decisions }`. Codex uses command or
file approvals, Claude tool approvals. Choices are a nonempty unique subset of
accept, decline and cancel, stored in that canonical order. No permanent grant
or policy amendment is supported. No raw tool input is persisted here.

Fresh registration, a new decision and dispatch admission also require a strict
synchronous `true` from `verifyPendingApproval`. It receives deeply frozen facts
`{ action, projectId, conversationId, turnId, approvalId, ownerToken,
ownerGeneration, hostGeneration, request, decision, evidence }`; actions are
register, decide and dispatch. Evidence is the opaque `pendingEvidence` argument,
never serialized. The host must match the exact current approval incarnation,
typed request ID, connection, native scope, offers and response state. False,
nonboolean, throwing and thenable results refuse. Owner proof alone cannot
authorize a stale request. Exact registration/decision retries do not require a
request to remain pending because they return history without a new permission.

The verifier evaluates facts already obtained by the trusted host; it performs
no SQL, IPC or provider effects inside the transaction. The host must serialize
pending-map changes and revalidate the exact incarnation immediately before the
native response after commit. A durable admission cannot prevent a withdrawal
that occurs after that commit. Never act on provisional inTransaction results.

The record contains id, conversationId, turnId, request, decision, state,
outcome, ownerGeneration, hostGeneration, createdAtMs, settledAtMs and history.
States pending, decided and dispatching have null outcome; terminal states use
their state name as outcome. Decisions are immutable once chosen, even decline
or cancel. No native response occurs in the store API.

Written means the response frame reached the native transport. It does not mean
the provider accepted the decision or that a tool executed. The existing clients'
response promises and `acknowledged: true` wrapper describe this transport
boundary. Not_sent requires conclusive trusted transport evidence that no write
occurred; timeouts and crashes cannot supply that conclusion. Both outcomes need
an admitted dispatch and the exact stored request, including a compatible native
identity. The parent may already be terminal when a late callback arrives, and
the pending map may already contain a later incarnation.

Unknown can settle any nonterminal approval, optionally supplying the exact
request. Unactionable is limited to pending or decided requests before dispatch;
after admission, retain uncertainty as unknown or record proven not_sent.
Supplying any request with a fresh unactionable settlement is an invalid
argument combination (`ERR_INVALID_RECORD`). Adding that argument on a terminal
retry instead changes the stored receipt semantics (`ERR_APPROVAL_CONFLICT`).
Exact terminal retries require the same outcome and original request-argument
semantics: null/omitted or the exact tuple. Terminal records never revive.
Generation-loss reconciliation by a later owner remains S5 work.

This API offers no retry/reset operation. Both current approval actor paths
retire pending records on response errors; Claude also fails the active actor.
The clarification NOT_SENT recovery path has different semantics. A future
explicit user retry for a proven unsent, still-pending approval requires a
separate attempt design and live revalidation; it must not fabricate a new
request or automatically resend.

UUIDs are canonical lowercase. Numeric request IDs are safe integers, excluding
negative zero; string and opaque IDs are nonempty, at most 512 UTF-16 units,
well-formed and NUL-free. No normalization or truncation occurs. Collision
inspection reads at most 65 candidates for a host and typed ID, refusing when
there are more than 64; it
does not scan unbounded historical receipts in JavaScript. The v1 receipt
is at most 32KiB UTF-8 and stores the immutable request once; history is at most
4KiB and contains normalized registration, decision, dispatch and terminal facts.
Evidence, raw provider payloads, prompts and tool inputs are excluded. Approval
display text will use future durable events/bodies.

Errors include `ERR_INVALID_RECORD`, `ERR_NOT_FOUND`, `ERR_FENCE_CONFLICT`,
`ERR_OWNER_UNVERIFIED`, `ERR_IDEMPOTENCY_CONFLICT`, `ERR_APPROVAL_CONFLICT`,
`ERR_APPROVAL_UNVERIFIED`, `ERR_DISPATCH_CONFLICT`, `ERR_APPROVAL_STATE` and
`ERR_STORAGE`. S1 busy, closed and transaction errors propagate. Messages are
static and do not echo SQL, proof, native IDs or payloads. Malformed detected
rows refuse rather than repair themselves.

Verification: 36 focused approval tests and all 566 package tests pass, along
with type checking and web build. Installed Node 24.11.1 and bundled Node
24.22.2 probes verify reopening, a two-process single-winner dispatch race,
stale-request denial, typed-ID reuse, unknown/unsent terminal behavior, outer
rollback, new-owner rejection, late Claude write facts and 512-unit escaped IDs.
Controller and complete independent GLM 5.3 high/Vibe review leave no High or
Medium finding. Proof callbacks in these probes are synthetic; actual host
process and pending-map verification remain unwired.
