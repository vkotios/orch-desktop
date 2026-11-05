// CHO-03 S3d typed tool lifecycle facts — internal module.
//
// Thin fact layer composing the S2c turn journal (`session-turns.mjs`),
// S2d immutable bodies (`session-bodies.mjs`), and S3a durable events
// (`session-events.mjs`) for conversations created by the S2a records API
// and fenced by the S2b producer fences. Each public data operation runs
// inside exactly one synchronous store.transaction with bound parameters;
// live-owner writes authorize inside that same mutation transaction via the
// existing `createProducerAuthorizer` helper.
//
// Surface: createSessionToolFacts({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { appendToolFact, inTransaction }. Importing this module
// opens no files and starts no providers; the caller owns store.close().
// `inTransaction(tx)` exposes the same data method on a supplied ACTIVE
// scoped S1 transaction for trusted internal composition: results are
// provisional until the outer commit, so never perform provider effects
// inside that callback.
//
// Persists normalized TOOL LIFECYCLE FACTS only: started/completed phases
// with normalizer statuses. Optional summary bodies use factId as body id
// when summaryText is provided (including empty string); title/status-only
// facts omit the body put. Caller must pass only extracted application
// fields, not raw provider envelopes/secrets. No semantic secret scrubber.
// factId is allocated ONCE per accepted toolCallId+phase by the future
// host, retained across retries; neither summary content nor requested
// UUID deduplicates provider frames.
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

const TOOL_KIND = "tool_fact";
const TOOL_KEY_PREFIX = "tool_fact:";

const PHASES = new Set(["started", "completed"]);
const STATUSES = new Set(["inProgress", "completed", "failed", "declined"]);

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  toolError("ERR_INVALID_RECORD", `session tool fact input is invalid (${detail})`);
const errNotFound = () =>
  toolError("ERR_NOT_FOUND", "session tool fact target not found");
const errIdempotency = () =>
  toolError(
    "ERR_IDEMPOTENCY_CONFLICT",
    "session tool fact id already used with different content or conversation"
  );
const errFence = () =>
  toolError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const errTurnState = () =>
  toolError("ERR_TURN_STATE", "session turn state transition rejected");
const errStorage = () =>
  toolError("ERR_STORAGE", "session tool fact stored data is unreadable");

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

// Opaque native message id (Claude assistant messageId when known): exact,
// nonempty, bounded, well-formed. Never normalized. Omitted for Codex.
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

// toolCallId / toolTitle: nonempty ≤512 UTF-16, no NUL, no lone surrogates.
function validateToolLabel(value, detail) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_NATIVE_ID ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw errInvalid(detail);
  }
}

function validatePhaseStatus(phase, toolStatus) {
  if (typeof phase !== "string" || !PHASES.has(phase)) {
    throw errInvalid("phase");
  }
  if (typeof toolStatus !== "string" || !STATUSES.has(toolStatus)) {
    throw errInvalid("tool status");
  }
  if (phase === "started" && toolStatus !== "inProgress") {
    throw errInvalid("phase status coupling");
  }
  if (
    phase === "completed" &&
    toolStatus !== "completed" &&
    toolStatus !== "failed" &&
    toolStatus !== "declined"
  ) {
    throw errInvalid("phase status coupling");
  }
}

// Optional summary text: plain string when provided, empty allowed. Bounded
// by S2d 1MiB UTF-8 limit with early UTF-16 guard. No truncation.
function validateSummaryText(value) {
  if (typeof value !== "string") throw errInvalid("summary text");
  if (value.length > MAX_BODY_UNITS) throw errInvalid("summary text bytes");
  if (value.includes("\0") || hasLoneSurrogate(value)) {
    throw errInvalid("summary text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    throw errInvalid("summary text bytes");
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

function deriveNativeFact(turn) {
  const observed = turn.history.find((entry) => entry.kind === "observed");
  if (!observed) {
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
  try {
    deriveNativeFact(priorTurn);
  } catch (e) {
    if (e.code === "ERR_TURN_STATE") throw errStorage();
    throw e;
  }
  return watermark;
}

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
      "lastToolTurn"
    );
    if (hasWatermark) {
      existingWatermark = existingState.lastToolTurn;
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

// ─── Input parse (shared public + inTransaction) ────────────────────────────

function parseAppendArgs(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw errInvalid("arguments");
  }
  const scope = validateScopeShape(args);
  validateUuid(args.turnId, "turn id");
  validateUuid(args.operationId, "operation id");
  validateUuid(args.factId, "fact id");
  validateToolLabel(args.toolCallId, "tool call id");
  validateToolLabel(args.toolTitle, "tool title");
  validatePhaseStatus(args.phase, args.toolStatus);
  validateExpectedSeq(args.expectedSeq);

  const hasSummary = Object.prototype.hasOwnProperty.call(args, "summaryText")
    ? args.summaryText !== undefined
    : false;
  if (hasSummary) {
    validateSummaryText(args.summaryText);
  }

  let nativeMessageId = null;
  if (
    Object.prototype.hasOwnProperty.call(args, "nativeMessageId") &&
    args.nativeMessageId !== undefined &&
    args.nativeMessageId !== null
  ) {
    validateNativeMessageId(args.nativeMessageId);
    nativeMessageId = args.nativeMessageId;
  }

  return {
    scope,
    turnId: args.turnId,
    operationId: args.operationId,
    factId: args.factId,
    toolCallId: args.toolCallId,
    phase: args.phase,
    toolTitle: args.toolTitle,
    toolStatus: args.toolStatus,
    summaryText: hasSummary ? args.summaryText : undefined,
    hasSummary,
    nativeMessageId,
    expectedSeq: args.expectedSeq,
    evidence: args.evidence,
    ownerToken: args.ownerToken,
    ownerGeneration: args.ownerGeneration,
    hostGeneration: args.hostGeneration,
    projectId: args.projectId,
    conversationId: args.conversationId,
  };
}

// ─── Core operation ─────────────────────────────────────────────────────────

function runAppendToolFact(tx, turnsTx, bodiesTx, eventsTx, authorizer, parsed) {
  const scope = {
    projectId: parsed.projectId,
    conversationId: parsed.conversationId,
    ownerToken: parsed.ownerToken,
    ownerGeneration: parsed.ownerGeneration,
    hostGeneration: parsed.hostGeneration,
    evidence: parsed.evidence,
  };

  authorizer.authorizeLiveWrite(tx, scope);

  const turn = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: parsed.turnId,
  });
  if (!turn) throw errNotFound();

  if (turn.operationId !== parsed.operationId) throw errIdempotency();

  if (
    turn.ownerGeneration !== scope.ownerGeneration ||
    turn.hostGeneration !== scope.hostGeneration
  ) {
    throw errFence();
  }

  const bodyId = parsed.factId;
  const eventKey = TOOL_KEY_PREFIX + parsed.factId;

  const eventExists = !!tx.get(SQL_EVENT_EXISTS, [scope.conversationId, eventKey]);

  const { existingState, existingBodyRefs, existingWatermark, hasWatermark } =
    readAndValidateWatermark(eventsTx, turnsTx, scope);

  let nativeFact;
  if (eventExists) {
    try {
      nativeFact = deriveNativeFact(turn);
    } catch (e) {
      if (e.code === "ERR_TURN_STATE") throw errStorage();
      throw e;
    }
  } else {
    if (turn.outcome !== null) throw errTurnState();
    if (turn.dispatchState !== "observed") throw errTurnState();
    nativeFact = deriveNativeFact(turn);
  }

  let verifiedBody = null;
  let bodyRef = null;

  if (parsed.hasSummary) {
    if (eventExists) {
      const existingBody = bodiesTx.getBody({
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        bodyId,
      });
      if (!existingBody) throw errStorage();
    }

    const putResult = bodiesTx.putBody({
      ...scope,
      bodyId,
      text: parsed.summaryText,
    });

    verifiedBody = bodiesTx.getBody({
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

    bodyRef = {
      id: bodyId,
      byteLength: verifiedBody.byteLength,
      sha256Hex: verifiedBody.sha256Hex,
    };
  }

  const payload = {
    v: 1,
    conversationId: scope.conversationId,
    turnId: parsed.turnId,
    operationId: parsed.operationId,
    turnSeq: turn.seq,
    controller: turn.controller,
    ownerGeneration: turn.ownerGeneration,
    hostGeneration: turn.hostGeneration,
    factId: parsed.factId,
    toolCallId: parsed.toolCallId,
    phase: parsed.phase,
    toolTitle: parsed.toolTitle,
    toolStatus: parsed.toolStatus,
    nativeMessageId: parsed.nativeMessageId,
    nativeFact,
    bodyRef,
  };

  if (eventExists) {
    const eventResult = eventsTx.appendEvent({
      ...scope,
      eventKey,
      kind: TOOL_KIND,
      expectedSeq: parsed.expectedSeq,
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

  const newState = { ...existingState };
  const newWatermark = buildWatermark(turn);

  if (hasWatermark) {
    if (newWatermark.turnSeq > existingWatermark.turnSeq) {
      newState.lastToolTurn = newWatermark;
    } else if (newWatermark.turnSeq < existingWatermark.turnSeq) {
      // Preserve existing (lower seq does not overwrite higher).
    } else {
      if (!watermarksEqual(newWatermark, existingWatermark)) {
        throw errStorage();
      }
    }
  } else {
    newState.lastToolTurn = newWatermark;
  }

  const projection = {
    state: newState,
    bodyRefs: existingBodyRefs,
  };

  const eventResult = eventsTx.appendEvent({
    ...scope,
    eventKey,
    kind: TOOL_KIND,
    expectedSeq: parsed.expectedSeq,
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

export function createSessionToolFacts(options) {
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

  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const bodies = createSessionBodies({ store, verifyOwnerEvidence, now });
  const events = createSessionEvents({ store, verifyOwnerEvidence, now });

  function appendToolFact(args) {
    resolveStamp(now);
    const parsed = parseAppendArgs(args);
    return store.transaction((tx) => {
      const turnsTx = turns.inTransaction(tx);
      const bodiesTx = bodies.inTransaction(tx);
      const eventsTx = events.inTransaction(tx);
      return runAppendToolFact(
        tx,
        turnsTx,
        bodiesTx,
        eventsTx,
        authorizer,
        parsed
      );
    });
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
      appendToolFact: (args) => {
        const turnsTx = turns.inTransaction(tx);
        const bodiesTx = bodies.inTransaction(tx);
        const eventsTx = events.inTransaction(tx);
        return runAppendToolFact(
          tx,
          turnsTx,
          bodiesTx,
          eventsTx,
          authorizer,
          parseAppendArgs(args)
        );
      },
    });
  }

  return Object.freeze({ appendToolFact, inTransaction });
}
