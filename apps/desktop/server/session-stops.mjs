// CHO-03 S2e durable Stop intent/dispatch journal.
//
// Thin Stop layer over the S1 session store (`session-store.mjs`) for turns
// created by the S2c turns API and fenced by the S2b producer fences. It
// persists the unconsumed internal Stop intent BEFORE any native interrupt
// effect, without sending interrupts, retrying providers, claiming cleanup,
// or touching turns/native_refs/fences. Each public data operation runs
// inside exactly one synchronous store.transaction with bound parameters;
// ownership checks, proof evaluation, and reads/mutations happen inside that
// same writer transaction via `createProducerAuthorizer`.
//
// Surface: createSessionStops({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { requestStop, beginStopDispatch, recordStopWritten,
// settleStop, getStop, inTransaction }. Importing this module opens no files
// and starts no providers; the caller owns store.close(). `inTransaction(tx)`
// exposes the same five data methods on a supplied ACTIVE scoped transaction
// for trusted internal composition (a future S3 slice composes Stop + event
// + projection + outcome in one outer transaction): each mutation still
// rechecks the current fence and proof, never a cached authorization. A tx
// from another store lineage (instance UUID mismatch) rejects with
// ERR_STORAGE.
//
// Model contract: a Stop operation (operations.kind 'stop') pairs one turn
// for its entire lifetime — at most ONE Stop op per (conversationId, turnId),
// no update/delete/re-arm API. The existing handoff (kind 'handoff') pair
// continues to coexist on the same turn; Stop reads/mutations validate the
// parent handoff pair through `createSessionTurns(...).inTransaction(tx)`
// without a nested transaction, and never count the Stop row against the
// sole handoff pair. Stop state queued/dispatching/written is pending
// (outcome null); acknowledged/unknown/not_needed is terminal (outcome
// equals state, settledAtMs set). The interrupt dispatch target is derived
// and validated from persisted rows inside the transaction, never from
// caller strings, and once bound it never changes.
//
// Error-code mapping: wrong/extra/missing target keys or malformed input is
// ERR_INVALID_RECORD; a missing turn/operation is ERR_NOT_FOUND; a same-id
// reuse with different payload/owner/kind/chat is ERR_IDEMPOTENCY_CONFLICT;
// a second Stop id on one turn or a well-shaped but non-matching target is
// ERR_STOP_CONFLICT; a repeated begin is always ERR_DISPATCH_CONFLICT; a
// premature/impossible transition (terminal target, write before begin, ack
// without begin, not_needed outside queued+settled) is ERR_STOP_STATE;
// malformed stored rows are ERR_STORAGE.
import { createHash } from "node:crypto";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";
import { createSessionTurns } from "./session-turns.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const MAX_NATIVE_ID = 512;
const MAX_HISTORY_BYTES = 8192;
const MAX_RESULT_BYTES = 8192;

const STOP_INTENT_V1 = "stop-intent-v1";

const PENDING_STOP_STATES = ["queued", "dispatching", "written"];
const TERMINAL_STOP_STATES = ["acknowledged", "unknown", "not_needed"];
const KNOWN_STOP_STATES = [...PENDING_STOP_STATES, ...TERMINAL_STOP_STATES];
const STOP_REASONS = ["user", "close"];
const STOP_HISTORY_KINDS = ["queued", "dispatching", "written", "terminal"];

function stopError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  stopError("ERR_INVALID_RECORD", `session stop input is invalid (${detail})`);
const errNotFound = () => stopError("ERR_NOT_FOUND", "session stop not found");
const errIdempotency = () =>
  stopError("ERR_IDEMPOTENCY_CONFLICT", "session stop id already used with a different payload, owner, or kind");
const errConflict = () =>
  stopError("ERR_STOP_CONFLICT", "session stop target conflict");
const errDispatch = () =>
  stopError("ERR_DISPATCH_CONFLICT", "session stop dispatch already admitted");
const errStopState = () =>
  stopError("ERR_STOP_STATE", "session stop state transition rejected");
const errFence = () =>
  stopError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const errStorage = () =>
  stopError("ERR_STORAGE", "session stop stored data is unreadable");

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

function validateWellformedText(value, min, max, detail) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw errInvalid(detail);
  }
}

// Opaque native ids (Codex thread/turn ids): exact, nonempty, bounded,
// well-formed. Never normalized; empty or padded values are shape errors.
function validateOpaqueId(value, detail) {
  validateWellformedText(value, 1, MAX_NATIVE_ID, detail);
}

// Stop reason: only 'user'|'close'. The default applies only when the key is
// absent or explicitly undefined; an explicit null is an invalid record.
function validateReason(value) {
  if (!STOP_REASONS.includes(value)) {
    throw errInvalid("reason");
  }
  return value;
}

function validateOutcome(value) {
  if (!TERMINAL_STOP_STATES.includes(value)) {
    throw errInvalid("outcome");
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

// Dispatch-target EXACT normalized shape:
// { controller, nativeIdentity, nativeTurnId, claudeInputUuid,
//   identitySource }. Codex: bound opaque thread id + stored opaque turn id,
// null input, source 'observed'. Claude: canonical requested/matching
// observed session UUID, null turn id, stored input UUID, source 'requested'
// (unbound at begin) or 'observed' (bound at begin). Wrong/extra/missing
// keys or malformed values are ERR_INVALID_RECORD; a well-shaped target that
// does not match the committed snapshot is ERR_STOP_CONFLICT (checked by the
// caller, not here).
function validateTargetShape(value) {
  const t = requireArgs(value);
  const keys = Object.keys(t).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "claudeInputUuid" ||
    keys[1] !== "controller" ||
    keys[2] !== "identitySource" ||
    keys[3] !== "nativeIdentity" ||
    keys[4] !== "nativeTurnId"
  ) {
    throw errInvalid("dispatch target");
  }
  if (t.controller !== "codex" && t.controller !== "claude") {
    throw errInvalid("dispatch target");
  }
  if (t.identitySource !== "requested" && t.identitySource !== "observed") {
    throw errInvalid("dispatch target");
  }
  if (t.controller === "codex") {
    if (t.identitySource !== "observed") throw errInvalid("dispatch target");
    validateOpaqueId(t.nativeIdentity, "dispatch target");
    validateOpaqueId(t.nativeTurnId, "dispatch target");
    if (t.claudeInputUuid !== null) throw errInvalid("dispatch target");
  } else {
    validateUuid(t.nativeIdentity, "dispatch target");
    if (t.nativeTurnId !== null) throw errInvalid("dispatch target");
    validateUuid(t.claudeInputUuid, "dispatch target");
  }
  return {
    controller: t.controller,
    nativeIdentity: t.nativeIdentity,
    nativeTurnId: t.nativeTurnId,
    claudeInputUuid: t.claudeInputUuid,
    identitySource: t.identitySource,
  };
}

// Null or an exact dispatch target. The default applies only when the key is
// absent or explicitly undefined; malformed non-null values reject.
function normalizeTargetArg(value) {
  if (value === undefined || value === null) return null;
  return validateTargetShape(value);
}

function targetsEqual(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.controller === b.controller &&
    a.nativeIdentity === b.nativeIdentity &&
    a.nativeTurnId === b.nativeTurnId &&
    a.claudeInputUuid === b.claudeInputUuid &&
    a.identitySource === b.identitySource
  );
}

// Static SQL only: every dynamic value travels as a bound parameter,
// including the sibling LIMIT (a fixed literal, never interpolated input).
const SQL_CONVERSATION_FULL =
  "SELECT id, project_id, controller, model_requested, effort, role, requested_claude_session_uuid FROM conversations WHERE id = ? AND project_id = ?";
const SQL_OP_BY_ID =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, native_request_id_text, native_request_id_type, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE id = ?";
const SQL_STOP_SIBLINGS =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, native_request_id_text, native_request_id_type, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE conversation_id = ? AND turn_id = ? AND kind = 'stop' LIMIT 2";
const SQL_REF_BY_CONVERSATION =
  "SELECT conversation_id, project_id, controller, native_thread_id, native_session_uuid FROM native_refs WHERE conversation_id = ?";
const SQL_INSERT_STOP =
  "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'stop', ?, ?, ?, 'queued', ?, ?, ?, ?, NULL)";
const SQL_CAS_BEGIN =
  "UPDATE operations SET state = 'dispatching', history_json = ?, result_json = ? WHERE id = ? AND state = 'queued'";
const SQL_CAS_WRITTEN =
  "UPDATE operations SET state = 'written', history_json = ?, result_json = ? WHERE id = ? AND state = 'dispatching'";
const SQL_SET_TERMINAL =
  "UPDATE operations SET state = ?, history_json = ?, result_json = ?, settled_at_ms = ? WHERE id = ? AND state = ?";

// Stored conversation config, validated on every read: malformed stored
// controller/model/effort/role/requested values are corruption, not input.
function readConversation(tx, projectId, conversationId) {
  const row = tx.get(SQL_CONVERSATION_FULL, [conversationId, projectId]);
  if (!row) throw errNotFound();
  if (row.controller !== "codex" && row.controller !== "claude") {
    throw errStorage();
  }
  if (row.model_requested !== null) {
    try {
      validateWellformedText(row.model_requested, 1, 256, "stored model");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
  }
  if (row.role !== null && row.role !== "implement" && row.role !== "review") {
    throw errStorage();
  }
  const requested = row.requested_claude_session_uuid ?? null;
  if (requested !== null && (typeof requested !== "string" || !UUID_RE.test(requested))) {
    throw errStorage();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    controller: row.controller,
    role: row.role,
    requestedClaudeSessionUuid: requested,
  };
}

// The bound native ref for a conversation, validated via conversation_id
// (never a controller-only filter). At most one row exists per the schema
// primary key; zero rows means unbound. Malformed project/controller/id
// kind/format rows, and a Claude binding that does not match the requested
// prelaunch UUID, are corruption: reject, never repair or invent.
function readNativeRef(tx, projectId, conversationId, conv) {
  const rows = tx.all(SQL_REF_BY_CONVERSATION, [conversationId]);
  if (rows.length > 1) throw errStorage();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.project_id !== projectId) throw errStorage();
  if (row.controller !== conv.controller) throw errStorage();
  if (conv.controller === "codex") {
    try {
      validateOpaqueId(row.native_thread_id, "stored thread id");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
    if (row.native_session_uuid !== null) throw errStorage();
    return {
      conversationId,
      projectId,
      controller: "codex",
      nativeThreadId: row.native_thread_id,
      nativeSessionUuid: null,
    };
  }
  if (
    typeof row.native_session_uuid !== "string" ||
    !UUID_RE.test(row.native_session_uuid)
  ) {
    throw errStorage();
  }
  if (row.native_thread_id !== null) throw errStorage();
  if (conv.requestedClaudeSessionUuid !== row.native_session_uuid) {
    throw errStorage();
  }
  return {
    conversationId,
    projectId,
    controller: "claude",
    nativeThreadId: null,
    nativeSessionUuid: row.native_session_uuid,
  };
}

function checkJsonCap(text, max) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > max) {
    throw errStorage();
  }
}

// Journal history, parsed without echoing raw JSON diagnostics. Entries are
// bounded normalized facts { kind, atMs [, target] [, outcome] }: never raw
// provider payloads, evidence, or prompts. At most one entry per kind, at
// most 8KiB serialized (512-unit opaque ids expand under JSON escaping, so
// the 2KiB S2c receipt cap would reject valid targets). The dispatch target
// is stored once in the begin fact, never repeated on every fact. Queued is
// always first; dispatching precedes written; a terminal fact, when present,
// is always last. Malformed stored journals reject as ERR_STORAGE.
function parseHistoryJson(text) {
  // Cap bytes BEFORE parsing; raw diagnostics never escape.
  checkJsonCap(text, MAX_HISTORY_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw errStorage();
  }
  if (!Array.isArray(parsed) || parsed.length > STOP_HISTORY_KINDS.length) {
    throw errStorage();
  }
  const seen = new Set();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw errStorage();
    }
    if (!STOP_HISTORY_KINDS.includes(entry.kind)) throw errStorage();
    if (!Number.isSafeInteger(entry.atMs) || entry.atMs < 0) throw errStorage();
    if (seen.has(entry.kind)) throw errStorage();
    seen.add(entry.kind);
  }
  if (!seen.has("queued")) throw errStorage();
  // Causal order: queued is always first; dispatching precedes written; a
  // terminal fact, when present, is always last.
  if (parsed.length > 0 && parsed[0].kind !== "queued") throw errStorage();
  const position = new Map();
  parsed.forEach((entry, index) => position.set(entry.kind, index));
  if (position.has("written")) {
    if (!position.has("dispatching") || position.get("dispatching") > position.get("written")) {
      throw errStorage();
    }
  }
  if (position.has("terminal") && position.get("terminal") !== parsed.length - 1) {
    throw errStorage();
  }
  // Fixed fact shapes: the begin fact carries the one stored target copy;
  // the terminal fact carries its outcome. Anything else is corruption.
  for (const entry of parsed) {
    const keys = Object.keys(entry).sort();
    if (entry.kind === "dispatching") {
      if (keys.length !== 3 || keys[0] !== "atMs" || keys[1] !== "kind" || keys[2] !== "target") {
        throw errStorage();
      }
      try {
        validateTargetShape(entry.target);
      } catch (error) {
        if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
        throw error;
      }
    } else if (entry.kind === "terminal") {
      if (keys.length !== 3 || keys[0] !== "atMs" || keys[1] !== "kind" || keys[2] !== "outcome") {
        throw errStorage();
      }
      if (!TERMINAL_STOP_STATES.includes(entry.outcome)) throw errStorage();
    } else if (keys.length !== 2 || keys[0] !== "atMs" || keys[1] !== "kind") {
      throw errStorage();
    }
  }
  return parsed.map((entry) => ({ ...entry }));
}

// Versioned receipt, validated without echoing raw JSON diagnostics. Queue
// receipts carry the intent hash; begin/written receipts retain hash/reason
// and the bound target; terminal receipts additionally record whether the
// original terminal argument was supplied (strict boolean
// terminalTargetSupplied) alongside the single stored target copy, so an
// exact retry can prove identity without trusting caller memory and without
// serializing the full target twice. 8KiB cap: bound opaque ids expand in
// JSON.
function parseResultJson(text, { state, hash, reason }) {
  // Cap bytes BEFORE parsing; raw diagnostics never escape.
  checkJsonCap(text, MAX_RESULT_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw errStorage();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errStorage();
  }
  if (parsed.v !== 1 || parsed.hash !== hash || parsed.reason !== reason) {
    throw errStorage();
  }
  if (state === "queued") {
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 6 ||
      parsed.kind !== "queue" ||
      parsed.target !== null ||
      parsed.outcome !== null ||
      keys[0] !== "hash" ||
      keys[1] !== "kind" ||
      keys[2] !== "outcome" ||
      keys[3] !== "reason" ||
      keys[4] !== "target" ||
      keys[5] !== "v"
    ) {
      throw errStorage();
    }
  } else if (state === "dispatching" || state === "written") {
    const keys = Object.keys(parsed).sort();
    const wantKind = state === "dispatching" ? "begin" : "written";
    if (
      keys.length !== 6 ||
      parsed.kind !== wantKind ||
      parsed.outcome !== null ||
      keys[0] !== "hash" ||
      keys[1] !== "kind" ||
      keys[2] !== "outcome" ||
      keys[3] !== "reason" ||
      keys[4] !== "target" ||
      keys[5] !== "v"
    ) {
      throw errStorage();
    }
    try {
      validateTargetShape(parsed.target);
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
  } else {
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 7 ||
      parsed.kind !== "terminal" ||
      parsed.outcome !== state ||
      keys[0] !== "hash" ||
      keys[1] !== "kind" ||
      keys[2] !== "outcome" ||
      keys[3] !== "reason" ||
      keys[4] !== "target" ||
      keys[5] !== "terminalTargetSupplied" ||
      keys[6] !== "v"
    ) {
      throw errStorage();
    }
    if (typeof parsed.terminalTargetSupplied !== "boolean") {
      throw errStorage();
    }
    if (parsed.target !== null) {
      try {
        validateTargetShape(parsed.target);
      } catch (error) {
        if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
        throw error;
      }
    }
  }
  return { ...parsed };
}

// Stable intent hash: the idempotency identity of one Stop request. Any
// payload, reason, chat, turn, or owner difference is a different request.
function computeStopHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function hashForRequest({ projectId, conversationId, turnId, reason, scope }) {
  return computeStopHash([
    STOP_INTENT_V1,
    projectId,
    conversationId,
    turnId,
    reason,
    scope.ownerToken,
    scope.ownerGeneration,
    scope.hostGeneration,
  ]);
}

// Append one journal fact unless its kind is already present (idempotent
// retries never grow history or touch timestamps). Returns the serialized
// journal plus whether it changed.
function appendHistoryFact(history, entry) {
  if (history.some((existing) => existing.kind === entry.kind)) {
    return { text: JSON.stringify(history), changed: false };
  }
  const next = [...history, { ...entry }];
  const text = JSON.stringify(next);
  checkJsonCap(text, MAX_HISTORY_BYTES);
  return { text, changed: true };
}

// Full Stop record with every stored invariant checked: kind/decision are
// the Stop pair, provenance is well-shaped, state/outcome/settled agree,
// history and receipt are bounded fixed v1 shapes that agree with each
// other, and the bound target (when present) is stored exactly once. Reads
// never expose prompts, evidence, or provider payloads.
function buildStopRecord(stopRow) {
  if (!stopRow || typeof stopRow !== "object") throw errStorage();
  if (typeof stopRow.id !== "string" || !UUID_RE.test(stopRow.id)) {
    throw errStorage();
  }
  if (stopRow.kind !== "stop") throw errStorage();
  if (typeof stopRow.conversation_id !== "string" || !UUID_RE.test(stopRow.conversation_id)) {
    throw errStorage();
  }
  if (typeof stopRow.turn_id !== "string" || !UUID_RE.test(stopRow.turn_id)) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(stopRow.owner_generation) || stopRow.owner_generation < 1) {
    throw errStorage();
  }
  if (typeof stopRow.host_generation !== "string" || !UUID_RE.test(stopRow.host_generation)) {
    throw errStorage();
  }
  if (stopRow.decision !== "user" && stopRow.decision !== "close") {
    throw errStorage();
  }
  // Future approval ids are unrelated: Stop rows never carry native request
  // identity.
  if (stopRow.native_request_id_text !== null && stopRow.native_request_id_text !== undefined) {
    throw errStorage();
  }
  if (stopRow.native_request_id_type !== null && stopRow.native_request_id_type !== undefined) {
    throw errStorage();
  }
  if (!KNOWN_STOP_STATES.includes(stopRow.state)) throw errStorage();
  const pending = PENDING_STOP_STATES.includes(stopRow.state);
  const outcome = pending ? null : stopRow.state;
  if (pending) {
    if (stopRow.settled_at_ms !== null) throw errStorage();
  } else if (!Number.isSafeInteger(stopRow.settled_at_ms) || stopRow.settled_at_ms < 0) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(stopRow.created_at_ms) || stopRow.created_at_ms < 0) {
    throw errStorage();
  }
  if (typeof stopRow.payload_hash !== "string" || !SHA_RE.test(stopRow.payload_hash)) {
    throw errStorage();
  }
  const history = parseHistoryJson(stopRow.history_json);
  const receipt = parseResultJson(stopRow.result_json, {
    state: stopRow.state,
    hash: stopRow.payload_hash,
    reason: stopRow.decision,
  });
  // State/history agreement: exactly the facts each state admits. A queued
  // Stop never began; dispatching began once; written wrote once; a terminal
  // Stop ends with its terminal fact and carries a bound target exactly when
  // it began (an unknown settled from queued never did).
  const kinds = history.map((entry) => entry.kind);
  if (stopRow.state === "queued") {
    if (kinds.length !== 1) throw errStorage();
  } else if (stopRow.state === "dispatching") {
    if (kinds.length !== 2 || kinds[1] !== "dispatching") throw errStorage();
  } else if (stopRow.state === "written") {
    if (kinds.length !== 3 || kinds[2] !== "written") throw errStorage();
  } else {
    const terminalEntry = history.find((entry) => entry.kind === "terminal");
    if (!terminalEntry || terminalEntry.outcome !== stopRow.state) throw errStorage();
    const began = kinds.includes("dispatching");
    if ((receipt.target !== null) !== began) throw errStorage();
    // Terminal receipt/supplied agreement: acknowledged always carried its
    // exact target; not_needed never began and never carried one; unknown
    // carried a target only when one was actually bound.
    if (stopRow.state === "acknowledged") {
      if (!receipt.terminalTargetSupplied || receipt.target === null || !began) {
        throw errStorage();
      }
    } else if (stopRow.state === "not_needed") {
      if (receipt.terminalTargetSupplied || receipt.target !== null || began) {
        throw errStorage();
      }
    } else if (receipt.terminalTargetSupplied && !began) {
      throw errStorage();
    }
  }
  // The one stored target copy (history begin fact) must equal the receipt
  // target; a later observed ref may confirm a requested snapshot but never
  // rewrites the stored source.
  const beginFact = history.find((entry) => entry.kind === "dispatching");
  if (beginFact) {
    if (receipt.target === null || !targetsEqual(beginFact.target, receipt.target)) {
      throw errStorage();
    }
  } else if (receipt.target !== null) {
    throw errStorage();
  }
  checkJsonCap(stopRow.history_json, MAX_HISTORY_BYTES);
  checkJsonCap(stopRow.result_json, MAX_RESULT_BYTES);
  return {
    id: stopRow.id,
    conversationId: stopRow.conversation_id,
    turnId: stopRow.turn_id,
    reason: stopRow.decision,
    state: stopRow.state,
    outcome,
    dispatchTarget: receipt.target === null ? null : { ...receipt.target },
    ownerGeneration: stopRow.owner_generation,
    hostGeneration: stopRow.host_generation,
    createdAtMs: stopRow.created_at_ms,
    settledAtMs: stopRow.settled_at_ms,
    history: history.map((entry) => ({ ...entry })),
  };
}

// Load the exact Stop operation for a mutation. An unknown operation id is
// ERR_NOT_FOUND; a known id bound to another conversation, turn, or kind is
// ERR_IDEMPOTENCY_CONFLICT (no cross-chat or cross-kind reuse).
function loadStopOp(tx, scope) {
  const opRow = tx.get(SQL_OP_BY_ID, [scope.operationId]);
  if (!opRow) throw errNotFound();
  if (
    opRow.kind !== "stop" ||
    opRow.conversation_id !== scope.conversationId ||
    opRow.turn_id !== scope.turnId
  ) {
    throw errIdempotency();
  }
  return opRow;
}

// The stored Stop op carries the owning provenance: every mutation requires
// it to match the requested scope exactly. A new owner cannot adopt an old
// owner's Stop through this API (explicit recovery is S5, never automatic
// adoption).
function requireStopProvenance(opRow, scope) {
  if (
    opRow.owner_generation !== scope.ownerGeneration ||
    opRow.host_generation !== scope.hostGeneration
  ) {
    throw errFence();
  }
}

// The stored paired handoff op carries the owning provenance: a new owner
// cannot mutate an old owner's turn through this API either.
function requireHandoffProvenance(turnRecord, scope) {
  if (
    turnRecord.ownerGeneration !== scope.ownerGeneration ||
    turnRecord.hostGeneration !== scope.hostGeneration
  ) {
    throw errFence();
  }
}

// Exactly one Stop row must exist per turn for its entire lifetime: a second
// Stop id on the same turn is ERR_STOP_CONFLICT at request time, and more
// than one stored Stop row for a turn is corruption everywhere.
function requireSoleStop(tx, scope, requestId) {
  const siblings = tx.all(SQL_STOP_SIBLINGS, [scope.conversationId, scope.turnId]);
  if (siblings.length !== 1) throw errStorage();
  if (siblings[0].id !== requestId) throw errStorage();
}

// Derive and validate the one-shot interrupt target from persisted rows,
// never from caller strings. Codex needs an actually observed turn (a stored
// opaque turn id) with its validated bound native thread: no ACK or queued
// id substitution. Claude needs a written-or-later intent with its stored
// input UUID and the persisted requested session UUID; a valid observed
// native ref, when present, must match the request, and when absent the
// requested UUID alone suffices ONLY for this interrupt target after the
// turn intent is written. Nothing here creates an observed native
// association. Missing/not-yet-ready targets reject with ERR_STOP_STATE;
// contradictory or malformed stored refs reject with ERR_STORAGE.
function deriveBeginTarget(conv, turnRecord, ref) {
  if (conv.controller === "codex") {
    if (turnRecord.nativeTurnId === null) throw errStopState();
    if (!ref) throw errStopState();
    return {
      controller: "codex",
      nativeIdentity: ref.nativeThreadId,
      nativeTurnId: turnRecord.nativeTurnId,
      claudeInputUuid: null,
      identitySource: "observed",
    };
  }
  if (turnRecord.intentState !== "written" && turnRecord.intentState !== "observed") {
    throw errStopState();
  }
  if (turnRecord.claudeInputUuid === null) throw errStorage();
  if (conv.requestedClaudeSessionUuid === null) throw errStopState();
  const identity = ref ? ref.nativeSessionUuid : conv.requestedClaudeSessionUuid;
  return {
    controller: "claude",
    nativeIdentity: identity,
    nativeTurnId: null,
    claudeInputUuid: turnRecord.claudeInputUuid,
    identitySource: ref ? "observed" : "requested",
  };
}

// Validate the committed original target against the CURRENT stored
// conversation/native ref/turn correlation too, not just caller equality.
// Current-row contradictions are stored corruption; caller mismatches are
// the caller's conflict (checked by the caller, not here).
function checkTargetCompatible(conv, turnRecord, ref, storedTarget) {
  if (!storedTarget || storedTarget.controller !== conv.controller) {
    throw errStorage();
  }
  if (conv.controller === "codex") {
    if (!ref || ref.nativeThreadId !== storedTarget.nativeIdentity) {
      throw errStorage();
    }
    if (turnRecord.nativeTurnId !== storedTarget.nativeTurnId) {
      throw errStorage();
    }
    if (turnRecord.claudeInputUuid !== null) throw errStorage();
    return;
  }
  if (conv.requestedClaudeSessionUuid !== storedTarget.nativeIdentity) {
    throw errStorage();
  }
  if (turnRecord.claudeInputUuid !== storedTarget.claudeInputUuid) {
    throw errStorage();
  }
  if (storedTarget.nativeTurnId !== null) throw errStorage();
  if (ref && ref.nativeSessionUuid !== storedTarget.nativeIdentity) {
    throw errStorage();
  }
}

// Persist one Stop intent plus its journal and receipt, atomically. At most
// one Stop op per turn for its entire lifetime. Idempotent on the exact
// request (same op id, payload, reason, owner, chat, turn, kind): returns
// { created: false } with the CURRENT record and no writes, even when the
// turn has since settled.
function runRequestStop(tx, authorizer, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  // The default reason applies only when the key is absent or undefined.
  const reason = input.reason === undefined ? "user" : input.reason;
  validateReason(reason);
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const hash = hashForRequest({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
    reason,
    scope,
  });
  const prior = tx.get(SQL_OP_BY_ID, [input.operationId]);
  if (prior) {
    if (
      prior.kind === "stop" &&
      prior.conversation_id === scope.conversationId &&
      prior.turn_id === input.turnId &&
      prior.payload_hash === hash &&
      prior.owner_generation === scope.ownerGeneration &&
      prior.host_generation === scope.hostGeneration
    ) {
      requireSoleStop(tx, scope, input.operationId);
      // An exact idempotent retry still proves its parent: a stored Stop
      // without a live parent handoff/turn, or with a provenance the request
      // no longer matches, must never read back as valid.
      const parentTurn = turnsTx.getTurn({
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        turnId: input.turnId,
      });
      if (!parentTurn) throw errStorage();
      requireHandoffProvenance(parentTurn, scope);
      return { created: false, stop: buildStopRecord(prior) };
    }
    throw errIdempotency();
  }
  const siblings = tx.all(SQL_STOP_SIBLINGS, [scope.conversationId, input.turnId]);
  if (siblings.length > 1) throw errStorage();
  if (siblings.length === 1) throw errConflict();
  const turnRecord = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
  });
  if (!turnRecord) throw errNotFound();
  requireHandoffProvenance(turnRecord, scope);
  // A fresh Stop requires a nonterminal target; an exact prior request
  // above already returned idempotently before this check.
  if (turnRecord.outcome !== null) throw errStopState();
  // Native refs may be absent pre-activation and are never invented here; a
  // present but malformed binding is corruption.
  readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  const historyText = JSON.stringify([{ kind: "queued", atMs: stamp }]);
  checkJsonCap(historyText, MAX_HISTORY_BYTES);
  const resultText = JSON.stringify({
    v: 1,
    kind: "queue",
    hash,
    reason,
    target: null,
    outcome: null,
  });
  checkJsonCap(resultText, MAX_RESULT_BYTES);
  tx.run(SQL_INSERT_STOP, [
    input.operationId,
    scope.conversationId,
    input.turnId,
    scope.ownerGeneration,
    scope.hostGeneration,
    reason,
    historyText,
    hash,
    resultText,
    stamp,
  ]);
  const stored = tx.get(SQL_OP_BY_ID, [input.operationId]);
  return { created: true, stop: buildStopRecord(stored) };
}

// Admit one Stop dispatch: CAS the paired op queued -> dispatching BEFORE
// any future native interrupt effect, with the target derived from persisted
// rows. The target commits one-shot and never changes afterwards. Repeated
// begins, including after a terminal Stop, always reject ERR_DISPATCH_CONFLICT,
// never a new permission. A resolved turn, including unknown, cannot newly
// dispatch a Stop through this slice.
function runBeginStopDispatch(tx, authorizer, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadStopOp(tx, scope);
  requireStopProvenance(opRow, scope);
  requireSoleStop(tx, scope, input.operationId);
  const turnRecord = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
  });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  // A repeated begin is always ERR_DISPATCH_CONFLICT, including after a
  // terminal outcome; it is never permission to interrupt again.
  if (opRow.state !== "queued") throw errDispatch();
  if (turnRecord.outcome !== null) throw errStopState();
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  const target = deriveBeginTarget(conv, turnRecord, ref);
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "dispatching", atMs: stamp, target });
  const receiptText = JSON.stringify({
    v: 1,
    kind: "begin",
    hash: opRow.payload_hash,
    reason: buildStopRecord(opRow).reason,
    target,
    outcome: null,
  });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_CAS_BEGIN, [appended.text, receiptText, input.operationId]);
  if (Number(updated.changes) !== 1) throw errDispatch();
  return buildStopRecord(tx.get(SQL_OP_BY_ID, [input.operationId]));
}

// Actual interrupt-request transport-write fact, NOT an ACK. Requires the op
// dispatching/written and the exact original target snapshot, plus a
// compatible current native/turn correlation. The target turn may already
// be terminal when this callback arrives; a terminal Stop rejects.
// Idempotent: an already-written Stop returns unchanged with no history
// growth.
function runRecordStopWritten(tx, authorizer, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  if (input.dispatchTarget === undefined || input.dispatchTarget === null) {
    throw errInvalid("dispatch target");
  }
  const callerTarget = validateTargetShape(input.dispatchTarget);
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadStopOp(tx, scope);
  requireStopProvenance(opRow, scope);
  requireSoleStop(tx, scope, input.operationId);
  const turnRecord = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
  });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  if (!PENDING_STOP_STATES.includes(opRow.state)) throw errStopState();
  if (opRow.state === "queued") throw errStopState();
  const stored = buildStopRecord(opRow);
  if (!targetsEqual(callerTarget, stored.dispatchTarget)) throw errConflict();
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  checkTargetCompatible(conv, turnRecord, ref, stored.dispatchTarget);
  if (opRow.state === "written") {
    return stored;
  }
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "written", atMs: stamp });
  const receiptText = JSON.stringify({
    v: 1,
    kind: "written",
    hash: opRow.payload_hash,
    reason: stored.reason,
    target: stored.dispatchTarget,
    outcome: null,
  });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_CAS_WRITTEN, [appended.text, receiptText, input.operationId]);
  if (Number(updated.changes) !== 1) throw errStopState();
  return buildStopRecord(tx.get(SQL_OP_BY_ID, [input.operationId]));
}

// Settle one Stop intent. Acknowledged requires dispatching/written and the
// exact original dispatch target; it records ONLY the interrupt-request
// acknowledgement and NEVER settles the turn. Unknown settles from any
// pending state with no target required (a supplied target must exactly
// match the stored one). Not_needed settles ONLY while the Stop is queued
// AND the target turn has actually settled completed/failed/interrupted, and
// takes no target argument. An exact terminal retry (same outcome, same
// original argument presence, with a supplied target equal to the bound
// snapshot) returns the unchanged record after proof and provenance — an
// acknowledged replay also rechecks native/turn compatibility; anything else
// on a terminal Stop conflicts. No terminal -> active transition exists.
function runSettleStop(tx, authorizer, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  validateOutcome(input.outcome);
  const hasTargetArg =
    input.dispatchTarget !== undefined && input.dispatchTarget !== null;
  const callerTarget = normalizeTargetArg(input.dispatchTarget);
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadStopOp(tx, scope);
  requireStopProvenance(opRow, scope);
  requireSoleStop(tx, scope, input.operationId);
  const turnRecord = turnsTx.getTurn({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
  });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  if (!PENDING_STOP_STATES.includes(opRow.state)) {
    // Exact terminal retry: same outcome AND same original argument presence
    // as the stored receipt; a supplied target must also equal the bound
    // snapshot. An acknowledged replay additionally rechecks current
    // native/turn compatibility, exactly like a first ACK. A missing or
    // different original fact rejects; unknown stays terminal.
    const stored = buildStopRecord(opRow);
    if (input.outcome !== stored.state) throw errConflict();
    const supplied = callerTarget !== null;
    if (storedTerminalSupplied(opRow) !== supplied) throw errConflict();
    if (supplied && !targetsEqual(callerTarget, stored.dispatchTarget)) {
      throw errConflict();
    }
    if (input.outcome === "acknowledged") {
      const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
      checkTargetCompatible(conv, turnRecord, ref, stored.dispatchTarget);
    }
    return stored;
  }
  const stored = buildStopRecord(opRow);
  if (input.outcome === "acknowledged") {
    // A supplied target may never stand in for a missing committed begin:
    // an ack from queued rejects even with a matching target.
    if (opRow.state === "queued") throw errStopState();
    if (!targetsEqual(callerTarget, stored.dispatchTarget)) throw errConflict();
    const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
    checkTargetCompatible(conv, turnRecord, ref, stored.dispatchTarget);
    return settleStopTo(tx, scope, opRow, stored, "acknowledged", true, stamp);
  }
  if (input.outcome === "unknown") {
    // Omitted/null is accepted from any pending state; a supplied target
    // must equal the bound snapshot. The supplied flag persists so an exact
    // null replay stays valid even though the record target remains bound.
    if (
      callerTarget !== null &&
      !targetsEqual(callerTarget, stored.dispatchTarget)
    ) {
      throw errConflict();
    }
    return settleStopTo(tx, scope, opRow, stored, "unknown", callerTarget !== null, stamp);
  }
  // not_needed takes no target argument and settles only while the Stop is
  // still queued and the target turn has actually settled to a known outcome.
  if (hasTargetArg) throw errInvalid("dispatch target");
  if (opRow.state !== "queued") throw errStopState();
  if (
    turnRecord.outcome !== "completed" &&
    turnRecord.outcome !== "failed" &&
    turnRecord.outcome !== "interrupted"
  ) {
    throw errStopState();
  }
  return settleStopTo(tx, scope, opRow, stored, "not_needed", false, stamp);
}

// Read the stored terminal argument presence flag from a terminal receipt
// for exact-retry comparison. The receipt shape is already validated by
// buildStopRecord; a missing or non-boolean key is corruption, never a match.
function storedTerminalSupplied(opRow) {
  let parsed;
  try {
    parsed = JSON.parse(opRow.result_json);
  } catch {
    throw errStorage();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errStorage();
  }
  if (typeof parsed.terminalTargetSupplied !== "boolean") throw errStorage();
  return parsed.terminalTargetSupplied;
}

function settleStopTo(tx, scope, opRow, stored, outcome, terminalTargetSupplied, stamp) {
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "terminal", atMs: stamp, outcome });
  const receiptText = JSON.stringify({
    v: 1,
    kind: "terminal",
    hash: opRow.payload_hash,
    reason: stored.reason,
    target: stored.dispatchTarget,
    outcome,
    terminalTargetSupplied,
  });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_SET_TERMINAL, [
    outcome,
    appended.text,
    receiptText,
    stamp,
    scope.operationId,
    opRow.state,
  ]);
  if (Number(updated.changes) !== 1) throw errStopState();
  return buildStopRecord(tx.get(SQL_OP_BY_ID, [scope.operationId]));
}

// Historical reads need no live proof: a released owner stays readable. A
// missing Stop is null after the project/chat check (even with no turn); a
// present Stop without a valid parent handoff/turn is ERR_STORAGE.
function runGetStop(tx, turnsTx, args) {
  const input = requireArgs(args);
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  validateUuid(input.turnId, "turn id");
  readConversation(tx, input.projectId, input.conversationId);
  const siblings = tx.all(SQL_STOP_SIBLINGS, [input.conversationId, input.turnId]);
  if (siblings.length === 0) return null;
  if (siblings.length !== 1) throw errStorage();
  const turnRecord = turnsTx.getTurn({
    projectId: input.projectId,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });
  if (!turnRecord) throw errStorage();
  const stop = buildStopRecord(siblings[0]);
  // Historical equality against the stored parent handoff — not the current
  // fence: a Stop whose provenance no longer matches its parent turn is
  // corruption, never a valid read.
  if (
    turnRecord.ownerGeneration !== stop.ownerGeneration ||
    turnRecord.hostGeneration !== stop.hostGeneration
  ) {
    throw errStorage();
  }
  return stop;
}

export function createSessionStops(options) {
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
  // The S2c reader validates the target turn and its sole handoff pair
  // inside the same transaction; Stop rows never count against the pair.
  const turnsReader = createSessionTurns({ store, verifyOwnerEvidence, now });

  // Wrapper methods pre-validate input shapes (matching the S2c convention)
  // so malformed calls fail before touching the store; the transaction body
  // re-validates for the inTransaction path.
  function requestStop(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    validateReason(input.reason === undefined ? "user" : input.reason);
    return store.transaction((tx) =>
      runRequestStop(tx, authorizer, turnsReader.inTransaction(tx), args, stamp)
    );
  }

  function beginStopDispatch(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    return store.transaction((tx) =>
      runBeginStopDispatch(tx, authorizer, turnsReader.inTransaction(tx), args, stamp)
    );
  }

  function recordStopWritten(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    return store.transaction((tx) =>
      runRecordStopWritten(tx, authorizer, turnsReader.inTransaction(tx), args, stamp)
    );
  }

  function settleStop(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    validateOutcome(input.outcome);
    return store.transaction((tx) =>
      runSettleStop(tx, authorizer, turnsReader.inTransaction(tx), args, stamp)
    );
  }

  function getStop(args) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    validateUuid(input.turnId, "turn id");
    return store.transaction((tx) => runGetStop(tx, turnsReader.inTransaction(tx), args));
  }

  // Trusted internal composition on a supplied ACTIVE scoped transaction:
  // no nested store.transaction, so a future S3 outer Stop+event+
  // projection+outcome write rolls back together. Lineage is proven by the
  // meta instance UUID; a tx from another store rejects with ERR_STORAGE.
  // Every mutation still rechecks the current fence and proof through the
  // same tx. Results are provisional until the OUTER commit: never perform
  // provider effects inside that callback or act on a provisional begin.
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
    const turnsTx = turnsReader.inTransaction(tx);
    return Object.freeze({
      requestStop: (args) => runRequestStop(tx, authorizer, turnsTx, args, resolveStamp(now)),
      beginStopDispatch: (args) =>
        runBeginStopDispatch(tx, authorizer, turnsTx, args, resolveStamp(now)),
      recordStopWritten: (args) =>
        runRecordStopWritten(tx, authorizer, turnsTx, args, resolveStamp(now)),
      settleStop: (args) => runSettleStop(tx, authorizer, turnsTx, args, resolveStamp(now)),
      getStop: (args) => runGetStop(tx, turnsTx, args),
    });
  }

  return Object.freeze({
    requestStop,
    beginStopDispatch,
    recordStopWritten,
    settleStop,
    getStop,
    inTransaction,
  });
}
