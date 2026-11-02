# Session bindings API — CHO-03 S2b

Source checkpoint: `f202eeb`. This trusted internal Node API stores producer
fences and native references for existing conversations. It has no host, UI,
IPC or provider consumer yet. See [SESSION_STORAGE](SESSION_STORAGE.md) for the
schema and [SESSION_RECORDS](SESSION_RECORDS.md) for project/chat creation.

## Ownership verification boundary

The factory is `createSessionBindings({ store, verifyOwnerEvidence, now = Date.now })`.
The caller owns the S1 store and its close operation. Construction performs no
I/O. Each data operation uses one synchronous transaction with project checks,
proof evaluation and mutation inside the same writer lock.

`verifyOwnerEvidence` is an explicitly required, synchronous trusted host callback.
Only the boolean `true` authorizes. False, other values, exceptions and asynchronous
results reject with `ERR_OWNER_UNVERIFIED`; asynchronous rejections are consumed.
The callback receives frozen facts containing action, projectId, conversationId,
ownerToken, generation and the opaque evidence supplied by the host. Actions are
`live`, `released` and `dead`. Evidence is never stored or logged by this module.

The host integration must verify complete process identity, liveness, token
association and proof freshness before calling the store, and evaluate those
already obtained facts in the callback. The callback must not perform SQL, IPC
or provider effects inside the transaction. There is no default verifier,
PID-only death check, TTL takeover or manual override. Synthetic test callbacks
prove storage behavior, not live process supervision; actual host integration
remains S3 work.

Future producer-owned writes must check the current fence and proof inside
their own mutation transaction. A separate `getProducer` call is a history read,
not authorization for a later transaction.

## API

All methods take projectId and conversationId and reject a missing or
wrong-project conversation with `ERR_NOT_FOUND`.

| Method | Behavior |
| --- | --- |
| `getProducer({ projectId, conversationId })` | Stored fence or null. |
| `claimProducer({ projectId, conversationId, ownerToken, expectedGeneration, evidence })` | Claim, renew or reclaim under the rules below. |
| `settleProducer({ projectId, conversationId, ownerToken, generation, state, evidence })` | Verified transition from held to released or dead. |
| `getNativeRef({ projectId, conversationId })` | Stored observed reference or null. |
| `setRequestedClaudeSession({ projectId, conversationId, ownerToken, generation, sessionUuid, evidence })` | Persist the requested Claude UUID before a future launch. |
| `bindNativeRef({ projectId, conversationId, ownerToken, generation, controller, nativeThreadId = null, nativeSessionUuid = null, evidence })` | Bind an observed native identity supplied by the trusted host. |

Fences return conversationId, ownerToken, generation, state and updatedAtMs.
Native references return conversationId, projectId, controller, nativeThreadId,
nativeSessionUuid and createdAtMs. Request writes return conversationId,
projectId and requestedClaudeSessionUuid. Reads remain available after release
or death without live evidence.

## Fence transitions

- An absent fence requires expectedGeneration 0 and verified live evidence for
  the proposed owner at generation 1. It inserts a held fence.
- A held fence permits renewal by the same token and exact generation. Another
  owner cannot claim it, regardless of age or a permissive verifier result.
- A released/dead fence can be reclaimed only with its exact prior generation,
  a different token and verified live evidence for the next generation. The
  compare-and-swap increments the generation without wrapping.
- Settlement requires the exact held token/generation and verified release or
  death evidence. An identical terminal repeat keeps its timestamp after
  verification; a different terminal proposal rejects. Former owners cannot
  renew, settle or bind after ownership advances.

## Native references

Requesting a Claude UUID creates no observed native reference or provider
effect. The request cannot be overwritten. Binding Claude requires an observed
session UUID that exactly matches the persisted request. Codex binding requires
an opaque native thread ID and no Claude UUID. Controller and project must
match the conversation. IDs are globally unique within their native ID kind;
an identical binding returns its original creation time and a different one
cannot replace it. Model, role, effort and reported/verified provenance fields
remain untouched.

Future host code must commit a returned Codex thread reference before turn/start
and persist a Claude request before launch, binding only the matching observed
control UUID. This module does not observe provider traffic, launch, resume or
replay anything.

## Validation and errors

Project/chat/token/session UUIDs are canonical lowercase UUID strings. Generation
inputs are safe integers: expectedGeneration permits 0, generation starts at 1.
Native thread IDs are exact, nonempty strings up to 512 UTF-16 units; NUL and
unpaired surrogates reject. Controller is codex or claude; settlement is released
or dead. No trimming, normalization or evidence serialization occurs.

`ERR_INVALID_RECORD` covers invalid inputs/factory dependencies; `ERR_NOT_FOUND` a
missing project/chat binding; `ERR_FENCE_CONFLICT` stale token, generation or state;
`ERR_GENERATION_LIMIT` overflow; `ERR_BINDING_CONFLICT` identity, controller, request
or uniqueness mismatch; `ERR_OWNER_UNVERIFIED` denied proof. Malformed stored
fences fail `ERR_STORAGE`. Existing S1 storage errors, including `ERR_BUSY` and
`ERR_CLOSED`, propagate. Mapped errors contain static messages without evidence
or inputs; an exception from the trusted injected clock currently propagates as
a programmer error. Consistent host-facing error handling is a tracked follow-up.
