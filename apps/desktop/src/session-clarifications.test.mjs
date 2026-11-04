// CHO-03 durable clarification regression tests: real temp SQLite fixtures only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";
import { createSessionClarifications } from "../server/session-clarifications.mjs";

const dirs = [];
const stores = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cho-clar-")); dirs.push(d); return d; };
const uid = (n) => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`;
const P1 = uid(1), P2 = uid(2);
const CX = uid(101), CL = uid(102), CX2 = uid(103);
const T1 = uid(201), T2 = uid(202);
const H1 = uid(211), H2 = uid(212);
const Q1 = uid(301), Q2 = uid(302), Q3 = uid(303), Q4 = uid(304);
const A1 = uid(401), A2 = uid(402), A3 = uid(403), A4 = uid(404);
const C1 = uid(501), C2 = uid(502);
const CS1 = uid(601), CS2 = uid(602);
const CI1 = uid(701), CI2 = uid(702);
const TH1 = "thread-alpha", TH2 = "thread-beta";

function clock(start = 1700000000000) { let t = start; return () => t++; }
const strictTrue = () => true;

function openFresh(dir, opts = {}) {
  const file = join(dir, "cho-sessions.sqlite3");
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const now = opts.now ?? clock();
  const records = createSessionRecords({ store, now });
  const bindings = createSessionBindings({ store, verifyOwnerEvidence: opts.ownerVerifier ?? strictTrue, now });
  const turns = createSessionTurns({ store, verifyOwnerEvidence: opts.turnVerifier ?? strictTrue, now });
  const clarifications = createSessionClarifications({
    store, verifyOwnerEvidence: opts.ownerVerifier ?? strictTrue,
    verifyPendingQuestion: opts.pendingVerifier ?? strictTrue, now,
  });
  return { file, store, records, bindings, turns, clarifications, now };
}

const RAW_FLAGS = { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false };
function rawGet(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true, ...RAW_FLAGS });
  try { const r = db.prepare(sql).get(...params); return r === undefined ? undefined : { ...r }; }
  finally { db.close(); }
}
function rawAll(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true, ...RAW_FLAGS });
  try { return db.prepare(sql).all(...params).map(r => ({ ...r })); }
  finally { db.close(); }
}
function rawRun(file, sql, params = []) {
  const db = new DatabaseSync(file, { ...RAW_FLAGS });
  try { return db.prepare(sql).run(...params); }
  finally { db.close(); }
}

function expectCode(fn, code) {
  try { fn(); } catch (e) { expect(e?.code).toBe(code); return e; }
  throw new Error(`expected throw ${code}`);
}

function seedProject(records, id) { return records.createProject({ id, name: `p-${id.slice(-4)}`, pathCanonical: `/tmp/${id}` }); }
function seedCodex(records, id, projectId) { return records.createConversation({ id, projectId, controller: "codex" }); }
function seedClaude(records, id, projectId, requested) { return records.createConversation({ id, projectId, controller: "claude", requestedClaudeSessionUuid: requested }); }
function claim(bindings, projectId, conversationId, token = T1) { return bindings.claimProducer({ projectId, conversationId, ownerToken: token, expectedGeneration: 0, evidence: null }); }
function sc(projectId, conversationId, o = {}) { return { projectId, conversationId, ownerToken: T1, ownerGeneration: 1, hostGeneration: H1, evidence: null, ...o }; }

function observedCodex(turns, bindings, projectId, conversationId, thread, turnId, handoffId) {
  bindings.bindNativeRef({ projectId, conversationId, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: thread, evidence: null });
  const s = { ...sc(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt: "work" });
  turns.beginDispatch(s);
  const nt = `nt-${turnId.slice(-4)}`;
  turns.recordObserved({ ...s, nativeFact: { nativeIdentity: thread, nativeTurnId: nt, claudeInputUuid: null } });
  return { s, nativeTurnId: nt };
}

function observedClaude(turns, bindings, projectId, conversationId, requested, inputUuid, turnId, handoffId) {
  bindings.setRequestedClaudeSession({ projectId, conversationId, ownerToken: T1, generation: 1, sessionUuid: requested, evidence: null });
  bindings.bindNativeRef({ projectId, conversationId, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: requested, evidence: null });
  const s = { ...sc(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt: "work", claudeInputUuid: inputUuid });
  turns.beginDispatch(s);
  turns.recordObserved({ ...s, nativeFact: { nativeIdentity: requested, nativeTurnId: null, claudeInputUuid: inputUuid } });
  return s;
}

function codexQuestions(id = "choice-1") {
  return [{ id, header: "Pick", question: "Which option?", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: false, isOther: true }];
}
function asyncQuestions() {
  return [{ id: "0", header: "Question 1", question: "Proceed?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false, isOther: true }];
}
function claudeQuestions() {
  return [{ id: "Pick colour", header: "Colour", question: "Pick colour", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false, isOther: true }];
}

function regCodex(projectId, conversationId, turnId, clarId, extra = {}) {
  return { ...sc(projectId, conversationId), turnId, clarificationId: clarId, route: "codex_request", connectionId: C1, nativeItemId: "item-1", nativeRequestId: 42, questions: codexQuestions(), pendingEvidence: null, ...extra };
}
function regAsync(projectId, conversationId, turnId, clarId, extra = {}) {
  return { ...sc(projectId, conversationId), turnId, clarificationId: clarId, route: "codex_async", connectionId: C1, nativeItemId: "async-item-1", nativeRequestId: null, questions: asyncQuestions(), pendingEvidence: null, ...extra };
}
function regClaude(projectId, conversationId, turnId, clarId, extra = {}) {
  return { ...sc(projectId, conversationId), turnId, clarificationId: clarId, route: "claude_request", connectionId: C1, nativeItemId: "claude-item-1", nativeRequestId: "req-str-1", questions: claudeQuestions(), pendingEvidence: null, ...extra };
}

describe("session-clarifications", () => {

  describe("factory validation", () => {
    it("rejects missing store", () => {
      expectCode(() => createSessionClarifications({ verifyOwnerEvidence: strictTrue, verifyPendingQuestion: strictTrue }), "ERR_INVALID_RECORD");
    });
    it("rejects missing verifiers", () => {
      const dir = tmp(); const file = join(dir, "s.db"); const store = openSessionStore({ databasePath: file }); stores.push(store);
      expectCode(() => createSessionClarifications({ store, verifyPendingQuestion: strictTrue }), "ERR_INVALID_RECORD");
      expectCode(() => createSessionClarifications({ store, verifyOwnerEvidence: strictTrue }), "ERR_INVALID_RECORD");
    });
    it("returns frozen API with all methods", () => {
      const dir = tmp(); const { clarifications } = openFresh(dir);
      expect(Object.isFrozen(clarifications)).toBe(true);
      for (const m of ["registerClarification","queueAnswer","beginAnswerDispatch","settleAnswer","retireClarification","getClarification","getAnswerAttempt","listAnswerAttempts","inTransaction"])
        expect(typeof clarifications[m]).toBe("function");
    });
  });

  describe("registration codex_request", () => {
    it("registers on observed nonterminal parent", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const r = clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      expect(r.created).toBe(true);
      expect(r.clarification.status).toBe("pending");
      expect(r.clarification.request.route).toBe("codex_request");
      expect(r.clarification.request.nativeRequestId).toBe(42);
      const row = rawGet(file, "SELECT id,status,native_question_id FROM clarifications WHERE id=?", [Q1]);
      expect(row.status).toBe("pending");
      expect(row.native_question_id).toContain("codex_request");
    });
    it("rejects unobserved parent", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      const s = { ...sc(P1, CX), turnId: T1, operationId: uid(900) };
      turns.queueTurn({ ...s, prompt: "work" });
      expectCode(() => clarifications.registerClarification(regCodex(P1, CX, T1, Q1)), "ERR_CLARIFICATION_STATE");
    });
    it("rejects route/controller mismatch", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), route: "claude_request" }), "ERR_CLARIFICATION_STATE");
    });
  });

  describe("registration codex_async", () => {
    it("registers with null nativeRequestId", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const r = clarifications.registerClarification(regAsync(P1, CX, T1, Q1));
      expect(r.created).toBe(true);
      expect(r.clarification.request.nativeRequestId).toBeNull();
      const row = rawGet(file, "SELECT native_question_id FROM clarifications WHERE id=?", [Q1]);
      expect(row.native_question_id).toContain("item");
    });
    it("rejects non-null nativeRequestId for async", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      expectCode(() => clarifications.registerClarification({ ...regAsync(P1, CX, T1, Q1), nativeRequestId: 99 }), "ERR_INVALID_RECORD");
    });
  });

  describe("registration claude_request", () => {
    it("registers on observed Claude turn", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedClaude(records, CL, P1, CS1); claim(bindings, P1, CL);
      observedClaude(turns, bindings, P1, CL, CS1, CI1, T1, uid(900));
      const r = clarifications.registerClarification(regClaude(P1, CL, T1, Q1));
      expect(r.created).toBe(true);
      expect(r.clarification.request.controller).toBe("claude");
      expect(r.clarification.request.claudeInputUuid).toBe(CI1);
    });
    it("rejects Claude without requested session", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedClaude(records, CL, P1, null); claim(bindings, P1, CL);
      const s = { ...sc(P1, CL), turnId: T1, operationId: uid(900) };
      turns.queueTurn({ ...s, prompt: "work", claudeInputUuid: CI1 });
      expectCode(() => clarifications.registerClarification(regClaude(P1, CL, T1, Q1)), "ERR_CLARIFICATION_STATE");
    });
  });

  describe("registration idempotency", () => {
    it("same UUID+payload returns created:false no new permission", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const args = regCodex(P1, CX, T1, Q1);
      const r1 = clarifications.registerClarification(args);
      const r2 = clarifications.registerClarification(args);
      expect(r1.created).toBe(true);
      expect(r2.created).toBe(false);
      expect(r2.clarification.id).toBe(Q1);
    });
    it("same UUID different payload rejects ERR_IDEMPOTENCY_CONFLICT", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), nativeItemId: "item-2" }), "ERR_IDEMPOTENCY_CONFLICT");
    });
  });

  describe("registration collisions", () => {
    it("distinct pending on same native_question_id same host rejects", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q2), nativeRequestId: 42 }), "ERR_CLARIFICATION_CONFLICT");
    });
    it("unknown answer blocks new incarnation same native_question_id", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "unknown", request: null });
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q2), nativeRequestId: 42 }), "ERR_CLARIFICATION_CONFLICT");
    });
  });

  describe("pending verifier strictness", () => {
    it("throws ERR_QUESTION_UNVERIFIED on false", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir, { pendingVerifier: () => false });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      expectCode(() => clarifications.registerClarification(regCodex(P1, CX, T1, Q1)), "ERR_QUESTION_UNVERIFIED");
    });
    it("throws on thenable (consumes rejection)", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir, { pendingVerifier: () => Promise.reject(new Error("x")) });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      expectCode(() => clarifications.registerClarification(regCodex(P1, CX, T1, Q1)), "ERR_QUESTION_UNVERIFIED");
    });
    it("receives frozen facts with original evidence identity", () => {
      const dir = tmp(); const evidence = { tag: "ev", self: null }; evidence.self = evidence;
      let received;
      const { records, bindings, turns, clarifications } = openFresh(dir, { pendingVerifier: (f) => { received = f; return true; } });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), pendingEvidence: evidence });
      expect(received.evidence).toBe(evidence);
      expect(received.evidence.self).toBe(evidence);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.request)).toBe(true);
      expect(Object.isFrozen(received.questions)).toBe(true);
    });
  });

  describe("queueAnswer valid", () => {
    it("queues valid answer creates queued attempt", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.attempt.state).toBe("queued");
      expect(r.attempt.outcome).toBeNull();
      expect(r.clarification.status).toBe("pending");
      const row = rawGet(file, "SELECT state FROM operations WHERE id=?", [A1]);
      expect(row.state).toBe("queued");
    });
    it("queues from invalid question status back to pending", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.clarification.status).toBe("pending");
    });
  });

  describe("queueAnswer invalid semantics", () => {
    it("invalid answers persist terminal invalid attempt", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.attempt.state).toBe("invalid");
      expect(r.attempt.outcome).toBe("invalid");
      expect(r.clarification.status).toBe("invalid");
      const row = rawGet(file, "SELECT state,settled_at_ms FROM operations WHERE id=?", [A1]);
      expect(row.state).toBe("invalid");
      expect(row.settled_at_ms).not.toBeNull();
    });
    it("invalid then corrected new operation persists both", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.attempt.state).toBe("queued");
      const ops = rawAll(file, "SELECT id,state FROM operations WHERE decision=? ORDER BY created_at_ms", [Q1]);
      expect(ops.length).toBe(2);
      expect(ops[0].state).toBe("invalid");
      expect(ops[1].state).toBe("queued");
    });
  });

  describe("queueAnswer idempotency and limits", () => {
    it("same operationId same payload returns created:false", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const args = { ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null };
      clarifications.queueAnswer(args);
      const r = clarifications.queueAnswer(args);
      expect(r.created).toBe(false);
      expect(r.attempt.id).toBe(A1);
    });
    it("rejects second active attempt for same question", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      expectCode(() => clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["B"] }, pendingEvidence: null }), "ERR_CLARIFICATION_STATE");
    });
  });

  describe("beginAnswerDispatch", () => {
    it("transitions queued to dispatching once", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const a = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      expect(a.state).toBe("dispatching");
      const row = rawGet(file, "SELECT state FROM operations WHERE id=?", [A1]);
      expect(row.state).toBe("dispatching");
    });
    it("repeated begin rejects ERR_DISPATCH_CONFLICT", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      expectCode(() => clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null }), "ERR_DISPATCH_CONFLICT");
    });
    it("retired question blocks begin", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.retireClarification(sc(P1, CX) && { ...sc(P1, CX), turnId: T1, clarificationId: Q1 });
      expectCode(() => clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null }), "ERR_CLARIFICATION_STATE");
    });
  });

  describe("settleAnswer written/acknowledged", () => {
    it("written settles codex_request attempt and question", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      const { nativeTurnId } = observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      expect(r.attempt.state).toBe("written");
      expect(r.clarification.status).toBe("answered");
      expect(r.clarification.answer.outcome).toBe("written");
      const row = rawGet(file, "SELECT status,answer_json FROM clarifications WHERE id=?", [Q1]);
      expect(row.status).toBe("answered");
      expect(row.answer_json).toContain("written");
    });
    it("acknowledged settles codex_async attempt", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regAsync(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "0": ["Yes"] }, pendingEvidence: null });
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "acknowledged", request: disp.request });
      expect(r.attempt.state).toBe("acknowledged");
      expect(r.clarification.status).toBe("answered");
    });
    it("written rejects codex_async route", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regAsync(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "0": ["Yes"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      expectCode(() => clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: null }), "ERR_ANSWER_STATE");
    });
    it("acknowledged rejects codex_request route", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      expectCode(() => clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "acknowledged", request: null }), "ERR_ANSWER_STATE");
    });
  });

  describe("settleAnswer not_sent/invalid", () => {
    it("not_sent from queued keeps question pending", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "not_sent", request: null });
      expect(r.attempt.state).toBe("not_sent");
      expect(r.clarification.status).toBe("pending");
    });
    it("not_sent then new operation permitted", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "not_sent", request: null });
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["B"] }, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.attempt.state).toBe("queued");
    });
    it("old UUID never readmitted after not_sent", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "not_sent", request: null });
      expectCode(() => clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null }), "ERR_DISPATCH_CONFLICT");
    });
  });

  describe("settleAnswer unknown/unactionable", () => {
    it("unknown makes question unactionable blocks new queue", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "unknown", request: null });
      expect(r.attempt.state).toBe("unknown");
      expect(r.clarification.status).toBe("unactionable");
      expectCode(() => clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["B"] }, pendingEvidence: null }), "ERR_CLARIFICATION_STATE");
    });
    it("unactionable only from queued no request", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "unactionable", request: null });
      expect(r.attempt.state).toBe("unactionable");
      expect(r.clarification.status).toBe("unactionable");
    });
    it("unactionable rejects from dispatching", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      expectCode(() => clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "unactionable", request: null }), "ERR_ANSWER_STATE");
    });
  });

  describe("settleAnswer terminal retry", () => {
    it("exact terminal retry returns unchanged records", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const r1 = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      const r2 = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      expect(r2.attempt.state).toBe("written");
      expect(r2.clarification.status).toBe("answered");
    });
    it("changed terminal outcome rejects ERR_ANSWER_CONFLICT", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      expectCode(() => clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "not_sent", request: disp.request }), "ERR_ANSWER_CONFLICT");
    });
  });

  describe("retireClarification", () => {
    it("retires pending to unactionable", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const r = clarifications.retireClarification({ ...sc(P1, CX), turnId: T1, clarificationId: Q1 });
      expect(r.status).toBe("unactionable");
    });
    it("retire after begin leaves dispatching attempt settleable", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      clarifications.retireClarification({ ...sc(P1, CX), turnId: T1, clarificationId: Q1 });
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      expect(r.attempt.state).toBe("written");
      expect(r.clarification.status).toBe("unactionable");
    });
  });

  describe("reads", () => {
    it("getClarification returns full record or null", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const c = clarifications.getClarification({ projectId: P1, conversationId: CX, clarificationId: Q1 });
      expect(c.id).toBe(Q1);
      expect(c.status).toBe("pending");
      expect(c.answer).toBeNull();
      const missing = clarifications.getClarification({ projectId: P1, conversationId: CX, clarificationId: Q2 });
      expect(missing).toBeNull();
    });
    it("getAnswerAttempt returns record or null", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const a = clarifications.getAnswerAttempt({ projectId: P1, conversationId: CX, operationId: A1 });
      expect(a.id).toBe(A1);
      expect(a.state).toBe("queued");
      expect(a.history[0].kind).toBe("queued");
      expect(clarifications.getAnswerAttempt({ projectId: P1, conversationId: CX, operationId: A2 })).toBeNull();
    });
  });

  describe("listAnswerAttempts", () => {
    it("returns metadata ordered by created_at_ms,id", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const list = clarifications.listAnswerAttempts({ projectId: P1, conversationId: CX, clarificationId: Q1 });
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(A1);
      expect(list[0].state).toBe("invalid");
      expect(list[1].id).toBe(A2);
      expect(list[1].state).toBe("queued");
      expect(list[0].answers).toBeUndefined();
    });
    it("cursor pagination works", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      const first = clarifications.listAnswerAttempts({ projectId: P1, conversationId: CX, clarificationId: Q1, limit: 1 });
      expect(first.length).toBe(1);
      const second = clarifications.listAnswerAttempts({ projectId: P1, conversationId: CX, clarificationId: Q1, limit: 1, after: { createdAtMs: first[0].createdAtMs, id: first[0].id } });
      expect(second.length).toBe(1);
      expect(second[0].id).toBe(A2);
    });
  });

  describe("owner/generation enforcement", () => {
    it("wrong owner token rejects every mutation", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const bad = { ...sc(P1, CX), ownerToken: T2 };
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), ...bad }), "ERR_FENCE_CONFLICT");
    });
    it("generation 2 takeover denies old records", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const gen2 = { ...sc(P1, CX), ownerGeneration: 2 };
      expectCode(() => clarifications.queueAnswer({ ...gen2, turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null }), "ERR_FENCE_CONFLICT");
    });
    it("reads are proof-free no verifier called", () => {
      let called = false;
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir, { ownerVerifier: () => { called = true; return true; } });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      called = false;
      clarifications.getClarification({ projectId: P1, conversationId: CX, clarificationId: Q1 });
      expect(called).toBe(false);
    });
  });

  describe("atomicity and rollback", () => {
    it("outer transaction rollback leaves question and operations unchanged", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, store, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const beforeQ = rawGet(file, "SELECT status FROM clarifications WHERE id=?", [Q1]);
      const beforeOps = rawGet(file, "SELECT COUNT(*) as c FROM operations");
      const beforeProj = rawGet(file, "SELECT name FROM projects WHERE id=?", [P1]);
      try {
        store.transaction((tx) => {
          const inner = clarifications.inTransaction(tx);
          inner.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
          tx.run("UPDATE projects SET name=? WHERE id=?", ["mutated", P1]);
          throw new Error("rollback-marker");
        });
      } catch (e) { expect(e.message).toBe("rollback-marker"); }
      const afterQ = rawGet(file, "SELECT status FROM clarifications WHERE id=?", [Q1]);
      const afterOps = rawGet(file, "SELECT COUNT(*) as c FROM operations");
      const afterProj = rawGet(file, "SELECT name FROM projects WHERE id=?", [P1]);
      expect(afterQ.status).toBe(beforeQ.status);
      expect(afterOps.c).toBe(beforeOps.c);
      expect(afterProj.name).toBe(beforeProj.name);
    });
    it("INSERT fault during queue rolls back question projection", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, store, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": [] }, pendingEvidence: null });
      const qBefore = rawGet(file, "SELECT status FROM clarifications WHERE id=?", [Q1]);
      expect(qBefore.status).toBe("invalid");
      let err;
      try {
        store.transaction((tx) => {
          const inner = clarifications.inTransaction(tx);
          inner.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": ["A"] }, pendingEvidence: null });
          tx.run("UPDATE clarifications SET question_json='CORRUPT' WHERE id=?", [Q1]);
          inner.getClarification({ projectId: P1, conversationId: CX, clarificationId: Q1 });
        });
      } catch (e) { err = e; }
      expect(err?.code).toBe("ERR_STORAGE");
      const qAfter = rawGet(file, "SELECT status FROM clarifications WHERE id=?", [Q1]);
      expect(qAfter.status).toBe("invalid");
    });
  });

  describe("stored corruption fail-closed", () => {
    it("malformed question_json version rejects ERR_STORAGE", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const badJson = JSON.stringify({ v: 99, hash: "0".repeat(64), ownerGeneration: 1, hostGeneration: H1, createdAtMs: 1, request: { route: "codex_request", controller: "codex", connectionId: C1, nativeIdentity: TH1, nativeTurnId: "nt-900", claudeInputUuid: null, nativeItemId: "item-1", nativeRequestId: 42 }, questions: [{ id: "x", header: "H", question: "Q", multiSelect: false, isOther: true, options: null }] });
      rawRun(file, "UPDATE clarifications SET question_json=? WHERE id=?", [badJson, Q1]);
      expectCode(() => clarifications.getClarification({ projectId: P1, conversationId: CX, clarificationId: Q1 }), "ERR_STORAGE");
    });
    it("orphan operation without question rejects ERR_STORAGE", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      rawRun(file, "DELETE FROM clarifications WHERE id=?", [Q1]);
      expectCode(() => clarifications.getAnswerAttempt({ projectId: P1, conversationId: CX, operationId: A1 }), "ERR_STORAGE");
    });
  });

  describe("Unicode and prototype keys", () => {
    it("preserves non-BMP and prototype-like question IDs byte-exact", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const qs = [{ id: "__proto__", header: "H", question: "Q\u{1F600}", options: [{ label: "A", description: "" }], multiSelect: false, isOther: true }];
      const r = clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), questions: qs });
      expect(r.clarification.questions[0].id).toBe("__proto__");
      expect(r.clarification.questions[0].question).toBe("Q\u{1F600}");
    });
    it("preserves __proto__ answer key as own property in frozen callback", () => {
      const dir = tmp(); let received;
      const { records, bindings, turns, clarifications } = openFresh(dir, { pendingVerifier: (f) => { received = f; return true; } });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const answers = Object.fromEntries([["__proto__", ["val"]]]);
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers, pendingEvidence: null });
      expect(Object.prototype.hasOwnProperty.call(received.answers, "__proto__")).toBe(true);
      expect(Object.isFrozen(received.answers)).toBe(true);
    });
  });

  describe("deepClone/verifyPending regression", () => {
    it("cyclic evidence reaches callback unchanged not frozen", () => {
      const dir = tmp(); const ev = { a: 1 }; ev.self = ev;
      let received;
      const { records, bindings, turns, clarifications } = openFresh(dir, { pendingVerifier: (f) => { received = f; return true; } });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), pendingEvidence: ev });
      expect(received.evidence).toBe(ev);
      expect(received.evidence.self).toBe(ev);
      expect(Object.isFrozen(ev)).toBe(false);
    });
    it("callback authorizes and valid attempt persists original answers", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const answers = { "choice-1": ["A", "B"] };
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers, pendingEvidence: null });
      const row = rawGet(file, "SELECT result_json FROM operations WHERE id=?", [A1]);
      const parsed = JSON.parse(row.result_json);
      expect(parsed.answers["choice-1"]).toEqual(["A", "B"]);
    });
  });

  describe("inTransaction", () => {
    it("returns frozen API with same 8 methods on active tx", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, store } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      store.transaction((tx) => {
        const inner = clarifications.inTransaction(tx);
        expect(Object.isFrozen(inner)).toBe(true);
        for (const m of ["registerClarification","queueAnswer","beginAnswerDispatch","settleAnswer","retireClarification","getClarification","getAnswerAttempt","listAnswerAttempts"])
          expect(typeof inner[m]).toBe("function");
      });
    });
    it("rejects foreign lineage", () => {
      const dir1 = tmp(); const { clarifications } = openFresh(dir1);
      const dir2 = tmp(); const { store: store2 } = openFresh(dir2);
      store2.transaction((tx) => {
        expectCode(() => clarifications.inTransaction(tx), "ERR_STORAGE");
      });
    });
  });

  describe("typed native request IDs", () => {
    it("integer 0 vs string 0 are distinct typed IDs", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const r1 = clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), nativeRequestId: 0 });
      expect(r1.created).toBe(true);
      const r2 = clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q2), nativeRequestId: "0" });
      expect(r2.created).toBe(true);
    });
    it("async stores NULL native_request_id columns", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regAsync(P1, CX, T1, Q1));
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "0": ["Yes"] }, pendingEvidence: null });
      const row = rawGet(file, "SELECT native_request_id_text,native_request_id_type FROM operations WHERE id=?", [A1]);
      expect(row.native_request_id_text).toBeNull();
      expect(row.native_request_id_type).toBeNull();
    });
  });

  describe("caps reject not truncate", () => {
    it("oversized question JSON rejects ERR_INVALID_RECORD", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const bigQ = "x".repeat(2049);
      const qs = [{ id: "q1", header: "H", question: bigQ, options: [{ label: "A", description: "" }], multiSelect: false, isOther: true }];
      expectCode(() => clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), questions: qs }), "ERR_INVALID_RECORD");
    });
  });

  describe("normalized-parser equality", () => {
    it("Claude wrong id rejects with no question row", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedClaude(records, CL, P1, CS1); claim(bindings, P1, CL);
      observedClaude(turns, bindings, P1, CL, CS1, CI1, T1, uid(900));
      const qs = [{ id: "wrong-id", header: "Colour", question: "Pick colour", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false, isOther: true }];
      expectCode(() => clarifications.registerClarification({ ...regClaude(P1, CL, T1, Q1), questions: qs }), "ERR_INVALID_RECORD");
      const row = rawGet(file, "SELECT id FROM clarifications WHERE id=?", [Q1]);
      expect(row).toBeUndefined();
    });
    it("async wrong index rejects with no row", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const qs = [{ id: "custom", header: "Question 1", question: "Proceed?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false, isOther: true }];
      expectCode(() => clarifications.registerClarification({ ...regAsync(P1, CX, T1, Q1), questions: qs }), "ERR_INVALID_RECORD");
      const row = rawGet(file, "SELECT id FROM clarifications WHERE id=?", [Q1]);
      expect(row).toBeUndefined();
    });
    it("async wrong header rejects with no row", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const qs = [{ id: "0", header: "Custom Header", question: "Proceed?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false, isOther: true }];
      expectCode(() => clarifications.registerClarification({ ...regAsync(P1, CX, T1, Q1), questions: qs }), "ERR_INVALID_RECORD");
      const row = rawGet(file, "SELECT id FROM clarifications WHERE id=?", [Q1]);
      expect(row).toBeUndefined();
    });
    it("async nonempty description rejects with no row", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const qs = [{ id: "0", header: "Question 1", question: "Proceed?", options: [{ label: "Yes", description: "affirmative" }, { label: "No", description: "" }], multiSelect: false, isOther: true }];
      expectCode(() => clarifications.registerClarification({ ...regAsync(P1, CX, T1, Q1), questions: qs }), "ERR_INVALID_RECORD");
      const row = rawGet(file, "SELECT id FROM clarifications WHERE id=?", [Q1]);
      expect(row).toBeUndefined();
    });
    it("async canonical index/header/empty-desc accepted", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const r = clarifications.registerClarification(regAsync(P1, CX, T1, Q1));
      expect(r.created).toBe(true);
      expect(r.clarification.status).toBe("pending");
    });
    it("Claude canonical id===question accepted", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedClaude(records, CL, P1, CS1); claim(bindings, P1, CL);
      observedClaude(turns, bindings, P1, CL, CS1, CI1, T1, uid(900));
      const r = clarifications.registerClarification(regClaude(P1, CL, T1, Q1));
      expect(r.created).toBe(true);
      expect(r.clarification.questions[0].id).toBe("Pick colour");
    });
    it("same canonical fields reordered in incoming object exact-retry stays created:false", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      const qs1 = [{ id: "choice-1", header: "Pick", question: "Which option?", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: false, isOther: true }];
      const qs2 = [{ question: "Which option?", options: [{ description: "first", label: "A" }, { description: "second", label: "B" }], isOther: true, multiSelect: false, header: "Pick", id: "choice-1" }];
      const r1 = clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), questions: qs1 });
      expect(r1.created).toBe(true);
      const r2 = clarifications.registerClarification({ ...regCodex(P1, CX, T1, Q1), questions: qs2 });
      expect(r2.created).toBe(false);
      expect(r2.clarification.id).toBe(Q1);
    });
  });

  describe("clock-order enforcement", () => {
    it("queue before question creation rejects ERR_INVALID_RECORD valid and invalid", () => {
      const dir = tmp(); let t = 1000;
      const { records, bindings, turns, clarifications, file } = openFresh(dir, { now: () => t });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const qBefore = rawGet(file, "SELECT status,question_json FROM clarifications WHERE id=?", [Q1]);
      t = 999;
      expectCode(() => clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null }), "ERR_INVALID_RECORD");
      expectCode(() => clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A2, answers: { "choice-1": [] }, pendingEvidence: null }), "ERR_INVALID_RECORD");
      const qAfter = rawGet(file, "SELECT status,question_json FROM clarifications WHERE id=?", [Q1]);
      expect(qAfter.status).toBe(qBefore.status);
      expect(qAfter.question_json).toBe(qBefore.question_json);
      const ops = rawAll(file, "SELECT id FROM operations WHERE decision=?", [Q1]);
      expect(ops.length).toBe(0);
    });
    it("settle before begin dispatch rejects ERR_INVALID_RECORD raw unchanged", () => {
      const dir = tmp(); let t = 1000;
      const { records, bindings, turns, clarifications, file } = openFresh(dir, { now: () => t });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      t = 1100;
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      t = 1200;
      clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const qBefore = rawGet(file, "SELECT status,question_json FROM clarifications WHERE id=?", [Q1]);
      const opBefore = rawGet(file, "SELECT state,history_json,result_json,settled_at_ms FROM operations WHERE id=?", [A1]);
      t = 1150;
      expectCode(() => clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "not_sent", request: null }), "ERR_INVALID_RECORD");
      const qAfter = rawGet(file, "SELECT status,question_json FROM clarifications WHERE id=?", [Q1]);
      const opAfter = rawGet(file, "SELECT state,history_json,result_json,settled_at_ms FROM operations WHERE id=?", [A1]);
      expect(qAfter.status).toBe(qBefore.status);
      expect(qAfter.question_json).toBe(qBefore.question_json);
      expect(opAfter.state).toBe(opBefore.state);
      expect(opAfter.history_json).toBe(opBefore.history_json);
      expect(opAfter.result_json).toBe(opBefore.result_json);
      expect(opAfter.settled_at_ms).toBe(opBefore.settled_at_ms);
    });
    it("settle at or after begin succeeds", () => {
      const dir = tmp(); let t = 1000;
      const { records, bindings, turns, clarifications } = openFresh(dir, { now: () => t });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      t = 1100;
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      t = 1200;
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      t = 1200;
      const r = clarifications.settleAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request });
      expect(r.attempt.state).toBe("written");
      expect(r.clarification.status).toBe("answered");
    });
    it("exact queue retry with earlier timestamp returns created:false raw unchanged", () => {
      const dir = tmp(); let t = 1000;
      const { records, bindings, turns, clarifications, file } = openFresh(dir, { now: () => t });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      t = 1100;
      const args = { ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null };
      clarifications.queueAnswer(args);
      const opBefore = rawGet(file, "SELECT state,history_json,result_json FROM operations WHERE id=?", [A1]);
      t = 500;
      const r = clarifications.queueAnswer(args);
      expect(r.created).toBe(false);
      expect(r.attempt.id).toBe(A1);
      const opAfter = rawGet(file, "SELECT state,history_json,result_json FROM operations WHERE id=?", [A1]);
      expect(opAfter.state).toBe(opBefore.state);
      expect(opAfter.history_json).toBe(opBefore.history_json);
      expect(opAfter.result_json).toBe(opBefore.result_json);
    });
    it("exact terminal retry with earlier timestamp returns same records raw unchanged", () => {
      const dir = tmp(); let t = 1000;
      const { records, bindings, turns, clarifications, file } = openFresh(dir, { now: () => t });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      t = 1100;
      clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: { "choice-1": ["A"] }, pendingEvidence: null });
      t = 1200;
      const disp = clarifications.beginAnswerDispatch({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, pendingEvidence: null });
      const settleArgs = { ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, outcome: "written", request: disp.request };
      clarifications.settleAnswer(settleArgs);
      const qBefore = rawGet(file, "SELECT status,answer_json,answered_at_ms FROM clarifications WHERE id=?", [Q1]);
      const opBefore = rawGet(file, "SELECT state,history_json,result_json,settled_at_ms FROM operations WHERE id=?", [A1]);
      t = 500;
      const r = clarifications.settleAnswer(settleArgs);
      expect(r.attempt.state).toBe("written");
      expect(r.clarification.status).toBe("answered");
      const qAfter = rawGet(file, "SELECT status,answer_json,answered_at_ms FROM clarifications WHERE id=?", [Q1]);
      const opAfter = rawGet(file, "SELECT state,history_json,result_json,settled_at_ms FROM operations WHERE id=?", [A1]);
      expect(qAfter.status).toBe(qBefore.status);
      expect(qAfter.answer_json).toBe(qBefore.answer_json);
      expect(qAfter.answered_at_ms).toBe(qBefore.answered_at_ms);
      expect(opAfter.state).toBe(opBefore.state);
      expect(opAfter.history_json).toBe(opBefore.history_json);
      expect(opAfter.result_json).toBe(opBefore.result_json);
      expect(opAfter.settled_at_ms).toBe(opBefore.settled_at_ms);
    });
  });

  describe("answer map shape", () => {
    it("Date answer map rejects ERR_INVALID_RECORD before attempt", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      expectCode(() => clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: new Date(), pendingEvidence: null }), "ERR_INVALID_RECORD");
      const row = rawGet(file, "SELECT id FROM operations WHERE id=?", [A1]);
      expect(row).toBeUndefined();
    });
    it("plain-empty map persists invalid attempt", () => {
      const dir = tmp(); const { records, bindings, turns, clarifications, file } = openFresh(dir);
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, uid(900));
      clarifications.registerClarification(regCodex(P1, CX, T1, Q1));
      const r = clarifications.queueAnswer({ ...sc(P1, CX), turnId: T1, clarificationId: Q1, operationId: A1, answers: {}, pendingEvidence: null });
      expect(r.created).toBe(true);
      expect(r.attempt.state).toBe("invalid");
      expect(r.attempt.outcome).toBe("invalid");
      const row = rawGet(file, "SELECT state FROM operations WHERE id=?", [A1]);
      expect(row.state).toBe("invalid");
    });
  });

});
