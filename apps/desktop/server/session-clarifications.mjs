// CHO-03 durable clarification question journal and answer-attempt operations.
//
// Thin clarification layer over the S1 session store for turns created by the
// S2c turns API and fenced by the S2b producer fences. Persists unconsumed
// clarification questions and explicit answer attempts BEFORE any native
// response effect, without sending responses, retrying providers, or touching
// turns/native_refs/fences. Each public data operation runs inside exactly one
// synchronous store.transaction; ownership checks, proof evaluation, and
// reads/mutations happen inside that same writer transaction via
// createProducerAuthorizer.
//
// Surface: createSessionClarifications({ store, verifyOwnerEvidence,
// verifyPendingQuestion, now = Date.now }) -> frozen API { registerClarification,
// queueAnswer, beginAnswerDispatch, settleAnswer, retireClarification,
// getClarification, getAnswerAttempt, listAnswerAttempts, inTransaction }.
//
// Routes: codex_async (no native request ID), codex_request, claude_request.
// Question statuses: pending, invalid, answered, unactionable.
// Attempt states: queued, dispatching (nonterminal); written, acknowledged,
// not_sent, invalid, unknown, unactionable (terminal).
// The decision column on operations carries the clarificationId (logical
// question link), NOT a permission decision.

import { createHash } from "node:crypto";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";
import { createSessionTurns } from "./session-turns.mjs";
import {
  parseCodexClarification,
  parseCodexAsyncClarification,
  parseClaudeClarification,
  encodeCodexClarificationAnswer,
  encodeCodexAsyncClarificationAnswer,
  encodeClaudeClarificationAnswer,
} from "./native-clarification.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_NATIVE_ID = 512;
const MAX_Q_ID = 2048;
const MAX_A_KEY = 2048;
const MAX_A_STR = 4096;
const MAX_A_ARR = 8;
const MAX_A_KEYS = 4;
const MAX_A_AGG = 16384;
const MAX_A_JSON = 65536;
const MAX_Q_JSON = 65536;
const MAX_RES_JSON = 98304;
const MAX_HIST = 4096;
const CLAR_V1 = "clarification-v1";
const ANS_V1 = "clarification-answer-v1";
const ROUTES = new Set(["codex_async", "codex_request", "claude_request"]);
const Q_STATUS = new Set(["pending", "invalid", "answered", "unactionable"]);
const AT_NONTERM = new Set(["queued", "dispatching"]);
const AT_TERM = new Set(["written", "acknowledged", "not_sent", "invalid", "unknown", "unactionable"]);
const AT_STATES = new Set([...AT_NONTERM, ...AT_TERM]);
const OUTCOMES = new Set(["written", "acknowledged", "not_sent", "invalid", "unknown", "unactionable"]);
const COLLISION_LIMIT = 64;
const LIST_MAX = 50;

function cErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
const eInv = (d) => cErr("ERR_INVALID_RECORD", `session clarification input is invalid (${d})`);
const eNF = () => cErr("ERR_NOT_FOUND", "session clarification not found");
const eFence = () => cErr("ERR_FENCE_CONFLICT", "session producer fence conflict");
const eIdem = () => cErr("ERR_IDEMPOTENCY_CONFLICT", "session clarification id already used with a different payload, owner, or kind");
const eQUnv = () => cErr("ERR_QUESTION_UNVERIFIED", "session clarification pending state is not verified");
const eCC = () => cErr("ERR_CLARIFICATION_CONFLICT", "session clarification request conflict");
const eCS = () => cErr("ERR_CLARIFICATION_STATE", "session clarification state transition rejected");
const eAC = () => cErr("ERR_ANSWER_CONFLICT", "session answer attempt conflict");
const eAS = () => cErr("ERR_ANSWER_STATE", "session answer attempt state transition rejected");
const eDisp = () => cErr("ERR_DISPATCH_CONFLICT", "session answer dispatch already admitted");
const eSto = () => cErr("ERR_STORAGE", "session clarification stored data is unreadable");

function reqObj(v) { if (v === null || typeof v !== "object" || Array.isArray(v)) throw eInv("arguments"); return v; }

function loneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) { const n = s.charCodeAt(i + 1); if (!(n >= 0xdc00 && n <= 0xdfff)) return true; i++; }
    else if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

function vUuid(v, d) { if (typeof v !== "string" || !UUID_RE.test(v)) throw eInv(d); }
function vText(v, min, max, d) { if (typeof v !== "string" || v.length < min || v.length > max || v.includes("\0") || loneSurrogate(v)) throw eInv(d); }
function vOpaque(v, d) { vText(v, 1, MAX_NATIVE_ID, d); }

function vNativeReqId(v, route) {
  if (route === "codex_async") { if (v !== null && v !== undefined) throw eInv("native request id must be null for async"); return { text: null, type: null }; }
  if (typeof v === "number") { if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw eInv("native request id"); return { text: JSON.stringify(v), type: "number" }; }
  if (typeof v === "string") { vText(v, 1, MAX_NATIVE_ID, "native request id"); return { text: JSON.stringify(v), type: "string" }; }
  throw eInv("native request id");
}

function vScope(s) {
  const o = reqObj(s);
  vUuid(o.projectId, "project id"); vUuid(o.conversationId, "conversation id");
  vUuid(o.ownerToken, "owner token");
  if (!Number.isSafeInteger(o.ownerGeneration) || o.ownerGeneration < 1) throw eInv("owner generation");
  vUuid(o.hostGeneration, "host generation");
  return o;
}

function stamp(now) { let t; try { t = now(); } catch { throw eInv("clock"); } if (!Number.isSafeInteger(t) || t < 0) throw eInv("clock"); return t; }
function cap(t, m) { if (typeof t !== "string" || Buffer.byteLength(t, "utf8") > m) throw eSto(); }
function setOwn(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }

// --- SQL ---
const S_CONV = "SELECT id,project_id,controller,requested_claude_session_uuid FROM conversations WHERE id=? AND project_id=?";
const S_REF = "SELECT conversation_id,project_id,controller,native_thread_id,native_session_uuid FROM native_refs WHERE conversation_id=?";
const S_CLAR = "SELECT id,turn_id,conversation_id,native_question_id,question_json,status,answer_json,answered_at_ms FROM clarifications WHERE id=?";
const S_CLAR_COLL = "SELECT id,status,question_json FROM clarifications WHERE native_question_id=? AND status IN ('pending','invalid') LIMIT 65";
const S_CLAR_UNK = "SELECT o.id FROM operations o JOIN clarifications c ON o.decision=c.id WHERE o.kind='clarification_answer' AND o.state='unknown' AND o.host_generation=? AND c.native_question_id=? LIMIT 1";
const S_INS_CLAR = "INSERT INTO clarifications(id,turn_id,conversation_id,native_question_id,question_json,status,answer_json,answered_at_ms) VALUES(?,?,?,?,?, 'pending',NULL,NULL)";
const S_UPD_CLAR = "UPDATE clarifications SET status=?,answer_json=?,answered_at_ms=? WHERE id=? AND status=?";
const S_UPD_RETIRE = "UPDATE clarifications SET status='unactionable' WHERE id=? AND status IN ('pending','invalid')";
const S_OP = "SELECT id,conversation_id,turn_id,kind,owner_generation,host_generation,decision,native_request_id_text,native_request_id_type,state,history_json,payload_hash,result_json,created_at_ms,settled_at_ms FROM operations WHERE id=?";
const S_ACTIVE = "SELECT id FROM operations WHERE kind='clarification_answer' AND decision=? AND state IN ('queued','dispatching') LIMIT 2";
const S_INS_OP = "INSERT INTO operations(id,conversation_id,turn_id,kind,owner_generation,host_generation,decision,native_request_id_text,native_request_id_type,state,history_json,payload_hash,result_json,created_at_ms,settled_at_ms) VALUES(?,?,?, 'clarification_answer',?,?,?,?,?,?,?,?,?,?,?)";
const S_CAS_BEG = "UPDATE operations SET state='dispatching',history_json=?,result_json=? WHERE id=? AND state='queued'";
const S_CAS_TERM = "UPDATE operations SET state=?,history_json=?,result_json=?,settled_at_ms=? WHERE id=? AND state=?";
const S_LIST = "SELECT id,state,created_at_ms,settled_at_ms FROM operations WHERE kind='clarification_answer' AND decision=? AND (created_at_ms>? OR (created_at_ms=? AND id>?)) ORDER BY created_at_ms ASC,id ASC LIMIT ?";
const S_LIST0 = "SELECT id,state,created_at_ms,settled_at_ms FROM operations WHERE kind='clarification_answer' AND decision=? ORDER BY created_at_ms ASC,id ASC LIMIT ?";

// --- Read helpers ---
function readConv(tx, pid, cid) {
  const r = tx.get(S_CONV, [cid, pid]);
  if (!r) throw eNF();
  if (r.controller !== "codex" && r.controller !== "claude") throw eSto();
  const rq = r.requested_claude_session_uuid ?? null;
  if (rq !== null && (typeof rq !== "string" || !UUID_RE.test(rq))) throw eSto();
  return { id: r.id, projectId: r.project_id, controller: r.controller, requestedClaudeSessionUuid: rq };
}

function readRef(tx, pid, cid, conv) {
  const rows = tx.all(S_REF, [cid]);
  if (rows.length > 1) throw eSto();
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r.project_id !== pid) throw eSto();
  if (r.controller !== conv.controller) throw eSto();
  if (conv.controller === "codex") {
    try { vOpaque(r.native_thread_id, "stored thread id"); } catch (e) { if (e?.code === "ERR_INVALID_RECORD") throw eSto(); throw e; }
    if (r.native_session_uuid !== null) throw eSto();
    return { controller: "codex", nativeThreadId: r.native_thread_id, nativeSessionUuid: null };
  }
  if (typeof r.native_session_uuid !== "string" || !UUID_RE.test(r.native_session_uuid)) throw eSto();
  if (r.native_thread_id !== null) throw eSto();
  if (conv.requestedClaudeSessionUuid !== r.native_session_uuid) throw eSto();
  return { controller: "claude", nativeThreadId: null, nativeSessionUuid: r.native_session_uuid };
}

function reqHandoff(tr, scope) {
  if (tr.ownerGeneration !== scope.ownerGeneration || tr.hostGeneration !== scope.hostGeneration) throw eFence();
}

// --- Request derivation ---
function deriveReq(route, conv, tr, ref, itemId, reqId, connId) {
  if (conv.controller === "codex") {
    if (tr.nativeTurnId === null) throw eCS();
    if (!ref) throw eCS();
    return Object.freeze({ route, controller: "codex", connectionId: connId, nativeIdentity: ref.nativeThreadId, nativeTurnId: tr.nativeTurnId, claudeInputUuid: null, nativeItemId: itemId, nativeRequestId: reqId });
  }
  if (tr.claudeInputUuid === null) throw eSto();
  if (conv.requestedClaudeSessionUuid === null) throw eCS();
  const id = ref ? ref.nativeSessionUuid : conv.requestedClaudeSessionUuid;
  if (ref && ref.nativeSessionUuid !== conv.requestedClaudeSessionUuid) throw eSto();
  return Object.freeze({ route, controller: "claude", connectionId: connId, nativeIdentity: id, nativeTurnId: null, claudeInputUuid: tr.claudeInputUuid, nativeItemId: itemId, nativeRequestId: reqId });
}

function reqEq(a, b) {
  if (a === null || b === null) return a === b;
  return a.route === b.route && a.controller === b.controller && a.connectionId === b.connectionId &&
    a.nativeIdentity === b.nativeIdentity && a.nativeTurnId === b.nativeTurnId &&
    a.claudeInputUuid === b.claudeInputUuid && a.nativeItemId === b.nativeItemId && a.nativeRequestId === b.nativeRequestId;
}

function verifyNativeCorrelation(conv, tr, ref, request, { requireNonterminalParent = false } = {}) {
  if (request.controller !== conv.controller) throw eAC();
  if (!ref) throw eCS();
  if (requireNonterminalParent) {
    if (tr.intentState !== "observed") throw eCS();
    if (tr.outcome !== null) throw eCS();
  }
  if (conv.controller === "codex") {
    if (request.nativeIdentity !== ref.nativeThreadId) throw eAC();
    if (request.nativeTurnId !== tr.nativeTurnId) throw eAC();
    if (request.claudeInputUuid !== null) throw eAC();
  } else {
    if (request.nativeIdentity !== ref.nativeSessionUuid) throw eAC();
    if (request.claudeInputUuid !== tr.claudeInputUuid) throw eAC();
    if (request.nativeTurnId !== null) throw eAC();
  }
}

function nqId(route, connId, reqId, itemId) {
  if (route === "codex_async") return JSON.stringify([route, connId, "item", itemId]);
  return JSON.stringify([route, connId, typeof reqId, reqId]);
}

// --- Structural question equality (property-order independent) ---
function normQEq(a, b) {
  if (a.id !== b.id) return false;
  if (a.header !== b.header) return false;
  if (a.question !== b.question) return false;
  if ("multiSelect" in a && (a.multiSelect ?? false) !== (b.multiSelect ?? false)) return false;
  if ("isOther" in a && (a.isOther ?? false) !== (b.isOther ?? false)) return false;
  const ao = a.options, bo = b.options;
  if (ao === null && bo === null) return true;
  if (ao === null || bo === null) return false;
  if (!Array.isArray(ao) || !Array.isArray(bo)) return false;
  if (ao.length !== bo.length) return false;
  for (let i = 0; i < ao.length; i++) {
    if (ao[i].label !== bo[i].label) return false;
    if ((ao[i].description ?? "") !== (bo[i].description ?? "")) return false;
  }
  return true;
}

// --- Question validation via codec ---
function vQuestions(route, req, qs) {
  if (!Array.isArray(qs) || qs.length === 0 || qs.length > 4) throw eInv("questions");
  const ids = new Set();
  for (const q of qs) {
    if (q === null || typeof q !== "object" || Array.isArray(q)) throw eInv("question");
    const ks = Object.keys(q).sort();
    if (ks.length !== 6 || ks[0] !== "header" || ks[1] !== "id" || ks[2] !== "isOther" || ks[3] !== "multiSelect" || ks[4] !== "options" || ks[5] !== "question") throw eInv("question keys");
    if (typeof q.id !== "string" || q.id.length === 0 || q.id.length > MAX_Q_ID || q.id.includes("\0") || loneSurrogate(q.id)) throw eInv("question id");
    if (ids.has(q.id)) throw eInv("duplicate question id"); ids.add(q.id);
    if (typeof q.header !== "string" || q.header.length === 0 || q.header.length > 128 || q.header.includes("\0") || loneSurrogate(q.header)) throw eInv("question header");
    if (typeof q.question !== "string" || q.question.length === 0 || q.question.length > 2048 || q.question.includes("\0") || loneSurrogate(q.question)) throw eInv("question text");
    if (typeof q.multiSelect !== "boolean") throw eInv("question multiSelect");
    if (typeof q.isOther !== "boolean") throw eInv("question isOther");
    if (q.options !== null) {
      if (!Array.isArray(q.options) || q.options.length === 0 || q.options.length > 8) throw eInv("question options");
      const sl = new Set();
      for (const o of q.options) {
        if (o === null || typeof o !== "object" || Array.isArray(o)) throw eInv("option");
        const ok = Object.keys(o).sort();
        if (ok.length !== 2 || ok[0] !== "description" || ok[1] !== "label") throw eInv("option keys");
        if (typeof o.label !== "string" || o.label.length === 0 || o.label.length > 256 || o.label.includes("\0") || loneSurrogate(o.label)) throw eInv("option label");
        if (typeof o.description !== "string" || o.description.length > 2048 || o.description.includes("\0") || loneSurrogate(o.description)) throw eInv("option description");
        if (sl.has(o.label)) throw eInv("duplicate option label"); sl.add(o.label);
      }
    }
  }
  const canon = qs.map((q) => ({ id: q.id, header: q.header, question: q.question, multiSelect: q.multiSelect, isOther: q.isOther, options: q.options === null ? null : q.options.map((o) => ({ label: o.label, description: o.description })) }));
  let normalized;
  try {
    if (route === "codex_request") {
      if (canon.some((q) => q.multiSelect !== false)) throw eInv("codex_request multiSelect must be false");
      normalized = parseCodexClarification({ threadId: req.nativeIdentity, turnId: req.nativeTurnId, itemId: req.nativeItemId, isBlocking: true, questions: canon.map((q) => ({ id: q.id, header: q.header, question: q.question, options: q.options, isOther: q.isOther })) }).questions;
    } else if (route === "codex_async") {
      if (canon.some((q) => q.multiSelect !== false || q.isOther !== true)) throw eInv("codex_async flags mismatch");
      normalized = parseCodexAsyncClarification({ threadId: req.nativeIdentity, turnId: req.nativeTurnId, item: { type: "agentMessage", delivery: "async", id: req.nativeItemId, questions: canon.map((q) => ({ title: q.question, options: q.options === null ? null : q.options.map((o) => o.label) })) } }).questions;
    } else {
      if (canon.some((q) => q.isOther !== true)) throw eInv("claude_request isOther must be true");
      if (canon.some((q) => q.options === null || q.options.length < 2)) throw eInv("claude_request needs 2+ options");
      normalized = parseClaudeClarification({ questions: canon.map((q) => ({ header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect })) }).questions;
    }
  } catch (e) { if (e instanceof Error && !e.code) throw eInv("question codec validation failed"); throw e; }
  if (!Array.isArray(normalized) || normalized.length !== canon.length) throw eInv("question codec normalization mismatch");
  for (let i = 0; i < canon.length; i++) {
    if (!normQEq(normalized[i], canon[i])) throw eInv("question codec normalization mismatch");
  }
  let agg = 0;
  for (const q of canon) { agg += q.header.length + q.question.length; if (q.options) for (const o of q.options) agg += o.label.length + o.description.length; }
  if (agg > 16384) throw eInv("questions exceed aggregate display cap");
  return canon;
}

// --- Answer map validation ---
function vAnsMap(ans) {
  if (ans === null || typeof ans !== "object" || Array.isArray(ans)) throw eInv("answers");
  const proto = Object.getPrototypeOf(ans);
  if (proto !== Object.prototype && proto !== null) throw eInv("answers must be a plain object");
  const ks = Object.keys(ans);
  if (ks.length > MAX_A_KEYS) throw eInv("answers too many keys");
  let agg = 0;
  for (const k of ks) {
    if (typeof k !== "string" || k.length === 0 || k.length > MAX_A_KEY || k.includes("\0") || loneSurrogate(k)) throw eInv("answer key");
    const a = ans[k];
    if (!Array.isArray(a) || a.length > MAX_A_ARR) throw eInv("answer value");
    for (const s of a) { if (typeof s !== "string" || s.length > MAX_A_STR || s.includes("\0") || loneSurrogate(s)) throw eInv("answer string"); agg += s.length; }
  }
  if (agg > MAX_A_AGG) throw eInv("answers exceed aggregate cap");
  const j = JSON.stringify(ans);
  if (Buffer.byteLength(j, "utf8") > MAX_A_JSON) throw eInv("answers JSON exceeds cap");
  return j;
}

function orderAns(ans, qs) {
  const ko = qs.map((q) => q.id); const ks = new Set(ko);
  const all = Object.keys(ans); const ord = [];
  for (const id of ko) if (all.includes(id)) ord.push(id);
  for (const k of all.filter((x) => !ks.has(x)).sort()) ord.push(k);
  const out = {}; for (const k of ord) setOwn(out, k, ans[k]); return out;
}

function vAnsSem(route, qs, ans) {
  try {
    if (route === "codex_request") {
      encodeCodexClarificationAnswer({ questions: qs.map((q) => ({ id: q.id, header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect, isOther: q.isOther })) }, ans);
    } else if (route === "codex_async") {
      encodeCodexAsyncClarificationAnswer({ questions: qs.map((q, i) => ({ id: String(i), header: `Question ${i + 1}`, question: q.question, options: q.options, multiSelect: false, isOther: true })) }, ans);
    } else {
      const ri = { questions: qs.map((q) => ({ header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect })) };
      const pi = { questions: qs.map((q) => ({ id: q.question, header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect, isOther: true })) };
      encodeClaudeClarificationAnswer(ri, pi, ans);
    }
    return true;
  } catch { return false; }
}

// --- Hash ---
function hash(parts) { return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex"); }
function qHash({ projectId, conversationId, turnId, clarificationId, scope, request, questions }) {
  return hash([CLAR_V1, projectId, conversationId, turnId, clarificationId, scope.ownerToken, scope.ownerGeneration, scope.hostGeneration, request, questions]);
}
function aHash({ projectId, conversationId, turnId, clarificationId, operationId, qh, scope, answers }) {
  return hash([ANS_V1, projectId, conversationId, turnId, clarificationId, operationId, qh, scope.ownerToken, scope.ownerGeneration, scope.hostGeneration, answers]);
}

// --- Build records ---
function buildClar(row) {
  if (!row || typeof row !== "object") throw eSto();
  if (typeof row.id !== "string" || !UUID_RE.test(row.id)) throw eSto();
  if (typeof row.conversation_id !== "string" || !UUID_RE.test(row.conversation_id)) throw eSto();
  if (typeof row.turn_id !== "string" || !UUID_RE.test(row.turn_id)) throw eSto();
  if (typeof row.native_question_id !== "string") throw eSto();
  if (!Q_STATUS.has(row.status)) throw eSto();
  cap(row.question_json, MAX_Q_JSON);
  let qd; try { qd = JSON.parse(row.question_json); } catch { throw eSto(); }
  if (qd === null || typeof qd !== "object" || Array.isArray(qd)) throw eSto();
  const qk = Object.keys(qd).sort();
  if (qk.length !== 7 || qk[0] !== "createdAtMs" || qk[1] !== "hash" || qk[2] !== "hostGeneration" || qk[3] !== "ownerGeneration" || qk[4] !== "questions" || qk[5] !== "request" || qk[6] !== "v") throw eSto();
  if (qd.v !== 1) throw eSto();
  if (typeof qd.hash !== "string" || !SHA_RE.test(qd.hash)) throw eSto();
  if (!Number.isSafeInteger(qd.ownerGeneration) || qd.ownerGeneration < 1) throw eSto();
  if (typeof qd.hostGeneration !== "string" || !UUID_RE.test(qd.hostGeneration)) throw eSto();
  if (!Number.isSafeInteger(qd.createdAtMs) || qd.createdAtMs < 0) throw eSto();
  if (!Array.isArray(qd.questions) || qd.questions.length === 0 || qd.questions.length > 4) throw eSto();
  const req = qd.request;
  if (req === null || typeof req !== "object" || Array.isArray(req)) throw eSto();
  const rk = Object.keys(req).sort();
  if (rk.length !== 8 || rk[0] !== "claudeInputUuid" || rk[1] !== "connectionId" || rk[2] !== "controller" || rk[3] !== "nativeIdentity" || rk[4] !== "nativeItemId" || rk[5] !== "nativeRequestId" || rk[6] !== "nativeTurnId" || rk[7] !== "route") throw eSto();
  if (!ROUTES.has(req.route)) throw eSto();
  if (typeof req.connectionId !== "string" || !UUID_RE.test(req.connectionId)) throw eSto();
  let ans = null;
  if (row.answer_json !== null) {
    cap(row.answer_json, MAX_RES_JSON);
    try { ans = JSON.parse(row.answer_json); } catch { throw eSto(); }
    if (ans === null || typeof ans !== "object" || Array.isArray(ans)) throw eSto();
    const ak = Object.keys(ans).sort();
    if (ak.length !== 4 || ak[0] !== "answers" || ak[1] !== "operationId" || ak[2] !== "outcome" || ak[3] !== "v") throw eSto();
    if (ans.v !== 1) throw eSto();
    if (typeof ans.operationId !== "string" || !UUID_RE.test(ans.operationId)) throw eSto();
    if (!OUTCOMES.has(ans.outcome)) throw eSto();
    if (row.status !== "answered") throw eSto();
    if (!Number.isSafeInteger(row.answered_at_ms) || row.answered_at_ms < 0) throw eSto();
    if (row.answered_at_ms < qd.createdAtMs) throw eSto();
  } else {
    if (row.status === "answered") throw eSto();
    if (row.answered_at_ms !== null) throw eSto();
  }
  return { id: row.id, conversationId: row.conversation_id, turnId: row.turn_id, route: req.route, connectionId: req.connectionId, nativeQuestionId: row.native_question_id, request: { ...req }, questions: qd.questions.map((q) => ({ ...q })), status: row.status, ownerGeneration: qd.ownerGeneration, hostGeneration: qd.hostGeneration, createdAtMs: qd.createdAtMs, answer: ans ? { operationId: ans.operationId, outcome: ans.outcome, answers: ans.answers, answeredAtMs: row.answered_at_ms } : null };
}

function parseHist(text) {
  cap(text, MAX_HIST);
  let p; try { p = JSON.parse(text); } catch { throw eSto(); }
  if (!Array.isArray(p) || p.length === 0 || p.length > 3) throw eSto();
  const kinds = ["queued", "dispatching", "terminal"];
  const seen = new Set();
  for (const e of p) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) throw eSto();
    if (!kinds.includes(e.kind)) throw eSto();
    if (!Number.isSafeInteger(e.atMs) || e.atMs < 0) throw eSto();
    if (seen.has(e.kind)) throw eSto(); seen.add(e.kind);
    const ek = Object.keys(e).sort();
    if (e.kind === "terminal") { if (ek.length !== 3 || ek[0] !== "atMs" || ek[1] !== "kind" || ek[2] !== "outcome") throw eSto(); if (!AT_TERM.has(e.outcome)) throw eSto(); }
    else { if (ek.length !== 2 || ek[0] !== "atMs" || ek[1] !== "kind") throw eSto(); }
  }
  if (p[0].kind !== "queued") throw eSto();
  const pos = new Map(); p.forEach((e, i) => pos.set(e.kind, i));
  if (pos.has("dispatching") && pos.get("dispatching") < pos.get("queued")) throw eSto();
  if (pos.has("terminal") && pos.get("terminal") !== p.length - 1) throw eSto();
  for (let i = 1; i < p.length; i++) if (p[i].atMs < p[i - 1].atMs) throw eSto();
  return p.map((e) => ({ ...e }));
}

function parseRes(text, { state, hash: h }) {
  cap(text, MAX_RES_JSON);
  let p; try { p = JSON.parse(text); } catch { throw eSto(); }
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw eSto();
  if (p.v !== 1 || p.hash !== h) throw eSto();
  const pk = Object.keys(p).sort();
  if (pk.length !== 8 || pk[0] !== "answers" || pk[1] !== "clarificationId" || pk[2] !== "hash" || pk[3] !== "outcome" || pk[4] !== "questionHash" || pk[5] !== "request" || pk[6] !== "terminalRequestSupplied" || pk[7] !== "v") throw eSto();
  if (typeof p.clarificationId !== "string" || !UUID_RE.test(p.clarificationId)) throw eSto();
  if (typeof p.questionHash !== "string" || !SHA_RE.test(p.questionHash)) throw eSto();
  if (typeof p.terminalRequestSupplied !== "boolean") throw eSto();
  if (p.request === null) throw eSto();
  if (AT_NONTERM.has(state)) { if (p.outcome !== null) throw eSto(); }
  else { if (p.outcome !== state) throw eSto(); }
  return { ...p, request: { ...p.request }, answers: { ...p.answers } };
}

function buildAttempt(row) {
  if (!row || typeof row !== "object") throw eSto();
  if (typeof row.id !== "string" || !UUID_RE.test(row.id)) throw eSto();
  if (row.kind !== "clarification_answer") throw eSto();
  if (typeof row.conversation_id !== "string" || !UUID_RE.test(row.conversation_id)) throw eSto();
  if (typeof row.turn_id !== "string" || !UUID_RE.test(row.turn_id)) throw eSto();
  if (!Number.isSafeInteger(row.owner_generation) || row.owner_generation < 1) throw eSto();
  if (typeof row.host_generation !== "string" || !UUID_RE.test(row.host_generation)) throw eSto();
  if (typeof row.decision !== "string" || !UUID_RE.test(row.decision)) throw eSto();
  if (!AT_STATES.has(row.state)) throw eSto();
  const outcome = AT_NONTERM.has(row.state) ? null : row.state;
  if (AT_NONTERM.has(row.state)) { if (row.settled_at_ms !== null) throw eSto(); }
  else if (!Number.isSafeInteger(row.settled_at_ms) || row.settled_at_ms < 0) throw eSto();
  if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) throw eSto();
  if (typeof row.payload_hash !== "string" || !SHA_RE.test(row.payload_hash)) throw eSto();
  const hist = parseHist(row.history_json);
  const res = parseRes(row.result_json, { state: row.state, hash: row.payload_hash });
  if (res.clarificationId !== row.decision) throw eSto();
  if (hist[0].atMs !== row.created_at_ms) throw eSto();
  const tf = hist.find((e) => e.kind === "terminal");
  if (tf) { if (tf.atMs !== row.settled_at_ms) throw eSto(); if (tf.atMs < row.created_at_ms) throw eSto(); }
  const kinds = hist.map((e) => e.kind);
  if (row.state === "queued") { if (kinds.length !== 1) throw eSto(); }
  else if (row.state === "dispatching") { if (kinds.length !== 2 || kinds[1] !== "dispatching") throw eSto(); }
  else { if (!tf || tf.outcome !== row.state) throw eSto(); }
  return { id: row.id, clarificationId: row.decision, conversationId: row.conversation_id, turnId: row.turn_id, request: res.request, answers: res.answers, state: row.state, outcome, ownerGeneration: row.owner_generation, hostGeneration: row.host_generation, createdAtMs: row.created_at_ms, settledAtMs: row.settled_at_ms, history: hist };
}

// --- Pending verifier ---
function deepClone(o) {
  if (o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const c = {};
  for (const k of Object.keys(o)) {
    if (k === "__proto__") {
      Object.defineProperty(c, k, { value: deepClone(o[k]), enumerable: true, writable: true, configurable: true });
    } else {
      c[k] = deepClone(o[k]);
    }
  }
  return c;
}
function deepFreeze(o) {
  if (o === null || typeof o !== "object") return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) { const v = o[k]; if (v !== null && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v); }
  return o;
}
function verifyPending(pv, facts) {
  const { evidence, ...rest } = facts;
  const frozenData = deepFreeze(deepClone(rest));
  const outer = {};
  for (const k of Object.keys(frozenData)) {
    Object.defineProperty(outer, k, { value: frozenData[k], enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperty(outer, "evidence", { value: evidence, enumerable: true, writable: false, configurable: false });
  Object.freeze(outer);
  let r; try { r = pv(outer); } catch { throw eQUnv(); }
  if (r === true) return;
  let t; try { t = r !== null && (typeof r === "object" || typeof r === "function") ? r.then : undefined; } catch { throw eQUnv(); }
  if (typeof t === "function") { try { r.then(undefined, () => {}); } catch { /* consume */ } }
  throw eQUnv();
}

function appendHist(hist, entry) {
  if (hist.some((e) => e.kind === entry.kind)) return { text: JSON.stringify(hist), changed: false };
  const next = [...hist, { ...entry }];
  const text = JSON.stringify(next);
  cap(text, MAX_HIST);
  return { text, changed: true };
}

// --- Core operations ---
function runRegister(tx, auth, pv, turnsTx, args, ts) {
  const inp = reqObj(args);
  const scope = vScope(inp);
  vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id");
  if (!ROUTES.has(inp.route)) throw eInv("route");
  vUuid(inp.connectionId, "connection id");
  if (inp.route === "codex_async" || inp.route === "codex_request") { vText(inp.nativeItemId, 1, 128, "native item id"); }
  else { vOpaque(inp.nativeItemId, "native item id"); }
  const nr = vNativeReqId(inp.nativeRequestId ?? null, inp.route);
  const conv = readConv(tx, scope.projectId, scope.conversationId);
  if (inp.route === "codex_async" || inp.route === "codex_request") { if (conv.controller !== "codex") throw eCS(); }
  else { if (conv.controller !== "claude") throw eCS(); }
  auth.authorizeLiveWrite(tx, scope);
  const tr = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
  if (!tr) throw eNF();
  reqHandoff(tr, scope);
  const ref = readRef(tx, scope.projectId, scope.conversationId, conv);
  const request = deriveReq(inp.route, conv, tr, ref, inp.nativeItemId, inp.nativeRequestId ?? null, inp.connectionId);
  const canonQs = vQuestions(inp.route, request, inp.questions);
  const nqi = nqId(inp.route, inp.connectionId, inp.nativeRequestId ?? null, inp.nativeItemId);
  const qh = qHash({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, scope, request, questions: canonQs });
  const prior = tx.get(S_CLAR, [inp.clarificationId]);
  if (prior) {
    if (prior.conversation_id === scope.conversationId && prior.turn_id === inp.turnId) {
      cap(prior.question_json, MAX_Q_JSON);
      let pqd; try { pqd = JSON.parse(prior.question_json); } catch { throw eSto(); }
      if (!pqd || typeof pqd !== "object") throw eSto();
      if (pqd.hostGeneration !== scope.hostGeneration) {
        const pt = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
        if (!pt) throw eSto();
        if (pt.hostGeneration === scope.hostGeneration) throw eFence();
        throw eIdem();
      }
      if (pqd.ownerGeneration !== scope.ownerGeneration) throw eIdem();
      if (pqd.hash !== qh) throw eIdem();
      const stored = buildClar(prior);
      if (!reqEq(stored.request, request)) throw eIdem();
      const pt2 = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
      if (!pt2) throw eSto();
      reqHandoff(pt2, scope);
      verifyNativeCorrelation(conv, pt2, ref, stored.request, { requireNonterminalParent: false });
      return { created: false, clarification: stored };
    }
    throw eIdem();
  }
  if (tr.intentState !== "observed") throw eCS();
  if (!ref) throw eCS();
  if (tr.outcome !== null) throw eCS();
  verifyNativeCorrelation(conv, tr, ref, request, { requireNonterminalParent: true });
  const coll = tx.all(S_CLAR_COLL, [nqi]);
  if (coll.length > COLLISION_LIMIT) throw eSto();
  if (coll.length > 0) {
    for (const c of coll) {
      cap(c.question_json, MAX_Q_JSON);
      let cq; try { cq = JSON.parse(c.question_json); } catch { throw eSto(); }
      if (cq && cq.hostGeneration === scope.hostGeneration) throw eCC();
    }
  }
  const unk = tx.get(S_CLAR_UNK, [scope.hostGeneration, nqi]);
  if (unk) throw eCC();
  verifyPending(pv, { action: "register", projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, operationId: null, ownerToken: scope.ownerToken, ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration, request, questions: canonQs, answers: null, evidence: inp.pendingEvidence });
  const qj = JSON.stringify({ v: 1, hash: qh, ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration, createdAtMs: ts, request, questions: canonQs });
  cap(qj, MAX_Q_JSON);
  tx.run(S_INS_CLAR, [inp.clarificationId, inp.turnId, scope.conversationId, nqi, qj]);
  return { created: true, clarification: buildClar(tx.get(S_CLAR, [inp.clarificationId])) };
}

function runQueue(tx, auth, pv, turnsTx, args, ts) {
  const inp = reqObj(args);
  const scope = vScope(inp);
  vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
  const ansJson = vAnsMap(inp.answers);
  const conv = readConv(tx, scope.projectId, scope.conversationId);
  auth.authorizeLiveWrite(tx, scope);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) throw eNF();
  if (cRow.conversation_id !== scope.conversationId || cRow.turn_id !== inp.turnId) throw eIdem();
  cap(cRow.question_json, MAX_Q_JSON);
  let cq; try { cq = JSON.parse(cRow.question_json); } catch { throw eSto(); }
  if (!cq || typeof cq !== "object") throw eSto();
  if (cq.ownerGeneration !== scope.ownerGeneration || cq.hostGeneration !== scope.hostGeneration) throw eFence();
  const tr = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
  if (!tr) throw eSto();
  reqHandoff(tr, scope);
  const clar = buildClar(cRow);
  const ref = readRef(tx, scope.projectId, scope.conversationId, conv);
  const ordered = orderAns(inp.answers, clar.questions);
  const qh = cq.hash;
  const ah = aHash({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, operationId: inp.operationId, qh, scope, answers: ordered });
  const prior = tx.get(S_OP, [inp.operationId]);
  if (prior) {
    if (prior.kind === "clarification_answer" && prior.conversation_id === scope.conversationId && prior.turn_id === inp.turnId && prior.decision === inp.clarificationId) {
      if (prior.host_generation !== scope.hostGeneration) throw eFence();
      if (prior.owner_generation !== scope.ownerGeneration) throw eIdem();
      if (prior.payload_hash !== ah) throw eIdem();
      const stored = buildAttempt(prior);
      verifyNativeCorrelation(conv, tr, ref, stored.request, { requireNonterminalParent: false });
      return { created: false, attempt: stored, clarification: clar };
    }
    throw eIdem();
  }
  if (clar.status !== "pending" && clar.status !== "invalid") throw eCS();
  if (tr.intentState !== "observed") throw eCS();
  if (tr.outcome !== null) throw eCS();
  verifyNativeCorrelation(conv, tr, ref, clar.request, { requireNonterminalParent: true });
  const active = tx.all(S_ACTIVE, [inp.clarificationId]);
  if (active.length > 1) throw eSto();
  if (active.length === 1) throw eCS();
  const valid = vAnsSem(clar.route, clar.questions, ordered);
  const nrText = clar.route === "codex_async" ? null : JSON.stringify(clar.request.nativeRequestId);
  const nrType = clar.route === "codex_async" ? null : typeof clar.request.nativeRequestId;
  if (valid) {
    verifyPending(pv, { action: "queue", projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, operationId: inp.operationId, ownerToken: scope.ownerToken, ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration, request: clar.request, questions: clar.questions, answers: ordered, evidence: inp.pendingEvidence });
    const hist = JSON.stringify([{ kind: "queued", atMs: ts }]);
    cap(hist, MAX_HIST);
    const res = JSON.stringify({ v: 1, hash: ah, clarificationId: inp.clarificationId, questionHash: qh, request: clar.request, answers: ordered, outcome: null, terminalRequestSupplied: false });
    cap(res, MAX_RES_JSON);
    tx.run(S_INS_OP, [inp.operationId, scope.conversationId, inp.turnId, scope.ownerGeneration, scope.hostGeneration, inp.clarificationId, nrText, nrType, "queued", hist, ah, res, ts, null]);
    if (clar.status === "invalid") {
      const qUpd = tx.run(S_UPD_CLAR, ["pending", null, null, inp.clarificationId, "invalid"]);
      if (Number(qUpd.changes) !== 1) throw eSto();
    }
    return { created: true, attempt: buildAttempt(tx.get(S_OP, [inp.operationId])), clarification: buildClar(tx.get(S_CLAR, [inp.clarificationId])) };
  }
  verifyPending(pv, { action: "queue", projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, operationId: inp.operationId, ownerToken: scope.ownerToken, ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration, request: clar.request, questions: clar.questions, answers: ordered, evidence: inp.pendingEvidence });
  const hist = JSON.stringify([{ kind: "queued", atMs: ts }, { kind: "terminal", atMs: ts, outcome: "invalid" }]);
  cap(hist, MAX_HIST);
  const res = JSON.stringify({ v: 1, hash: ah, clarificationId: inp.clarificationId, questionHash: qh, request: clar.request, answers: ordered, outcome: "invalid", terminalRequestSupplied: false });
  cap(res, MAX_RES_JSON);
  tx.run(S_INS_OP, [inp.operationId, scope.conversationId, inp.turnId, scope.ownerGeneration, scope.hostGeneration, inp.clarificationId, nrText, nrType, "invalid", hist, ah, res, ts, ts]);
  if (clar.status === "pending") {
    const qUpd = tx.run(S_UPD_CLAR, ["invalid", null, null, inp.clarificationId, "pending"]);
    if (Number(qUpd.changes) !== 1) throw eSto();
  }
  return { created: true, attempt: buildAttempt(tx.get(S_OP, [inp.operationId])), clarification: buildClar(tx.get(S_CLAR, [inp.clarificationId])) };
}

function runBegin(tx, auth, pv, turnsTx, args, ts) {
  const inp = reqObj(args);
  const scope = vScope(inp);
  vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
  const conv = readConv(tx, scope.projectId, scope.conversationId);
  auth.authorizeLiveWrite(tx, scope);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) throw eNF();
  if (cRow.conversation_id !== scope.conversationId || cRow.turn_id !== inp.turnId) throw eIdem();
  cap(cRow.question_json, MAX_Q_JSON);
  let cq; try { cq = JSON.parse(cRow.question_json); } catch { throw eSto(); }
  if (!cq || typeof cq !== "object") throw eSto();
  if (cq.ownerGeneration !== scope.ownerGeneration || cq.hostGeneration !== scope.hostGeneration) throw eFence();
  const tr = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
  if (!tr) throw eSto();
  reqHandoff(tr, scope);
  const opRow = tx.get(S_OP, [inp.operationId]);
  if (!opRow) throw eNF();
  if (opRow.kind !== "clarification_answer" || opRow.decision !== inp.clarificationId) throw eIdem();
  if (opRow.owner_generation !== scope.ownerGeneration || opRow.host_generation !== scope.hostGeneration) throw eFence();
  if (opRow.state !== "queued") throw eDisp();
  if (tr.intentState !== "observed") throw eCS();
  if (tr.outcome !== null) throw eCS();
  const clar = buildClar(cRow);
  if (clar.status !== "pending") throw eCS();
  const ref = readRef(tx, scope.projectId, scope.conversationId, conv);
  const active = tx.all(S_ACTIVE, [inp.clarificationId]);
  if (active.length > 1) throw eSto();
  if (active.length === 1 && active[0].id !== inp.operationId) throw eCS();
  const attempt = buildAttempt(opRow);
  if (ts < attempt.createdAtMs) throw eInv("clock");
  verifyNativeCorrelation(conv, tr, ref, attempt.request, { requireNonterminalParent: true });
  verifyPending(pv, { action: "dispatch", projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId, clarificationId: inp.clarificationId, operationId: inp.operationId, ownerToken: scope.ownerToken, ownerGeneration: scope.ownerGeneration, hostGeneration: scope.hostGeneration, request: deepFreeze(deepClone(attempt.request)), questions: deepFreeze(deepClone(clar.questions)), answers: deepFreeze(deepClone(attempt.answers)), evidence: inp.pendingEvidence });
  const hist = parseHist(opRow.history_json);
  const ap = appendHist(hist, { kind: "dispatching", atMs: ts });
  const res = JSON.stringify({ v: 1, hash: opRow.payload_hash, clarificationId: inp.clarificationId, questionHash: cq.hash, request: attempt.request, answers: attempt.answers, outcome: null, terminalRequestSupplied: false });
  cap(res, MAX_RES_JSON);
  const upd = tx.run(S_CAS_BEG, [ap.text, res, inp.operationId]);
  if (Number(upd.changes) !== 1) throw eDisp();
  return buildAttempt(tx.get(S_OP, [inp.operationId]));
}

function runSettle(tx, auth, turnsTx, args, ts) {
  const inp = reqObj(args);
  const scope = vScope(inp);
  vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
  if (!OUTCOMES.has(inp.outcome)) throw eInv("outcome");
  const hasReq = inp.request !== undefined && inp.request !== null;
  const conv = readConv(tx, scope.projectId, scope.conversationId);
  auth.authorizeLiveWrite(tx, scope);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) throw eNF();
  if (cRow.conversation_id !== scope.conversationId || cRow.turn_id !== inp.turnId) throw eIdem();
  cap(cRow.question_json, MAX_Q_JSON);
  let cq; try { cq = JSON.parse(cRow.question_json); } catch { throw eSto(); }
  if (!cq || typeof cq !== "object") throw eSto();
  if (cq.ownerGeneration !== scope.ownerGeneration || cq.hostGeneration !== scope.hostGeneration) throw eFence();
  const tr = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
  if (!tr) throw eSto();
  reqHandoff(tr, scope);
  const opRow = tx.get(S_OP, [inp.operationId]);
  if (!opRow) throw eNF();
  if (opRow.kind !== "clarification_answer" || opRow.decision !== inp.clarificationId) throw eIdem();
  if (opRow.owner_generation !== scope.ownerGeneration || opRow.host_generation !== scope.hostGeneration) throw eFence();
  const clar = buildClar(cRow);
  const attempt = buildAttempt(opRow);
  if (ts < attempt.createdAtMs) throw eInv("clock");
  if (ts < clar.createdAtMs) throw eInv("clock");
  const ref = readRef(tx, scope.projectId, scope.conversationId, conv);
  // Exact terminal retry
  if (AT_TERM.has(opRow.state)) {
    if (inp.outcome !== opRow.state) throw eAC();
    const storedSupplied = JSON.parse(opRow.result_json).terminalRequestSupplied;
    if (storedSupplied !== hasReq) throw eAC();
    if (hasReq && !reqEq(inp.request, attempt.request)) throw eAC();
    if (inp.outcome === "written" || inp.outcome === "acknowledged") {
      verifyNativeCorrelation(conv, tr, ref, attempt.request, { requireNonterminalParent: false });
    }
    return { attempt, clarification: clar };
  }
  // written: requires dispatching, route codex_request|claude_request
  if (inp.outcome === "written") {
    if (opRow.state !== "dispatching") throw eAS();
    if (clar.route === "codex_async") throw eAS();
    if (!hasReq) throw eInv("request");
    if (!reqEq(inp.request, attempt.request)) throw eAC();
    verifyNativeCorrelation(conv, tr, ref, attempt.request, { requireNonterminalParent: false });
    return settleTo(tx, scope, opRow, attempt, clar, cRow, "written", true, ts, inp.clarificationId, inp.operationId);
  }
  // acknowledged: requires dispatching, route codex_async
  if (inp.outcome === "acknowledged") {
    if (opRow.state !== "dispatching") throw eAS();
    if (clar.route !== "codex_async") throw eAS();
    if (!hasReq) throw eInv("request");
    if (!reqEq(inp.request, attempt.request)) throw eAC();
    verifyNativeCorrelation(conv, tr, ref, attempt.request, { requireNonterminalParent: false });
    return settleTo(tx, scope, opRow, attempt, clar, cRow, "acknowledged", true, ts, inp.clarificationId, inp.operationId);
  }
  // not_sent / invalid: from queued or dispatching
  if (inp.outcome === "not_sent" || inp.outcome === "invalid") {
    if (opRow.state !== "queued" && opRow.state !== "dispatching") throw eAS();
    if (hasReq && !reqEq(inp.request, attempt.request)) throw eAC();
    return settleTo(tx, scope, opRow, attempt, clar, cRow, inp.outcome, hasReq, ts, inp.clarificationId, inp.operationId);
  }
  // unknown: any nonterminal
  if (inp.outcome === "unknown") {
    if (hasReq && !reqEq(inp.request, attempt.request)) throw eAC();
    return settleTo(tx, scope, opRow, attempt, clar, cRow, "unknown", hasReq, ts, inp.clarificationId, inp.operationId);
  }
  // unactionable: only queued, no request
  if (inp.outcome === "unactionable") {
    if (opRow.state !== "queued") throw eAS();
    if (hasReq) throw eInv("request");
    return settleTo(tx, scope, opRow, attempt, clar, cRow, "unactionable", false, ts, inp.clarificationId, inp.operationId);
  }
  throw eInv("outcome");
}

function settleTo(tx, scope, opRow, attempt, clar, cRow, outcome, supplied, ts, clarificationId, operationId) {
  const hist = parseHist(opRow.history_json);
  const ap = appendHist(hist, { kind: "terminal", atMs: ts, outcome });
  const qh = JSON.parse(cRow.question_json).hash;
  const res = JSON.stringify({ v: 1, hash: opRow.payload_hash, clarificationId, questionHash: qh, request: attempt.request, answers: attempt.answers, outcome, terminalRequestSupplied: supplied });
  cap(res, MAX_RES_JSON);
  const upd = tx.run(S_CAS_TERM, [outcome, ap.text, res, ts, operationId, opRow.state]);
  if (Number(upd.changes) !== 1) throw eAS();
  // Question projection
  if (outcome === "written" || outcome === "acknowledged") {
    if (clar.status === "pending" || clar.status === "invalid") {
      const aj = JSON.stringify({ v: 1, operationId, outcome, answers: attempt.answers });
      cap(aj, MAX_RES_JSON);
      const qUpd = tx.run(S_UPD_CLAR, ["answered", aj, ts, clarificationId, clar.status]);
      if (Number(qUpd.changes) !== 1) throw eSto();
    }
  } else if (outcome === "not_sent") {
    if (clar.status === "pending" || clar.status === "invalid") {
      const qUpd = tx.run(S_UPD_CLAR, ["pending", null, null, clarificationId, clar.status]);
      if (Number(qUpd.changes) !== 1) throw eSto();
    }
  } else if (outcome === "invalid") {
    if (clar.status === "pending" || clar.status === "invalid") {
      const qUpd = tx.run(S_UPD_CLAR, ["invalid", null, null, clarificationId, clar.status]);
      if (Number(qUpd.changes) !== 1) throw eSto();
    }
  } else if (outcome === "unknown" || outcome === "unactionable") {
    if (clar.status !== "answered") {
      const qUpd = tx.run(S_UPD_CLAR, ["unactionable", null, null, clarificationId, clar.status]);
      if (Number(qUpd.changes) !== 1) throw eSto();
    }
  }
  return { attempt: buildAttempt(tx.get(S_OP, [operationId])), clarification: buildClar(tx.get(S_CLAR, [clarificationId])) };
}

function runRetire(tx, auth, turnsTx, args) {
  const inp = reqObj(args);
  const scope = vScope(inp);
  vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id");
  readConv(tx, scope.projectId, scope.conversationId);
  auth.authorizeLiveWrite(tx, scope);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) throw eNF();
  if (cRow.conversation_id !== scope.conversationId || cRow.turn_id !== inp.turnId) throw eIdem();
  cap(cRow.question_json, MAX_Q_JSON);
  let cq; try { cq = JSON.parse(cRow.question_json); } catch { throw eSto(); }
  if (!cq || typeof cq !== "object") throw eSto();
  if (cq.ownerGeneration !== scope.ownerGeneration || cq.hostGeneration !== scope.hostGeneration) throw eFence();
  const tr = turnsTx.getTurn({ projectId: scope.projectId, conversationId: scope.conversationId, turnId: inp.turnId });
  if (!tr) throw eSto();
  reqHandoff(tr, scope);
  const clar = buildClar(cRow);
  if (clar.status === "answered" || clar.status === "unactionable") return clar;
  const upd = tx.run(S_UPD_RETIRE, [inp.clarificationId]);
  if (Number(upd.changes) !== 1) throw eSto();
  return buildClar(tx.get(S_CLAR, [inp.clarificationId]));
}

function runGet(tx, turnsTx, args) {
  const inp = reqObj(args);
  vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.clarificationId, "clarification id");
  const conv = readConv(tx, inp.projectId, inp.conversationId);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) return null;
  if (cRow.conversation_id !== inp.conversationId) throw eNF();
  const tr = turnsTx.getTurn({ projectId: inp.projectId, conversationId: inp.conversationId, turnId: cRow.turn_id });
  if (!tr) throw eSto();
  const clar = buildClar(cRow);
  const ref = readRef(tx, inp.projectId, inp.conversationId, conv);
  if (ref) verifyNativeCorrelation(conv, tr, ref, clar.request, { requireNonterminalParent: false });
  return clar;
}

function runGetAttempt(tx, turnsTx, args) {
  const inp = reqObj(args);
  vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.operationId, "operation id");
  const conv = readConv(tx, inp.projectId, inp.conversationId);
  const opRow = tx.get(S_OP, [inp.operationId]);
  if (!opRow) return null;
  if (opRow.kind !== "clarification_answer" || opRow.conversation_id !== inp.conversationId) throw eNF();
  const cRow = tx.get(S_CLAR, [opRow.decision]);
  if (!cRow) throw eSto();
  if (cRow.conversation_id !== inp.conversationId) throw eNF();
  const tr = turnsTx.getTurn({ projectId: inp.projectId, conversationId: inp.conversationId, turnId: opRow.turn_id });
  if (!tr) throw eSto();
  const attempt = buildAttempt(opRow);
  const ref = readRef(tx, inp.projectId, inp.conversationId, conv);
  if (ref) verifyNativeCorrelation(conv, tr, ref, attempt.request, { requireNonterminalParent: false });
  return attempt;
}

function runList(tx, turnsTx, args) {
  const inp = reqObj(args);
  vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.clarificationId, "clarification id");
  let limit;
  if (inp.limit === undefined) limit = LIST_MAX;
  else if (inp.limit === null) throw eInv("limit");
  else limit = inp.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX) throw eInv("limit");
  const conv = readConv(tx, inp.projectId, inp.conversationId);
  const cRow = tx.get(S_CLAR, [inp.clarificationId]);
  if (!cRow) throw eNF();
  if (cRow.conversation_id !== inp.conversationId) throw eNF();
  const tr = turnsTx.getTurn({ projectId: inp.projectId, conversationId: inp.conversationId, turnId: cRow.turn_id });
  if (!tr) throw eSto();
  const clar = buildClar(cRow);
  const ref = readRef(tx, inp.projectId, inp.conversationId, conv);
  if (ref) verifyNativeCorrelation(conv, tr, ref, clar.request, { requireNonterminalParent: false });
  let rows;
  if (inp.after !== null && inp.after !== undefined) {
    const a = reqObj(inp.after);
    if (!Number.isSafeInteger(a.createdAtMs) || a.createdAtMs < 0) throw eInv("after.createdAtMs");
    if (typeof a.id !== "string" || !UUID_RE.test(a.id)) throw eInv("after.id");
    rows = tx.all(S_LIST, [inp.clarificationId, a.createdAtMs, a.createdAtMs, a.id, limit]);
  } else {
    rows = tx.all(S_LIST0, [inp.clarificationId, limit]);
  }
  return rows.map((r) => ({ id: r.id, state: r.state, outcome: AT_NONTERM.has(r.state) ? null : r.state, createdAtMs: r.created_at_ms, settledAtMs: r.settled_at_ms }));
}

// --- Factory ---
export function createSessionClarifications(options) {
  const settings = reqObj(options ?? null);
  const { store, verifyOwnerEvidence, verifyPendingQuestion, now = Date.now } = settings;
  if (store === null || typeof store !== "object") throw eInv("store");
  if (typeof store.transaction !== "function") throw eInv("store");
  if (typeof verifyOwnerEvidence !== "function") throw eInv("owner verifier");
  if (typeof verifyPendingQuestion !== "function") throw eInv("pending verifier");
  if (typeof now !== "function") throw eInv("clock");
  const auth = createProducerAuthorizer({ verifyOwnerEvidence });
  const turnsReader = createSessionTurns({ store, verifyOwnerEvidence, now });

  function registerClarification(args) {
    const ts = stamp(now);
    const inp = reqObj(args); vScope(inp); vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id");
    if (!ROUTES.has(inp.route)) throw eInv("route");
    vUuid(inp.connectionId, "connection id"); vOpaque(inp.nativeItemId, "native item id");
    vNativeReqId(inp.nativeRequestId ?? null, inp.route);
    return store.transaction((tx) => runRegister(tx, auth, verifyPendingQuestion, turnsReader.inTransaction(tx), args, ts));
  }

  function queueAnswer(args) {
    const ts = stamp(now);
    const inp = reqObj(args); vScope(inp); vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
    vAnsMap(inp.answers);
    return store.transaction((tx) => runQueue(tx, auth, verifyPendingQuestion, turnsReader.inTransaction(tx), args, ts));
  }

  function beginAnswerDispatch(args) {
    const ts = stamp(now);
    const inp = reqObj(args); vScope(inp); vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
    return store.transaction((tx) => runBegin(tx, auth, verifyPendingQuestion, turnsReader.inTransaction(tx), args, ts));
  }

  function settleAnswer(args) {
    const ts = stamp(now);
    const inp = reqObj(args); vScope(inp); vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id"); vUuid(inp.operationId, "operation id");
    if (!OUTCOMES.has(inp.outcome)) throw eInv("outcome");
    return store.transaction((tx) => runSettle(tx, auth, turnsReader.inTransaction(tx), args, ts));
  }

  function retireClarification(args) {
    const inp = reqObj(args); vScope(inp); vUuid(inp.turnId, "turn id"); vUuid(inp.clarificationId, "clarification id");
    return store.transaction((tx) => runRetire(tx, auth, turnsReader.inTransaction(tx), args));
  }

  function getClarification(args) {
    const inp = reqObj(args); vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.clarificationId, "clarification id");
    return store.transaction((tx) => runGet(tx, turnsReader.inTransaction(tx), args));
  }

  function getAnswerAttempt(args) {
    const inp = reqObj(args); vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.operationId, "operation id");
    return store.transaction((tx) => runGetAttempt(tx, turnsReader.inTransaction(tx), args));
  }

  function listAnswerAttempts(args) {
    const inp = reqObj(args); vUuid(inp.projectId, "project id"); vUuid(inp.conversationId, "conversation id"); vUuid(inp.clarificationId, "clarification id");
    return store.transaction((tx) => runList(tx, turnsReader.inTransaction(tx), args));
  }

  function inTransaction(tx) {
    if (tx === null || typeof tx !== "object" || typeof tx.get !== "function" || typeof tx.all !== "function" || typeof tx.run !== "function") throw eInv("transaction");
    let meta;
    try { meta = tx.get("SELECT instance_uuid FROM meta WHERE application_id=?", ["cho.sessions.v1"]); }
    catch (error) { if (error && error.code) throw error; throw eSto(); }
    if (!meta || meta.instance_uuid !== store.instanceId) throw eSto();
    const turnsTx = turnsReader.inTransaction(tx);
    return Object.freeze({
      registerClarification: (a) => runRegister(tx, auth, verifyPendingQuestion, turnsTx, a, stamp(now)),
      queueAnswer: (a) => runQueue(tx, auth, verifyPendingQuestion, turnsTx, a, stamp(now)),
      beginAnswerDispatch: (a) => runBegin(tx, auth, verifyPendingQuestion, turnsTx, a, stamp(now)),
      settleAnswer: (a) => runSettle(tx, auth, turnsTx, a, stamp(now)),
      retireClarification: (a) => runRetire(tx, auth, turnsTx, a),
      getClarification: (a) => runGet(tx, turnsTx, a),
      getAnswerAttempt: (a) => runGetAttempt(tx, turnsTx, a),
      listAnswerAttempts: (a) => runList(tx, turnsTx, a),
    });
  }

  return Object.freeze({ registerClarification, queueAnswer, beginAnswerDispatch, settleAnswer, retireClarification, getClarification, getAnswerAttempt, listAnswerAttempts, inTransaction });
}
