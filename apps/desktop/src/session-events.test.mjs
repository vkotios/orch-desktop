import { describe, it, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionEvents } from "../server/session-events.mjs";
import { createSessionBodies } from "../server/session-bodies.mjs";

let tmpDir;
let store;

function freshStore() {
  tmpDir = mkdtempSync(join(tmpdir(), "evt-test-"));
  store = openSessionStore({ databasePath: join(tmpDir, "test.db") });
  return store;
}

function setupFixture() {
  const s = freshStore();
  const records = createSessionRecords({ store: s });
  const P = randomUUID();
  const C = randomUUID();
  records.createProject({ id: P, name: "synthetic", pathCanonical: "C:/synthetic/events" });
  records.createConversation({ id: C, projectId: P, controller: "codex" });
  const bindings = createSessionBindings({ store: s, verifyOwnerEvidence: () => true });
  const claim = bindings.claimProducer({
    projectId: P, conversationId: C, ownerToken: randomUUID(),
    expectedGeneration: 0, evidence: null,
  });
  const scope = {
    projectId: P, conversationId: C,
    ownerToken: claim.ownerToken, ownerGeneration: 1,
    hostGeneration: randomUUID(), evidence: null,
  };
  return { store: s, records, bindings, P, C, scope };
}

function makeEvents(s, clock = () => 1000) {
  return createSessionEvents({ store: s, verifyOwnerEvidence: () => true, now: clock });
}

afterEach(() => {
  if (store) { try { store.close(); } catch {} store = null; }
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = null; }
});

describe("S3a session-events", () => {
  it("empty snapshot/poll, fresh append shape, payload copy, idempotent retry, key conflict", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    expect(ev.getSnapshot({ projectId: P, conversationId: C })).toBeNull();
    const poll0 = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    expect(poll0.events).toEqual([]);
    expect(poll0.tip).toBe(0);
    expect(poll0.hasMore).toBe(false);

    const payload = { text: "hello", meta: { z: 1, a: 2 } };
    const res = ev.appendEvent({
      ...scope, eventKey: "one", kind: "message_delta",
      payload, expectedSeq: 0, projection: { state: { count: 1 }, bodyRefs: [] },
    });
    assert.equal(res.created, true);
    assert.equal(res.event.seq, 1);
    assert.equal(res.event.kind, "message_delta");
    assert.equal(res.cursor.instanceId, s.instanceId);
    // canonical key order: a before z
    assert.deepEqual(Object.keys(res.event.payload.meta), ["a", "z"]);
    // payload is a copy
    payload.text = "MUTATED";
    assert.equal(res.event.payload.text, "hello");

    const snap = ev.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap.version, 1);
    assert.equal(snap.conversationId, C);
    assert.equal(snap.lastSeq, 1);
    assert.deepEqual(snap.bodyRefs, []);
    assert.deepEqual(snap.state, { count: 1 });

    // idempotent retry: same key, reordered payload keys, stale expectedSeq, no projection
    const retry = ev.appendEvent({
      ...scope, eventKey: "one", kind: "message_delta",
      payload: { meta: { a: 2, z: 1 }, text: "hello" },
      expectedSeq: 99,
    });
    assert.equal(retry.created, false);
    assert.equal(retry.event.seq, 1);

    // key conflict: different payload
    try {
      ev.appendEvent({
        ...scope, eventKey: "one", kind: "message_delta",
        payload: { text: "different" }, expectedSeq: 1,
        projection: { state: {}, bodyRefs: [] },
      });
      assert.fail("should throw");
    } catch (e) { assert.equal(e.code, "ERR_EVENT_KEY_CONFLICT"); }
  });

  it("stale expectedSeq, contiguous events, poll replay/limit/at-tip, cap 32", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    try {
      ev.appendEvent({
        ...scope, eventKey: "x", kind: "message_delta",
        payload: { a: 1 }, expectedSeq: 5,
        projection: { state: {}, bodyRefs: [] },
      });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_EVENT_VERSION_CONFLICT"); }

    for (let i = 1; i <= 3; i++) {
      ev.appendEvent({
        ...scope, eventKey: `k${i}`, kind: "message_delta",
        payload: { i }, expectedSeq: i - 1,
        projection: { state: { i }, bodyRefs: [] },
      });
    }
    // poll replay identical
    const p1 = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    const p2 = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.deepEqual(p1.events, p2.events);
    assert.equal(p1.tip, 3);
    // limit 1
    const pL = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 1, maxBytes: 131072 });
    assert.equal(pL.events.length, 1);
    assert.equal(pL.hasMore, true);
    assert.equal(pL.cursor.seq, 1);
    // at tip
    const pT = ev.pollEvents({ projectId: P, conversationId: C, cursor: p1.cursor, limit: 32, maxBytes: 131072 });
    assert.equal(pT.events.length, 0);
    assert.equal(pT.hasMore, false);
    // cap 32
    for (let i = 4; i <= 35; i++) {
      ev.appendEvent({
        ...scope, eventKey: `k${i}`, kind: "message_delta",
        payload: { i }, expectedSeq: i - 1,
        projection: { state: { i }, bodyRefs: [] },
      });
    }
    const pCap = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.equal(pCap.events.length, 32);
    assert.equal(pCap.hasMore, true);
  });

  it("cursor errors, wrong project NF before cursor, invalid limits/maxBytes", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    ev.appendEvent({
      ...scope, eventKey: "a", kind: "message_delta",
      payload: { x: 1 }, expectedSeq: 0,
      projection: { state: {}, bodyRefs: [] },
    });
    const badInst = { instanceId: randomUUID(), conversationId: C, seq: 0 };
    try { ev.pollEvents({ projectId: P, conversationId: C, cursor: badInst, limit: 32, maxBytes: 131072 }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_CURSOR_INSTANCE"); }

    const badConv = { instanceId: s.instanceId, conversationId: randomUUID(), seq: 0 };
    try { ev.pollEvents({ projectId: P, conversationId: C, cursor: badConv, limit: 32, maxBytes: 131072 }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_CURSOR_SCOPE"); }

    const beyond = { instanceId: s.instanceId, conversationId: C, seq: 99 };
    try { ev.pollEvents({ projectId: P, conversationId: C, cursor: beyond, limit: 32, maxBytes: 131072 }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_CURSOR_RANGE"); }

    // wrong project NF before cursor checks
    try { ev.pollEvents({ projectId: randomUUID(), conversationId: C, cursor: badInst, limit: 32, maxBytes: 131072 }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_NOT_FOUND"); }

    // invalid limits
    for (const lim of [0, 33, null]) {
      try { ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: lim, maxBytes: 131072 }); assert.fail(); }
      catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    }
    for (const mb of [4095, 131073, null]) {
      try { ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: mb }); assert.fail(); }
      catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    }
  });

  it("page budget: only one fits, next cursor not tip, hasMore, page too small", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    const big = "A".repeat(32000);
    for (let i = 1; i <= 3; i++) {
      ev.appendEvent({
        ...scope, eventKey: `big${i}`, kind: "message_delta",
        payload: { text: big }, expectedSeq: i - 1,
        projection: { state: { i }, bodyRefs: [] },
      });
    }
    const page = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 65536 });
    assert.equal(page.events.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.cursor.seq, 1);
    assert.equal(page.tip, 3);
    const actualBytes = Buffer.byteLength(JSON.stringify(page), "utf8") + 2048;
    assert.ok(actualBytes <= 65536, `page bytes ${actualBytes} exceeds budget`);
    // 4096 budget too small
    try { ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 4096 }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_EVENT_PAGE_TOO_SMALL"); }
  });

  it("payload validation: root types, nested unsafe, getters", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    const base = { ...scope, eventKey: "v", kind: "message_delta", expectedSeq: 0, projection: { state: {}, bodyRefs: [] } };
    for (const bad of [null, [1, 2], 42, "str", new Date()]) {
      try { ev.appendEvent({ ...base, payload: bad }); assert.fail(); }
      catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    }
    // nested undefined
    try { ev.appendEvent({ ...base, payload: { a: undefined } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // function
    try { ev.appendEvent({ ...base, payload: { f: () => {} } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // symbol
    try { ev.appendEvent({ ...base, payload: { s: Symbol("x") } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // bigint
    try { ev.appendEvent({ ...base, payload: { b: 1n } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // non-finite
    try { ev.appendEvent({ ...base, payload: { n: Infinity } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // NUL in string
    try { ev.appendEvent({ ...base, payload: { s: "a\0b" } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // lone surrogate
    try { ev.appendEvent({ ...base, payload: { s: "\uD800" } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // cycle
    const cyc = {}; cyc.self = cyc;
    try { ev.appendEvent({ ...base, payload: cyc }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // sparse array
    const sparse = [1, , 3];
    try { ev.appendEvent({ ...base, payload: { a: sparse } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    // object getter rejected with counter
    let objGetterCount = 0;
    const withGetter = {}; Object.defineProperty(withGetter, "g", { get() { objGetterCount++; return 1; }, enumerable: true });
    try { ev.appendEvent({ ...base, payload: withGetter }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    assert.equal(objGetterCount, 0);

    // array index getter with own enumerable get increments counter
    let arrGetterCount = 0;
    const arrWithGetter = [1, 2];
    Object.defineProperty(arrWithGetter, "1", { get() { arrGetterCount++; return 99; }, enumerable: true });
    try { ev.appendEvent({ ...base, payload: { a: arrWithGetter } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    assert.equal(arrGetterCount, 0);

    // projection.state getter increments counter
    let stateGetterCount = 0;
    const stateWithGetter = {};
    Object.defineProperty(stateWithGetter, "x", { get() { stateGetterCount++; return 1; }, enumerable: true });
    try { ev.appendEvent({ ...scope, eventKey: "pg", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: stateWithGetter, bodyRefs: [] } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    assert.equal(stateGetterCount, 0);

    // bodyRefs index getter increments counter
    let brGetterCount = 0;
    const brWithGetter = [randomUUID()];
    Object.defineProperty(brWithGetter, "0", { get() { brGetterCount++; return randomUUID(); }, enumerable: true });
    try { ev.appendEvent({ ...scope, eventKey: "bg", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: {}, bodyRefs: brWithGetter } }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
    assert.equal(brGetterCount, 0);

    // valid own __proto__ payload preserved without prototype mutation
    const protoPayload = JSON.parse('{"__proto__":{"x":1}}');
    const protoRes = ev.appendEvent({ ...scope, eventKey: "proto", kind: "message_delta", payload: protoPayload, expectedSeq: 0, projection: { state: {}, bodyRefs: [] } });
    assert.equal(protoRes.created, true);
    assert.ok(Object.prototype.hasOwnProperty.call(protoRes.event.payload, "__proto__"));
    assert.deepEqual(protoRes.event.payload.__proto__, { x: 1 });
    const protoPoll = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.equal(protoPoll.events.length, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(protoPoll.events[0].payload, "__proto__"));
    assert.equal({}.x, undefined);
  });

  it("bodyRef existing/missing/foreign, duplicate bodyRefs", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    const bodies = createSessionBodies({ store: s, verifyOwnerEvidence: () => true });
    const bodyId = randomUUID();
    bodies.putBody({ ...scope, bodyId, text: "synthetic" });
    // valid
    const res = ev.appendEvent({
      ...scope, eventKey: "br", kind: "message_delta",
      payload: { x: 1 }, expectedSeq: 0,
      projection: { state: {}, bodyRefs: [bodyId] },
    });
    assert.equal(res.created, true);
    // missing bodyRef
    try {
      ev.appendEvent({
        ...scope, eventKey: "br2", kind: "message_delta",
        payload: { x: 1 }, expectedSeq: 1,
        projection: { state: {}, bodyRefs: [randomUUID()] },
      });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_NOT_FOUND"); }
    // duplicate bodyRefs
    try {
      ev.appendEvent({
        ...scope, eventKey: "br3", kind: "message_delta",
        payload: { x: 1 }, expectedSeq: 1,
        projection: { state: {}, bodyRefs: [bodyId, bodyId] },
      });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }
  });

  it("owner false ERR_OWNER_UNVERIFIED, stale owner ERR_FENCE_CONFLICT, proof-free reads", () => {
    const s = freshStore();
    const records = createSessionRecords({ store: s });
    const P = randomUUID(); const C = randomUUID();
    records.createProject({ id: P, name: "synthetic", pathCanonical: "C:/synthetic/events" });
    records.createConversation({ id: C, projectId: P, controller: "codex" });
    const bindings = createSessionBindings({ store: s, verifyOwnerEvidence: () => true });
    const claim = bindings.claimProducer({ projectId: P, conversationId: C, ownerToken: randomUUID(), expectedGeneration: 0, evidence: null });
    const scope = { projectId: P, conversationId: C, ownerToken: claim.ownerToken, ownerGeneration: 1, hostGeneration: randomUUID(), evidence: null };

    // owner false
    const evDeny = createSessionEvents({ store: s, verifyOwnerEvidence: () => false, now: () => 1000 });
    try {
      evDeny.appendEvent({ ...scope, eventKey: "d", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: {}, bodyRefs: [] } });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_OWNER_UNVERIFIED"); }

    // release and reclaim -> stale owner
    bindings.settleProducer({ ...scope, generation: 1, state: "released" });
    const claim2 = bindings.claimProducer({ projectId: P, conversationId: C, ownerToken: randomUUID(), expectedGeneration: 1, evidence: null });
    const staleScope = { ...scope, ownerGeneration: 1 };
    const ev2 = makeEvents(s);
    try {
      ev2.appendEvent({ ...staleScope, eventKey: "s", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: {}, bodyRefs: [] } });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_FENCE_CONFLICT"); }

    // proof-free poll/snapshot still work
    const snap = ev2.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap, null);
    const poll = ev2.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.equal(poll.events.length, 0);
  });

  it("trigger ABORT/IGNORE on snapshots -> ERR_STORAGE, rollback", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    // Seed one valid event so snapshot exists at seq 1 (UPDATE trigger will fire on next append)
    ev.appendEvent({ ...scope, eventKey: "seed", kind: "message_delta", payload: { a: 0 }, expectedSeq: 0, projection: { state: { v: 0 }, bodyRefs: [] } });

    function snapshotRaw() {
      return s.transaction((tx) => ({
        events: tx.all("SELECT * FROM events WHERE conversation_id = ?", [C]),
        snapshots: tx.all("SELECT * FROM snapshots WHERE conversation_id = ?", [C]),
        conversations: tx.all("SELECT * FROM conversations WHERE id = ?", [C]),
      }));
    }

    // ABORT trigger
    const beforeAbort = snapshotRaw();
    s.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER test_abort BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'fixture'); END");
    });
    try {
      ev.appendEvent({ ...scope, eventKey: "t1", kind: "message_delta", payload: { a: 1 }, expectedSeq: 1, projection: { state: { v: 1 }, bodyRefs: [] } });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    const afterAbort = snapshotRaw();
    assert.deepEqual(afterAbort, beforeAbort);
    s.transaction((tx) => { tx.run("DROP TRIGGER test_abort"); });

    // IGNORE trigger
    const beforeIgnore = snapshotRaw();
    s.transaction((tx) => {
      tx.run("CREATE TEMP TRIGGER test_ignore BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(IGNORE); END");
    });
    try {
      ev.appendEvent({ ...scope, eventKey: "t2", kind: "message_delta", payload: { a: 2 }, expectedSeq: 1, projection: { state: { v: 2 }, bodyRefs: [] } });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
    const afterIgnore = snapshotRaw();
    assert.deepEqual(afterIgnore, beforeIgnore);
    s.transaction((tx) => { tx.run("DROP TRIGGER test_ignore"); });
  });

  it("inTransaction outer rollback: body+event then throw -> no changes", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    const bodies = createSessionBodies({ store: s, verifyOwnerEvidence: () => true });
    const bodyId = randomUUID();
    try {
      s.transaction((tx) => {
        const inner = ev.inTransaction(tx);
        const innerBodies = bodies.inTransaction(tx);
        innerBodies.putBody({ ...scope, bodyId, text: "synthetic" });
        inner.appendEvent({
          ...scope, eventKey: "tx1", kind: "message_delta",
          payload: { a: 1 }, expectedSeq: 0,
          projection: { state: {}, bodyRefs: [bodyId] },
        });
        throw new Error("marker");
      });
    } catch (e) { assert.equal(e.message, "marker"); }
    // nothing persisted
    const poll = ev.pollEvents({ projectId: P, conversationId: C, cursor: null, limit: 32, maxBytes: 131072 });
    assert.equal(poll.events.length, 0);
    assert.equal(poll.tip, 0);
    const snap = ev.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap, null);
    // body absent
    assert.equal(bodies.getBody({ projectId: P, conversationId: C, bodyId }), null);
  });

  it("close/reopen persistence, clock regression, corrupt data -> ERR_STORAGE", () => {
    const { store: s, P, C, scope } = setupFixture();
    const ev = makeEvents(s);
    ev.appendEvent({ ...scope, eventKey: "p1", kind: "message_delta", payload: { a: 1 }, expectedSeq: 0, projection: { state: { v: 1 }, bodyRefs: [] } });
    const cursor = { instanceId: s.instanceId, conversationId: C, seq: 1 };
    store.close(); store = null;
    // reopen
    store = openSessionStore({ databasePath: join(tmpDir, "test.db") });
    const ev2 = makeEvents(store);
    const snap = ev2.getSnapshot({ projectId: P, conversationId: C });
    assert.equal(snap.lastSeq, 1);
    const poll = ev2.pollEvents({ projectId: P, conversationId: C, cursor, limit: 32, maxBytes: 131072 });
    assert.equal(poll.events.length, 0);
    assert.equal(poll.tip, 1);

    // clock regression: fresh append with earlier stamp
    const ev3 = createSessionEvents({ store, verifyOwnerEvidence: () => true, now: () => 500 });
    try {
      ev3.appendEvent({ ...scope, eventKey: "p2", kind: "message_delta", payload: { a: 2 }, expectedSeq: 1, projection: { state: { v: 2 }, bodyRefs: [] } });
      assert.fail();
    } catch (e) { assert.equal(e.code, "ERR_INVALID_RECORD"); }

    // corrupt snapshot lastSeq mismatch via raw edit
    store.transaction((tx) => {
      tx.run("UPDATE snapshots SET last_seq = 99 WHERE conversation_id = ?", [C]);
    });
    try { ev2.getSnapshot({ projectId: P, conversationId: C }); assert.fail(); }
    catch (e) { assert.equal(e.code, "ERR_STORAGE"); }
  });
});
