// Backup-then-migrate-then-verify for the CHO session store.
// openSessionStore remains fail-closed on version mismatch; callers must
// migrate explicitly before reopen. A failed migration restores the backup.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SESSION_STORE_APPLICATION_ID,
  SESSION_STORE_SCHEMA_VERSION,
} from './session-store-schema.mjs';

/**
 * Ordered migrations. Each step advances schema_version by exactly one.
 * v1 → v2 adds an audit table recording applied migrations (additive).
 */
export const SESSION_STORE_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: 1,
    to: 2,
    id: '2026-11-06-schema-migrations-table',
    // DDL text must match session-store-schema.mjs exactly so assertExpectedSchema passes.
    sql: `CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  migration_id TEXT NOT NULL UNIQUE,
  applied_at_ms INTEGER NOT NULL);`,
  }),
]);

function copyDatabase(src, dest) {
  fs.copyFileSync(src, dest);
  for (const suffix of ['-wal', '-shm']) {
    const side = `${src}${suffix}`;
    if (fs.existsSync(side)) fs.copyFileSync(side, `${dest}${suffix}`);
  }
}

function readVersion(db) {
  const meta = db.prepare(
    'SELECT application_id, schema_version FROM meta',
  ).get();
  if (!meta || meta.application_id !== SESSION_STORE_APPLICATION_ID) {
    throw new Error('ERR_FOREIGN_DB: not a CHO session store');
  }
  const userVersion = db.prepare('PRAGMA user_version').get()?.user_version;
  if (userVersion !== meta.schema_version) {
    throw new Error('ERR_SCHEMA_MISMATCH: user_version does not mirror meta');
  }
  return meta.schema_version;
}

/**
 * @param {{ databasePath: string, targetVersion?: number }} options
 */
export function backupSessionStore({ databasePath }) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    throw new Error('ERR_BAD_PATH: databasePath must be absolute');
  }
  if (!fs.existsSync(databasePath)) {
    throw new Error('ERR_BAD_PATH: database does not exist');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${databasePath}.bak-${stamp}`;
  copyDatabase(databasePath, backupPath);
  return { backupPath };
}

/**
 * Migrate an on-disk session store to targetVersion (default: current code).
 * On failure the original file bytes are restored from the backup.
 */
export function migrateSessionStore({
  databasePath,
  targetVersion = SESSION_STORE_SCHEMA_VERSION,
}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    throw new Error('ERR_BAD_PATH: databasePath must be absolute');
  }
  if (!fs.existsSync(databasePath)) {
    throw new Error('ERR_BAD_PATH: database does not exist');
  }
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error('ERR_SCHEMA_MISMATCH: invalid targetVersion');
  }
  if (targetVersion > SESSION_STORE_SCHEMA_VERSION) {
    throw new Error('ERR_FUTURE_VERSION: target newer than this code');
  }

  const { backupPath } = backupSessionStore({ databasePath });
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA busy_timeout = 100');
    let version = readVersion(db);
    if (version === targetVersion) {
      db.close();
      return {
        databasePath,
        backupPath,
        fromVersion: version,
        toVersion: version,
        applied: [],
        noop: true,
      };
    }
    if (version > targetVersion) {
      throw new Error('ERR_FUTURE_VERSION: database newer than target');
    }

    const applied = [];
    while (version < targetVersion) {
      const step = SESSION_STORE_MIGRATIONS.find((m) => m.from === version && m.to === version + 1);
      if (!step) {
        throw new Error(`ERR_SCHEMA_MISMATCH: no migration from v${version}`);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(step.sql);
        if (step.to >= 2) {
          db.prepare(
            'INSERT OR IGNORE INTO schema_migrations(version, migration_id, applied_at_ms) VALUES (?, ?, ?)',
          ).run(step.to, step.id, Date.now());
        }
        db.prepare('UPDATE meta SET schema_version = ?').run(step.to);
        db.exec(`PRAGMA user_version = ${step.to}`);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      applied.push(step.id);
      version = step.to;
    }

    const verified = readVersion(db);
    if (verified !== targetVersion) {
      throw new Error('ERR_SCHEMA_MISMATCH: post-migration version verify failed');
    }
    db.close();
    db = null;
    return {
      databasePath,
      backupPath,
      fromVersion: targetVersion - applied.length,
      toVersion: targetVersion,
      applied,
      noop: false,
    };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    // Restore prior bytes so a failed migration never leaves a half-applied DB.
    copyDatabase(backupPath, databasePath);
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `${message}. Prior database restored from backup ${backupPath}.`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}
