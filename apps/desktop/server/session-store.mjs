// CHO-03 S1 session store core: standalone SQLite schema/lifecycle plus a
// guarded synchronous transaction boundary. No UI, IPC, provider wiring, or
// provider start. No records CRUD: transactions expose scoped run/get/all
// helpers for trusted internal SQL only (never a new IPC SQL endpoint).
//
// Surface: openSessionStore({ databasePath }) -> frozen
// { instanceId, schemaVersion, transaction(fn), close }.
// Importing this module opens no files and starts no providers.
//
// Programmer callback errors propagate unchanged after rollback (documented
// choice: the store never swallows or rewrites the caller's own error; only
// SQLite I/O failures are translated to ERR_BUSY / ERR_STORAGE).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SESSION_STORE_APPLICATION_ID,
  SESSION_STORE_SCHEMA_VERSION,
  SESSION_STORE_SCHEMA_SQL,
} from "./session-store-schema.mjs";

export const SESSION_STORE_BUSY_TIMEOUT_MS = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_ERROR = Symbol("choSessionStoreError");

function storeError(code, message) {
  // Public store errors carry stable generic messages and codes only: no SQL
  // text, bound values, table/column literals, paths, or SQLite diagnostics.
  // Bound parameters are never interpolated anywhere because every statement
  // uses bound values. Programmer callback errors propagate unchanged after
  // rollback and never pass through here.
  const error = new Error(message);
  error.code = code;
  error[STORE_ERROR] = true;
  return error;
}

const errBadPath = (detail) =>
  storeError("ERR_BAD_PATH", `session store requires an absolute database file path (${detail})`);
const errForeignDb = () =>
  storeError("ERR_FOREIGN_DB", "session store refuses foreign database (application id mismatch)");
const errFutureVersion = () =>
  storeError("ERR_FUTURE_VERSION", "session store refuses newer schema version than this code supports");
const errSchemaMismatch = (detail) =>
  storeError("ERR_SCHEMA_MISMATCH", `session store refuses database with schema mismatch (${detail})`);
const errBusy = () =>
  storeError("ERR_BUSY", "session store is busy (bounded lock wait exceeded)");
const errStorage = (detail) =>
  storeError("ERR_STORAGE", `session store I/O failure (${detail})`);
const errClosed = () => storeError("ERR_CLOSED", "session store is closed");
const errInvalidTx = (detail) =>
  storeError("ERR_INVALID_TX", `invalid session store transaction use (${detail})`);

function isBusyLike(error) {
  if (!error || typeof error !== "object") return false;
  for (const candidate of [error.errcode, error.extendedErrcode, error.extendedCode]) {
    const n = Number(candidate);
    if (Number.isInteger(n)) {
      const primary = n & 0xff;
      if (primary === 5 || primary === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
    }
  }
  if (typeof error.code === "string" && /BUSY|LOCKED/i.test(error.code)) return true;
  if (typeof error.message === "string" && /database is (locked|busy)/i.test(error.message)) return true;
  return false;
}

// Translate a raw SQLite failure. Already-coded store errors pass through
// untouched so transaction helper failures are never double-wrapped.
function mapIoError(error, detail) {
  if (error && error[STORE_ERROR]) return error;
  if (isBusyLike(error)) return errBusy();
  return errStorage(detail);
}

function assertDatabasePath(databasePath) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw errBadPath("missing or non-string path");
  }
  if (databasePath.includes("\0")) throw errBadPath("NUL byte in path");
  if (databasePath === ":memory:" || databasePath.includes(":memory:")) {
    throw errBadPath("in-memory database is not admitted");
  }
  if (!path.isAbsolute(databasePath)) throw errBadPath("path is not absolute");
  // Windows drive-letter absolutes (C:\...) never contain "://"; anything with
  // a URI scheme prefix at this point is a URI, not a file path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(databasePath) || /^file:/i.test(databasePath)) {
    throw errBadPath("URI database path is not admitted");
  }
}

function validateIdentity(rows, userVersion) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw errSchemaMismatch("meta singleton row missing or duplicated");
  }
  const meta = rows[0];
  if (!meta || typeof meta !== "object") throw errSchemaMismatch("meta row unreadable");
  if (meta.application_id !== SESSION_STORE_APPLICATION_ID) throw errForeignDb();
  if (!Number.isInteger(meta.schema_version)) throw errSchemaMismatch("meta schema version is not an integer");
  if (meta.schema_version > SESSION_STORE_SCHEMA_VERSION) throw errFutureVersion();
  if (meta.schema_version !== SESSION_STORE_SCHEMA_VERSION) {
    throw errSchemaMismatch("meta schema version does not match this code (no auto-migration)");
  }
  if (userVersion !== meta.schema_version) {
    throw errSchemaMismatch("user_version does not mirror meta schema version");
  }
  if (typeof meta.instance_uuid !== "string" || !UUID_RE.test(meta.instance_uuid)) {
    throw errSchemaMismatch("meta instance UUID malformed");
  }
  if (!Number.isInteger(meta.created_at_ms) || meta.created_at_ms < 0) {
    throw errSchemaMismatch("meta creation timestamp malformed");
  }
  return meta.instance_uuid;
}

function readUserVersion(db) {
  let row;
  try {
    row = db.prepare("PRAGMA user_version").get();
  } catch (error) {
    // Contention must surface as ERR_BUSY, never as corruption.
    if (isBusyLike(error)) throw errBusy();
    throw errSchemaMismatch("database header unreadable");
  }
  const version = row?.user_version;
  if (!Number.isInteger(version) || version < 0) throw errSchemaMismatch("user_version unreadable");
  return version;
}

function readMetaRows(db) {
  try {
    return db.prepare(
      "SELECT application_id, instance_uuid, schema_version, created_at_ms FROM meta"
    ).all();
  } catch (error) {
    // Contention must surface as ERR_BUSY, never as corruption.
    if (isBusyLike(error)) throw errBusy();
    throw errSchemaMismatch("meta table missing or unreadable");
  }
}

// Canonical sqlite_schema manifest: (type, name, table, DDL text) for every
// non-internal object. Covers missing tables/columns/indices/constraints and
// triggers with no SQL parser: the engine normalizes the DDL itself.
function readSchemaManifest(db) {
  let rows;
  try {
    rows = db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name, tbl_name"
    ).all();
  } catch (error) {
    if (isBusyLike(error)) throw errBusy();
    throw errSchemaMismatch("database schema unreadable");
  }
  return rows.map((row) => `${row.type}|${row.name}|${row.tbl_name}|${row.sql ?? ""}`).join("\n");
}

// Expected manifest, generated once from the accepted DDL in a throwaway
// in-memory database (no files) and reused for every admission check, never
// rebuilt per helper query.
let cachedExpectedSchemaManifest = null;
function expectedSchemaManifest() {
  if (cachedExpectedSchemaManifest === null) {
    const mem = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      mem.exec(SESSION_STORE_SCHEMA_SQL);
      cachedExpectedSchemaManifest = readSchemaManifest(mem);
    } finally {
      mem.close();
    }
  }
  return cachedExpectedSchemaManifest;
}

// Refuse any table/index/trigger/schema shape that does not match the
// accepted DDL. Runs before persistent writes; never repairs.
function assertExpectedSchema(db) {
  if (readSchemaManifest(db) !== expectedSchemaManifest()) {
    throw errSchemaMismatch("database schema does not match the accepted schema");
  }
}

// True when the database holds no user objects at all (engine internals ignored).
function isUserSchemaEmpty(db) {
  let row;
  try {
    row = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'"
    ).get();
  } catch (error) {
    if (isBusyLike(error)) throw errBusy();
    throw errSchemaMismatch("database schema unreadable under write lock");
  }
  return (row?.n ?? 0) === 0;
}

// Admission gate for existing nonempty files. Uses a read-only connection so
// refused foreign/future/malformed files are never modified (no WAL, DDL,
// user_version, or data writes happen before this gate passes). Identity
// (foreign/future) is checked before schema shape so typed refusals keep
// precedence; the same identity+shape gate re-runs under the write lock.
function preflightExistingDatabase(databasePath) {
  let probe;
  try {
    probe = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
  } catch (error) {
    throw classifyOpenError(error);
  }
  try {
    try {
      // Connection-scoped wait policy, mirroring the read-write connection.
      probe.exec(`PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS}`);
    } catch (error) {
      // A garbage file can fail on first touch here: keep the
      // corrupt-header verdict instead of reporting I/O failure.
      throw classifyOpenError(error);
    }
    const userVersion = readUserVersion(probe);
    if (userVersion === 0) throw errSchemaMismatch("nonempty database has version 0");
    const identity = validateIdentity(readMetaRows(probe), userVersion);
    assertExpectedSchema(probe);
    return identity;
  } finally {
    try {
      probe.close();
    } catch {
      /* closing a failed probe must not mask the admission error */
    }
  }
}

// Read-only open failures: contention stays ERR_BUSY, corrupt/unreadable
// headers stay ERR_SCHEMA_MISMATCH, and real I/O failures become ERR_STORAGE.
function classifyOpenError(error) {
  if (error && error[STORE_ERROR]) return error;
  if (isBusyLike(error)) return errBusy();
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/not a database|malformed|corrupt|header/i.test(message)) {
    return errSchemaMismatch("existing database is not a readable database file");
  }
  return errStorage("existing database cannot be opened");
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* best effort: opening failed, nothing to report beyond the real error */
  }
}

function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* a failed rollback must not mask the original error */
  }
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function consumeRejection(thenable) {
  try {
    thenable.then(undefined, () => {});
  } catch {
    /* a throwing `then` accessor must not mask the transaction error */
  }
}

export function openSessionStore(options) {
  const databasePath = options?.databasePath;
  assertDatabasePath(databasePath);

  let fresh = false;
  try {
    const stat = statSync(databasePath);
    if (!stat.isFile()) throw errBadPath("path is not a regular file");
    fresh = stat.size === 0;
  } catch (error) {
    if (error && error[STORE_ERROR]) throw error;
    if (error?.code === "ENOENT") {
      fresh = true;
    } else {
      throw errStorage("cannot stat database path");
    }
  }

  if (!fresh) {
    // Throws ERR_FOREIGN_DB / ERR_FUTURE_VERSION / ERR_SCHEMA_MISMATCH with
    // the file bytes untouched; the read-write connection below is only
    // opened after this gate passes.
    preflightExistingDatabase(databasePath);
  } else {
    // Create the missing parent only for a newly requested path; existing
    // files (even refused ones) never gain sidecar directories from us.
    try {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    } catch (error) {
      throw errStorage("cannot create database parent directory");
    }
  }

  let db;
  try {
    db = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
  } catch (error) {
    throw mapIoError(error, "cannot open database");
  }

  // Per-connection settings only (nothing persistent yet, so a fresh file is
  // still zero-length/empty until the atomic setup transaction commits).
  // journal_mode is deliberately NOT touched here: switching a fresh DB to
  // WAL before the schema/meta setup would create a partial nonempty v0
  // window observable by a competing process.
  try {
    db.exec(`PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = FULL");
  } catch (error) {
    closeQuietly(db);
    throw mapIoError(error, "cannot configure database connection");
  }

  let instanceId;
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    closeQuietly(db);
    throw mapIoError(error, "cannot acquire database write lock");
  }

  try {
    // Recheck identity/version/schema under the write lock: another process
    // may have initialized the file since our preflight (or since stat). The
    // schema-shape gate runs here too so nothing persistent (WAL, DDL,
    // version stamp) is written for an incompatible database.
    const userVersion = readUserVersion(db);
    let rows = null;
    try {
      rows = db.prepare(
        "SELECT application_id, instance_uuid, schema_version, created_at_ms FROM meta"
      ).all();
    } catch (error) {
      if (isBusyLike(error)) throw errBusy();
      rows = null; // fresh file has no meta table yet
    }

    if (rows === null || rows.length === 0) {
      if (!fresh) {
        // A nonempty file that passed preflight must still carry its meta
        // row; losing it under the lock means refuse, never re-initialize
        // over someone else's database.
        throw errSchemaMismatch("meta row vanished under write lock");
      }
      // A formerly absent/zero-length file may have been replaced by a
      // competing initializer since stat. Never create CHO tables alongside
      // it: only initialize a still-empty version-0 schema, otherwise refuse
      // (a valid racing winner carries its meta row and reuses the branch below).
      if (userVersion !== 0 || !isUserSchemaEmpty(db)) {
        throw errSchemaMismatch("database file changed before initialization");
      }
      const created = randomUUID();
      db.exec(SESSION_STORE_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO meta(application_id, instance_uuid, schema_version, created_at_ms) VALUES (?, ?, ?, ?)"
      ).run(SESSION_STORE_APPLICATION_ID, created, SESSION_STORE_SCHEMA_VERSION, Date.now());
      db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
      try {
        db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(db);
        throw mapIoError(error, "cannot commit database initialization");
      }
      instanceId = created;
    } else {
      // Competing initializer won, or our own existing DB: re-admit the
      // identity AND the schema shape under the lock, then reuse the winning
      // valid identity. Never reset UUID/schema here.
      instanceId = validateIdentity(rows, userVersion);
      assertExpectedSchema(db);
      rollbackQuietly(db);
    }
  } catch (error) {
    rollbackQuietly(db);
    closeQuietly(db);
    if (error && error[STORE_ERROR]) throw error;
    throw mapIoError(error, "cannot initialize database");
  }

  // Configure the verified persistent settings only after the identity/setup
  // transaction resolved, then verify every setting by read-back.
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (String(journalMode).toLowerCase() !== "wal") throw errStorage("WAL journal mode not confirmed");
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
    if (foreignKeys !== 1) throw errStorage("foreign key enforcement not confirmed");
    const synchronous = db.prepare("PRAGMA synchronous").get()?.synchronous;
    if (synchronous !== 2) throw errStorage("synchronous FULL not confirmed");
    // node:sqlite reports this read-back as { timeout }, not { busy_timeout }.
    const busyRow = db.prepare("PRAGMA busy_timeout").get();
    const busyTimeout = busyRow?.timeout ?? busyRow?.busy_timeout;
    if (busyTimeout !== SESSION_STORE_BUSY_TIMEOUT_MS) {
      throw errStorage("busy timeout not confirmed");
    }
    const stamped = db.prepare("PRAGMA user_version").get()?.user_version;
    if (stamped !== SESSION_STORE_SCHEMA_VERSION) throw errStorage("schema version stamp not confirmed");
    const check = db.prepare("SELECT instance_uuid FROM meta").get();
    if (!check || check.instance_uuid !== instanceId) {
      throw errStorage("meta singleton not confirmed after setup");
    }
  } catch (error) {
    closeQuietly(db);
    if (error && error[STORE_ERROR]) throw error;
    throw mapIoError(error, "cannot verify database settings");
  }

  let closed = false;
  let inTransaction = false;

  const normalizeParams = (rest) =>
    rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;

  function transaction(fn) {
    if (closed) throw errClosed();
    if (typeof fn !== "function") throw errInvalidTx("callback must be a function");
    if (inTransaction) throw errInvalidTx("nested transaction");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw mapIoError(error, "cannot begin transaction");
    }
    inTransaction = true;
    const token = { active: true };
    const finish = () => {
      token.active = false;
      inTransaction = false;
    };
    const checkHelper = () => {
      if (!token.active) throw errInvalidTx("helper used outside its transaction callback");
    };
    const prepareHelper = (sql) => {
      checkHelper();
      if (typeof sql !== "string" || sql.length === 0) throw errInvalidTx("statement must be a string");
      try {
        return db.prepare(sql);
      } catch (error) {
        throw mapIoError(error, "cannot prepare statement");
      }
    };
    // Scoped query capability: prepared statements with bound values only.
    // The raw DatabaseSync handle and StatementSync objects never escape.
    const api = Object.freeze({
      run(sql, ...rest) {
        const statement = prepareHelper(sql);
        try {
          const info = statement.run(...normalizeParams(rest));
          return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
        } catch (error) {
          throw mapIoError(error, "statement failed");
        }
      },
      get(sql, ...rest) {
        const statement = prepareHelper(sql);
        try {
          return statement.get(...normalizeParams(rest)) ?? undefined;
        } catch (error) {
          throw mapIoError(error, "statement failed");
        }
      },
      all(sql, ...rest) {
        const statement = prepareHelper(sql);
        try {
          return statement.all(...normalizeParams(rest));
        } catch (error) {
          throw mapIoError(error, "statement failed");
        }
      },
    });

    let result;
    try {
      result = fn(api);
    } catch (callbackError) {
      // SQL errors thrown by helpers are already coded; programmer errors
      // propagate unchanged. Either way the partial work rolls back first.
      rollbackQuietly(db);
      finish();
      throw callbackError;
    }
    // Expire the scoped helpers BEFORE touching the result: reading `.then`
    // runs a user getter and consuming the result runs custom `then`
    // assimilation, either of which must never observe a live capability.
    // Probing/consuming runs user code, so rollback/finish cover those steps
    // too; an async rejection is consumed so no unhandled rejection escapes
    // while the visible ERR_INVALID_TX still surfaces. The result is never
    // Promise-assimilated while helpers are live: async callbacks are
    // rejected outright after rolling back the synchronous prefix.
    // (inTransaction stays set until commit/rollback so reentrant use from
    // user `then` code still rejects as nested.)
    token.active = false;
    let asyncResult = false;
    try {
      asyncResult = isThenable(result);
      if (asyncResult) consumeRejection(result);
    } catch {
      // A throwing `then` getter is still an async-callback misuse signal.
      asyncResult = true;
    }
    if (asyncResult) {
      rollbackQuietly(db);
      finish();
      throw errInvalidTx("asynchronous transaction callback (thenable result)");
    }
    try {
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      finish();
      throw mapIoError(error, "cannot commit transaction");
    }
    finish();
    return result;
  }

  function close() {
    if (closed) return;
    if (inTransaction) throw errInvalidTx("close inside transaction");
    try {
      // Best-effort checkpoint so readers tolerate no WAL residue; a failed
      // checkpoint must not block closing a healthy store.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore checkpoint failures on close */
    }
    try {
      db.close();
    } finally {
      closed = true;
    }
  }

  return Object.freeze({ instanceId, schemaVersion: SESSION_STORE_SCHEMA_VERSION, transaction, close });
}
