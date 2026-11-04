// Regression tests for draft-conflict resolution (CHO-03 S2a).
// Uses real SQLite via node:sqlite for raw before/after snapshots.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";

const uid = () => randomUUID();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "draft-res-"));
  const dbPath = join(dir, "test.db");
  const store = openSessionStore({ databasePath: dbPath });
  let time = 1_000_000;
  const records = createSessionRecords({ store, now: () => time });
  return { dir, dbPath, store, records, tick: () => (time += 1000), setTime: (value) => (time = value) };
}

async function cleanup(f) {
  f.store.close();
  await rm(f.dir, { recursive: true, force: true });
}

function rawRows(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function rawExec(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function seedProjectAndChat(f) {
  const P = uid(), C = uid();
  f.records.createProject({ id: P, name: "fixture", pathCanonical: "C:/synthetic/draft" });
  f.records.createConversation({ id: C, projectId: P, controller: "codex" });
  return { P, C };
}

describe("resolveDraftConflict", () => {

  it("1 kept: merged Unicode, version inc, conflict text/base/time unchanged, receipt has no text", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "base" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "merged\u{1F600}caf\u00E9" });
      f.tick();
      const receipt = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "merged\u{1F600}caf\u00E9",
      });
      assert.equal(receipt.status, "resolved");
      assert.equal(receipt.version, 2);
      assert.equal(receipt.resolution, "kept");
      assert.equal(receipt.v, 1);
      assert.equal(Object.keys(receipt).length, 8);
      assert.ok(!("text" in receipt));
      const draft = f.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draft.text, "merged\u{1F600}caf\u00E9");
      assert.equal(draft.version, 2);
      const conflict = f.records.getDraftConflict({ projectId: P, conversationId: C, saveId: Q });
      assert.equal(conflict.resolution, "kept");
      assert.equal(conflict.baseVersion, 0);
      const ops = rawRows(f.dbPath, "SELECT result_json FROM operations WHERE id = ?", [S]);
      assert.ok(ops[0].result_json.includes('"saved"'));
    } finally { await cleanup(f); }
  });

  it("2 dropped: preserves raw draft and conversation; conflict text preserved, resolution dropped", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "keepme" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "dropme" });
      f.tick();
      const before = rawRows(f.dbPath, "SELECT text, version FROM drafts WHERE conversation_id = ?", [C]);
      const convBefore = rawRows(f.dbPath, "SELECT updated_at_ms FROM conversations WHERE id = ?", [C]);
      const receipt = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "dropped",
      });
      assert.equal(receipt.status, "resolved");
      assert.equal(receipt.resolution, "dropped");
      assert.equal(receipt.version, 1);
      const after = rawRows(f.dbPath, "SELECT text, version FROM drafts WHERE conversation_id = ?", [C]);
      assert.deepEqual(after, before);
      const convAfter = rawRows(f.dbPath, "SELECT updated_at_ms FROM conversations WHERE id = ?", [C]);
      assert.deepEqual(convAfter, convBefore);
      const conflict = f.records.getDraftConflict({ projectId: P, conversationId: C, saveId: Q });
      assert.equal(conflict.resolution, "dropped");
      assert.equal(conflict.text, "dropme");
    } finally { await cleanup(f); }
  });

  it("3 stale kept+dropped preserve state; retry returns original stale receipt; new R+version succeeds", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "v1" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "conflict" });
      f.tick();
      const stale = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 99, action: "kept", text: "x",
      });
      assert.equal(stale.status, "stale");
      assert.equal(stale.resolution, "open");
      assert.equal(stale.version, 1);
      const draft = f.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draft.version, 1);
      const conflict = f.records.getDraftConflict({ projectId: P, conversationId: C, saveId: Q });
      assert.equal(conflict.resolution, "open");
      const retry = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 99, action: "kept", text: "x",
      });
      assert.deepEqual(retry, stale);
      const R3 = uid();
      const snapD3 = rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]);
      const snapC3 = rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]);
      const snapConv3 = rawRows(f.dbPath, "SELECT * FROM conversations WHERE id = ?", [C]);
      const staleDrop = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R3,
        expectedVersion: 99, action: "dropped",
      });
      assert.equal(staleDrop.status, "stale");
      assert.equal(staleDrop.resolution, "open");
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]), snapD3);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]), snapC3);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM conversations WHERE id = ?", [C]), snapConv3);
      const R2 = uid();
      const ok = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R2,
        expectedVersion: 1, action: "dropped",
      });
      assert.equal(ok.status, "resolved");
      assert.equal(ok.resolution, "dropped");
    } finally { await cleanup(f); }
  });

  it("4 exact kept retry after later save returns orig receipt; changed params -> conflict; resolved new R -> state error", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f.tick();
      const orig = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      f.tick();
      const S2 = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S2, expectedVersion: 2, text: "c" });
      const retry = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      assert.deepEqual(retry, orig);
      f.setTime(0);
      const retry2 = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      assert.deepEqual(retry2, orig);
      const draftAfter4 = f.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draftAfter4.text, "c");
      assert.equal(draftAfter4.version, 3);
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "dropped",
      }), (e) => e.code === "ERR_IDEMPOTENCY_CONFLICT");
      const R2 = uid();
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R2,
        expectedVersion: 3, action: "kept", text: "z",
      }), (e) => e.code === "ERR_DRAFT_CONFLICT_STATE");
    } finally { await cleanup(f); }
  });

  it("5 cross-kind ID reuse -> conflict; missing/foreign project/chat/conflict -> NF; no cross-chat leak", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const C2 = uid();
      f.records.createConversation({ id: C2, projectId: P, controller: "codex" });
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f.tick();
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: S,
        expectedVersion: 1, action: "dropped",
      }), (e) => e.code === "ERR_IDEMPOTENCY_CONFLICT");
      f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "dropped",
      });
      assert.throws(() => f.records.saveDraft({
        projectId: P, conversationId: C, saveId: R, expectedVersion: 1, text: "x",
      }), (e) => e.code === "ERR_IDEMPOTENCY_CONFLICT");
      const foreignP = uid();
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: foreignP, conversationId: C, conflictId: Q, resolutionId: uid(),
        expectedVersion: 1, action: "dropped",
      }), (e) => e.code === "ERR_NOT_FOUND");
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C2, conflictId: Q, resolutionId: uid(),
        expectedVersion: 1, action: "dropped",
      }), (e) => e.code === "ERR_NOT_FOUND");
    } finally { await cleanup(f); }
  });

  it("6 absent draft v0: stale save expectedVersion 1 creates conflict; kept creates v1 empty; drop leaves absent", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 1, text: "" });
      f.tick();
      const receipt = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 0, action: "kept", text: "",
      });
      assert.equal(receipt.status, "resolved");
      assert.equal(receipt.version, 1);
      const draft = f.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draft.text, "");
      assert.equal(draft.version, 1);
    } finally { await cleanup(f); }

    const f2 = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f2);
      const Q = uid(), R = uid();
      f2.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 1, text: "x" });
      f2.tick();
      f2.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 0, action: "dropped",
      });
      const draft = f2.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draft, null);
    } finally { await cleanup(f2); }
  });

  it("7 BEFORE INSERT trigger on operations -> ERR_STORAGE; entire DB unchanged", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f.tick();
      f.store.transaction((tx) => {
        tx.run("CREATE TEMP TRIGGER abort_ops BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'boom'); END");
      });
      const snapDraft = rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]);
      const snapConflict = rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]);
      const snapConv = rawRows(f.dbPath, "SELECT * FROM conversations WHERE id = ?", [C]);
      const snapOps = rawRows(f.dbPath, "SELECT * FROM operations");
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      }), (e) => e.code === "ERR_STORAGE");
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]), snapDraft);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]), snapConflict);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM conversations WHERE id = ?", [C]), snapConv);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM operations"), snapOps);
    } finally { await cleanup(f); }
  });

  it("8 version exhaustion -> ERR_VERSION_LIMIT no mutation; invalid inputs rejected; clock regression rejected", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f.tick();
      rawExec(f.dbPath, "UPDATE drafts SET version = ? WHERE conversation_id = ?", [Number.MAX_SAFE_INTEGER, C]);
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: Number.MAX_SAFE_INTEGER, action: "kept", text: "b",
      }), (e) => e.code === "ERR_VERSION_LIMIT");
      const draft = f.records.getDraft({ projectId: P, conversationId: C });
      assert.equal(draft.version, Number.MAX_SAFE_INTEGER);
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "invalid", text: "b",
      }), (e) => e.code === "ERR_INVALID_RECORD");
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "nul\0byte",
      }), (e) => e.code === "ERR_INVALID_RECORD");
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "\uD800lone",
      }), (e) => e.code === "ERR_INVALID_RECORD");
      const snapD8 = rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]);
      const snapC8 = rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]);
      const snapO8 = rawRows(f.dbPath, "SELECT * FROM operations");
      f.setTime(0);
      assert.throws(() => f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: uid(),
        expectedVersion: Number.MAX_SAFE_INTEGER, action: "dropped",
      }), (e) => e.code === "ERR_INVALID_RECORD");
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM drafts WHERE conversation_id = ?", [C]), snapD8);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM draft_conflicts WHERE conversation_id = ?", [C]), snapC8);
      assert.deepEqual(rawRows(f.dbPath, "SELECT * FROM operations"), snapO8);
      f.setTime(1_000_000);
    } finally { await cleanup(f); }
  });

  it("9 close/reopen reads old receipt; corrupt result_json bad JSON / oversize -> ERR_STORAGE", async () => {
    const f = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f);
      const S = uid(), Q = uid(), R = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f.tick();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f.tick();
      const orig = f.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      f.tick();
      const S2 = uid();
      f.records.saveDraft({ projectId: P, conversationId: C, saveId: S2, expectedVersion: 2, text: "c" });
      f.store.close();
      const store2 = openSessionStore({ databasePath: f.dbPath });
      const records2 = createSessionRecords({ store: store2, now: () => 9_999_999 });
      const retry = records2.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      assert.deepEqual(retry, orig);
      store2.close();
    } finally { await rm(f.dir, { recursive: true, force: true }); }

    const f2 = await fixture();
    try {
      const { P, C } = await seedProjectAndChat(f2);
      const S = uid(), Q = uid(), R = uid();
      f2.records.saveDraft({ projectId: P, conversationId: C, saveId: S, expectedVersion: 0, text: "a" });
      f2.tick();
      f2.records.saveDraft({ projectId: P, conversationId: C, saveId: Q, expectedVersion: 0, text: "b" });
      f2.tick();
      f2.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      });
      rawExec(f2.dbPath, "UPDATE operations SET result_json = ? WHERE id = ?", ["{bad json", R]);
      assert.throws(() => f2.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      }), (e) => e.code === "ERR_STORAGE");
      const oversize = "x".repeat(2049);
      rawExec(f2.dbPath, "UPDATE operations SET result_json = ? WHERE id = ?", [oversize, R]);
      assert.throws(() => f2.records.resolveDraftConflict({
        projectId: P, conversationId: C, conflictId: Q, resolutionId: R,
        expectedVersion: 1, action: "kept", text: "b",
      }), (e) => e.code === "ERR_STORAGE");
    } finally { await cleanup(f2); }
  });

});
