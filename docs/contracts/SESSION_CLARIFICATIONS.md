# Session clarification API — CHO-03 S2g

Source checkpoint: `61bdbe9`. This internal API persists normalized
questions and explicit answer attempts. Native actors, UI, durable events and
recovery consumers remain unwired; application chats still use memory.
See [SESSION_STORAGE](SESSION_STORAGE.md) and [SESSION_TURNS](SESSION_TURNS.md).

```js
createSessionClarifications({ store, verifyOwnerEvidence, verifyPendingQuestion,
  now = Date.now })
```

Returns a frozen API without I/O. Both verifiers are mandatory.
The caller owns store lifetime. Each public data call uses one synchronous S1
transaction; every mutation, including exact retries, checks live ownership,
the parent handoff and the question/attempt owner and host provenance inside it.
A new owner cannot adopt an old journal. Historical reads need no live proof.

The common mutation scope is { projectId, conversationId, turnId,
clarificationId, ownerToken, ownerGeneration, hostGeneration, evidence }.
Answer mutations add operationId: a stable UUID for one explicit answer attempt.
It differs from the question incarnation UUID. Many attempts can belong to a
question, and many questions can belong to a turn.

| Method | Behavior |
| --- | --- |
| registerClarification({ ...scope, route, connectionId, nativeItemId, nativeRequestId = null, questions, pendingEvidence }) | Persist an observed question or return `created: false`/current record for an exact retry. |
| queueAnswer({ ...scope, operationId, answers, pendingEvidence }) | Persist a bounded explicit attempt before any native response. Valid answers queue; semantically invalid answers are retained as terminal invalid attempts. |
| beginAnswerDispatch({ ...scope, operationId, pendingEvidence }) | Commit one-shot queued-to-dispatching admission. Every repeated begin rejects. |
| settleAnswer({ ...scope, operationId, outcome, request = null }) | Atomically settle the attempt and its question projection, returning { attempt, clarification }. |
| retireClarification({ ...scope }) | Make pending/invalid questions unactionable without deleting answer history or pretending an in-flight response was unsent. |
| getClarification({ projectId, conversationId, clarificationId }) | Full question record or null, after chat/project checks. |
| getAnswerAttempt({ projectId, conversationId, operationId }) | Full attempt with entered answer values and history, or null. |
| listAnswerAttempts({ projectId, conversationId, clarificationId, limit = 50, after = null }) | Metadata only, at most 50 rows, ordered by creation timestamp and UUID. The cursor is { createdAtMs, id }. |
| inTransaction(tx) | The same eight methods on an active transaction from the same database lineage; results remain provisional until outer commit. |

Routes preserve actual native semantics:

- codex_async has no native request ID and submits through expected-turn steer.
  Its successful outcome is acknowledged, requiring a matching native turn ACK.
- codex_request and claude_request use typed native request IDs; numeric 0 and
  string "0" differ. Their written outcome confirms a response transport write,
  not provider acceptance, tool execution or turn completion.

Queue admission alone proves neither success. No answer operation changes its
parent turn. Requested-only Claude sessions cannot register questions: both
controllers require an observed parent and actual bound native identity.

The immutable request contains route, controller, connectionId, nativeIdentity,
nativeTurnId, claudeInputUuid, nativeItemId and nativeRequestId. The database's
native_question_id is a canonical typed lookup key derived from actual request
or async item identity; it is not a fabricated provider ID. Actual native IDs
remain in the request. A known retired/completed request may have a new question
incarnation; an unknown answer blocks ambiguous reuse.

Questions use the current codec's normalized six-field display form: id, header,
question, options, multiSelect and isOther. One to four questions, with at most
eight options, preserve exact text, empty option descriptions and Unicode.
Claude IDs must equal their original question text; async Codex IDs and headers
must match the codec's positional form. No secret/prefilled/raw provider fields
are admitted. No choice or answer is generated automatically.

New registration, queueing (including invalid attempts) and dispatch require a
strict synchronous true from verifyPendingQuestion. It receives frozen copied
request/questions/answers plus project/chat/turn/question/attempt/owner identities.
The pendingEvidence value is opaque and passes by original identity, without
cloning, freezing or serialization. False, nonboolean, throwing or thenable
results refuse. The host must verify the exact current question incarnation and
serialize/revalidate withdrawal immediately before the native effect after
commit; a database admission cannot prevent a post-commit withdrawal.

An answer map preserves explicit entered values. Bounded missing, blank or
otherwise semantically invalid answers become terminal invalid attempts; malformed
or oversized data rejects before insertion. Correcting invalid or conclusively
not_sent answers requires a new explicit operation ID and fresh current-question
proof. Old attempts never rearm. Only one queued/dispatching attempt may exist
for a question. Unknown submission makes the question unactionable and blocks
automatic replay. A timeout or crash is insufficient proof of not_sent.

Retiring a question prevents a queued attempt from beginning. It does not
reclassify an admitted response as unsent. A late written/acknowledged callback
may settle the attempt after retirement or parent completion; an already
unactionable question's entire row remains unchanged. Exact terminal retries
require the same outcome and original supplied-request/null semantics.
Later-owner generation-loss reconciliation is separate S5 work.

New attempts cannot precede question creation. Fresh settlement facts cannot
precede the attempt's latest history entry. Regressing timestamps reject before
writes with `ERR_INVALID_RECORD`; exact retries add no fact and remain valid
with an earlier nonnegative safe-integer clock value.

The question record also exposes route, connectionId and nativeQuestionId (the
internal lookup key). It includes immutable request/questions, status, owner/host
provenance, creation time and an optional successful answer projection. Attempt
records retain answers, state, outcome, provenance, timestamps and normalized
history. Operations use kind clarification_answer and decision stores the
question UUID as a logical link, not a permission choice. No rows are pruned.
Question projection and answer changes share a transaction and roll back together.

Bounds: question envelope 64KiB UTF-8, answer map 64KiB, attempt/projection
receipts 96KiB and history 4KiB. Existing codec text/count bounds also apply;
answer strings are at most 4096 UTF-16 units with at most 16384 aggregate units.
NUL and lone surrogates reject. Oversize rejects explicitly without truncation;
body-reference integration remains separate. Credentials, proof evidence and raw
native payloads are excluded. Original Claude control input remains private at
the future host; reconstructed normalized input here validates answers only.

Errors are static and include invalid record, missing target, ownership/fence
denial, idempotency conflict, unverified question, clarification/answer state or
payload conflict, dispatch conflict and storage failure. S1 busy, closed and
expired-transaction errors propagate. No error authorizes an automatic native retry.

Current writers preserve their record links atomically. Exhaustive validation
of corrupted/imported question, attempt and successful-answer links, missing
historical native references and list metadata is a prerequisite before any
host/import/restore consumer. This slice does not qualify those databases.
See the [tracked follow-ups](../work-packages/CHO-03.md).

Verification: all 640 package tests (44 shared, 596 desktop), including 74
clarification tests, type checking and web build pass. Actual installed Node
24.11.1 and bundled Node 24.22.2 process probes verify reopen, a single dispatch
winner, invalid/unsent correction, pending-proof denial, exact terminal retries,
new-owner rejection, late Claude response facts and atomic fault rollback.
Controller and complete independent GLM 5.3 high/Vibe review leave no unresolved
High or Medium issue after validation. Proof callbacks are synthetic; actual
host/process/pending-map qualification and application consumers remain pending.
