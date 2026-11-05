// CHO-03 S3c normalized message-delta/body composition — Vitest tests.
// Real temp SQLite; no mocks of the module under test.

import { describe, it, afterEach, expect } from "vitest";
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

// ─── Helpers ────────────────────────────────────────────────────────────────

const ownedStores = [];
const ownedDirs = [];

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "s3c-test-"));
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
  records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/messages" });
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
  records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/messages" });
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

// ─── 1. Codex typed payload / body / key / immutability / frozen / no I/O ──

describe("S3c Codex typed payload and body", () => {
  it("produces exact 12-field payload, 3-field bodyRef, key message_delta:partId, no text/prompt/evidence in event or snapshot", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    const partId = randomUUID();
    const result = deltas.appendMessageDelta({
      ...fx.scope,
      turnId: fx.T,
      operationId: fx.O,
      partId,
      nativeMessageId: "item-42",
      text: "hello world",
      expectedSeq: 0,
    });

    assert.equal(result.created, true);
    assert.equal(result.event.eventKey, `message_delta:${partId}`);
    assert.equal(result.event.kind, "message_delta");

    const payload = result.event.payload;
    const payloadKeys = Object.keys(payload).sort();
    assert.deepEqual(payloadKeys, [
      "bodyRef", "controller", "conversationId", "hostGeneration",
      "nativeFact", "nativeMessageId", "operationId", "ownerGeneration",
      "partId", "turnId", "turnSeq", "v",
    ]);
    assert.equal(payload.v, 1);
    assert.equal(payload.conversationId, fx.C);
    assert.equal(payload.turnId, fx.T);
    assert.equal(payload.operationId, fx.O);
    assert.equal(payload.controller, "codex");
    assert.equal(payload.partId, partId);
    assert.equal(payload.nativeMessageId, "item-42");
    assert.deepEqual(payload.nativeFact, {
      nativeIdentity: "thread",
      nativeTurnId: "native-turn",
      claudeInputUuid: null,
    });
    assert.deepEqual(Object.keys(payload.bodyRef).sort(), ["byteLength", "id", "sha256Hex"]);
    assert.equal(payload.bodyRef.id, partId);

    // No text/prompt/evidence/ownerToken in event or snapshot
    const rawEvent = JSON.stringify(result.event);
    assert.ok(!rawEvent.includes("hello world"));
    assert.ok(!rawEvent.includes("synthetic"));
    assert.ok(!rawEvent.includes(fx.scope.ownerToken));

    const snap = snapshotRow(fx.store, fx.C);
    assert.ok(snap);
    const snapState = JSON.parse(snap.projection_json).state;
    const snapStr = JSON.stringify(snapState);
    assert.ok(!snapStr.includes("hello world"));
    assert.ok(!snapStr.includes("synthetic"));
    assert.ok(!snapStr.includes(fx.scope.ownerToken));

    // Body metadata 5 fields
    assert.equal(result.body.id, partId);
    assert.equal(result.body.conversationId, fx.C);
    assert.ok(Number.isSafeInteger(result.body.byteLength));
    assert.ok(typeof result.body.sha256Hex === "string");
    assert.ok(Number.isSafeInteger(result.body.createdAtMs));
  });

  it("exact Unicode/newlines body roundtrip via readBodyChunk", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });
    const partId = randomUUID();
    const text = "line1\nline2\ttab\r\nemoji: 🎉🚀\u00e9\u00e8\u00ea";
    deltas.appendMessageDelta({
      ...fx.scope,
      turnId: fx.T,
      operationId: fx.O,
      partId,
      nativeMessageId: "item-uni",
      text,
      expectedSeq: 0,
    });
    const chunk = bodies.readBodyChunk({
      projectId: fx.P,
      conversationId: fx.C,
      bodyId: partId,
      offsetBytes: 0,
      lengthBytes: 16384,
    });
    const decoded = Buffer.from(chunk.dataBase64, "base64").toString("utf8");
    assert.equal(decoded, text);
  });

  it("frozen API object and frozen inTransaction helper inside active tx", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    assert.ok(Object.isFrozen(deltas));
    assert.ok(typeof deltas.appendMessageDelta === "function");
    assert.ok(typeof deltas.inTransaction === "function");

    // Frozen helper check INSIDE active transaction
    fx.store.transaction((tx) => {
      const helper = deltas.inTransaction(tx);
      assert.ok(Object.isFrozen(helper));
      assert.ok(typeof helper.appendMessageDelta === "function");
    });
  });

  it("no I/O on construction (import opens no files)", () => {
    // Construction with valid args must not throw and must not touch filesystem
    const storeLike = { instanceId: randomUUID(), transaction() { throw new Error("unexpected constructor I/O"); } };
    const deltas = createSessionMessageDeltas({
      store: storeLike,
      verifyOwnerEvidence: () => true,
      now: () => 1000,
    });
    assert.ok(Object.isFrozen(deltas));
  });
});

// ─── 2. Claude observed facts, empty/large delta, no content dedup ─────────

describe("S3c Claude facts and delta properties", () => {
  it("Claude observed session/input/message fact, empty delta accepted", () => {
    const fx = makeClaudeFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    const partId = randomUUID();
    const result = deltas.appendMessageDelta({
      ...fx.scope,
      turnId: fx.T,
      operationId: fx.O,
      partId,
      nativeMessageId: "msg-claude-1",
      text: "",
      expectedSeq: 0,
    });
    assert.equal(result.created, true);
    const payload = result.event.payload;
    assert.deepEqual(payload.nativeFact, {
      nativeIdentity: fx.sessionUuid,
      nativeTurnId: null,
      claudeInputUuid: fx.inputUUID,
    });
    assert.equal(result.body.byteLength, 0);
  });

  it("large 64KiB+ body supported, bodyRef/poll metadata small", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    const partId = randomUUID();
    const largeText = "x".repeat(65536);
    const result = deltas.appendMessageDelta({
      ...fx.scope,
      turnId: fx.T,
      operationId: fx.O,
      partId,
      nativeMessageId: "item-large",
      text: largeText,
      expectedSeq: 0,
    });
    assert.equal(result.created, true);
    assert.equal(result.body.byteLength, 65536);
    const payload = result.event.payload;
    assert.equal(payload.bodyRef.byteLength, 65536);
    // Event payload JSON is small (no text embedded)
    assert.ok(Buffer.byteLength(JSON.stringify(result.event.payload), 'utf8') < 1024);
  });

  it("same text DIFFERENT part IDs create separate facts, no content dedup", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => true,
      now: () => 2000,
    });
    const partA = randomUUID();
    const partB = randomUUID();
    const text = "identical text";
    const rA = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: partA, nativeMessageId: "item-a", text, expectedSeq: 0,
    });
    const rB = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: partB, nativeMessageId: "item-b", text, expectedSeq: 1,
    });
    assert.equal(rA.created, true);
    assert.equal(rB.created, true);
    assert.notEqual(rA.event.seq, rB.event.seq);
    assert.notEqual(rA.event.eventKey, rB.event.eventKey);
  });
});

// ─── 3. Turn state / idempotency / fence / denied proof ────────────────────

describe("S3c turn state and idempotency guards", () => {
  it("queued unobserved turn denied ERR_TURN_STATE", () => {
    const fixture = makeStore();
    const { store } = fixture;
    const P = randomUUID();
    const C = randomUUID();
    const records = createSessionRecords({ store });
    records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/messages" });
    records.createConversation({ id: C, projectId: P, controller: "codex" });
    const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
    const ownerToken = randomUUID();
    const claim = bindings.claimProducer({ projectId: P, conversationId: C, ownerToken, expectedGeneration: 0, evidence: null });
    const hostGeneration = randomUUID();
    const scope = { projectId: P, conversationId: C, ownerToken: claim.ownerToken, ownerGeneration: 1, hostGeneration, evidence: null };
    bindings.bindNativeRef({ ...scope, generation: 1, controller: "codex", nativeThreadId: "thread" });

    const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
    const T = randomUUID();
    const O = randomUUID();
    turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic" });

    const deltas = createSessionMessageDeltas({ store, verifyOwnerEvidence: () => true, now: () => 2000 });
    try {
      deltas.appendMessageDelta({
        ...scope, turnId: T, operationId: O,
        partId: randomUUID(), nativeMessageId: "x", text: "hi", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }
  });

  it("fresh part after terminal denied ERR_TURN_STATE; historical SAME part after terminal+stale expectedSeq returns original cursor/no changes", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const partId = randomUUID();
    const r1 = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-t", text: "first", expectedSeq: 0,
    });
    assert.equal(r1.created, true);

    // Settle turn to terminal
    const outcomes = createSessionTurnOutcomes({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 3000 });
    outcomes.settleTurn({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      outcome: "completed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 1,
    });

    // Fresh part after terminal -> ERR_TURN_STATE
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-new", text: "new", expectedSeq: 2,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }

    // Historical SAME part retry with stale expectedSeq -> original cursor, no changes
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    const r2 = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-t", text: "first", expectedSeq: 0,
    });
    assert.equal(r2.created, false);
    assert.deepEqual(r2.cursor, r1.cursor);

    const eventsAfter = rawRows(fx.store, "events");
    const bodiesAfter = rawRows(fx.store, "large_bodies");
    const snapAfter = snapshotRow(fx.store, fx.C);
    assert.deepEqual(eventsAfter, eventsBefore);
    assert.deepEqual(bodiesAfter, bodiesBefore);
    assert.deepEqual(snapAfter, snapBefore);
  });

  it("changed text same part ERR_IDEMPOTENCY_CONFLICT; wrong opID ERR_IDEMPOTENCY_CONFLICT; wrong provenance ERR_FENCE_CONFLICT", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const partId = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-x", text: "original", expectedSeq: 0,
    });

    // Changed text same part
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId, nativeMessageId: "item-x", text: "changed", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_IDEMPOTENCY_CONFLICT");
    }

    // Wrong operationId
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: randomUUID(),
        partId: randomUUID(), nativeMessageId: "item-y", text: "z", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_IDEMPOTENCY_CONFLICT");
    }

    // Wrong hostGeneration (fence)
    try {
      deltas.appendMessageDelta({
        ...fx.scope, hostGeneration: randomUUID(),
        turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-z", text: "w", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_FENCE_CONFLICT");
    }
  });

  it("denied proof (verifier false) no-touch: all raw rows unchanged", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => false, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-denied", text: "nope", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_OWNER_UNVERIFIED");
    }

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });
});

// ─── 4. Late older turn preserves newer marker; preserve state/bodyRefs/outcome ──

describe("S3c snapshot watermark preservation", () => {
  it("late older turn preserves newer lastMessageTurn; preserves other state and bodyRefs", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });

    // Seed a real same-chat body so bodyRefs reference an existing UUID.
    const seedUUID = randomUUID();
    bodies.putBody({ ...fx.scope, bodyId: seedUUID, text: "seed" });

    // Seed a snapshot with custom state and bodyRefs via a generic event.
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

    // First delta on current turn (seq 1)
    const partA = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: partA, nativeMessageId: "item-a", text: "a", expectedSeq: 1,
    });

    // Create a second turn with higher seq
    const T2 = randomUUID();
    const O2 = randomUUID();
    fx.turns.queueTurn({ ...fx.scope, turnId: T2, operationId: O2, prompt: "second" });
    fx.turns.beginDispatch({ ...fx.scope, turnId: T2, operationId: O2 });
    fx.turns.recordObserved({
      ...fx.scope, turnId: T2, operationId: O2,
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn-2", claudeInputUuid: null },
    });
    const partB = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: T2, operationId: O2,
      partId: partB, nativeMessageId: "item-b", text: "b", expectedSeq: 2,
    });

    // Now try a late delta on the FIRST turn (lower seq) — should preserve newer marker
    const partC = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: partC, nativeMessageId: "item-c", text: "c", expectedSeq: 3,
    });

    // Settle the FIRST turn via the outcome writer (tip seq 4): verifies the
    // outcome writer preserves the newer message marker.
    const outcomes = createSessionTurnOutcomes({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    outcomes.settleTurn({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      outcome: "completed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 4,
    });

    // Immediate check: outcome writer must have preserved the newer T2 marker.
    const midSnap = JSON.parse(snapshotRow(fx.store, fx.C).projection_json).state.lastMessageTurn;
    assert.equal(midSnap.turnId, T2);
    assert.equal(midSnap.turnSeq, 2);

    // Another delta on the still-observed second turn (seq 5): verifies the
    // message writer preserves the outcome written by the outcome writer.
    const partD = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: T2, operationId: O2,
      partId: partD, nativeMessageId: "item-d", text: "d", expectedSeq: 5,
    });

    const snap = snapshotRow(fx.store, fx.C);
    const state = JSON.parse(snap.projection_json).state;
    // Marker should still point to T2 (higher seq)
    assert.equal(state.lastMessageTurn.turnId, T2);
    assert.equal(state.customField, "keep");
    // Outcome writer's marker preserved by the later message writer
    assert.equal(state.lastTurnOutcome.turnId, fx.T);
    // __proto__ own property preserved through projection roundtrip
    assert.ok(Object.hasOwn(state, "__proto__"));
    assert.equal(state.__proto__.safe, true);
    // bodyRefs preserved exactly as the seeded UUID
    const bodyRefs = JSON.parse(snap.projection_json).bodyRefs;
    assert.deepEqual(bodyRefs, [seedUUID]);
  });

  it("bodyRefs MUST NOT grow per delta (>64 parts)", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    for (let i = 0; i < 65; i++) {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: `item-${i}`, text: `t${i}`, expectedSeq: i,
      });
    }
    const snap = snapshotRow(fx.store, fx.C);
    const bodyRefs = JSON.parse(snap.projection_json).bodyRefs;
    assert.equal(bodyRefs.length, 0);
  });

  it("marker EXACT 8 fields, no part/body pointer", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: randomUUID(), nativeMessageId: "item-m", text: "m", expectedSeq: 0,
    });
    const snap = snapshotRow(fx.store, fx.C);
    const marker = JSON.parse(snap.projection_json).state.lastMessageTurn;
    const keys = Object.keys(marker).sort();
    assert.deepEqual(keys, [
      "controller", "conversationId", "hostGeneration",
      "operationId", "ownerGeneration", "turnId", "turnSeq", "v",
    ]);
    assert.ok(!("partId" in marker));
    assert.ok(!("bodyRef" in marker));
    assert.ok(!("nativeMessageId" in marker));
  });
});

// ─── 5. Stale expectedSeq rollback; key collision; wrong kind/payload ──────

describe("S3c CAS and key collision rollback", () => {
  it("stale expectedSeq after body insertion rolls back new body/event/snapshot", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    // First delta succeeds at seq 0
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: randomUUID(), nativeMessageId: "item-1", text: "one", expectedSeq: 0,
    });

    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    // Stale expectedSeq (0 instead of 1)
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-2", text: "two", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_EVENT_VERSION_CONFLICT");
    }

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("existing event without body -> ERR_STORAGE on retry", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const partId = randomUUID();
    // Seed an event via public API without a body
    events.appendEvent({
      ...fx.scope,
      eventKey: `message_delta:${partId}`,
      kind: "message_delta",
      payload: { x: 1 },
      expectedSeq: 0,
      projection: { state: {}, bodyRefs: [] },
    });

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId, nativeMessageId: "item-orphan", text: "orphan", expectedSeq: 1,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });
});

// ─── 6. Trigger ABORT/IGNORE rollback tests ────────────────────────────────

describe("S3c trigger fault rollback", () => {
  it("BEFORE INSERT large_bodies ABORT -> ERR_STORAGE + full rows no-touch", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    fx.store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER abort_body BEFORE INSERT ON large_bodies BEGIN SELECT RAISE(ABORT, 'test-abort'); END");
    });

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-abort", text: "abort", expectedSeq: 0,
      });
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
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    fx.store.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER ignore_event BEFORE INSERT ON events BEGIN SELECT RAISE(IGNORE); END");
    });

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-ign", text: "ignore", expectedSeq: 0,
      });
      // IGNORE may cause metadata mismatch -> ERR_STORAGE
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
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    // Preseed snapshot BEFORE defining trigger
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
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
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-snap", text: "snap", expectedSeq: 1,
      });
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

// ─── 7. Third proof denial rollback ────────────────────────────────────────

describe("S3c multi-proof denial rollback", () => {
  it("verifier true first, true second, false third -> ERR_OWNER_UNVERIFIED + all raw rollback", () => {
    const fx = makeCodexFixture();
    let callCount = 0;
    const deltas = createSessionMessageDeltas({
      store: fx.store,
      verifyOwnerEvidence: () => {
        callCount++;
        return callCount < 3;
      },
      now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-3p", text: "three", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_OWNER_UNVERIFIED");
    }
    assert.equal(callCount, 3);

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });
});

// ─── 8. Outer transaction composition ──────────────────────────────────────

describe("S3c outer transaction composition", () => {
  it("recordObserved + message append + throw rolls back observed journal AND body/event/snapshot", () => {
    const fixture = makeStore();
    const { store } = fixture;
    const P = randomUUID();
    const C = randomUUID();
    const records = createSessionRecords({ store });
    records.createProject({ id: P, name: "Synthetic", pathCanonical: "C:/synthetic/messages" });
    records.createConversation({ id: C, projectId: P, controller: "codex" });
    const bindings = createSessionBindings({ store, verifyOwnerEvidence: () => true });
    const ownerToken = randomUUID();
    const claim = bindings.claimProducer({ projectId: P, conversationId: C, ownerToken, expectedGeneration: 0, evidence: null });
    const hostGeneration = randomUUID();
    const scope = { projectId: P, conversationId: C, ownerToken: claim.ownerToken, ownerGeneration: 1, hostGeneration, evidence: null };
    bindings.bindNativeRef({ ...scope, generation: 1, controller: "codex", nativeThreadId: "thread" });

    const turns = createSessionTurns({ store, verifyOwnerEvidence: () => true, now: () => 1000 });
    const T = randomUUID();
    const O = randomUUID();
    turns.queueTurn({ ...scope, turnId: T, operationId: O, prompt: "synthetic" });
    turns.beginDispatch({ ...scope, turnId: T, operationId: O });

    const deltas = createSessionMessageDeltas({ store, verifyOwnerEvidence: () => true, now: () => 2000 });

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
        const helper = deltas.inTransaction(tx);
        helper.appendMessageDelta({
          ...scope, turnId: T, operationId: O,
          partId: randomUUID(), nativeMessageId: "item-outer", text: "outer", expectedSeq: 0,
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

// ─── 9. Existing event body deleted -> ERR_STORAGE, no silent repair ───────

describe("S3c body deletion on existing event", () => {
  it("exact retry after body DELETE -> ERR_STORAGE, body stays null, no repair", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const partId = randomUUID();
    deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-del", text: "del", expectedSeq: 0,
    });

    // Delete body via bound raw SQL
    fx.store.transaction((tx) => {
      tx.run("DELETE FROM large_bodies WHERE id = ?", [partId]);
    });

    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const eventsBefore = rawRows(fx.store, "events");

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId, nativeMessageId: "item-del", text: "del", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    // Body stays null
    const bodies = createSessionBodies({ store: fx.store, verifyOwnerEvidence: () => true });
    assert.equal(bodies.getBody({ projectId: fx.P, conversationId: fx.C, bodyId: partId }), null);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
  });
});

// ─── 10. Malformed lastMessageTurn namespace -> ERR_STORAGE + rollback ─────

describe("S3c malformed watermark namespace", () => {
  it("wrong conversationId in watermark -> ERR_STORAGE + full rows rollback", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const badMarker = {
      v: 1,
      conversationId: randomUUID(), // wrong
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
      projection: { state: { lastMessageTurn: badMarker }, bodyRefs: [] },
    });

    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-bad", text: "bad", expectedSeq: 1,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });

  it("dangling turn in watermark -> ERR_STORAGE", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    const badMarker = {
      v: 1,
      conversationId: fx.C,
      turnId: randomUUID(), // dangling
      operationId: randomUUID(),
      turnSeq: 1,
      controller: "codex",
      ownerGeneration: 1,
      hostGeneration: fx.scope.hostGeneration,
    };
    events.appendEvent({
      ...fx.scope, eventKey: "seed-dangle", kind: "status",
      expectedSeq: 0, payload: { x: 1 },
      projection: { state: { lastMessageTurn: badMarker }, bodyRefs: [] },
    });

    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-d", text: "d", expectedSeq: 1,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });
});

// ─── 11. Corrupt observed triple -> ERR_STORAGE ────────────────────────────

describe("S3c corrupt observed fact", () => {
  it("corrupted nativeTurnId mismatch in stored history -> ERR_STORAGE", () => {
    const fx = makeCodexFixture();
    // Corrupt the operations history_json to mismatch nativeTurnId
    fx.store.transaction((tx) => {
      const row = tx.get("SELECT history_json FROM operations WHERE conversation_id = ? AND turn_id = ?", [fx.C, fx.T]);
      const history = JSON.parse(row.history_json);
      const obs = history.find((e) => e.kind === "observed");
      obs.nativeTurnId = "WRONG-MISMATCH";
      tx.run("UPDATE operations SET history_json = ? WHERE conversation_id = ? AND turn_id = ?", [
        JSON.stringify(history), fx.C, fx.T,
      ]);
    });

    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-c", text: "c", expectedSeq: 0,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_STORAGE");
    }
  });
});

// ─── 12. Oversize snapshot -> ERR_INVALID_RECORD + full rollback ───────────

describe("S3c snapshot cap overflow", () => {
  it("state near 32KiB + marker exceeds cap -> ERR_INVALID_RECORD + full rollback", () => {
    const fx = makeCodexFixture();
    const events = createSessionEvents({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });

    // Preseed snapshot with large state string sized to fit within 32768 cap
    const baseBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, conversationId: fx.C, lastSeq: 1, bodyRefs: [], state: { bigField: "" } }),
      "utf8"
    );
    const bigStr = "A".repeat(32768 - baseBytes - 32);
    events.appendEvent({
      ...fx.scope, eventKey: "seed-big", kind: "status",
      expectedSeq: 0, payload: { x: 1 },
      projection: { state: { bigField: bigStr }, bodyRefs: [] },
    });

    // Assert preseed snapshot is within cap
    assert.ok(Buffer.byteLength(snapshotRow(fx.store, fx.C).projection_json, "utf8") <= 32768);

    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const eventsBefore = rawRows(fx.store, "events");
    const bodiesBefore = rawRows(fx.store, "large_bodies");
    const snapBefore = snapshotRow(fx.store, fx.C);

    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: fx.T, operationId: fx.O,
        partId: randomUUID(), nativeMessageId: "item-ovf", text: "ovf", expectedSeq: 1,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_INVALID_RECORD");
    }

    assert.deepEqual(rawRows(fx.store, "events"), eventsBefore);
    assert.deepEqual(rawRows(fx.store, "large_bodies"), bodiesBefore);
    assert.deepEqual(snapshotRow(fx.store, fx.C), snapBefore);
  });
});

// ─── 13. Invalid input shapes ──────────────────────────────────────────────

describe("S3c input validation", () => {
  it("invalid expectedSeq, malformed partId/nativeMessageId/NUL/surrogate, oversize text -> ERR_INVALID_RECORD", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const base = { ...fx.scope, turnId: fx.T, operationId: fx.O };

    const cases = [
      ["negative expectedSeq", { ...base, partId: randomUUID(), nativeMessageId: "x", text: "a", expectedSeq: -1 }],
      ["fraction expectedSeq", { ...base, partId: randomUUID(), nativeMessageId: "x", text: "a", expectedSeq: 1.5 }],
      ["malformed partId", { ...base, partId: "not-uuid", nativeMessageId: "x", text: "a", expectedSeq: 0 }],
      ["NUL in nativeMessageId", { ...base, partId: randomUUID(), nativeMessageId: "a\0b", text: "a", expectedSeq: 0 }],
      ["lone surrogate in text", { ...base, partId: randomUUID(), nativeMessageId: "x", text: "\uD800", expectedSeq: 0 }],
      ["oversize text >1MiB", { ...base, partId: randomUUID(), nativeMessageId: "x", text: "x".repeat(1048577), expectedSeq: 0 }],
    ];

    for (const [label, args] of cases) {
      try {
        deltas.appendMessageDelta(args);
        assert.fail(`should have thrown for ${label}`);
      } catch (e) {
        assert.equal(e.code, "ERR_INVALID_RECORD", `failed for ${label}`);
      }
    }
  });

  it("factory validation: missing store/verifier/clock -> ERR_INVALID_RECORD", () => {
    try { createSessionMessageDeltas(null); assert.fail(); } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    try { createSessionMessageDeltas({}); assert.fail(); } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    try { createSessionMessageDeltas({ store: {}, verifyOwnerEvidence: () => true }); assert.fail(); } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
  });
});

// ─── 14. Reopen stability and foreign/expired helper ───────────────────────

describe("S3c reopen and lineage", () => {
  it("reopen same path -> stable event/body/snapshot; foreign helper fails", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const partId = randomUUID();
    const r1 = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-r", text: "reopen", expectedSeq: 0,
    });

    fx.store.close();
    // Remove from ownedStores since already closed
    const idx = ownedStores.indexOf(fx.store);
    if (idx >= 0) ownedStores.splice(idx, 1);

    const store2 = openSessionStore({ databasePath: fx.path });
    ownedStores.push(store2);

    const deltas2 = createSessionMessageDeltas({
      store: store2, verifyOwnerEvidence: () => true, now: () => 3000,
    });
    // Exact retry on reopened store
    const r2 = deltas2.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId, nativeMessageId: "item-r", text: "reopen", expectedSeq: 0,
    });
    assert.equal(r2.created, false);
    assert.deepEqual(r2.cursor, r1.cursor);

    // Foreign helper: create a second store and try to use its tx with first deltas
    const fixture2 = makeStore();
    let expired;
    store2.transaction((tx) => { expired = tx; });
    assert.throws(() => deltas2.inTransaction(expired), { code: "ERR_INVALID_TX" });
    fixture2.store.transaction((tx) => {
      assert.throws(() => deltas2.inTransaction(tx), { code: "ERR_STORAGE" });
    });
  });
});

// ─── Regression: valid terminal without observation is NOT corrupt ──────────

describe("S3c regressions", () => {
  it("valid terminal WITHOUT observation: fresh delta ERR_TURN_STATE (not ERR_STORAGE)", () => {
    const fx = makeCodexFixture();
    // Queue a NEW turn without dispatch/observe, then settle via public API
    const newT = randomUUID();
    const newO = randomUUID();
    fx.turns.queueTurn({ ...fx.scope, turnId: newT, operationId: newO, prompt: "unobserved" });

    const outcomes = createSessionTurnOutcomes({ store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000 });
    outcomes.settleTurn({
      ...fx.scope, turnId: newT, operationId: newO,
      outcome: "failed",
      nativeFact: { nativeIdentity: "thread", nativeTurnId: "native-turn", claudeInputUuid: null },
      expectedSeq: 0,
    });

    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    try {
      deltas.appendMessageDelta({
        ...fx.scope, turnId: newT, operationId: newO,
        partId: randomUUID(), nativeMessageId: "item-reg", text: "reg", expectedSeq: 1,
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "ERR_TURN_STATE");
    }
  });

  it("second legitimate same-turn delta succeeds; both events present", () => {
    const fx = makeCodexFixture();
    const deltas = createSessionMessageDeltas({
      store: fx.store, verifyOwnerEvidence: () => true, now: () => 2000,
    });
    const p1 = randomUUID();
    const p2 = randomUUID();
    const r1 = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: p1, nativeMessageId: "item-s1", text: "one", expectedSeq: 0,
    });
    const r2 = deltas.appendMessageDelta({
      ...fx.scope, turnId: fx.T, operationId: fx.O,
      partId: p2, nativeMessageId: "item-s2", text: "two", expectedSeq: 1,
    });
    assert.equal(r1.created, true);
    assert.equal(r2.created, true);
    const events = rawRows(fx.store, "events");
    const keys = events.map((e) => e.event_key).sort();
    assert.deepEqual(keys, [`message_delta:${p1}`, `message_delta:${p2}`].sort());
  });
});
