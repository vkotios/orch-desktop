// CHO-03 S3c normalized message-delta/body composition — internal module.
//
// Thin delta layer composing the S2c turn journal (`session-turns.mjs`),
// S2d immutable bodies (`session-bodies.mjs`), and S3a durable events
// (`session-events.mjs`) for conversations created by the S2a records API
// and fenced by the S2b producer fences. Each public data operation runs
// inside exactly one synchronous store.transaction with bound parameters;
// live-owner writes authorize inside that same mutation transaction via the
// existing `createProducerAuthorizer` helper.
//
// Surface: createSessionMessageDeltas({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { appendMessageDelta, inTransaction }. Importing this module
// opens no files and starts no providers; the caller owns store.close().
// `inTransaction(tx)` exposes the same data method on a supplied ACTIVE
// scoped S1 transaction for trusted internal composition: results are
// provisional until the outer commit, so never perform provider effects
// inside that callback.
//
// Persists normalized TEXT DELTAS only: no invented completion/start events,
// tools, permission state or full UI reconstruction. Caller must pass only
// extracted application text, not raw provider envelopes/secrets. No
// semantic secret scrubber. partId is allocated ONCE per accepted actor
// delta by the future host, retained across retries; neither text content
// nor requested UUID deduplicates provider frames.
//
// Error-code mapping: ERR_STORAGE stored inconsistency; ERR_INVALID_RECORD
// bad input/factory; ERR_NOT_FOUND target; ERR_IDEMPOTENCY_CONFLICT op
// mismatch/body reuse; ERR_FENCE_CONFLICT provenance; ERR_TURN_STATE no
// observation/new terminal. Base event key/sequence/page errors unchanged.
// S1 tx/lineage errors propagate. No parser diagnostics/user text leaks.

import { createSessionTurns } from "./session-turns.mjs";
import { createSessionBodies } from "./session-bodies.mjs";
import { createSessionEvents } from "./session-events.mjs";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_NATIVE_ID = 512;
const MAX_BODY_BYTES = 1048576;
const MAX_BODY_UNITS = 1048576;
const MAX_EVENT_KEY_UNITS = 512;
const MAX_PAYLOAD_JSON_BYTES = 32768;

const DELTA_KIND = "message_delta";
const DELTA_KEY_PREFIX = "message_delta:";

function deltaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  deltaError("ERR_INVALID_RECORD", `session message delta input is invalid (${detail})`);
const errNotFound = () =>
  deltaError("ERR_NOT_FOUND", "session message delta target not found");
const errIdempotency = () =>
  deltaError(
    "ERR_IDEMPOTENCY_CONFLICT",
    "session message delta id already used with different content or conversation"
  );
const errFence = () =>
  deltaError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const errTurnState = () =>
  deltaError("ERR_TURN_STATE", "session turn state transition rejected");
const errStorage = () =>
  deltaError("ERR_STORAGE", "session message delta stored data is unreadable");

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

// Opaque native message id (Codex actual itemId or Claude actual assistant
// messageId): exact, nonempty, bounded, well-formed. Never normalized.
function validateNativeMessageId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_NATIVE_ID ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw errInvalid("native message id");
  }
}

// Delta text: plain string, empty allowed. Bounded by S2d 1MiB UTF-8 limit
// with early UTF-16 guard. No truncation, no normalization.
function validateDeltaText(value) {
  if (typeof value !== "string") throw errInvalid("text");
  if (value.length > MAX_BODY_UNITS) throw errInvalid("text bytes");
  if (value.includes("\0") || hasLoneSurrogate(value)) {
    throw errInvalid("text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    throw errInvalid("text bytes");
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

// ─── Observed history fact derivation ───────────────────────────────────────

// Derive the exact 3-field nativeFact from the ONE observed history entry.
// Validates controller-specific shapes and cross-checks against the turn
// record. Malformed stored facts are ERR_STORAGE; missing observation on a
// nonterminal turn is ERR_TURN_STATE.
function deriveNativeFact(turn) {
  const observed = turn.history.find((entry) => entry.kind === "observed");
  if (!observed) {
    // Missing observation: ERR_TURN_STATE. Callers map this to ERR_STORAGE
    // when an existing event implies the observation must exist (stored
    // corruption), or leave as ERR_TURN_STATE for fresh admission on a
    // valid nonterminal turn that has not yet been observed.
    throw errTurnState();
  }
  if (!Number.isSafeInteger(observed.atMs) || observed.atMs < 0) {
    throw errStorage();
  }
  const { nativeIdentity, nativeTurnId, claudeInputUuid } = observed;
  if (turn.controller === "codex") {
    if (
      typeof nativeIdentity !== "string" ||
      nativeIdentity.length < 1 ||
      nativeIdentity.length > MAX_NATIVE_ID ||
      nativeIdentity.includes("\0") ||
      hasLoneSurrogate(nativeIdentity)
    ) {
      throw errStorage();
    }
    if (
      typeof nativeTurnId !== "string" ||
      nativeTurnId.length < 1 ||
      nativeTurnId.length > MAX_NATIVE_ID ||
      nativeTurnId.includes("\0") ||
      hasLoneSurrogate(nativeTurnId)
    ) {
      throw errStorage();
    }
    if (claudeInputUuid !== null) throw errStorage();
    if (nativeTurnId !== turn.nativeTurnId) throw errStorage();
    return { nativeIdentity, nativeTurnId, claudeInputUuid: null };
  }
  // Claude
  if (typeof nativeIdentity !== "string" || !UUID_RE.test(nativeIdentity)) {
    throw errStorage();
  }
  if (nativeTurnId !== null) throw errStorage();
  if (typeof claudeInputUuid !== "string" || !UUID_RE.test(claudeInputUuid)) {
    throw errStorage();
  }
  if (claudeInputUuid !== turn.claudeInputUuid) throw errStorage();
  return { nativeIdentity, nativeTurnId: null, claudeInputUuid };
}

// ─── Snapshot watermark validation ──────────────────────────────────────────

const WATERMARK_KEYS = [
  "controller",
  "conversationId",
  "hostGeneration",
  "operationId",
  "ownerGeneration",
  "turnId",
  "turnSeq",
  "v",
];

// Validate an existing lastMessageTurn watermark in the snapshot state.
// Must have exactly 8 keys with correct types and match the actual stored
// turn via getTurn. Malformed/dangling/nonobserved/wrongchat/version ->
// ERR_STORAGE.
function validateExistingWatermark(watermark, turnsTx, projectId, conversationId) {
  if (watermark === null || typeof watermark !== "object" || Array.isArray(watermark)) {
    throw errStorage();
  }
  const keys = Object.keys(watermark).sort();
  if (keys.length !== 8) throw errStorage();
  for (let i = 0; i < 8; i += 1) {
    if (keys[i] !== WATERMARK_KEYS[i]) throw errStorage();
  }
  if (watermark.v !== 1) throw errStorage();
  if (typeof watermark.conversationId !== "string" || !UUID_RE.test(watermark.conversationId)) {
    throw errStorage();
  }
  if (watermark.conversationId !== conversationId) throw errStorage();
  if (typeof watermark.turnId !== "string" || !UUID_RE.test(watermark.turnId)) {
    throw errStorage();
  }
  if (typeof watermark.operationId !== "string" || !UUID_RE.test(watermark.operationId)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(watermark.turnSeq) || watermark.turnSeq < 1) {
    throw errStorage();
  }
  if (watermark.controller !== "codex" && watermark.controller !== "claude") {
    throw errStorage();
  }
  if (!Number.isSafeInteger(watermark.ownerGeneration) || watermark.ownerGeneration < 1) {
    throw errStorage();
  }
  if (typeof watermark.hostGeneration !== "string" || !UUID_RE.test(watermark.hostGeneration)) {
    throw errStorage();
  }
  // Cross-check against actual stored turn
  const priorTurn = turnsTx.getTurn({
    projectId,
    conversationId,
    turnId: watermark.turnId,
  });
  if (!priorTurn) throw errStorage();
  if (priorTurn.operationId !== watermark.operationId) throw errStorage();
  if (priorTurn.seq !== watermark.turnSeq) throw errStorage();
  if (priorTurn.controller !== watermark.controller) throw errStorage();
  if (priorTurn.ownerGeneration !== watermark.ownerGeneration) throw errStorage();
  if (priorTurn.hostGeneration !== watermark.hostGeneration) throw errStorage();
  // Must have a valid observed fact; missing observation on a prior
  // watermark is stored-namespace corruption (the event that set this
  // marker required a prior observation).
  try {
    deriveNativeFact(priorTurn);
  } catch (e) {
    if (e.code === "ERR_TURN_STATE") throw errStorage();
    throw e;
  }
  return watermark;
}

// Shared read/validate helper: reads snapshot and validates existing typed
// watermark (if present as own property) against the journal. Used by both
// fresh and retry paths so that typed storage corruption is detected before
// any publication, including exact duplicates.
function readAndValidateWatermark(eventsTx, turnsTx, scope) {
  const snapshot = eventsTx.getSnapshot({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
  });
  let existingState = {};
  let existingBodyRefs = [];
  let existingWatermark;
  let hasWatermark = false;

  if (snapshot) {
    existingState = snapshot.state;
    existingBodyRefs = snapshot.bodyRefs;
    hasWatermark = Object.prototype.hasOwnProperty.call(
      existingState,
      "lastMessageTurn"
    );
    if (hasWatermark) {
      existingWatermark = existingState.lastMessageTurn;
      validateExistingWatermark(
        existingWatermark,
        turnsTx,
        scope.projectId,
        scope.conversationId
      );
    }
  }

  return { snapshot, existingState, existingBodyRefs, existingWatermark, hasWatermark };
}

// Build the new watermark from the current turn.
function buildWatermark(turn) {
  return {
    v: 1,
    conversationId: turn.conversationId,
    turnId: turn.id,
    operationId: turn.operationId,
    turnSeq: turn.seq,
    controller: turn.controller,
    ownerGeneration: turn.ownerGeneration,
    hostGeneration: turn.hostGeneration,
  };
}

// Compare watermarks for equality (all 8 fields).
function watermarksEqual(a, b) {
  return (
    a.v === b.v &&
    a.conversationId === b.conversationId &&
    a.turnId === b.turnId &&
    a.operationId === b.operationId &&
    a.turnSeq === b.turnSeq &&
    a.controller === b.controller &&
    a.ownerGeneration === b.ownerGeneration &&
    a.hostGeneration === b.hostGeneration
  );
}

// ─── SQL (static only, bound parameters) ────────────────────────────────────

const SQL_EVENT_EXISTS =
  "SELECT id FROM events WHERE conversation_id = ? AND event_key = ?";

// ─── Core operation ─────────────────────────────────────────────────────────

function runAppendMessageDelta(tx, turnsTx, bodiesTx, eventsTx, authorizer, args, stamp) {
  const input = args;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw errInvalid("arguments");
  }
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  validateUuid(input.partId, "part id");
  validateNativeMessageId(input.nativeMessageId);
  validateDeltaText(input.text);
  validateExpectedSeq(input.expectedSeq);

  // Authorize live write BEFORE any mutation or duplicate admission.
  authorizer.authorizeLiveWrite(tx, scope);

  // Get validated turn via base turns module.
  const turn = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
  });
  if (!turn) throw errNotFound();

  // operationId must exactly match the paired turn.
  if (turn.operationId !== input.operationId) throw errIdempotency();

  // Stored provenance must match scope exactly.
  if (
    turn.ownerGeneration !== scope.ownerGeneration ||
    turn.hostGeneration !== scope.hostGeneration
  ) {
    throw errFence();
  }

  // Build stable identifiers.
  const bodyId = input.partId;
  const eventKey = DELTA_KEY_PREFIX + input.partId;

  // Metadata-only event presence check.
  const eventExists = !!tx.get(SQL_EVENT_EXISTS, [scope.conversationId, eventKey]);

  // Shared: read snapshot and validate existing typed watermark BEFORE any
  // branch. Both fresh and retry paths must detect typed storage corruption.
  const { existingState, existingBodyRefs, existingWatermark, hasWatermark } =
    readAndValidateWatermark(eventsTx, turnsTx, scope);

  // Derive nativeFact with event-presence-aware error mapping.
  let nativeFact;
  if (eventExists) {
    // Retry: event exists implies observation must exist; missing = corruption.
    try {
      nativeFact = deriveNativeFact(turn);
    } catch (e) {
      if (e.code === "ERR_TURN_STATE") throw errStorage();
      throw e;
    }
  } else {
    // Fresh: terminal rejects (ERR_TURN_STATE), nonterminal without
    // observation rejects (ERR_TURN_STATE). Base S2 allows terminal states
    // without observation; fresh part on ANY terminal is ERR_TURN_STATE.
    if (turn.outcome !== null) throw errTurnState();
    if (turn.dispatchState !== "observed") throw errTurnState();
    nativeFact = deriveNativeFact(turn);
  }

  if (eventExists) {
    // ── Exact historical retry path ──
    // Require actual scoped body metadata EXISTS BEFORE putBody.
    const existingBody = bodiesTx.getBody({
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      bodyId,
    });
    if (!existingBody) throw errStorage();

    // putBody validates full stored body / exact retry with proof.
    const putResult = bodiesTx.putBody({
      ...scope,
      bodyId,
      text: input.text,
    });

    // Metadata consistency check.
    const verifiedBody = bodiesTx.getBody({
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      bodyId,
    });
    if (!verifiedBody) throw errStorage();
    if (
      verifiedBody.id !== putResult.body.id ||
      verifiedBody.conversationId !== putResult.body.conversationId ||
      verifiedBody.byteLength !== putResult.body.byteLength ||
      verifiedBody.sha256Hex !== putResult.body.sha256Hex ||
      verifiedBody.createdAtMs !== putResult.body.createdAtMs
    ) {
      throw errStorage();
    }

    // Build derived payload.
    const payload = {
      v: 1,
      conversationId: scope.conversationId,
      turnId: input.turnId,
      operationId: input.operationId,
      turnSeq: turn.seq,
      controller: turn.controller,
      ownerGeneration: turn.ownerGeneration,
      hostGeneration: turn.hostGeneration,
      partId: input.partId,
      nativeMessageId: input.nativeMessageId,
      nativeFact,
      bodyRef: {
        id: bodyId,
        byteLength: verifiedBody.byteLength,
        sha256Hex: verifiedBody.sha256Hex,
      },
    };

    // Call base appendEvent; it checks key+kind+canonical payload.
    // For exact retry, returns created:false without projection write.
    // Typed watermark already validated by shared helper above.
    const eventResult = eventsTx.appendEvent({
      ...scope,
      eventKey,
      kind: DELTA_KIND,
      expectedSeq: input.expectedSeq,
      payload,
      projection: null,
    });

    return {
      created: eventResult.created,
      body: verifiedBody,
      event: eventResult.event,
      cursor: eventResult.cursor,
    };
  }

  // ── Fresh admission path ──
  // Put body.
  const putResult = bodiesTx.putBody({
    ...scope,
    bodyId,
    text: input.text,
  });

  // Validate actual getBody metadata exists and exactly equals returned
  // metadata, preventing inherited INSERT RAISE(IGNORE) from fabricating
  // a body result.
  const verifiedBody = bodiesTx.getBody({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    bodyId,
  });
  if (!verifiedBody) throw errStorage();
  if (
    verifiedBody.id !== putResult.body.id ||
    verifiedBody.conversationId !== putResult.body.conversationId ||
    verifiedBody.byteLength !== putResult.body.byteLength ||
    verifiedBody.sha256Hex !== putResult.body.sha256Hex ||
    verifiedBody.createdAtMs !== putResult.body.createdAtMs
  ) {
    throw errStorage();
  }

  // Build derived payload (EXACT 12 fields).
  const payload = {
    v: 1,
    conversationId: scope.conversationId,
    turnId: input.turnId,
    operationId: input.operationId,
    turnSeq: turn.seq,
    controller: turn.controller,
    ownerGeneration: turn.ownerGeneration,
    hostGeneration: turn.hostGeneration,
    partId: input.partId,
    nativeMessageId: input.nativeMessageId,
    nativeFact,
    bodyRef: {
      id: bodyId,
      byteLength: verifiedBody.byteLength,
      sha256Hex: verifiedBody.sha256Hex,
    },
  };

  // Build projection: preserve ALL existing state fields (own-property
  // safe for parsed JSON ownproto) and ALL existing bodyRefs.
  const newState = { ...existingState };
  const newWatermark = buildWatermark(turn);

  if (hasWatermark) {
    // Existing watermark already validated by shared helper.
    // Higher TURN seq replaces, lower preserves, equal requires identical.
    if (newWatermark.turnSeq > existingWatermark.turnSeq) {
      newState.lastMessageTurn = newWatermark;
    } else if (newWatermark.turnSeq < existingWatermark.turnSeq) {
      // Preserve existing (lower seq does not overwrite higher).
    } else {
      // Equal: require identical metadata.
      if (!watermarksEqual(newWatermark, existingWatermark)) {
        throw errStorage();
      }
    }
  } else {
    // No existing watermark: set it.
    newState.lastMessageTurn = newWatermark;
  }

  // Preserve ALL existing bodyRefs (no delta body accumulation).
  const projection = {
    state: newState,
    bodyRefs: existingBodyRefs,
  };

  // Append event with projection.
  const eventResult = eventsTx.appendEvent({
    ...scope,
    eventKey,
    kind: DELTA_KIND,
    expectedSeq: input.expectedSeq,
    payload,
    projection,
  });

  return {
    created: eventResult.created,
    body: verifiedBody,
    event: eventResult.event,
    cursor: eventResult.cursor,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSessionMessageDeltas(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
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

  // Create base module instances sharing the same store/clock/verifier.
  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const bodies = createSessionBodies({ store, verifyOwnerEvidence, now });
  const events = createSessionEvents({ store, verifyOwnerEvidence, now });

  function appendMessageDelta(args) {
    const stamp = resolveStamp(now);
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw errInvalid("arguments");
    }
    validateScopeShape(args);
    validateUuid(args.turnId, "turn id");
    validateUuid(args.operationId, "operation id");
    validateUuid(args.partId, "part id");
    validateNativeMessageId(args.nativeMessageId);
    validateDeltaText(args.text);
    validateExpectedSeq(args.expectedSeq);
    return store.transaction((tx) => {
      const turnsTx = turns.inTransaction(tx);
      const bodiesTx = bodies.inTransaction(tx);
      const eventsTx = events.inTransaction(tx);
      return runAppendMessageDelta(
        tx,
        turnsTx,
        bodiesTx,
        eventsTx,
        authorizer,
        args,
        stamp
      );
    });
  }

  // Trusted internal composition on a supplied ACTIVE scoped transaction:
  // no nested store.transaction, so an S3 outer turn+event+projection+body
  // write rolls back together. Lineage is proven by the meta instance UUID;
  // a tx from another store rejects with ERR_STORAGE. Every mutation still
  // rechecks the current fence and proof through the same tx. Results are
  // provisional until the OUTER commit: never perform provider effects
  // inside that callback or act on a provisional result.
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
      appendMessageDelta: (args) => {
        const turnsTx = turns.inTransaction(tx);
        const bodiesTx = bodies.inTransaction(tx);
        const eventsTx = events.inTransaction(tx);
        return runAppendMessageDelta(
          tx,
          turnsTx,
          bodiesTx,
          eventsTx,
          authorizer,
          args,
          resolveStamp(now)
        );
      },
    });
  }

  return Object.freeze({ appendMessageDelta, inTransaction });
}
