// CHO-03 S2b producer-fence and native-binding tests: real temp SQLite
// fixtures only, never the actual user app-data. Projects/conversations come
// from the existing S2a records API. Covers factory/input validation,
// fence claim/renew/settle generations, verifier proof handling, Claude
// prelaunch requests, native ref binding/uniqueness, trigger-abort
// atomicity, overflow/malformed seeds, and close/reopen behavior. No
// implementation-mirroring mocks: verification reads raw SQL back through an
// independent connection where relevant, and fault seeds use trusted store
// transactions or raw SQL fixtures.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "cho-session-bindings-"));
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
const C1 = uid(101);
const C2 = uid(102);
const C3 = uid(103);
const C4 = uid(104);
const C5 = uid(105);
const C6 = uid(106);
const T1 = uid(301);
const T2 = uid(302);
const U1 = uid(401);
const U2 = uid(402);

function makeClock(start = 1700000000000) {
  let tick = start;
  return () => tick++;
}

const strictTrue = () => true;
const strictFalse = () => false;

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
  return { file, store, records, bindings, clock };
}

function openSecond(file, options = {}) {
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const bindings = createSessionBindings({
    store,
    verifyOwnerEvidence: options.verifier ?? strictTrue,
    now: options.clock ?? makeClock(1800000000000),
  });
  return { store, bindings };
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

function seedProject(records, id, name, pathCanonical) {
  return records.createProject({
    id,
    name,
    pathCanonical: pathCanonical ?? `/tmp/cho-bind-${id.slice(-4)}`,
  });
}

function seedConversation(records, id, projectId, controller = "codex") {
  return records.createConversation({ id, projectId, controller });
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

describe("factory and input validation", () => {
  it("exposes six frozen methods and performs no I/O on import/factory", () => {
    const dir = tempDir();
    const probe = dbPath(dir, "untouched.sqlite3");
    // A stub store proves the factory itself never touches the filesystem.
    const api = createSessionBindings({
      store: { transaction() {} },
      verifyOwnerEvidence: strictTrue,
    });
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "bindNativeRef",
      "claimProducer",
      "getNativeRef",
      "getProducer",
      "setRequestedClaudeSession",
      "settleProducer",
    ]);
    // No database file was created as a side effect of the factory.
    expect(existsSync(probe)).toBe(false);
  });

  it("rejects bad factory dependencies with ERR_INVALID_RECORD", () => {
    const stub = { transaction() {} };
    expectCode(() => createSessionBindings(), "ERR_INVALID_RECORD");
    expectCode(() => createSessionBindings(null), "ERR_INVALID_RECORD");
    expectCode(
      () => createSessionBindings({ store: stub }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBindings({ store: stub, verifyOwnerEvidence: null }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBindings({ store: stub, verifyOwnerEvidence: true }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBindings({ store: stub, verifyOwnerEvidence: "yes" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBindings({ store: null, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBindings({ store: {}, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        createSessionBindings({ store: stub, verifyOwnerEvidence: strictTrue, now: 123 }),
      "ERR_INVALID_RECORD"
    );
  });

  it("rejects malformed ids, generations, strings, and enums with ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { bindings } = openFresh(dir, "invalid.sqlite3");
    const upper = P1.toUpperCase();
    const padded = ` ${P1}`;
    const badIds = [undefined, null, 42, "", "not-a-uuid", upper, padded, "AAAAAAAA-BBBB-CCCC-DDDD-000000000001"];
    for (const projectId of badIds) {
      expectCode(() => bindings.getProducer({ projectId, conversationId: C1 }), "ERR_INVALID_RECORD");
      expectCode(() => bindings.getNativeRef({ projectId, conversationId: C1 }), "ERR_INVALID_RECORD");
    }
    const badGens = [undefined, null, -1, 1.5, "1", NaN, Infinity, true];
    for (const expectedGeneration of badGens) {
      expectCode(
        () =>
          bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration, evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    for (const generation of [0, ...badGens]) {
      expectCode(
        () =>
          bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation, state: "released", evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    for (const state of ["held", "queued", "", null, 42]) {
      expectCode(
        () =>
          bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state, evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    for (const controller of ["gpt", "", null, "CODEX"]) {
      expectCode(
        () =>
          bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller, nativeThreadId: "thr", evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    // Whitespace-only and padded ids are still well-formed opaque ids
    // (no trimming or normalization); only shape violations reject.
    const badThreads = ["", "x".repeat(513), "a\0b", 42, {}, []];
    for (const nativeThreadId of badThreads) {
      expectCode(
        () =>
          bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId, evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    // Lone surrogates reject without normalization.
    expectCode(
      () =>
        bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thr\ud800x", evidence: null }),
      "ERR_INVALID_RECORD"
    );
    for (const sessionUuid of ["not-a-uuid", U1.toUpperCase(), "", 42]) {
      expectCode(
        () =>
          bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid, evidence: null }),
        "ERR_INVALID_RECORD"
      );
    }
    expectCode(() => bindings.getProducer(null), "ERR_INVALID_RECORD");
    expectCode(() => bindings.claimProducer([]), "ERR_INVALID_RECORD");
  });

  it("reports ERR_NOT_FOUND for missing or wrong-project conversations on all six methods", () => {
    const dir = tempDir();
    const { file, bindings, records } = openFresh(dir, "notfound.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-nf-alpha");
    seedProject(records, P2, "beta", "/tmp/cho-nf-beta");
    seedConversation(records, C1, P1);
    const missing = uid(999);
    const cases = [
      () => bindings.getProducer({ projectId: P2, conversationId: C1 }),
      () => bindings.getProducer({ projectId: P1, conversationId: missing }),
      () => bindings.getNativeRef({ projectId: P2, conversationId: C1 }),
      () => bindings.getNativeRef({ projectId: P1, conversationId: missing }),
      () =>
        bindings.claimProducer({ projectId: P2, conversationId: C1, ownerToken: T1, expectedGeneration: 0, evidence: null }),
      () =>
        bindings.claimProducer({ projectId: P1, conversationId: missing, ownerToken: T1, expectedGeneration: 0, evidence: null }),
      () =>
        bindings.settleProducer({ projectId: P2, conversationId: C1, ownerToken: T1, generation: 1, state: "released", evidence: null }),
      () =>
        bindings.settleProducer({ projectId: P1, conversationId: missing, ownerToken: T1, generation: 1, state: "released", evidence: null }),
      () =>
        bindings.setRequestedClaudeSession({ projectId: P2, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null }),
      () =>
        bindings.setRequestedClaudeSession({ projectId: P1, conversationId: missing, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null }),
      () =>
        bindings.bindNativeRef({ projectId: P2, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thr-x", evidence: null }),
      () =>
        bindings.bindNativeRef({ projectId: P1, conversationId: missing, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thr-x", evidence: null }),
    ];
    for (const probe of cases) {
      expectCode(probe, "ERR_NOT_FOUND");
    }
    // Failed ownership checks wrote nothing.
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(rawAll(file, "SELECT conversation_id FROM producer_fences")).toEqual([]);
  });

  it("passes ERR_CLOSED through unchanged", () => {
    const dir = tempDir();
    const { store, bindings } = openFresh(dir, "closed.sqlite3");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expectCode(() => bindings.getProducer({ projectId: P1, conversationId: C1 }), "ERR_CLOSED");
    expectCode(() => bindings.getNativeRef({ projectId: P1, conversationId: C1 }), "ERR_CLOSED");
    expectCode(
      () => bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 0, evidence: null }),
      "ERR_CLOSED"
    );
    expectCode(
      () => bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "released", evidence: null }),
      "ERR_CLOSED"
    );
  });
});

describe("producer fences", () => {
  it("claims generation 1, renews at the same generation, and is visible to a second connection", () => {
    const dir = tempDir();
    const { file, store, records, bindings } = openFresh(dir, "fence.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-fence-alpha");
    seedConversation(records, C1, P1);
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toBeNull();

    const first = seedHeld(bindings, P1, C1, T1);
    expect(first).toMatchObject({ conversationId: C1, ownerToken: T1, generation: 1, state: "held" });
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toEqual(first);
    // Independent raw read-back confirms the persisted row.
    expect(rawGet(file, "SELECT owner_token, generation, state FROM producer_fences WHERE conversation_id = ?", [C1])).toMatchObject({
      owner_token: T1,
      generation: 1,
      state: "held",
    });

    // Same owner + exact generation renews at the SAME generation with a
    // refreshed timestamp (the shared clock advances on every operation).
    const renewed = bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 1, evidence: null });
    expect(renewed.generation).toBe(1);
    expect(renewed.updatedAtMs).toBeGreaterThan(first.updatedAtMs);

    // Age the fence far into the past: a different owner still cannot steal
    // a held fence, even with a verifier that always returns true.
    store.transaction((tx) => {
      tx.run("UPDATE producer_fences SET updated_ms = ? WHERE conversation_id = ?", [1, C1]);
    });
    const aged = bindings.getProducer({ projectId: P1, conversationId: C1 });
    expect(aged.updatedAtMs).toBe(1);
    const peer = openSecond(file, { verifier: strictTrue });
    expect(peer.bindings.getProducer({ projectId: P1, conversationId: C1 })).toEqual(aged);
    expectCode(
      () => peer.bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: 1, evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
    // The same owner renews fine through the independent connection.
    const peerRenewed = peer.bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 1, evidence: null });
    expect(peerRenewed).toMatchObject({ ownerToken: T1, generation: 1, state: "held" });
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toEqual(peerRenewed);
  });

  it("rejects stale generations and wrong tokens with ERR_FENCE_CONFLICT", () => {
    const dir = tempDir();
    const { bindings, records } = openFresh(dir, "stale.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-stale-alpha");
    seedConversation(records, C1, P1);
    const first = seedHeld(bindings, P1, C1, T1);
    const bad = [
      { ownerToken: T1, expectedGeneration: 0 },
      { ownerToken: T1, expectedGeneration: 2 },
      { ownerToken: T1, expectedGeneration: 99 },
      { ownerToken: T2, expectedGeneration: 1 },
      { ownerToken: T2, expectedGeneration: 0 },
    ];
    for (const attempt of bad) {
      expectCode(
        () => bindings.claimProducer({ projectId: P1, conversationId: C1, ...attempt, evidence: null }),
        "ERR_FENCE_CONFLICT"
      );
    }
    // Nothing moved.
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toEqual(first);
  });

  it("never inserts or upserts on a missing or stale expected generation", () => {
    const dir = tempDir();
    const { file, bindings, records } = openFresh(dir, "noguess.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-noguess-alpha");
    seedConversation(records, C1, P1);
    for (const expectedGeneration of [1, 2, 99]) {
      expectCode(
        () => bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration, evidence: null }),
        "ERR_FENCE_CONFLICT"
      );
    }
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(rawAll(file, "SELECT conversation_id FROM producer_fences")).toEqual([]);
  });

  it("rejects denied, non-boolean, throwing, and async proofs without secret echo or writes", async () => {
    const dir = tempDir();
    const { file, store, records } = openFresh(dir, "proof.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-proof-alpha");
    const secret = new Error("s3cr3t-proof-boom-xyz");
    const verifiers = [
      ["false", strictFalse],
      ["zero", () => 0],
      ["string", () => "yes"],
      ["undefined", () => undefined],
      ["null", () => null],
      ["throw", () => { throw secret; }],
      ["async-true", () => Promise.resolve(true)],
      ["async-reject", () => Promise.reject(secret)],
    ];
    for (const [index, [label, verifyOwnerEvidence]] of verifiers.entries()) {
      const conversationId = uid(110 + index);
      seedConversation(records, conversationId, P1);
      const bindings = createSessionBindings({ store, verifyOwnerEvidence, now: makeClock() });
      const error = expectCode(
        () =>
          bindings.claimProducer({ projectId: P1, conversationId, ownerToken: T1, expectedGeneration: 0, evidence: { marker: label } }),
        "ERR_OWNER_UNVERIFIED"
      );
      expect(String(error.message)).not.toContain("s3cr3t");
      expect(String(error.message)).not.toContain(label === "throw" ? "proof-boom" : "definitely-absent-marker-zz");
      // A rejected proof updates nothing.
      expect(bindings.getProducer({ projectId: P1, conversationId })).toBeNull();
    }
    // Let any consumed async rejection settle: none may escape unhandled.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rawAll(file, "SELECT conversation_id FROM producer_fences")).toEqual([]);
  });

  it("passes correct frozen facts and denies without updating held state", () => {
    const dir = tempDir();
    const { store, bindings, records } = openFresh(dir, "facts.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-facts-alpha");
    seedConversation(records, C1, P1);
    seedConversation(records, C2, P1);
    const seen = [];
    const spy = (facts) => {
      seen.push(facts);
      return true;
    };
    const spied = createSessionBindings({
      store,
      verifyOwnerEvidence: spy,
      now: makeClock(1900000000000),
    });
    const evidence = { proof: "host-fact-1" };
    spied.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 0, evidence });
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.keys(seen[0]).sort()).toEqual([
      "action",
      "conversationId",
      "evidence",
      "generation",
      "ownerToken",
      "projectId",
    ]);
    expect(seen[0]).toMatchObject({
      action: "live",
      projectId: P1,
      conversationId: C1,
      ownerToken: T1,
      generation: 1,
    });
    expect(seen[0].evidence).toBe(evidence);

    // Renew carries the same generation; settle carries the terminal action.
    spied.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 1, evidence: null });
    expect(seen[1]).toMatchObject({ action: "live", ownerToken: T1, generation: 1 });
    spied.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "released", evidence: null });
    expect(seen[2]).toMatchObject({ action: "released", ownerToken: T1, generation: 1 });
    // Reclaiming a released fence proposes the next generation for the new token.
    spied.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: 1, evidence: null });
    expect(seen[3]).toMatchObject({ action: "live", ownerToken: T2, generation: 2 });

    // A denied settle leaves the held fence exactly as it was.
    const denier = createSessionBindings({
      store,
      verifyOwnerEvidence: strictFalse,
      now: makeClock(),
    });
    const before = spied.getProducer({ projectId: P1, conversationId: C2 });
    expect(before).toBeNull();
    seedHeld(bindings, P1, C2, T1);
    const held = bindings.getProducer({ projectId: P1, conversationId: C2 });
    expectCode(
      () => denier.settleProducer({ projectId: P1, conversationId: C2, ownerToken: T1, generation: 1, state: "dead", evidence: null }),
      "ERR_OWNER_UNVERIFIED"
    );
    expect(bindings.getProducer({ projectId: P1, conversationId: C2 })).toEqual(held);
  });

  it("transitions held to released/dead only when verified, with stable repeats", () => {
    const dir = tempDir();
    const { bindings, records } = openFresh(dir, "settle.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-settle-alpha");
    seedConversation(records, C1, P1);
    seedHeld(bindings, P1, C1, T1);

    const released = bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "released", evidence: null });
    expect(released).toMatchObject({ ownerToken: T1, generation: 1, state: "released" });
    // Exact repeat returns the same record with an unchanged timestamp.
    const repeated = bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "released", evidence: null });
    expect(repeated).toEqual(released);
    // A different terminal proposal never downgrades or upgrades.
    expectCode(
      () => bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "dead", evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
    // A new token reclaims the terminal fence at generation 2.
    const second = bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: 1, evidence: null });
    expect(second).toMatchObject({ ownerToken: T2, generation: 2, state: "held" });
    // The stale former owner can no longer settle, renew, or write.
    expectCode(
      () => bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, state: "dead", evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
    expectCode(
      () => bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 1, evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
    // The old token can never reclaim its own terminal fence either.
    bindings.settleProducer({ projectId: P1, conversationId: C1, ownerToken: T2, generation: 2, state: "dead", evidence: null });
    expectCode(
      () => bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: 2, evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
  });

  it("denies terminal reclaim to the old token and blocks generation overflow", () => {
    const dir = tempDir();
    const { file, store, bindings, records } = openFresh(dir, "overflow.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-overflow-alpha");
    seedConversation(records, C1, P1);
    seedConversation(records, C2, P1);
    // Trusted store-tx seed: a released fence already at the safe-integer ceiling.
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO producer_fences(conversation_id, owner_token, generation, state, updated_ms) VALUES (?, ?, ?, ?, ?)",
        [C1, T1, Number.MAX_SAFE_INTEGER, "released", 7]
      );
    });
    expectCode(
      () => bindings.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: Number.MAX_SAFE_INTEGER, evidence: null }),
      "ERR_GENERATION_LIMIT"
    );
    // Overflow left the fence exactly as seeded.
    expect(rawGet(file, "SELECT owner_token, generation, state, updated_ms FROM producer_fences WHERE conversation_id = ?", [C1])).toMatchObject({
      owner_token: T1,
      generation: Number.MAX_SAFE_INTEGER,
      state: "released",
      updated_ms: 7,
    });
    // Malformed stored fences (bad generation / bad token) fail storage,
    // never authorize. (Bad states cannot be seeded: the schema CHECK
    // rejects them at write time, which the suite relies on elsewhere.)
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO producer_fences(conversation_id, owner_token, generation, state, updated_ms) VALUES (?, ?, ?, ?, ?)",
        [C2, T1, 0, "held", 7]
      );
    });
    expectCode(() => bindings.getProducer({ projectId: P1, conversationId: C2 }), "ERR_STORAGE");
    expectCode(
      () => bindings.claimProducer({ projectId: P1, conversationId: C2, ownerToken: T1, expectedGeneration: 0, evidence: null }),
      "ERR_STORAGE"
    );
  });

  it("survives close/reopen with no automatic recovery of held fences", () => {
    const dir = tempDir();
    const { file, store, records, bindings } = openFresh(dir, "reopen.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-reopen-alpha");
    seedConversation(records, C1, P1);
    const first = seedHeld(bindings, P1, C1, T1);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openSessionStore({ databasePath: file });
    stores.push(reopened);
    const again = createSessionBindings({ store: reopened, verifyOwnerEvidence: strictTrue, now: makeClock() });
    expect(again.getProducer({ projectId: P1, conversationId: C1 })).toEqual(first);
    // Still held after reopen: no TTL, no takeover, no auto-release.
    expectCode(
      () => again.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T2, expectedGeneration: 1, evidence: null }),
      "ERR_FENCE_CONFLICT"
    );
    const renewed = again.claimProducer({ projectId: P1, conversationId: C1, ownerToken: T1, expectedGeneration: 1, evidence: null });
    expect(renewed).toMatchObject({ ownerToken: T1, generation: 1, state: "held" });
  });
});

describe("native references", () => {
  it("persists a Claude prelaunch request without creating a native ref", () => {
    const dir = tempDir();
    const { bindings, records } = openFresh(dir, "request.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-req-alpha");
    seedConversation(records, C1, P1, "claude");
    seedHeld(bindings, P1, C1, T1);
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C1 })).toBeNull();

    const receipt = bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });
    expect(receipt).toEqual({ conversationId: C1, projectId: P1, requestedClaudeSessionUuid: U1 });
    // Still no native ref: the request is not an association.
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C1 })).toBeNull();
    const conv = records.getConversation({ projectId: P1, conversationId: C1 });
    expect(conv.requestedClaudeSessionUuid).toBe(U1);
    // Observed/reported model fields stay NULL; only the request is stored.
    expect(conv.modelReported).toBeNull();
    expect(conv.servedVerified).toBeNull();

    // The same UUID repeats unchanged without touching the timestamp.
    const touched = records.getConversation({ projectId: P1, conversationId: C1 });
    const repeat = bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });
    expect(repeat).toEqual(receipt);
    expect(records.getConversation({ projectId: P1, conversationId: C1 }).updatedAtMs).toBe(touched.updatedAtMs);
    // The requested UUID can never change.
    expectCode(
      () => bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U2, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    expect(records.getConversation({ projectId: P1, conversationId: C1 }).requestedClaudeSessionUuid).toBe(U1);
  });

  it("rejects requests on codex chats and mismatched or absent requests", () => {
    const dir = tempDir();
    const { bindings, records } = openFresh(dir, "reqerr.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-reqerr-alpha");
    seedConversation(records, C1, P1, "codex");
    seedConversation(records, C2, P1, "claude");
    seedConversation(records, C3, P1, "claude");
    seedHeld(bindings, P1, C1, T1);
    seedHeld(bindings, P1, C2, T1);
    seedHeld(bindings, P1, C3, T1);
    // A request on a Codex conversation rejects.
    expectCode(
      () => bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // Binding without any request rejects (absent request).
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C2, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // Binding a UUID that does not match the request rejects.
    bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C3, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C3, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U2, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // Wrong controller for the conversation rejects.
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C3, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thr-x", evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // Mixed or missing native id kinds reject.
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thr-x", nativeSessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: null, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C3, ownerToken: T1, generation: 1, controller: "claude", nativeThreadId: "thr-x", nativeSessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // Nothing bound anywhere.
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C2 })).toBeNull();
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C3 })).toBeNull();
  });

  it("binds the matching observed Claude UUID, keeps the original timestamp, and never replaces", () => {
    const dir = tempDir();
    const { file, bindings, records } = openFresh(dir, "claudebind.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-cbind-alpha");
    seedConversation(records, C1, P1, "claude");
    seedHeld(bindings, P1, C1, T1);
    bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });

    const ref = bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null });
    expect(ref).toMatchObject({
      conversationId: C1,
      projectId: P1,
      controller: "claude",
      nativeThreadId: null,
      nativeSessionUuid: U1,
    });
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C1 })).toEqual(ref);
    // Exact repeat returns the original record with its original timestamp.
    const repeat = bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null });
    expect(repeat).toEqual(ref);
    // A different observed id cannot replace the bound ref.
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U2, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    // The raw row holds exactly the observed identity, nothing fabricated.
    expect(rawGet(file, "SELECT controller, native_thread_id, native_session_uuid FROM native_refs WHERE conversation_id = ?", [C1])).toMatchObject({
      controller: "claude",
      native_thread_id: null,
      native_session_uuid: U1,
    });
    // Conversation pinning fields stay untouched by the bind.
    expect(records.getConversation({ projectId: P1, conversationId: C1 })).toMatchObject({
      modelRequested: null,
      modelReported: null,
      servedVerified: null,
      requestedClaudeSessionUuid: U1,
    });
  });

  it("rejects a request when a Claude ref is already bound without history", () => {
    const dir = tempDir();
    const { store, bindings, records } = openFresh(dir, "inconsistent.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-inc-alpha");
    seedConversation(records, C1, P1, "claude");
    seedHeld(bindings, P1, C1, T1);
    // Trusted store-tx seed: a bound ref with no matching requested UUID.
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO native_refs(conversation_id, project_id, controller, native_thread_id, native_session_uuid, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [C1, P1, "claude", null, U1, 11]
      );
    });
    expectCode(
      () => bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
  });

  it("binds opaque Codex thread ids with global uniqueness and intact raw constraints", () => {
    const dir = tempDir();
    const { file, bindings, records } = openFresh(dir, "codexbind.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-xbind-alpha");
    seedConversation(records, C1, P1, "codex");
    seedConversation(records, C2, P1, "codex");
    seedConversation(records, C3, P1, "codex");
    seedHeld(bindings, P1, C1, T1);
    seedHeld(bindings, P1, C2, T1);
    seedHeld(bindings, P1, C3, T1);

    const opaque = "thr∅ead-😀-尾-9f2";
    const ref = bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: opaque, evidence: null });
    expect(ref.nativeThreadId).toBe(opaque);
    expect(ref.nativeSessionUuid).toBeNull();
    // The same native id cannot bind a second chat, atomically: no row leaks.
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C2, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: opaque, evidence: null }),
      "ERR_BINDING_CONFLICT"
    );
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C2 })).toBeNull();
    // A distinct thread in the same project binds correctly.
    const other = bindings.bindNativeRef({ projectId: P1, conversationId: C2, ownerToken: T1, generation: 1, controller: "codex", nativeThreadId: "thread_other_7", evidence: null });
    expect(other).toMatchObject({ conversationId: C2, nativeThreadId: "thread_other_7" });
    // Raw foreign-key and uniqueness constraints remain intact.
    const raw = openRaw(file);
    try {
      expect(() =>
        raw.prepare(
          "INSERT INTO native_refs(conversation_id, project_id, controller, native_thread_id, native_session_uuid, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(uid(777), P1, "codex", "thread_raw_fk", null, 1)
      ).toThrow();
      expect(() =>
        raw.prepare(
          "INSERT INTO native_refs(conversation_id, project_id, controller, native_thread_id, native_session_uuid, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(C3, P1, "codex", opaque, null, 1)
      ).toThrow();
    } finally {
      raw.close();
    }
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C3 })).toBeNull();
  });

  it("denies requests and binds without changing stored state", () => {
    const dir = tempDir();
    const { store, bindings, records } = openFresh(dir, "denied.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-denied-alpha");
    seedConversation(records, C1, P1, "claude");
    seedHeld(bindings, P1, C1, T1);
    const denier = createSessionBindings({ store, verifyOwnerEvidence: strictFalse, now: makeClock() });
    expectCode(
      () => denier.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null }),
      "ERR_OWNER_UNVERIFIED"
    );
    expect(records.getConversation({ projectId: P1, conversationId: C1 }).requestedClaudeSessionUuid).toBeNull();
    bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });
    expectCode(
      () => denier.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null }),
      "ERR_OWNER_UNVERIFIED"
    );
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C1 })).toBeNull();
  });

  it("aborts a fault-injected insert atomically and retries cleanly after trigger removal", () => {
    const dir = tempDir();
    const { file, bindings, records } = openFresh(dir, "fault.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-fault-alpha");
    seedConversation(records, C1, P1, "claude");
    const fence = seedHeld(bindings, P1, C1, T1);
    bindings.setRequestedClaudeSession({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, sessionUuid: U1, evidence: null });
    const convBefore = records.getConversation({ projectId: P1, conversationId: C1 });

    // The raw trigger is added AFTER the store opened (S1 schema admission
    // would refuse it on open, which is intentional), and removed BEFORE any
    // reopen below.
    const raw = openRaw(file);
    try {
      raw.exec(
        "CREATE TRIGGER cho_abort_native BEFORE INSERT ON native_refs BEGIN SELECT RAISE(ABORT, 'cho fault injection'); END"
      );
    } finally {
      raw.close();
    }
    expectCode(
      () => bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null }),
      "ERR_STORAGE"
    );
    // Atomic abort: no native ref, and fence / request / config unchanged.
    expect(bindings.getNativeRef({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(bindings.getProducer({ projectId: P1, conversationId: C1 })).toEqual(fence);
    expect(records.getConversation({ projectId: P1, conversationId: C1 })).toEqual(convBefore);
    expect(rawAll(file, "SELECT conversation_id FROM native_refs")).toEqual([]);

    const cleanup = openRaw(file);
    try {
      cleanup.exec("DROP TRIGGER cho_abort_native");
    } finally {
      cleanup.close();
    }
    const ref = bindings.bindNativeRef({ projectId: P1, conversationId: C1, ownerToken: T1, generation: 1, controller: "claude", nativeSessionUuid: U1, evidence: null });
    expect(ref).toMatchObject({ conversationId: C1, nativeSessionUuid: U1 });
  });
});
