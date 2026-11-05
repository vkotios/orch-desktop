# Tool lifecycle facts — CHO-03 S3d (contract)

Status: ready for implementation. Trusted internal storage composition only;
native actors, mailbox, poll RPC and UI remain unwired until a later consumer
slice. Grounded in existing Codex/Claude normalized tool events from
`@cho-desktop/acp-client` (`tool_call` / `tool_result` with `toolCallId`,
`toolTitle`, `toolStatus`, optional summary `text`).

This API does not invent tools from raw provider frames, grant execution
rights, auto-approve permissions, or replace the in-memory mailbox.

## Surface

`createSessionToolFacts({ store, verifyOwnerEvidence, now = Date.now })` returns
frozen `{ appendToolFact, inTransaction }` without construction I/O. The caller
owns `store.close()`. Public append uses one synchronous store transaction.
`inTransaction(tx)` exposes the same method on an active same-lineage S1
transaction; results are provisional until outer commit. No native/provider
effects inside that callback.

## Arguments

Usual producer scope (`projectId`, `conversationId`, `ownerToken`,
`ownerGeneration`, `hostGeneration`, `evidence`) plus:

| Field | Rule |
| --- | --- |
| `turnId`, `operationId` | UUIDs; must match the observed handoff pair |
| `toolCallId` | Nonempty string ≤512 UTF-16; native tool/item id |
| `phase` | `started` \| `completed` only |
| `toolTitle` | Nonempty string ≤512 UTF-16 (e.g. `command`, `fileChange`, `Read`) |
| `toolStatus` | Exact enum from normalizers: `inProgress` \| `completed` \| `failed` \| `declined` |
| `summaryText` | Optional Unicode string; empty allowed; 1MiB body bound; no silent truncation |
| `nativeMessageId` | Optional ≤512; Claude assistant message id when known; omitted/ignored for Codex item-only facts |
| `expectedSeq` | Event sequence CAS |

Phase/status coupling: `started` requires `toolStatus === "inProgress"`;
`completed` requires `completed` \| `failed` \| `declined`. Other combinations
reject as `ERR_INVALID_RECORD`.

Stable fact identity: one UUID `factId` allocated **once per accepted
toolCallId+phase** by the future actor and retained across retries. Content is
not a dedupe key. Retries with the same `factId` and immutable payload replay
the original event; changed payload conflicts (`ERR_IDEMPOTENCY_CONFLICT`).

## Persistence composition

Compose existing S2c turns, S2d bodies, and S3a events (same pattern as
[SESSION_MESSAGE_DELTAS](SESSION_MESSAGE_DELTAS.md)):

- Fresh append requires a nonterminal **observed** turn, exact paired handoff
  operation, and live owner/host proof inside the writer (including retries).
- Body id is `factId` when `summaryText` is provided (including empty string);
  omit body put when `summaryText` is `undefined` (title/status-only started
  facts). Missing body on retry of a body-backed fact is `ERR_STORAGE` (no repair).
- Internal event key: `tool_fact:<factId>`; kind: `tool_fact`.
- Payload is exactly these fields (no owner tokens, evidence, or raw envelopes):

```js
{
  v: 1, conversationId, turnId, operationId, turnSeq, controller,
  ownerGeneration, hostGeneration, factId, toolCallId, phase,
  toolTitle, toolStatus, nativeMessageId, // null when absent
  nativeFact: { nativeIdentity, nativeTurnId, claudeInputUuid },
  bodyRef: null | { id: factId, byteLength, sha256Hex }
}
```

- Body, event and snapshot commit together; any failure rolls all back.
- Exact fact retry returns original event/cursor without snapshot touch when
  owner/provenance/body still match, even with stale `expectedSeq`.

## Bounded snapshot reducer

Only `state.lastToolTurn` may change for this writer:

```js
{
  v: 1, conversationId, turnId, operationId, turnSeq, controller,
  ownerGeneration, hostGeneration
}
```

Rules mirror `lastMessageTurn`:

- Follows the highest turn sequence with a committed tool fact; late older
  turns cannot regress it.
- Preserve `state.lastTurnOutcome`, `state.lastMessageTurn`, other own keys and
  existing `bodyRefs`. Tool summary bodies do **not** accumulate into snapshot
  `bodyRefs` (same reason as message deltas).
- Reserve capacity for these namespaces; snapshot overflow fails closed.
- This marker is not a full tool transcript or permission map.

## Explicit non-goals (later slices)

- Permission/approval fact writers (use [SESSION_APPROVALS](SESSION_APPROVALS.md) + events).
- Transcript/history reader projection.
- Host poll replacing `mailbox.drain()`, actor wiring, UI.
- Automatic execution replay; ACK ≠ process stopped.

## Inherited consumer holds before host wiring

Classify observed-journal-missing-entry as `ERR_STORAGE` (not `ERR_TURN_STATE`)
when strengthening corrupt-row paths; promote relevant negative tests from
S3c holds. Synthetic owner proofs remain acceptable for this storage slice.
