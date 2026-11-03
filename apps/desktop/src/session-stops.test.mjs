// CHO-03 S2e Stop intent/dispatch journal tests: real temp SQLite fixtures
// only, never the actual user app-data. Projects/conversations come from the
// S2a records API, fences and native refs from the S2b bindings API, turns
// from the S2c turns API. Covers factory/input validation, Stop queue
// idempotency and conflicts, the one-shot begin target per controller,
// written/ACK ordering, terminal exact-retry rules, not_needed gating, live
// proof and two-connection takeover, trigger-abort atomicity and
// inTransaction composition/lineage, and stored-shape corruption. No
// implementation-mirroring mocks: verification reads raw SQL back through
// an independent connection where relevant, and fault seeds use trusted
// store transactions or raw fixtures.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";
import { createSessionStops } from "../server/session-stops.mjs";

const dirs = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* closed-store tests leave the store closed on purpose */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cho-session-stops-"));
  dirs.push(dir);
  return dir;
}

function dbPath(dir, name = "cho-sessions.sqlite3") {
  return join(dir, name);
}

// Canonical lowercase UUID fixtures (8-4-4-4-12 hex).
const uid = (n) => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`;
const P1 = uid(1);
const P2 = uid(2);
const CX = uid(101);
const CL = uid(102);
const CX2 = uid(103);
const T1 = uid(201);
const T2 = uid(202);
const H1 = uid(211);
const H2 = uid(212);
const UREQ = uid(221);
const I1 = uid(231);
const I2 = uid(232);

function makeClock(start = 1700000000000) {
  let tick = start;
  return () => tick++;
}

const strictTrue = () => true;

function openFresh(dir, name, options = {}) {
  const file = dbPath(dir, name);
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const clock = options.clock ?? makeClock();
  const records = createSessionRecords({ store, now: clock });
  const bindings = createSessionBindings({
    store,
    verifyOwnerEvidence: options.verifier ?? strictTrue,
    now: clock,
  });
  const turns = createSessionTurns({
    store,
    verifyOwnerEvidence: options.turnVerifier ?? strictTrue,
    now: clock,
  });
  const stops = createSessionStops({
    store,
    verifyOwnerEvidence: options.stopVerifier ?? strictTrue,
    now: options.stopClock ?? clock,
  });
  return { file, store, records, bindings, turns, stops, clock };
}

function openSecondStops(file, options = {}) {
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const stops = createSessionStops({
    store,
    verifyOwnerEvidence: options.stopVerifier ?? strictTrue,
    now: options.clock ?? makeClock(1800000000000),
  });
  const turns = createSessionTurns({
    store,
    verifyOwnerEvidence: options.turnVerifier ?? strictTrue,
    now: options.clock ?? makeClock(1800000000000),
  });
  return { store, stops, turns };
}

// Explicit flags on every raw fixture connection: extension loading off,
// double-quoted string literals off, foreign keys on.
const RAW_OPEN_FLAGS = {
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  allowExtension: false,
};

function openRaw(file, readOnly = false) {
  return new DatabaseSync(
    file,
    readOnly ? { readOnly: true, ...RAW_OPEN_FLAGS } : { ...RAW_OPEN_FLAGS }
  );
}

function rawGet(file, sql, params = []) {
  const raw = openRaw(file, true);
  try {
    const row = raw.prepare(sql).get(...params);
    return row === undefined ? undefined : { ...row };
  } finally {
    raw.close();
  }
}

function rawAll(file, sql, params = []) {
  const raw = openRaw(file, true);
  try {
    return raw.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    raw.close();
  }
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error?.code).toBe(code);
    return error;
  }
  throw new Error(`expected throw with code ${code}`);
}

function seedProject(records, id, name) {
  return records.createProject({
    id,
    name,
    pathCanonical: `/tmp/cho-stop-${id.slice(-4)}`,
  });
}

function seedCodex(records, id, projectId, extra = {}) {
  return records.createConversation({
    id,
    projectId,
    controller: "codex",
    ...extra,
  });
}

function seedClaude(records, id, projectId, extra = {}) {
  return records.createConversation({
    id,
    projectId,
    controller: "claude",
    ...extra,
  });
}

function seedHeld(bindings, projectId, conversationId, ownerToken = T1) {
  return bindings.claimProducer({
    projectId,
    conversationId,
    ownerToken,
    expectedGeneration: 0,
    evidence: null,
  });
}

function scope(projectId, conversationId, overrides = {}) {
  return {
    projectId,
    conversationId,
    ownerToken: T1,
    ownerGeneration: 1,
    hostGeneration: H1,
    evidence: null,
    ...overrides,
  };
}

function codexTarget(thread, nativeTurnId) {
  return {
    controller: "codex",
    nativeIdentity: thread,
    nativeTurnId,
    claudeInputUuid: null,
    identitySource: "observed",
  };
}

function claudeTarget(identity, inputUuid, source) {
  return {
    controller: "claude",
    nativeIdentity: identity,
    nativeTurnId: null,
    claudeInputUuid: inputUuid,
    identitySource: source,
  };
}

// Full Codex turn flow through observed: bound thread, queued intent,
// dispatch, write, and observation of the stored native turn id.
function seedObservedCodex(turns, bindings, projectId, conversationId, thread, turnId, handoffId, prompt = "codex work") {
  bindings.bindNativeRef({
    projectId, conversationId, ownerToken: T1, generation: 1,
    controller: "codex", nativeThreadId: thread, evidence: null,
  });
  const s = { ...scope(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt });
  turns.beginDispatch(s);
  turns.recordWritten(s);
  const nativeTurnId = `nt-${turnId.slice(-4)}`;
  turns.recordObserved({
    ...s,
    nativeFact: { nativeIdentity: thread, nativeTurnId, claudeInputUuid: null },
  });
  return { scope: s, nativeTurnId };
}

// Claude turn flow through written on the requested UUID alone: no observed
// ref is fabricated by the write.
function seedWrittenClaude(records, turns, bindings, projectId, conversationId, requested, inputUuid, turnId, handoffId) {
  bindings.setRequestedClaudeSession({
    projectId, conversationId, ownerToken: T1, generation: 1, sessionUuid: requested, evidence: null,
  });
  const s = { ...scope(projectId, conversationId), turnId, operationId: handoffId };
  turns.queueTurn({ ...s, prompt: "claude work", claudeInputUuid: inputUuid });
  turns.beginDispatch(s);
  turns.recordWritten(s);
  return s;
}

describe("factory and input validation", () => {
  it("exposes six frozen methods and performs no I/O on import/factory", () => {
    const dir = tempDir();
    const probe = dbPath(dir, "untouched.sqlite3");
    const api = createSessionStops({
      store: { transaction() {} },
      verifyOwnerEvidence: strictTrue,
    });
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "beginStopDispatch",
      "getStop",
      "inTransaction",
      "recordStopWritten",
      "requestStop",
      "settleStop",
    ]);
    expect(existsSync(probe)).toBe(false);
  });

  it("rejects bad factory dependencies with ERR_INVALID_RECORD", () => {
    const stub = { transaction() {} };
    expectCode(() => createSessionStops(), "ERR_INVALID_RECORD");
    expectCode(() => createSessionStops(null), "ERR_INVALID_RECORD");
    expectCode(() => createSessionStops({ store: stub }), "ERR_INVALID_RECORD");
    expectCode(
      () => createSessionStops({ store: stub, verifyOwnerEvidence: null }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionStops({ store: null, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionStops({ store: {}, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionStops({ store: stub, verifyOwnerEvidence: strictTrue, now: 7 }),
      "ERR_INVALID_RECORD"
    );
  });

  it("rejects malformed ids, reasons, outcomes, and targets with ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { stops, records } = openFresh(dir, "invalid.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    const bad = [undefined, null, 42, "", "not-a-uuid", P1.toUpperCase(), ` ${P1}`];
    for (const projectId of bad) {
      expectCode(
        () => stops.getStop({ projectId, conversationId: CX, turnId: uid(900) }),
        "ERR_INVALID_RECORD"
      );
    }
    const s = { ...scope(P1, CX), turnId: uid(901), operationId: uid(902) };
    expectCode(() => stops.requestStop({ ...s, turnId: "bad" }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop({ ...s, operationId: "bad" }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop({ ...s, reason: null }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop({ ...s, reason: "user-cancel" }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop({ ...s, ownerGeneration: 0 }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop({ ...s, hostGeneration: "bad" }), "ERR_INVALID_RECORD");
    expectCode(() => stops.requestStop(null), "ERR_INVALID_RECORD");
    expectCode(
      () => stops.settleStop({ ...s, outcome: "done" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.settleStop({ ...s, outcome: "completed" }),
      "ERR_INVALID_RECORD"
    );
    const target = codexTarget("thr-1", "nt-1");
    expectCode(
      () => stops.recordStopWritten({ ...s }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: null }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: {} }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: { ...target, extra: 1 } }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: { ...target, kind: "x" } }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: { ...target, controller: "sms" } }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.recordStopWritten({ ...s, dispatchTarget: { ...target, identitySource: "requested" } }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => stops.inTransaction(null),
      "ERR_INVALID_RECORD"
    );
    expectCode(() => stops.inTransaction({}), "ERR_INVALID_RECORD");
  });

  it("rejects a faulting or non-monotonic clock only on the new layer", () => {
    const dir = tempDir();
    const throwing = openFresh(dir, "throw.sqlite3", { stopClock: () => { throw new Error("boom"); } });
    seedProject(throwing.records, P1, "alpha");
    seedCodex(throwing.records, CX, P1);
    seedHeld(throwing.bindings, P1, CX);
    throwing.turns.queueTurn({ ...scope(P1, CX), turnId: uid(910), operationId: uid(911), prompt: "hi" });
    expectCode(
      () => throwing.stops.requestStop({ ...scope(P1, CX), turnId: uid(910), operationId: uid(912) }),
      "ERR_INVALID_RECORD"
    );
    const negative = openFresh(dir, "neg.sqlite3", { stopClock: () => -1 });
    seedProject(negative.records, P1, "alpha");
    seedCodex(negative.records, CX, P1);
    seedHeld(negative.bindings, P1, CX);
    negative.turns.queueTurn({ ...scope(P1, CX), turnId: uid(910), operationId: uid(911), prompt: "hi" });
    expectCode(
      () => negative.stops.requestStop({ ...scope(P1, CX), turnId: uid(910), operationId: uid(912) }),
      "ERR_INVALID_RECORD"
    );
  });
});

describe("requestStop queue semantics", () => {
  it("persists exact reason and provenance with no turn mutation", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "queue.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(920);
    const H = uid(921);
    const O = uid(922);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "keep working" });
    const before = turns.getTurn({ projectId: P1, conversationId: CX, turnId: R });
    const receipt = stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O, reason: "close" });
    expect(receipt.created).toBe(true);
    expect(receipt.stop).toMatchObject({
      id: O,
      conversationId: CX,
      turnId: R,
      reason: "close",
      state: "queued",
      outcome: null,
      dispatchTarget: null,
      ownerGeneration: 1,
      hostGeneration: H1,
      settledAtMs: null,
    });
    expect(receipt.stop.history).toEqual([{ kind: "queued", atMs: receipt.stop.createdAtMs }]);
    // The target turn is untouched: same record, same native fields.
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R })).toEqual(before);
    expect(rawGet(file, "SELECT intent_state, outcome, native_turn_id FROM turns WHERE id = ?", [R])).toEqual(
      { intent_state: "queued", outcome: null, native_turn_id: null }
    );
    const op = rawGet(file, "SELECT kind, decision, turn_id, owner_generation, host_generation, native_request_id_text, native_request_id_type, payload_hash, result_json FROM operations WHERE id = ?", [O]);
    expect(op.kind).toBe("stop");
    expect(op.decision).toBe("close");
    expect(op.turn_id).toBe(R);
    expect(op.owner_generation).toBe(1);
    expect(op.host_generation).toBe(H1);
    expect(op.native_request_id_text).toBeNull();
    expect(op.native_request_id_type).toBeNull();
    expect(op.result_json).not.toContain("keep working");
    // Historical read agrees.
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: R })).toEqual(receipt.stop);
  });

  it("returns created:false on exact retry even after the turn settles", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "retry.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(930);
    const H = uid(931);
    const O = uid(932);
    const s = { ...scope(P1, CX), turnId: R, operationId: O, reason: "user" };
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    const first = stops.requestStop(s);
    expect(first.created).toBe(true);
    // Settle the turn to unknown (factless, allowed from queued).
    turns.settleTurn({ ...scope(P1, CX), turnId: R, operationId: H, outcome: "unknown" });
    const current = stops.getStop({ projectId: P1, conversationId: CX, turnId: R });
    const again = stops.requestStop(s);
    expect(again.created).toBe(false);
    expect(again.stop).toEqual(current);
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: R })).toEqual(current);
    // A second Stop id on the same turn is still a Stop conflict, even
    // though the turn has since settled.
    expectCode(
      () => stops.requestStop({ ...s, operationId: uid(933) }),
      "ERR_STOP_CONFLICT"
    );
    // A fresh terminal turn with no Stop at all rejects as state.
    const R2 = uid(934);
    const H2 = uid(935);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: H2, prompt: "late" });
    turns.settleTurn({ ...scope(P1, CX), turnId: R2, operationId: H2, outcome: "unknown" });
    expectCode(
      () => stops.requestStop({ ...scope(P1, CX), turnId: R2, operationId: uid(936) }),
      "ERR_STOP_STATE"
    );
  });

  it("rejects changed payload, reason, chat, turn, owner, and kind reuse", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "idem.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedCodex(records, CX2, P1);
    seedHeld(bindings, P1, CX);
    seedHeld(bindings, P1, CX2, T2);
    const R = uid(940);
    const H = uid(941);
    const O = uid(942);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "base" });
    turns.queueTurn({ ...scope(P1, CX2, { ownerToken: T2 }), turnId: uid(943), operationId: uid(944), prompt: "other" });
    stops.requestStop(s);
    expectCode(() => stops.requestStop({ ...s, reason: "close" }), "ERR_IDEMPOTENCY_CONFLICT");
    expectCode(() => stops.requestStop({ ...s, turnId: uid(945) }), "ERR_IDEMPOTENCY_CONFLICT");
    expectCode(() => stops.requestStop({ ...s, hostGeneration: H2 }), "ERR_IDEMPOTENCY_CONFLICT");
    expectCode(
      () => stops.requestStop({ ...s, ownerToken: T2, ownerGeneration: 2 }),
      "ERR_FENCE_CONFLICT"
    );
    // Same op id against another chat cannot be reused.
    expectCode(
      () => stops.requestStop({ ...scope(P1, CX2, { ownerToken: T2 }), turnId: uid(943), operationId: O }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // A handoff receipt id can never become a Stop id.
    expectCode(
      () => stops.requestStop({ ...s, operationId: H }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Same turn with a new Stop id is a Stop conflict, not idempotency.
    expectCode(
      () => stops.requestStop({ ...s, operationId: uid(946) }),
      "ERR_STOP_CONFLICT"
    );
    // A missing turn is not found.
    expectCode(
      () => stops.requestStop({ ...s, turnId: uid(947), operationId: uid(948) }),
      "ERR_NOT_FOUND"
    );
    // A missing conversation is not found.
    expectCode(
      () => stops.requestStop({ ...scope(P1, uid(949)), turnId: R, operationId: uid(950) }),
      "ERR_NOT_FOUND"
    );
  });

  it("rejects duplicate stored Stop rows on request and read", () => {
    const dir = tempDir();
    const { file, store, stops, turns, records, bindings } = openFresh(dir, "dup.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(960);
    const H = uid(961);
    const O = uid(962);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, decision, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'stop', 1, ?, 'user', 'queued', '[]', 'x', '{}', 1, NULL)",
        [uid(963), CX, R, H1]
      );
    });
    expect(rawAll(file, "SELECT id FROM operations WHERE turn_id = ? AND kind = 'stop'", [R])).toHaveLength(2);
    expectCode(
      () => stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: uid(964) }),
      "ERR_STORAGE"
    );
    expectCode(
      () => stops.getStop({ projectId: P1, conversationId: CX, turnId: R }),
      "ERR_STORAGE"
    );
  });
});

describe("beginStopDispatch one-shot target", () => {
  it("codex admits only an observed turn with its bound thread", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "codex.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(970);
    const H = uid(971);
    const O = uid(972);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    stops.requestStop(s);
    // Unobserved with no ref at all: not yet ready.
    expectCode(() => stops.beginStopDispatch(s), "ERR_STOP_STATE");
    // Bound ref alone is no substitute for an observed turn id.
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-obs", evidence: null,
    });
    expectCode(() => stops.beginStopDispatch(s), "ERR_STOP_STATE");
    turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: H });
    turns.recordWritten({ ...scope(P1, CX), turnId: R, operationId: H });
    turns.recordObserved({
      ...scope(P1, CX), turnId: R, operationId: H,
      nativeFact: { nativeIdentity: "thr-obs", nativeTurnId: "nt-obs", claudeInputUuid: null },
    });
    const begun = stops.beginStopDispatch(s);
    const want = codexTarget("thr-obs", "nt-obs");
    expect(begun.state).toBe("dispatching");
    expect(begun.dispatchTarget).toEqual(want);
    expect(begun.history[0]).toEqual({ kind: "queued", atMs: begun.createdAtMs });
    expect(begun.history[1].kind).toBe("dispatching");
    expect(begun.history[1].target).toEqual(want);
    expect(Number.isSafeInteger(begun.history[1].atMs)).toBe(true);
    expect(begun.history[1].atMs).toBeGreaterThanOrEqual(begun.createdAtMs);
    // Repeat begins never grant new permission, including after terminal.
    expectCode(() => stops.beginStopDispatch(s), "ERR_DISPATCH_CONFLICT");
    stops.recordStopWritten({ ...s, dispatchTarget: want });
    stops.settleStop({ ...s, outcome: "unknown" });
    expectCode(() => stops.beginStopDispatch(s), "ERR_DISPATCH_CONFLICT");
    expectCode(
      () => stops.beginStopDispatch({ ...s, operationId: uid(973) }),
      "ERR_NOT_FOUND"
    );
  });

  it("claude admits written requested-only targets and keeps the source", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "claude.sqlite3");
    seedProject(records, P1, "alpha");
    seedClaude(records, CL, P1);
    seedHeld(bindings, P1, CL);
    const R = uid(980);
    const H = uid(981);
    const O = uid(982);
    bindings.setRequestedClaudeSession({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, sessionUuid: UREQ, evidence: null,
    });
    turns.queueTurn({ ...scope(P1, CL), turnId: R, operationId: H, prompt: "work", claudeInputUuid: I1 });
    stops.requestStop({ ...scope(P1, CL), turnId: R, operationId: O });
    const s = { ...scope(P1, CL), turnId: R, operationId: O };
    // Pre-write intent is not an interruptible target.
    expectCode(() => stops.beginStopDispatch(s), "ERR_STOP_STATE");
    turns.beginDispatch({ ...scope(P1, CL), turnId: R, operationId: H });
    turns.recordWritten({ ...scope(P1, CL), turnId: R, operationId: H });
    const begun = stops.beginStopDispatch(s);
    const want = claudeTarget(UREQ, I1, "requested");
    expect(begun.dispatchTarget).toEqual(want);
    // A later observed ref confirms the snapshot but never rewrites it.
    bindings.bindNativeRef({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1,
      controller: "claude", nativeSessionUuid: UREQ, evidence: null,
    });
    expect(stops.getStop({ projectId: P1, conversationId: CL, turnId: R }).dispatchTarget).toEqual(want);
    const written = stops.recordStopWritten({ ...s, dispatchTarget: want });
    expect(written.state).toBe("written");
    expect(written.dispatchTarget).toEqual(want);
  });

  it("claude admits the observed path and rejects resolved turns", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "claude-obs.sqlite3");
    seedProject(records, P1, "alpha");
    seedClaude(records, CL, P1);
    seedHeld(bindings, P1, CL);
    const R = uid(990);
    const H = uid(991);
    const O = uid(992);
    bindings.setRequestedClaudeSession({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, sessionUuid: UREQ, evidence: null,
    });
    turns.queueTurn({ ...scope(P1, CL), turnId: R, operationId: H, prompt: "work", claudeInputUuid: I1 });
    turns.beginDispatch({ ...scope(P1, CL), turnId: R, operationId: H });
    turns.recordWritten({ ...scope(P1, CL), turnId: R, operationId: H });
    bindings.bindNativeRef({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1,
      controller: "claude", nativeSessionUuid: UREQ, evidence: null,
    });
    turns.recordObserved({
      ...scope(P1, CL), turnId: R, operationId: H,
      nativeFact: { nativeIdentity: UREQ, nativeTurnId: null, claudeInputUuid: I1 },
    });
    stops.requestStop({ ...scope(P1, CL), turnId: R, operationId: O });
    const begun = stops.beginStopDispatch({ ...scope(P1, CL), turnId: R, operationId: O });
    expect(begun.dispatchTarget).toEqual(claudeTarget(UREQ, I1, "observed"));
    // A resolved turn, including unknown, cannot newly dispatch.
    const R2 = uid(993);
    const H2 = uid(994);
    const O2 = uid(995);
    turns.queueTurn({ ...scope(P1, CL), turnId: R2, operationId: H2, prompt: "late", claudeInputUuid: I2 });
    stops.requestStop({ ...scope(P1, CL), turnId: R2, operationId: O2 });
    turns.settleTurn({ ...scope(P1, CL), turnId: R2, operationId: H2, outcome: "unknown" });
    expectCode(
      () => stops.beginStopDispatch({ ...scope(P1, CL), turnId: R2, operationId: O2 }),
      "ERR_STOP_STATE"
    );
  });

  it("rejects contradictory stored bindings without inventing refs", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "contra.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-ok", uid(996), uid(997));
    const O = uid(998);
    stops.requestStop({ ...s, operationId: O });
    const before = rawGet(file, "SELECT state, history_json, result_json FROM operations WHERE id = ?", [O]);
    // Controller flip breaks the native_ref FK correlation: corruption.
    const raw = openRaw(file);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.prepare("UPDATE conversations SET controller = 'claude' WHERE id = ?").run(CX);
    } finally {
      raw.close();
    }
    expectCode(
      () => stops.beginStopDispatch({ ...s, operationId: O }),
      "ERR_STORAGE"
    );
    expect(rawGet(file, "SELECT state, history_json, result_json FROM operations WHERE id = ?", [O])).toEqual(before);
    expect(nativeTurnId).toBe("nt-0996");
  });
});

describe("recordStopWritten and settleStop", () => {
  it("tracks idempotent writes with ACK before and after the write", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "written.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-w", uid(1010), uid(1011));
    const O = uid(1012);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-w", nativeTurnId);
    const written = stops.recordStopWritten({ ...scopeStop, dispatchTarget: want });
    expect(written.state).toBe("written");
    // Exact write repeats are unchanged with no history growth.
    const again = stops.recordStopWritten({ ...scopeStop, dispatchTarget: want });
    expect(again).toEqual(written);
    // Write-before-begin on a second Stop rejects.
    const R2 = uid(1013);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: uid(1014), prompt: "second" });
    const O2 = uid(1015);
    stops.requestStop({ ...scope(P1, CX), turnId: R2, operationId: O2 });
    expectCode(
      () => stops.recordStopWritten({ ...scope(P1, CX), turnId: R2, operationId: O2, dispatchTarget: want }),
      "ERR_STOP_STATE"
    );
    // ACK admits the exact target only; the turn itself never settles.
    const acked = stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    expect(acked.state).toBe("acknowledged");
    expect(acked.outcome).toBe("acknowledged");
    expect(acked.settledAtMs).not.toBeNull();
    const turn = turns.getTurn({ projectId: P1, conversationId: CX, turnId: s.turnId });
    expect(turn.outcome).toBeNull();
    expect(turn.intentState).toBe("observed");
    // A terminal Stop rejects the late write callback.
    expectCode(
      () => stops.recordStopWritten({ ...scopeStop, dispatchTarget: want }),
      "ERR_STOP_STATE"
    );
  });

  it("settles ACK before the write and survives late turn outcomes", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "ackfirst.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-a", uid(1020), uid(1021));
    const O = uid(1022);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-a", nativeTurnId);
    const acked = stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    expect(acked.history.map((entry) => entry.kind)).toEqual(["queued", "dispatching", "terminal"]);
    // The target turn may settle afterwards; the Stop receipt is unchanged.
    turns.settleTurn({
      ...s, outcome: "completed",
      nativeFact: { nativeIdentity: "thr-a", nativeTurnId, claudeInputUuid: null },
    });
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: s.turnId })).toEqual(acked);
  });

  it("rejects target mismatches and enforces exact terminal replay", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "replay.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-r", uid(1030), uid(1031));
    const O = uid(1032);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-r", nativeTurnId);
    const wrong = codexTarget("thr-r", "nt-other");
    expectCode(
      () => stops.recordStopWritten({ ...scopeStop, dispatchTarget: wrong }),
      "ERR_STOP_CONFLICT"
    );
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: wrong }),
      "ERR_STOP_CONFLICT"
    );
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "acknowledged" }),
      "ERR_STOP_CONFLICT"
    );
    // A queued Stop never acks on a supplied stand-in target.
    const R2 = uid(1033);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: uid(1034), prompt: "q" });
    const O2 = uid(1035);
    stops.requestStop({ ...scope(P1, CX), turnId: R2, operationId: O2 });
    expectCode(
      () => stops.settleStop({ ...scope(P1, CX), turnId: R2, operationId: O2, outcome: "acknowledged", dispatchTarget: want }),
      "ERR_STOP_STATE"
    );
    // Unknown from dispatching settles with an exact null-or-target replay.
    const settled = stops.settleStop({ ...scopeStop, outcome: "unknown" });
    expect(settled.state).toBe("unknown");
    const replay = stops.settleStop({ ...scopeStop, outcome: "unknown" });
    expect(replay).toEqual(settled);
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "unknown", dispatchTarget: want }),
      "ERR_STOP_CONFLICT"
    );
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want }),
      "ERR_STOP_CONFLICT"
    );
  });

  it("gates not_needed on queued Stops over known-settled turns", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "notneeded.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const mk = (n) => {
      const R = uid(n);
      const H = uid(n + 1);
      const O = uid(n + 2);
      turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: `t${n}` });
      stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
      return { R, H, O };
    };
    // Unknown turn outcome is not enough.
    const a = mk(1040);
    turns.settleTurn({ ...scope(P1, CX), turnId: a.R, operationId: a.H, outcome: "unknown" });
    expectCode(
      () => stops.settleStop({ ...scope(P1, CX), turnId: a.R, operationId: a.O, outcome: "not_needed" }),
      "ERR_STOP_STATE"
    );
    // Completed turn with a still-queued Stop settles.
    const b = mk(1050);
    turns.settleTurn({ ...scope(P1, CX), turnId: b.R, operationId: b.H, outcome: "failed" });
    const done = stops.settleStop({ ...scope(P1, CX), turnId: b.R, operationId: b.O, outcome: "not_needed" });
    expect(done.state).toBe("not_needed");
    // not_needed takes no target argument.
    const c = mk(1060);
    turns.settleTurn({ ...scope(P1, CX), turnId: c.R, operationId: c.H, outcome: "failed" });
    expectCode(
      () => stops.settleStop({
        ...scope(P1, CX), turnId: c.R, operationId: c.O, outcome: "not_needed",
        dispatchTarget: codexTarget("thr-x", "nt-x"),
      }),
      "ERR_INVALID_RECORD"
    );
    // A dispatched Stop can no longer take not_needed.
    const d = mk(1070);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-d", evidence: null,
    });
    turns.beginDispatch({ ...scope(P1, CX), turnId: d.R, operationId: d.H });
    turns.recordWritten({ ...scope(P1, CX), turnId: d.R, operationId: d.H });
    const nt = `nt-${d.R.slice(-4)}`;
    turns.recordObserved({
      ...scope(P1, CX), turnId: d.R, operationId: d.H,
      nativeFact: { nativeIdentity: "thr-d", nativeTurnId: nt, claudeInputUuid: null },
    });
    stops.beginStopDispatch({ ...scope(P1, CX), turnId: d.R, operationId: d.O });
    turns.settleTurn({
      ...scope(P1, CX), turnId: d.R, operationId: d.H, outcome: "completed",
      nativeFact: { nativeIdentity: "thr-d", nativeTurnId: nt, claudeInputUuid: null },
    });
    expectCode(
      () => stops.settleStop({ ...scope(P1, CX), turnId: d.R, operationId: d.O, outcome: "not_needed" }),
      "ERR_STOP_STATE"
    );
  });
});

describe("proof, fence, and takeover", () => {
  it("denies false, non-boolean, throwing, and async proof without echo", () => {
    const dir = tempDir();
    const { file, store, records, bindings, turns } = openFresh(dir, "proof.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1100);
    const H = uid(1101);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    const attempt = (verifyOwnerEvidence) => {
      const probe = createSessionStops({ store, verifyOwnerEvidence, now: makeClock() });
      return probe.requestStop({ ...scope(P1, CX), turnId: R, operationId: uid(1102) });
    };
    for (const bad of [() => false, () => 1, () => { throw new Error("no"); }, () => Promise.resolve(true)]) {
      const error = expectCode(() => attempt(bad), "ERR_OWNER_UNVERIFIED");
      expect(error.message).not.toContain(R);
    }
    expect(rawAll(file, "SELECT id FROM operations WHERE kind = 'stop'")).toEqual([]);
  });

  it("blocks old and new owners from a previous journal after takeover", () => {
    const dir = tempDir();
    const { file, store, records, bindings, turns, stops } = openFresh(dir, "takeover.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1110);
    const H = uid(1111);
    const O = uid(1112);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
    bindings.settleProducer({ projectId: P1, conversationId: CX, ownerToken: T1, generation: 1, state: "released", evidence: null });
    const second = openSecondStops(file);
    const reclaimed = bindings.claimProducer({ projectId: P1, conversationId: CX, ownerToken: T2, expectedGeneration: 1, evidence: null });
    expect(reclaimed.generation).toBe(2);
    second.turns.queueTurn({ ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2 }), turnId: uid(1113), operationId: uid(1114), prompt: "x" });
    const newClaim = second.store.transaction((tx) =>
      tx.get("SELECT owner_token, generation FROM producer_fences WHERE conversation_id = ?", [CX])
    );
    expect(newClaim.generation).toBe(2);
    // Old owner cannot mutate: fence moved on.
    expectCode(
      () => stops.beginStopDispatch({ ...scope(P1, CX), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    // New owner cannot adopt the old journal: provenance is pinned.
    expectCode(
      () => second.stops.beginStopDispatch({ ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2 }), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    expectCode(
      () => second.stops.settleStop({ ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2 }), turnId: R, operationId: O, outcome: "unknown" }),
      "ERR_FENCE_CONFLICT"
    );
    // Wrong host, same generation, strict-true verifier: still fenced.
    expectCode(
      () => stops.beginStopDispatch({ ...scope(P1, CX, { hostGeneration: H2 }), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    void store;
  });

  it("reads history after release with no permission implied", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "hist.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1120);
    const H = uid(1121);
    const O = uid(1122);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    const first = stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
    bindings.settleProducer({ projectId: P1, conversationId: CX, ownerToken: T1, generation: 1, state: "released", evidence: null });
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: R })).toEqual(first.stop);
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: uid(1123) })).toBeNull();
  });
});

describe("atomicity and composition", () => {
  it("rolls back queue and begin atomically under trigger ABORT", () => {
    const dir = tempDir();
    const { file, store, stops, turns, records, bindings } = openFresh(dir, "abort.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1130);
    const H = uid(1131);
    const O = uid(1132);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    store.transaction((tx) => {
      tx.run(
        "CREATE TRIGGER cho_probe_abort AFTER INSERT ON operations BEGIN SELECT RAISE(ABORT, 'probe'); END",
        []
      );
    });
    expectCode(
      () => stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O }),
      "ERR_STORAGE"
    );
    expect(rawAll(file, "SELECT id FROM operations WHERE id = ?", [O])).toEqual([]);
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).intentState).toBe("queued");
    store.transaction((tx) => {
      tx.run("DROP TRIGGER cho_probe_abort", []);
    });
    expect(stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O }).created).toBe(true);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-abort", evidence: null,
    });
    turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: H });
    turns.recordWritten({ ...scope(P1, CX), turnId: R, operationId: H });
    turns.recordObserved({
      ...scope(P1, CX), turnId: R, operationId: H,
      nativeFact: { nativeIdentity: "thr-abort", nativeTurnId: "nt-abort", claudeInputUuid: null },
    });
    const before = rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O]);
    store.transaction((tx) => {
      tx.run(
        "CREATE TRIGGER cho_probe_abort_update AFTER UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'probe'); END",
        []
      );
    });
    expectCode(
      () => stops.beginStopDispatch({ ...scope(P1, CX), turnId: R, operationId: O }),
      "ERR_STORAGE"
    );
    expect(rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O])).toEqual(before);
    store.transaction((tx) => {
      tx.run("DROP TRIGGER cho_probe_abort_update", []);
    });
  });

  it("composes Stop with unrelated writes and enforces transaction lineage", () => {
    const dir = tempDir();
    const { file, store, stops, turns, records, bindings } = openFresh(dir, "compose.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1140);
    const H = uid(1141);
    const O = uid(1142);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    const scopeStop = { ...scope(P1, CX), turnId: R, operationId: O };
    // Rollback: an unrelated failing write discards the Stop insert too.
    expectCode(
      () =>
        store.transaction((tx) => {
          stops.inTransaction(tx).requestStop(scopeStop);
          tx.run("UPDATE conversations SET nope = 1 WHERE id = ?", [CX]);
        }),
      "ERR_STORAGE"
    );
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: R })).toBeNull();
    // Success: both commit together.
    store.transaction((tx) => {
      stops.inTransaction(tx).requestStop(scopeStop);
      tx.run("UPDATE conversations SET title = 'renamed' WHERE id = ?", [CX]);
    });
    expect(stops.getStop({ projectId: P1, conversationId: CX, turnId: R }).state).toBe("queued");
    expect(rawGet(file, "SELECT title FROM conversations WHERE id = ?", [CX]).title).toBe("renamed");
    expect(Object.isFrozen(store.transaction((tx) => stops.inTransaction(tx)))).toBe(true);
    // Foreign lineage, expired helpers, nesting, and close all reject.
    const otherDb = openFresh(tempDir(), "foreign.sqlite3");
    otherDb.store.transaction((tx) => {
      expectCode(() => stops.inTransaction(tx), "ERR_STORAGE");
    });
    let leaked;
    store.transaction((tx) => {
      leaked = stops.inTransaction(tx);
    });
    expectCode(() => leaked.getStop({ projectId: P1, conversationId: CX, turnId: R }), "ERR_INVALID_TX");
    expectCode(
      () => store.transaction(() => stops.requestStop({ ...scopeStop, operationId: uid(1143) })),
      "ERR_INVALID_TX"
    );
    store.close();
    expectCode(() => stops.requestStop({ ...scopeStop, operationId: uid(1144) }), "ERR_CLOSED");
  });
});

describe("stored shapes, caps, and static errors", () => {
  it("rejects malformed journals, oversized receipts, and reordered facts", () => {
    const dir = tempDir();
    const { file, store, stops, turns, records, bindings } = openFresh(dir, "shapes.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1150);
    const H = uid(1151);
    const O = uid(1152);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
    const args = { projectId: P1, conversationId: CX, turnId: R };
    const corrupt = (sql, params) => {
      store.transaction((tx) => {
        tx.run(sql, params);
      });
      expectCode(() => stops.getStop(args), "ERR_STORAGE");
    };
    corrupt("UPDATE operations SET history_json = 'nope' WHERE id = ?", [O]);
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = '[]' WHERE id = ?", [O]);
    });
    corrupt("UPDATE operations SET result_json = '{}' WHERE id = ?", [O]);
    store.transaction((tx) => {
      tx.run(
        "UPDATE operations SET result_json = ?, history_json = '[{\"kind\":\"queued\",\"atMs\":1}]' WHERE id = ?",
        [`{"v":1,"kind":"queue","hash":"${"a".repeat(64)}","reason":"user","target":null,"outcome":null,"pad":"${"x".repeat(9000)}"}`, O]
      );
    });
    expectCode(() => stops.getStop(args), "ERR_STORAGE");
  });

  it("accepts 512-unit opaque ids end to end and keeps errors static", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "bounds.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const thread = "t".repeat(512);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, thread, uid(1160), uid(1161));
    const O = uid(1162);
    stops.requestStop({ ...s, operationId: O });
    const begun = stops.beginStopDispatch({ ...s, operationId: O });
    expect(begun.dispatchTarget).toEqual(codexTarget(thread, nativeTurnId));
    // Static messages never echo ids, prompts, SQL, or JSON diagnostics.
    const missing = uid(1163);
    const notFound = expectCode(
      () => stops.requestStop({ ...scope(P1, CX), turnId: missing, operationId: uid(1164) }),
      "ERR_NOT_FOUND"
    );
    expect(notFound.message).not.toContain(missing);
    const conflict = expectCode(
      () => stops.requestStop({ ...s, operationId: uid(1165) }),
      "ERR_STOP_CONFLICT"
    );
    expect(conflict.message).not.toContain(s.turnId);
  });
});

describe("stop journal regression coverage", () => {
  it("stores fixed v1 receipts with exact key sets for queue/begin/written/acknowledged", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "receipts.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const readReceipt = (O) => {
      const row = rawGet(file, "SELECT result_json, history_json FROM operations WHERE id = ?", [O]);
      expect(Buffer.byteLength(row.result_json, "utf8")).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(row.history_json, "utf8")).toBeLessThanOrEqual(8192);
      return JSON.parse(row.result_json);
    };
    const Rq = uid(1500);
    turns.queueTurn({ ...scope(P1, CX), turnId: Rq, operationId: uid(1501), prompt: "q" });
    const Oq = uid(1502);
    stops.requestStop({ ...scope(P1, CX), turnId: Rq, operationId: Oq });
    const queueReceipt = readReceipt(Oq);
    expect(Object.keys(queueReceipt).sort()).toEqual(["hash", "kind", "outcome", "reason", "target", "v"]);
    expect(queueReceipt.kind).toBe("queue");
    expect(queueReceipt.v).toBe(1);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-shape", uid(1510), uid(1511));
    const O = uid(1512);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    const want = codexTarget("thr-shape", nativeTurnId);
    stops.beginStopDispatch(scopeStop);
    const beginReceipt = readReceipt(O);
    expect(Object.keys(beginReceipt).sort()).toEqual(["hash", "kind", "outcome", "reason", "target", "v"]);
    expect(beginReceipt.kind).toBe("begin");
    expect(beginReceipt.target).toEqual(want);
    stops.recordStopWritten({ ...scopeStop, dispatchTarget: want });
    expect(readReceipt(O).kind).toBe("written");
    stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    const ackReceipt = readReceipt(O);
    expect(Object.keys(ackReceipt).sort()).toEqual(
      ["hash", "kind", "outcome", "reason", "target", "terminalTargetSupplied", "v"]
    );
    expect(ackReceipt.kind).toBe("terminal");
    expect(ackReceipt.outcome).toBe("acknowledged");
    expect(ackReceipt.target).toEqual(want);
    expect(ackReceipt.terminalTargetSupplied).toBe(true);
  });

  it("settles unknown with null after begin, replays null exactly, rejects target mismatch", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "unknown-null.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-u", uid(1530), uid(1531));
    const O = uid(1532);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-u", nativeTurnId);
    const settled = stops.settleStop({ ...scopeStop, outcome: "unknown" });
    expect(settled.state).toBe("unknown");
    const receipt = JSON.parse(
      rawGet(file, "SELECT result_json FROM operations WHERE id = ?", [O]).result_json
    );
    expect(receipt.terminalTargetSupplied).toBe(false);
    expect(receipt.target).toEqual(want);
    expect(stops.settleStop({ ...scopeStop, outcome: "unknown" })).toEqual(settled);
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "unknown", dispatchTarget: want }),
      "ERR_STOP_CONFLICT"
    );
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "unknown", dispatchTarget: codexTarget("thr-u", "nt-other") }),
      "ERR_STOP_CONFLICT"
    );
  });

  it("settles unknown with a supplied target and replays it exactly", () => {
    const dir = tempDir();
    const { stops, turns, records, bindings } = openFresh(dir, "unknown-supplied.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-us", uid(1540), uid(1541));
    const O = uid(1542);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-us", nativeTurnId);
    const settled = stops.settleStop({ ...scopeStop, outcome: "unknown", dispatchTarget: want });
    expect(settled.state).toBe("unknown");
    expect(stops.settleStop({ ...scopeStop, outcome: "unknown", dispatchTarget: want })).toEqual(settled);
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "unknown" }),
      "ERR_STOP_CONFLICT"
    );
  });

  it("settles not_needed with a fixed receipt that carries no target", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "notneeded-shape.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1550);
    const H = uid(1551);
    const O = uid(1552);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "t" });
    stops.requestStop({ ...scope(P1, CX), turnId: R, operationId: O });
    turns.settleTurn({ ...scope(P1, CX), turnId: R, operationId: H, outcome: "failed" });
    const done = stops.settleStop({ ...scope(P1, CX), turnId: R, operationId: O, outcome: "not_needed" });
    expect(done.state).toBe("not_needed");
    const receipt = JSON.parse(
      rawGet(file, "SELECT result_json FROM operations WHERE id = ?", [O]).result_json
    );
    expect(Object.keys(receipt).sort()).toEqual(
      ["hash", "kind", "outcome", "reason", "target", "terminalTargetSupplied", "v"]
    );
    expect(receipt.target).toBeNull();
    expect(receipt.terminalTargetSupplied).toBe(false);
    expect(stops.settleStop({ ...scope(P1, CX), turnId: R, operationId: O, outcome: "not_needed" })).toEqual(done);
  });

  it("acks 512-unit control-char ids within the 8KiB receipt cap", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "control.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const thread = String.fromCharCode(1).repeat(512);
    const nativeTurnId = String.fromCharCode(2).repeat(512);
    const R = uid(1560);
    const H = uid(1561);
    const O = uid(1562);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: thread, evidence: null,
    });
    const s = { ...scope(P1, CX), turnId: R, operationId: H };
    turns.queueTurn({ ...s, prompt: "control work" });
    turns.beginDispatch(s);
    turns.recordWritten(s);
    turns.recordObserved({
      ...s, nativeFact: { nativeIdentity: thread, nativeTurnId, claudeInputUuid: null },
    });
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    const want = codexTarget(thread, nativeTurnId);
    expect(stops.beginStopDispatch(scopeStop).dispatchTarget).toEqual(want);
    expect(stops.recordStopWritten({ ...scopeStop, dispatchTarget: want }).state).toBe("written");
    const acked = stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    expect(acked.state).toBe("acknowledged");
    const row = rawGet(file, "SELECT result_json, history_json FROM operations WHERE id = ?", [O]);
    expect(Buffer.byteLength(row.result_json, "utf8")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(row.history_json, "utf8")).toBeLessThanOrEqual(8192);
    expect(Object.hasOwn(JSON.parse(row.result_json), "terminalTarget")).toBe(false);
    expect(JSON.parse(row.result_json).terminalTargetSupplied).toBe(true);
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).outcome).toBeNull();
  });

  it("rejects exact request retries and reads against a broken parent handoff", () => {
    const dir = tempDir();
    const { store, stops, turns, records, bindings } = openFresh(dir, "parent.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(1570);
    const H = uid(1571);
    const O = uid(1572);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: H, prompt: "work" });
    const args = { ...scope(P1, CX), turnId: R, operationId: O };
    expect(stops.requestStop(args).created).toBe(true);
    store.transaction((tx) => {
      tx.run("UPDATE operations SET owner_generation = 2 WHERE id = ?", [H]);
    });
    expectCode(() => stops.requestStop(args), "ERR_FENCE_CONFLICT");
    expectCode(
      () => stops.getStop({ projectId: P1, conversationId: CX, turnId: R }),
      "ERR_STORAGE"
    );
  });

  it("fails terminal ACK replay on a corrupt native binding without changes", () => {
    const dir = tempDir();
    const { file, store, stops, turns, records, bindings } = openFresh(dir, "ack-replay.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-k", uid(1580), uid(1581));
    const O = uid(1582);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    stops.beginStopDispatch(scopeStop);
    const want = codexTarget("thr-k", nativeTurnId);
    stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    const before = rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O]);
    store.transaction((tx) => {
      tx.run("UPDATE native_refs SET native_thread_id = 'thr-corrupt' WHERE conversation_id = ?", [CX]);
    });
    expectCode(
      () => stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want }),
      "ERR_STORAGE"
    );
    expect(rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O])).toEqual(before);
  });

  it("leaves turn, conversation, native-ref, and fence rows untouched across Stop life", () => {
    const dir = tempDir();
    const { file, stops, turns, records, bindings } = openFresh(dir, "untouched.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const { scope: s, nativeTurnId } = seedObservedCodex(turns, bindings, P1, CX, "thr-n", uid(1590), uid(1591));
    const snapTurn = rawGet(file, "SELECT * FROM turns WHERE id = ?", [s.turnId]);
    const snapConv = rawGet(file, "SELECT * FROM conversations WHERE id = ?", [CX]);
    const snapRef = rawGet(file, "SELECT * FROM native_refs WHERE conversation_id = ?", [CX]);
    const snapFence = rawGet(file, "SELECT * FROM producer_fences WHERE conversation_id = ?", [CX]);
    const O = uid(1592);
    const scopeStop = { ...s, operationId: O };
    stops.requestStop(scopeStop);
    const want = codexTarget("thr-n", nativeTurnId);
    stops.beginStopDispatch(scopeStop);
    stops.recordStopWritten({ ...scopeStop, dispatchTarget: want });
    stops.settleStop({ ...scopeStop, outcome: "acknowledged", dispatchTarget: want });
    expect(rawGet(file, "SELECT * FROM turns WHERE id = ?", [s.turnId])).toEqual(snapTurn);
    expect(rawGet(file, "SELECT * FROM conversations WHERE id = ?", [CX])).toEqual(snapConv);
    expect(rawGet(file, "SELECT * FROM native_refs WHERE conversation_id = ?", [CX])).toEqual(snapRef);
    expect(rawGet(file, "SELECT * FROM producer_fences WHERE conversation_id = ?", [CX])).toEqual(snapFence);
    const snapOp = rawGet(file, "SELECT * FROM operations WHERE id = ?", [O]);
    expect(stops.requestStop(scopeStop).created).toBe(false);
    expect(rawGet(file, "SELECT * FROM operations WHERE id = ?", [O])).toEqual(snapOp);
  });
});
