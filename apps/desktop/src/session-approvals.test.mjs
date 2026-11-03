// CHO-03 durable approval journal tests: real temp SQLite fixtures only.
// Projects/conversations from S2a records, fences/native refs from S2b bindings,
// turns from S2c turns. Covers factory validation, registration idempotency and
// conflicts, native-ID collision/reuse, pending-verifier strictness, decision
// immutability, one-shot begin, terminal settle rules, proof-free reads,
// inTransaction lineage/rollback, trigger-abort atomicity, and stored-shape
// corruption. No implementation-mirroring mocks: raw SQL reads verify no-touch
// invariants and deliberate corruption uses trusted store transactions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";
import { createSessionApprovals } from "../server/session-approvals.mjs";

const dirs = [];
const stores = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cho-appr-")); dirs.push(d); return d; };
const uid = (n) => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`;
const P1 = uid(1), P2 = uid(2);
const CX = uid(101), CL = uid(102), CX2 = uid(103);
const T1 = uid(201), T2 = uid(202);
const H1 = uid(211), H2 = uid(212);
const A1 = uid(301), A2 = uid(302), A3 = uid(303);
const C1 = uid(401), C2 = uid(402);
const TH1 = "thread-alpha", TH2 = "thread-beta";
const IN1 = uid(501);

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
  const approvals = createSessionApprovals({
    store, verifyOwnerEvidence: opts.ownerVerifier ?? strictTrue,
    verifyPendingApproval: opts.pendingVerifier ?? strictTrue, now,
  });
  return { file, store, records, bindings, turns, approvals, now };
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

function expectCode(fn, code) {
  try { fn(); } catch (e) { expect(e?.code).toBe(code); return e; }
  throw new Error(`expected throw ${code}`);
}

function seedProject(records, id) {
  return records.createProject({ id, name: `p-${id.slice(-4)}`, pathCanonical: `/tmp/${id}` });
}
function seedCodex(records, id, projectId) {
  return records.createConversation({ id, projectId, controller: "codex" });
}
function seedClaude(records, id, projectId, requested) {
  return records.createConversation({ id, projectId, controller: "claude", requestedClaudeSessionUuid: requested });
}
function claim(bindings, projectId, conversationId, token = T1) {
  return bindings.claimProducer({ projectId, conversationId, ownerToken: token, expectedGeneration: 0, evidence: null });
}
function sc(projectId, conversationId, o = {}) {
  return { projectId, conversationId, ownerToken: T1, ownerGeneration: 1, hostGeneration: H1, evidence: null, ...o };
}

function observedCodex(turns, bindings, projectId, conversationId, thread, turnId, handoffId) {
  bindings.bindNativeRef({ projectId, conversationId, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: thread, evidence: null });
  const s = { ...sc(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt: "work" });
  turns.beginDispatch(s);
  const nt = `nt-${turnId.slice(-4)}`;
  turns.recordObserved({ ...s, nativeFact: { nativeIdentity: thread, nativeTurnId: nt, claudeInputUuid: null } });
  return { s, nativeTurnId: nt };
}

function observedClaude(turns, bindings, records, projectId, conversationId, requested, inputUuid, turnId, handoffId) {
  bindings.setRequestedClaudeSession({ projectId, conversationId, ownerToken: T1, generation: 1, sessionUuid: requested, evidence: null });
  bindings.bindNativeRef({ projectId, conversationId, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: requested, evidence: null });
  const s = { ...sc(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt: "work", claudeInputUuid: inputUuid });
  turns.beginDispatch(s);
  turns.recordObserved({ ...s, nativeFact: { nativeIdentity: requested, nativeTurnId: null, claudeInputUuid: inputUuid } });
  return s;
}

function regArgs(projectId, conversationId, turnId, operationId, extra = {}) {
  return {
    ...sc(projectId, conversationId), turnId, operationId,
    nativeRequestId: 42, connectionId: C1, nativeItemId: "item-1",
    approvalType: "command", decisions: ["accept", "decline", "cancel"],
    pendingEvidence: null, ...extra,
  };
}

describe("factory and input validation", () => {
  it("rejects missing store/verifiers and exposes frozen API", () => {
    expectCode(() => createSessionApprovals({}), "ERR_INVALID_RECORD");
    expectCode(() => createSessionApprovals({ store: {} }), "ERR_INVALID_RECORD");
    const dir = tmp();
    const { approvals } = openFresh(dir);
    expect(Object.isFrozen(approvals)).toBe(true);
    for (const m of ["registerApproval", "decideApproval", "beginApprovalDispatch", "settleApproval", "getApproval", "inTransaction"])
      expect(typeof approvals[m]).toBe("function");
  });

  it("rejects malformed scope and non-UUID operationId", () => {
    const dir = tmp();
    const { approvals } = openFresh(dir);
    expectCode(() => approvals.registerApproval({ projectId: "x" }), "ERR_INVALID_RECORD");
    expectCode(() => approvals.getApproval({ projectId: P1, conversationId: P1, operationId: "not-uuid" }), "ERR_INVALID_RECORD");
  });

  it("rejects -0 nativeRequestId and empty decisions", () => {
    const dir = tmp();
    const { approvals } = openFresh(dir);
    expectCode(() => approvals.registerApproval({ ...regArgs(P1, CX, T1, A1), nativeRequestId: -0 }), "ERR_INVALID_RECORD");
    expectCode(() => approvals.registerApproval({ ...regArgs(P1, CX, T1, A1), decisions: [] }), "ERR_INVALID_RECORD");
  });
});

describe("registration: fresh, idempotent, conflicts", () => {
  it("registers Codex approval with derived request and returns created:true", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    const { s, nativeTurnId } = observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    const res = approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expect(res.created).toBe(true);
    expect(res.approval.state).toBe("pending");
    expect(res.approval.request.controller).toBe("codex");
    expect(res.approval.request.nativeIdentity).toBe(TH1);
    expect(res.approval.request.nativeTurnId).toBe(nativeTurnId);
    expect(res.approval.request.decisions).toEqual(["accept", "decline", "cancel"]);
    const row = rawGet(file, "SELECT kind,state FROM operations WHERE id=?", [A2]);
    expect(row.kind).toBe("approval"); expect(row.state).toBe("pending");
  });

  it("exact retry returns created:false with same record, no new writes", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    const args = regArgs(P1, CX, T1, A2, { nativeRequestId: 7 });
    const first = approvals.registerApproval(args);
    const second = approvals.registerApproval(args);
    expect(second.created).toBe(false);
    expect(second.approval.id).toBe(first.approval.id);
    const rows = rawAll(file, "SELECT id FROM operations WHERE kind='approval'");
    expect(rows.length).toBe(1);
  });

  it("same opID different payload is ERR_IDEMPOTENCY_CONFLICT", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 99 })), "ERR_IDEMPOTENCY_CONFLICT");
  });

  it("wrong hostGeneration is ERR_FENCE_CONFLICT before idempotency check", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7, hostGeneration: H2 })), "ERR_FENCE_CONFLICT");
  });

  it("Claude tool approval derives claudeInputUuid from stored turn", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedClaude(records, CL, P1, IN1); claim(bindings, P1, CL);
    observedClaude(turns, bindings, records, P1, CL, IN1, uid(601), T1, A1);
    const res = approvals.registerApproval(regArgs(P1, CL, T1, A2, { approvalType: "tool", nativeRequestId: "req-x" }));
    expect(res.approval.request.controller).toBe("claude");
    expect(res.approval.request.claudeInputUuid).toBe(uid(601));
    expect(res.approval.request.nativeTurnId).toBeNull();
  });
});

describe("native-ID collision and reuse", () => {
  it("active same hostGen+typedID+connection blocks new registration", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, A3, { nativeRequestId: 7 })), "ERR_APPROVAL_CONFLICT");
  });

  it("different connectionId with same typedID is distinct", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7, connectionId: C1 }));
    const r = approvals.registerApproval(regArgs(P1, CX, T1, A3, { nativeRequestId: 7, connectionId: C2 }));
    expect(r.created).toBe(true);
  });

  it("written terminal frees typedID for new incarnation", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    const args = regArgs(P1, CX, T1, A2, { nativeRequestId: 7 });
    approvals.registerApproval(args);
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request });
    const r = approvals.registerApproval(regArgs(P1, CX, T1, A3, { nativeRequestId: 7 }));
    expect(r.created).toBe(true);
  });
});

describe("pending verifier strictness", () => {
  it("false/nonbool/throw/rejected-promise all yield ERR_APPROVAL_UNVERIFIED", () => {
    const dir = tmp();
    const { records, bindings, turns } = (() => {
      const d = tmp(); const f = join(d, "cho-sessions.sqlite3");
      const store = openSessionStore({ databasePath: f }); stores.push(store);
      const now = clock();
      const records = createSessionRecords({ store, now });
      const bindings = createSessionBindings({ store, verifyOwnerEvidence: strictTrue, now });
      const turns = createSessionTurns({ store, verifyOwnerEvidence: strictTrue, now });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
      return { records, bindings, turns, store };
    })();
    for (const bad of [() => false, () => 1, () => { throw new Error("x"); }, () => Promise.reject(new Error("r"))]) {
      const approvals = createSessionApprovals({ store: stores[stores.length - 1], verifyOwnerEvidence: strictTrue, verifyPendingApproval: bad, now: clock() });
      expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 })), "ERR_APPROVAL_UNVERIFIED");
    }
  });

  it("verifier receives deeply frozen facts with correct action", () => {
    const dir = tmp();
    let captured = null;
    const { records, bindings, turns, approvals } = openFresh(dir, {
      pendingVerifier: (facts) => { captured = facts; return true; },
    });
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expect(captured.action).toBe("register");
    expect(captured.approvalId).toBe(A2);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.request)).toBe(true);
    expect(Object.isFrozen(captured.request.decisions)).toBe(true);
  });
});

describe("decision flow", () => {
  it("pending->decided with offered choice; unoffered is ERR_APPROVAL_CONFLICT", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7, decisions: ["accept"] }));
    const rec = approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    expect(rec.state).toBe("decided"); expect(rec.decision).toBe("accept");
    expectCode(() => approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "decline", pendingEvidence: null }), "ERR_APPROVAL_CONFLICT");
  });

  it("same decision after decided returns current record, no writes", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    const before = rawGet(file, "SELECT history_json FROM operations WHERE id=?", [A2]);
    const again = approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    expect(again.state).toBe("decided");
    const after = rawGet(file, "SELECT history_json FROM operations WHERE id=?", [A2]);
    expect(after.history_json).toBe(before.history_json);
  });
});

describe("begin dispatch", () => {
  it("decided->dispatching one-shot; repeated begin is ERR_DISPATCH_CONFLICT", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    const rec = approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    expect(rec.state).toBe("dispatching");
    expectCode(() => approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null }), "ERR_DISPATCH_CONFLICT");
  });

  it("begin on pending (no decision) is ERR_APPROVAL_STATE", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expectCode(() => approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null }), "ERR_APPROVAL_STATE");
  });
});

describe("settle terminal states", () => {
  it("written requires dispatching + exact request; exact retry returns unchanged", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    const settled = approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request });
    expect(settled.state).toBe("written"); expect(settled.outcome).toBe("written");
    const retry = approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request });
    expect(retry.state).toBe("written");
  });

  it("changed outcome on terminal is ERR_APPROVAL_CONFLICT", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request });
    expectCode(() => approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "not_sent", request: rec.request }), "ERR_APPROVAL_CONFLICT");
  });

  it("unknown from pending allowed; unactionable from dispatching rejected", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    const unk = approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "unknown" });
    expect(unk.state).toBe("unknown");
    approvals.registerApproval(regArgs(P1, CX, T1, A3, { nativeRequestId: 8 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A3, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A3, pendingEvidence: null });
    expectCode(() => approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A3, outcome: "unactionable" }), "ERR_APPROVAL_STATE");
  });

  it("written from pending (not dispatching) is ERR_APPROVAL_STATE", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    expectCode(() => approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request }), "ERR_APPROVAL_STATE");
  });
});

describe("get and proof-free reads", () => {
  it("getApproval returns null for missing op, ERR_NOT_FOUND for same-kind cross-chat", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    // Register an actual approval in first chat
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    // Genuinely missing operationId returns null (no row at all)
    expect(approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A3 })).toBeNull();
    // Same-kind cross-chat: existing APPROVAL id queried from valid second project/chat -> ERR_NOT_FOUND
    seedProject(records, P2); seedCodex(records, CX2, P2);
    expectCode(() => approvals.getApproval({ projectId: P2, conversationId: CX2, operationId: A2 }), "ERR_NOT_FOUND");
  });

  it("getApproval works after parent turn terminal, no live owner needed", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    const { s, nativeTurnId } = observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    turns.settleTurn({ ...s, outcome: "completed", nativeFact: { nativeIdentity: TH1, nativeTurnId, claudeInputUuid: null } });
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    expect(rec.state).toBe("pending");
  });
});

describe("inTransaction and rollback", () => {
  it("foreign lineage tx rejects with ERR_STORAGE", () => {
    const dir = tmp();
    const { store, approvals } = openFresh(dir);
    const other = openSessionStore({ databasePath: join(dir, "other.sqlite3") });
    stores.push(other);
    let err;
    try { other.transaction((tx) => { approvals.inTransaction(tx); }); } catch (e) { err = e; }
    expect(err?.code).toBe("ERR_STORAGE");
  });

  it("outer rollback discards approval write; unrelated project row persists", () => {
    const dir = tmp();
    const { store, records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    seedProject(records, P2);
    try {
      store.transaction((tx) => {
        const api = approvals.inTransaction(tx);
        api.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
        throw new Error("rollback");
      });
    } catch { /* expected */ }
    expect(rawGet(file, "SELECT id FROM operations WHERE id=?", [A2])).toBeUndefined();
    expect(rawGet(file, "SELECT id FROM projects WHERE id=?", [P2])).toBeDefined();
  });

  it("trigger UPDATE on operations aborts settle atomically", () => {
    const dir = tmp();
    const { store, records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    const rec = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER abort_upd BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'boom'); END");
    });
    expectCode(() => approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request }), "ERR_STORAGE");
    const row = rawGet(file, "SELECT state FROM operations WHERE id=?", [A2]);
    expect(row.state).toBe("dispatching");
  });
});

describe("stored corruption failclosed", () => {
  it("malformed result_json version yields ERR_STORAGE on get", () => {
    const dir = tmp();
    const { store, records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    store.transaction((tx) => {
      tx.run("UPDATE operations SET result_json=? WHERE id=?", ['{"v":2,"hash":"x","request":null,"decision":null,"outcome":null,"terminalRequestSupplied":false}', A2]);
    });
    expectCode(() => approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 }), "ERR_STORAGE");
  });

  it("invalid state column yields ERR_STORAGE", () => {
    const dir = tmp();
    const { store, records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    store.transaction((tx) => { tx.run("UPDATE operations SET state='bogus' WHERE id=?", [A2]); });
    expectCode(() => approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 }), "ERR_STORAGE");
  });

  it("history_json missing registered fact yields ERR_STORAGE", () => {
    const dir = tmp();
    const { store, records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    store.transaction((tx) => { tx.run("UPDATE operations SET history_json='[]' WHERE id=?", [A2]); });
    expectCode(() => approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 }), "ERR_STORAGE");
  });
});

describe("caps and edge cases", () => {
  it("512-unit nativeItemId fits receipt without truncation", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    const longId = "x".repeat(512);
    const res = approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeItemId: longId, nativeRequestId: 1 }));
    expect(res.approval.request.nativeItemId).toBe(longId);
    expect(res.approval.request.nativeItemId.length).toBe(512);
  });

  it("invalid clock (negative) is ERR_INVALID_RECORD before any write", () => {
    const dir = tmp();
    const { records, bindings, turns } = (() => {
      const d = tmp(); const f = join(d, "cho-sessions.sqlite3");
      const store = openSessionStore({ databasePath: f }); stores.push(store);
      const now = clock();
      const records = createSessionRecords({ store, now });
      const bindings = createSessionBindings({ store, verifyOwnerEvidence: strictTrue, now });
      const turns = createSessionTurns({ store, verifyOwnerEvidence: strictTrue, now });
      seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
      observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
      return { records, bindings, turns, store };
    })();
    const badClock = () => -1;
    const approvals = createSessionApprovals({ store: stores[stores.length - 1], verifyOwnerEvidence: strictTrue, verifyPendingApproval: strictTrue, now: badClock });
    expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 })), "ERR_INVALID_RECORD");
  });

  it("many approvals per turn with distinct nativeRequestIds", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    for (let i = 0; i < 5; i++) {
      const r = approvals.registerApproval(regArgs(P1, CX, T1, uid(700 + i), { nativeRequestId: i + 1 }));
      expect(r.created).toBe(true);
    }
  });
});

describe("owner verifier denial on mutations", () => {
  it("bad owner verifier rejects every mutation; raw fields unchanged; get still readable", () => {
    const dir = tmp();
    const d = tmp();
    const f = join(d, "cho-sessions.sqlite3");
    const store = openSessionStore({ databasePath: f });
    stores.push(store);
    const now = clock();
    const records = createSessionRecords({ store, now });
    const bindings = createSessionBindings({ store, verifyOwnerEvidence: strictTrue, now });
    const turns = createSessionTurns({ store, verifyOwnerEvidence: strictTrue, now });
    const goodApprovals = createSessionApprovals({ store, verifyOwnerEvidence: strictTrue, verifyPendingApproval: strictTrue, now });
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    // Register with good verifier
    goodApprovals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    // Construct bad-owner approvals on same store
    const badOwner = () => false;
    const badApprovals = createSessionApprovals({ store, verifyOwnerEvidence: badOwner, verifyPendingApproval: strictTrue, now });
    // Exact retry register denied
    expectCode(() => badApprovals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 })), "ERR_OWNER_UNVERIFIED");
    // Decide denied
    expectCode(() => badApprovals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null }), "ERR_OWNER_UNVERIFIED");
    // Progress with good API
    goodApprovals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    // Begin denied
    expectCode(() => badApprovals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null }), "ERR_OWNER_UNVERIFIED");
    // Progress with good API
    goodApprovals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null });
    const rec = goodApprovals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    // Settle denied
    expectCode(() => badApprovals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request }), "ERR_OWNER_UNVERIFIED");
    // Progress with good API
    goodApprovals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request });
    // Terminal exact retry denied
    expectCode(() => badApprovals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "written", request: rec.request }), "ERR_OWNER_UNVERIFIED");
    // Raw fields unchanged (still written, not corrupted)
    const row = rawGet(f, "SELECT state,decision,history_json,result_json FROM operations WHERE id=?", [A2]);
    expect(row.state).toBe("written");
    expect(row.decision).toBe("accept");
    // Get with bad proof remains readable (read path does not call owner verifier)
    const got = badApprovals.getApproval({ projectId: P1, conversationId: CX, operationId: A2 });
    expect(got.state).toBe("written");
  });
});

describe("pending verifier toggle mid-lifecycle", () => {
  it("toggle false denies decide/begin; true allows; frozen facts correct; same-decision retry while false returns current", () => {
    const dir = tmp();
    let pendingOk = true;
    const captured = [];
    const { records, bindings, turns, approvals } = openFresh(dir, {
      pendingVerifier: (facts) => { captured.push(facts); return pendingOk; },
    });
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    // Register succeeds (pendingOk=true)
    approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 7 }));
    expect(captured.length).toBe(1);
    expect(captured[0].action).toBe("register");
    // Toggle false: decide denied, state unchanged
    pendingOk = false;
    captured.length = 0;
    expectCode(() => approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null }), "ERR_APPROVAL_UNVERIFIED");
    expect(captured.length).toBe(1);
    expect(captured[0].action).toBe("decide");
    expect(Object.isFrozen(captured[0])).toBe(true);
    expect(Object.isFrozen(captured[0].request)).toBe(true);
    // Restore true: decide succeeds
    pendingOk = true;
    captured.length = 0;
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    expect(captured.length).toBe(1);
    expect(captured[0].action).toBe("decide");
    // Toggle false: begin denied, state unchanged
    pendingOk = false;
    captured.length = 0;
    expectCode(() => approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A2, pendingEvidence: null }), "ERR_APPROVAL_UNVERIFIED");
    expect(captured.length).toBe(1);
    expect(captured[0].action).toBe("dispatch");
    expect(Object.isFrozen(captured[0].request)).toBe(true);
    // Same chosen decision retry while false returns current record (no admission, no verifier call)
    captured.length = 0;
    const retry = approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, decision: "accept", pendingEvidence: null });
    expect(retry.state).toBe("decided");
    expect(captured.length).toBe(0);
  });
});

describe("numeric 0 vs string 0 typedID discrimination", () => {
  it("number 0 and string 0 coexist; unknown blocks same typedID; not_sent permits new incarnation; old UUID begin conflicts", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedCodex(records, CX, P1); claim(bindings, P1, CX);
    observedCodex(turns, bindings, P1, CX, TH1, T1, A1);
    // Register number 0
    const rNum = approvals.registerApproval(regArgs(P1, CX, T1, A2, { nativeRequestId: 0, connectionId: C1 }));
    expect(rNum.created).toBe(true);
    // Register string "0" with different UI UUID, same connection
    const rStr = approvals.registerApproval(regArgs(P1, CX, T1, A3, { nativeRequestId: "0", connectionId: C1 }));
    expect(rStr.created).toBe(true);
    // Raw columns differ in canonical text and type
    const rowNum = rawGet(file, "SELECT native_request_id_text, native_request_id_type FROM operations WHERE id=?", [A2]);
    const rowStr = rawGet(file, "SELECT native_request_id_text, native_request_id_type FROM operations WHERE id=?", [A3]);
    expect(rowNum.native_request_id_text).toBe("0");
    expect(rowNum.native_request_id_type).toBe("number");
    expect(rowStr.native_request_id_text).toBe("\"0\"");
    expect(rowStr.native_request_id_type).toBe("string");
    // Settle number-0 as unknown: blocks same typedID (number 0) reuse
    approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A2, outcome: "unknown" });
    expectCode(() => approvals.registerApproval(regArgs(P1, CX, T1, uid(801), { nativeRequestId: 0, connectionId: C1 })), "ERR_APPROVAL_CONFLICT");
    // Settle string-"0" through full lifecycle to not_sent
    approvals.decideApproval({ ...sc(P1, CX), turnId: T1, operationId: A3, decision: "accept", pendingEvidence: null });
    approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A3, pendingEvidence: null });
    const recStr = approvals.getApproval({ projectId: P1, conversationId: CX, operationId: A3 });
    approvals.settleApproval({ ...sc(P1, CX), turnId: T1, operationId: A3, outcome: "not_sent", request: recStr.request });
    // not_sent is terminal: permits genuinely new incarnation with same typedID + new UI UUID
    const rNew = approvals.registerApproval(regArgs(P1, CX, T1, uid(802), { nativeRequestId: "0", connectionId: C1 }));
    expect(rNew.created).toBe(true);
    // Old UUID begin still ERR_DISPATCH_CONFLICT (already terminal, no rearm)
    expectCode(() => approvals.beginApprovalDispatch({ ...sc(P1, CX), turnId: T1, operationId: A3, pendingEvidence: null }), "ERR_DISPATCH_CONFLICT");
  });
});

describe("Claude requested-only without observation rejects approval", () => {
  it("requested UUID + queue/begin without bindNativeRef/recordObserved rejects ERR_APPROVAL_STATE; no native_ref/op inserted; after proper observation succeeds", () => {
    const dir = tmp();
    const { records, bindings, turns, approvals, file } = openFresh(dir);
    seedProject(records, P1); seedClaude(records, CL, P1, IN1); claim(bindings, P1, CL);
    // Set requested session UUID only (no native binding yet)
    bindings.setRequestedClaudeSession({ projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, sessionUuid: IN1, evidence: null });
    const s = { ...sc(P1, CL), turnId: T1, operationId: A1 };
    const inputUuid = uid(601);
    turns.queueTurn({ ...s, prompt: "work", claudeInputUuid: inputUuid });
    turns.beginDispatch(s);
    // Attempt registration without bindNativeRef or recordObserved -> ERR_APPROVAL_STATE
    expectCode(() => approvals.registerApproval(regArgs(P1, CL, T1, A2, { approvalType: "tool", nativeRequestId: "req-x" })), "ERR_APPROVAL_STATE");
    // Verify no native_ref row and no operations row inserted
    expect(rawGet(file, "SELECT conversation_id FROM native_refs WHERE conversation_id=?", [CL])).toBeUndefined();
    expect(rawGet(file, "SELECT id FROM operations WHERE id=?", [A2])).toBeUndefined();
    // Now bind native ref and record observed with correct input UUID
    bindings.bindNativeRef({ projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: IN1, evidence: null });
    turns.recordObserved({ ...s, nativeFact: { nativeIdentity: IN1, nativeTurnId: null, claudeInputUuid: inputUuid } });
    // Registration now succeeds
    const res = approvals.registerApproval(regArgs(P1, CL, T1, A2, { approvalType: "tool", nativeRequestId: "req-x" }));
    expect(res.created).toBe(true);
    expect(res.approval.request.claudeInputUuid).toBe(inputUuid);
    expect(res.approval.request.nativeIdentity).toBe(IN1);
  });
});
