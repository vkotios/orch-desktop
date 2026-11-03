// CHO-03 S2c turn intents and dispatch journal.
//
// Thin turn layer over the S1 session store (`session-store.mjs`) for
// conversations created by the S2a records API, fenced by the S2b producer
// fences, and bound by the S2b native refs. Each public data operation runs
// inside exactly one synchronous store.transaction with bound parameters;
// ownership checks, proof evaluation, and reads/mutations happen inside that
// same writer transaction via `session-producer-transaction.mjs`.
//
// Surface: createSessionTurns({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API { queueTurn, beginDispatch, recordWritten, recordObserved,
// settleTurn, getTurn, listTurns, inTransaction }. Importing this module opens
// no files and starts no providers; the caller owns store.close().
// `inTransaction(tx)` exposes the same data methods on a supplied ACTIVE
// scoped transaction for trusted internal composition (S3 will compose
// turn + event + projection + outcome in one outer transaction): each
// mutation still rechecks the current fence and proof, never a cached
// authorization. A tx from another store lineage (instance UUID mismatch)
// rejects with ERR_STORAGE.
//
// Model contract: controller/modelRequested/role are inferred from the
// conversation, never overridden per turn. Codex effort is per turn
// (undefined inherits the conversation effort); Claude effort is pinned to
// the conversation effort. A queued turn with dispatchState `dispatching`
// is NOT proven not-sent: intent stays `queued` until an actual write or
// observation fact lands. No auto binding, no turn start, no provider
// invocation/replay, no automatic crash reconciliation, no recovery APIs.
//
// Error-code mapping used here (mismatches the taxonomy deliberately
// nowhere): wrong op/turn state or a terminal target is ERR_TURN_STATE;
// missing or contradictory native correlation (absent required binding,
// absent required fact, wrong session/thread/turn/input, conflicting
// terminal outcome or id) is ERR_TURN_CONFLICT; a repeated begin is always
// ERR_DISPATCH_CONFLICT; mutated stored rows are ERR_STORAGE.
import { createHash } from "node:crypto";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_PROMPT_UNITS = 65536;
const MAX_PROMPT_BYTES = 32768;
const MAX_MODEL = 256;
const MAX_EFFORT = 64;
const MAX_NATIVE_ID = 512;
const MAX_HISTORY_BYTES = 8192;
const MAX_RESULT_BYTES = 2048;

const TURN_INTENT_V1 = "turn-intent-v1";

const TERMINAL_OUTCOMES = ["completed", "failed", "interrupted", "unknown"];
const NONTERMINAL_OP_STATES = ["queued", "dispatching", "written", "observed"];
const KNOWN_OP_STATES = [...NONTERMINAL_OP_STATES, ...TERMINAL_OUTCOMES];
const NONTERMINAL_INTENTS = ["queued", "written", "observed"];
const HISTORY_KINDS = ["queued", "dispatching", "written", "observed", "terminal"];

function turnError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const errInvalid = (detail) =>
  turnError("ERR_INVALID_RECORD", `session turn input is invalid (${detail})`);
const errNotFound = () => turnError("ERR_NOT_FOUND", "session turn not found");
const errIdempotency = () =>
  turnError("ERR_IDEMPOTENCY_CONFLICT", "session turn id already used with a different payload, owner, or kind");
const errRecord = () =>
  turnError("ERR_RECORD_CONFLICT", "session turn already exists");
const errDispatch = () =>
  turnError("ERR_DISPATCH_CONFLICT", "session turn dispatch already admitted");
const errTurnState = () =>
  turnError("ERR_TURN_STATE", "session turn state transition rejected");
const errTurnConflict = () =>
  turnError("ERR_TURN_CONFLICT", "session turn native correlation conflict");
const errFence = () =>
  turnError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const errVersion = () =>
  turnError("ERR_VERSION_LIMIT", "session turn sequence limit reached");
const errStorage = () =>
  turnError("ERR_STORAGE", "session turn stored data is unreadable");

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

// Inline prompt only: bounded UTF-16 length AND UTF-8 bytes, exact text,
// no truncation, no body-ref invention. Oversized payloads reject here
// until bounded body records land.
function validatePrompt(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PROMPT_UNITS ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw errInvalid("prompt");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw errInvalid("prompt bytes");
  }
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

// Null or a nonempty well-formed string within the UTF-16 budget.
function validateNullOrBoundedText(value, max, detail) {
  if (value === null) return;
  validateWellformedText(value, 1, max, detail);
}

// Opaque native ids (Codex thread/turn ids): exact, nonempty, bounded,
// well-formed. Never normalized; empty or padded values are shape errors.
function validateOpaqueId(value, detail) {
  validateWellformedText(value, 1, MAX_NATIVE_ID, detail);
}

function validateEffortValue(value) {
  validateNullOrBoundedText(value, MAX_EFFORT, "effort");
}

function validateOutcome(value) {
  if (!TERMINAL_OUTCOMES.includes(value)) {
    throw errInvalid("outcome");
  }
}

function validateLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw errInvalid("limit");
  }
}

function validateOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errInvalid("offset");
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

// nativeFact EXACT normalized shape: exactly { nativeIdentity, nativeTurnId,
// claudeInputUuid }. Codex: opaque identity + opaque turn id, null input
// UUID. Claude: session UUID identity, null turn id, input UUID. Shape and
// type errors are ERR_INVALID_RECORD; mismatches against stored/bound data
// are ERR_TURN_CONFLICT (checked by the caller, not here).
function validateNativeFactShape(fact, controller) {
  const f = requireArgs(fact);
  const keys = Object.keys(f).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "claudeInputUuid" ||
    keys[1] !== "nativeIdentity" ||
    keys[2] !== "nativeTurnId"
  ) {
    throw errInvalid("native fact");
  }
  if (controller === "codex") {
    validateOpaqueId(f.nativeIdentity, "native identity");
    validateOpaqueId(f.nativeTurnId, "native turn id");
    if (f.claudeInputUuid !== null) throw errInvalid("native fact");
  } else {
    validateUuid(f.nativeIdentity, "native identity");
    if (f.nativeTurnId !== null) throw errInvalid("native fact");
    validateUuid(f.claudeInputUuid, "native input id");
  }
  return f;
}

// Static SQL only: every dynamic value travels as a bound parameter,
// including LIMIT/OFFSET.
const SQL_CONVERSATION_FULL =
  "SELECT id, project_id, controller, model_requested, effort, role, requested_claude_session_uuid FROM conversations WHERE id = ? AND project_id = ?";
const SQL_OP_BY_ID =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE id = ?";
const SQL_TURN_BY_KEY =
  "SELECT id, conversation_id, seq, prompt_text, model_requested, effort, role, claude_input_uuid, intent_state, native_turn_id, outcome, created_at_ms FROM turns WHERE conversation_id = ? AND id = ?";
const SQL_OPS_BY_TURN =
  "SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms FROM operations WHERE conversation_id = ? AND turn_id = ?";
const SQL_REF_BY_CONVERSATION =
  "SELECT conversation_id, project_id, controller, native_thread_id, native_session_uuid FROM native_refs WHERE conversation_id = ?";
const SQL_TURN_BY_INPUT_UUID =
  "SELECT conversation_id, id FROM turns WHERE claude_input_uuid = ?";
const SQL_MAX_SEQ = "SELECT MAX(seq) AS max_seq FROM turns WHERE conversation_id = ?";
const SQL_INSERT_TURN =
  "INSERT INTO turns(id, conversation_id, seq, prompt_text, prompt_ref, model_requested, effort, role, claude_input_uuid, intent_state, native_turn_id, outcome, created_at_ms) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', NULL, NULL, ?)";
const SQL_INSERT_OP =
  "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'handoff', ?, ?, 'queued', ?, ?, ?, ?, NULL)";
const SQL_TOUCH_CONVERSATION = "UPDATE conversations SET updated_at_ms = ? WHERE id = ?";
const SQL_BEGIN_OP =
  "UPDATE operations SET state = 'dispatching', history_json = ? WHERE id = ? AND state = 'queued'";
const SQL_SET_OP_STATE =
  "UPDATE operations SET state = ?, history_json = ? WHERE id = ? AND state = ?";
const SQL_SET_OP_TERMINAL =
  "UPDATE operations SET state = ?, history_json = ?, result_json = ?, settled_at_ms = ? WHERE id = ? AND state IN ('queued', 'dispatching', 'written', 'observed')";
const SQL_SET_TURN_WRITTEN =
  "UPDATE turns SET intent_state = 'written' WHERE conversation_id = ? AND id = ? AND intent_state = 'queued'";
const SQL_SET_TURN_OBSERVED =
  "UPDATE turns SET intent_state = 'observed', native_turn_id = COALESCE(native_turn_id, ?) WHERE conversation_id = ? AND id = ? AND intent_state IN ('queued', 'written')";
const SQL_SET_TURN_TERMINAL =
  "UPDATE turns SET intent_state = ?, outcome = ?, native_turn_id = ? WHERE conversation_id = ? AND id = ? AND outcome IS NULL";
const SQL_LIST_TURNS =
  "SELECT id, conversation_id, seq, prompt_text, model_requested, effort, role, claude_input_uuid, intent_state, native_turn_id, outcome, created_at_ms FROM turns WHERE conversation_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?";

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
      validateWellformedText(row.model_requested, 1, MAX_MODEL, "stored model");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
  }
  if (row.effort !== null) {
    try {
      validateWellformedText(row.effort, 1, MAX_EFFORT, "stored effort");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
  }
  if (row.role !== "implement" && row.role !== "review") throw errStorage();
  const requested = row.requested_claude_session_uuid ?? null;
  if (requested !== null && (typeof requested !== "string" || !UUID_RE.test(requested))) {
    throw errStorage();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    controller: row.controller,
    modelRequested: row.model_requested ?? null,
    effort: row.effort ?? null,
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

// Journal history, parsed without echoing raw JSON diagnostics. Entries are
// bounded normalized facts { kind, atMs, ...correlation/outcome }: never
// raw provider payloads, evidence, or prompts. At most one entry per kind,
// at most 8KiB serialized. Malformed stored journals reject as ERR_STORAGE.
function parseHistoryJson(text) {
  // Cap bytes BEFORE parsing; raw diagnostics never escape.
  checkJsonCap(text, MAX_HISTORY_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw errStorage();
  }
  if (!Array.isArray(parsed) || parsed.length > HISTORY_KINDS.length) {
    throw errStorage();
  }
  const seen = new Set();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw errStorage();
    }
    if (!HISTORY_KINDS.includes(entry.kind)) throw errStorage();
    if (!Number.isSafeInteger(entry.atMs) || entry.atMs < 0) throw errStorage();
    if (seen.has(entry.kind)) throw errStorage();
    seen.add(entry.kind);
  }
  if (!seen.has("queued")) throw errStorage();
  // Causal order: queued is always first; dispatching precedes any
  // written/observed fact (observed-before-written is allowed); a terminal
  // fact, when present, is always last.
  if (parsed.length > 0 && parsed[0].kind !== "queued") throw errStorage();
  const position = new Map();
  parsed.forEach((entry, index) => position.set(entry.kind, index));
  for (const kind of ["written", "observed"]) {
    if (position.has(kind)) {
      if (!position.has("dispatching") || position.get("dispatching") > position.get(kind)) {
        throw errStorage();
      }
    }
  }
  if (position.has("terminal") && position.get("terminal") !== parsed.length - 1) {
    throw errStorage();
  }
  return parsed.map((entry) => ({ ...entry }));
}

// Terminal receipt: bounded normalized identity/terminal outcome, never a
// prompt or provider payload. Queue receipts carry the intent hash so an
// exact retry can prove identity without trusting caller memory.
function parseResultJson(text, { terminal, outcome, hash }) {
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
  if (terminal) {
    if (
      parsed.v !== 1 ||
      parsed.kind !== "terminal" ||
      parsed.outcome !== outcome ||
      parsed.hash !== hash
    ) {
      throw errStorage();
    }
  } else if (parsed.v !== 1 || parsed.kind !== "queue" || parsed.hash !== hash) {
    throw errStorage();
  }
  return { ...parsed };
}

function checkJsonCap(text, max) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > max) {
    throw errStorage();
  }
}

// Stable intent hash: the idempotency identity of one queue request. Any
// payload, owner, or kind difference is a different request.
function computeTurnHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function hashForRequest({ projectId, conversationId, turnId, prompt, conv, effort, claudeInputUuid, scope }) {
  return computeTurnHash([
    TURN_INTENT_V1,
    projectId,
    conversationId,
    turnId,
    prompt,
    conv.controller,
    conv.modelRequested,
    conv.role,
    effort,
    claudeInputUuid,
    scope.ownerToken,
    scope.ownerGeneration,
    scope.hostGeneration,
  ]);
}

// Codex effort is per turn (undefined inherits the conversation effort).
// Claude effort is pinned to the conversation effort: any override is an
// immutable-config conflict, not input.
function resolveEffort(conv, effortArg) {
  if (conv.controller === "codex") {
    if (effortArg === undefined) return conv.effort;
    if (effortArg === null) return null;
    validateEffortValue(effortArg);
    return effortArg;
  }
  if (effortArg !== undefined && effortArg !== conv.effort) {
    if (effortArg !== null) validateEffortValue(effortArg);
    throw errTurnConflict();
  }
  return conv.effort;
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

// Full turn record with every stored invariant checked: exactly one handoff
// operation pair, well-formed provenance, journal/result consistency, and
// op-state/turn-intent agreement. Reads never truncate prompt or history.
function buildTurnRecord(conv, turnRow, opRow) {
  if (!turnRow || typeof turnRow !== "object") throw errStorage();
  if (opRow.kind !== "handoff") throw errStorage();
  if (opRow.conversation_id !== turnRow.conversation_id || opRow.turn_id !== turnRow.id) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(opRow.owner_generation) || opRow.owner_generation < 1) {
    throw errStorage();
  }
  if (typeof opRow.host_generation !== "string" || !UUID_RE.test(opRow.host_generation)) {
    throw errStorage();
  }
  if (!KNOWN_OP_STATES.includes(opRow.state)) throw errStorage();
  if (typeof opRow.payload_hash !== "string" || opRow.payload_hash.length === 0) {
    throw errStorage();
  }
  if (!Number.isSafeInteger(opRow.created_at_ms) || opRow.created_at_ms < 0) {
    throw errStorage();
  }
  if (opRow.settled_at_ms !== null && (!Number.isSafeInteger(opRow.settled_at_ms) || opRow.settled_at_ms < 0)) {
    throw errStorage();
  }
  if (typeof turnRow.prompt_text !== "string") throw errStorage();
  if (!Number.isSafeInteger(turnRow.seq) || turnRow.seq < 1) throw errStorage();
  if (turnRow.model_requested !== conv.modelRequested) throw errStorage();
  if (turnRow.role !== conv.role) throw errStorage();
  if (turnRow.effort !== null) {
    try {
      validateWellformedText(turnRow.effort, 1, MAX_EFFORT, "stored effort");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
  }
  const claudeInput = turnRow.claude_input_uuid ?? null;
  if (conv.controller === "codex") {
    if (claudeInput !== null) throw errStorage();
  } else if (typeof claudeInput !== "string" || !UUID_RE.test(claudeInput)) {
    throw errStorage();
  }
  const nativeTurnId = turnRow.native_turn_id ?? null;
  if (nativeTurnId !== null) {
    try {
      validateOpaqueId(nativeTurnId, "stored native turn id");
    } catch (error) {
      if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
      throw error;
    }
    if (conv.controller === "claude") throw errStorage();
  }
  if (!Number.isSafeInteger(turnRow.created_at_ms) || turnRow.created_at_ms < 0) {
    throw errStorage();
  }
  const intent = turnRow.intent_state;
  const outcome = turnRow.outcome ?? null;
  if (outcome !== null && !TERMINAL_OUTCOMES.includes(outcome)) throw errStorage();
  if (outcome === null) {
    if (!NONTERMINAL_INTENTS.includes(intent)) throw errStorage();
  } else if (intent !== outcome) {
    throw errStorage();
  }
  // Op/turn agreement: dispatching keeps the intent queued until an actual
  // write or observation fact lands; terminal states always agree. A null
  // turn outcome requires a NONTERMINAL op state; a terminal op state with
  // a null turn outcome is corruption.
  const dispatchState = opRow.state;
  if (outcome === null) {
    if (!NONTERMINAL_OP_STATES.includes(dispatchState)) throw errStorage();
    if (dispatchState === "queued" || dispatchState === "dispatching") {
      if (intent !== "queued") throw errStorage();
    } else if (dispatchState === "written") {
      if (intent !== "written") throw errStorage();
    } else if (intent !== "observed") {
      throw errStorage();
    }
    if (opRow.settled_at_ms !== null) throw errStorage();
  } else {
    if (dispatchState !== outcome) throw errStorage();
    if (opRow.settled_at_ms === null) throw errStorage();
  }
  const history = parseHistoryJson(opRow.history_json);
  const hasTerminal = history.some((entry) => entry.kind === "terminal");
  if (hasTerminal !== (outcome !== null)) throw errStorage();
  if (hasTerminal) {
    const terminalEntry = history.find((entry) => entry.kind === "terminal");
    if (terminalEntry.outcome !== outcome) throw errStorage();
  }
  parseResultJson(opRow.result_json, {
    terminal: outcome !== null,
    outcome,
    hash: opRow.payload_hash,
  });
  checkJsonCap(opRow.history_json, MAX_HISTORY_BYTES);
  checkJsonCap(opRow.result_json, MAX_RESULT_BYTES);
  return {
    id: turnRow.id,
    conversationId: turnRow.conversation_id,
    operationId: opRow.id,
    seq: turnRow.seq,
    prompt: turnRow.prompt_text,
    controller: conv.controller,
    modelRequested: conv.modelRequested,
    role: conv.role,
    effort: turnRow.effort ?? null,
    claudeInputUuid: claudeInput,
    nativeTurnId,
    intentState: intent,
    outcome,
    dispatchState,
    ownerGeneration: opRow.owner_generation,
    hostGeneration: opRow.host_generation,
    createdAtMs: turnRow.created_at_ms,
    settledAtMs: opRow.settled_at_ms,
    history,
  };
}

// Load the exact paired turn + handoff operation for a mutation or read.
// An unknown operation id is ERR_NOT_FOUND; a known id bound to another
// conversation, turn, or kind is ERR_IDEMPOTENCY_CONFLICT (no cross-chat
// or cross-kind reuse, matching the S2a receipt rule). Exactly one handoff
// pair must exist per turn: non-handoff siblings (stop/approval/
// clarification answers) are ignored, but zero or multiple handoff rows are
// ERR_STORAGE. A second handoff pair is never silently ignored in favor of
// the provided op id.
function loadPair(tx, conv, turnId, operationId) {
  const opRow = tx.get(SQL_OP_BY_ID, [operationId]);
  if (!opRow) throw errNotFound();
  if (
    opRow.kind !== "handoff" ||
    opRow.conversation_id !== conv.id ||
    opRow.turn_id !== turnId
  ) {
    throw errIdempotency();
  }
  const turnRow = tx.get(SQL_TURN_BY_KEY, [conv.id, turnId]);
  if (!turnRow) throw errStorage();
  const siblings = tx.all(SQL_OPS_BY_TURN, [conv.id, turnId]);
  if (siblings.filter((row) => row.kind === "handoff").length !== 1) {
    throw errStorage();
  }
  return { turnRow, opRow, record: buildTurnRecord(conv, turnRow, opRow) };
}

// The stored paired op carries the owning provenance: every mutation after
// queue requires it to match the requested scope exactly. A new owner
// cannot update or resend an old owner's pending turn through these APIs
// (explicit recovery is S5, never automatic adoption).
function requireOpProvenance(opRow, scope) {
  if (
    opRow.owner_generation !== scope.ownerGeneration ||
    opRow.host_generation !== scope.hostGeneration
  ) {
    throw errFence();
  }
}

// Validate a supplied native fact against the bound identity and the stored
// turn correlation. Returns the Codex native turn id to persist (null keeps
// the stored value). Contradictions are ERR_TURN_CONFLICT, never repairs.
function checkFactConsistent(conv, turnRow, ref, fact) {
  if (conv.controller === "codex") {
    if (!ref) throw errTurnConflict();
    if (fact.nativeIdentity !== ref.nativeThreadId) throw errTurnConflict();
    const stored = turnRow.native_turn_id ?? null;
    if (stored !== null && fact.nativeTurnId !== stored) throw errTurnConflict();
    return stored === null ? fact.nativeTurnId : null;
  }
  // Every Claude native fact must match the persisted validated observed
  // native ref. The prelaunch requested UUID alone is sufficient ONLY for
  // recordWritten (which takes no fact); observed/settle facts never fall
  // back to it.
  if (!ref) throw errTurnConflict();
  const expected = ref.nativeSessionUuid;
  if (fact.nativeIdentity !== expected) throw errTurnConflict();
  if (fact.claudeInputUuid !== (turnRow.claude_input_uuid ?? null)) {
    throw errTurnConflict();
  }
  return null;
}

// The stored terminal receipt's correlation tuple. Exactly the three
// normalized fact fields; all null only for a factless failed/unknown
// receipt, otherwise controller-valid. Missing keys or malformed values are
// stored corruption, never a match.
function readTerminalReceipt(opRow, conv, outcome) {
  const receipt = parseResultJson(opRow.result_json, {
    terminal: true,
    outcome,
    hash: opRow.payload_hash,
  });
  for (const key of ["nativeIdentity", "nativeTurnId", "claudeInputUuid"]) {
    if (!(key in receipt)) throw errStorage();
  }
  const { nativeIdentity, nativeTurnId, claudeInputUuid } = receipt;
  if (nativeIdentity === null && nativeTurnId === null && claudeInputUuid === null) {
    return receipt;
  }
  try {
    if (conv.controller === "codex") {
      validateOpaqueId(nativeIdentity, "stored native identity");
      validateOpaqueId(nativeTurnId, "stored native turn id");
      if (claudeInputUuid !== null) throw errStorage();
    } else {
      validateUuid(nativeIdentity, "stored native identity");
      if (nativeTurnId !== null) throw errStorage();
      validateUuid(claudeInputUuid, "stored native input id");
    }
  } catch (error) {
    if (error?.code === "ERR_INVALID_RECORD") throw errStorage();
    throw error;
  }
  return receipt;
}

// Persist one turn intent plus its paired handoff operation, atomically.
// Idempotent on the exact request (same op id, payload, owner, kind):
// returns { created: false } with the CURRENT record and no writes.
function runQueueTurn(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  validatePrompt(input.prompt);
  const hasEffortArg = Object.hasOwn(input, "effort");
  const effortArg = hasEffortArg ? input.effort : undefined;
  if (effortArg !== undefined && effortArg !== null) validateEffortValue(effortArg);
  const claudeInputUuid = input.claudeInputUuid ?? null;
  if (claudeInputUuid !== null) validateUuid(claudeInputUuid, "native input id");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  if (conv.controller === "codex") {
    if (claudeInputUuid !== null) throw errInvalid("native input id");
  } else if (claudeInputUuid === null) {
    throw errInvalid("native input id");
  }
  const effort = resolveEffort(conv, effortArg);
  authorizer.authorizeLiveWrite(tx, scope);
  const hash = hashForRequest({
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    turnId: input.turnId,
    prompt: input.prompt,
    conv,
    effort,
    claudeInputUuid,
    scope,
  });
  const prior = tx.get(SQL_OP_BY_ID, [input.operationId]);
  if (prior) {
    if (
      prior.kind === "handoff" &&
      prior.conversation_id === scope.conversationId &&
      prior.turn_id === input.turnId &&
      prior.payload_hash === hash &&
      prior.owner_generation === scope.ownerGeneration &&
      prior.host_generation === scope.hostGeneration
    ) {
      const loaded = loadPair(tx, conv, input.turnId, input.operationId);
      return { created: false, turn: loaded.record };
    }
    throw errIdempotency();
  }
  if (tx.get(SQL_TURN_BY_KEY, [scope.conversationId, input.turnId])) {
    throw errRecord();
  }
  if (claudeInputUuid !== null) {
    if (tx.get(SQL_TURN_BY_INPUT_UUID, [claudeInputUuid])) {
      throw errTurnConflict();
    }
  }
  // No native ref is required yet: the first native creation happens AFTER
  // the persisted intent. A present ref must still be valid, else corruption.
  readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  const maxRow = tx.get(SQL_MAX_SEQ, [scope.conversationId]);
  const maxSeq = maxRow ? maxRow.max_seq : null;
  let seq;
  if (maxSeq === null || maxSeq === undefined) {
    seq = 1;
  } else {
    if (!Number.isSafeInteger(maxSeq) || maxSeq < 0) throw errStorage();
    seq = maxSeq + 1;
    if (!Number.isSafeInteger(seq)) throw errVersion();
  }
  const historyText = JSON.stringify([{ kind: "queued", atMs: stamp }]);
  checkJsonCap(historyText, MAX_HISTORY_BYTES);
  const resultText = JSON.stringify({ v: 1, kind: "queue", hash });
  checkJsonCap(resultText, MAX_RESULT_BYTES);
  tx.run(SQL_INSERT_TURN, [
    input.turnId,
    scope.conversationId,
    seq,
    input.prompt,
    conv.modelRequested,
    effort,
    conv.role,
    claudeInputUuid,
    stamp,
  ]);
  tx.run(SQL_INSERT_OP, [
    input.operationId,
    scope.conversationId,
    input.turnId,
    scope.ownerGeneration,
    scope.hostGeneration,
    historyText,
    hash,
    resultText,
    stamp,
  ]);
  tx.run(SQL_TOUCH_CONVERSATION, [stamp, scope.conversationId]);
  // Both rows commit together; the receipt is only handed out after commit.
  const loaded = loadPair(tx, conv, input.turnId, input.operationId);
  return { created: true, turn: loaded.record };
}

// Admit one dispatch: CAS the paired op queued -> dispatching BEFORE any
// future provider effect (thread/start, process launch, user write). The
// turn intent stays queued until an actual write or observation fact lands,
// so a dispatching row is never proof of not-sent. Repeated begin always
// rejects ERR_DISPATCH_CONFLICT, never permission to send again.
function runBeginDispatch(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const loaded = loadPair(tx, conv, input.turnId, input.operationId);
  requireOpProvenance(loaded.opRow, scope);
  // Surface a malformed stored binding before admitting any effect.
  readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  // A repeated begin is always ERR_DISPATCH_CONFLICT, including after a
  // terminal outcome; it is never permission to send again.
  if (loaded.opRow.state !== "queued") throw errDispatch();
  if (loaded.record.outcome !== null) throw errTurnState();
  const history = parseHistoryJson(loaded.opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "dispatching", atMs: stamp });
  const updated = tx.run(SQL_BEGIN_OP, [appended.text, input.operationId]);
  if (Number(updated.changes) !== 1) throw errDispatch();
  return loadPair(tx, conv, input.turnId, input.operationId).record;
}

// Actual host-transport write fact, NOT an ACK or completion. Allowed only
// after beginDispatch. Codex requires the validated bound thread ref (S3
// commits it before turn/start). Claude requires the prelaunch requested
// UUID; the observed native ref may still be absent because stream init can
// arrive after the user write, so no association is fabricated here.
// dispatching -> written; a queued turn moves queued -> written, but an
// already-observed turn never regresses. Idempotent: no history growth.
function runRecordWritten(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  authorizer.authorizeLiveWrite(tx, scope);
  const loaded = loadPair(tx, conv, input.turnId, input.operationId);
  requireOpProvenance(loaded.opRow, scope);
  if (loaded.record.outcome !== null) throw errTurnState();
  if (
    loaded.opRow.state !== "dispatching" &&
    loaded.opRow.state !== "written" &&
    loaded.opRow.state !== "observed"
  ) {
    throw errTurnState();
  }
  if (conv.controller === "codex") {
    if (!readNativeRef(tx, scope.projectId, scope.conversationId, conv)) {
      throw errTurnConflict();
    }
  } else {
    // recordWritten alone may rely on the prelaunch requested UUID while
    // the observed ref is still absent; a malformed stored binding still
    // fails ERR_STORAGE before any effect.
    readNativeRef(tx, scope.projectId, scope.conversationId, conv);
    if (conv.requestedClaudeSessionUuid === null) {
      throw errTurnConflict();
    }
  }
  const history = parseHistoryJson(loaded.opRow.history_json);
  const appended = appendHistoryFact(history, { kind: "written", atMs: stamp });
  if (loaded.opRow.state === "dispatching") {
    const updated = tx.run(SQL_SET_OP_STATE, [
      "written",
      appended.text,
      input.operationId,
      "dispatching",
    ]);
    if (Number(updated.changes) !== 1) throw errTurnState();
  } else if (appended.changed) {
    const updated = tx.run(SQL_SET_OP_STATE, [
      loaded.opRow.state,
      appended.text,
      input.operationId,
      loaded.opRow.state,
    ]);
    if (Number(updated.changes) !== 1) throw errTurnState();
  }
  if (loaded.record.intentState === "queued") {
    const moved = tx.run(SQL_SET_TURN_WRITTEN, [scope.conversationId, input.turnId]);
    if (Number(moved.changes) !== 1) throw errTurnState();
  }
  return loadPair(tx, conv, input.turnId, input.operationId).record;
}

// Observation of the controller's own identity for a dispatched turn.
// Codex binds its opaque native turn id once (later differences reject);
// Claude carries no invented turn id and must match the stored input UUID.
// dispatching -> observed is allowed (observation may arrive before the
// local written callback). Idempotent on the same fact; no backward state;
// terminal turns reject (settle replays carry terminal facts instead).
function runRecordObserved(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  if (input.nativeFact === undefined) throw errInvalid("native fact");
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  const fact = validateNativeFactShape(input.nativeFact, conv.controller);
  authorizer.authorizeLiveWrite(tx, scope);
  const loaded = loadPair(tx, conv, input.turnId, input.operationId);
  requireOpProvenance(loaded.opRow, scope);
  if (loaded.record.outcome !== null) throw errTurnState();
  if (
    loaded.opRow.state !== "dispatching" &&
    loaded.opRow.state !== "written" &&
    loaded.opRow.state !== "observed"
  ) {
    throw errTurnState();
  }
  const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
  if (!ref) throw errTurnConflict();
  const bindTurnId = checkFactConsistent(conv, loaded.turnRow, ref, fact);
  const history = parseHistoryJson(loaded.opRow.history_json);
  const appended = appendHistoryFact(history, {
    kind: "observed",
    atMs: stamp,
    nativeIdentity: fact.nativeIdentity,
    nativeTurnId: fact.nativeTurnId,
    claudeInputUuid: fact.claudeInputUuid,
  });
  if (loaded.opRow.state !== "observed" || appended.changed) {
    const updated = tx.run(SQL_SET_OP_STATE, [
      "observed",
      appended.text,
      input.operationId,
      loaded.opRow.state,
    ]);
    if (Number(updated.changes) !== 1) throw errTurnState();
  }
  if (loaded.record.intentState !== "observed") {
    const moved = tx.run(SQL_SET_TURN_OBSERVED, [
      bindTurnId,
      scope.conversationId,
      input.turnId,
    ]);
    if (Number(moved.changes) !== 1) throw errTurnState();
  }
  return loadPair(tx, conv, input.turnId, input.operationId).record;
}

// Terminal outcome for a turn. Completed/interrupted require a normalized
// native fact matching the validated bound identity and correlation, from
// any dispatched-or-later op state (an outcome may arrive before the
// separate observed callback). Failed while queued may omit the fact
// (pre-dispatch failure); after dispatch began, failed also requires one,
// otherwise the host must use unknown (no inference that a transport
// failure means not-executed). Unknown may omit the fact from any
// nonterminal state and never requeues. An exact terminal retry returns the
// unchanged record; a different terminal outcome or id conflicts. Unknown
// stays terminal: no terminal -> active transition exists.
function runSettleTurn(tx, authorizer, args, stamp) {
  const input = requireArgs(args);
  const scope = validateScopeShape(input);
  validateUuid(input.turnId, "turn id");
  validateUuid(input.operationId, "operation id");
  validateOutcome(input.outcome);
  const hasFact = input.nativeFact !== undefined && input.nativeFact !== null;
  const conv = readConversation(tx, scope.projectId, scope.conversationId);
  const fact = hasFact ? validateNativeFactShape(input.nativeFact, conv.controller) : null;
  authorizer.authorizeLiveWrite(tx, scope);
  const loaded = loadPair(tx, conv, input.turnId, input.operationId);
  requireOpProvenance(loaded.opRow, scope);
  if (loaded.record.outcome !== null) {
    // Exact terminal retry: same outcome AND same correlation tuple as the
    // stored terminal receipt (null matches null only; a supplied fact
    // compares all three normalized fields). A missing or different
    // original fact rejects; a new fact is never compatible with a factless
    // original receipt. Completed/interrupted retries always need a fact;
    // a factless failed/unknown original replays factless only.
    if (input.outcome !== loaded.record.outcome) throw errTurnConflict();
    const stored = readTerminalReceipt(loaded.opRow, conv, loaded.record.outcome);
    if (!fact) {
      if (input.outcome === "completed" || input.outcome === "interrupted") {
        throw errTurnConflict();
      }
      if (
        stored.nativeIdentity !== null ||
        stored.nativeTurnId !== null ||
        stored.claudeInputUuid !== null
      ) {
        throw errTurnConflict();
      }
      return loadPair(tx, conv, input.turnId, input.operationId).record;
    }
    if (
      fact.nativeIdentity !== stored.nativeIdentity ||
      fact.nativeTurnId !== stored.nativeTurnId ||
      fact.claudeInputUuid !== stored.claudeInputUuid
    ) {
      throw errTurnConflict();
    }
    const replayRef = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
    if (!replayRef) throw errTurnConflict();
    checkFactConsistent(conv, loaded.turnRow, replayRef, fact);
    return loadPair(tx, conv, input.turnId, input.operationId).record;
  }
  const opState = loaded.opRow.state;
  const needsFact =
    input.outcome === "completed" ||
    input.outcome === "interrupted" ||
    (input.outcome === "failed" && opState !== "queued");
  if ((input.outcome === "completed" || input.outcome === "interrupted") && opState === "queued") {
    throw errTurnState();
  }
  if (needsFact && !fact) throw errTurnConflict();
  let bindTurnId = null;
  if (fact) {
    // Settle facts must match the persisted validated observed ref; the
    // prelaunch requested UUID alone never suffices here.
    const ref = readNativeRef(tx, scope.projectId, scope.conversationId, conv);
    if (!ref) throw errTurnConflict();
    bindTurnId = checkFactConsistent(conv, loaded.turnRow, ref, fact);
  }
  const nativeTurnId =
    conv.controller === "codex"
      ? (bindTurnId ?? loaded.turnRow.native_turn_id ?? null)
      : null;
  const receipt = {
    v: 1,
    kind: "terminal",
    outcome: input.outcome,
    hash: loaded.opRow.payload_hash,
    nativeIdentity: fact ? fact.nativeIdentity : null,
    nativeTurnId: fact ? fact.nativeTurnId : null,
    claudeInputUuid: fact ? fact.claudeInputUuid : null,
  };
  const receiptText = JSON.stringify(receipt);
  checkJsonCap(receiptText, MAX_RESULT_BYTES);
  const history = parseHistoryJson(loaded.opRow.history_json);
  const appended = appendHistoryFact(history, {
    kind: "terminal",
    atMs: stamp,
    outcome: input.outcome,
    nativeIdentity: fact ? fact.nativeIdentity : null,
    nativeTurnId: fact ? fact.nativeTurnId : null,
    claudeInputUuid: fact ? fact.claudeInputUuid : null,
  });
  const movedTurn = tx.run(SQL_SET_TURN_TERMINAL, [
    input.outcome,
    input.outcome,
    nativeTurnId,
    scope.conversationId,
    input.turnId,
  ]);
  if (Number(movedTurn.changes) !== 1) throw errTurnState();
  const movedOp = tx.run(SQL_SET_OP_TERMINAL, [
    input.outcome,
    appended.text,
    receiptText,
    stamp,
    input.operationId,
  ]);
  if (Number(movedOp.changes) !== 1) throw errTurnState();
  return loadPair(tx, conv, input.turnId, input.operationId).record;
}

// Historical reads need no live proof: a released owner stays readable.
// A missing turn is null (after the project/chat check); a present turn
// with a missing, multiple, or malformed handoff pair is ERR_STORAGE.
function runGetTurn(tx, args) {
  const input = requireArgs(args);
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  validateUuid(input.turnId, "turn id");
  const conv = readConversation(tx, input.projectId, input.conversationId);
  const turnRow = tx.get(SQL_TURN_BY_KEY, [input.conversationId, input.turnId]);
  if (!turnRow) return null;
  // Exactly one handoff operation pairs the turn; other operation kinds on
  // the same turn (stop/approval/clarification answers) are preserved and
  // ignored here, never counted against the pair.
  const opRows = tx.all(SQL_OPS_BY_TURN, [input.conversationId, input.turnId]);
  const handoffs = opRows.filter((row) => row.kind === "handoff");
  if (handoffs.length !== 1) throw errStorage();
  return buildTurnRecord(conv, turnRow, handoffs[0]);
}

function toTurnMetadata(record) {
  const metadata = { ...record };
  delete metadata.prompt;
  delete metadata.history;
  return metadata;
}

// Metadata only (no prompt, no history), ordered by seq ascending.
function runListTurns(tx, args) {
  const input = requireArgs(args ?? {});
  validateUuid(input.projectId, "project id");
  validateUuid(input.conversationId, "conversation id");
  // Defaults apply only when the key is absent (undefined); an explicit
  // null is an invalid record, never a default.
  const limit = input.limit === undefined ? 50 : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  validateLimit(limit);
  validateOffset(offset);
  const conv = readConversation(tx, input.projectId, input.conversationId);
  const rows = tx.all(SQL_LIST_TURNS, [input.conversationId, limit, offset]);
  return rows.map((turnRow) => {
    const opRows = tx.all(SQL_OPS_BY_TURN, [input.conversationId, turnRow.id]);
    const handoffs = opRows.filter((row) => row.kind === "handoff");
    if (handoffs.length !== 1) throw errStorage();
    return toTurnMetadata(buildTurnRecord(conv, turnRow, handoffs[0]));
  });
}

export function createSessionTurns(options) {
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

  // Wrapper methods pre-validate input shapes (matching the S2a convention)
  // so malformed calls fail before touching the store; the transaction body
  // re-validates for the inTransaction path.
  function queueTurn(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    validatePrompt(input.prompt);
    return store.transaction((tx) => runQueueTurn(tx, authorizer, args, stamp));
  }

  function beginDispatch(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    return store.transaction((tx) => runBeginDispatch(tx, authorizer, args, stamp));
  }

  function recordWritten(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    return store.transaction((tx) => runRecordWritten(tx, authorizer, args, stamp));
  }

  function recordObserved(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    return store.transaction((tx) => runRecordObserved(tx, authorizer, args, stamp));
  }

  function settleTurn(args) {
    const stamp = resolveStamp(now);
    const input = requireArgs(args);
    validateScopeShape(input);
    validateUuid(input.turnId, "turn id");
    validateUuid(input.operationId, "operation id");
    validateOutcome(input.outcome);
    return store.transaction((tx) => runSettleTurn(tx, authorizer, args, stamp));
  }

  function getTurn(args) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    validateUuid(input.turnId, "turn id");
    return store.transaction((tx) => runGetTurn(tx, args));
  }

  function listTurns(args = {}) {
    const input = requireArgs(args);
    validateUuid(input.projectId, "project id");
    validateUuid(input.conversationId, "conversation id");
    return store.transaction((tx) => runListTurns(tx, args));
  }

  // Trusted internal composition on a supplied ACTIVE scoped transaction:
  // no nested store.transaction, so an S3 outer turn+event+projection write
  // rolls back together. Lineage is proven by the meta instance UUID; a tx
  // from another store rejects with ERR_STORAGE. Every mutation still
  // rechecks the current fence and proof through the same tx.
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
      queueTurn: (args) => runQueueTurn(tx, authorizer, args, resolveStamp(now)),
      beginDispatch: (args) =>
        runBeginDispatch(tx, authorizer, args, resolveStamp(now)),
      recordWritten: (args) =>
        runRecordWritten(tx, authorizer, args, resolveStamp(now)),
      recordObserved: (args) =>
        runRecordObserved(tx, authorizer, args, resolveStamp(now)),
      settleTurn: (args) => runSettleTurn(tx, authorizer, args, resolveStamp(now)),
      getTurn: (args) => runGetTurn(tx, args),
      listTurns: (args) => runListTurns(tx, args),
    });
  }

  return Object.freeze({
    queueTurn,
    beginDispatch,
    recordWritten,
    recordObserved,
    settleTurn,
    getTurn,
    listTurns,
    inTransaction,
  });
}
