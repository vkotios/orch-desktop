# Session bodies API — CHO-03 S2d

Source checkpoint: `82f742c`. This internal Node API stores immutable normalized
text bodies and returns bounded byte chunks. It has no host, UI, poll or provider
consumer yet. See [SESSION_STORAGE](SESSION_STORAGE.md) and
[SESSION_TURNS](SESSION_TURNS.md).

`createSessionBodies({ store, verifyOwnerEvidence, now = Date.now })` returns a
frozen API without opening files. The caller owns the S1 store and its close.
Each public data method uses one synchronous transaction.

| Method | Behavior |
| --- | --- |
| `putBody({ projectId, conversationId, ownerToken, ownerGeneration, hostGeneration, evidence, bodyId, text })` | Authorize the current producer and insert immutable text; return `{ created, body }`. |
| `getBody({ projectId, conversationId, bodyId })` | Metadata or null when absent in the checked conversation. |
| `readBodyChunk({ projectId, conversationId, bodyId, offsetBytes = 0, lengthBytes = 16384 })` | At most 16384 bytes, encoded as base64, with total length, stored hash, next offset and EOF. |
| `inTransaction(tx)` | The same three data methods on an active scoped transaction from the same store lineage. Results remain provisional until the outer commit. |

Metadata is `{ id, conversationId, byteLength, sha256Hex, createdAtMs }`.
A chunk is `{ bodyId, conversationId, offsetBytes, lengthBytes, totalBytes,
sha256Hex, dataBase64, nextOffsetBytes, eof }`; returned lengthBytes is the actual
chunk size. Metadata/chunk methods never select full `body_text` into JavaScript. Reads
check the project/chat binding and require no live producer, allowing history
after release. A body in another conversation is not exposed.

Every put, including an exact retry, checks the current held fence, token/counter
and trusted synchronous proof inside its write transaction, using the S2c producer
helper. The verifier must associate hostGeneration with the actual owner/process;
test callbacks do not qualify live host proof. Evidence is never stored. An exact
same-ID, same-conversation, same-text retry returns the original metadata and
`created: false` without changing timestamps. A different currently verified
producer may reuse that immutable row. Changing text or conversation conflicts
for valid stored rows. There is no overwrite, delete or provider-effect permission.
An existing other-chat row is currently fully validated before the conflict check;
corruption can therefore return `ERR_STORAGE` first. Earlier conflict rejection
is tracked before host consumers. Neither path returns the other chat's content.

Text may be empty. The initial limit is 1MiB (1048576 UTF-8 bytes), with an early
1048576 UTF-16-unit guard. NUL and unpaired surrogates reject; whitespace, line
endings and Unicode remain exact. UUIDs are canonical lowercase. Larger input
explicitly rejects without truncation. This adds no composer/transport capacity;
the S2c inline prompt cap remains unchanged. Callers must extract application
content and exclude credentials/raw provider payloads before storing text; this
API does not perform semantic filtering or Unicode normalization.

Chunk offsets are nonnegative safe integers; requested length is 1–16384 bytes.
Defaults apply only to undefined. Offset equal to total length returns an empty
EOF chunk; offset beyond the end rejects. SQL slices the UTF-8 BLOB, so chunks
may split a multibyte character. Decode incrementally or concatenate bytes first;
never decode/re-encode individual split chunks. Verify the assembled bytes against
the returned full-body hash. Metadata/chunk reads validate stored type, bounds,
hash shape and byte length but do not recompute the full hash on each read.
Put retries validate the existing full body before accepting idempotency.

Errors use static messages: `ERR_INVALID_RECORD`, `ERR_NOT_FOUND`,
`ERR_IDEMPOTENCY_CONFLICT`, `ERR_STORAGE`, and the existing producer/S1 errors
including denied proof, stale fence, busy, closed and expired transaction.
Detected corruption is not repaired. No automatic provider retry occurs.

Future S3 writes must compose body/event/projection/outcome changes in one outer
transaction. Separate public calls are separate commits. Do not perform provider
effects in a transaction callback or treat an inTransaction result as committed.
Operation journals, clarification persistence, conflict resolution, host coupling,
UI history and restart/import/export recovery remain separate work.
