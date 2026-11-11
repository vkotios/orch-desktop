import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionStore } from "../server/session-store.mjs";
import { restoreSessionStore } from "../server/session-store-restore.mjs";

it("clones committed WAL history with a new cursor identity and preserves owner fences", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-restore-"));
  let source, clone;
  try {
    const sourcePath = path.join(dir, "source.sqlite3");
    const databasePath = path.join(dir, "clone.sqlite3");
    source = openSessionStore({ databasePath: sourcePath });
    source.transaction((tx) => {
      tx.run("INSERT INTO projects VALUES (?, ?, ?, ?, ?)", ["p", "retained", "C:/synthetic", 1, 0]);
      tx.run("INSERT INTO conversations(id, project_id, controller, created_at_ms, updated_at_ms) VALUES ('c', 'p', 'codex', 1, 1)");
      tx.run("INSERT INTO producer_fences VALUES ('c', 'prior-owner', 7, 'held', 1)");
    });
    const result = restoreSessionStore({ sourcePath, databasePath });
    expect(result.priorInstanceId).toBe(source.instanceId);
    expect(result.instanceId).not.toBe(source.instanceId);
    clone = openSessionStore({ databasePath });
    expect(clone.instanceId).toBe(result.instanceId);
    expect(clone.transaction((tx) => tx.get("SELECT owner_token, generation, state FROM producer_fences"))).toEqual({ owner_token: "prior-owner", generation: 7, state: "held" });
    expect(clone.transaction((tx) => tx.get("SELECT name FROM projects WHERE id = ?", ["p"]))).toEqual({ name: "retained" });
    expect(source.transaction((tx) => tx.get("SELECT instance_uuid FROM meta")).instance_uuid).toBe(source.instanceId);
    const before = fs.readFileSync(databasePath);
    expect(() => restoreSessionStore({ sourcePath, databasePath })).toThrow(/already exists/);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(() => restoreSessionStore({ sourcePath, databasePath: sourcePath })).toThrow(/new path/);
  } finally {
    clone?.close(); source?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses a foreign snapshot without publishing a destination or modifying the source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-restore-foreign-"));
  try {
    const sourcePath = path.join(dir, "foreign.sqlite3"), databasePath = path.join(dir, "restore.sqlite3");
    fs.writeFileSync(sourcePath, "not a CHO database");
    expect(() => restoreSessionStore({ sourcePath, databasePath })).toThrow();
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("not a CHO database");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
