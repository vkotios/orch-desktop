// CHO-03 S3a durable event/cursor/snapshot core — internal module.
//
// Thin event layer over the S1 session store (`session-store.mjs`) for
// conversations created by the S2a records API and fenced by the S2b
// producer fences. Each public data operation runs inside exactly one
// synchronous store.transaction with bound parameters; live-owner writes
// authorize inside that same mutation transaction via the existing
// `createProducerAuthorizer` helper (`session-producer-transaction.mjs`).
//
// Surface: createSessionEvents({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { appendEvent, pollEvents, getSnapshot, inTransaction }.
// Importing this module opens no files and starts no providers; the caller
// owns store.close(). `inTransaction(tx)` exposes the same three data
// methods on a supplied ACTIVE scoped S1 transaction for trusted internal
// composition: results are provisional until the outer commit, so never
// perform provider effects inside that callback.
//
// Events are append-only: no update/delete API. Idempotent retries compare
// kind + canonical payload only (not projection). No pruning, coalescing,
// or deletes. events.id is a global rowid, never a cursor.

import { createProducerAuthorizer } from "./session-producer-transaction.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;

const MAX_EVENT_KEY_UNITS = 512;
const MAX_PAYLOAD_JSON_BYTES = 32768;
const MAX_PAYLOAD_NODES = 4096;
const MAX_PAYLOAD_DEPTH = 16;
const MAX_PAYLOAD_STRING_UNITS = 32768;
const MAX_BODY_REFS = 64;
const MAX_POLL_LIMIT = 32;
const MIN_POLL_LIMIT = 1;
const MAX_POLL_BYTES = 131072;
const MIN_POLL_BYTES = 4096;
const POLL_OVERHEAD = 2048;

function evtError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  evtError("ERR_INVALID_RECORD", `session event input is invalid (${detail})`);
const errNotFound = () =>
  evtError("ERR_NOT_FOUND", "session event target not found");
const errStorage = () =>
  evtError("ERR_STORAGE", "session event stored data is unreadable");
const errVersionLimit = () =>
  evtError("ERR_VERSION_LIMIT", "session event sequence exceeds safe range");
const errVersionConflict = () =>
  evtError(
    "ERR_EVENT_VERSION_CONFLICT",
    "session event expected sequence does not match current tip"
  );
const errKeyConflict = () =>
  evtError(
    "ERR_EVENT_KEY_CONFLICT",
    "session event key already used with different kind or payload"
  );
const errCursorInstance = () =>
  evtError("ERR_CURSOR_INSTANCE", "session event cursor instance mismatch");
const errCursorScope = () =>
  evtError("ERR_CURSOR_SCOPE", "session event cursor conversation mismatch");
const errCursorRange = () =>
  evtError("ERR_CURSOR_RANGE", "session event cursor sequence beyond tip");
const errPageTooSmall = () =>
  evtError(
    "ERR_EVENT_PAGE_TOO_SMALL",
    "session event page budget cannot fit a single event"
  );

// ─── String / UUID / scope validation ───────────────────────────────────────

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

function hasOwnSymbolKeys(obj) {
  return Object.getOwnPropertySymbols(obj).length > 0;
}

function isOwnDataDescriptor(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc != null && desc.enumerable && "value" in desc;
}

function validatePlainObjectRoot(value, detail) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errInvalid(detail);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw errInvalid(detail);
  }
  if (hasOwnSymbolKeys(value)) throw errInvalid(detail);
}

function validateUuid(value, detail) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw errInvalid(detail);
  }
}

function validateScopeShape(scope) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw errInvalid("scope");
  }
  validateUuid(scope.projectId, "project id");
  validateUuid(scope.conversationId, "conversation id");
  validateUuid(scope.ownerToken, "owner token");
  if (
    !Number.isSafeInteger(scope.ownerGeneration) ||
    scope.ownerGeneration < 1
  ) {
    throw errInvalid("owner generation");
  }
  validateUuid(scope.hostGeneration, "host generation");
  return scope;
}

function validateEventKey(value) {
  if (typeof value !== "string") throw errInvalid("event key");
  if (value.length < 1 || value.length > MAX_EVENT_KEY_UNITS) {
    throw errInvalid("event key");
  }
  if (value.includes("\0") || hasLoneSurrogate(value)) {
    throw errInvalid("event key");
  }
}

function validateKind(value) {
  if (typeof value !== "string" || !KIND_RE.test(value)) {
    throw errInvalid("kind");
  }
}

function validateExpectedSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errInvalid("expected sequence");
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

// ─── Canonical JSON ─────────────────────────────────────────────────────────
// Recursively sorts object keys, preserves array order, rejects unsafe types.
// Bounds: depth 16, nodes 4096, aggregate UTF-16 string units 32768.
// Final UTF-8 byte cap 32768. No toJSON, no getters, no sparse arrays.

function canonicalJson(value) {
  let nodeCount = 0;
  let stringUnits = 0;

  function walk(v, depth) {
    if (depth > MAX_PAYLOAD_DEPTH) throw errInvalid("payload depth");
    nodeCount += 1;
    if (nodeCount > MAX_PAYLOAD_NODES) throw errInvalid("payload nodes");

    if (v === null) return "null";

    const t = typeof v;
    if (t === "boolean") return v ? "true" : "false";

    if (t === "number") {
      if (!Number.isFinite(v)) throw errInvalid("payload number");
      return JSON.stringify(v);
    }

    if (t === "string") {
      if (v.includes("\0") || hasLoneSurrogate(v)) {
        throw errInvalid("payload string");
      }
      stringUnits += v.length;
      if (stringUnits > MAX_PAYLOAD_STRING_UNITS) {
        throw errInvalid("payload string units");
      }
      return JSON.stringify(v);
    }

    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
      throw errInvalid("payload type");
    }

    if (Array.isArray(v)) {
      if (v.length > MAX_PAYLOAD_NODES) throw errInvalid("payload nodes");
      if (hasOwnSymbolKeys(v)) throw errInvalid("payload array");
      const ownKeys = Object.keys(v);
      if (ownKeys.length !== v.length) throw errInvalid("payload array");
      const parts = [];
      for (let i = 0; i < v.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(v, String(i));
        if (!desc || !desc.enumerable || !("value" in desc)) {
          throw errInvalid("payload array");
        }
        parts.push(walk(desc.value, depth + 1));
      }
      return "[" + parts.join(",") + "]";
    }

    if (t === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw errInvalid("payload object");
      }
      if (hasOwnSymbolKeys(v)) throw errInvalid("payload object");
      const keys = Object.keys(v);
      if (keys.length > MAX_PAYLOAD_NODES) throw errInvalid("payload nodes");
      for (let i = 0; i < keys.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(v, keys[i]);
        if (!desc || !desc.enumerable || !("value" in desc)) {
          throw errInvalid("payload accessor");
        }
      }
      keys.sort();
      const parts = [];
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        if (k.includes("\0") || hasLoneSurrogate(k)) {
          throw errInvalid("payload key");
        }
        stringUnits += k.length;
        if (stringUnits > MAX_PAYLOAD_STRING_UNITS) {
          throw errInvalid("payload string units");
        }
        const desc = Object.getOwnPropertyDescriptor(v, k);
        parts.push(JSON.stringify(k) + ":" + walk(desc.value, depth + 1));
      }
      return "{" + parts.join(",") + "}";
    }

    throw errInvalid("payload type");
  }

  const result = walk(value, 0);
  if (Buffer.byteLength(result, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw errInvalid("payload bytes");
  }
  return result;
}

// ─── Projection validation ──────────────────────────────────────────────────

function validateProjection(projection) {
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    throw errInvalid("projection");
  }
  const proto = Object.getPrototypeOf(projection);
  if (proto !== Object.prototype && proto !== null) {
    throw errInvalid("projection");
  }
  if (hasOwnSymbolKeys(projection)) throw errInvalid("projection");
  const keys = Object.keys(projection);
  if (keys.length !== 2) throw errInvalid("projection");
  if (!isOwnDataDescriptor(projection, "state") || !isOwnDataDescriptor(projection, "bodyRefs")) {
    throw errInvalid("projection");
  }
  const stateDesc = Object.getOwnPropertyDescriptor(projection, "state");
  const bodyRefsDesc = Object.getOwnPropertyDescriptor(projection, "bodyRefs");
  const state = stateDesc.value;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw errInvalid("projection state");
  }
  const stateProto = Object.getPrototypeOf(state);
  if (stateProto !== Object.prototype && stateProto !== null) {
    throw errInvalid("projection state");
  }
  const bodyRefs = bodyRefsDesc.value;
  if (!Array.isArray(bodyRefs) || bodyRefs.length > MAX_BODY_REFS) {
    throw errInvalid("projection bodyRefs");
  }
  if (hasOwnSymbolKeys(bodyRefs)) throw errInvalid("projection bodyRefs");
  const brKeys = Object.keys(bodyRefs);
  if (brKeys.length !== bodyRefs.length) throw errInvalid("projection bodyRefs");
  const seen = new Set();
  for (let i = 0; i < bodyRefs.length; i += 1) {
    const idxDesc = Object.getOwnPropertyDescriptor(bodyRefs, String(i));
    if (!idxDesc || !idxDesc.enumerable || !("value" in idxDesc)) {
      throw errInvalid("projection bodyRefs");
    }
    validateUuid(idxDesc.value, "projection bodyRef");
    if (seen.has(idxDesc.value)) throw errInvalid("projection bodyRefs duplicate");
    seen.add(idxDesc.value);
  }
  return { state, bodyRefs: [...bodyRefs] };
}

function buildProjectionJson(conversationId, lastSeq, bodyRefs, state) {
  const wrapper = { version: 1, conversationId, lastSeq, bodyRefs, state };
  const json = canonicalJson(wrapper);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw errInvalid("projection bytes");
  }
  return json;
}

// ─── Stored data validation ─────────────────────────────────────────────────

function assertStoredEventRow(row) {
  if (!row || typeof row !== "object") throw errStorage();
  if (!Number.isSafeInteger(row.seq) || row.seq < 1) throw errStorage();
  if (typeof row.event_key !== "string") throw errStorage();
  if (
    row.event_key.length < 1 ||
    row.event_key.length > MAX_EVENT_KEY_UNITS ||
    row.event_key.includes("\0") ||
    hasLoneSurrogate(row.event_key)
  ) {
    throw errStorage();
  }
  if (typeof row.kind !== "string" || !KIND_RE.test(row.kind)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) {
    throw errStorage();
  }
  if (typeof row.payload_json !== "string") throw errStorage();
  if (Buffer.byteLength(row.payload_json, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw errStorage();
  }
  // Parse and re-canonicalize to detect tampering.
  let parsed;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw errStorage();
  }
  // Stored payload root must be a plain object.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errStorage();
  }
  let canonical;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    throw errStorage();
  }
  if (canonical !== row.payload_json) throw errStorage();
}

function assertStoredSnapshotRow(row) {
  if (!row || typeof row !== "object") throw errStorage();
  if (typeof row.conversation_id !== "string" || !UUID_RE.test(row.conversation_id)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(row.last_seq) || row.last_seq < 1) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw errStorage();
  }
  if (typeof row.projection_json !== "string") throw errStorage();
  if (Buffer.byteLength(row.projection_json, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw errStorage();
  }
  let parsed;
  try {
    parsed = JSON.parse(row.projection_json);
  } catch {
    throw errStorage();
  }
  // Validate wrapper shape: EXACT 5 keys {version, conversationId, lastSeq, bodyRefs, state}
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw errStorage();
  }
  const pKeys = Object.keys(parsed);
  if (pKeys.length !== 5) throw errStorage();
  if (
    !("version" in parsed) ||
    !("conversationId" in parsed) ||
    !("lastSeq" in parsed) ||
    !("bodyRefs" in parsed) ||
    !("state" in parsed)
  ) {
    throw errStorage();
  }
  if (
    parsed.version !== 1 ||
    parsed.conversationId !== row.conversation_id ||
    parsed.lastSeq !== row.last_seq
  ) {
    throw errStorage();
  }
  if (!Array.isArray(parsed.bodyRefs) || parsed.bodyRefs.length > MAX_BODY_REFS) {
    throw errStorage();
  }
  const brSeen = new Set();
  for (let i = 0; i < parsed.bodyRefs.length; i += 1) {
    if (typeof parsed.bodyRefs[i] !== "string" || !UUID_RE.test(parsed.bodyRefs[i])) {
      throw errStorage();
    }
    if (brSeen.has(parsed.bodyRefs[i])) throw errStorage();
    brSeen.add(parsed.bodyRefs[i]);
  }
  if (
    parsed.state === null ||
    typeof parsed.state !== "object" ||
    Array.isArray(parsed.state)
  ) {
    throw errStorage();
  }
  // Re-canonicalize to detect tampering.
  let canonical;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    throw errStorage();
  }
  if (canonical !== row.projection_json) throw errStorage();
  return parsed;
}

function toEventRecord(row) {
  return {
    seq: row.seq,
    eventKey: row.event_key,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    createdAtMs: row.created_at_ms,
  };
}

// ─── SQL (static only, bound parameters) ────────────────────────────────────

const SQL_CONVERSATION_BY_KEY =
  "SELECT id, project_id FROM conversations WHERE id = ? AND project_id = ?";
const SQL_TIP =
  "SELECT MAX(seq) AS tip FROM events WHERE conversation_id = ?";
const SQL_EVENT_BY_KEY =
  "SELECT seq, event_key, kind, payload_json, created_at_ms FROM events WHERE conversation_id = ? AND event_key = ?";
const SQL_EVENTS_AFTER =
  "SELECT seq, event_key, kind, payload_json, created_at_ms FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?";
const SQL_SNAPSHOT_BY_CONV =
  "SELECT conversation_id, last_seq, projection_json, updated_at_ms FROM snapshots WHERE conversation_id = ?";
const SQL_INSERT_EVENT =
  "INSERT INTO events(conversation_id, seq, event_key, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)";
const SQL_UPSERT_SNAPSHOT =
  "INSERT INTO snapshots(conversation_id, last_seq, projection_json, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET last_seq = excluded.last_seq, projection_json = excluded.projection_json, updated_at_ms = excluded.updated_at_ms";
const SQL_BODY_EXISTS =
  "SELECT id FROM large_bodies WHERE id = ? AND conversation_id = ?";

// ─── Core operations ────────────────────────────────────────────────────────

function runAppendEvent(tx, authorizer, args, stamp, instanceId) {
  const input = args;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw errInvalid("arguments");
  }
  const scope = validateScopeShape(input);
  validateEventKey(input.eventKey);
  validateKind(input.kind);
  validateExpectedSeq(input.expectedSeq);

  // Payload root must be a plain object.
  validatePlainObjectRoot(input.payload, "payload");

  // Canonicalize payload (rejects unsafe types, enforces caps).
  const payloadCanonical = canonicalJson(input.payload);

  // Authorize live write (checks project/conversation binding + fence + proof).
  authorizer.authorizeLiveWrite(tx, scope);

  // Read current tip.
  const tipRow = tx.get(SQL_TIP, [scope.conversationId]);
  const tip = tipRow && tipRow.tip !== null && tipRow.tip !== undefined ? tipRow.tip : 0;
  if (!Number.isSafeInteger(tip) || tip < 0) throw errStorage();

  // Snapshot integrity: exists iff tip > 0.
  const snapRow = tx.get(SQL_SNAPSHOT_BY_CONV, [scope.conversationId]);
  if (tip > 0) {
    if (!snapRow) throw errStorage();
    const snapParsed = assertStoredSnapshotRow(snapRow);
    if (snapRow.last_seq !== tip) throw errStorage();
    // Validate current stored bodyRefs existence.
    for (let i = 0; i < snapParsed.bodyRefs.length; i += 1) {
      if (!tx.get(SQL_BODY_EXISTS, [snapParsed.bodyRefs[i], scope.conversationId])) {
        throw errStorage();
      }
    }
  } else {
    if (snapRow) throw errStorage();
  }

  // Idempotency check: same conversation + event_key.
  const prior = tx.get(SQL_EVENT_BY_KEY, [
    scope.conversationId,
    input.eventKey,
  ]);
  if (prior) {
    assertStoredEventRow(prior);
    if (prior.kind !== input.kind || prior.payload_json !== payloadCanonical) {
      throw errKeyConflict();
    }
    // Exact retry: return original event, no projection write/touch.
    return {
      created: false,
      event: toEventRecord(prior),
      cursor: {
        instanceId,
        conversationId: scope.conversationId,
        seq: prior.seq,
      },
    };
  }

  // Fresh append: expectedSeq must equal current tip.
  if (input.expectedSeq !== tip) throw errVersionConflict();

  const nextSeq = tip + 1;
  if (!Number.isSafeInteger(nextSeq)) throw errVersionLimit();

  // Projection required for fresh append.
  if (
    input.projection === undefined ||
    input.projection === null
  ) {
    throw errInvalid("projection");
  }
  const proj = validateProjection(input.projection);

  // Validate bodyRefs exist in same conversation (scoped id check only).
  for (let i = 0; i < proj.bodyRefs.length; i += 1) {
    if (!tx.get(SQL_BODY_EXISTS, [proj.bodyRefs[i], scope.conversationId])) {
      throw errNotFound();
    }
  }

  // Stamp must be >= previous snapshot timestamp (if any).
  if (snapRow && stamp < snapRow.updated_at_ms) {
    throw errInvalid("clock");
  }

  // Build projection JSON.
  const projectionJson = buildProjectionJson(
    scope.conversationId,
    nextSeq,
    proj.bodyRefs,
    proj.state
  );

  // Insert event.
  const insResult = tx.run(SQL_INSERT_EVENT, [
    scope.conversationId,
    nextSeq,
    input.eventKey,
    input.kind,
    payloadCanonical,
    stamp,
  ]);
  if (!insResult || Number(insResult.changes) !== 1) throw errStorage();

  // Upsert snapshot.
  const upResult = tx.run(SQL_UPSERT_SNAPSHOT, [
    scope.conversationId,
    nextSeq,
    projectionJson,
    stamp,
  ]);
  if (!upResult || Number(upResult.changes) !== 1) throw errStorage();

  return {
    created: true,
    event: {
      seq: nextSeq,
      eventKey: input.eventKey,
      kind: input.kind,
      payload: JSON.parse(payloadCanonical),
      createdAtMs: stamp,
    },
    cursor: {
      instanceId,
      conversationId: scope.conversationId,
      seq: nextSeq,
    },
  };
}

function runPollEvents(tx, args, instanceId) {
  const input = args;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw errInvalid("arguments");
  }
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");

  // Defaults apply only when key is absent (undefined); explicit null invalid.
  const cursor = input.cursor === undefined ? null : input.cursor;
  const limit = input.limit === undefined ? 32 : input.limit;
  const maxBytes = input.maxBytes === undefined ? MAX_POLL_BYTES : input.maxBytes;

  // Validate limit.
  if (!Number.isInteger(limit) || limit < MIN_POLL_LIMIT || limit > MAX_POLL_LIMIT) {
    throw errInvalid("limit");
  }
  // Validate maxBytes.
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < MIN_POLL_BYTES ||
    maxBytes > MAX_POLL_BYTES
  ) {
    throw errInvalid("maxBytes");
  }

  // Project/conversation binding BEFORE cursor validation (no scope leak).
  if (!tx.get(SQL_CONVERSATION_BY_KEY, [input.conversationId, input.projectId])) {
    throw errNotFound();
  }

  // Validate cursor (strict own DATA props, exact 3 keys).
  let afterSeq = 0;
  if (cursor !== null) {
    if (cursor === undefined || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw errInvalid("cursor");
    }
    const cProto = Object.getPrototypeOf(cursor);
    if (cProto !== Object.prototype && cProto !== null) {
      throw errInvalid("cursor");
    }
    if (hasOwnSymbolKeys(cursor)) throw errInvalid("cursor");
    const cKeys = Object.keys(cursor);
    if (cKeys.length !== 3) throw errInvalid("cursor");
    if (
      !isOwnDataDescriptor(cursor, "instanceId") ||
      !isOwnDataDescriptor(cursor, "conversationId") ||
      !isOwnDataDescriptor(cursor, "seq")
    ) {
      throw errInvalid("cursor");
    }
    const cInstDesc = Object.getOwnPropertyDescriptor(cursor, "instanceId");
    const cConvDesc = Object.getOwnPropertyDescriptor(cursor, "conversationId");
    const cSeqDesc = Object.getOwnPropertyDescriptor(cursor, "seq");
    validateUuid(cInstDesc.value, "cursor instanceId");
    validateUuid(cConvDesc.value, "cursor conversationId");
    if (!Number.isSafeInteger(cSeqDesc.value) || cSeqDesc.value < 0) {
      throw errInvalid("cursor seq");
    }
    if (cInstDesc.value !== instanceId) throw errCursorInstance();
    if (cConvDesc.value !== input.conversationId) throw errCursorScope();
    afterSeq = cSeqDesc.value;
  }

  // Read tip.
  const tipRow = tx.get(SQL_TIP, [input.conversationId]);
  const tip = tipRow && tipRow.tip !== null && tipRow.tip !== undefined ? tipRow.tip : 0;
  if (!Number.isSafeInteger(tip) || tip < 0) throw errStorage();

  // Tip/snapshot integrity: exists iff tip > 0, lastSeq matches.
  const pollSnapRow = tx.get(SQL_SNAPSHOT_BY_CONV, [input.conversationId]);
  if (tip > 0) {
    if (!pollSnapRow) throw errStorage();
    assertStoredSnapshotRow(pollSnapRow);
    if (pollSnapRow.last_seq !== tip) throw errStorage();
  } else {
    if (pollSnapRow) throw errStorage();
  }

  // Cursor range check.
  if (afterSeq > tip) throw errCursorRange();

  // At tip: empty batch.
  if (afterSeq >= tip) {
    return {
      events: [],
      cursor: { instanceId, conversationId: input.conversationId, seq: afterSeq },
      tip,
      hasMore: false,
    };
  }

  // Fetch bounded rows.
  const rows = tx.all(SQL_EVENTS_AFTER, [input.conversationId, afterSeq, limit]);
  if (!Array.isArray(rows)) throw errStorage();

  // Validate contiguity and stored integrity.
  for (let i = 0; i < rows.length; i += 1) {
    const expected = afterSeq + 1 + i;
    if (!rows[i] || typeof rows[i] !== "object") throw errStorage();
    if (rows[i].seq !== expected) throw errStorage();
    assertStoredEventRow(rows[i]);
  }

  // Find largest contiguous prefix fitting byte budget.
  let count = rows.length;
  while (count > 0) {
    const events = [];
    for (let i = 0; i < count; i += 1) {
      events.push(toEventRecord(rows[i]));
    }
    const lastSeq = events[events.length - 1].seq;
    const reply = {
      events,
      cursor: { instanceId, conversationId: input.conversationId, seq: lastSeq },
      tip,
      hasMore: lastSeq < tip,
    };
    const replyBytes = Buffer.byteLength(JSON.stringify(reply), "utf8") + POLL_OVERHEAD;
    if (replyBytes <= maxBytes) {
      return reply;
    }
    count -= 1;
  }

  // No events fit but there are events to return.
  throw errPageTooSmall();
}

function runGetSnapshot(tx, args) {
  const input = args;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw errInvalid("arguments");
  }
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");

  // Project/conversation binding (no live proof).
  if (!tx.get(SQL_CONVERSATION_BY_KEY, [input.conversationId, input.projectId])) {
    throw errNotFound();
  }

  // Read tip.
  const tipRow = tx.get(SQL_TIP, [input.conversationId]);
  const tip = tipRow && tipRow.tip !== null && tipRow.tip !== undefined ? tipRow.tip : 0;
  if (!Number.isSafeInteger(tip) || tip < 0) throw errStorage();

  // Read snapshot.
  const snapRow = tx.get(SQL_SNAPSHOT_BY_CONV, [input.conversationId]);

  // Empty tip: check orphan snapshot.
  if (tip === 0) {
    if (snapRow) throw errStorage();
    return null;
  }

  if (!snapRow) throw errStorage();
  const parsed = assertStoredSnapshotRow(snapRow);
  if (parsed.lastSeq !== tip) throw errStorage();

  // Validate bodyRefs scoped existence.
  for (let i = 0; i < parsed.bodyRefs.length; i += 1) {
    if (!tx.get(SQL_BODY_EXISTS, [parsed.bodyRefs[i], input.conversationId])) {
      throw errStorage();
    }
  }

  // Return exact 5-field parsed copy.
  return {
    version: parsed.version,
    conversationId: parsed.conversationId,
    lastSeq: parsed.lastSeq,
    bodyRefs: parsed.bodyRefs,
    state: parsed.state,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSessionEvents(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw errInvalid("factory arguments");
  }
  const { store, verifyOwnerEvidence, now = Date.now } = options;
  if (store === null || typeof store !== "object") {
    throw errInvalid("store");
  }
  if (typeof store.transaction !== "function") throw errInvalid("store");
  if (typeof store.instanceId !== "string") throw errInvalid("store");
  if (typeof verifyOwnerEvidence !== "function") {
    throw errInvalid("owner verifier");
  }
  if (typeof now !== "function") throw errInvalid("clock");

  const authorizer = createProducerAuthorizer({ verifyOwnerEvidence });
  const instanceId = store.instanceId;

  function appendEvent(args) {
    const stamp = resolveStamp(now);
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw errInvalid("arguments");
    }
    validateScopeShape(args);
    validateEventKey(args.eventKey);
    validateKind(args.kind);
    validateExpectedSeq(args.expectedSeq);
    validatePlainObjectRoot(args.payload, "payload");
    canonicalJson(args.payload);
    return store.transaction((tx) =>
      runAppendEvent(tx, authorizer, args, stamp, instanceId)
    );
  }

  function pollEvents(args) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw errInvalid("arguments");
    }
    validateUuid(args.projectId, "project id");
    validateUuid(args.conversationId, "conversation id");
    return store.transaction((tx) => runPollEvents(tx, args, instanceId));
  }

  function getSnapshot(args) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw errInvalid("arguments");
    }
    validateUuid(args.projectId, "project id");
    validateUuid(args.conversationId, "conversation id");
    return store.transaction((tx) => runGetSnapshot(tx, args));
  }

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
      if (error && error.code) throw error;
      throw errStorage();
    }
    if (!meta || meta.instance_uuid !== store.instanceId) {
      throw errStorage();
    }
    return Object.freeze({
      appendEvent: (args) =>
        runAppendEvent(tx, authorizer, args, resolveStamp(now), instanceId),
      pollEvents: (args) => runPollEvents(tx, args, instanceId),
      getSnapshot: (args) => runGetSnapshot(tx, args),
    });
  }

  return Object.freeze({ appendEvent, pollEvents, getSnapshot, inTransaction });
}
