// CHO-03 S2a records/drafts tests: real temp SQLite fixtures only, never the
// actual user app-data. Covers the handoff boundaries: project/chat CRUD,
// exact draft fidelity, version/idempotency receipts, stale-save conflicts,
// trigger-abort atomicity, version exhaustion, and closed-store pass-through.
// No implementation-mirroring mocks: verification reads raw SQL back through
// an independent connection where relevant.
//
// NUL note: these tests assert that text containing U+0000 is rejected with
// ERR_INVALID_RECORD before any write on every persisted-text field, because
// the native node:sqlite string binding on older runtimes silently truncates
// text at the first NUL on read.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "cho-session-records-"));
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
const S1 = uid(201);
const S2 = uid(202);
const S3 = uid(203);

function makeClock(start = 1700000000000) {
  let tick = start;
  return () => tick++;
}

function openFresh(dir, name, now) {
  const file = dbPath(dir, name);
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const records = createSessionRecords({ store, now: now ?? makeClock() });
  return { file, store, records };
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
    pathCanonical: pathCanonical ?? `/tmp/cho-proj-${id.slice(-4)}`,
  });
}

function seedConversation(records, id, projectId, extra = {}) {
  return records.createConversation({
    id,
    projectId,
    controller: "codex",
    ...extra,
  });
}

function expectedHash(projectId, conversationId, expectedVersion, text) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "draft-save-v1",
        projectId,
        conversationId,
        expectedVersion,
        text,
      ]),
      "utf8"
    )
    .digest("hex");
}

describe("projects and conversations", () => {
  it("creates, gets, and reopens persisted identity with native fields NULL", () => {
    const dir = tempDir();
    const { file, store, records } = openFresh(dir, "a.sqlite3");
    const project = seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    expect(project).toEqual({
      id: P1,
      name: "alpha",
      pathCanonical: "/tmp/cho-alpha",
      createdAtMs: 1700000000000,
      archived: false,
    });
    const conv = seedConversation(records, C1, P1, {
      title: "first chat",
      modelRequested: "gpt-5",
      effort: "high",
      role: "review",
      controller: "claude",
    });
    expect(conv).toMatchObject({
      id: C1,
      projectId: P1,
      title: "first chat",
      controller: "claude",
      modelRequested: "gpt-5",
      modelReported: null,
      servedVerified: null,
      requestedClaudeSessionUuid: null,
      effort: "high",
      role: "review",
      parentConversationId: null,
      archived: false,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openSessionStore({ databasePath: file });
    stores.push(reopened);
    const again = createSessionRecords({ store: reopened });
    expect(again.getProject({ projectId: P1 })).toEqual(project);
    expect(again.getConversation({ projectId: P1, conversationId: C1 })).toEqual(conv);
    // Independent raw read-back: no invented native binding survived.
    const rawConv = rawGet(
      file,
      "SELECT model_reported, served_verified, requested_claude_session_uuid FROM conversations WHERE id = ?",
      [C1]
    );
    expect(rawConv).toMatchObject({
      model_reported: null,
      served_verified: null,
      requested_claude_session_uuid: null,
    });
    expect(
      rawAll(file, "SELECT conversation_id FROM native_refs WHERE conversation_id = ?", [C1])
    ).toEqual([]);
  });

  it("rejects duplicate project id/path without changing the original", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "dup.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    expectCode(
      () => records.createProject({ id: P1, name: "other", pathCanonical: "/tmp/cho-other" }),
      "ERR_RECORD_CONFLICT"
    );
    expectCode(
      () => records.createProject({ id: P2, name: "other", pathCanonical: "/tmp/cho-alpha" }),
      "ERR_RECORD_CONFLICT"
    );
    expect(records.getProject({ projectId: P1 })).toMatchObject({
      name: "alpha",
      pathCanonical: "/tmp/cho-alpha",
    });
    expect(
      rawAll(file, "SELECT id, name FROM projects ORDER BY id")
    ).toEqual([{ id: P1, name: "alpha" }]);
    // Duplicate conversation ids also conflict, even across projects.
    seedProject(records, P2, "beta", "/tmp/cho-beta");
    seedConversation(records, C1, P1);
    expectCode(
      () => seedConversation(records, C1, P2),
      "ERR_RECORD_CONFLICT"
    );
    expect(records.getConversation({ projectId: P1, conversationId: C1 })).not.toBeNull();
    expect(records.getConversation({ projectId: P2, conversationId: C1 })).toBeNull();
  });

  it("accepts same-project parents and rejects cross-project parents", () => {
    const dir = tempDir();
    const { records } = openFresh(dir, "parent.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedProject(records, P2, "beta", "/tmp/cho-beta");
    seedConversation(records, C1, P1);
    const child = records.createConversation({
      id: C2,
      projectId: P1,
      controller: "claude",
      parentConversationId: C1,
    });
    expect(child.parentConversationId).toBe(C1);
    expectCode(
      () =>
        records.createConversation({
          id: uid(103),
          projectId: P2,
          controller: "codex",
          parentConversationId: C1,
        }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () =>
        records.createConversation({
          id: uid(104),
          projectId: P1,
          controller: "codex",
          parentConversationId: uid(999),
        }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () =>
        records.createConversation({
          id: uid(105),
          projectId: uid(998),
          controller: "codex",
        }),
      "ERR_NOT_FOUND"
    );
  });

  it("returns null for wrong-project reads; mutators report ERR_NOT_FOUND", () => {
    const dir = tempDir();
    const { records } = openFresh(dir, "owner.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedProject(records, P2, "beta", "/tmp/cho-beta");
    seedConversation(records, C1, P1, { title: "mine" });
    expect(records.getConversation({ projectId: P2, conversationId: C1 })).toBeNull();
    expectCode(
      () => records.renameConversation({ projectId: P2, conversationId: C1, title: "x" }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => records.setConversationArchived({ projectId: P2, conversationId: C1, archived: true }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => records.getDraft({ projectId: P2, conversationId: C1 }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () =>
        records.saveDraft({ projectId: P2, conversationId: C1, saveId: S1, expectedVersion: 0, text: "x" }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => records.listDraftConflicts({ projectId: P2, conversationId: C1 }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => records.getDraftConflict({ projectId: P2, conversationId: C1, saveId: S1 }),
      "ERR_NOT_FOUND"
    );
    expect(records.getConversation({ projectId: P1, conversationId: C1 })).toMatchObject({
      title: "mine",
    });
  });

  it("rejects strict UUID, null, bound, and type violations", () => {
    const dir = tempDir();
    const { records } = openFresh(dir, "strict.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    const badIds = [
      "AAAAAAAAAAAAAAAA-BBBB-CCCC-DDDD-000000000001",
      " 11111111-1111-1111-1111-111111111111",
      "not-a-uuid",
      "",
      null,
      42,
    ];
    for (const projectId of badIds) {
      expectCode(() => records.getProject({ projectId }), "ERR_INVALID_RECORD");
    }
    expectCode(
      () => records.createProject({ id: P2, name: "", pathCanonical: "/tmp/x" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.createProject({ id: P2, name: "n".repeat(257), pathCanonical: "/tmp/x" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.createProject({ id: P2, name: "ok", pathCanonical: "relative/path" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.createProject({ id: P2, name: "ok", pathCanonical: "/tmp/a\0b" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.createProject({ id: P2, name: `lone${String.fromCharCode(0xd800)}`, pathCanonical: "/tmp/x" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, uid(110), P1, { title: "t".repeat(513) }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, uid(111), P1, { modelRequested: "" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, uid(112), P1, { effort: "e".repeat(65) }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, uid(113), P1, { role: "owner" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        records.createConversation({ id: uid(114), projectId: P1, controller: "gemini" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.createConversation({ id: uid(115), projectId: P1, controller: "codex", parentConversationId: "zzz" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(() => records.listProjects({ limit: 0 }), "ERR_INVALID_RECORD");
    expectCode(() => records.listProjects({ limit: 101 }), "ERR_INVALID_RECORD");
    expectCode(() => records.listProjects({ offset: -1 }), "ERR_INVALID_RECORD");
    expectCode(() => records.listProjects({ offset: 1.5 }), "ERR_INVALID_RECORD");
    expectCode(
      () => records.setProjectArchived({ projectId: P1, archived: "true" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: -1, text: "x" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 1.5, text: "x" }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: 42 }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: `lone${String.fromCharCode(0xd800)}` }),
      "ERR_INVALID_RECORD"
    );
    // Static messages carry no input or storage detail.
    const error = expectCode(
      () => records.getProject({ projectId: "nope" }),
      "ERR_INVALID_RECORD"
    );
    expect(String(error.message)).not.toContain("nope");
  });

  it("preserves native binding/config on rename and archive; archive is organization only", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "meta.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1, {
      title: "v1",
      controller: "claude",
      modelRequested: "sonnet",
      effort: "medium",
      role: "implement",
    });
    const renamed = records.renameConversation({
      projectId: P1,
      conversationId: C1,
      title: "v2 title",
    });
    expect(renamed.title).toBe("v2 title");
    expect(renamed.updatedAtMs).toBeGreaterThan(renamed.createdAtMs);
    const archived = records.setConversationArchived({
      projectId: P1,
      conversationId: C1,
      archived: true,
    });
    expect(archived.archived).toBe(true);
    expect(archived.title).toBe("v2 title");
    // Native config/identities untouched by metadata-only edits.
    const rawConv = rawGet(
      file,
      "SELECT controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role FROM conversations WHERE id = ?",
      [C1]
    );
    expect(rawConv).toMatchObject({
      controller: "claude",
      model_requested: "sonnet",
      model_reported: null,
      served_verified: null,
      requested_claude_session_uuid: null,
      effort: "medium",
      role: "implement",
    });
    // Archived records stay explicitly readable.
    expect(records.getConversation({ projectId: P1, conversationId: C1 }).archived).toBe(true);
    expect(
      records.listConversations({ projectId: P1 }).some((c) => c.id === C1)
    ).toBe(false);
    expect(
      records.listConversations({ projectId: P1, includeArchived: true }).some((c) => c.id === C1)
    ).toBe(true);
    // Project archival does not touch children or rename anything.
    const proj = records.setProjectArchived({ projectId: P1, archived: true });
    expect(proj.archived).toBe(true);
    expect(records.getProject({ projectId: P1 }).name).toBe("alpha");
    expect(records.getConversation({ projectId: P1, conversationId: C1 }).archived).toBe(true);
    expect(records.listProjects()).toEqual([]);
    expect(records.listProjects({ includeArchived: true }).map((p) => p.id)).toEqual([P1]);
  });

  it("paginates lists stably and treats search input literally", () => {
    const dir = tempDir();
    const clock = makeClock();
    const { records } = openFresh(dir, "list.sqlite3", clock);
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    const titles = ["100% coverage", "under_score", 'say "hi"', "plain", "100% coverage again"];
    const ids = titles.map((title, i) =>
      records.createConversation({
        id: uid(300 + i),
        projectId: P1,
        controller: "codex",
        title,
      }).id
    );
    // Literal search: % and _ and quotes are not wildcards.
    expect(
      records.listConversations({ projectId: P1, query: "%" }).map((c) => c.title).sort()
    ).toEqual(["100% coverage", "100% coverage again"]);
    expect(
      records.listConversations({ projectId: P1, query: "_" }).map((c) => c.title)
    ).toEqual(["under_score"]);
    expect(
      records.listConversations({ projectId: P1, query: '"hi"' }).map((c) => c.title)
    ).toEqual(['say "hi"']);
    expect(
      records.listConversations({ projectId: P1, query: "nope" })
    ).toEqual([]);
    // Case-sensitive: TITLE in caps matches nothing.
    expect(
      records.listConversations({ projectId: P1, query: "PLAIN" })
    ).toEqual([]);
    // Stable bounded pagination: newest first, full pages then remainder.
    const page1 = records.listConversations({ projectId: P1, limit: 2, offset: 0 });
    const page2 = records.listConversations({ projectId: P1, limit: 2, offset: 2 });
    const page3 = records.listConversations({ projectId: P1, limit: 2, offset: 4 });
    expect([...page1, ...page2, ...page3].map((c) => c.id)).toEqual(ids.reverse());
    // A rename bumps updatedAtMs and moves the row to the front.
    records.renameConversation({ projectId: P1, conversationId: ids.at(-1), title: "plain renamed" });
    const first = records.listConversations({ projectId: P1, limit: 1 });
    expect(first[0].id).toBe(ids.at(-1));
    expectCode(
      () => records.listConversations({ projectId: uid(997) }),
      "ERR_NOT_FOUND"
    );
    expectCode(
      () => records.listConversations({ projectId: P1, query: "q".repeat(513) }),
      "ERR_INVALID_RECORD"
    );
  });
});

describe("draft text fidelity", () => {
  it("round-trips whitespace, newlines, and non-BMP exactly", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "fidelity.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();
    const text = "  leading\ttab\nnewline 🌍 non-BMP  \n";
    const receipt = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 0,
      text,
    });
    expect(receipt).toEqual({
      saveId: S1,
      conversationId: C1,
      status: "saved",
      version: 1,
      conflictId: null,
    });
    const draft = records.getDraft({ projectId: P1, conversationId: C1 });
    expect(draft.text).toBe(text);
    expect(draft.version).toBe(1);
    expect(rawGet(file, "SELECT text, version FROM drafts WHERE conversation_id = ?", [C1])).toMatchObject({
      text,
      version: 1,
    });
  });

  it("rejects embedded NUL on every persisted-text field with no partial rows", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "nul.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    const nul = (s) => `${s.slice(0, 1)}${String.fromCharCode(0)}${s.slice(1)}`;
    // Project name.
    expectCode(
      () => records.createProject({ id: P2, name: nul("beta"), pathCanonical: "/tmp/cho-beta" }),
      "ERR_INVALID_RECORD"
    );
    // Conversation title, model, effort (create and rename paths).
    expectCode(
      () => seedConversation(records, C2, P1, { title: nul("chat") }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, C2, P1, { modelRequested: nul("gpt") }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => seedConversation(records, C2, P1, { effort: nul("high") }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => records.renameConversation({ projectId: P1, conversationId: C1, title: nul("v2") }),
      "ERR_INVALID_RECORD"
    );
    // Draft text (stale-branch NUL is covered in the next test).
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: nul("draft") }),
      "ERR_INVALID_RECORD"
    );
    // Search query.
    expectCode(
      () => records.listConversations({ projectId: P1, query: nul("hi") }),
      "ERR_INVALID_RECORD"
    );
    // Nothing persisted: no conversation, draft, conflict, or receipt.
    expect(records.getConversation({ projectId: P1, conversationId: C2 })).toBeNull();
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(records.listDraftConflicts({ projectId: P1, conversationId: C1 })).toEqual([]);
    expect(rawAll(file, "SELECT id, name FROM projects ORDER BY id")).toEqual([
      { id: P1, name: "alpha" },
    ]);
    expect(rawAll(file, "SELECT conversation_id FROM drafts")).toEqual([]);
    expect(rawAll(file, "SELECT client_save_id FROM draft_conflicts")).toEqual([]);
    expect(rawAll(file, "SELECT id FROM operations")).toEqual([]);
  });

  it("leaves the existing draft untouched after a NUL save attempt", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "nul-stale.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "kept" });
    expectCode(
      () =>
        records.saveDraft({
          projectId: P1,
          conversationId: C1,
          saveId: S2,
          expectedVersion: 1,
          text: `new${String.fromCharCode(0)}text`,
        }),
      "ERR_INVALID_RECORD"
    );
    // Stale-branch NUL attempt also rejects without a conflict row.
    expectCode(
      () =>
        records.saveDraft({
          projectId: P1,
          conversationId: C1,
          saveId: S3,
          expectedVersion: 0,
          text: `stale${String.fromCharCode(0)}text`,
        }),
      "ERR_INVALID_RECORD"
    );
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "kept",
      version: 1,
    });
    expect(records.listDraftConflicts({ projectId: P1, conversationId: C1 })).toEqual([]);
    expect(rawAll(file, "SELECT id FROM operations ORDER BY id")).toEqual([{ id: S1 }]);
  });

  it("accepts the 65536 boundary and empty text; rejects overbound", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "bounds.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    seedConversation(records, C2, P1);
    const max = "x".repeat(65536);
    expect(
      records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: max }).version
    ).toBe(1);
    expect(records.getDraft({ projectId: P1, conversationId: C1 }).text).toBe(max);
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S2, expectedVersion: 1, text: "y".repeat(65537) }),
      "ERR_INVALID_RECORD"
    );
    expect(records.getDraft({ projectId: P1, conversationId: C1 }).version).toBe(1);
    // Empty text is valid and creates version 1.
    const empty = records.saveDraft({
      projectId: P1,
      conversationId: C2,
      saveId: S2,
      expectedVersion: 0,
      text: "",
    });
    expect(empty).toMatchObject({ status: "saved", version: 1 });
    expect(records.getDraft({ projectId: P1, conversationId: C2 }).text).toBe("");
    // A rejected overbound save wrote nothing: no conflict, no operation.
    expect(rawAll(file, "SELECT client_save_id FROM draft_conflicts")).toEqual([]);
    expect(
      rawAll(file, "SELECT id FROM operations WHERE id = ?", [S2]).length
    ).toBe(1); // only the successful empty-text save
  });

  it("creates no rows on read", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "noread.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(rawAll(file, "SELECT conversation_id FROM drafts")).toEqual([]);
    expect(rawAll(file, "SELECT id FROM operations")).toEqual([]);
  });
});

describe("draft versions and idempotent receipts", () => {
  it("increments v1/v2, survives reopen, and replays the original receipt after later edits", () => {
    const dir = tempDir();
    const { file, store, records } = openFresh(dir, "versions.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    const first = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 0,
      text: "v1 text",
    });
    expect(first).toEqual({
      saveId: S1,
      conversationId: C1,
      status: "saved",
      version: 1,
      conflictId: null,
    });
    const second = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S2,
      expectedVersion: 1,
      text: "v2 text",
    });
    expect(second.version).toBe(2);
    // Exact retry of the first save returns the ORIGINAL receipt even
    // though the draft has since moved on; the draft is untouched.
    const replay = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 0,
      text: "v1 text",
    });
    expect(replay).toEqual(first);
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "v2 text",
      version: 2,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openSessionStore({ databasePath: file });
    stores.push(reopened);
    const again = createSessionRecords({ store: reopened });
    expect(again.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "v2 text",
      version: 2,
    });
    expect(
      again.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "v1 text" })
    ).toEqual(first);
  });

  it("rejects same-ID reuse with changed text, chat, or kind", () => {
    const dir = tempDir();
    const { store, records } = openFresh(dir, "reuse.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedProject(records, P2, "beta", "/tmp/cho-beta");
    seedConversation(records, C1, P1);
    seedConversation(records, C2, P1);
    records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "v1" });
    // Same ID, changed text.
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "changed" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Same ID, same text, but a different expected version (different hash).
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 1, text: "v1" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Same ID in another chat of the same project: no cross-chat reuse.
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C2, saveId: S1, expectedVersion: 0, text: "v1" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Seed a non-draft operation id through the trusted store transaction
    // (handoff kind admits NULL turn) to prove kind mismatch rejects.
    store.transaction((tx) => {
      tx.run(
        "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, state, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, NULL, 'handoff', 0, 'completed', ?, ?, ?, ?)",
        [S3, C1, "seed-hash", '{"seeded":true}', 1700000000000, 1700000000000]
      );
    });
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S3, expectedVersion: 1, text: "v1b" }),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // Ownership is checked before the receipt lookup: an unknown chat
    // reports NOT_FOUND even though the save id exists elsewhere.
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: uid(404), saveId: S1, expectedVersion: 0, text: "v1" }),
      "ERR_NOT_FOUND"
    );
    // None of the rejections moved the draft or added rows.
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "v1",
      version: 1,
    });
    expect(records.listDraftConflicts({ projectId: P1, conversationId: C1 })).toEqual([]);
  });
});

describe("stale saves across two independently opened stores", () => {
  it("keeps one current draft, one immutable conflict per stale save, idempotent retries", () => {
    const dir = tempDir();
    const file = dbPath(dir, "two.sqlite3");
    const storeA = openSessionStore({ databasePath: file });
    const storeB = openSessionStore({ databasePath: file });
    stores.push(storeA, storeB);
    const clockA = makeClock(1700000000000);
    const clockB = makeClock(1800000000000);
    const recordsA = createSessionRecords({ store: storeA, now: clockA });
    const recordsB = createSessionRecords({ store: storeB, now: clockB });
    seedProject(recordsA, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(recordsA, C1, P1);
    // B sees the commit made through A: no cached rows outside the DB.
    expect(recordsB.getConversation({ projectId: P1, conversationId: C1 }).id).toBe(C1);

    const winner = recordsA.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 0,
      text: "winner text",
    });
    expect(winner).toMatchObject({ status: "saved", version: 1 });

    const staleB = recordsB.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S2,
      expectedVersion: 0,
      text: "stale from B",
    });
    expect(staleB).toEqual({
      saveId: S2,
      conversationId: C1,
      status: "conflict",
      version: 1,
      conflictId: S2,
    });
    const staleA = recordsA.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S3,
      expectedVersion: 0,
      text: "stale from A",
    });
    expect(staleA.status).toBe("conflict");

    // One current draft survives; each distinct stale save keeps its text.
    expect(recordsB.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "winner text",
      version: 1,
    });
    expect(
      recordsA.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S2 })
    ).toMatchObject({ baseVersion: 0, resolution: "open", text: "stale from B" });
    expect(
      recordsA.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S3 })
    ).toMatchObject({ baseVersion: 0, resolution: "open", text: "stale from A" });

    // Idempotent retries return the original conflict receipts, no new rows.
    expect(
      recordsB.saveDraft({ projectId: P1, conversationId: C1, saveId: S2, expectedVersion: 0, text: "stale from B" })
    ).toEqual(staleB);
    expect(
      rawAll(file, "SELECT client_save_id, base_version, text FROM draft_conflicts ORDER BY client_save_id")
    ).toEqual([
      { client_save_id: S2, base_version: 0, text: "stale from B" },
      { client_save_id: S3, base_version: 0, text: "stale from A" },
    ]);

    // Metadata lists carry no full text and sort by creation then save id.
    const listed = recordsA.listDraftConflicts({ projectId: P1, conversationId: C1 });
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      expect(entry).not.toHaveProperty("text");
      expect(entry.resolution).toBe("open");
    }
    // Independent clocks: clockA (1700000000000 + small ticks) runs far below
    // clockB (1800000000000), so staleA (S3) sorts before staleB (S2) by
    // created_at_ms even though the S2 save ran first.
    expect(listed.map((e) => e.saveId)).toEqual([S3, S2]);
    expect(recordsA.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S1 })).toBeNull();
    expectCode(
      () => recordsA.getDraftConflict({ projectId: P2, conversationId: C1, saveId: S2 }),
      "ERR_NOT_FOUND"
    );

    // Receipts and rows agree: owner_generation 0, NULL turn/host, hash, result, settled.
    const op = rawGet(file, "SELECT * FROM operations WHERE id = ?", [S2]);
    expect(op).toMatchObject({
      conversation_id: C1,
      turn_id: null,
      kind: "draft_save",
      owner_generation: 0,
      host_generation: null,
      state: "completed",
      history_json: "[]",
      payload_hash: expectedHash(P1, C1, 0, "stale from B"),
    });
    expect(JSON.parse(op.result_json)).toEqual(staleB);
    expect(op.settled_at_ms).toBe(op.created_at_ms);
  });

  it("treats expected-nonzero on a missing draft as conflict-only", () => {
    const dir = tempDir();
    const { file, records } = openFresh(dir, "missing.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    const receipt = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 4,
      text: "orphan attempt",
    });
    expect(receipt).toEqual({
      saveId: S1,
      conversationId: C1,
      status: "conflict",
      version: 0,
      conflictId: S1,
    });
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();
    expect(rawAll(file, "SELECT conversation_id FROM drafts")).toEqual([]);
    expect(
      records.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S1 })
    ).toMatchObject({ baseVersion: 4, text: "orphan attempt" });
  });

  it("pages conflict metadata and honors includeResolved", () => {
    const dir = tempDir();
    const { records } = openFresh(dir, "confpage.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "w" });
    // One incremental clock, so creation order is the insertion order.
    const staleSaves = [uid(204), S2, S3];
    for (const saveId of staleSaves) {
      records.saveDraft({ projectId: P1, conversationId: C1, saveId, expectedVersion: 0, text: `stale ${saveId}` });
    }
    const page = records.listDraftConflicts({ projectId: P1, conversationId: C1, limit: 2, offset: 1 });
    expect(page.map((e) => e.saveId)).toEqual([S2, S3]);
    expect(
      records.listDraftConflicts({ projectId: P1, conversationId: C1, includeResolved: true })
    ).toHaveLength(3);
    expectCode(
      () => records.listDraftConflicts({ projectId: P1, conversationId: C1, limit: 101 }),
      "ERR_INVALID_RECORD"
    );
  });
});

describe("atomicity, version limit, and closed stores", () => {
  it("rolls back draft, conflict, and receipt together when the receipt write aborts", () => {
    const dir = tempDir();
    const { file, store, records } = openFresh(dir, "atomic.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();

    // Deterministic abort fixture: a TEMP trigger that fails the operations
    // insert after the draft/conflict mutation already ran. Added through a
    // second connection while the store stays open (admission only runs at
    // open), and dropped the same way before close/reopen.
    const raw = openRaw(file);
    try {
      raw.exec(
        "CREATE TRIGGER fail_ops_abort BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fail-ops'); END;"
      );
      const error = expectCode(
        () =>
          records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "doomed" }),
        "ERR_STORAGE"
      );
      expect(String(error.message)).not.toContain("doomed");
      expect(records.getDraft({ projectId: P1, conversationId: C1 })).toBeNull();
      expect(records.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S1 })).toBeNull();
      expect(records.listDraftConflicts({ projectId: P1, conversationId: C1 })).toEqual([]);
    } finally {
      raw.exec("DROP TRIGGER fail_ops_abort");
      raw.close();
    }
    // Independent read-back: nothing from the aborted attempt persisted.
    expect(rawAll(file, "SELECT conversation_id FROM drafts")).toEqual([]);
    expect(rawAll(file, "SELECT client_save_id FROM draft_conflicts")).toEqual([]);
    expect(rawAll(file, "SELECT id FROM operations")).toEqual([]);
    // The store is fully usable afterwards, including across reopen
    // (S1 rejects a mismatched schema, so the dropped trigger matters).
    const receipt = records.saveDraft({
      projectId: P1,
      conversationId: C1,
      saveId: S1,
      expectedVersion: 0,
      text: "doomed",
    });
    expect(receipt).toMatchObject({ status: "saved", version: 1 });
    // Same abort fixture against the conflict branch: a stale save must
    // roll back the conflict row and the receipt together.
    const rawConflict = openRaw(file);
    try {
      rawConflict.exec(
        "CREATE TRIGGER fail_ops_abort BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fail-ops'); END;"
      );
      expectCode(
        () =>
          records.saveDraft({ projectId: P1, conversationId: C1, saveId: S2, expectedVersion: 0, text: "doomed stale" }),
        "ERR_STORAGE"
      );
      expect(records.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S2 })).toBeNull();
      expect(records.listDraftConflicts({ projectId: P1, conversationId: C1 })).toEqual([]);
    } finally {
      rawConflict.exec("DROP TRIGGER fail_ops_abort");
      rawConflict.close();
    }
    // Only the successful S1 rows survived both aborted attempts.
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "doomed",
      version: 1,
    });
    expect(rawAll(file, "SELECT client_save_id FROM draft_conflicts")).toEqual([]);
    expect(rawAll(file, "SELECT id FROM operations")).toEqual([{ id: S1 }]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openSessionStore({ databasePath: file });
    stores.push(reopened);
    expect(
      createSessionRecords({ store: reopened }).getDraft({ projectId: P1, conversationId: C1 }).text
    ).toBe("doomed");
  });

  it("refuses to wrap the draft version past MAX_SAFE_INTEGER", () => {
    const dir = tempDir();
    const { file, store, records } = openFresh(dir, "versions-limit.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    const top = Number.MAX_SAFE_INTEGER;
    store.transaction((tx) => {
      tx.run("INSERT INTO drafts(conversation_id, text, version, updated_at_ms) VALUES (?, ?, ?, ?)", [
        C1,
        "seeded top",
        top,
        1700000000000,
      ]);
    });
    expectCode(
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: top, text: "wrap" }),
      "ERR_VERSION_LIMIT"
    );
    expect(records.getDraft({ projectId: P1, conversationId: C1 })).toMatchObject({
      text: "seeded top",
      version: top,
    });
    expect(rawAll(file, "SELECT id FROM operations")).toEqual([]);
    expect(rawAll(file, "SELECT client_save_id FROM draft_conflicts")).toEqual([]);
  });

  it("passes ERR_CLOSED through after the store closes", () => {
    const dir = tempDir();
    const { store, records } = openFresh(dir, "closed.sqlite3");
    seedProject(records, P1, "alpha", "/tmp/cho-alpha");
    seedConversation(records, C1, P1);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const calls = [
      () => records.getProject({ projectId: P1 }),
      () => records.listProjects(),
      () => records.createProject({ id: P2, name: "b", pathCanonical: "/tmp/cho-b" }),
      () => records.setProjectArchived({ projectId: P1, archived: true }),
      () => records.createConversation({ id: C2, projectId: P1, controller: "codex" }),
      () => records.getConversation({ projectId: P1, conversationId: C1 }),
      () => records.listConversations({ projectId: P1 }),
      () => records.renameConversation({ projectId: P1, conversationId: C1, title: "x" }),
      () => records.setConversationArchived({ projectId: P1, conversationId: C1, archived: true }),
      () => records.getDraft({ projectId: P1, conversationId: C1 }),
      () =>
        records.saveDraft({ projectId: P1, conversationId: C1, saveId: S1, expectedVersion: 0, text: "x" }),
      () => records.listDraftConflicts({ projectId: P1, conversationId: C1 }),
      () => records.getDraftConflict({ projectId: P1, conversationId: C1, saveId: S1 }),
    ];
    for (const call of calls) expectCode(call, "ERR_CLOSED");
  });
});
