// CHO-03 S2c turn-intent and dispatch-journal tests: real temp SQLite
// fixtures only, never the actual user app-data. Projects/conversations
// come from the S2a records API, fences and native refs from the S2b
// bindings API. Covers factory/input validation, queue idempotency and
// conflicts, fence/proof handling across two live connections, the
// dispatch -> written -> observed -> terminal journal, native correlation
// rules per controller, trigger-abort atomicity, overflow/malformed seeds,
// inTransaction composition/lineage, and close behavior. No
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
import { createProducerAuthorizer } from "../server/session-producer-transaction.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "cho-session-turns-"));
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
const T1 = uid(301);
const T2 = uid(302);
const H1 = uid(311);
const H2 = uid(312);
const UREQ = uid(321);
const I1 = uid(331);
const I2 = uid(332);
const I3 = uid(333);

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
  const turns = createSessionTurns({
    store,
    verifyOwnerEvidence: options.turnVerifier ?? strictTrue,
    now: clock,
  });
  return { file, store, records, bindings, turns, clock };
}

function openSecondTurns(file, options = {}) {
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const turns = createSessionTurns({
    store,
    verifyOwnerEvidence: options.turnVerifier ?? strictTrue,
    now: options.clock ?? makeClock(1800000000000),
  });
  return { store, turns };
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
    pathCanonical: `/tmp/cho-turn-${id.slice(-4)}`,
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

describe("factory and input validation", () => {
  it("exposes eight frozen methods and performs no I/O on import/factory", () => {
    const dir = tempDir();
    const probe = dbPath(dir, "untouched.sqlite3");
    const api = createSessionTurns({
      store: { transaction() {} },
      verifyOwnerEvidence: strictTrue,
    });
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "beginDispatch",
      "getTurn",
      "inTransaction",
      "listTurns",
      "queueTurn",
      "recordObserved",
      "recordWritten",
      "settleTurn",
    ]);
    expect(existsSync(probe)).toBe(false);
  });

  it("rejects bad factory dependencies with ERR_INVALID_RECORD", () => {
    const stub = { transaction() {} };
    expectCode(() => createSessionTurns(), "ERR_INVALID_RECORD");
    expectCode(() => createSessionTurns(null), "ERR_INVALID_RECORD");
    expectCode(() => createSessionTurns({ store: stub }), "ERR_INVALID_RECORD");
    expectCode(
      () => createSessionTurns({ store: stub, verifyOwnerEvidence: null }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionTurns({ store: null, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionTurns({ store: {}, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        createSessionTurns({ store: stub, verifyOwnerEvidence: strictTrue, now: 7 }),
      "ERR_INVALID_RECORD"
    );
  });

  it("rejects malformed ids, prompts, and pagination with ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { turns, records } = openFresh(dir, "invalid.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    const bad = [undefined, null, 42, "", "not-a-uuid", P1.toUpperCase(), ` ${P1}`];
    for (const projectId of bad) {
      expectCode(
        () => turns.getTurn({ projectId, conversationId: CX, turnId: uid(900) }),
        "ERR_INVALID_RECORD"
      );
    }
    const s = scope(P1, CX);
    const R = uid(910);
    const O = uid(920);
    expectCode(() => turns.queueTurn({ ...s, turnId: "bad", operationId: O, prompt: "hi" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: "bad", prompt: "hi" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "x".repeat(65537) }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "é".repeat(20000) }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "a\0b" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "ok\ud800" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn({ ...s, turnId: R, operationId: O, prompt: "hi", effort: "x".repeat(65) }), "ERR_INVALID_RECORD");
    expectCode(() => turns.queueTurn(null), "ERR_INVALID_RECORD");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX, limit: 0 }), "ERR_INVALID_RECORD");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX, limit: 101 }), "ERR_INVALID_RECORD");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX, offset: -1 }), "ERR_INVALID_RECORD");
    expectCode(() => turns.settleTurn({ ...s, turnId: R, operationId: O, outcome: "done" }), "ERR_INVALID_RECORD");
    expectCode(() => turns.inTransaction(null), "ERR_INVALID_RECORD");
    expectCode(() => turns.inTransaction({}), "ERR_INVALID_RECORD");
  });

  it("reports ERR_NOT_FOUND for missing or wrong-project conversations", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "notfound.sqlite3");
    seedProject(records, P1, "alpha");
    seedProject(records, P2, "beta");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const missing = uid(940);
    const s = scope(P1, CX);
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: missing })).toBeNull();
    expectCode(() => turns.getTurn({ projectId: P2, conversationId: CX, turnId: missing }), "ERR_NOT_FOUND");
    expectCode(() => turns.getTurn({ projectId: P1, conversationId: missing, turnId: missing }), "ERR_NOT_FOUND");
    expectCode(() => turns.listTurns({ projectId: P2, conversationId: CX }), "ERR_NOT_FOUND");
    expectCode(
      () => turns.queueTurn({ ...s, projectId: P2, turnId: missing, operationId: uid(941), prompt: "hi" }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => turns.beginDispatch({ ...s, turnId: missing, operationId: uid(942) }),
      "ERR_NOT_FOUND"
    );
    // Failed ownership checks wrote nothing.
    expect(rawAll(dbPath(dir, "notfound.sqlite3"), "SELECT id FROM turns")).toEqual([]);
  });

  it("passes ERR_CLOSED through unchanged", () => {
    const dir = tempDir();
    const { store, turns } = openFresh(dir, "closed.sqlite3");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expectCode(
      () => turns.getTurn({ projectId: P1, conversationId: CX, turnId: uid(950) }),
      "ERR_CLOSED"
    );
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX), turnId: uid(951), operationId: uid(952), prompt: "hi" }),
      "ERR_CLOSED"
    );
  });
});

describe("queue intents, idempotency, and conflicts", () => {
  it("queues a codex turn with exact text, config, provenance, and seq", () => {
    const dir = tempDir();
    const { file, turns, records, bindings } = openFresh(dir, "queue.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1, { modelRequested: "m-codex", effort: null, role: "review" });
    seedHeld(bindings, P1, CX);
    const R = uid(960);
    const O = uid(961);
    const prompt = "Ship it.  \nUnicode: héllo ✓";
    const receipt = turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt });
    expect(receipt.created).toBe(true);
    expect(receipt.turn).toMatchObject({
      id: R,
      conversationId: CX,
      operationId: O,
      seq: 1,
      prompt,
      controller: "codex",
      modelRequested: "m-codex",
      role: "review",
      effort: null,
      claudeInputUuid: null,
      nativeTurnId: null,
      intentState: "queued",
      outcome: null,
      dispatchState: "queued",
      ownerGeneration: 1,
      hostGeneration: H1,
    });
    expect(receipt.turn.history).toEqual([{ kind: "queued", atMs: receipt.turn.createdAtMs }]);
    // Independent raw read-back confirms both rows committed together.
    expect(rawGet(file, "SELECT prompt_text, intent_state FROM turns WHERE id = ?", [R])).toMatchObject({
      prompt_text: prompt,
      intent_state: "queued",
    });
    const op = rawGet(file, "SELECT kind, state, owner_generation, host_generation FROM operations WHERE id = ?", [O]);
    expect(op).toMatchObject({ kind: "handoff", state: "queued", owner_generation: 1, host_generation: H1 });
    // A queued turn fabricates no native identity.
    expect(rawAll(file, "SELECT conversation_id FROM native_refs")).toEqual([]);
    // Second turn allocates seq 2.
    const R2 = uid(962);
    const receipt2 = turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: uid(963), prompt: "next" });
    expect(receipt2.turn.seq).toBe(2);
  });

  it("returns created:false on exact retry even after later states, with no writes", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "retry.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-retry", evidence: null,
    });
    const R = uid(970);
    const O = uid(971);
    const s = { ...scope(P1, CX), turnId: R, operationId: O, prompt: "retry me" };
    const first = turns.queueTurn(s);
    expect(first.created).toBe(true);
    turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: O });
    turns.recordWritten({ ...scope(P1, CX), turnId: R, operationId: O });
    const before = turns.getTurn({ projectId: P1, conversationId: CX, turnId: R });
    const again = turns.queueTurn(s);
    expect(again.created).toBe(false);
    expect(again.turn).toEqual(before);
    // No timestamp or journal change on the idempotent retry.
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R })).toEqual(before);
  });

  it("rejects changed payload, owner, generation, host, kind, and chat reuse", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "idem.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedCodex(records, CX2, P1);
    seedHeld(bindings, P1, CX);
    seedHeld(bindings, P1, CX2, T2);
    const R = uid(980);
    const O = uid(981);
    const s = { ...scope(P1, CX), turnId: R, operationId: O, prompt: "base" };
    turns.queueTurn(s);
    expectCode(() => turns.queueTurn({ ...s, prompt: "changed" }), "ERR_IDEMPOTENCY_CONFLICT");
    expectCode(() => turns.queueTurn({ ...s, turnId: uid(982) }), "ERR_IDEMPOTENCY_CONFLICT");
    expectCode(() => turns.queueTurn({ ...s, hostGeneration: H2 }), "ERR_IDEMPOTENCY_CONFLICT");
    // Same op id against another chat cannot be reused.
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX2, { ownerToken: T2 }), turnId: uid(983), operationId: O, prompt: "base" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Same turn id with a new op id is a record conflict, not idempotency.
    expectCode(
      () => turns.queueTurn({ ...s, operationId: uid(984) }),
      "ERR_RECORD_CONFLICT"
    );
    // A draft_save receipt id can never become a handoff id.
    const saveId = uid(985);
    records.saveDraft({ projectId: P1, conversationId: CX, saveId, expectedVersion: 0, text: "draft" });
    expectCode(
      () => turns.queueTurn({ ...s, turnId: uid(986), operationId: saveId, prompt: "base" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
  });

  it("enforces claude input UUID required/unique and codex null", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "input.sqlite3");
    seedProject(records, P1, "alpha");
    seedClaude(records, CL, P1);
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CL);
    seedHeld(bindings, P1, CX);
    // Claude requires a nonnull input UUID.
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CL), turnId: uid(990), operationId: uid(991), prompt: "hi" }),
      "ERR_INVALID_RECORD"
    );
    const first = turns.queueTurn({
      ...scope(P1, CL), turnId: uid(990), operationId: uid(991), prompt: "hi", claudeInputUuid: I1,
    });
    expect(first.turn.claudeInputUuid).toBe(I1);
    // Unique across turns, even in another conversation.
    seedClaude(records, CX2, P1);
    seedHeld(bindings, P1, CX2, T2);
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CL), turnId: uid(992), operationId: uid(993), prompt: "hi", claudeInputUuid: I1 }),
      "ERR_TURN_CONFLICT"
    );
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX2, { ownerToken: T2 }), turnId: uid(994), operationId: uid(995), prompt: "hi", claudeInputUuid: I1 }),
      "ERR_TURN_CONFLICT"
    );
    // Codex requires null.
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX), turnId: uid(996), operationId: uid(997), prompt: "hi", claudeInputUuid: I2 }),
      "ERR_INVALID_RECORD"
    );
  });

  it("resolves codex effort per turn and pins claude effort", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "effort.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1, { effort: null });
    seedClaude(records, CL, P1, { effort: "high" });
    seedHeld(bindings, P1, CX);
    seedHeld(bindings, P1, CL);
    const inherited = turns.queueTurn({ ...scope(P1, CX), turnId: uid(100), operationId: uid(101), prompt: "a" });
    expect(inherited.turn.effort).toBeNull();
    const perTurn = turns.queueTurn({ ...scope(P1, CX), turnId: uid(102), operationId: uid(103), prompt: "b", effort: "medium" });
    expect(perTurn.turn.effort).toBe("medium");
    const claudeSame = turns.queueTurn({
      ...scope(P1, CL), turnId: uid(104), operationId: uid(105), prompt: "c",
      claudeInputUuid: I1, effort: "high",
    });
    expect(claudeSame.turn.effort).toBe("high");
    const claudeInherited = turns.queueTurn({
      ...scope(P1, CL), turnId: uid(106), operationId: uid(107), prompt: "d", claudeInputUuid: I2,
    });
    expect(claudeInherited.turn.effort).toBe("high");
    expectCode(
      () => turns.queueTurn({
        ...scope(P1, CL), turnId: uid(108), operationId: uid(109), prompt: "e",
        claudeInputUuid: I3, effort: "low",
      }),
      "ERR_TURN_CONFLICT"
    );
  });

  it("lists metadata only, ordered by seq", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "list.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const ids = [uid(110), uid(111), uid(112)];
    ids.forEach((turnId, index) => {
      turns.queueTurn({ ...scope(P1, CX), turnId, operationId: uid(120 + index), prompt: `secret-${index}` });
    });
    const all = turns.listTurns({ projectId: P1, conversationId: CX });
    expect(all.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(all.map((row) => row.id)).toEqual(ids);
    for (const row of all) {
      expect(row).not.toHaveProperty("prompt");
      expect(row).not.toHaveProperty("history");
      expect(row.operationId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const page = turns.listTurns({ projectId: P1, conversationId: CX, limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].seq).toBe(2);
  });
});

describe("fences, proof, and provenance", () => {
  it("passes frozen live facts including hostGeneration and counts callbacks", () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "facts.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const seen = [];
    let calls = 0;
    const spied = createSessionTurns({
      store,
      verifyOwnerEvidence: (facts) => {
        calls += 1;
        seen.push(facts);
        return true;
      },
      now: makeClock(1900000000000),
    });
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-facts", evidence: null,
    });
    const R = uid(200);
    const O = uid(201);
    const s = { ...scope(P1, CX), turnId: R, operationId: O, prompt: "counted" };
    spied.queueTurn(s);
    spied.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: O });
    spied.recordWritten({ ...scope(P1, CX), turnId: R, operationId: O });
    spied.recordObserved({
      ...scope(P1, CX), turnId: R, operationId: O,
      nativeFact: { nativeIdentity: "thr-facts", nativeTurnId: "nt-1", claudeInputUuid: null },
    });
    spied.settleTurn({
      ...scope(P1, CX), turnId: R, operationId: O, outcome: "completed",
      nativeFact: { nativeIdentity: "thr-facts", nativeTurnId: "nt-1", claudeInputUuid: null },
    });
    // One proof evaluation per mutation.
    expect(calls).toBe(5);
    expect(seen).toHaveLength(5);
    for (const facts of seen) {
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.keys(facts).sort()).toEqual([
        "action",
        "conversationId",
        "evidence",
        "generation",
        "hostGeneration",
        "ownerToken",
        "projectId",
      ]);
      expect(facts).toMatchObject({
        action: "live",
        projectId: P1,
        conversationId: CX,
        ownerToken: T1,
        generation: 1,
        hostGeneration: H1,
      });
    }
  });

  it("rejects wrong hostGeneration, stale owners, and a second connection takeover", () => {
    const dir = tempDir();
    const { file, turns, records, bindings } = openFresh(dir, "takeover.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const R = uid(210);
    const O = uid(211);
    turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt: "held" });
    // Same generation but a different host UUID is not the owning provenance.
    expectCode(
      () => turns.beginDispatch({ ...scope(P1, CX, { hostGeneration: H2 }), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    // Hand the fence to a new owner through the bindings API (release + reclaim).
    bindings.settleProducer({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1, state: "released", evidence: null,
    });
    bindings.claimProducer({
      projectId: P1, conversationId: CX, ownerToken: T2, expectedGeneration: 1, evidence: null,
    });
    const peer = openSecondTurns(file);
    // The old owner cannot write after the fence moved, via either connection.
    expectCode(
      () => turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    expectCode(
      () => peer.turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: O }),
      "ERR_FENCE_CONFLICT"
    );
    // The new owner cannot adopt the old owner's pending turn either.
    expectCode(
      () => peer.turns.beginDispatch({
        ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2, hostGeneration: H2 }),
        turnId: R,
        operationId: O,
      }),
      "ERR_FENCE_CONFLICT"
    );
    // But the new owner queues fresh turns fine.
    const fresh = peer.turns.queueTurn({
      ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2, hostGeneration: H2 }),
      turnId: uid(212),
      operationId: uid(213),
      prompt: "new owner",
    });
    expect(fresh.created).toBe(true);
    expect(fresh.turn.ownerGeneration).toBe(2);
    expect(fresh.turn.hostGeneration).toBe(H2);
  });

  it("denies false, non-boolean, throwing, and async proofs without echo", async () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "proof.sqlite3");
    seedProject(records, P1, "alpha");
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
      const conversationId = uid(220 + index);
      seedCodex(records, conversationId, P1);
      seedHeld(bindings, P1, conversationId);
      const turns = createSessionTurns({ store, verifyOwnerEvidence, now: makeClock() });
      const error = expectCode(
        () =>
          turns.queueTurn({
            ...scope(P1, conversationId), turnId: uid(240 + index), operationId: uid(250 + index), prompt: "hi",
          }),
        "ERR_OWNER_UNVERIFIED"
      );
      expect(String(error.message)).not.toContain("s3cr3t");
      expect(String(error.message)).not.toContain(label === "throw" ? "proof-boom" : "definitely-absent-marker-zz");
    }
    // Let any consumed async rejection settle: none may escape unhandled.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rawAll(dbPath(dir, "proof.sqlite3"), "SELECT id FROM turns")).toEqual([]);
  });

  it("authorizes the producer helper directly with strict-true only", async () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "authorizer.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const authorizer = createProducerAuthorizer({ verifyOwnerEvidence: strictTrue });
    expect(Object.isFrozen(authorizer)).toBe(true);
    expectCode(() => createProducerAuthorizer(), "ERR_INVALID_RECORD");
    expectCode(() => createProducerAuthorizer({ verifyOwnerEvidence: false }), "ERR_INVALID_RECORD");
    const ok = store.transaction((tx) =>
      authorizer.authorizeLiveWrite(tx, scope(P1, CX))
    );
    expect(ok).toMatchObject({ projectId: P1, conversationId: CX, ownerToken: T1, generation: 1, hostGeneration: H1 });
    const denier = createProducerAuthorizer({ verifyOwnerEvidence: strictFalse });
    expectCode(
      () => store.transaction((tx) => denier.authorizeLiveWrite(tx, scope(P1, CX))),
      "ERR_OWNER_UNVERIFIED"
    );
    const asyncer = createProducerAuthorizer({ verifyOwnerEvidence: () => Promise.resolve(true) });
    expectCode(
      () => store.transaction((tx) => asyncer.authorizeLiveWrite(tx, scope(P1, CX))),
      "ERR_OWNER_UNVERIFIED"
    );
    await new Promise((resolve) => setImmediate(resolve));
    // A scope for another conversation is not authorized by this fence.
    expectCode(
      () => store.transaction((tx) => authorizer.authorizeLiveWrite(tx, scope(P1, uid(260)))),
      "ERR_NOT_FOUND"
    );
  });
});

describe("dispatch journal", () => {
  function seedCodexFlow(dir, name, threadId = "thr-journal") {
    const ctx = openFresh(dir, name);
    seedProject(ctx.records, P1, "alpha");
    seedCodex(ctx.records, CX, P1);
    seedHeld(ctx.bindings, P1, CX);
    ctx.bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: threadId, evidence: null,
    });
    return ctx;
  }

  it("begins dispatch once; the intent stays queued until a write fact", () => {
    const dir = tempDir();
    const { turns } = seedCodexFlow(dir, "begin.sqlite3");
    const R = uid(300);
    const O = uid(301);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...s, prompt: "dispatch once" });
    // No provider effect may precede begin: writing first rejects.
    expectCode(() => turns.recordWritten(s), "ERR_TURN_STATE");
    const begun = turns.beginDispatch(s);
    expect(begun.intentState).toBe("queued");
    expect(begun.dispatchState).toBe("dispatching");
    expect(begun.history.map((entry) => entry.kind)).toEqual(["queued", "dispatching"]);
    // A repeated begin is never permission to send again.
    expectCode(() => turns.beginDispatch(s), "ERR_DISPATCH_CONFLICT");
    expectCode(() => turns.beginDispatch(s), "ERR_DISPATCH_CONFLICT");
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).history).toHaveLength(2);
  });

  it("allows observed-before-written; late written never regresses and stays bounded", () => {
    const dir = tempDir();
    const { turns } = seedCodexFlow(dir, "latewrite.sqlite3");
    const R = uid(310);
    const O = uid(311);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    const fact = { nativeIdentity: "thr-journal", nativeTurnId: "nt-early", claudeInputUuid: null };
    turns.queueTurn({ ...s, prompt: "early observation" });
    turns.beginDispatch(s);
    const observed = turns.recordObserved({ ...s, nativeFact: fact });
    expect(observed.intentState).toBe("observed");
    expect(observed.dispatchState).toBe("observed");
    expect(observed.nativeTurnId).toBe("nt-early");
    // The late transport write appends its fact without regressing state.
    const afterWrite = turns.recordWritten(s);
    expect(afterWrite.intentState).toBe("observed");
    expect(afterWrite.dispatchState).toBe("observed");
    expect(afterWrite.history.map((entry) => entry.kind).sort()).toEqual(
      ["dispatching", "observed", "queued", "written"].sort()
    );
    const historyLen = afterWrite.history.length;
    // Duplicates add no history and touch no timestamps.
    expect(turns.recordWritten(s)).toEqual(afterWrite);
    expect(turns.recordObserved({ ...s, nativeFact: fact })).toEqual(afterWrite);
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).history).toHaveLength(historyLen);
  });

  it("drives a claude turn from requested UUID to terminal without invented refs", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "claude.sqlite3");
    seedProject(records, P1, "alpha");
    seedClaude(records, CL, P1, { modelRequested: "claude-m", effort: "high" });
    seedHeld(bindings, P1, CL);
    bindings.setRequestedClaudeSession({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, sessionUuid: UREQ, evidence: null,
    });
    const R = uid(320);
    const O = uid(321);
    const s = { ...scope(P1, CL), turnId: R, operationId: O };
    const fact = { nativeIdentity: UREQ, nativeTurnId: null, claudeInputUuid: I1 };
    const queued = turns.queueTurn({ ...s, prompt: "claude turn", claudeInputUuid: I1 });
    expect(queued.turn.nativeTurnId).toBeNull();
    turns.beginDispatch(s);
    // Stream init may still be pending: written is allowed on the requested
    // prelaunch UUID alone, and invents no association.
    const written = turns.recordWritten(s);
    expect(written.intentState).toBe("written");
    expect(written.nativeTurnId).toBeNull();
    bindings.bindNativeRef({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1,
      controller: "claude", nativeSessionUuid: UREQ, evidence: null,
    });
    const observed = turns.recordObserved({ ...s, nativeFact: fact });
    expect(observed.intentState).toBe("observed");
    const terminal = turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact });
    expect(terminal).toMatchObject({
      intentState: "completed",
      outcome: "completed",
      dispatchState: "completed",
      nativeTurnId: null,
      claudeInputUuid: I1,
    });
    expect(terminal.history.map((entry) => entry.kind)).toEqual(
      ["queued", "dispatching", "written", "observed", "terminal"]
    );
    expect(terminal.settledAtMs).not.toBeNull();
  });

  it("rejects wrong session, thread, turn, and input correlation", () => {
    const dir = tempDir();
    const { turns } = seedCodexFlow(dir, "wrong.sqlite3", "thr-right");
    const R = uid(330);
    const O = uid(331);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...s, prompt: "correlation" });
    turns.beginDispatch(s);
    expectCode(
      () => turns.recordObserved({ ...s, nativeFact: { nativeIdentity: "thr-wrong", nativeTurnId: "nt-1", claudeInputUuid: null } }),
      "ERR_TURN_CONFLICT"
    );
    expectCode(
      () => turns.recordObserved({ ...s, nativeFact: { nativeIdentity: "thr-right", nativeTurnId: "", claudeInputUuid: null } }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => turns.recordObserved({ ...s, nativeFact: { nativeIdentity: "thr-right", nativeTurnId: "nt-1", claudeInputUuid: I1 } }),
      "ERR_INVALID_RECORD"
    );
    const seen = turns.recordObserved({
      ...s, nativeFact: { nativeIdentity: "thr-right", nativeTurnId: "nt-1", claudeInputUuid: null },
    });
    expect(seen.nativeTurnId).toBe("nt-1");
    // The bound native turn id is immutable.
    expectCode(
      () => turns.recordObserved({
        ...s, nativeFact: { nativeIdentity: "thr-right", nativeTurnId: "nt-2", claudeInputUuid: null },
      }),
      "ERR_TURN_CONFLICT"
    );
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).nativeTurnId).toBe("nt-1");
  });

  it("requires the codex bound thread before written, and claude requested UUID", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "readiness.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedClaude(records, CL, P1);
    seedHeld(bindings, P1, CX);
    seedHeld(bindings, P1, CL);
    const RX = uid(340);
    const OX = uid(341);
    turns.queueTurn({ ...scope(P1, CX), turnId: RX, operationId: OX, prompt: "unbound" });
    turns.beginDispatch({ ...scope(P1, CX), turnId: RX, operationId: OX });
    // S3 has not committed the Codex thread ref yet: no transport fact.
    expectCode(
      () => turns.recordWritten({ ...scope(P1, CX), turnId: RX, operationId: OX }),
      "ERR_TURN_CONFLICT"
    );
    const RL = uid(342);
    const OL = uid(343);
    turns.queueTurn({ ...scope(P1, CL), turnId: RL, operationId: OL, prompt: "unrequested", claudeInputUuid: I1 });
    turns.beginDispatch({ ...scope(P1, CL), turnId: RL, operationId: OL });
    // No prelaunch request persisted: no transport fact.
    expectCode(
      () => turns.recordWritten({ ...scope(P1, CL), turnId: RL, operationId: OL }),
      "ERR_TURN_CONFLICT"
    );
    expectCode(
      () => turns.recordObserved({
        ...scope(P1, CL), turnId: RL, operationId: OL,
        nativeFact: { nativeIdentity: UREQ, nativeTurnId: null, claudeInputUuid: I1 },
      }),
      "ERR_TURN_CONFLICT"
    );
  });
});

describe("terminal settlement", () => {
  it("settles completed before the separate observed callback and binds the turn id", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "fastsettle.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-fast", evidence: null,
    });
    const R = uid(400);
    const O = uid(401);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    const fact = { nativeIdentity: "thr-fast", nativeTurnId: "nt-fast", claudeInputUuid: null };
    turns.queueTurn({ ...s, prompt: "fast outcome" });
    // Outcomes require dispatch; settling a merely queued turn rejects.
    expectCode(() => turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact }), "ERR_TURN_STATE");
    expectCode(() => turns.settleTurn({ ...s, outcome: "completed" }), "ERR_TURN_STATE");
    turns.beginDispatch(s);
    expectCode(() => turns.settleTurn({ ...s, outcome: "completed" }), "ERR_TURN_CONFLICT");
    expectCode(() => turns.settleTurn({ ...s, outcome: "interrupted" }), "ERR_TURN_CONFLICT");
    const terminal = turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact });
    expect(terminal).toMatchObject({
      intentState: "completed",
      outcome: "completed",
      dispatchState: "completed",
      nativeTurnId: "nt-fast",
    });
    expect(terminal.history.map((entry) => entry.kind)).toEqual(
      ["queued", "dispatching", "terminal"]
    );
    // Exact terminal retry returns the unchanged record and history.
    const historyLen = terminal.history.length;
    expect(turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact })).toEqual(terminal);
    // A completed terminal retry without its fact is never exact.
    expectCode(() => turns.settleTurn({ ...s, outcome: "completed" }), "ERR_TURN_CONFLICT");
    // A new fact is never compatible with the stored receipt's tuple.
    expectCode(
      () => turns.settleTurn({
        ...s, outcome: "completed",
        nativeFact: { nativeIdentity: "thr-fast", nativeTurnId: "nt-fresh", claudeInputUuid: null },
      }),
      "ERR_TURN_CONFLICT"
    );
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).history).toHaveLength(historyLen);
    // A conflicting terminal outcome or id rejects; terminal rows never move.
    expectCode(() => turns.settleTurn({ ...s, outcome: "failed", nativeFact: fact }), "ERR_TURN_CONFLICT");
    expectCode(
      () => turns.settleTurn({
        ...s, outcome: "completed",
        nativeFact: { nativeIdentity: "thr-fast", nativeTurnId: "nt-other", claudeInputUuid: null },
      }),
      "ERR_TURN_CONFLICT"
    );
    // A repeated begin is always a dispatch conflict, even after terminal.
    expectCode(() => turns.beginDispatch(s), "ERR_DISPATCH_CONFLICT");
    expectCode(() => turns.recordWritten(s), "ERR_TURN_STATE");
    expectCode(() => turns.recordObserved({ ...s, nativeFact: fact }), "ERR_TURN_STATE");
  });

  it("allows failed-before-dispatch without a fact, requires it after, and keeps unknown terminal", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "failunk.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-fu", evidence: null,
    });
    const fact = { nativeIdentity: "thr-fu", nativeTurnId: "nt-fu", claudeInputUuid: null };
    // Pre-dispatch failure carries no native fact.
    const R2 = uid(412);
    const O2 = uid(413);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: O2, prompt: "pre-dispatch failure" });
    const terminal = turns.settleTurn({ ...scope(P1, CX), turnId: R2, operationId: O2, outcome: "failed" });
    expect(terminal).toMatchObject({ intentState: "failed", outcome: "failed", dispatchState: "failed" });
    // Post-dispatch failure without a fact means the host must use unknown.
    const R3 = uid(414);
    const O3 = uid(415);
    const s3 = { ...scope(P1, CX), turnId: R3, operationId: O3 };
    turns.queueTurn({ ...s3, prompt: "post-dispatch failure" });
    turns.beginDispatch(s3);
    expectCode(() => turns.settleTurn({ ...s3, outcome: "failed" }), "ERR_TURN_CONFLICT");
    expect(turns.settleTurn({ ...s3, outcome: "failed", nativeFact: fact })).toMatchObject({ outcome: "failed" });
    // Unknown from a nonterminal state stays terminal and never requeues.
    const R4 = uid(416);
    const O4 = uid(417);
    const s4 = { ...scope(P1, CX), turnId: R4, operationId: O4 };
    turns.queueTurn({ ...s4, prompt: "unknown fate" });
    const unknown = turns.settleTurn({ ...s4, outcome: "unknown" });
    expect(unknown).toMatchObject({ intentState: "unknown", outcome: "unknown", dispatchState: "unknown" });
    expectCode(() => turns.settleTurn({ ...s4, outcome: "completed", nativeFact: fact }), "ERR_TURN_CONFLICT");
    expectCode(() => turns.beginDispatch(s4), "ERR_DISPATCH_CONFLICT");
  });
});

describe("stored corruption, atomicity, overflow, and composition", () => {
  function seedQueued(dir, name) {
    const ctx = openFresh(dir, name);
    seedProject(ctx.records, P1, "alpha");
    seedCodex(ctx.records, CX, P1);
    seedHeld(ctx.bindings, P1, CX);
    const R = uid(500);
    const O = uid(501);
    ctx.turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt: "seeded" });
    return { ...ctx, R, O };
  }

  it("rejects malformed journals, provenance, and pairs as ERR_STORAGE", () => {
    const dir = tempDir();
    const { file, store, turns, R, O } = seedQueued(dir, "malformed.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    expect(turns.getTurn(key)).not.toBeNull();
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ? WHERE id = ?", ["not json", O]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ?, result_json = ? WHERE id = ?", [
        JSON.stringify([{ kind: "queued", atMs: 1 }]),
        JSON.stringify({ v: 1, kind: "queue", hash: "mismatch" }),
        O,
      ]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    store.transaction((tx) => {
      tx.run("UPDATE operations SET host_generation = ? WHERE id = ?", ["bad-host", O]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    expect(file.endsWith(".sqlite3")).toBe(true);
  });

  it("rejects a missing or duplicated handoff pair as ERR_STORAGE", () => {
    const dir = tempDir();
    const { store, turns, R, O } = seedQueued(dir, "pair.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    // An imported-style turn row without any operation pair is unreadable here.
    store.transaction((tx) => {
      tx.run("DELETE FROM operations WHERE id = ?", [O]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX }), "ERR_STORAGE");
    // Two handoff operations naming the same turn are equally unreadable.
    const R2 = uid(502);
    const O2 = uid(503);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: O2, prompt: "second" });
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'handoff', 1, ?, 'queued', ?, ?, ?, ?, NULL)",
        [
          uid(504),
          CX,
          R2,
          H1,
          JSON.stringify([{ kind: "queued", atMs: 1 }]),
          "probe-hash",
          JSON.stringify({ v: 1, kind: "queue", hash: "probe-hash" }),
          1,
        ]
      );
    });
    expectCode(
      () => turns.getTurn({ projectId: P1, conversationId: CX, turnId: R2 }),
      "ERR_STORAGE"
    );
  });

  it("rolls back queue, transition, outcome, and history atomically under trigger ABORT", () => {
    const dir = tempDir();
    const { file, store, turns, records, bindings } = openFresh(dir, "abort.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    store.transaction((tx) => {
      tx.run(
        "CREATE TRIGGER cho_probe_abort AFTER INSERT ON operations BEGIN SELECT RAISE(ABORT, 'probe'); END",
        []
      );
    });
    const R = uid(510);
    const O = uid(511);
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt: "aborted" }),
      "ERR_STORAGE"
    );
    // The turn side rolled back with the aborted operation insert.
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R })).toBeNull();
    expect(rawAll(file, "SELECT id FROM turns WHERE id = ?", [R])).toEqual([]);
    // Drop the fixture trigger before reopen (the S1 expected manifest
    // admits no extra objects), then the same queue succeeds.
    store.transaction((tx) => {
      tx.run("DROP TRIGGER cho_probe_abort", []);
    });
    const receipt = turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt: "aborted" });
    expect(receipt.created).toBe(true);
    // UPDATE coverage: bind the Codex ref, admit dispatch, queue a second
    // turn, then abort every UPDATE on operations.
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-abort", evidence: null,
    });
    turns.beginDispatch({ ...scope(P1, CX), turnId: R, operationId: O });
    const R2 = uid(512);
    const O2 = uid(513);
    turns.queueTurn({ ...scope(P1, CX), turnId: R2, operationId: O2, prompt: "second" });
    const beforeDispatch = turns.getTurn({ projectId: P1, conversationId: CX, turnId: R2 });
    const beforeSettle = turns.getTurn({ projectId: P1, conversationId: CX, turnId: R });
    const rawTurnBefore = rawGet(file, "SELECT intent_state, outcome, native_turn_id FROM turns WHERE id = ?", [R]);
    const rawOpBefore = rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O]);
    store.transaction((tx) => {
      tx.run(
        "CREATE TRIGGER cho_probe_abort_update AFTER UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'probe'); END",
        []
      );
    });
    // Transition UPDATE aborts atomically: the queued pair is unchanged.
    expectCode(
      () => turns.beginDispatch({ ...scope(P1, CX), turnId: R2, operationId: O2 }),
      "ERR_STORAGE"
    );
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R2 })).toEqual(beforeDispatch);
    // Settle updates turns first, then operations: the trigger failure
    // rolls back turn outcome/nativeTurnId plus op receipt/history/settled.
    const fact = { nativeIdentity: "thr-abort", nativeTurnId: "nt-abort", claudeInputUuid: null };
    expectCode(
      () => turns.settleTurn({ ...scope(P1, CX), turnId: R, operationId: O, outcome: "completed", nativeFact: fact }),
      "ERR_STORAGE"
    );
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R })).toEqual(beforeSettle);
    expect(rawGet(file, "SELECT intent_state, outcome, native_turn_id FROM turns WHERE id = ?", [R])).toEqual(rawTurnBefore);
    expect(rawGet(file, "SELECT state, history_json, result_json, settled_at_ms FROM operations WHERE id = ?", [O])).toEqual(rawOpBefore);
    // Drop the UPDATE trigger (manifest admits no extra objects); the same
    // settle then succeeds.
    store.transaction((tx) => {
      tx.run("DROP TRIGGER cho_probe_abort_update", []);
    });
    const terminal = turns.settleTurn({ ...scope(P1, CX), turnId: R, operationId: O, outcome: "completed", nativeFact: fact });
    expect(terminal.outcome).toBe("completed");
    expect(terminal.nativeTurnId).toBe("nt-abort");
  });

  it("rejects sequence overflow with ERR_VERSION_LIMIT", () => {
    const dir = tempDir();
    const { store, turns, records, bindings } = openFresh(dir, "overflow.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    turns.queueTurn({ ...scope(P1, CX), turnId: uid(520), operationId: uid(521), prompt: "first" });
    store.transaction((tx) => {
      tx.run("UPDATE turns SET seq = ? WHERE conversation_id = ?", [Number.MAX_SAFE_INTEGER, CX]);
    });
    expectCode(
      () => turns.queueTurn({ ...scope(P1, CX), turnId: uid(522), operationId: uid(523), prompt: "overflow" }),
      "ERR_VERSION_LIMIT"
    );
  });

  it("maps a throwing clock to ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "clock.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const broken = createSessionTurns({
      store,
      verifyOwnerEvidence: strictTrue,
      now: () => { throw new Error("clock boom"); },
    });
    expectCode(
      () => broken.queueTurn({ ...scope(P1, CX), turnId: uid(530), operationId: uid(531), prompt: "hi" }),
      "ERR_INVALID_RECORD"
    );
    const negative = createSessionTurns({ store, verifyOwnerEvidence: strictTrue, now: () => -1 });
    expectCode(
      () => negative.queueTurn({ ...scope(P1, CX), turnId: uid(532), operationId: uid(533), prompt: "hi" }),
      "ERR_INVALID_RECORD"
    );
  });

  it("composes turn transitions in an outer transaction and rolls back together", () => {
    const dir = tempDir();
    const { file, store, turns, records, bindings } = openFresh(dir, "compose.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-compose", evidence: null,
    });
    const R = uid(540);
    const O = uid(541);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    const fact = { nativeIdentity: "thr-compose", nativeTurnId: "nt-compose", claudeInputUuid: null };
    // A caller failure after queue + begin rolls back the whole outer write.
    expect(() =>
      store.transaction((tx) => {
        const inner = turns.inTransaction(tx);
        inner.queueTurn({ ...s, prompt: "composed" });
        inner.beginDispatch(s);
        throw new Error("outer probe");
      })
    ).toThrow("outer probe");
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R })).toBeNull();
    expect(rawAll(file, "SELECT id FROM turns")).toEqual([]);
    // The same composition commits when the outer callback succeeds.
    store.transaction((tx) => {
      const inner = turns.inTransaction(tx);
      expect(Object.isFrozen(inner)).toBe(true);
      const receipt = inner.queueTurn({ ...s, prompt: "composed" });
      expect(receipt.created).toBe(true);
      const begun = inner.beginDispatch(s);
      expect(begun.dispatchState).toBe("dispatching");
      const written = inner.recordWritten(s);
      expect(written.intentState).toBe("written");
      const observed = inner.recordObserved({ ...s, nativeFact: fact });
      expect(observed.nativeTurnId).toBe("nt-compose");
      const terminal = inner.settleTurn({ ...s, outcome: "interrupted", nativeFact: fact });
      expect(terminal.outcome).toBe("interrupted");
      expect(inner.getTurn({ projectId: P1, conversationId: CX, turnId: R }).seq).toBe(1);
      expect(inner.listTurns({ projectId: P1, conversationId: CX })).toHaveLength(1);
    });
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).outcome).toBe("interrupted");
  });

  it("rejects foreign, escaped, and nested transaction use", () => {
    const dir = tempDir();
    const { store, turns, records, bindings } = openFresh(dir, "lineage.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    const otherFile = dbPath(dir, "other.sqlite3");
    const other = openSessionStore({ databasePath: otherFile });
    stores.push(other);
    // A scoped tx from another store lineage is not trusted composition.
    other.transaction((otherTx) => {
      expectCode(() => turns.inTransaction(otherTx), "ERR_STORAGE");
    });
    // An escaped handle from a finished transaction is expired.
    let escaped;
    store.transaction((tx) => {
      escaped = turns.inTransaction(tx);
    });
    expectCode(
      () => escaped.getTurn({ projectId: P1, conversationId: CX, turnId: uid(550) }),
      "ERR_INVALID_TX"
    );
    // Wrapper calls never nest inside an active transaction.
    expectCode(
      () =>
        store.transaction(() =>
          turns.queueTurn({ ...scope(P1, CX), turnId: uid(551), operationId: uid(552), prompt: "nested" })
        ),
      "ERR_INVALID_TX"
    );
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: uid(551) })).toBeNull();
  });
});

describe("handoff pairing with non-handoff siblings", () => {
  function seedCodexFlow(dir, name, threadId) {
    const ctx = openFresh(dir, name);
    seedProject(ctx.records, P1, "alpha");
    seedCodex(ctx.records, CX, P1);
    seedHeld(ctx.bindings, P1, CX);
    ctx.bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: threadId, evidence: null,
    });
    return ctx;
  }

  it("ignores a valid stop sibling but rejects a second handoff pair", () => {
    const dir = tempDir();
    const { file, store, turns } = seedCodexFlow(dir, "siblings.sqlite3", "thr-sib");
    const R = uid(600);
    const O = uid(601);
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...s, prompt: "with sibling" });
    // A real stop operation on the SAME turn: preserved, never counted.
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'stop', 1, NULL, 'completed', '[]', NULL, NULL, ?, NULL)",
        [uid(602), CX, R, 1]
      );
    });
    // Reads and transitions still work with the stop sibling present.
    expect(turns.getTurn({ projectId: P1, conversationId: CX, turnId: R }).operationId).toBe(O);
    expect(turns.listTurns({ projectId: P1, conversationId: CX })).toHaveLength(1);
    turns.beginDispatch(s);
    // A second HANDOFF pair breaks reads and mutations alike: the provided
    // op id is never silently honored over the duplicate.
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, ?, 'handoff', 1, ?, 'queued', ?, ?, ?, ?, NULL)",
        [
          uid(603),
          CX,
          R,
          H1,
          JSON.stringify([{ kind: "queued", atMs: 1 }]),
          "probe-hash",
          JSON.stringify({ v: 1, kind: "queue", hash: "probe-hash" }),
          1,
        ]
      );
    });
    const key = { projectId: P1, conversationId: CX, turnId: R };
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX }), "ERR_STORAGE");
    expectCode(() => turns.recordWritten(s), "ERR_STORAGE");
    expectCode(() => turns.settleTurn({ ...s, outcome: "unknown" }), "ERR_STORAGE");
    // No sibling was deleted.
    expect(
      rawAll(file, "SELECT kind FROM operations WHERE turn_id = ?", [R])
        .map((row) => row.kind)
        .sort()
    ).toEqual(["handoff", "handoff", "stop"]);
  });
});

describe("stored state and journal validation", () => {
  function seedQueued(dir, name) {
    const ctx = openFresh(dir, name);
    seedProject(ctx.records, P1, "alpha");
    seedCodex(ctx.records, CX, P1);
    seedHeld(ctx.bindings, P1, CX);
    ctx.bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-malformed", evidence: null,
    });
    const R = uid(610);
    const O = uid(611);
    ctx.turns.queueTurn({ ...scope(P1, CX), turnId: R, operationId: O, prompt: "seeded" });
    return { ...ctx, R, O };
  }

  it("rejects terminal op state with a null turn outcome", () => {
    const dir = tempDir();
    const { store, turns, R, O } = seedQueued(dir, "badstate.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    expect(turns.getTurn(key)).not.toBeNull();
    store.transaction((tx) => {
      tx.run("UPDATE operations SET state = ? WHERE id = ?", ["completed", O]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    expectCode(() => turns.listTurns({ projectId: P1, conversationId: CX }), "ERR_STORAGE");
  });

  it("rejects journals with invalid causal order", () => {
    const dir = tempDir();
    const { store, turns, R, O } = seedQueued(dir, "badorder.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    // Written without a preceding dispatching fact.
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ? WHERE id = ?", [
        JSON.stringify([
          { kind: "queued", atMs: 1 },
          { kind: "written", atMs: 2 },
        ]),
        O,
      ]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    // Queued must be first.
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ? WHERE id = ?", [
        JSON.stringify([
          { kind: "dispatching", atMs: 2 },
          { kind: "queued", atMs: 1 },
        ]),
        O,
      ]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
  });

  it("rejects a terminal fact that is not last", () => {
    const dir = tempDir();
    const { store, turns, R, O } = seedQueued(dir, "badterminal.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    const fact = { nativeIdentity: "thr-malformed", nativeTurnId: "nt-1", claudeInputUuid: null };
    const s = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.beginDispatch(s);
    turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact });
    const history = turns.getTurn(key).history;
    const terminal = history.find((entry) => entry.kind === "terminal");
    const rest = history.filter((entry) => entry.kind !== "terminal");
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ? WHERE id = ?", [
        JSON.stringify([rest[0], terminal, ...rest.slice(1)]),
        O,
      ]);
    });
    expectCode(() => turns.getTurn(key), "ERR_STORAGE");
  });

  it("caps journal bytes before parsing and never echoes raw content", () => {
    const dir = tempDir();
    const { store, turns, R, O } = seedQueued(dir, "bigjournal.sqlite3");
    const key = { projectId: P1, conversationId: CX, turnId: R };
    const marker = "definitely-absent-marker-zz-pad";
    store.transaction((tx) => {
      tx.run("UPDATE operations SET history_json = ? WHERE id = ?", [
        JSON.stringify([{ kind: "queued", atMs: 1, pad: marker + "x".repeat(9000) }]),
        O,
      ]);
    });
    const error = expectCode(() => turns.getTurn(key), "ERR_STORAGE");
    expect(String(error.message)).not.toContain(marker);
  });
});

describe("terminal retry facts and pagination", () => {
  function seedCodexFlow(dir, name, threadId) {
    const ctx = openFresh(dir, name);
    seedProject(ctx.records, P1, "alpha");
    seedCodex(ctx.records, CX, P1);
    seedHeld(ctx.bindings, P1, CX);
    ctx.bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: threadId, evidence: null,
    });
    return ctx;
  }

  it("rejects null pagination and inexact terminal replays", () => {
    const dir = tempDir();
    const { turns } = seedCodexFlow(dir, "replay.sqlite3", "thr-replay");
    expectCode(
      () => turns.listTurns({ projectId: P1, conversationId: CX, limit: null }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => turns.listTurns({ projectId: P1, conversationId: CX, offset: null }),
      "ERR_INVALID_RECORD"
    );
    const fact = { nativeIdentity: "thr-replay", nativeTurnId: "nt-r", claudeInputUuid: null };
    // A factless pre-dispatch failure replays factless only.
    const R2 = uid(622);
    const O2 = uid(623);
    const s2 = { ...scope(P1, CX), turnId: R2, operationId: O2 };
    turns.queueTurn({ ...s2, prompt: "pre-dispatch failure" });
    const failed = turns.settleTurn({ ...s2, outcome: "failed" });
    expect(turns.settleTurn({ ...s2, outcome: "failed" })).toEqual(failed);
    // A new fact is never compatible with a factless original receipt.
    expectCode(() => turns.settleTurn({ ...s2, outcome: "failed", nativeFact: fact }), "ERR_TURN_CONFLICT");
    // A post-dispatch failure with a fact cannot be retried without it.
    const R3 = uid(624);
    const O3 = uid(625);
    const s3 = { ...scope(P1, CX), turnId: R3, operationId: O3 };
    turns.queueTurn({ ...s3, prompt: "post-dispatch failure" });
    turns.beginDispatch(s3);
    const failedAfter = turns.settleTurn({ ...s3, outcome: "failed", nativeFact: fact });
    expectCode(() => turns.settleTurn({ ...s3, outcome: "failed" }), "ERR_TURN_CONFLICT");
    expect(turns.settleTurn({ ...s3, outcome: "failed", nativeFact: fact })).toEqual(failedAfter);
    // A factless unknown replays factless only.
    const R4 = uid(626);
    const O4 = uid(627);
    const s4 = { ...scope(P1, CX), turnId: R4, operationId: O4 };
    turns.queueTurn({ ...s4, prompt: "unknown fate" });
    const unknown = turns.settleTurn({ ...s4, outcome: "unknown" });
    expect(turns.settleTurn({ ...s4, outcome: "unknown" })).toEqual(unknown);
    expectCode(() => turns.settleTurn({ ...s4, outcome: "unknown", nativeFact: fact }), "ERR_TURN_CONFLICT");
  });

  it("rejects claude terminal facts without a persisted observed ref", () => {
    const dir = tempDir();
    const { turns, records, bindings } = openFresh(dir, "claudeterm.sqlite3");
    seedProject(records, P1, "alpha");
    seedClaude(records, CL, P1);
    seedHeld(bindings, P1, CL);
    bindings.setRequestedClaudeSession({
      projectId: P1, conversationId: CL, ownerToken: T1, generation: 1, sessionUuid: UREQ, evidence: null,
    });
    const R = uid(630);
    const O = uid(631);
    const s = { ...scope(P1, CL), turnId: R, operationId: O };
    const fact = { nativeIdentity: UREQ, nativeTurnId: null, claudeInputUuid: I1 };
    turns.queueTurn({ ...s, prompt: "claude turn", claudeInputUuid: I1 });
    turns.beginDispatch(s);
    // The positive case is preserved: written works on the requested UUID
    // alone while the observed ref is still absent.
    expect(turns.recordWritten(s).intentState).toBe("written");
    // Requested-only identity never suffices for a terminal fact.
    expectCode(() => turns.settleTurn({ ...s, outcome: "completed", nativeFact: fact }), "ERR_TURN_CONFLICT");
    expectCode(() => turns.settleTurn({ ...s, outcome: "interrupted", nativeFact: fact }), "ERR_TURN_CONFLICT");
    expectCode(() => turns.settleTurn({ ...s, outcome: "failed" }), "ERR_TURN_CONFLICT");
    // A factless unknown still settles and replays exactly.
    const unknown = turns.settleTurn({ ...s, outcome: "unknown" });
    expect(turns.settleTurn({ ...s, outcome: "unknown" })).toEqual(unknown);
  });
});

describe("current-owner provenance on another owner's journal", () => {
  it("rejects a new current owner and a mismatched host, with journals unchanged", () => {
    const dir = tempDir();
    const { file, turns, records, bindings } = openFresh(dir, "g2prov.sqlite3");
    seedProject(records, P1, "alpha");
    seedCodex(records, CX, P1);
    seedHeld(bindings, P1, CX);
    bindings.bindNativeRef({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1,
      controller: "codex", nativeThreadId: "thr-g2prov", evidence: null,
    });
    const fact = { nativeIdentity: "thr-g2prov", nativeTurnId: "nt-g2", claudeInputUuid: null };
    const R = uid(640);
    const O = uid(641);
    const s1 = { ...scope(P1, CX), turnId: R, operationId: O };
    turns.queueTurn({ ...s1, prompt: "g1 journal" });
    turns.beginDispatch(s1);
    // A completed terminal turn whose exact replay must still check provenance.
    const R2 = uid(642);
    const O2 = uid(643);
    const s2 = { ...scope(P1, CX), turnId: R2, operationId: O2 };
    turns.queueTurn({ ...s2, prompt: "g1 terminal" });
    turns.beginDispatch(s2);
    turns.settleTurn({ ...s2, outcome: "completed", nativeFact: fact });
    // Same g1 generation but a different host generation is not the owning
    // provenance, even with the trusted true verifier.
    expectCode(
      () => turns.recordWritten({ ...s1, hostGeneration: H2 }),
      "ERR_FENCE_CONFLICT"
    );
    const before = rawGet(file, "SELECT history_json FROM operations WHERE id = ?", [O]);
    const beforeTerminal = rawGet(file, "SELECT history_json FROM operations WHERE id = ?", [O2]);
    // Hand the fence to a new current owner through the bindings API.
    bindings.settleProducer({
      projectId: P1, conversationId: CX, ownerToken: T1, generation: 1, state: "released", evidence: null,
    });
    bindings.claimProducer({
      projectId: P1, conversationId: CX, ownerToken: T2, expectedGeneration: 1, evidence: null,
    });
    const peer = openSecondTurns(file);
    const g2 = {
      ...scope(P1, CX, { ownerToken: T2, ownerGeneration: 2, hostGeneration: H2 }),
      turnId: R,
      operationId: O,
    };
    // Valid current fence plus trusted verifier, but the journal is g1's.
    expectCode(() => turns.recordWritten(g2), "ERR_FENCE_CONFLICT");
    expectCode(() => peer.turns.recordWritten(g2), "ERR_FENCE_CONFLICT");
    expectCode(() => peer.turns.settleTurn({ ...g2, outcome: "unknown" }), "ERR_FENCE_CONFLICT");
    // Even an exact terminal replay checks provenance before returning.
    expectCode(
      () => peer.turns.settleTurn({ ...g2, turnId: R2, operationId: O2, outcome: "completed", nativeFact: fact }),
      "ERR_FENCE_CONFLICT"
    );
    // Two connections attempted; raw read-back shows unchanged journals.
    expect(rawGet(file, "SELECT history_json FROM operations WHERE id = ?", [O])).toEqual(before);
    expect(rawGet(file, "SELECT history_json FROM operations WHERE id = ?", [O2])).toEqual(beforeTerminal);
  });
});
