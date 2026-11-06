// Exclusive backup-then-migrate-then-verify for the CHO session store.
// openSessionStore remains fail-closed on version mismatch; callers must
// migrate explicitly before reopen. Controlled failures roll back the
// migration transaction and never overwrite a live DB from a stale backup.

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

function sleepMs(ms) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* spin */
  }
}

function migrationLockPath(databasePath) {
  return `${databasePath}.migrate.lock`;
}

function withMigrationLock(databasePath, fn) {
  const lockPath = migrationLockPath(databasePath);
  let fd = null;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new Error('ERR_BUSY: session store migration lock held');
      }
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
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

function integrityOk(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  if (!row || typeof row !== 'object') return false;
  const value = row.integrity_check ?? Object.values(row)[0];
  return value === 'ok';
}

/**
 * Consistent SQLite backup via VACUUM INTO (single-file snapshot).
 * Must not run inside an open write transaction.
 */
function consistentBackup(db, databasePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${databasePath}.bak-${stamp}`;
  if (fs.existsSync(backupPath)) {
    throw new Error('ERR_STORAGE: backup path already exists');
  }
  const escaped = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return backupPath;
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
  return withMigrationLock(databasePath, () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 100');
      // Serialize writers briefly before snapshotting.
      db.exec('BEGIN EXCLUSIVE');
      db.exec('COMMIT');
      const backupPath = consistentBackup(db, databasePath);
      return { backupPath };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  });
}

/**
 * Migrate an on-disk session store to targetVersion (default: current code).
 * Already-current databases are a no-op with no backup/restore side effects.
 * Controlled migration failures roll back the exclusive transaction and leave
 * the live database untouched (backup is retained for operator recovery only).
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

  return withMigrationLock(databasePath, () => {
    let db;
    let backupPath = null;
    try {
      db = new DatabaseSync(databasePath);
      db.exec('PRAGMA busy_timeout = 100');

      db.exec('BEGIN EXCLUSIVE');
      let version = readVersion(db);
      if (version === targetVersion) {
        db.exec('COMMIT');
        db.close();
        db = null;
        return {
          databasePath,
          backupPath: null,
          fromVersion: version,
          toVersion: version,
          applied: [],
          noop: true,
        };
      }
      if (version > targetVersion) {
        throw new Error('ERR_FUTURE_VERSION: database newer than target');
      }
      // End the lock probe before VACUUM INTO (cannot run inside a transaction).
      db.exec('COMMIT');

      backupPath = consistentBackup(db, databasePath);

      db.exec('BEGIN EXCLUSIVE');
      version = readVersion(db);
      if (version === targetVersion) {
        db.exec('COMMIT');
        db.close();
        db = null;
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
      const fromVersion = version;
      while (version < targetVersion) {
        const step = SESSION_STORE_MIGRATIONS.find((m) => m.from === version && m.to === version + 1);
        if (!step) {
          throw new Error(`ERR_SCHEMA_MISMATCH: no migration from v${version}`);
        }
        db.exec(step.sql);
        if (step.to >= 2) {
          db.prepare(
            'INSERT OR IGNORE INTO schema_migrations(version, migration_id, applied_at_ms) VALUES (?, ?, ?)',
          ).run(step.to, step.id, Date.now());
        }
        db.prepare('UPDATE meta SET schema_version = ?').run(step.to);
        db.exec(`PRAGMA user_version = ${step.to}`);
        applied.push(step.id);
        version = step.to;
      }

      const verified = readVersion(db);
      if (verified !== targetVersion) {
        throw new Error('ERR_SCHEMA_MISMATCH: post-migration version verify failed');
      }
      db.exec('COMMIT');
      if (!integrityOk(db)) {
        throw new Error('ERR_STORAGE: integrity_check failed after migration');
      }
      db.close();
      db = null;
      return {
        databasePath,
        backupPath,
        fromVersion,
        toVersion: targetVersion,
        applied,
        noop: false,
      };
    } catch (err) {
      try { db?.exec('ROLLBACK'); } catch { /* ignore */ }
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      // Never copy a pre-migration snapshot over the live DB: concurrent
      // committed writes after an unlocked backup must not be erased.
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        backupPath
          ? `${message}. Live database left unchanged; operator backup at ${backupPath}.`
          : message,
      );
      wrapped.cause = err;
      throw wrapped;
    }
  });
}
