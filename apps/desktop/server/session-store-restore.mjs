// Explicit offline restore/clone to a NEW path. Never replaces a live store.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore } from "./session-store.mjs";

export function restoreSessionStore({ sourcePath, databasePath }) {
  if (![sourcePath, databasePath].every((p) => typeof p === "string" && path.isAbsolute(p))) {
    throw new Error("ERR_BAD_PATH: restore requires absolute source and destination paths");
  }
  if (path.resolve(sourcePath).toLowerCase() === path.resolve(databasePath).toLowerCase()) {
    throw new Error("ERR_BAD_PATH: restore destination must be a new path");
  }
  for (const suffix of ["", "-wal", "-shm", ".migrate.lock"]) {
    if (fs.existsSync(databasePath + suffix)) throw new Error("ERR_BUSY: restore destination already exists");
  }
  const stage = path.join(path.dirname(databasePath), `.cho-restore-${randomUUID()}.sqlite3`);
  let reader, writer, checked;
  try {
    reader = new DatabaseSync(sourcePath, { readOnly: true });
    // SQLite creates a consistent snapshot, including committed WAL contents.
    reader.exec(`VACUUM INTO '${stage.replace(/'/g, "''")}'`);
    reader.close(); reader = null;
    checked = openSessionStore({ databasePath: stage });
    const priorInstanceId = checked.instanceId;
    checked.close(); checked = null;
    const instanceId = randomUUID();
    writer = new DatabaseSync(stage);
    writer.exec("PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE");
    writer.prepare("UPDATE meta SET instance_uuid = ?").run(instanceId);
    writer.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close(); writer = null;
    checked = openSessionStore({ databasePath: stage });
    if (checked.instanceId !== instanceId) throw new Error("ERR_STORAGE: restored identity did not rotate");
    checked.close(); checked = null;
    // Atomic, no-overwrite publication on the destination volume. A concurrent
    // creator wins safely; no source bytes or existing destination are replaced.
    fs.linkSync(stage, databasePath);
    return { databasePath, instanceId, priorInstanceId };
  } finally {
    try { checked?.close(); } catch { /* retain original error */ }
    try { writer?.close(); } catch { /* retain original error */ }
    try { reader?.close(); } catch { /* retain original error */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(stage + suffix); } catch { /* absent or retained for inspection */ }
    }
  }
}
