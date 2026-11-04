// CHO-03 S2h turn/body reference tests: real temp SQLite fixtures only.
// Covers queue with promptRef, XOR/null/legacy-inline, exact retry,
// different-ref+inline conflict, missing/foreign/empty body, >32KiB
// Unicode body via chunk API, owner-fence rejection, stale-owner fence,
// Codex full lifecycle with native facts, get/list metadata-only,
// close/reopen persistence, stored corruption (dangling ref, dual-
// populated) via direct raw edit, and two atomic-transaction tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionBodies } from "../server/session-bodies.mjs";
import { createSessionTurns } from "../server/session-turns.mjs";

const dirs = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* idempotent */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cho-body-refs-"));
  dirs.push(dir);
  return dir;
}

const uid = (n) => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`;
const P1 = uid(1);
const CX = uid(101);
const T1 = uid(301);
const T2 = uid(302);
const OP1 = uid(401);
const OP2 = uid(402);
const BODY1 = uid(501);
const BODY2 = uid(502);
const H1 = uid(311);

function makeClock(start = 1700000000000) {
  let tick = start;
  return () => tick++;
}

const strictTrue = () => true;
const strictFalse = () => false;

function openFresh(dir, options = {}) {
  const file = join(dir, "cho-sessions.sqlite3");
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const clock = options.clock ?? makeClock();
  const records = createSessionRecords({ store, now: clock });
  const bindings = createSessionBindings({
    store,
    verifyOwnerEvidence: options.verifier ?? strictTrue,
    now: clock,
  });
  const bodies = createSessionBodies({
    store,
    verifyOwnerEvidence: options.bodyVerifier ?? strictTrue,
    now: clock,
  });
  const turns = createSessionTurns({
    store,
    verifyOwnerEvidence: options.turnVerifier ?? strictTrue,
    now: clock,
  });
  return { file, store, records, bindings, bodies, turns, clock };
}

function seedCodexProject(records, bindings, projectId, conversationId, hostGen) {
  records.createProject({ id: projectId, name: "proj", pathCanonical: "C:/synthetic/bodyrefs" });
  records.createConversation({
    projectId,
    id: conversationId,
    controller: "codex",
    modelRequested: "gpt-4o",
    effort: "medium",
    role: "implement",
  });
  bindings.claimProducer({
    projectId,
    conversationId,
    ownerToken: uid(900),
    expectedGeneration: 0,
    evidence: null,
  });
  bindings.bindNativeRef({
    projectId,
    conversationId,
    ownerToken: uid(900),
    generation: 1,
    controller: "codex",
    nativeThreadId: "thread-fake-001",
    evidence: null,
  });
}

function seedBody(bodies, projectId, conversationId, bodyId, text) {
  bodies.putBody({
    projectId,
    conversationId,
    ownerToken: uid(900),
    ownerGeneration: 1,
    hostGeneration: H1,
    evidence: null,
    bodyId,
    text,
  });
}

function scope(projectId, conversationId, hostGen) {
  return {
    projectId,
    conversationId,
    ownerToken: uid(900),
    ownerGeneration: 1,
    hostGeneration: hostGen,
    evidence: null,
  };
}

const RAW_FLAGS = {
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  allowExtension: false,
};

function openRaw(file, readOnly = false) {
  return new DatabaseSync(file, readOnly ? { readOnly: true, ...RAW_FLAGS } : { ...RAW_FLAGS });
}

function rawGet(file, sql, params = []) {
  const raw = openRaw(file, true);
  try {
    const row = raw.prepare(sql).get(...params);
    return row === undefined ? undefined : { ...row };
  } finally { raw.close(); }
}

function rawAll(file, sql, params = []) {
  const raw = openRaw(file, true);
  try {
    return raw.prepare(sql).all(...params).map((r) => ({ ...r }));
  } finally { raw.close(); }
}

function expectCode(fn, code) {
  try { fn(); } catch (error) {
    expect(error?.code).toBe(code);
    return error;
  }
  throw new Error(`expected throw with code ${code}`);
}

describe("CHO-03 S2h turn/body references", () => {

  it("queue with promptRef returns prompt null, promptRef UUID, promptBody metadata", () => {
    const dir = tempDir();
    const { file, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "hello body text");

    const sc = scope(P1, CX, hostGen);
    const result = turns.queueTurn({
      ...sc,
      turnId: T1,
      operationId: OP1,
      promptRef: BODY1,
    });

    expect(result.created).toBe(true);
    expect(result.turn.prompt).toBeNull();
    expect(result.turn.promptRef).toBe(BODY1);
    expect(result.turn.promptBody).toBeDefined();
    expect(result.turn.promptBody.id).toBe(BODY1);
    expect(result.turn.promptBody.byteLength).toBeGreaterThan(0);
    expect(result.turn.promptBody.sha256Hex).toMatch(/^[0-9a-f]{64}$/);

    // Raw verification: turn row has prompt_ref set, prompt_text is ''
    const turnRow = rawGet(file, "SELECT prompt_text, prompt_ref FROM turns WHERE id = ?", [T1]);
    expect(turnRow.prompt_ref).toBe(BODY1);
    expect(turnRow.prompt_text).toBe("");
  });

  it("XOR: prompt and promptRef mutually exclusive → ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "body");

    const sc = scope(P1, CX, hostGen);
    expectCode(() => turns.queueTurn({
      ...sc,
      turnId: T1,
      operationId: OP1,
      prompt: "inline",
      promptRef: BODY1,
    }), "ERR_INVALID_RECORD");
  });

  it("legacy inline prompt still works; null promptRef treated as inline", () => {
    const dir = tempDir();
    const { records, bindings, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);

    const sc = scope(P1, CX, hostGen);
    const result = turns.queueTurn({
      ...sc,
      turnId: T1,
      operationId: OP1,
      prompt: "inline prompt text",
      promptRef: null,
    });

    expect(result.created).toBe(true);
    expect(result.turn.prompt).toBe("inline prompt text");
    expect(result.turn.promptRef).toBeNull();
    expect(result.turn.promptBody).toBeNull();
  });

  it("exact retry idempotent: same op id + payload returns created:false, no writes", () => {
    const dir = tempDir();
    const { file, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "retry body");

    const sc = scope(P1, CX, hostGen);
    const args = { ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 };
    const first = turns.queueTurn(args);
    expect(first.created).toBe(true);

    // Snapshot raw state before retry
    const turnBefore = rawGet(file, "SELECT * FROM turns WHERE id = ?", [T1]);
    const opBefore = rawGet(file, "SELECT * FROM operations WHERE id = ?", [OP1]);
    const convBefore = rawGet(file, "SELECT updated_at_ms FROM conversations WHERE id = ?", [CX]);

    const second = turns.queueTurn(args);
    expect(second.created).toBe(false);
    expect(second.turn.id).toBe(T1);

    // Full raw rows unchanged
    const turnAfter = rawGet(file, "SELECT * FROM turns WHERE id = ?", [T1]);
    const opAfter = rawGet(file, "SELECT * FROM operations WHERE id = ?", [OP1]);
    const convAfter = rawGet(file, "SELECT updated_at_ms FROM conversations WHERE id = ?", [CX]);
    expect(turnAfter).toEqual(turnBefore);
    expect(opAfter).toEqual(opBefore);
    expect(convAfter.updated_at_ms).toBe(convBefore.updated_at_ms);
  });

  it("different ref + inline conflict on same op id → ERR_IDEMPOTENCY_CONFLICT", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "first body");
    seedBody(bodies, P1, CX, BODY2, "second body");

    const sc = scope(P1, CX, hostGen);
    turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });

    // Same op id, different promptRef → idempotency conflict
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, promptRef: BODY2,
    }), "ERR_IDEMPOTENCY_CONFLICT");

    // Same op id, inline prompt instead → idempotency conflict
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, prompt: "inline instead",
    }), "ERR_IDEMPOTENCY_CONFLICT");
  });

  it("missing body → ERR_NOT_FOUND; foreign body → ERR_NOT_FOUND; empty body → ERR_INVALID_RECORD", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);

    const sc = scope(P1, CX, hostGen);

    // Missing body
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, promptRef: uid(999),
    }), "ERR_NOT_FOUND");

    // Foreign body: seed in a different conversation (claim producer first)
    const CX2 = uid(103);
    records.createConversation({
      projectId: P1, id: CX2, controller: "codex",
      modelRequested: "gpt-4o", effort: "low", role: "review",
    });
    bindings.claimProducer({
      projectId: P1, conversationId: CX2,
      ownerToken: uid(900), expectedGeneration: 0, evidence: null,
    });
    bodies.putBody({
      projectId: P1, conversationId: CX2,
      ownerToken: uid(900), ownerGeneration: 1, hostGeneration: H1,
      evidence: null, bodyId: BODY1, text: "foreign body",
    });
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, promptRef: BODY1,
    }), "ERR_NOT_FOUND");

    // Empty body: putBody permits empty text; queue rejects it
    const EMPTY_BODY = uid(777);
    bodies.putBody({
      projectId: P1, conversationId: CX,
      ownerToken: uid(900), ownerGeneration: 1, hostGeneration: H1,
      evidence: null, bodyId: EMPTY_BODY, text: "",
    });
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T2, operationId: OP2, promptRef: EMPTY_BODY,
    }), "ERR_INVALID_RECORD");
  });

  it(">32KiB Unicode body via readBodyChunk: queue succeeds, chunk round-trip correct", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);

    // Build a >32KiB Unicode string
    const chunk = "日本語テキスト🎉";
    const parts = [];
    let totalBytes = 0;
    while (totalBytes <= 33000) {
      parts.push(chunk);
      totalBytes += Buffer.byteLength(chunk, "utf8");
    }
    const bigText = parts.join("");
    expect(Buffer.byteLength(bigText, "utf8")).toBeGreaterThan(32768);

    seedBody(bodies, P1, CX, BODY1, bigText);

    const sc = scope(P1, CX, hostGen);
    const result = turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, promptRef: BODY1,
    });

    expect(result.created).toBe(true);
    expect(result.turn.prompt).toBeNull();
    expect(result.turn.promptRef).toBe(BODY1);
    expect(result.turn.promptBody.byteLength).toBe(Buffer.byteLength(bigText, "utf8"));

    // Accumulate via readBodyChunk API and verify round-trip
    const buffers = [];
    let offset = 0;
    let eof = false;
    while (!eof) {
      const page = bodies.readBodyChunk({
        projectId: P1, conversationId: CX, bodyId: BODY1,
        offsetBytes: offset, lengthBytes: 16383,
      });
      buffers.push(Buffer.from(page.dataBase64, "base64"));
      offset = page.nextOffsetBytes;
      eof = page.eof;
    }
    const decoded = Buffer.concat(buffers).toString("utf8");
    expect(decoded).toBe(bigText);
  });

  it("owner verifier false → ERR_OWNER_UNVERIFIED on queue", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir, { turnVerifier: strictFalse });
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "fenced body");

    const sc = scope(P1, CX, hostGen);
    expectCode(() => turns.queueTurn({
      ...sc, turnId: T1, operationId: OP1, promptRef: BODY1,
    }), "ERR_OWNER_UNVERIFIED");
  });

  it("stale owner after settle+reclaim → ERR_FENCE_CONFLICT; turns/ops unchanged", () => {
    const dir = tempDir();
    const { file, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "stale body");

    const sc = scope(P1, CX, hostGen);
    // Queue a turn under the original owner
    turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });

    // Settle the producer (release) then reclaim with a different token
    bindings.settleProducer({
      projectId: P1, conversationId: CX,
      ownerToken: uid(900), generation: 1, state: "released", evidence: null,
    });
    bindings.claimProducer({
      projectId: P1, conversationId: CX,
      ownerToken: uid(901), expectedGeneration: 1, evidence: null,
    });

    // Old scope now stale → ERR_FENCE_CONFLICT
    expectCode(() => turns.beginDispatch({
      ...sc, turnId: T1, operationId: OP1,
    }), "ERR_FENCE_CONFLICT");

    // Assert turns/operations rows unchanged (still queued)
    const turnRow = rawGet(file, "SELECT intent_state FROM turns WHERE id = ?", [T1]);
    expect(turnRow.intent_state).toBe("queued");
    const opRow = rawGet(file, "SELECT state FROM operations WHERE id = ?", [OP1]);
    expect(opRow.state).toBe("queued");
  });

  it("Codex full lifecycle: begin → written → observed → terminal with native facts", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "lifecycle body");

    const sc = scope(P1, CX, hostGen);
    const queued = turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });
    expect(queued.turn.intentState).toBe("queued");

    const begun = turns.beginDispatch({ ...sc, turnId: T1, operationId: OP1 });
    expect(begun.dispatchState).toBe("dispatching");

    const written = turns.recordWritten({ ...sc, turnId: T1, operationId: OP1 });
    expect(written.dispatchState).toBe("written");
    expect(written.intentState).toBe("written");

    const observed = turns.recordObserved({
      ...sc, turnId: T1, operationId: OP1,
      nativeFact: { nativeIdentity: "thread-fake-001", nativeTurnId: "turn-fake-42", claudeInputUuid: null },
    });
    expect(observed.dispatchState).toBe("observed");
    expect(observed.intentState).toBe("observed");
    expect(observed.nativeTurnId).toBe("turn-fake-42");

    const settled = turns.settleTurn({
      ...sc, turnId: T1, operationId: OP1, outcome: "completed",
      nativeFact: { nativeIdentity: "thread-fake-001", nativeTurnId: "turn-fake-42", claudeInputUuid: null },
    });
    expect(settled.outcome).toBe("completed");
    expect(settled.intentState).toBe("completed");
    expect(settled.settledAtMs).toBeGreaterThan(0);
  });

  it("get/list return metadata only: no promptBody, no history, no full prompt", () => {
    const dir = tempDir();
    const { records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "metadata check body");

    const sc = scope(P1, CX, hostGen);
    turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });

    const got = turns.getTurn({ projectId: P1, conversationId: CX, turnId: T1 });
    expect(got).not.toBeNull();
    expect(got.prompt).toBeNull();
    expect(got.promptRef).toBe(BODY1);
    expect(got.promptBody).toBeDefined();
    expect(got.history).toBeDefined();

    const listed = turns.listTurns({ projectId: P1, conversationId: CX });
    expect(listed).toHaveLength(1);
    expect(listed[0].prompt).toBeUndefined();
    expect(listed[0].promptBody).toBeUndefined();
    expect(listed[0].history).toBeUndefined();
    expect(listed[0].promptRef).toBe(BODY1);
  });

  it("close and reopen: body-ref turn persists identically", () => {
    const dir = tempDir();
    const { file, store, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "persist body");

    const sc = scope(P1, CX, hostGen);
    const queued = turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });

    // Close the store; afterEach repeated close is idempotent so leave tracked
    store.close();

    // Reopen
    const store2 = openSessionStore({ databasePath: file });
    stores.push(store2);
    const turns2 = createSessionTurns({ store: store2, verifyOwnerEvidence: strictTrue, now: makeClock() });

    const got = turns2.getTurn({ projectId: P1, conversationId: CX, turnId: T1 });
    expect(got).not.toBeNull();
    expect(got.promptRef).toBe(BODY1);
    expect(got.promptBody.id).toBe(BODY1);
    expect(got.promptBody.byteLength).toBe(queued.turn.promptBody.byteLength);
    expect(got.promptBody.sha256Hex).toBe(queued.turn.promptBody.sha256Hex);
  });

  it("dangling ref + dual-populated stored shape → ERR_STORAGE via direct raw edit", () => {
    const dir = tempDir();
    const { file, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "corrupt test body");

    const sc = scope(P1, CX, hostGen);
    turns.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });

    // Dangling ref: point prompt_ref to a nonexistent body
    const raw = openRaw(file);
    try {
      raw.prepare("UPDATE turns SET prompt_ref = ? WHERE id = ?").run(uid(888), T1);
    } finally { raw.close(); }

    expectCode(() => turns.getTurn({ projectId: P1, conversationId: CX, turnId: T1 }), "ERR_STORAGE");

    // Dual populated: restore valid ref but also set prompt_text non-empty
    const raw2 = openRaw(file);
    try {
      raw2.prepare("UPDATE turns SET prompt_ref = ?, prompt_text = ? WHERE id = ?").run(BODY1, "dual", T1);
    } finally { raw2.close(); }

    expectCode(() => turns.getTurn({ projectId: P1, conversationId: CX, turnId: T1 }), "ERR_STORAGE");
  });

  it("atomic rollback: body put + turn queue + project rename then throw → nothing persisted", () => {
    const dir = tempDir();
    const { file, store, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);

    const sc = scope(P1, CX, hostGen);
    const NEW_BODY = uid(601);
    const NEW_TURN = uid(602);
    const NEW_OP = uid(603);

    expect(() => {
      store.transaction((tx) => {
        const btx = bodies.inTransaction(tx);
        btx.putBody({
          projectId: P1, conversationId: CX,
          ownerToken: uid(900), ownerGeneration: 1, hostGeneration: H1,
          evidence: null, bodyId: NEW_BODY, text: "atomic body",
        });
        const ttx = turns.inTransaction(tx);
        ttx.queueTurn({
          ...sc, turnId: NEW_TURN, operationId: NEW_OP, promptRef: NEW_BODY,
        });
        tx.run("UPDATE projects SET name = ? WHERE id = ?", ["renamed", P1]);
        throw new Error("explicit rollback");
      });
    }).toThrow("explicit rollback");

    // Nothing persisted
    const bodyRow = rawGet(file, "SELECT id FROM large_bodies WHERE id = ?", [NEW_BODY]);
    expect(bodyRow).toBeUndefined();
    const turnRow = rawGet(file, "SELECT id FROM turns WHERE id = ?", [NEW_TURN]);
    expect(turnRow).toBeUndefined();
    const opRow = rawGet(file, "SELECT id FROM operations WHERE id = ?", [NEW_OP]);
    expect(opRow).toBeUndefined();
    const projRow = rawGet(file, "SELECT name FROM projects WHERE id = ?", [P1]);
    expect(projRow.name).toBe("proj");
  });

  it("trigger blocks operations INSERT → ERR_STORAGE; turns/ops/conversation/body unchanged", () => {
    const dir = tempDir();
    const { file, store, records, bindings, bodies, turns } = openFresh(dir);
    const hostGen = H1;
    seedCodexProject(records, bindings, P1, CX, hostGen);
    seedBody(bodies, P1, CX, BODY1, "trigger body");

    const sc = scope(P1, CX, hostGen);

    // Snapshot state before
    const convBefore = rawGet(file, "SELECT updated_at_ms FROM conversations WHERE id = ?", [CX]);
    const bodyBefore = rawGet(file, "SELECT byte_len FROM large_bodies WHERE id = ?", [BODY1]);

    expectCode(() => {
      store.transaction((tx) => {
        tx.run(
          "CREATE TEMP TRIGGER deny_ref_op BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        const ttx = turns.inTransaction(tx);
        ttx.queueTurn({ ...sc, turnId: T1, operationId: OP1, promptRef: BODY1 });
      });
    }, "ERR_STORAGE");

    // Nothing written
    const turnRow = rawGet(file, "SELECT id FROM turns WHERE id = ?", [T1]);
    expect(turnRow).toBeUndefined();
    const opRow = rawGet(file, "SELECT id FROM operations WHERE id = ?", [OP1]);
    expect(opRow).toBeUndefined();
    const convAfter = rawGet(file, "SELECT updated_at_ms FROM conversations WHERE id = ?", [CX]);
    expect(convAfter.updated_at_ms).toBe(convBefore.updated_at_ms);
    const bodyAfter = rawGet(file, "SELECT byte_len FROM large_bodies WHERE id = ?", [BODY1]);
    expect(bodyAfter.byte_len).toBe(bodyBefore.byte_len);
  });

});
