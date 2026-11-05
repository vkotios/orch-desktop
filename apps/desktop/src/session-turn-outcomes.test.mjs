import { describe, it, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";
import { createSessionEvents } from "../server/session-events.mjs";
import { createSessionBodies } from "../server/session-bodies.mjs";
import { createSessionTurnOutcomes } from "../server/session-turn-outcomes.mjs";

const ownedStores = [];
const ownedDirs = [];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "outcome-test-"));
  ownedDirs.push(dir);
  const s = openSessionStore({ databasePath: join(dir, "test.db") });
  ownedStores.push(s);
  return s;
}

function setupCodexFixture(clock = () => 1000) {
  const s = freshStore();
  const records = createSessionRecords({ store: s });
  const P = randomUUID();
  const C = randomUUID();
  records.createProject({ id: P, name: "synthetic", pathCanonical: "C:/synthetic/outcomes" });
  records.createConversation({ id: C, projectId: P, controller: "codex" });
  const bindings = createSessionBindings({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const claim = bindings.claimProducer({
    projectId: P, conversationId: C, ownerToken: randomUUID(),
    expectedGeneration: 0, evidence: null,
  });
  const scope = {
    projectId: P, conversationId: C,
    ownerToken: claim.ownerToken, ownerGeneration: 1,
    hostGeneration: randomUUID(), evidence: null,
  };
  const turns = createSessionTurns({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const events = createSessionEvents({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const outcomes = createSessionTurnOutcomes({ store: s, verifyOwnerEvidence: () => true, now: clock });
  return { store: s, records, bindings, turns, events, outcomes, P, C, scope };
}

function setupClaudeFixture(clock = () => 1000) {
  const s = freshStore();
  const records = createSessionRecords({ store: s });
  const P = randomUUID();
  const C = randomUUID();
  records.createProject({ id: P, name: "synthetic", pathCanonical: "C:/synthetic/outcomes" });
  records.createConversation({ id: C, projectId: P, controller: "claude" });
  const bindings = createSessionBindings({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const claim = bindings.claimProducer({
    projectId: P, conversationId: C, ownerToken: randomUUID(),
    expectedGeneration: 0, evidence: null,
  });
  const scope = {
    projectId: P, conversationId: C,
    ownerToken: claim.ownerToken, ownerGeneration: 1,
    hostGeneration: randomUUID(), evidence: null,
  };
  const sessionUuid = randomUUID();
  bindings.setRequestedClaudeSession({ ...scope, generation: 1, sessionUuid, evidence: null });
  bindings.bindNativeRef({ ...scope, generation: 1, controller: "claude", nativeSessionUuid: sessionUuid, evidence: null });
  const turns = createSessionTurns({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const events = createSessionEvents({ store: s, verifyOwnerEvidence: () => true, now: clock });
  const outcomes = createSessionTurnOutcomes({ store: s, verifyOwnerEvidence: () => true, now: clock });
  return { store: s, records, bindings, turns, events, outcomes, P, C, scope, sessionUuid };
}

function bindCodexRef(bindings, scope) {
  bindings.bindNativeRef({ ...scope, generation: 1, controller: "codex", nativeThreadId: "thread-1", evidence: null });
}

function queueAndDispatch(turns, scope, turnId, operationId, prompt = "hello") {
  turns.queueTurn({ ...scope, turnId, operationId, prompt });
  turns.beginDispatch({ ...scope, turnId, operationId });
}

function fourTableRaw(s, C) {
  return s.transaction((tx) => ({
    turns: tx.all("SELECT * FROM turns WHERE conversation_id = ?", [C]),
    operations: tx.all("SELECT * FROM operations WHERE conversation_id = ?", [C]),
    events: tx.all("SELECT * FROM events WHERE conversation_id = ?", [C]),
    snapshots: tx.all("SELECT * FROM snapshots WHERE conversation_id = ?", [C]),
  }));
}

afterEach(() => {
  for (const s of ownedStores) { try { s.close(); } catch {} }
  ownedStores.length = 0;
  for (const d of ownedDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  ownedDirs.length = 0;
});

describe("S3b session-turn-outcomes", () => {
  it("1. Codex completed: exact 11 payload fields, event key/kind, return shape, snapshot namespace, frozen API", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nativeFact = { nativeIdentity: "thread-1", nativeTurnId: "turn-1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact });
    const res = outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact, expectedSeq: 0 });
    assert.equal(res.created, true);
    assert.equal(res.event.kind, "turn_outcome");
    assert.equal(res.event.eventKey, "turn_outcome:" + O);
    assert.equal(res.event.seq, 1);
    assert.equal(res.cursor.instanceId, s.instanceId);
    assert.equal(res.cursor.conversationId, C);
    assert.equal(res.cursor.seq, 1);
    // Exact 11 payload fields
    const p = res.event.payload;
    const pKeys = Object.keys(p).sort();
    const expectedKeys = ["conversationId","controller","hostGeneration","nativeFact","operationId","outcome","ownerGeneration","settledAtMs","turnId","turnSeq","v"].sort();
    assert.deepEqual(pKeys, expectedKeys);
    assert.equal(p.v, 1);
    assert.equal(p.conversationId, C);
    assert.equal(p.turnId, T);
    assert.equal(p.operationId, O);
    assert.equal(p.turnSeq, 1);
    assert.equal(p.controller, "codex");
    assert.equal(p.outcome, "completed");
    assert.equal(p.ownerGeneration, 1);
    assert.equal(p.hostGeneration, scope.hostGeneration);
    assert.equal(p.settledAtMs, 1000);
    assert.deepEqual(p.nativeFact, { nativeIdentity: "thread-1", nativeTurnId: "turn-1", claudeInputUuid: null });
    // No prompt/evidence/token/extras
    assert.ok(!("prompt" in p));
    assert.ok(!("evidence" in p));
    assert.ok(!("ownerToken" in p));
    // Snapshot namespace
    const evSnap = s.transaction((tx) => tx.get("SELECT projection_json FROM snapshots WHERE conversation_id = ?", [C]));
    const proj = JSON.parse(evSnap.projection_json);
    assert.deepEqual(proj.state.lastTurnOutcome, p);
    // Frozen API: outcomes object frozen; helper frozen only inside active tx
    assert.ok(Object.isFrozen(outcomes));
    s.transaction((tx) => {
      const inner = outcomes.inTransaction(tx);
      assert.ok(Object.isFrozen(inner));
    });
  });

  it("1b. Codex interrupted + Claude completed exact payload", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "turn-x", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    const res = outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "interrupted", nativeFact: nf, expectedSeq: 0 });
    assert.equal(res.event.payload.outcome, "interrupted");
    assert.equal(res.event.payload.nativeFact.nativeTurnId, "turn-x");

    // Claude completed
    const cl = setupClaudeFixture();
    const T2 = randomUUID(), O2 = randomUUID(), inputUuid = randomUUID();
    cl.turns.queueTurn({ ...cl.scope, turnId: T2, operationId: O2, prompt: "hi", claudeInputUuid: inputUuid });
    cl.turns.beginDispatch({ ...cl.scope, turnId: T2, operationId: O2 });
    const cFact = { nativeIdentity: cl.sessionUuid, nativeTurnId: null, claudeInputUuid: inputUuid };
    cl.turns.recordObserved({ ...cl.scope, turnId: T2, operationId: O2, nativeFact: cFact });
    const res2 = cl.outcomes.settleTurn({ ...cl.scope, turnId: T2, operationId: O2, outcome: "completed", nativeFact: cFact, expectedSeq: 0 });
    assert.equal(res2.event.payload.controller, "claude");
    assert.equal(res2.event.payload.nativeFact.nativeIdentity, cl.sessionUuid);
    assert.equal(res2.event.payload.nativeFact.nativeTurnId, null);
    assert.equal(res2.event.payload.nativeFact.claudeInputUuid, inputUuid);
  });

  it("1c. Malicious eventKey/payload/projection ignored (caller cannot choose them)", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    // Extraneous fields are ignored; internal key/kind/payload/projection used
    const res = outcomes.settleTurn({
      ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0,
      eventKey: "MALICIOUS", kind: "evil", payload: { hack: true }, projection: { state: { evil: 1 }, bodyRefs: [] },
    });
    assert.equal(res.event.eventKey, "turn_outcome:" + O);
    assert.equal(res.event.kind, "turn_outcome");
    assert.ok(!("hack" in res.event.payload));
    assert.ok(!("evil" in res.event.payload));
  });

  it("2. queued failed/unknown fact null; observed then unknown stays null; completed without fact rejected; failed after dispatch missing fact rejected", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    // queued failed (no dispatch) - factless
    const T1 = randomUUID(), O1 = randomUUID();
    turns.queueTurn({ ...scope, turnId: T1, operationId: O1, prompt: "p" });
    const r1 = outcomes.settleTurn({ ...scope, turnId: T1, operationId: O1, outcome: "failed", expectedSeq: 0 });
    assert.equal(r1.event.payload.nativeFact, null);
    assert.equal(r1.event.payload.outcome, "failed");

    // queued unknown - factless
    const T2 = randomUUID(), O2 = randomUUID();
    turns.queueTurn({ ...scope, turnId: T2, operationId: O2, prompt: "p" });
    const r2 = outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "unknown", expectedSeq: 1 });
    assert.equal(r2.event.payload.nativeFact, null);

    // observed then unknown without terminal fact: nativeFact null despite earlier nativeTurnId
    const T3 = randomUUID(), O3 = randomUUID();
    queueAndDispatch(turns, scope, T3, O3);
    const nf3 = { nativeIdentity: "thread-1", nativeTurnId: "obs-turn", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T3, operationId: O3, nativeFact: nf3 });
    const r3 = outcomes.settleTurn({ ...scope, turnId: T3, operationId: O3, outcome: "unknown", expectedSeq: 2 });
    assert.equal(r3.event.payload.nativeFact, null);

    // completed without fact rejected by base (ERR_TURN_CONFLICT)
    const T4 = randomUUID(), O4 = randomUUID();
    queueAndDispatch(turns, scope, T4, O4);
    try {
      outcomes.settleTurn({ ...scope, turnId: T4, operationId: O4, outcome: "completed", expectedSeq: 3 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_TURN_CONFLICT"); }

    // failed after dispatch missing fact rejected
    const T5 = randomUUID(), O5 = randomUUID();
    queueAndDispatch(turns, scope, T5, O5);
    try {
      outcomes.settleTurn({ ...scope, turnId: T5, operationId: O5, outcome: "failed", expectedSeq: 3 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_TURN_CONFLICT"); }
  });

  it("2b. Changed retry outcome/nativeFact/omitted original fact rejected; proof denial/stale owner rollback", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });
    // Changed outcome retry
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "failed", nativeFact: nf, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_TURN_CONFLICT"); }
    // Changed nativeFact retry
    const nf2 = { nativeIdentity: "thread-1", nativeTurnId: "t2", claudeInputUuid: null };
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf2, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_TURN_CONFLICT"); }
    // Omitted original fact retry (completed needs fact)
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_TURN_CONFLICT"); }

    // Proof denial rollback
    const s2 = freshStore();
    const records2 = createSessionRecords({ store: s2 });
    const P2 = randomUUID(), C2 = randomUUID();
    records2.createProject({ id: P2, name: "x", pathCanonical: "C:/x" });
    records2.createConversation({ id: C2, projectId: P2, controller: "codex" });
    const b2 = createSessionBindings({ store: s2, verifyOwnerEvidence: () => true });
    const cl2 = b2.claimProducer({ projectId: P2, conversationId: C2, ownerToken: randomUUID(), expectedGeneration: 0, evidence: null });
    const sc2 = { projectId: P2, conversationId: C2, ownerToken: cl2.ownerToken, ownerGeneration: 1, hostGeneration: randomUUID(), evidence: null };
    b2.bindNativeRef({ ...sc2, generation: 1, controller: "codex", nativeThreadId: "th", evidence: null });
    const t2 = createSessionTurns({ store: s2, verifyOwnerEvidence: () => true });
    const ocDeny = createSessionTurnOutcomes({ store: s2, verifyOwnerEvidence: () => false });
    const Td = randomUUID(), Od = randomUUID();
    t2.queueTurn({ ...sc2, turnId: Td, operationId: Od, prompt: "p" });
    try {
      ocDeny.settleTurn({ ...sc2, turnId: Td, operationId: Od, outcome: "failed", expectedSeq: 0 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_OWNER_UNVERIFIED"); }

    // Stale owner token on exact retry -> ERR_FENCE_CONFLICT, full raw unchanged
    const s3 = freshStore();
    const records3 = createSessionRecords({ store: s3 });
    const P3 = randomUUID(), C3 = randomUUID();
    records3.createProject({ id: P3, name: "x", pathCanonical: "C:/x" });
    records3.createConversation({ id: C3, projectId: P3, controller: "codex" });
    const b3 = createSessionBindings({ store: s3, verifyOwnerEvidence: () => true, now: () => 1000 });
    const cl3 = b3.claimProducer({ projectId: P3, conversationId: C3, ownerToken: randomUUID(), expectedGeneration: 0, evidence: null });
    const sc3 = { projectId: P3, conversationId: C3, ownerToken: cl3.ownerToken, ownerGeneration: 1, hostGeneration: randomUUID(), evidence: null };
    b3.bindNativeRef({ ...sc3, generation: 1, controller: "codex", nativeThreadId: "th3", evidence: null });
    const t3 = createSessionTurns({ store: s3, verifyOwnerEvidence: () => true, now: () => 1000 });
    const oc3 = createSessionTurnOutcomes({ store: s3, verifyOwnerEvidence: () => true, now: () => 1000 });
    const Tr = randomUUID(), Or = randomUUID();
    t3.queueTurn({ ...sc3, turnId: Tr, operationId: Or, prompt: "p" });
    oc3.settleTurn({ ...sc3, turnId: Tr, operationId: Or, outcome: "failed", expectedSeq: 0 });
    const rawBeforeStale = s3.transaction((tx) => ({
      turns: tx.all("SELECT * FROM turns WHERE conversation_id = ?", [C3]),
      operations: tx.all("SELECT * FROM operations WHERE conversation_id = ?", [C3]),
      events: tx.all("SELECT * FROM events WHERE conversation_id = ?", [C3]),
      snapshots: tx.all("SELECT * FROM snapshots WHERE conversation_id = ?", [C3]),
    }));
    try {
      oc3.settleTurn({ ...sc3, turnId: Tr, operationId: Or, outcome: "failed", expectedSeq: 1, ownerToken: randomUUID() });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_FENCE_CONFLICT"); }
    const rawAfterStale = s3.transaction((tx) => ({
      turns: tx.all("SELECT * FROM turns WHERE conversation_id = ?", [C3]),
      operations: tx.all("SELECT * FROM operations WHERE conversation_id = ?", [C3]),
      events: tx.all("SELECT * FROM events WHERE conversation_id = ?", [C3]),
      snapshots: tx.all("SELECT * FROM snapshots WHERE conversation_id = ?", [C3]),
    }));
    assert.deepEqual(rawAfterStale, rawBeforeStale);
  });

  it("3. Two turns: newer settles first then older -> lastTurnOutcome stays newer. Preserve prior state/bodyRefs. Equal namespace allowed.", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    // Seed a generic event with prior state and bodyRefs
    const bodies = createSessionBodies({ store: s, verifyOwnerEvidence: () => true });
    const bodyId = randomUUID();
    bodies.putBody({ ...scope, bodyId, text: "prior" });
    const protoState = JSON.parse('{"custom":"keep","__proto__":{"safe":true}}');
    events.appendEvent({ ...scope, eventKey: "seed", kind: "message_delta", payload: { x: 1 }, expectedSeq: 0, projection: { state: protoState, bodyRefs: [bodyId] } });

    // Turn 1 (seq 1)
    const T1 = randomUUID(), O1 = randomUUID();
    queueAndDispatch(turns, scope, T1, O1);
    const nf1 = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T1, operationId: O1, nativeFact: nf1 });

    // Turn 2 (seq 2)
    const T2 = randomUUID(), O2 = randomUUID();
    queueAndDispatch(turns, scope, T2, O2);
    const nf2 = { nativeIdentity: "thread-1", nativeTurnId: "t2", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T2, operationId: O2, nativeFact: nf2 });

    // Settle newer (turn 2) first at seq 1
    const r2 = outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "completed", nativeFact: nf2, expectedSeq: 1 });
    assert.equal(r2.created, true);
    assert.equal(r2.event.payload.turnSeq, 2);

    // Settle older (turn 1) at seq 2 -> event created but namespace stays newer
    const r1 = outcomes.settleTurn({ ...scope, turnId: T1, operationId: O1, outcome: "completed", nativeFact: nf1, expectedSeq: 2 });
    assert.equal(r1.created, true);
    assert.equal(r1.event.payload.turnSeq, 1);

    // Snapshot: lastTurnOutcome should be turn 2 (higher seq)
    const snap = events.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap.state.lastTurnOutcome.turnSeq, 2);
    assert.equal(snap.state.lastTurnOutcome.turnId, T2);
    // Prior state preserved including own __proto__ key without pollution
    assert.equal(snap.state.custom, "keep");
    assert.ok(Object.prototype.hasOwnProperty.call(snap.state, "__proto__"));
    assert.equal(snap.state.__proto__.safe, true);
    assert.equal({}.safe, undefined);
    // bodyRefs preserved
    assert.deepEqual(snap.bodyRefs, [bodyId]);

    // Equal namespace retry: settle turn 2 again -> created false, no regression
    const r2retry = outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "completed", nativeFact: nf2, expectedSeq: 3 });
    assert.equal(r2retry.created, false);
    const snap2 = events.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap2.state.lastTurnOutcome.turnSeq, 2);
  });

  it("3b. Historical retry stale expectedSeq after other events: created false, original cursor/history/timestamp/four-table exact no touch", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    const first = outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });
    assert.equal(first.created, true);
    // Add another event to advance tip
    events.appendEvent({ ...scope, eventKey: "other", kind: "message_delta", payload: { z: 1 }, expectedSeq: 1, projection: { state: { lastTurnOutcome: first.event.payload }, bodyRefs: [] } });
    // Retry with stale expectedSeq
    const rawBefore = fourTableRaw(s, C);
    const retry = outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });
    assert.equal(retry.created, false);
    assert.equal(retry.event.seq, 1);
    assert.equal(retry.cursor.seq, 1);
    assert.equal(retry.event.createdAtMs, 1000);
    assert.deepEqual(fourTableRaw(s, C), rawBefore);
  });

  it("4. Stale expectedSeq new outcome -> ERR_EVENT_VERSION_CONFLICT; key collision mismatch -> rollback all4table", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    // Stale expectedSeq
    const rawBefore = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 5 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_EVENT_VERSION_CONFLICT"); }
    assert.deepEqual(fourTableRaw(s, C), rawBefore);

    // Real key collision: generic append with same eventKey but wrong kind BEFORE settlement
    const T2 = randomUUID(), O2 = randomUUID();
    turns.queueTurn({ ...scope, turnId: T2, operationId: O2, prompt: "p" });
    const collKey = "turn_outcome:" + O2;
    events.appendEvent({ ...scope, eventKey: collKey, kind: "wrong_kind", payload: { x: 1 }, expectedSeq: 0, projection: { state: {}, bodyRefs: [] } });
    const rawBeforeColl = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "failed", expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_EVENT_KEY_CONFLICT"); }
    assert.deepEqual(fourTableRaw(s, C), rawBeforeColl);

    // Key collision with wrong payload (same key, same kind, different payload)
    const T3 = randomUUID(), O3 = randomUUID();
    turns.queueTurn({ ...scope, turnId: T3, operationId: O3, prompt: "p" });
    const collKey3 = "turn_outcome:" + O3;
    events.appendEvent({ ...scope, eventKey: collKey3, kind: "turn_outcome", payload: { x: 999 }, expectedSeq: 1, projection: { state: {}, bodyRefs: [] } });
    const rawBeforeColl3 = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T3, operationId: O3, outcome: "failed", expectedSeq: 2 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_EVENT_KEY_CONFLICT"); }
    assert.deepEqual(fourTableRaw(s, C), rawBeforeColl3);

    // Idempotent retry: settle same op same payload -> created false
    outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 2 });
    const raw2 = fourTableRaw(s, C);
    const retry = outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
    assert.equal(retry.created, false);
    const raw3 = fourTableRaw(s, C);
    assert.deepEqual(raw3.events, raw2.events);
    assert.deepEqual(raw3.snapshots, raw2.snapshots);
  });

  it("5. ABORT/IGNORE triggers -> ERR_STORAGE all4table rollback; outer composition throw rollback; success outer commit", () => {
    const { store: s, bindings, turns, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    // Preseed snapshot so UPDATE fires
    const events = createSessionEvents({ store: s, verifyOwnerEvidence: () => true, now: () => 1000 });
    events.appendEvent({ ...scope, eventKey: "seed", kind: "message_delta", payload: { a: 0 }, expectedSeq: 0, projection: { state: {}, bodyRefs: [] } });

    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });

    function raw() { return fourTableRaw(s, C); }

    // ABORT trigger
    const before = raw();
    s.transaction((tx) => { tx.run("CREATE TEMP TRIGGER t_abort BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'fixture'); END"); });
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    assert.deepEqual(raw(), before);
    s.transaction((tx) => { tx.run("DROP TRIGGER t_abort"); });

    // IGNORE trigger
    const before2 = raw();
    s.transaction((tx) => { tx.run("CREATE TEMP TRIGGER t_ignore BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(IGNORE); END"); });
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    assert.deepEqual(raw(), before2);
    s.transaction((tx) => { tx.run("DROP TRIGGER t_ignore"); });

    // Outer composition throw rollback
    const before3 = raw();
    try {
      s.transaction((tx) => {
        const inner = outcomes.inTransaction(tx);
        inner.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
        throw new Error("marker");
      });
    } catch (e) { assert.equal(e.message, "marker"); }
    assert.deepEqual(raw(), before3);

    // Success outer commit
    s.transaction((tx) => {
      const inner = outcomes.inTransaction(tx);
      inner.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
    });
    const after = raw();
    assert.equal(after.events.length, 2);
    assert.equal(after.turns[0].outcome, "completed");
  });

  it("6. Generic state <=32KiB initially but adding summary exceeds cap -> reject no trimming, all4table rollback. State/bodyRefs retained.", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    // Seed with large generic state near cap (initial snapshot must be <= 32768)
    const bigVal = "x".repeat(32500);
    events.appendEvent({ ...scope, eventKey: "big", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: { big: bigVal }, bodyRefs: [] } });
    // Assert initial snapshot JSON byte length <= 32768
    const initSnap = s.transaction((tx) => tx.get("SELECT projection_json FROM snapshots WHERE conversation_id = ?", [C]));
    assert.ok(Buffer.byteLength(initSnap.projection_json, "utf8") <= 32768);

    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });

    const before = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    const after = fourTableRaw(s, C);
    assert.deepEqual(after, before);
    // Generic state retained
    const snap = events.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap.state.big, bigVal);
  });

  it("7. Malformed/dangling namespace and valid-shaped mismatched journal -> ERR_STORAGE + full rollback", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);

    // Seed a snapshot with a malformed lastTurnOutcome namespace via generic events
    const fakeNamespace = {
      v: 1, conversationId: C, turnId: randomUUID(), operationId: randomUUID(),
      turnSeq: 1, controller: "codex", outcome: "completed",
      ownerGeneration: 1, hostGeneration: randomUUID(), settledAtMs: 999,
      nativeFact: null,
    };
    events.appendEvent({ ...scope, eventKey: "seed", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: { lastTurnOutcome: fakeNamespace }, bodyRefs: [] } });

    // Now settle a real turn -> validateExistingNamespace finds dangling turnId -> ERR_STORAGE
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    const before = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    assert.deepEqual(fourTableRaw(s, C), before);
  });

  describe("7b. Valid-shaped mismatched journal: wrong conversationId, wrong timestamp, extra native fields, unsupported version", () => {
    // Helper: seed a valid turn+namespace, then corrupt namespace, then settle new turn -> ERR_STORAGE
    function corruptAndSettle(corruptFn) {
      const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
      bindCodexRef(bindings, scope);
      const T = randomUUID(), O = randomUUID();
      queueAndDispatch(turns, scope, T, O);
      const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
      turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
      outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });

      // Corrupt namespace via generic append
      const validPayload = { v: 1, conversationId: C, turnId: T, operationId: O, turnSeq: 1, controller: "codex", outcome: "completed", ownerGeneration: 1, hostGeneration: scope.hostGeneration, settledAtMs: 1000, nativeFact: { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null } };
      const corrupted = corruptFn(JSON.parse(JSON.stringify(validPayload)), C, scope);
      events.appendEvent({ ...scope, eventKey: "corrupt:" + randomUUID(), kind: "message_delta", payload: { a: 1 }, expectedSeq: 1, projection: { state: { lastTurnOutcome: corrupted }, bodyRefs: [] } });

      // Settle new turn -> validateExistingNamespace finds mismatch -> ERR_STORAGE
      const T2 = randomUUID(), O2 = randomUUID();
      queueAndDispatch(turns, scope, T2, O2);
      const nf2 = { nativeIdentity: "thread-1", nativeTurnId: "t2", claudeInputUuid: null };
      turns.recordObserved({ ...scope, turnId: T2, operationId: O2, nativeFact: nf2 });
      const before = fourTableRaw(s, C);
      try {
        outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "completed", nativeFact: nf2, expectedSeq: 2 });
        assert.fail();
      } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
      assert.deepEqual(fourTableRaw(s, C), before);
    }

    it("7b-a wrong conversationId", () => corruptAndSettle((p) => { p.conversationId = randomUUID(); return p; }));
    it("7b-b malformed conversationId", () => corruptAndSettle((p) => { p.conversationId = "bad"; return p; }));
    it("7b-c wrong settledAtMs", () => corruptAndSettle((p) => { p.settledAtMs = 9999; return p; }));
    it("7b-d unsupported version v=2", () => corruptAndSettle((p) => { p.v = 2; return p; }));
    it("7b-e nativeFact extra key", () => corruptAndSettle((p) => { p.nativeFact.extra = "bad"; return p; }));
    it("7b-f extra root field", () => corruptAndSettle((p) => { p.extraRoot = 1; return p; }));
    it("7b-g missing root field", () => corruptAndSettle((p) => { delete p.outcome; return p; }));
    it("7b-h wrong ownerGeneration", () => corruptAndSettle((p) => { p.ownerGeneration = 99; return p; }));
    it("7b-i changed nativeFact ID", () => corruptAndSettle((p) => { p.nativeFact.nativeIdentity = "other"; return p; }));
  });

  it("7c. Journal terminal atMs mismatch vs turn settledAtMs -> ERR_STORAGE full4 unchanged", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });

    // Corrupt the operation history_json: change terminal entry atMs while keeping valid JSON
    s.transaction((tx) => {
      const row = tx.get("SELECT history_json FROM operations WHERE conversation_id = ? AND turn_id = ?", [C, T]);
      const hist = JSON.parse(row.history_json);
      const term = hist.find((e) => e.kind === "terminal");
      term.atMs = 9999;
      tx.run("UPDATE operations SET history_json = ? WHERE conversation_id = ? AND turn_id = ?", [JSON.stringify(hist), C, T]);
    });

    // Next outcome settle -> deriveOutcomePayload finds atMs mismatch -> ERR_STORAGE
    const T2 = randomUUID(), O2 = randomUUID();
    queueAndDispatch(turns, scope, T2, O2);
    const nf2 = { nativeIdentity: "thread-1", nativeTurnId: "t2", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T2, operationId: O2, nativeFact: nf2 });
    const before = fourTableRaw(s, C);
    try {
      outcomes.settleTurn({ ...scope, turnId: T2, operationId: O2, outcome: "completed", nativeFact: nf2, expectedSeq: 1 });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    assert.deepEqual(fourTableRaw(s, C), before);
  });

  it("8. Persisted reopen: event/snapshot/turn consistency; same-lineage helper works; foreign store rejected", () => {
    const { store: s, bindings, turns, events, outcomes, P, C, scope } = setupCodexFixture();
    bindCodexRef(bindings, scope);
    const T = randomUUID(), O = randomUUID();
    queueAndDispatch(turns, scope, T, O);
    const nf = { nativeIdentity: "thread-1", nativeTurnId: "t1", claudeInputUuid: null };
    turns.recordObserved({ ...scope, turnId: T, operationId: O, nativeFact: nf });
    outcomes.settleTurn({ ...scope, turnId: T, operationId: O, outcome: "completed", nativeFact: nf, expectedSeq: 0 });

    // Close and reopen
    const dbPath = join(ownedDirs.at(-1), "test.db");
    s.close();
    const store = openSessionStore({ databasePath: dbPath });
    ownedStores.push(store);
    const outcomes2 = createSessionTurnOutcomes({ store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const events2 = createSessionEvents({ store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const turns2 = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 2000 });

    // Turn consistency
    const turn = turns2.getTurn({ projectId: P, conversationId: C, turnId: T });
    assert.equal(turn.outcome, "completed");
    // Event consistency
    const poll = events2.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.equal(poll.events.length, 1);
    assert.equal(poll.events[0].kind, "turn_outcome");
    // Snapshot consistency
    const snap = events2.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap.state.lastTurnOutcome.turnId, T);

    // Same-lineage helper works
    store.transaction((tx) => {
      const inner = outcomes2.inTransaction(tx);
      assert.ok(typeof inner.settleTurn === "function");
    });

    // Foreign store rejected
    const foreignDir = mkdtempSync(join(tmpdir(), "outcome-test-foreign-"));
    ownedDirs.push(foreignDir);
    const foreign = openSessionStore({ databasePath: join(foreignDir, "foreign.db") });
    ownedStores.push(foreign);
    try {
      foreign.transaction((tx) => {
        outcomes2.inTransaction(tx);
      });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
  });
});
