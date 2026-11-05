// CHO-03 S3d typed tool lifecycle facts — Vitest tests.
// Real temp SQLite; no mocks of the module under test.

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";
import { createSessionBodies } from "../server/session-bodies.mjs";
import { createSessionEvents } from "../server/session-events.mjs";
import { createSessionTurnOutcomes } from "../server/session-turn-outcomes.mjs";
import { createSessionMessageDeltas } from "../server/session-message-deltas.mjs";
import { createSessionToolFacts } from "../server/session-tool-facts.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ownedStores = [];
const ownedDirs = [];

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "s3d-test-"));
  ownedDirs.push(dir);
  const dbPath = join(dir, "test.db");
  const store = openSessionStore({ databasePath: dbPath });
  ownedStores.push(store);
  return { store, dir, path: dbPath };
}

function makeCodexFixture() {
  const fixture = makeStore();
  const { store } = fixture;
  const P = randomUUID();
  const C = randomUUID();
  const records = createSessionRecords({ store });
  records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/tools" });
  records.createConversation({ id: C, projectId: P, controller: "codex" });

  const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
  const ownerToken = randomUUID();
  const claim = bindings.claimProducer({
    projectId: P,
    conversationId: C,
    ownerToken,
    expectedGeneration: 0,
    evidence: null,
  });
  const hostGeneration = randomUUID();
  const scope = {
    projectId: P,
    conversationId: C,
    ownerToken: claim.ownerToken,
    ownerGeneration: 1,
    hostGeneration,
    evidence: null,
  };
  bindings.bindNativeRef({
    ...scope,
    generation: 1,
    controller: "codex",
    nativeThreadId: "thread",
  });

  const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
  const T = randomUUID();
  const O = randomUUID();
  turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic" });
  turns.beginDispatch({ ...scope, turnId: T, operationId: O });
  turns.recordObserved({
    ...scope,
    turnId: T,
    operationId: O,
    nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
  });

  return { ...fixture, P, C, T, O, scope, turns, bindings, records };
}

function makeClaudeFixture() {
  const fixture = makeStore();
  const { store } = fixture;
  const P = randomUUID();
  const C = randomUUID();
  const records = createSessionRecords({ store });
  records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/tools" });
  records.createConversation({ id: C, projectId: P, controller: "claude" });

  const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
  const ownerToken = randomUUID();
  const claim = bindings.claimProducer({
    projectId: P,
    conversationId: C,
    ownerToken,
    expectedGeneration: 0,
    evidence: null,
  });
  const hostGeneration = randomUUID();
  const scope = {
    projectId: P,
    conversationId: C,
    ownerToken: claim.ownerToken,
    ownerGeneration: 1,
    hostGeneration,
    evidence: null,
  };
  const sessionUuid = randomUUID();
  bindings.setRequestedClaudeSession({ ...scope, generation: 1, sessionUuid });
  bindings.bindNativeRef({
    ...scope,
    generation: 1,
    controller: "claude",
    nativeSessionUuid: sessionUuid,
  });

  const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
  const T = randomUUID();
  const O = randomUUID();
  const inputUUID = randomUUID();
  turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic", claudeInputUuid: inputUUID });
  turns.beginDispatch({ ...scope, turnId: T, operationId: O });
  turns.recordObserved({
    ...scope,
    turnId: T,
    operationId: O,
    nativeFact: { nativeIdentity: sessionUuid, nativeTurnId: null, claudeInputUuid: inputUUID },
  });

  return { ...fixture, P, C, T, O, scope, turns, bindings, records, sessionUuid, inputUUID };
}

function rawRows(store, table, orderCol = "id") {
  return store.transaction((tx) =>
    tx.all(`SELECT * FROM ${table} ORDER BY ${orderCol}`)
  );
}

function snapshotRow(store, conversationId) {
  return store.transaction((tx) =>
    tx.get("SELECT * FROM snapshots WHERE conversation_id = ?", [conversationId])
  );
}

function baseToolArgs(fx, overrides = {}) {
  return {
    ...fx.scope,
    turnId: fx.T,
    operationId: fx.O,
    factId: randomUUID(),
    toolCallId: "call-1",
    phase: "started",
    toolTitle: "command",
    toolStatus: "inProgress",
    expectedSeq: 0,
    ...overrides,
  };
}

afterEach(() => {
  for (const s of ownedStores) {
    try { s.close(); } catch { /* already closed */ }
  }
  ownedStores.length = 0;
  for (const d of ownedDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  ownedDirs.length = 0;
});

// ─── 1. Codex started/completed typed payload ───────────────────────────────

describe("S3d Codex tool lifecycle payload", () => {
  it("started then completed command facts: exact payload, key tool_fact:factId, no summary/evidence leak", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });

    const startedId = randomUUID();
    const started = tools.appendToolFact(baseToolArgs(fx, {
      factId: startedId,
      toolCallId: "item_command_1",
      phase: "started",
      toolTitle: "command",
      toolStatus: "inProgress",
      expectedSeq: 0,
    }));

    assert.equal(started.created, true);
    assert.equal(started.body, null);
    assert.equal(started.event.eventKey, `tool_fact:${startedId}`);
    assert.equal(started.event.kind, "tool_fact");

    const payload = started.event.payload;
    assert.deepEqual(Object.keys(payload).sort(), [
      "bodyRef", "controller", "conversationId", "factId", "hostGeneration",
      "nativeFact", "nativeMessageId", "operationId", "ownerGeneration",
      "phase", "toolCallId", "toolStatus", "toolTitle", "turnId", "turnSeq", "v",
    ]);
    assert.equal(payload.v, 1);
    assert.equal(payload.conversationId, fx.C);
    assert.equal(payload.turnId, fx.T);
    assert.equal(payload.operationId, fx.O);
    assert.equal(payload.controller, "codex");
    assert.equal(payload.factId, startedId);
    assert.equal(payload.toolCallId, "item_command_1");
    assert.equal(payload.phase, "started");
    assert.equal(payload.toolTitle, "command");
    assert.equal(payload.toolStatus, "inProgress");
    assert.equal(payload.nativeMessageId, null);
    assert.equal(payload.bodyRef, null);
    assert.deepEqual(payload.nativeFact, {
      nativeIdentity: "thread",
      nativeTurnId: "native-turn",
      claudeInputUuid: null,
    });

    const completedId = randomUUID();
    const completed = tools.appendToolFact(baseToolArgs(fx, {
      factId: completedId,
      toolCallId: "item_command_1",
      phase: "completed",
      toolTitle: "command",
      toolStatus: "completed",
      summaryText: "exit 0\nok",
      expectedSeq: 1,
    }));
    assert.equal(completed.created, true);
    assert.ok(completed.body);
    assert.equal(completed.body.id, completedId);
    assert.equal(completed.event.payload.bodyRef.id, completedId);
    assert.deepEqual(Object.keys(completed.event.payload.bodyRef).sort(), [
      "byteLength", "id", "sha256Hex",
    ]);

    const rawEvent = JSON.stringify(completed.event);
    assert.ok(!rawEvent.includes("exit 0"));
    assert.ok(!rawEvent.includes("synthetic"));
    assert.ok(!rawEvent.includes(fx.scope.ownerToken));

    const snap = snapshotRow(fx.store, fx.C);
    const snapState = JSON.parse(snap.projection_json).state;
    assert.equal(snapState.lastToolTurn.turnId, fx.T);
    assert.ok(!JSON.stringify(snapState).includes("exit 0"));
    assert.ok(!JSON.stringify(snapState).includes(fx.scope.ownerToken));
  });

  it("Unicode summary roundtrip via readBodyChunk; empty summary accepted with body", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });

    const uniId = randomUUID();
    const text = "line1\nline2\ttab\r\nemoji: 🎉🚀\u00e9\u00e8\u00ea";
    tools.appendToolFact(baseToolArgs(fx, {
      factId: uniId,
      phase: "completed",
      toolStatus: "completed",
      summaryText: text,
      expectedSeq: 0,
    }));
    const chunk = bodies.readBodyChunk({
      projectId: fx.P,
      conversationId: fx.C,
      bodyId: uniId,
      offsetBytes: 0,
      lengthBytes: 16384,
    });
    assert.equal(Buffer.from(chunk.dataBase64, "base64").toString("utf8"), text);

    const emptyId = randomUUID();
    const empty = tools.appendToolFact(baseToolArgs(fx, {
      factId: emptyId,
      toolCallId: "call-empty",
      phase: "completed",
      toolStatus: "failed",
      summaryText: "",
      expectedSeq: 1,
    }));
    assert.equal(empty.created, true);
    assert.equal(empty.body.byteLength, 0);
    assert.equal(empty.event.payload.bodyRef.byteLength, 0);
  });

  it("optional summary omitted: no body row; frozen API; no constructor I/O", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    assert.ok(Object.isFrozen(tools));
    assert.ok(typeof tools.appendToolFact === "function");
    assert.ok(typeof tools.inTransaction === "function");

    fx.store.transaction((tx) => {
      const helper = tools.inTransaction(tx);
      assert.ok(Object.isFrozen(helper));
      assert.ok(typeof helper.appendToolFact === "function");
    });

    const factId = randomUUID();
    const result = tools.appendToolFact(baseToolArgs(fx, { factId }));
    assert.equal(result.created, true);
    assert.equal(result.body, null);
    assert.equal(result.event.payload.bodyRef, null);
    assert.equal(rawRows(fx.store, "large_bodies").length, 0);

    const storeLike = {
      instanceId: randomUUID(),
      transaction() { throw new Error("unexpected constructor I/O"); },
    };
    const tools2 = createSessionToolFacts({
      store: storeLike,
      verifyOwnerEvidence: () => true,
      now: () => 1000,
    });
    assert.ok(Object.isFrozen(tools2));
  });
});

// ─── 2. Claude + declined/failed ────────────────────────────────────────────

describe("S3d Claude facts and declined/failed statuses", () => {
  it("Claude tool with nativeMessageId and observed session/input fact", () => {
    const fx = makeClaudeFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    const result = tools.appendToolFact(baseToolArgs(fx, {
      factId,
      toolCallId: "toolu_01",
      toolTitle: "Read",
      phase: "completed",
      toolStatus: "completed",
      nativeMessageId: "msg-claude-1",
      summaryText: "file contents",
      expectedSeq: 0,
    }));
    assert.equal(result.created, true);
    assert.equal(result.event.payload.nativeMessageId, "msg-claude-1");
    assert.deepEqual(result.event.payload.nativeFact, {
      nativeIdentity: fx.sessionUuid,
      nativeTurnId: null,
      claudeInputUuid: fx.inputUUID,
    });
  });

  it("declined and failed completed phases accepted", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const declined = tools.appendToolFact(baseToolArgs(fx, {
      factId: randomUUID(),
      toolCallId: "call-declined",
      phase: "completed",
      toolTitle: "command",
      toolStatus: "declined",
      expectedSeq: 0,
    }));
    assert.equal(declined.created, true);
    assert.equal(declined.event.payload.toolStatus, "declined");

    const failed = tools.appendToolFact(baseToolArgs(fx, {
      factId: randomUUID(),
      toolCallId: "call-failed",
      phase: "completed",
      toolTitle: "fileChange",
      toolStatus: "failed",
      summaryText: "permission denied",
      expectedSeq: 1,
    }));
    assert.equal(failed.created, true);
    assert.equal(failed.event.payload.toolStatus, "failed");
  });
});

// ─── 3. Phase/status mismatch + turn/idempotency/fence/proof ────────────────

describe("S3d phase coupling and admission guards", () => {
  it("phase/status mismatches reject ERR_INVALID_RECORD", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const cases = [
      ["started+completed", { phase: "started", toolStatus: "completed" }],
      ["started+failed", { phase: "started", toolStatus: "failed" }],
      ["started+declined", { phase: "started", toolStatus: "declined" }],
      ["completed+inProgress", { phase: "completed", toolStatus: "inProgress" }],
      ["bad phase", { phase: "running", toolStatus: "inProgress" }],
      ["bad status", { phase: "started", toolStatus: "running" }],
    ];
    for (const [label, patch] of cases) {
      try {
        tools.appendToolFact(baseToolArgs(fx, patch));
        assert.fail(`should have thrown for ${label}`);
      } catch (e) {
        assert.equal(e.code, "ERR_INVALID_RECORD", `failed for ${label}`);
      }
    }
  });

  it("queued unobserved turn denied ERR_TURN_STATE", () => {
    const fixture = makeStore();
    const { store } = fixture;
    const P = randomUUID();
    const C = randomUUID();
    const records = createSessionRecords({ store });
    records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/tools" });
    records.createConversation({ id: C, projectId: P, controller: "codex" });
    const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
    const ownerToken = randomUUID();
    const claim = bindings.claimProducer({
      projectId: P, conversationId: C, ownerToken, expectedGeneration: 0, evidence: null,
    });
    const hostGeneration = randomUUID();
    const scope = {
      projectId: P, conversationId: C, ownerToken: claim.ownerToken,
      ownerGeneration: 1, hostGeneration, evidence: null,
    };
    bindings.bindNativeRef({ ...scope, generation: 1, controller: "codex", nativeThreadId: "thread" });
    const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
    const T = randomUUID();
    const O = randomUUID();
    turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic" });

    const tools = createSessionToolFacts({ store, verifyOwnerEvidence: () => true, now: () => 2000 });
    try {
      tools.appendToolFact({
        ...scope, turnId: T, operationId: O, factId: randomUUID(),
        toolCallId: "x", phase: "started", toolTitle: "command",
        toolStatus: "inProgress", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }
  });

  it("fresh fact after terminal ERR_TURN_STATE; historical same fact after terminal+stale expectedSeq returns original", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    const r1 = tools.appendToolFact(baseToolArgs(fx, {
      factId,
      summaryText: "first",
      phase: "completed",
      toolStatus: "completed",
    }));
    assert.equal(r1.created, true);

    const outcomes = createSessionTurnOutcomes({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 3000,
    });
    outcomes.settleTurn({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      outcome: "completed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 1,
    });

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        toolCallId: "new",
        expectedSeq: 2,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }

    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    const r2 = tools.appendToolFact(baseToolArgs(fx, {
      factId,
      summaryText: "first",
      phase: "completed",
      toolStatus: "completed",
      expectedSeq: 0,
    }));
    assert.equal(r2.created, false);
    assert.deepEqual(r2.cursor, r1.cursor);
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("changed summary same fact ERR_IDEMPOTENCY_CONFLICT; wrong opID; wrong provenance; denied proof", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    tools.appendToolFact(baseToolArgs(fx, {
      factId,
      phase: "completed",
      toolStatus: "completed",
      summaryText: "original",
    }));

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId,
        phase: "completed",
        toolStatus: "completed",
        summaryText: "changed",
        expectedSeq: 0,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_IDEMPOTENCY_CONFLICT");
    }

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        operationId: randomUUID(),
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_IDEMPOTENCY_CONFLICT");
    }

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        hostGeneration: randomUUID(),
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_FENCE_CONFLICT");
    }

    const denied = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => false, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);
    try {
      denied.appendToolFact(baseToolArgs(fx, { factId: randomUUID(), expectedSeq: 1 }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_OWNER_UNVERIFIED");
    }
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });
});

// ─── 4. Snapshot watermark preservation ─────────────────────────────────────

describe("S3d snapshot watermark preservation", () => {
  it("preserves lastMessageTurn and lastTurnOutcome; late older turn keeps newer lastToolTurn; bodyRefs unchanged", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });

    const seedUUID = randomUUID();
    bodies.putBody({ ...fx.scope, bodyId: seedUUID, text: "seed" });
    events.appendEvent({
      ...fx.scope,
      eventKey: "seed-marker",
      kind: "status",
      expectedSeq: 0,
      payload: { x: 1 },
      projection: {
        state: JSON.parse('{"customField":"keep","__proto__":{"safe":true}}'),
        bodyRefs: [seedUUID],
      },
    });

    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: randomUUID(), nativeMessageId: "item-a", text: "a", expectedSeq: 1,
    });

    tools.appendToolFact(baseToolArgs(fx, {
      factId: randomUUID(),
      expectedSeq: 2,
    }));

    const T2 = randomUUID();
    const O2 = randomUUID();
    fx.turns.queueTurn({ ...fx.scope, turnId: T2, operationId: O2, prompt: "second" });
    fx.turns.beginDispatch({ ...fx.scope, turnId: T2, operationId: O2 });
    fx.turns.recordObserved({
      ...fx.scope, turnId: T2, operationId: O2,
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn-2", claudeInputUuid: null },
    });
    tools.appendToolFact(baseToolArgs(fx, {
      turnId: T2,
      operationId: O2,
      factId: randomUUID(),
      toolCallId: "call-t2",
      expectedSeq: 3,
    }));

    tools.appendToolFact(baseToolArgs(fx, {
      factId: randomUUID(),
      toolCallId: "call-late",
      expectedSeq: 4,
    }));

    const outcomes = createSessionTurnOutcomes({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    outcomes.settleTurn({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      outcome: "completed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 5,
    });

    tools.appendToolFact(baseToolArgs(fx, {
      turnId: T2,
      operationId: O2,
      factId: randomUUID(),
      toolCallId: "call-after-outcome",
      expectedSeq: 6,
    }));

    const snap = snapshotRow(fx.store, fx.C);
    const state = JSON.parse(snap.projection_json).state;
    assert.equal(state.lastToolTurn.turnId, T2);
    assert.equal(state.lastToolTurn.turnSeq, 2);
    assert.equal(state.lastMessageTurn.turnId, fx.T);
    assert.equal(state.lastTurnOutcome.turnId, fx.T);
    assert.equal(state.customField, "keep");
    assert.ok(Object.hasOwn(state, "__proto__"));
    assert.equal(state.__proto__.safe, true);
    assert.deepEqual(JSON.parse(snap.projection_json).bodyRefs, [seedUUID]);

    const markerKeys = Object.keys(state.lastToolTurn).sort();
    assert.deepEqual(markerKeys, [
      "controller", "conversationId", "hostGeneration",
      "operationId", "ownerGeneration", "turnId", "turnSeq", "v",
    ]);
  });

  it("bodyRefs MUST NOT grow for tool summary bodies (>64 facts)", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    for (let i = 0; i < 65; i++) {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        toolCallId: `call-${i}`,
        phase: "completed",
        toolStatus: "completed",
        summaryText: `t${i}`,
        expectedSeq: i,
      }));
    }
    const snap = snapshotRow(fx.store, fx.C);
    assert.equal(JSON.parse(snap.projection_json).bodyRefs.length, 0);
  });
});

// ─── 5. Competing sequence / dangling body ──────────────────────────────────

describe("S3d CAS and dangling-body rejection", () => {
  it("stale expectedSeq after body insertion rolls back new body/event/snapshot", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    tools.appendToolFact(baseToolArgs(fx, {
      factId: randomUUID(),
      phase: "completed",
      toolStatus: "completed",
      summaryText: "one",
      expectedSeq: 0,
    }));

    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        toolCallId: "call-2",
        phase: "completed",
        toolStatus: "completed",
        summaryText: "two",
        expectedSeq: 0,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_EVENT_VERSION_CONFLICT");
    }

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("existing body-backed event without body -> ERR_STORAGE on retry; no repair", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    tools.appendToolFact(baseToolArgs(fx, {
      factId,
      phase: "completed",
      toolStatus: "completed",
      summaryText: "del",
      expectedSeq: 0,
    }));
    fx.store.transaction((tx) => {
      tx.run("DELETE FROM large_bodies WHERE id = ?", [factId]);
    });

    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const eventsBefore = rawRows(fx.store, "events");
    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId,
        phase: "completed",
        toolStatus: "completed",
        summaryText: "del",
        expectedSeq: 0,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });
    assert.equal(bodies.getBody({ projectId: fx.P, conversationId: fx.C, bodyId: factId }), null);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
  });

  it("seeded event without body for body-backed factId -> ERR_STORAGE", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    events.appendEvent({
      ...fx.scope,
      eventKey: `tool_fact:${factId}`,
      kind: "tool_fact",
      payload: { x: 1 },
      expectedSeq: 0,
      projection: { state: {}, bodyRefs: [] },
    });
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId,
        phase: "completed",
        toolStatus: "completed",
        summaryText: "orphan",
        expectedSeq: 1,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });
});

// ─── 6. Trigger ABORT/IGNORE rollback ───────────────────────────────────────

describe("S3d trigger fault rollback", () => {
  it("BEFORE INSERT large_bodies ABORT -> ERR_STORAGE + full rows no-touch", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    fx.store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER abort_body BEFORE INSERT ON large_bodies BEGIN SELECT RAISE(ABORT, 'test-abort'); END");
    });

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        phase: "completed",
        toolStatus: "completed",
        summaryText: "abort",
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    fx.store.transaction((tx) => { tx.run("DROP TRIGGER IF EXISTS abort_body"); });
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("BEFORE INSERT events IGNORE -> no fabricated body, full rollback", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    fx.store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER ignore_event BEFORE INSERT ON events BEGIN SELECT RAISE(IGNORE); END");
    });

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        phase: "completed",
        toolStatus: "completed",
        summaryText: "ignore",
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    fx.store.transaction((tx) => { tx.run("DROP TRIGGER IF EXISTS ignore_event"); });
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("BEFORE UPDATE snapshots ABORT -> ERR_STORAGE + full rows no-touch", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    events.appendEvent({
      ...fx.scope, eventKey: "preseed", kind: "status",
      expectedSeq: 0, payload: { x: 1 }, projection: { state: {}, bodyRefs: [] },
    });

    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    fx.store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER abort_snap BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'test-snap-abort'); END");
    });

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        phase: "completed",
        toolStatus: "completed",
        summaryText: "snap",
        expectedSeq: 1,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    fx.store.transaction((tx) => { tx.run("DROP TRIGGER IF EXISTS abort_snap"); });
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });
});

// ─── 7. Multi-proof denial + outer composition ──────────────────────────────

describe("S3d proof denial and outer transaction composition", () => {
  it("verifier true first/second false third -> ERR_OWNER_UNVERIFIED + rollback", () => {
    const fx = makeCodexFixture();
    let callCount = 0;
    const tools = createSessionToolFacts({
      store: fx.store,
      verifyOwnerEvidence: () => {
        callCount += 1;
        return callCount < 3;
      },
      now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      tools.appendToolFact(baseToolArgs(fx, {
        factId: randomUUID(),
        phase: "completed",
        toolStatus: "completed",
        summaryText: "three",
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_OWNER_UNVERIFIED");
    }
    assert.equal(callCount, 3);
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("recordObserved + tool append + throw rolls back observed journal AND body/event/snapshot", () => {
    const fixture = makeStore();
    const { store } = fixture;
    const P = randomUUID();
    const C = randomUUID();
    const records = createSessionRecords({ store });
    records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/tools" });
    records.createConversation({ id: C, projectId: P, controller: "codex" });
    const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
    const ownerToken = randomUUID();
    const claim = bindings.claimProducer({
      projectId: P, conversationId: C, ownerToken, expectedGeneration: 0, evidence: null,
    });
    const hostGeneration = randomUUID();
    const scope = {
      projectId: P, conversationId: C, ownerToken: claim.ownerToken,
      ownerGeneration: 1, hostGeneration, evidence: null,
    };
    bindings.bindNativeRef({ ...scope, generation: 1, controller: "codex", nativeThreadId: "thread" });

    const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
    const T = randomUUID();
    const O = randomUUID();
    turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic" });
    turns.beginDispatch({ ...scope, turnId: T, operationId: O });

    const tools = createSessionToolFacts({ store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const opsBefore = rawRows(store, "operations");
    const eventsBefore = rawRows(store, "events");
    const bodiesBefore = rawRows(store, "large_bodies");

    try {
      store.transaction((tx) => {
        const turnsTx = turns.inTransaction(tx);
        turnsTx.recordObserved({
          ...scope, turnId: T, operationId: O,
          nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
        });
        const helper = tools.inTransaction(tx);
        helper.appendToolFact({
          ...scope, turnId: T, operationId: O, factId: randomUUID(),
          toolCallId: "outer", phase: "completed", toolTitle: "command",
          toolStatus: "completed", summaryText: "outer", expectedSeq: 0,
        });
        throw new Error("rollback-marker");
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.message, "rollback-marker");
    }

    assert.deepEqual(rawRows(store, "operations"), opsBefore);
    assert.deepEqual(rawRows(store, "events"), eventsBefore);
    assert.deepEqual(rawRows(store, "large_bodies"), bodiesBefore);
  });
});

// ─── 8. Malformed watermark / corrupt observed / overflow / validation ──────

describe("S3d malformed watermark and input validation", () => {
  it("wrong conversationId in lastToolTurn -> ERR_STORAGE + rollback", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const badMarker = {
      v: 1,
      conversationId: randomUUID(),
      turnId: fx.T,
      operationId: fx.O,
      turnSeq: 1,
      controller: "codex",
      ownerGeneration: 1,
      hostGeneration: fx.scope.hostGeneration,
    };
    events.appendEvent({
      ...fx.scope, eventKey: "seed-bad", kind: "status",
      expectedSeq: 0, payload: { x: 1 },
      projection: { state: { lastToolTurn: badMarker }, bodyRefs: [] },
    });

    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      tools.appendToolFact(baseToolArgs(fx, { factId: randomUUID(), expectedSeq: 1 }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("dangling turn in lastToolTurn -> ERR_STORAGE", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    events.appendEvent({
      ...fx.scope, eventKey: "seed-dangle", kind: "status",
      expectedSeq: 0, payload: { x: 1 },
      projection: {
        state: {
          lastToolTurn: {
            v: 1,
            conversationId: fx.C,
            turnId: randomUUID(),
            operationId: randomUUID(),
            turnSeq: 1,
            controller: "codex",
            ownerGeneration: 1,
            hostGeneration: fx.scope.hostGeneration,
          },
        },
        bodyRefs: [],
      },
    });
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      tools.appendToolFact(baseToolArgs(fx, { factId: randomUUID(), expectedSeq: 1 }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });

  it("corrupted nativeTurnId mismatch -> ERR_STORAGE", () => {
    const fx = makeCodexFixture();
    fx.store.transaction((tx) => {
      const row = tx.get(
        "SELECT history_json FROM operations WHERE conversation_id = ? AND turn_id = ?",
        [fx.C, fx.T]
      );
      const history = JSON.parse(row.history_json);
      const obs = history.find((e) => e.kind === "observed");
      obs.nativeTurnId = "WRONG-MISMATCH";
      tx.run(
        "UPDATE operations SET history_json = ? WHERE conversation_id = ? AND turn_id = ?",
        [JSON.stringify(history), fx.C, fx.T]
      );
    });
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      tools.appendToolFact(baseToolArgs(fx, { factId: randomUUID() }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });

  it("state near 32KiB + marker exceeds cap -> ERR_INVALID_RECORD + rollback", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const baseBytes = Buffer.byteLength(
      JSON.stringify({
        version: 1, conversationId: fx.C, lastSeq: 1, bodyRefs: [], state: { bigField: "" },
      }),
      "utf8"
    );
    const bigStr = "A".repeat(32768 - baseBytes - 32);
    events.appendEvent({
      ...fx.scope, eventKey: "seed-big", kind: "status",
      expectedSeq: 0, payload: { x: 1 },
      projection: { state: { bigField: bigStr }, bodyRefs: [] },
    });
    assert.ok(Buffer.byteLength(snapshotRow(fx.store, fx.C).projection_json, "utf8") <= 32768);

    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      tools.appendToolFact(baseToolArgs(fx, { factId: randomUUID(), expectedSeq: 1 }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_INVALID_RECORD");
    }
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("invalid expectedSeq/factId/tool labels/NUL/surrogate/oversize -> ERR_INVALID_RECORD", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const cases = [
      ["negative expectedSeq", baseToolArgs(fx, { expectedSeq: -1 })],
      ["fraction expectedSeq", baseToolArgs(fx, { expectedSeq: 1.5 })],
      ["malformed factId", baseToolArgs(fx, { factId: "not-uuid" })],
      ["empty toolCallId", baseToolArgs(fx, { toolCallId: "" })],
      ["NUL in toolTitle", baseToolArgs(fx, { toolTitle: "a\0b" })],
      ["lone surrogate in toolCallId", baseToolArgs(fx, { toolCallId: "\uD800" })],
      ["oversize summary", baseToolArgs(fx, {
        phase: "completed", toolStatus: "completed",
        summaryText: "x".repeat(1048577),
      })],
      ["NUL in summary", baseToolArgs(fx, {
        phase: "completed", toolStatus: "completed", summaryText: "a\0b",
      })],
    ];
    for (const [label, args] of cases) {
      try {
        tools.appendToolFact(args);
        assert.fail(`should have thrown for ${label}`);
      } catch (e) {
        assert.equal(e.code, "ERR_INVALID_RECORD", `failed for ${label}`);
      }
    }
  });

  it("factory validation: missing store/verifier/clock -> ERR_INVALID_RECORD", () => {
    try { createSessionToolFacts(null); assert.fail(); } catch (e) {
      assert.equal(e.code, "ERR_INVALID_RECORD");
    }
    try { createSessionToolFacts({}); assert.fail(); } catch (e) {
      assert.equal(e.code, "ERR_INVALID_RECORD");
    }
    try {
      createSessionToolFacts({ store: {}, verifyOwnerEvidence: () => true });
      assert.fail();
    } catch (e) {
      assert.equal(e.code, "ERR_INVALID_RECORD");
    }
  });
});

// ─── 9. Reopen / lineage / regressions ──────────────────────────────────────

describe("S3d reopen, lineage, regressions", () => {
  it("reopen same path -> stable event/body/snapshot; foreign helper fails", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const factId = randomUUID();
    const r1 = tools.appendToolFact(baseToolArgs(fx, {
      factId,
      phase: "completed",
      toolStatus: "completed",
      summaryText: "reopen",
    }));

    fx.store.close();
    const idx = ownedStores.indexOf(fx.store);
    if (idx >= 0) ownedStores.splice(idx, 1);

    const store2 = openSessionStore({ databasePath: fx.path });
    ownedStores.push(store2);
    const tools2 = createSessionToolFacts({
      store: store2, verifyOwnerEvidence: () => true, now: () => 3000,
    });
    const r2 = tools2.appendToolFact(baseToolArgs(fx, {
      factId,
      phase: "completed",
      toolStatus: "completed",
      summaryText: "reopen",
      expectedSeq: 0,
    }));
    assert.equal(r2.created, false);
    assert.deepEqual(r2.cursor, r1.cursor);

    const fixture2 = makeStore();
    let expired;
    store2.transaction((tx) => { expired = tx; });
    assert.throws(() => tools2.inTransaction(expired), { code: "ERR_INVALID_TX" });
    fixture2.store.transaction((tx) => {
      assert.throws(() => tools2.inTransaction(tx), { code: "ERR_STORAGE" });
    });
  });

  it("valid terminal WITHOUT observation: fresh tool fact ERR_TURN_STATE", () => {
    const fx = makeCodexFixture();
    const newT = randomUUID();
    const newO = randomUUID();
    fx.turns.queueTurn({ ...fx.scope, turnId: newT, operationId: newO, prompt: "unobserved" });
    const outcomes = createSessionTurnOutcomes({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    outcomes.settleTurn({
      ...fx.scope, turnId: newT, operationId: newO,
      outcome: "failed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 0,
    });
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      tools.appendToolFact(baseToolArgs(fx, {
        turnId: newT, operationId: newO, factId: randomUUID(), expectedSeq: 1,
      }));
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }
  });

  it("second same-turn tool fact succeeds; both events present; title-only then body-backed", () => {
    const fx = makeCodexFixture();
    const tools = createSessionToolFacts({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const f1 = randomUUID();
    const f2 = randomUUID();
    const r1 = tools.appendToolFact(baseToolArgs(fx, { factId: f1 }));
    const r2 = tools.appendToolFact(baseToolArgs(fx, {
      factId: f2,
      toolCallId: "call-2",
      phase: "completed",
      toolStatus: "completed",
      summaryText: "done",
      expectedSeq: 1,
    }));
    assert.equal(r1.created, true);
    assert.equal(r2.created, true);
    const keys = rawRows(fx.store, "events").map((e) => e.event_key).sort();
    assert.deepEqual(keys, [`tool_fact:${f1}`, `tool_fact:${f2}`].sort());
  });
});
