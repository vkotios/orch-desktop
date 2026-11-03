// CHO-03 S2d immutable normalized UTF-8 text-body storage with bounded
// byte-chunk reads over the accepted S1 store.
//
// Thin body layer over the S1 session store (`session-store.mjs`) for
// conversations created by the S2a records API and fenced by the S2b
// producer fences. Each public data operation runs inside exactly one
// synchronous store.transaction with bound parameters; live-owner writes
// authorize inside that same mutation transaction via the existing
// `createProducerAuthorizer` helper (`session-producer-transaction.mjs`).
//
// Surface: createSessionBodies({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { putBody, getBody, readBodyChunk, inTransaction }.
// Importing this module opens no files and starts no providers; the caller
// owns store.close(). `inTransaction(tx)` exposes the same three data
// methods on a supplied ACTIVE scoped S1 transaction for trusted internal
// composition (a future S3 slice will compose body + event + projection +
// outcome in one outer transaction): results are provisional until the
// outer commit, so never perform provider effects inside that callback.
// Bodies are immutable: no update/delete API. A new verified current owner
// may exactly reuse an existing immutable body but cannot rewrite it.
import { createHash } from "node:crypto";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const MAX_BODY_BYTES = 1048576;
const MAX_BODY_UNITS = 1048576;
const MAX_CHUNK_BYTES = 16384;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function bodyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  bodyError("ERR_INVALID_RECORD", `session body input is invalid (${detail})`);
const errNotFound = () =>
  bodyError("ERR_NOT_FOUND", "session body not found");
const errIdempotency = () =>
  bodyError(
    "ERR_IDEMPOTENCY_CONFLICT",
    "session body id already used with different content or conversation"
  );
const errStorage = () =>
  bodyError("ERR_STORAGE", "session body stored data is unreadable");

function requireArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errInvalid("arguments");
  }
  return value;
}

// True when the string holds an unpaired surrogate half. Such strings are
// rejected rather than normalized or silently repaired.
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Canonical lowercase UUID only: no trimming, no case conversion.
function validateUuid(value, detail) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw errInvalid(detail);
  }
}

function validateScopeShape(scope) {
  const s = requireArgs(scope);
  validateUuid(s.projectId, "project id");
  validateUuid(s.conversationId, "conversation id");
  validateUuid(s.ownerToken, "owner token");
  if (!Number.isSafeInteger(s.ownerGeneration) || s.ownerGeneration < 1) {
    throw errInvalid("owner generation");
  }
  validateUuid(s.hostGeneration, "host generation");
  return s;
}

// Normalized plain string only, empty allowed. Fixed initial internal limit
// of 1MiB UTF-8 bytes with an early UTF-16 length guard; oversize rejects,
// never truncation. Whitespace/newlines/non-BMP preserved exactly.
function validateBodyText(value) {
  if (typeof value !== "string") throw errInvalid("body text");
  if (value.length > MAX_BODY_UNITS) throw errInvalid("body bytes");
  if (value.includes("\0") || hasLoneSurrogate(value)) {
    throw errInvalid("body text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    throw errInvalid("body bytes");
  }
}

function validateOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errInvalid("offset");
  }
}

function validateLength(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHUNK_BYTES) {
    throw errInvalid("length");
  }
}

function resolveStamp(now) {
  let stamp;
  try {
    stamp = now();
  } catch {
    throw errInvalid("clock");
  }
  if (!Number.isSafeInteger(stamp) || stamp < 0) {
    throw errInvalid("clock");
  }
  return stamp;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toMetadata(id, conversationId, byteLength, sha256HexValue, createdAtMs) {
  return {
    id,
    conversationId,
    byteLength,
    sha256Hex: sha256HexValue,
    createdAtMs,
  };
}

// Static SQL only: every dynamic value travels as a bound parameter,
// including chunk offset/length (SQLite admits bound substr arguments).
const SQL_CONVERSATION_BY_KEY =
  "SELECT id, project_id FROM conversations WHERE id = ? AND project_id = ?";
const SQL_BODY_BY_ID =
  "SELECT id, conversation_id, byte_len, sha256_hex, body_text, created_at_ms FROM large_bodies WHERE id = ?";
const SQL_BODY_META_BY_ID =
  "SELECT id, conversation_id, byte_len, sha256_hex, created_at_ms, typeof(body_text) AS body_type, length(CAST(body_text AS BLOB)) AS blob_len FROM large_bodies WHERE id = ?";
const SQL_BODY_META_SCOPED =
  "SELECT id, conversation_id, byte_len, sha256_hex, created_at_ms, typeof(body_text) AS body_type, length(CAST(body_text AS BLOB)) AS blob_len FROM large_bodies WHERE id = ? AND conversation_id = ?";
const SQL_BODY_CHUNK =
  "SELECT substr(CAST(body_text AS BLOB), ?, ?) AS chunk FROM large_bodies WHERE id = ? AND conversation_id = ?";
const SQL_INSERT_BODY =
  "INSERT INTO large_bodies(id, conversation_id, byte_len, sha256_hex, body_text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)";

// Stored metadata validation for metadata/chunk reads: uses the SQL
// type/blob-length columns only, never body_text in JS and never a full
// rehash. Clients verify assembled bytes against the stored hash.
function assertStoredMeta(row) {
  if (!row || typeof row !== "object") throw errStorage();
  if (typeof row.id !== "string" || !UUID_RE.test(row.id)) throw errStorage();
  if (
    typeof row.conversation_id !== "string" ||
    !UUID_RE.test(row.conversation_id)
  ) {
    throw errStorage();
  }
  if (
    !Number.isSafeInteger(row.byte_len) ||
    row.byte_len < 0 ||
    row.byte_len > MAX_BODY_BYTES
  ) {
    throw errStorage();
  }
  if (typeof row.sha256_hex !== "string" || !SHA_RE.test(row.sha256_hex)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) {
    throw errStorage();
  }
  if (row.body_type !== "text") throw errStorage();
  if (!Number.isSafeInteger(row.blob_len) || row.blob_len !== row.byte_len) {
    throw errStorage();
  }
}

// Stored full-content validation for the put replay path (which may load
// the one body up to 1MiB): metadata plus UTF-8 rules, exact byte length,
// and exact SHA-256. A tampered stored body never yields a false
// idempotent success.
function assertStoredFull(row) {
  if (!row || typeof row !== "object") throw errStorage();
  if (typeof row.id !== "string" || !UUID_RE.test(row.id)) throw errStorage();
  if (
    typeof row.conversation_id !== "string" ||
    !UUID_RE.test(row.conversation_id)
  ) {
    throw errStorage();
  }
  if (
    !Number.isSafeInteger(row.byte_len) ||
    row.byte_len < 0 ||
    row.byte_len > MAX_BODY_BYTES
  ) {
    throw errStorage();
  }
  if (typeof row.sha256_hex !== "string" || !SHA_RE.test(row.sha256_hex)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) {
    throw errStorage();
  }
  if (typeof row.body_text !== "string") throw errStorage();
  if (row.body_text.length > MAX_BODY_UNITS) throw errStorage();
  if (row.body_text.includes("\0") || hasLoneSurrogate(row.body_text)) {
    throw errStorage();
  }
  if (Buffer.byteLength(row.body_text, "utf8") !== row.byte_len) {
    throw errStorage();
  }
  if (sha256Hex(row.body_text) !== row.sha256_hex) throw errStorage();
}

function toChunkBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw errStorage();
}

function runPutBody(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.bodyId, "body id");
  validateBodyText(input.text);
  authorizer.authorizeLiveWrite(tx, scope);
  const byteLength = Buffer.byteLength(input.text, "utf8");
  const digest = sha256Hex(input.text);
  // Metadata-only preflight first: a corrupt oversized existing row must
  // reject before any full body_text SELECT loads it into JS.
  const meta = tx.get(SQL_BODY_META_BY_ID, [input.bodyId]);
  if (meta) {
    assertStoredMeta(meta);
    const prior = tx.get(SQL_BODY_BY_ID, [input.bodyId]);
    assertStoredFull(prior);
    if (
      prior.conversation_id !== scope.conversationId ||
      prior.body_text !== input.text
    ) {
      throw errIdempotency();
    }
    return {
      created: false,
      body: toMetadata(
        prior.id,
        prior.conversation_id,
        prior.byte_len,
        prior.sha256_hex,
        prior.created_at_ms
      ),
    };
  }
  tx.run(SQL_INSERT_BODY, [
    input.bodyId,
    scope.conversationId,
    byteLength,
    digest,
    input.text,
    stamp,
  ]);
  return {
    created: true,
    body: toMetadata(
      input.bodyId,
      scope.conversationId,
      byteLength,
      digest,
      stamp
    ),
  };
}

// Historical reads need no live proof: a released owner stays readable.
// A body absent in this conversation is null after the project/chat check.
function runGetBody(tx, args) {
  const input = requireArgs(args);
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  validateUuid(input.bodyId, "body id");
  if (!tx.get(SQL_CONVERSATION_BY_KEY, [input.conversationId, input.projectId])) {
    throw errNotFound();
  }
  const row = tx.get(SQL_BODY_META_SCOPED, [
    input.bodyId,
    input.conversationId,
  ]);
  if (!row) return null;
  assertStoredMeta(row);
  return toMetadata(
    row.id,
    row.conversation_id,
    row.byte_len,
    row.sha256_hex,
    row.created_at_ms
  );
}

function runReadBodyChunk(tx, args) {
  const input = requireArgs(args);
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  validateUuid(input.bodyId, "body id");
  // Defaults apply only when the key is absent (undefined); an explicit
  // null is an invalid record, never a default.
  const offset = input.offsetBytes === undefined ? 0 : input.offsetBytes;
  const length = input.lengthBytes === undefined ? MAX_CHUNK_BYTES : input.lengthBytes;
  validateOffset(offset);
  validateLength(length);
  if (!tx.get(SQL_CONVERSATION_BY_KEY, [input.conversationId, input.projectId])) {
    throw errNotFound();
  }
  const row = tx.get(SQL_BODY_META_SCOPED, [
    input.bodyId,
    input.conversationId,
  ]);
  if (!row) throw errNotFound();
  assertStoredMeta(row);
  const total = row.byte_len;
  if (offset > total) throw errInvalid("offset");
  if (offset === total) {
    return {
      bodyId: row.id,
      conversationId: row.conversation_id,
      offsetBytes: offset,
      lengthBytes: 0,
      totalBytes: total,
      sha256Hex: row.sha256_hex,
      dataBase64: "",
      nextOffsetBytes: offset,
      eof: true,
    };
  }
  // Cap first to avoid offset+length overflow arithmetic.
  const remaining = total - offset;
  const actual = length < remaining ? length : remaining;
  const chunkRow = tx.get(SQL_BODY_CHUNK, [
    offset + 1,
    actual,
    input.bodyId,
    input.conversationId,
  ]);
  if (!chunkRow) throw errStorage();
  const buf = toChunkBuffer(chunkRow.chunk);
  if (buf.length !== actual) throw errStorage();
  const next = offset + actual;
  return {
    bodyId: row.id,
    conversationId: row.conversation_id,
    offsetBytes: offset,
    lengthBytes: actual,
    totalBytes: total,
    sha256Hex: row.sha256_hex,
    dataBase64: buf.toString("base64"),
    nextOffsetBytes: next,
    eof: next === total,
  };
}

export function createSessionBodies(options) {
  const settings = requireArgs(options ?? null);
  const { store, verifyOwnerEvidence, now = Date.now } = settings;
  if (store === null || typeof store !== "object") {
    throw errInvalid("store");
  }
  if (typeof store.transaction !== "function") throw errInvalid("store");
  if (typeof verifyOwnerEvidence !== "function") {
    throw errInvalid("owner verifier");
  }
  if (typeof now !== "function") throw errInvalid("clock");
  const authorizer = createProducerAuthorizer({ verifyOwnerEvidence });

  function putBody(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.bodyId, "body id");
    validateBodyText(input.text);
    return store.transaction((tx) => runPutBody(tx, authorizer, args, stamp));
  }

  function getBody(args) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    validateUuid(input.bodyId, "body id");
    return store.transaction((tx) => runGetBody(tx, args));
  }

  function readBodyChunk(args) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    validateUuid(input.bodyId, "body id");
    return store.transaction((tx) => runReadBodyChunk(tx, args));
  }

  // Trusted internal composition on a supplied ACTIVE scoped transaction:
  // no nested store.transaction, so a future S3 outer body+event+
  // projection+outcome write rolls back together. Lineage is proven by the
  // meta instance UUID; a tx from another store rejects with ERR_STORAGE.
  // Every mutation still rechecks the current fence and proof through the
  // same tx. Results are provisional until the OUTER commit: never perform
  // provider effects inside that callback or act on a provisional result.
  function inTransaction(tx) {
    if (
      tx === null ||
      typeof tx !== "object" ||
      typeof tx.get !== "function" ||
      typeof tx.all !== "function" ||
      typeof tx.run !== "function"
    ) {
      throw errInvalid("transaction");
    }
    let meta;
    try {
      meta = tx.get("SELECT instance_uuid FROM meta");
    } catch (error) {
      // An expired scoped helper throws ERR_INVALID_TX here and propagates
      // untouched; anything else without a code is unreadable lineage.
      if (error && error.code) throw error;
      throw errStorage();
    }
    if (!meta || meta.instance_uuid !== store.instanceId) {
      throw errStorage();
    }
    return Object.freeze({
      putBody: (args) => runPutBody(tx, authorizer, args, resolveStamp(now)),
      getBody: (args) => runGetBody(tx, args),
      readBodyChunk: (args) => runReadBodyChunk(tx, args),
    });
  }

  return Object.freeze({ putBody, getBody, readBodyChunk, inTransaction });
}
