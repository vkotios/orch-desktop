// CHO-03 durable approval request/decision/response journal.
//
// Thin approval layer over the S1 session store (`session-store.mjs`) for turns
// created by the S2c turns API and fenced by the S2b producer fences. It
// persists the unconsumed approval intent BEFORE any native response effect,
// without sending responses, retrying providers, claiming cleanup, or touching
// turns/native_refs/fences. Each public data operation runs inside exactly one
// synchronous store.transaction with bound parameters; ownership checks, proof
// evaluation, and reads/mutations happen inside that same writer transaction
// via `createProducerAuthorizer`.
//
// Surface: createSessionApprovals({ store, verifyOwnerEvidence,
// verifyPendingApproval, now = Date.now }) -> frozen API { registerApproval,
// decideApproval, beginApprovalDispatch, settleApproval, getApproval,
// inTransaction }. Importing this module opens no files and starts no
// providers; the caller owns store.close(). `inTransaction(tx)` exposes the
// same five data methods on a supplied ACTIVE scoped transaction for trusted
// internal composition: each mutation still rechecks the current fence and
// proof, never a cached authorization. A tx from another store lineage
// (instance UUID mismatch) rejects with ERR_STORAGE.
//
// Model contract: many approvals per turn (no one-per-turn restriction). The
// UI approval UUID (operationId) is a unique native request INCARNATION; the
// typed native request ID alone is reusable and insufficient. States
// pending/decided/dispatching are nonterminal (outcome null); written/not_sent/
// unknown/unactionable are terminal (outcome equals state, settledAtMs set).
// The immutable normalized request is derived from STORED rows and stored once
// in the result receipt. The pending verifier gates fresh registration,
// decision, and dispatch admission; settlement requires no pending verifier.
//
// Error-code mapping: wrong/extra/missing keys or malformed input is
// ERR_INVALID_RECORD; a missing turn/operation is ERR_NOT_FOUND; a same-id
// reuse with different payload/owner/kind/chat is ERR_IDEMPOTENCY_CONFLICT; a
// well-shaped but non-matching request/decision is ERR_APPROVAL_CONFLICT; a
// pending verifier denial is ERR_APPROVAL_UNVERIFIED; a repeated begin is
// ERR_DISPATCH_CONFLICT; a premature/impossible transition is
// ERR_APPROVAL_STATE; malformed stored rows are ERR_STORAGE.
import { createHash } from "node:crypto";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";
import { createSessionTurns } from "./session-turns.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_NATIVE_ID = 512;
const MAX_HISTORY_BYTES = 4096;
const MAX_RESULT_BYTES = 32768;
const APPROVAL_V1 = "approval-v1";
const CANONICAL_DECISIONS = ["accept", "decline", "cancel"];
const DECISION_SET = new Set(CANONICAL_DECISIONS);
const APPROVAL_TYPES = new Set(["command", "file", "tool"]);
const PENDING_STATES = ["pending", "decided", "dispatching"];
const TERMINAL_STATES = ["written", "not_sent", "unknown", "unactionable"];
const KNOWN_STATES = [...PENDING_STATES, ...TERMINAL_STATES];
const HISTORY_KINDS = ["registered", "decided", "dispatching", "terminal"];
const COLLISION_LIMIT = 64;

function approvalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const errInvalid = (detail) =>
  approvalError("ERR_INVALID_RECORD", `session approval input is invalid (${detail})`);
const errNotFound = () =>
  approvalError("ERR_NOT_FOUND", "session approval not found");
const errIdempotency = () =>
  approvalError("ERR_IDEMPOTENCY_CONFLICT", "session approval id already used with a different payload, owner, or kind");
const errApprovalConflict = () =>
  approvalError("ERR_APPROVAL_CONFLICT", "session approval request or decision conflict");
const errApprovalUnverified = () =>
  approvalError("ERR_APPROVAL_UNVERIFIED", "session approval pending state is not verified");
const errDispatch = () =>
  approvalError("ERR_DISPATCH_CONFLICT", "session approval dispatch already admitted");
const errApprovalState = () =>
  approvalError("ERR_APPROVAL_STATE", "session approval state transition rejected");
const errFence = () =>
  approvalError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const errStorage = () =>
  approvalError("ERR_STORAGE", "session approval stored data is unreadable");

function requireArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errInvalid("arguments");
  }
  return value;
}

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
  if (typeof value !== "string" || !UUID_RE.test(value)) throw errInvalid(detail);
}

function validateScopeShape(scope) {
  const s = requireArgs(scope);
  validateUuid(s.projectId, "project id");
  validateUuid(s.conversationId, "conversation id");
  validateUuid(s.ownerToken, "owner token");
  if (!Number.isSafeInteger(s.ownerGeneration) || s.ownerGeneration < 1) throw errInvalid("owner generation");
  validateUuid(s.hostGeneration, "host generation");
  return s;
}

function validateWellformedText(value, min, max, detail) {
  if (typeof value !== "string" || value.length < min || value.length > max ||
      value.includes("\0") || hasLoneSurrogate(value)) {
    throw errInvalid(detail);
  }
}

function validateOpaqueId(value, detail) {
  validateWellformedText(value, 1, MAX_NATIVE_ID, detail);
}

// Typed native request ID: safe integer (reject -0) or nonempty wellformed
// string <=512 UTF-16 units. Returns { text, type } for column storage.
function validateNativeRequestId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw errInvalid("native request id");
    return { text: JSON.stringify(value), type: "number" };
  }
  if (typeof value === "string") {
    validateWellformedText(value, 1, MAX_NATIVE_ID, "native request id");
    return { text: JSON.stringify(value), type: "string" };
  }
  throw errInvalid("native request id");
}

// Decisions: nonempty unique subset of accept|decline|cancel, normalized to
// canonical order. Input order is not semantic.
function validateDecisions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw errInvalid("decisions");
  const seen = new Set();
  for (const d of value) {
    if (!DECISION_SET.has(d) || seen.has(d)) throw errInvalid("decisions");
    seen.add(d);
  }
  return CANONICAL_DECISIONS.filter((d) => seen.has(d));
}

function validateApprovalType(value, controller) {
  if (!APPROVAL_TYPES.has(value)) throw errInvalid("approval type");
  if (controller === "codex" && value === "tool") throw errInvalid("approval type");
  if (controller === "claude" && value !== "tool") throw errInvalid("approval type");
  return value;
}

function resolveStamp(now) {
  let stamp;
  try { stamp = now(); } catch { throw errInvalid("clock"); }
  if (!Number.isSafeInteger(stamp) || stamp < 0) throw errInvalid("clock");
  return stamp;
}

// Static SQL only: every dynamic value travels as a bound parameter.
const SQL_CONVERSATION_FULL =
  "SELECT id, project_id, controller, model_requested, effort, role, requested_claude_session_uuid FROM conversations WHERE id = ? AND project_id = ?";
const SQL_OP_BY_ID =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, native_request_id_text, native_request_id_type, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE id = ?";
const SQL_REF_BY_CONVERSATION =
  "SELECT conversation_id, project_id, controller, native_thread_id, native_session_uuid FROM native_refs WHERE conversation_id = ?";
const SQL_INSERT_APPROVAL =
  "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, native_request_id_text, native_request_id_type, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'approval', ?, ?, NULL, ?, ?, 'pending', ?, ?, ?, ?, NULL)";
const SQL_CAS_DECIDE =
  "UPDATE operations SET decision = ?, state = 'decided', history_json = ?, result_json = ? WHERE id = ? AND state = 'pending'";
const SQL_CAS_BEGIN =
  "UPDATE operations SET state = 'dispatching', history_json = ?, result_json = ? WHERE id = ? AND state = 'decided'";
const SQL_SET_TERMINAL =
  "UPDATE operations SET state = ?, history_json = ?, result_json = ?, settled_at_ms = ? WHERE id = ? AND state = ?";
const SQL_COLLISION =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, native_request_id_text, native_request_id_type, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE kind = 'approval' AND host_generation = ? AND native_request_id_text = ? AND native_request_id_type = ? AND state IN ('pending','decided','dispatching','unknown') LIMIT 65";

function readConversation(tx, projectId, conversationId) {
  const row = tx.get(SQL_CONVERSATION_FULL, [conversationId, projectId]);
  if (!row) throw errNotFound();
  if (row.controller !== "codex" && row.controller !== "claude") throw errStorage();
  if (row.model_requested !== null) {
    try { validateWellformedText(row.model_requested, 1, 256, "stored model"); }
    catch (e) { if (e?.code === "ERR_INVALID_RECORD") throw errStorage(); throw e; }
  }
  if (row.role !== null && row.role !== "implement" && row.role !== "review") throw errStorage();
  const requested = row.requested_claude_session_uuid ?? null;
  if (requested !== null && (typeof requested !== "string" || !UUID_RE.test(requested))) throw errStorage();
  return { id: row.id, projectId: row.project_id, controller: row.controller, role: row.role, requestedClaudeSessionUuid: requested };
}

function readNativeRef(tx, projectId, conversationId, conv) {
  const rows = tx.all(SQL_REF_BY_CONVERSATION, [conversationId]);
  if (rows.length > 1) throw errStorage();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.project_id !== projectId) throw errStorage();
  if (row.controller !== conv.controller) throw errStorage();
  if (conv.controller === "codex") {
    try { validateOpaqueId(row.native_thread_id, "stored thread id"); }
    catch (e) { if (e?.code === "ERR_INVALID_RECORD") throw errStorage(); throw e; }
    if (row.native_session_uuid !== null) throw errStorage();
    return { conversationId, projectId, controller: "codex", nativeThreadId: row.native_thread_id, nativeSessionUuid: null };
  }
  if (typeof row.native_session_uuid !== "string" || !UUID_RE.test(row.native_session_uuid)) throw errStorage();
  if (row.native_thread_id !== null) throw errStorage();
  if (conv.requestedClaudeSessionUuid !== row.native_session_uuid) throw errStorage();
  return { conversationId, projectId, controller: "claude", nativeThreadId: null, nativeSessionUuid: row.native_session_uuid };
}

function checkJsonCap(text, max) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > max) throw errStorage();
}

// Derive the immutable normalized request from stored rows.
function deriveRequest(conv, turnRecord, ref, nativeItemId, nativeRequestId, connectionId, approvalType, decisions) {
  if (conv.controller === "codex") {
    if (turnRecord.nativeTurnId === null) throw errApprovalState();
    if (!ref) throw errApprovalState();
    return Object.freeze({
      controller: "codex", nativeIdentity: ref.nativeThreadId, nativeTurnId: turnRecord.nativeTurnId,
      claudeInputUuid: null, nativeItemId, nativeRequestId, connectionId, approvalType, decisions,
    });
  }
  if (turnRecord.claudeInputUuid === null) throw errStorage();
  if (conv.requestedClaudeSessionUuid === null) throw errApprovalState();
  const identity = ref ? ref.nativeSessionUuid : conv.requestedClaudeSessionUuid;
  if (ref && ref.nativeSessionUuid !== conv.requestedClaudeSessionUuid) throw errStorage();
  return Object.freeze({
    controller: "claude", nativeIdentity: identity, nativeTurnId: null,
    claudeInputUuid: turnRecord.claudeInputUuid, nativeItemId, nativeRequestId, connectionId, approvalType, decisions,
  });
}

function requestsEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a.controller === b.controller && a.nativeIdentity === b.nativeIdentity &&
    a.nativeTurnId === b.nativeTurnId && a.claudeInputUuid === b.claudeInputUuid &&
    a.nativeItemId === b.nativeItemId && a.nativeRequestId === b.nativeRequestId &&
    a.connectionId === b.connectionId && a.approvalType === b.approvalType &&
    a.decisions.length === b.decisions.length && a.decisions.every((d, i) => d === b.decisions[i]);
}

// Validate a caller-supplied request against the stored one.
function validateRequestShape(value) {
  const r = requireArgs(value);
  const keys = Object.keys(r).sort();
  const want = ["approvalType", "claudeInputUuid", "connectionId", "controller", "decisions", "nativeIdentity", "nativeItemId", "nativeRequestId", "nativeTurnId"];
  if (keys.length !== 9 || keys.some((k, i) => k !== want[i])) throw errInvalid("request");
  if (r.controller !== "codex" && r.controller !== "claude") throw errInvalid("request");
  if (!APPROVAL_TYPES.has(r.approvalType)) throw errInvalid("request");
  validateUuid(r.connectionId, "request");
  validateOpaqueId(r.nativeItemId, "request");
  if (!Array.isArray(r.decisions) || r.decisions.length === 0) throw errInvalid("request");
  for (const d of r.decisions) if (!DECISION_SET.has(d)) throw errInvalid("request");
  if (r.controller === "codex") {
    validateOpaqueId(r.nativeIdentity, "request");
    validateOpaqueId(r.nativeTurnId, "request");
    if (r.claudeInputUuid !== null) throw errInvalid("request");
  } else {
    validateUuid(r.nativeIdentity, "request");
    if (r.nativeTurnId !== null) throw errInvalid("request");
    validateUuid(r.claudeInputUuid, "request");
  }
  const nr = r.nativeRequestId;
  if (typeof nr === "number") { if (!Number.isSafeInteger(nr) || Object.is(nr, -0)) throw errInvalid("request"); }
  else if (typeof nr === "string") { validateWellformedText(nr, 1, MAX_NATIVE_ID, "request"); }
  else throw errInvalid("request");
  return Object.freeze({ ...r, decisions: Object.freeze([...r.decisions]) });
}

function parseHistoryJson(text) {
  checkJsonCap(text, MAX_HISTORY_BYTES);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw errStorage(); }
  if (!Array.isArray(parsed) || parsed.length > HISTORY_KINDS.length) throw errStorage();
  const seen = new Set();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw errStorage();
    if (!HISTORY_KINDS.includes(entry.kind)) throw errStorage();
    if (!Number.isSafeInteger(entry.atMs) || entry.atMs < 0) throw errStorage();
    if (seen.has(entry.kind)) throw errStorage();
    seen.add(entry.kind);
  }
  if (!seen.has("registered")) throw errStorage();
  if (parsed[0].kind !== "registered") throw errStorage();
  const pos = new Map();
  parsed.forEach((e, i) => pos.set(e.kind, i));
  if (pos.has("decided") && pos.get("decided") < pos.get("registered")) throw errStorage();
  if (pos.has("dispatching")) {
    if (!pos.has("decided") || pos.get("decided") > pos.get("dispatching")) throw errStorage();
  }
  if (pos.has("terminal") && pos.get("terminal") !== parsed.length - 1) throw errStorage();
  for (const entry of parsed) {
    const keys = Object.keys(entry).sort();
    if (entry.kind === "decided") {
      if (keys.length !== 3 || keys[0] !== "atMs" || keys[1] !== "decision" || keys[2] !== "kind") throw errStorage();
      if (!DECISION_SET.has(entry.decision)) throw errStorage();
    } else if (entry.kind === "terminal") {
      if (keys.length !== 3 || keys[0] !== "atMs" || keys[1] !== "kind" || keys[2] !== "outcome") throw errStorage();
      if (!TERMINAL_STATES.includes(entry.outcome)) throw errStorage();
    } else if (keys.length !== 2 || keys[0] !== "atMs" || keys[1] !== "kind") {
      throw errStorage();
    }
  }
  return parsed.map((e) => ({ ...e }));
}

function parseResultJson(text, { state, hash }) {
  checkJsonCap(text, MAX_RESULT_BYTES);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw errStorage(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw errStorage();
  if (parsed.v !== 1 || parsed.hash !== hash) throw errStorage();
  const keys = Object.keys(parsed).sort();
  const wantKeys = ["decision", "hash", "outcome", "request", "terminalRequestSupplied", "v"];
  if (keys.length !== 6 || keys.some((k, i) => k !== wantKeys[i])) throw errStorage();
  if (typeof parsed.terminalRequestSupplied !== "boolean") throw errStorage();
  if (parsed.request === null) throw errStorage();
  try { validateRequestShape(parsed.request); }
  catch (e) { if (e?.code === "ERR_INVALID_RECORD") throw errStorage(); throw e; }
  if (state === "pending") {
    if (parsed.decision !== null || parsed.outcome !== null || parsed.terminalRequestSupplied) throw errStorage();
  } else if (state === "decided") {
    if (!DECISION_SET.has(parsed.decision) || parsed.outcome !== null || parsed.terminalRequestSupplied) throw errStorage();
  } else if (state === "dispatching") {
    if (!DECISION_SET.has(parsed.decision) || parsed.outcome !== null || parsed.terminalRequestSupplied) throw errStorage();
  } else {
    if (parsed.outcome !== state) throw errStorage();
    if (parsed.decision !== null && !DECISION_SET.has(parsed.decision)) throw errStorage();
  }
  return { ...parsed, request: { ...parsed.request, decisions: [...parsed.request.decisions] } };
}

function computeApprovalHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function hashForRequest({ projectId, conversationId, turnId, operationId, scope, request }) {
  return computeApprovalHash([APPROVAL_V1, projectId, conversationId, turnId, operationId,
    scope.ownerToken, scope.ownerGeneration, scope.hostGeneration, request]);
}

function appendHistoryFact(history, entry) {
  if (history.some((e) => e.kind === entry.kind)) return { text: JSON.stringify(history), changed: false };
  const next = [...history, { ...entry }];
  const text = JSON.stringify(next);
  checkJsonCap(text, MAX_HISTORY_BYTES);
  return { text, changed: true };
}

function buildApprovalRecord(opRow) {
  if (!opRow || typeof opRow !== "object") throw errStorage();
  if (typeof opRow.id !== "string" || !UUID_RE.test(opRow.id)) throw errStorage();
  if (opRow.kind !== "approval") throw errStorage();
  if (typeof opRow.conversation_id !== "string" || !UUID_RE.test(opRow.conversation_id)) throw errStorage();
  if (typeof opRow.turn_id !== "string" || !UUID_RE.test(opRow.turn_id)) throw errStorage();
  if (!Number.isSafeInteger(opRow.owner_generation) || opRow.owner_generation < 1) throw errStorage();
  if (typeof opRow.host_generation !== "string" || !UUID_RE.test(opRow.host_generation)) throw errStorage();
  if (opRow.decision !== null && !DECISION_SET.has(opRow.decision)) throw errStorage();
  if (typeof opRow.native_request_id_text !== "string") throw errStorage();
  if (opRow.native_request_id_type !== "number" && opRow.native_request_id_type !== "string") throw errStorage();
  if (!KNOWN_STATES.includes(opRow.state)) throw errStorage();
  const pending = PENDING_STATES.includes(opRow.state);
  const outcome = pending ? null : opRow.state;
  if (pending) { if (opRow.settled_at_ms !== null) throw errStorage(); }
  else if (!Number.isSafeInteger(opRow.settled_at_ms) || opRow.settled_at_ms < 0) throw errStorage();
  if (!Number.isSafeInteger(opRow.created_at_ms) || opRow.created_at_ms < 0) throw errStorage();
  if (typeof opRow.payload_hash !== "string" || !SHA_RE.test(opRow.payload_hash)) throw errStorage();
  const history = parseHistoryJson(opRow.history_json);
  const receipt = parseResultJson(opRow.result_json, { state: opRow.state, hash: opRow.payload_hash });
  const req = receipt.request;
  // Crosscheck native_request_id_text/type against receipt.request.nativeRequestId
  const nrCanonical = JSON.stringify(req.nativeRequestId);
  if (opRow.native_request_id_text !== nrCanonical) throw errStorage();
  const nrType = typeof req.nativeRequestId === "number" ? "number" : "string";
  if (opRow.native_request_id_type !== nrType) throw errStorage();
  // request.controller vs approvalType
  if (req.controller === "codex" && req.approvalType === "tool") throw errStorage();
  if (req.controller === "claude" && req.approvalType !== "tool") throw errStorage();
  // canonical unique offered decisions max 3
  if (!Array.isArray(req.decisions) || req.decisions.length === 0 || req.decisions.length > 3) throw errStorage();
  const dSet = new Set(req.decisions);
  if (dSet.size !== req.decisions.length) throw errStorage();
  for (const d of req.decisions) if (!DECISION_SET.has(d)) throw errStorage();
  const canonical = CANONICAL_DECISIONS.filter((d) => dSet.has(d));
  if (canonical.length !== req.decisions.length || canonical.some((d, i) => d !== req.decisions[i])) throw errStorage();
  // chosen decision must be offered
  if (opRow.decision !== null && !dSet.has(opRow.decision)) throw errStorage();
  // history decided fact decision equals row decision and receipt decision
  const decidedFact = history.find((e) => e.kind === "decided");
  if (opRow.decision === null) {
    if (decidedFact) throw errStorage();
    if (receipt.decision !== null) throw errStorage();
  } else {
    if (!decidedFact) throw errStorage();
    if (decidedFact.decision !== opRow.decision) throw errStorage();
    if (receipt.decision !== opRow.decision) throw errStorage();
  }
  if (opRow.decision !== null && receipt.decision !== opRow.decision) throw errStorage();
  if (opRow.decision === null && receipt.decision !== null) throw errStorage();
  // atMs nondecreasing
  for (let i = 1; i < history.length; i += 1) {
    if (history[i].atMs < history[i - 1].atMs) throw errStorage();
  }
  // registered atMs == createdAtMs
  if (history[0].atMs !== opRow.created_at_ms) throw errStorage();
  // terminal atMs == settledAtMs and >= createdAtMs
  const terminalFact = history.find((e) => e.kind === "terminal");
  if (terminalFact) {
    if (terminalFact.atMs !== opRow.settled_at_ms) throw errStorage();
    if (terminalFact.atMs < opRow.created_at_ms) throw errStorage();
  }
  // Exactly mandatory facts per state
  const kinds = history.map((e) => e.kind);
  if (opRow.state === "pending") { if (kinds.length !== 1) throw errStorage(); }
  else if (opRow.state === "decided") { if (kinds.length !== 2 || kinds[1] !== "decided") throw errStorage(); }
  else if (opRow.state === "dispatching") { if (kinds.length !== 3 || kinds[2] !== "dispatching") throw errStorage(); }
  else {
    if (!terminalFact || terminalFact.outcome !== opRow.state) throw errStorage();
    if (opRow.state === "written" || opRow.state === "not_sent") {
      if (!kinds.includes("decided") || !kinds.includes("dispatching")) throw errStorage();
      if (!receipt.terminalRequestSupplied) throw errStorage();
    }
    if (opRow.state === "unactionable") {
      if (kinds.includes("dispatching")) throw errStorage();
      if (receipt.terminalRequestSupplied) throw errStorage();
    }
    // unknown: any legal prefix allowed (registered, optionally decided, optionally dispatching, terminal)
  }
  checkJsonCap(opRow.history_json, MAX_HISTORY_BYTES);
  checkJsonCap(opRow.result_json, MAX_RESULT_BYTES);
  return {
    id: opRow.id, conversationId: opRow.conversation_id, turnId: opRow.turn_id,
    request: { ...req, decisions: [...req.decisions] },
    decision: opRow.decision, state: opRow.state, outcome,
    ownerGeneration: opRow.owner_generation, hostGeneration: opRow.host_generation,
    createdAtMs: opRow.created_at_ms, settledAtMs: opRow.settled_at_ms,
    history: history.map((e) => ({ ...e })),
  };
}

function deepFreezeRequest(request) {
  if (request === null) return null;
  return Object.freeze({
    controller: request.controller,
    nativeIdentity: request.nativeIdentity,
    nativeTurnId: request.nativeTurnId,
    claudeInputUuid: request.claudeInputUuid,
    nativeItemId: request.nativeItemId,
    nativeRequestId: request.nativeRequestId,
    connectionId: request.connectionId,
    approvalType: request.approvalType,
    decisions: Object.freeze([...request.decisions]),
  });
}

function verifyPending(pendingVerifier, facts) {
  const frozenFacts = Object.freeze({
    ...facts,
    request: deepFreezeRequest(facts.request),
  });
  let result;
  try { result = pendingVerifier(frozenFacts); } catch { throw errApprovalUnverified(); }
  if (result === true) return;
  let then;
  try { then = result !== null && (typeof result === "object" || typeof result === "function") ? result.then : undefined; }
  catch { throw errApprovalUnverified(); }
  if (typeof then === "function") { try { result.then(undefined, () => {}); } catch { /* consume */ } }
  throw errApprovalUnverified();
}

function loadApprovalOp(tx, scope) {
  const opRow = tx.get(SQL_OP_BY_ID, [scope.operationId]);
  if (!opRow) throw errNotFound();
  if (opRow.kind !== "approval" || opRow.conversation_id !== scope.conversationId || opRow.turn_id !== scope.turnId) {
    throw errIdempotency();
  }
  return opRow;
}

function requireApprovalProvenance(opRow, scope) {
  if (opRow.owner_generation !== scope.ownerGeneration || opRow.host_generation !== scope.hostGeneration) throw errFence();
}

function requireHandoffProvenance(turnRecord, scope) {
  if (turnRecord.ownerGeneration !== scope.ownerGeneration || turnRecord.hostGeneration !== scope.hostGeneration) throw errFence();
}

function checkNativeCompatible(conv, turnRecord, ref, storedRequest) {
  if (!storedRequest || storedRequest.controller !== conv.controller) throw errStorage();
  if (conv.controller === "codex") {
    if (!ref || ref.nativeThreadId !== storedRequest.nativeIdentity) throw errStorage();
    if (turnRecord.nativeTurnId !== storedRequest.nativeTurnId) throw errStorage();
    if (turnRecord.claudeInputUuid !== null) throw errStorage();
    return;
  }
  if (conv.requestedClaudeSessionUuid !== storedRequest.nativeIdentity) throw errStorage();
  if (turnRecord.claudeInputUuid !== storedRequest.claudeInputUuid) throw errStorage();
  if (storedRequest.nativeTurnId !== null) throw errStorage();
  if (ref && ref.nativeSessionUuid !== storedRequest.nativeIdentity) throw errStorage();
  if (!ref && conv.requestedClaudeSessionUuid !== storedRequest.nativeIdentity) throw errStorage();
}

function runRegisterApproval(tx, authorizer, pendingVerifier, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "approval id");
  const nr = validateNativeRequestId(input.nativeRequestId);
  validateUuid(input.connectionId, "connection id");
  validateOpaqueId(input.nativeItemId, "native item id");
  const decisions = validateDecisions(input.decisions);
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  const approvalType = validateApprovalType(input.approvalType, conv.controller);
  authorizer.authorizeLiveWrite(tx, scope);
  const turnRecord = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
  if (!turnRecord) throw errNotFound();
  requireHandoffProvenance(turnRecord, scope);
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  const request = deriveRequest(conv, turnRecord, ref, input.nativeItemId, input.nativeRequestId, input.connectionId, approvalType, decisions);
  const hash = hashForRequest({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId, operationId: input.operationId, scope, request });
  const prior = tx.get(SQL_OP_BY_ID, [input.operationId]);
  if (prior) {
    if (prior.kind === "approval" && prior.conversation_id === scope.conversationId &&
        prior.turn_id === input.turnId) {
      if (prior.host_generation !== scope.hostGeneration) {
        const pt = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
        if (!pt) throw errStorage();
        if (pt.hostGeneration === scope.hostGeneration) throw errFence();
        throw errIdempotency();
      }
      if (prior.payload_hash !== hash || prior.owner_generation !== scope.ownerGeneration) {
        throw errIdempotency();
      }
      const storedRec = buildApprovalRecord(prior);
      if (!requestsEqual(storedRec.request, request)) throw errIdempotency();
      const parentTurn = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
      if (!parentTurn) throw errStorage();
      requireHandoffProvenance(parentTurn, scope);
      const storedRef = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
      checkNativeCompatible(conv, parentTurn, storedRef, storedRec.request);
      return { created: false, approval: storedRec };
    }
    throw errIdempotency();
  }
  // Fresh registration: require observed nonterminal parent and bound ref.
  if (turnRecord.intentState !== "observed") throw errApprovalState();
  if (!ref) throw errApprovalState();
  if (turnRecord.outcome !== null) throw errApprovalState();
  // Collision: same hostGeneration + typed nativeID in active states.
  const candidates = tx.all(SQL_COLLISION, [scope.hostGeneration, nr.text, nr.type]);
  if (candidates.length > COLLISION_LIMIT) throw errStorage();
  for (const c of candidates) {
    checkJsonCap(c.result_json, MAX_RESULT_BYTES);
    const cRec = buildApprovalRecord(c);
    if (cRec.request.connectionId === input.connectionId) throw errApprovalConflict();
  }
  verifyPending(pendingVerifier, {
    action: "register", projectId: scope.projectId, conversationId: scope.conversationId,
    turnId: input.turnId, approvalId: input.operationId, ownerToken: scope.ownerToken,
    ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration,
    request, decision: null, evidence: input.pendingEvidence,
  });
  const historyText = JSON.stringify([{ kind: "registered", atMs: stamp }]);
  checkJsonCap(historyText, MAX_HISTORY_BYTES);
  const resultText = JSON.stringify({ v: 1, hash, request, decision: null, outcome: null, terminalRequestSupplied: false });
  checkJsonCap(resultText, MAX_RESULT_BYTES);
  tx.run(SQL_INSERT_APPROVAL, [input.operationId, scope.conversationId, input.turnId,
    scope.ownerGeneration, scope.hostGeneration, nr.text, nr.type, historyText, hash, resultText, stamp]);
  return { created: true, approval: buildApprovalRecord(tx.get(SQL_OP_BY_ID, [input.operationId])) };
}

function runDecideApproval(tx, authorizer, pendingVerifier, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "approval id");
  if (!DECISION_SET.has(input.decision)) throw errInvalid("decision");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadApprovalOp(tx, scope);
  requireApprovalProvenance(opRow, scope);
  const turnRecord = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  const stored = buildApprovalRecord(opRow);
  if (opRow.state !== "pending") {
    if (opRow.decision === input.decision) return stored;
    throw errApprovalConflict();
  }
  if (!stored.request.decisions.includes(input.decision)) throw errApprovalConflict();
  if (turnRecord.intentState !== "observed") throw errApprovalState();
  if (turnRecord.outcome !== null) throw errApprovalState();
  if (stamp < stored.createdAtMs) throw errInvalid("clock");
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  checkNativeCompatible(conv, turnRecord, ref, stored.request);
  verifyPending(pendingVerifier, {
    action: "decide", projectId: scope.projectId, conversationId: scope.conversationId,
    turnId: input.turnId, approvalId: input.operationId, ownerToken: scope.ownerToken,
    ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration,
    request: stored.request, decision: input.decision, evidence: input.pendingEvidence,
  });
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "decided", atMs: stamp, decision: input.decision });
  const receiptText = JSON.stringify({ v: 1, hash: opRow.payload_hash, request: stored.request, decision: input.decision, outcome: null, terminalRequestSupplied: false });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_CAS_DECIDE, [input.decision, appended.text, receiptText, input.operationId]);
  if (Number(updated.changes) !== 1) throw errApprovalConflict();
  return buildApprovalRecord(tx.get(SQL_OP_BY_ID, [input.operationId]));
}

function runBeginApprovalDispatch(tx, authorizer, pendingVerifier, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "approval id");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadApprovalOp(tx, scope);
  requireApprovalProvenance(opRow, scope);
  const turnRecord = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  if (opRow.state === "pending") throw errApprovalState();
  if (opRow.state !== "decided") throw errDispatch();
  if (turnRecord.intentState !== "observed") throw errApprovalState();
  if (turnRecord.outcome !== null) throw errApprovalState();
  const stored = buildApprovalRecord(opRow);
  if (stamp < stored.createdAtMs) throw errInvalid("clock");
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  checkNativeCompatible(conv, turnRecord, ref, stored.request);
  verifyPending(pendingVerifier, {
    action: "dispatch", projectId: scope.projectId, conversationId: scope.conversationId,
    turnId: input.turnId, approvalId: input.operationId, ownerToken: scope.ownerToken,
    ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration,
    request: stored.request, decision: stored.decision, evidence: input.pendingEvidence,
  });
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "dispatching", atMs: stamp });
  const receiptText = JSON.stringify({ v: 1, hash: opRow.payload_hash, request: stored.request, decision: stored.decision, outcome: null, terminalRequestSupplied: false });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_CAS_BEGIN, [appended.text, receiptText, input.operationId]);
  if (Number(updated.changes) !== 1) throw errDispatch();
  return buildApprovalRecord(tx.get(SQL_OP_BY_ID, [input.operationId]));
}

function runSettleApproval(tx, authorizer, turnsTx, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "approval id");
  if (!TERMINAL_STATES.includes(input.outcome)) throw errInvalid("outcome");
  const hasRequestArg = input.request !== undefined && input.request !== null;
  const callerRequest = hasRequestArg ? validateRequestShape(input.request) : null;
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const opRow = loadApprovalOp(tx, scope);
  requireApprovalProvenance(opRow, scope);
  const turnRecord = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: input.turnId });
  if (!turnRecord) throw errStorage();
  requireHandoffProvenance(turnRecord, scope);
  const stored = buildApprovalRecord(opRow);
  if (stamp < stored.createdAtMs) throw errInvalid("clock");
  if (!PENDING_STATES.includes(opRow.state)) {
    if (input.outcome !== stored.state) throw errApprovalConflict();
    const supplied = callerRequest !== null;
    const storedSupplied = storedTerminalSupplied(opRow);
    if (storedSupplied !== supplied) throw errApprovalConflict();
    if (supplied && !requestsEqual(callerRequest, stored.request)) throw errApprovalConflict();
    if (input.outcome === "written" || input.outcome === "not_sent") {
      const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
      checkNativeCompatible(conv, turnRecord, ref, stored.request);
    }
    return stored;
  }
  if (input.outcome === "written" || input.outcome === "not_sent") {
    if (opRow.state !== "dispatching") throw errApprovalState();
    if (!hasRequestArg) throw errInvalid("request");
    if (!requestsEqual(callerRequest, stored.request)) throw errApprovalConflict();
    const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
    checkNativeCompatible(conv, turnRecord, ref, stored.request);
    return settleApprovalTo(tx, scope, opRow, stored, input.outcome, true, stamp);
  }
  if (input.outcome === "unknown") {
    if (callerRequest !== null && !requestsEqual(callerRequest, stored.request)) throw errApprovalConflict();
    return settleApprovalTo(tx, scope, opRow, stored, "unknown", callerRequest !== null, stamp);
  }
  // unactionable: only pending/decided, no request.
  if (hasRequestArg) throw errInvalid("request");
  if (opRow.state === "dispatching") throw errApprovalState();
  return settleApprovalTo(tx, scope, opRow, stored, "unactionable", false, stamp);
}

function storedTerminalSupplied(opRow) {
  let parsed;
  try { parsed = JSON.parse(opRow.result_json); } catch { throw errStorage(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw errStorage();
  if (typeof parsed.terminalRequestSupplied !== "boolean") throw errStorage();
  return parsed.terminalRequestSupplied;
}

function settleApprovalTo(tx, scope, opRow, stored, outcome, terminalRequestSupplied, stamp) {
  const history = parseHistoryJson(opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "terminal", atMs: stamp, outcome });
  const receiptText = JSON.stringify({ v: 1, hash: opRow.payload_hash, request: stored.request, decision: stored.decision, outcome, terminalRequestSupplied });
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const updated = tx.run(SQL_SET_TERMINAL, [outcome, appended.text, receiptText, stamp, scope.operationId, opRow.state]);
  if (Number(updated.changes) !== 1) throw errApprovalState();
  return buildApprovalRecord(tx.get(SQL_OP_BY_ID, [scope.operationId]));
}

function runGetApproval(tx, turnsTx, args) {
  const input = requireArgs(args);
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  validateUuid(input.operationId, "approval id");
  const conv = readConversation(tx, input.projectId, input.conversationId);
  const opRow = tx.get(SQL_OP_BY_ID, [input.operationId]);
  if (!opRow) return null;
  if (opRow.kind !== "approval" || opRow.conversation_id !== input.conversationId) throw errNotFound();
  const turnRecord = turnsTx.getTurn({ projectId: input.projectId, conversationId: input.conversationId, turnId: opRow.turn_id });
  if (!turnRecord) throw errStorage();
  const approval = buildApprovalRecord(opRow);
  if (turnRecord.ownerGeneration !== approval.ownerGeneration || turnRecord.hostGeneration !== approval.hostGeneration) throw errStorage();
  const ref = readNativeRef(tx, input.projectId, input.conversationId, conv);
  checkNativeCompatible(conv, turnRecord, ref, approval.request);
  return approval;
}

export function createSessionApprovals(options) {
  const settings = requireArgs(options ?? null);
  const { store, verifyOwnerEvidence, verifyPendingApproval, now = Date.now } = settings;
  if (store === null || typeof store !== "object") throw errInvalid("store");
  if (typeof store.transaction !== "function") throw errInvalid("store");
  if (typeof verifyOwnerEvidence !== "function") throw errInvalid("owner verifier");
  if (typeof verifyPendingApproval !== "function") throw errInvalid("pending verifier");
  if (typeof now !== "function") throw errInvalid("clock");
  const authorizer = createProducerAuthorizer({ verifyOwnerEvidence });
  const turnsReader = createSessionTurns({ store, verifyOwnerEvidence, now });

  function registerApproval(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "approval id");
    validateNativeRequestId(input.nativeRequestId);
    validateUuid(input.connectionId, "connection id");
    validateOpaqueId(input.nativeItemId, "native item id");
    validateDecisions(input.decisions);
    return store.transaction((tx) =>
      runRegisterApproval(tx, authorizer, verifyPendingApproval, turnsReader.inTransaction(tx), args, stamp));
  }

  function decideApproval(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "approval id");
    if (!DECISION_SET.has(input.decision)) throw errInvalid("decision");
    return store.transaction((tx) =>
      runDecideApproval(tx, authorizer, verifyPendingApproval, turnsReader.inTransaction(tx), args, stamp));
  }

  function beginApprovalDispatch(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "approval id");
    return store.transaction((tx) =>
      runBeginApprovalDispatch(tx, authorizer, verifyPendingApproval, turnsReader.inTransaction(tx), args, stamp));
  }

  function settleApproval(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "approval id");
    if (!TERMINAL_STATES.includes(input.outcome)) throw errInvalid("outcome");
    return store.transaction((tx) =>
      runSettleApproval(tx, authorizer, turnsReader.inTransaction(tx), args, stamp));
  }

  function getApproval(args) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    validateUuid(input.operationId, "approval id");
    return store.transaction((tx) => runGetApproval(tx, turnsReader.inTransaction(tx), args));
  }

  function inTransaction(tx) {
    if (tx === null || typeof tx !== "object" || typeof tx.get !== "function" ||
        typeof tx.all !== "function" || typeof tx.run !== "function") {
      throw errInvalid("transaction");
    }
    let meta;
    try { meta = tx.get("SELECT instance_uuid FROM meta WHERE application_id = ?", ["cho.sessions.v1"]); }
    catch (error) { if (error && error.code) throw error; throw errStorage(); }
    if (!meta || meta.instance_uuid !== store.instanceId) throw errStorage();
    const turnsTx = turnsReader.inTransaction(tx);
    return Object.freeze({
      registerApproval: (args) => runRegisterApproval(tx, authorizer, verifyPendingApproval, turnsTx, args, resolveStamp(now)),
      decideApproval: (args) => runDecideApproval(tx, authorizer, verifyPendingApproval, turnsTx, args, resolveStamp(now)),
      beginApprovalDispatch: (args) => runBeginApprovalDispatch(tx, authorizer, verifyPendingApproval, turnsTx, args, resolveStamp(now)),
      settleApproval: (args) => runSettleApproval(tx, authorizer, turnsTx, args, resolveStamp(now)),
      getApproval: (args) => runGetApproval(tx, turnsTx, args),
    });
  }

  return Object.freeze({ registerApproval, decideApproval, beginApprovalDispatch, settleApproval, getApproval, inTransaction });
}
