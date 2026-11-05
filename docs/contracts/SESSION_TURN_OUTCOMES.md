# Terminal turn outcomes — CHO-03 S3b

Source checkpoint: `6d06a67`.

Internal storage composition for terminal turn facts. This module has no host or
UI consumer yet. Native mailbox polling, provider dispatch and application
recovery remain unchanged.

`createSessionTurnOutcomes({store, verifyOwnerEvidence, now = Date.now})` returns
frozen `{settleTurn, inTransaction}`. Construction performs no database I/O.
`settleTurn` takes the existing fenced turn-settlement arguments plus
`expectedSeq`, the current durable event sequence. It returns exactly
`{created, turn, event, cursor}`; `created` describes the event.

Inside one transaction it settles the base turn journal first, derives the
terminal fact, preserves and updates the snapshot, then appends the event.
Any failure rolls back the turn, handoff operation, event and snapshot together.
`inTransaction(tx)` composes with an active transaction from the same database
lineage. Its results are provisional until the outer commit. Database callbacks
must not perform native effects.

The internal kind is `turn_outcome`, with stable key `turn_outcome:<operationId>`.
The payload has exactly eleven fields:

```js
{
  v: 1, conversationId, turnId, operationId, turnSeq, controller,
  outcome, ownerGeneration, hostGeneration, settledAtMs, nativeFact
}
```

Values come from the validated terminal turn and its single terminal history
entry. Outcomes are `completed`, `failed`, `interrupted` and `unknown`. No prompt,
tool result, evidence or owner token is included. `nativeFact` is null when the
terminal entry contains no native fact; otherwise it contains exactly
`nativeIdentity`, `nativeTurnId` and `claudeInputUuid`. Codex facts use the actual
thread/turn; Claude facts use the actual session/input UUID. Requested identities
cannot establish observation. A factless unknown can retain an earlier observed
native turn ID on the turn row while its terminal event still has null
`nativeFact`.

Only `snapshot.state.lastTurnOutcome` changes. All other state and body references
survive. An existing namespace must match its actual persisted terminal journal;
malformed, dangling or inconsistent typed state is `ERR_STORAGE`. The summary
follows the highest **turn sequence**, so a late outcome for an older turn does
not replace a newer turn's summary. Equal sequences require identical facts.
This namespace records the last terminal outcome; it does not describe the active
turn or provide a complete conversation projection. A snapshot that would exceed
the inherited bound fails and rolls back; state is never trimmed to make room.
Future projection writers must reserve room for this metadata.

Retries still run the base settlement's owner, proof, immutable outcome and
native-correlation checks. The same event returns its original cursor with
`created:false`, even after later events and with a stale expected sequence.
Different terminal arguments cannot bypass the base journal checks. An existing
terminal journal without an event can be published by the same valid owner;
this does not allow a new owner to adopt or replay the operation. Callers cannot
select the event key, kind, payload or projection through extra arguments.

Inherited turn/event/storage errors remain load-bearing, including stale event
sequence, ownership, native correlation and size errors. Invalid stored typed
state uses a static `ERR_STORAGE` response. Unknown outcomes and interrupt
acknowledgements are not proof that a native process stopped.

See [turn journal](SESSION_TURNS.md), [event storage](SESSION_EVENTS.md) and
[storage contract](SESSION_STORAGE.md). Host owner/access proofs, remaining typed
message/tool/permission projections, replay polling, UI history and explicit
restart recovery are separate pending work.

Verification: S3b source `6d06a67` couples terminal turn settlement, the handoff journal,
a typed durable outcome event and the last-terminal snapshot in one transaction.
Late older outcomes preserve the newer turn summary; exact retries preserve the
original event and native-correlation checks. Snapshot failures roll back all four
records. All 696 package tests, including 22 outcome tests, type checking
and web build pass. Installed and bundled Node process probes establish reopen,
Codex/Claude facts, a single competing sequence winner, exact retry and complete
ABORT/IGNORE, stale-sequence and outer-transaction rollback. Controller and complete
GLM 5.3 high/Vibe review leave no unresolved High or Medium issue.
The host, native mailbox and UI still use memory; application durability remains
unqualified until those consumers are implemented and tested.
