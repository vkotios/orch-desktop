import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  SESSION_STORE_APPLICATION_ID,
  SESSION_STORE_SCHEMA_SQL,
} from "../server/session-store-schema.mjs";
import { openSessionStore } from "../server/session-store.mjs";
import { migrateSessionStore } from "../server/session-store-migrate.mjs";

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-migrate-"));
  return path.join(dir, name);
}

function craftV1Database(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // v1 DDL was the schema without schema_migrations.
  const v1Sql = SESSION_STORE_SCHEMA_SQL.replace(
    /CREATE TABLE schema_migrations\([\s\S]*?\);\n?/,
    "",
  );
  db.exec(v1Sql);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO meta(application_id, instance_uuid, schema_version, created_at_ms) VALUES (?, ?, ?, ?)",
  ).run(SESSION_STORE_APPLICATION_ID, id, 1, Date.now());
  db.exec("PRAGMA user_version = 1");
  db.close();
  return id;
}

describe("session-store migrate", () => {
  it("backs up, migrates v1 to current, and opens cleanly", () => {
    const file = tempDb("migrate-ok.sqlite3");
    const instanceId = craftV1Database(file);
    const before = fs.readFileSync(file);
    const result = migrateSessionStore({ databasePath: file });
    expect(result.noop).toBe(false);
    expect(result.applied).toContain("2026-11-06-schema-migrations-table");
    expect(fs.existsSync(result.backupPath)).toBe(true);
    // VACUUM INTO is a consistent logical snapshot, not necessarily byte-identical.
    const backup = new DatabaseSync(result.backupPath);
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    backup.close();
    expect(before.length).toBeGreaterThan(0);
    const store = openSessionStore({ databasePath: file });
    expect(store.instanceId).toBe(instanceId);
    expect(store.schemaVersion).toBe(2);
    store.close();
  });

  it("leaves the live database unchanged when a migration step fails", () => {
    const file = tempDb("migrate-fail.sqlite3");
    craftV1Database(file);
    // Pre-create a conflicting table so the v1→v2 DDL cannot apply.
    const poison = new DatabaseSync(file);
    poison.exec("CREATE TABLE schema_migrations(version INTEGER)");
    poison.close();
    const before = fs.readFileSync(file);
    expect(() => migrateSessionStore({ databasePath: file })).toThrow(/left unchanged|already exists|migration/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // Still fail-closed for open: not at current schema.
    expect(() => openSessionStore({ databasePath: file })).toThrow(/migrateSessionStore|schema/);
  });

  it("does not erase a concurrent committed write after a failed migrate", () => {
    const file = tempDb("migrate-concurrent.sqlite3");
    craftV1Database(file);
    const poison = new DatabaseSync(file);
    poison.exec("CREATE TABLE schema_migrations(version INTEGER)");
    poison.close();
    // Competing writer commits after the file exists (simulates post-backup write).
    const writer = new DatabaseSync(file);
    writer.exec(
      "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path_canonical TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0)",
    );
    writer
      .prepare(
        "INSERT OR IGNORE INTO projects(id, name, path_canonical, created_at_ms, archived) VALUES (?, ?, ?, ?, 0)",
      )
      .run("11111111-1111-4111-8111-111111111111", "kept", "C:/kept", Date.now());
    writer.close();
    expect(() => migrateSessionStore({ databasePath: file })).toThrow();
    const check = new DatabaseSync(file);
    const row = check
      .prepare("SELECT name FROM projects WHERE path_canonical = ?")
      .get("C:/kept");
    check.close();
    expect(row?.name).toBe("kept");
  });

  it("is a noop when already at the current schema", () => {
    const file = tempDb("migrate-noop.sqlite3");
    const store = openSessionStore({ databasePath: file });
    store.close();
    const result = migrateSessionStore({ databasePath: file });
    expect(result.noop).toBe(true);
    expect(result.applied).toEqual([]);
  });

  it("recovers a crash-left migration lock owned by a dead pid", () => {
    const file = tempDb("migrate-stale-lock.sqlite3");
    craftV1Database(file);
    const lockPath = `${file}.migrate.lock`;
    // Synthetic dead owner: pid that is extremely unlikely to be alive.
    fs.writeFileSync(lockPath, "2147483646\n1\n", "utf8");
    const result = migrateSessionStore({ databasePath: file });
    expect(result.noop).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    const store = openSessionStore({ databasePath: file });
    expect(store.schemaVersion).toBe(2);
    store.close();
  });

  it("refuses to steal a migration lock owned by a live pid", { timeout: 15_000 }, () => {
    const file = tempDb("migrate-live-lock.sqlite3");
    craftV1Database(file);
    const lockPath = `${file}.migrate.lock`;
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    expect(() => migrateSessionStore({ databasePath: file })).toThrow(/ERR_BUSY|lock held/);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
  });
});
