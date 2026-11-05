# Message delta bodies — CHO-03 S3c

Source checkpoint: `ccb8a30`. Trusted internal storage composition only;
the native actors, mailbox, poll RPC and UI remain unwired. Current Codex and
Claude adapters emit text deltas; this API does not invent message starts or
completion facts, reconstruct a transcript, or grant execution rights.

`createSessionMessageDeltas({store, verifyOwnerEvidence, now = Date.now})` returns
frozen `{appendMessageDelta, inTransaction}` without construction I/O. A public
append uses one synchronous transaction; an active same-lineage `inTransaction`
helper composes into an outer transaction. Results remain provisional until its
commit. Provider effects do not belong in database callbacks.

Arguments are the usual producer scope plus `turnId`, `operationId`, `partId`,
`nativeMessageId`, `text` and `expectedSeq`. The future actor consumer must
allocate one stable part UUID per accepted delta and retain it across retries.
Two different parts containing identical text are two facts. Text content and
requested native IDs cannot deduplicate frames or establish observation.
Codex uses the actual native item ID as `nativeMessageId`; Claude uses the actual
assistant message ID. Message-level correlation remains the trusted actor's
responsibility. Thread/turn or session/input identity comes from the validated
observed history entry, never caller-supplied native facts or requested IDs.

A fresh delta requires a nonterminal observed turn, the exact paired handoff
operation and matching owner/host provenance. Live ownership is verified inside
the writer even on retries. No journal observation or dispatch is performed by
this helper. A first observation can be composed through the existing turn
helper in the same outer transaction. Queued/unobserved turns and new parts on
terminal turns reject.

The immutable body ID is `partId`. Its text retains Unicode, whitespace and
line endings, including empty deltas, with the inherited 1MiB body bound.
Oversize input rejects without truncation. This does not increase native IPC or
composer capacity. Callers supply extracted application text; neither this API
nor body storage scrubs secrets from arbitrary provider envelopes.

The internal key is `message_delta:<partId>` and the kind is `message_delta`.
The event payload contains exactly twelve fields:

```js
{
  v: 1, conversationId, turnId, operationId, turnSeq, controller,
  ownerGeneration, hostGeneration, partId, nativeMessageId,
  nativeFact: {nativeIdentity, nativeTurnId, claudeInputUuid},
  bodyRef: {id: partId, byteLength, sha256Hex}
}
```

Text, prompts, evidence and owner tokens are excluded from event/snapshot
metadata. Body bytes are read through bounded body chunks. Event order supplies
delta concatenation order; each body is a delta, not cumulative message text.
The return is exactly `{created, body, event, cursor}`; `created` describes the
event, and `body` is the existing five-field body metadata.

Body, event and snapshot publication commit together. A stale event sequence,
denied proof, size limit, ignored write or storage failure rolls back new bodies
as well as event/snapshot changes. Actual body metadata is checked after put so
an ignored INSERT cannot produce a phantom body. A failed outer transaction also
rolls back any turn-journal mutation composed into it.

An exact part retry returns its original event/cursor without touching the
snapshot, even with a stale sequence, later events or a now-terminal turn.
The same live owner, operation provenance, observation and immutable body still
must match. Missing bodies on an existing event reject with `ERR_STORAGE`; retries
do not repair them by inserting replacements. Changed text conflicts with body
idempotency; changed message identity conflicts with the event key. Owner release
does not authorize historical producer writes or adoption by a new owner.

Only `state.lastMessageTurn` changes in the snapshot: exactly version, chat,
turn, operation, turn sequence, controller and owner/host generation metadata.
Its shape is `{v: 1, conversationId, turnId, operationId, turnSeq, controller,
ownerGeneration, hostGeneration}`.
It follows the highest turn sequence with a committed delta; late older turns
cannot regress it. Existing typed metadata must match its actual observed turn.
All other state, prototype-like own keys, body references and `lastTurnOutcome`
survive. The marker contains no body pointers, so delta bodies do not accumulate
in snapshot `bodyRefs` or exhaust its 64-reference bound. It is not a full
transcript, active-turn or completion projection. Snapshot overflow fails and
rolls back; future reducers must preserve and reserve room for these namespaces.

Errors are static: invalid record, missing target, immutable body/operation
conflict, fence conflict, invalid turn state, event key/sequence conflict, storage
and inherited transaction errors. Malformed stored typed state/facts fail closed;
there is no automatic repair, provider replay or process-stop inference.

See [bodies](SESSION_BODIES.md), [events](SESSION_EVENTS.md),
[turn journal](SESSION_TURNS.md), [outcomes](SESSION_TURN_OUTCOMES.md) and
[storage](SESSION_STORAGE.md). Tool/permission projections, actual owner/access
proofs, host replay polling, full UI history and explicit recovery remain pending.

Verification: S3c source `ccb8a30` adds normalized body-backed message deltas with typed
event receipts and a bounded last-message-turn watermark. Native turn identity
comes from the observed journal; stable part IDs preserve retries without
content deduplication. New bodies, events and snapshots commit together, while
existing snapshot references and outcome state survive without per-delta growth.
All 727 package tests, including 31 message-delta tests, type checking
and web build pass. Installed/bundled Node process probes with synthetic owner proofs
verify Codex/Claude
correlation, Unicode and empty bodies, terminal historical retries, 65 deltas
without reference growth, a competing sequence winner with losing-body rollback,
ABORT/IGNORE body/event/snapshot faults, proof denial, outer observation rollback
and dangling-body rejection without repair. Controller and complete GLM 5.3
high/Vibe review leave no unresolved High or Medium issue.
The native mailbox, host polling and UI still use memory. Full transcript
projection and application restart durability are not yet qualified.
