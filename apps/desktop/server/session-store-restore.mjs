// Explicit offline restore/clone to a NEW path. Never replaces a live store.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore } from "./session-store.mjs";

export function restoreSessionStore({ sourcePath, databasePath, resetNativeOwnership = false }) {
  if (typeof resetNativeOwnership !== "boolean") throw new Error("resetNativeOwnership requires explicit true or false");
  if (![sourcePath, databasePath].every((p) => typeof p === "string" && path.isAbsolute(p))) {
    throw new Error("ERR_BAD_PATH: restore requires absolute source and destination paths");
  }
  if (path.resolve(sourcePath).toLowerCase() === path.resolve(databasePath).toLowerCase()) {
    throw new Error("ERR_BAD_PATH: restore destination must be a new path");
  }
  for (const suffix of ["", "-wal", "-shm", ".migrate.lock", ".restore.json"]) {
    if (fs.existsSync(databasePath + suffix)) throw new Error("ERR_BUSY: restore destination already exists");
  }
  const stage = path.join(path.dirname(databasePath), `.cho-restore-${randomUUID()}.sqlite3`);
  let reader, writer, checked, receiptOwned = false, published = false;
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
    let copiedFencesReleased = 0;
    if (resetNativeOwnership) {
      // Explicitly continue the CLONE in a fresh provider context. This does not
      // assert that the source owner or its operations stopped. Pending original
      // journals remain available for the normal unknown-outcome acknowledgement.
      copiedFencesReleased = Number(writer.prepare("UPDATE producer_fences SET state = 'released' WHERE state = 'held'").run().changes);
      writer.exec("DELETE FROM native_refs; UPDATE conversations SET requested_claude_session_uuid = NULL");
    }
    writer.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close(); writer = null;
    checked = openSessionStore({ databasePath: stage });
    if (checked.instanceId !== instanceId) throw new Error("ERR_STORAGE: restored identity did not rotate");
    checked.close(); checked = null;
    // Atomic, no-overwrite publication on the destination volume. A concurrent
    // creator wins safely; no source bytes or existing destination are replaced.
    const receipt = { databasePath, instanceId, priorInstanceId, resetNativeOwnership, copiedFencesReleased, nativeContextResumed: false };
    // Audit receipt only; authority is the rotated identity and fences in SQLite.
    fs.writeFileSync(`${databasePath}.restore.json`, JSON.stringify(receipt, null, 2), { flag: "wx" });
    receiptOwned = true;
    fs.linkSync(stage, databasePath);
    published = true;
    return receipt;
  } finally {
    try { checked?.close(); } catch { /* retain original error */ }
    try { writer?.close(); } catch { /* retain original error */ }
    try { reader?.close(); } catch { /* retain original error */ }
    if (receiptOwned && !published) { try { fs.unlinkSync(`${databasePath}.restore.json`); } catch { /* preserve on cleanup failure */ } }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(stage + suffix); } catch { /* absent or retained for inspection */ }
    }
  }
}
