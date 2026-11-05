// CHO-03 S3b terminal turn outcome/event coupling — composition module.
//
// Couples the S2c turn settle (terminal outcome + journal) with the S3a
// durable event/projection append inside exactly one synchronous
// store.transaction. Reuses the actual createSessionTurns and
// createSessionEvents factories (read-only references); no base API,
// schema, config, native, mailbox, or UI changes.
//
// Surface: createSessionTurnOutcomes({ store, verifyOwnerEvidence,
// now = Date.now }) -> frozen { settleTurn, inTransaction }. Construction
// performs no I/O. Public settleTurn opens one store.transaction; internal
// helpers compose via .inTransaction(tx) on the same scoped transaction,
// never nested public calls. inTransaction(tx) uses the existing event
// helper lineage guard (meta instance UUID) and exposes frozen
// { settleTurn }; results are provisional until the outer commit — no
// native effects inside the callback.
//
// settleTurn(args): EXACT existing S2 scope + turnId + operationId +
// outcome + nativeFact optional/null, PLUS expectedSeq (S3a current stream
// tip). The caller does NOT choose eventKey/kind/payload/projection; these
// are derived internally from the validated returned terminal record and
// journal history. Extraneous caller fields are ignored; projection is
// never passed through.
//
// Stable eventKey: 'turn_outcome:' + operationId. kind: 'turn_outcome'.
// ONE fact per handoff operation, not a new key per retry. Payload EXACT
// 11 fields derived from the validated turn record + terminal journal
// entry; no prompt, body text, tool results, credentials, evidence, or
// tokens. nativeFact null when all three persisted terminal-entry fields
// are null; otherwise the exact three-field triple. No native ID
// fabrication.
//
// Projection: preserves ALL existing state fields and bodyRefs (including
// own prototype-like keys without prototype pollution). Modifies ONLY
// state.lastTurnOutcome namespace. Namespace absent -> initialize; present
// -> validate against stored turn/journal. Turn-seq ordering: higher seq
// replaces, lower preserves (late outcome for older turn must not regress
// newer last outcome), equal requires exact payload match.
//
// ANY snapshot/event/version/fact/proof failure rolls back the turn
// outcome/journal/history mutation too. Only the success result after
// commit may permit future display/ACK; still no effect inside the DB.
//
// Error codes: static ERR_STORAGE for bad stored typed state/history;
// others delegate to S2/S3a/S1 (stale event seq, owner, native fact,
// snapshot caps). Never echoes user text or parser errors.

import { createSessionTurns } from "./session-turns.mjs";
import { createSessionEvents } from "./session-events.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NATIVE_ID = 512;
const TERMINAL_OUTCOMES = ["completed", "failed", "interrupted", "unknown"];
const OUTCOME_NAMESPACE = "lastTurnOutcome";
const EVENT_KIND = "turn_outcome";
const EVENT_KEY_PREFIX = "turn_outcome:";

function outcomeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  outcomeError(
    "ERR_INVALID_RECORD",
    `session turn outcome input is invalid (${detail})`
  );
const errStorage = () =>
  outcomeError("ERR_STORAGE", "session turn outcome stored data is unreadable");

// ─── Minimal local validators (stored-data integrity) ───────────────────────

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

function validateOpaqueId(value, detail) {
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

function validateExpectedSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errInvalid("expected sequence");
  }
}

// Validate a stored native-fact triple from a terminal journal entry or
// namespace payload. All-null means factless (null returned). Otherwise
// controller-specific shape is enforced; malformed stored data is
// ERR_STORAGE, never a repair or fabrication.
function validateStoredNativeFactTriple(identity, turnId, inputUuid, controller) {
  if (identity === null && turnId === null && inputUuid === null) {
    return null;
  }
  try {
    if (controller === "codex") {
      validateOpaqueId(identity, "stored native identity");
      validateOpaqueId(turnId, "stored native turn id");
      if (inputUuid !== null) throw errStorage();
    } else {
      validateUuid(identity, "stored native identity");
      if (turnId !== null) throw errStorage();
      validateUuid(inputUuid, "stored native input id");
    }
  } catch (error) {
    if (error && error.code === "ERR_INVALID_RECORD") throw errStorage();
    throw error;
  }
  return {
    nativeIdentity: identity,
    nativeTurnId: turnId,
    claudeInputUuid: inputUuid,
  };
}

// ─── Safe shallow copy (prototype-pollution resistant) ──────────────────────

function safeShallowCopy(obj) {
  const copy = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (desc && desc.enumerable && "value" in desc) {
      Object.defineProperty(copy, k, {
        value: desc.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return copy;
}

// ─── Payload equality helper ────────────────────────────────────────────────

// Exact 11-field + nativeFact triple equality. Used by namespace validation
// and the equal-turnSeq guard to avoid duplicated incomplete field lists.
const NATIVE_FACT_KEYS = ["claudeInputUuid", "nativeIdentity", "nativeTurnId"];

function nativeFactShapeValid(nf) {
  if (nf === null) return true;
  if (typeof nf !== "object" || Array.isArray(nf)) return false;
  const keys = Object.keys(nf).sort();
  if (keys.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (keys[i] !== NATIVE_FACT_KEYS[i]) return false;
  }
  return true;
}

function payloadsEqual(a, b) {
  if (a.v !== b.v) return false;
  if (a.conversationId !== b.conversationId) return false;
  if (a.turnId !== b.turnId) return false;
  if (a.operationId !== b.operationId) return false;
  if (a.turnSeq !== b.turnSeq) return false;
  if (a.controller !== b.controller) return false;
  if (a.outcome !== b.outcome) return false;
  if (a.ownerGeneration !== b.ownerGeneration) return false;
  if (a.hostGeneration !== b.hostGeneration) return false;
  if (a.settledAtMs !== b.settledAtMs) return false;
  if (a.nativeFact === null && b.nativeFact === null) return true;
  if (a.nativeFact === null || b.nativeFact === null) return false;
  if (!nativeFactShapeValid(a.nativeFact) || !nativeFactShapeValid(b.nativeFact)) return false;
  return (
    a.nativeFact.nativeIdentity === b.nativeFact.nativeIdentity &&
    a.nativeFact.nativeTurnId === b.nativeFact.nativeTurnId &&
    a.nativeFact.claudeInputUuid === b.nativeFact.claudeInputUuid
  );
}

// ─── Payload derivation ─────────────────────────────────────────────────────

// Derive the EXACT 11-field outcome payload from the validated terminal
// turn record returned by the base settleTurn. The terminal journal entry
// must exist, match the record outcome/timestamp, and carry a
// controller-valid native-fact triple (or all-null for factless).
function deriveOutcomePayload(turn) {
  if (!TERMINAL_OUTCOMES.includes(turn.outcome)) throw errStorage();
  if (!Number.isSafeInteger(turn.seq) || turn.seq < 1) throw errStorage();
  if (
    turn.settledAtMs === null ||
    !Number.isSafeInteger(turn.settledAtMs) ||
    turn.settledAtMs < 0
  ) {
    throw errStorage();
  }
  if (
    !Number.isSafeInteger(turn.ownerGeneration) ||
    turn.ownerGeneration < 1
  ) {
    throw errStorage();
  }
  if (
    typeof turn.hostGeneration !== "string" ||
    !UUID_RE.test(turn.hostGeneration)
  ) {
    throw errStorage();
  }
  if (turn.controller !== "codex" && turn.controller !== "claude") {
    throw errStorage();
  }
  try {
    validateUuid(turn.conversationId, "stored conversation id");
    validateUuid(turn.id, "stored turn id");
    validateUuid(turn.operationId, "stored operation id");
  } catch (error) {
    if (error && error.code === "ERR_INVALID_RECORD") throw errStorage();
    throw error;
  }

  // Exactly one terminal history entry, consistent with the record.
  const terminalEntry = turn.history.find((e) => e.kind === "terminal");
  if (!terminalEntry) throw errStorage();
  if (terminalEntry.outcome !== turn.outcome) throw errStorage();
  if (terminalEntry.atMs !== turn.settledAtMs) throw errStorage();

  const nativeIdentity = terminalEntry.nativeIdentity ?? null;
  const nativeTurnId = terminalEntry.nativeTurnId ?? null;
  const claudeInputUuid = terminalEntry.claudeInputUuid ?? null;
  const nativeFact = validateStoredNativeFactTriple(
    nativeIdentity,
    nativeTurnId,
    claudeInputUuid,
    turn.controller
  );

  return {
    v: 1,
    conversationId: turn.conversationId,
    turnId: turn.id,
    operationId: turn.operationId,
    turnSeq: turn.seq,
    controller: turn.controller,
    outcome: turn.outcome,
    ownerGeneration: turn.ownerGeneration,
    hostGeneration: turn.hostGeneration,
    settledAtMs: turn.settledAtMs,
    nativeFact,
  };
}

// ─── Namespace validation ───────────────────────────────────────────────────

// Validate an existing state.lastTurnOutcome namespace payload against the
// stored turn/journal. Malformed namespace, dangling turn reference, or
// mismatch against the actual stored terminal record is ERR_STORAGE; never
// silently overwrite foreign state. Reuses deriveOutcomePayload for the
// authoritative journal-derived expected payload and exact full equality.
function validateExistingNamespace(existing, turnsTx, scope) {
  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    throw errStorage();
  }
  const keys = Object.keys(existing).sort();
  const expectedKeys = [
    "conversationId",
    "controller",
    "hostGeneration",
    "nativeFact",
    "operationId",
    "outcome",
    "ownerGeneration",
    "settledAtMs",
    "turnId",
    "turnSeq",
    "v",
  ].sort();
  if (keys.length !== 11) throw errStorage();
  for (let i = 0; i < 11; i += 1) {
    if (keys[i] !== expectedKeys[i]) throw errStorage();
  }
  if (existing.v !== 1) throw errStorage();
  if (!TERMINAL_OUTCOMES.includes(existing.outcome)) throw errStorage();
  if (!Number.isSafeInteger(existing.turnSeq) || existing.turnSeq < 1) {
    throw errStorage();
  }
  if (
    !Number.isSafeInteger(existing.settledAtMs) ||
    existing.settledAtMs < 0
  ) {
    throw errStorage();
  }
  if (
    !Number.isSafeInteger(existing.ownerGeneration) ||
    existing.ownerGeneration < 1
  ) {
    throw errStorage();
  }
  if (
    typeof existing.hostGeneration !== "string" ||
    !UUID_RE.test(existing.hostGeneration)
  ) {
    throw errStorage();
  }
  if (existing.controller !== "codex" && existing.controller !== "claude") {
    throw errStorage();
  }
  try {
    validateUuid(existing.conversationId, "namespace conversation id");
    validateUuid(existing.turnId, "namespace turn id");
    validateUuid(existing.operationId, "namespace operation id");
  } catch (error) {
    if (error && error.code === "ERR_INVALID_RECORD") throw errStorage();
    throw error;
  }

  // Look up the referenced turn (one bounded prior record).
  const priorTurn = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: existing.turnId,
  });
  if (!priorTurn) throw errStorage();
  if (priorTurn.outcome === null) throw errStorage();

  // Derive the canonical payload from the actual stored turn/journal and
  // require exact full equality. This catches every mismatch (conversationId,
  // timestamps, nativeFact, provenance) without duplicated field lists.
  const expected = deriveOutcomePayload(priorTurn);
  if (!payloadsEqual(existing, expected)) throw errStorage();
}

// ─── Projection construction ────────────────────────────────────────────────

// Build the projection input {state, bodyRefs} preserving all existing
// fields and modifying ONLY state.lastTurnOutcome by turn-seq ordering.
function buildOutcomeProjection(snapshot, newPayload, turnsTx, scope) {
  let state;
  let bodyRefs;

  if (snapshot === null) {
    state = {};
    bodyRefs = [];
  } else {
    state = safeShallowCopy(snapshot.state);
    bodyRefs = [...snapshot.bodyRefs];
  }

  const existing = state[OUTCOME_NAMESPACE];

  if (existing === undefined) {
    // Namespace absent: initialize.
    state[OUTCOME_NAMESPACE] = newPayload;
  } else {
    // Namespace present: validate against stored turn/journal.
    validateExistingNamespace(existing, turnsTx, scope);

    if (newPayload.turnSeq > existing.turnSeq) {
      // Newer turn outcome replaces.
      state[OUTCOME_NAMESPACE] = newPayload;
    } else if (newPayload.turnSeq < existing.turnSeq) {
      // Late outcome for older turn: preserve newer, do not regress.
      // state[OUTCOME_NAMESPACE] unchanged.
    } else {
      // Equal turnSeq: require exact payload identity (per-conversation
      // turn seq is unique; a different payload at the same seq is
      // corruption).
      if (!payloadsEqual(newPayload, existing)) throw errStorage();
      // Exact match: no change needed.
    }
  }

  return { state, bodyRefs };
}

// ─── Core composition logic ─────────────────────────────────────────────────

// Execute the coupled settle + event append inside the caller's scoped
// transaction. Base settleTurn runs FIRST (all S2 validation, mutation or
// exact retry). Then the typed fact and projection are derived from the
// validated returned record. Finally eventsTx.appendEvent writes the
// durable outcome event and upserts the snapshot. ANY failure after the
// base mutation rolls back the turn/outcome/journal/history too (same
// transaction).
function runSettleTurnOutcome(turnsTx, eventsTx, args) {
  // 1. Base settleTurn: validates scope, owner, native fact, terminal
  //    state, immutable terminal, no-replay. Returns the full validated
  //    turn record (fresh mutation or exact retry).
  const turn = turnsTx.settleTurn(args);

  // 2. Derive the 11-field payload from the validated terminal record.
  const payload = deriveOutcomePayload(turn);

  // 3. Read current snapshot (historical, proof-free read).
  const snapshot = eventsTx.getSnapshot({
    projectId: args.projectId,
    conversationId: args.conversationId,
  });

  // 4. Build projection preserving existing state/bodyRefs, modifying
  //    only state.lastTurnOutcome by turn-seq ordering.
  const projection = buildOutcomeProjection(snapshot, payload, turnsTx, args);

  // 5. Append the durable outcome event (idempotent on eventKey + kind +
  //    canonical payload; fresh append requires expectedSeq CAS).
  const eventKey = EVENT_KEY_PREFIX + args.operationId;
  const eventResult = eventsTx.appendEvent({
    projectId: args.projectId,
    conversationId: args.conversationId,
    ownerToken: args.ownerToken,
    ownerGeneration: args.ownerGeneration,
    hostGeneration: args.hostGeneration,
    evidence: args.evidence,
    eventKey,
    kind: EVENT_KIND,
    expectedSeq: args.expectedSeq,
    payload,
    projection,
  });

  // 6. Return the coupled result. created refers to the NEW outcome event,
  //    not turn creation.
  return {
    created: eventResult.created,
    turn,
    event: eventResult.event,
    cursor: eventResult.cursor,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSessionTurnOutcomes(options) {
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
  if (typeof verifyOwnerEvidence !== "function") {
    throw errInvalid("owner verifier");
  }
  if (typeof now !== "function") throw errInvalid("clock");

  // Reuse the actual factories with the same store/verifier/clock.
  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const events = createSessionEvents({ store, verifyOwnerEvidence, now });

  // Public settleTurn: one store.transaction, internal composition via
  // .inTransaction(tx) on the same scoped transaction.
  function settleTurn(args) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw errInvalid("arguments");
    }
    validateExpectedSeq(args.expectedSeq);
    return store.transaction((tx) => {
      // Lineage guard via events helper (meta instance UUID check).
      const eventsTx = events.inTransaction(tx);
      const turnsTx = turns.inTransaction(tx);
      return runSettleTurnOutcome(turnsTx, eventsTx, args);
    });
  }

  // Trusted internal composition on a supplied ACTIVE scoped transaction:
  // no nested store.transaction, so an outer turn+event+projection write
  // rolls back together. Lineage proven by the existing event helper
  // guard. Results are provisional until the outer commit; no native
  // effects inside the callback.
  function inTransaction(tx) {
    // Lineage guard via events helper.
    const eventsTx = events.inTransaction(tx);
    const turnsTx = turns.inTransaction(tx);
    return Object.freeze({
      settleTurn: (args) => {
        if (
          args === null ||
          typeof args !== "object" ||
          Array.isArray(args)
        ) {
          throw errInvalid("arguments");
        }
        validateExpectedSeq(args.expectedSeq);
        return runSettleTurnOutcome(turnsTx, eventsTx, args);
      },
    });
  }

  return Object.freeze({ settleTurn, inTransaction });
}
