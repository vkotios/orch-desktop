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
    expect(fs.readFileSync(result.backupPath).equals(before)).toBe(true);
    const store = openSessionStore({ databasePath: file });
    expect(store.instanceId).toBe(instanceId);
    expect(store.schemaVersion).toBe(2);
    store.close();
  });

  it("restores the backup when a migration step fails", () => {
    const file = tempDb("migrate-fail.sqlite3");
    craftV1Database(file);
    // Pre-create a conflicting table so the v1→v2 DDL cannot apply.
    const poison = new DatabaseSync(file);
    poison.exec("CREATE TABLE schema_migrations(version INTEGER)");
    poison.close();
    const before = fs.readFileSync(file);
    expect(() => migrateSessionStore({ databasePath: file })).toThrow(/restored from backup/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // Still fail-closed for open: not at current schema.
    expect(() => openSessionStore({ databasePath: file })).toThrow(/migrateSessionStore|schema/);
  });

  it("is a noop when already at the current schema", () => {
    const file = tempDb("migrate-noop.sqlite3");
    const store = openSessionStore({ databasePath: file });
    store.close();
    const result = migrateSessionStore({ databasePath: file });
    expect(result.noop).toBe(true);
    expect(result.applied).toEqual([]);
  });
});
