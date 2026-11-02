// CHO-03 S1 store core tests: real temp SQLite fixtures only, never actual
// user app-data. Covers lifecycle boundaries from SESSION_STORAGE.md §2,6,7.
// NOTE: node:sqlite rows use null-prototype objects, so assertions below use
// toMatchObject / field access instead of toEqual on whole rows.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import {
  SESSION_STORE_APPLICATION_ID,
  SESSION_STORE_SCHEMA_VERSION,
} from "../server/session-store-schema.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dirs = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* tests asserting close-in-tx leave the store open on purpose */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cho-session-store-"));
  dirs.push(dir);
  return dir;
}

function dbPath(dir, name = "cho-sessions.sqlite3") {
  return join(dir, name);
}

function track(store) {
  stores.push(store);
  return store;
}

// Explicit flags on every raw fixture connection: extension loading off,
// double-quoted string literals off, foreign keys on.
const RAW_OPEN_FLAGS = {
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  enableLoadExtension: false,
};

function openRaw(file, readOnly = false) {
  return new DatabaseSync(
    file,
    readOnly ? { readOnly: true, ...RAW_OPEN_FLAGS } : { ...RAW_OPEN_FLAGS }
  );
}

function openFresh(dir, name) {
  return track(openSessionStore({ databasePath: dbPath(dir, name) }));
}

function sha256Hex(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sidecars(path) {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`].filter(existsSync);
}

// Minimal valid meta fixture written with raw SQL (not via the module).
function craftDatabase(file, { applicationId, schemaVersion, userVersion, instanceUuid, metaRows } = {}) {
  const raw = openRaw(file);
  try {
    raw.exec(
      "CREATE TABLE meta(application_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL)"
    );
    const app = applicationId ?? SESSION_STORE_APPLICATION_ID;
    const version = schemaVersion ?? SESSION_STORE_SCHEMA_VERSION;
    const uuid = instanceUuid ?? "11111111-2222-4333-8444-555555555555";
    const rows = metaRows ?? [[app, uuid, version, 1700000000000]];
    const insert = raw.prepare(
      "INSERT INTO meta(application_id, instance_uuid, schema_version, created_at_ms) VALUES (?, ?, ?, ?)"
    );
    for (const row of rows) insert.run(...row);
    raw.exec(`PRAGMA user_version = ${userVersion ?? version}`);
  } finally {
    raw.close();
  }
}

// Raw read-back of PERSISTED state for verification (independent route).
// Connection-scoped settings (foreign_keys, synchronous, busy_timeout) are
// asserted on the store's own scoped helpers instead: a fresh independent
// connection only carries defaults.
function inspectDatabase(file) {
  const raw = openRaw(file, true);
  try {
    return {
      journalMode: String(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase(),
      userVersion: raw.prepare("PRAGMA user_version").get()?.user_version,
      tables: raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => ({ ...row }).name),
      meta: raw.prepare("SELECT application_id, instance_uuid, schema_version FROM meta").all().map((row) => ({ ...row })),
    };
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

const PROJECT_INSERT =
  "INSERT INTO projects(id, name, path_canonical, created_at_ms) VALUES (?, ?, ?, ?)";
const projectRow = (id) => [id, `name-${id}`, `/tmp/canonical-${id}`, 1700000000000];

describe("session store lifecycle", () => {
  it("creates a fresh database with schema, identity, and verified settings", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    const store = openFresh(dir);
    expect(Object.isFrozen(store)).toBe(true);
    expect(store.schemaVersion).toBe(SESSION_STORE_SCHEMA_VERSION);
    expect(store.instanceId).toMatch(UUID_RE);

    // Connection-scoped settings read through the store's own helpers.
    // node:sqlite reports busy_timeout read-back as { timeout }.
    const pragmas = store.transaction((tx) => ({
      foreignKeys: tx.get("PRAGMA foreign_keys").foreign_keys,
      synchronous: tx.get("PRAGMA synchronous").synchronous,
      busyTimeout: tx.get("PRAGMA busy_timeout").timeout,
    }));
    expect(pragmas.foreignKeys).toBe(1);
    expect(pragmas.synchronous).toBe(2); // FULL
    expect(pragmas.busyTimeout).toBe(100);

    // Persisted settings read through an independent connection.
    const seen = inspectDatabase(file);
    expect(seen.userVersion).toBe(SESSION_STORE_SCHEMA_VERSION);
    expect(seen.journalMode).toBe("wal");
    for (const table of ["meta", "projects", "conversations", "native_refs", "turns", "events"]) {
      expect(seen.tables).toContain(table);
    }
    expect(seen.meta).toHaveLength(1);
    expect(seen.meta[0]).toMatchObject({
      application_id: SESSION_STORE_APPLICATION_ID,
      schema_version: SESSION_STORE_SCHEMA_VERSION,
      instance_uuid: store.instanceId,
    });
  });

  it("reopening the same file keeps the same instance UUID and version", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    const first = openFresh(dir);
    const { instanceId } = first;
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = track(openSessionStore({ databasePath: file }));
    expect(second.instanceId).toBe(instanceId);
    expect(second.schemaVersion).toBe(SESSION_STORE_SCHEMA_VERSION);
    expect(inspectDatabase(file).meta).toHaveLength(1);
  });

  it("rejects bad paths with ERR_BAD_PATH before touching the filesystem", () => {
    const dir = tempDir();
    const probe = dbPath(dir, "probe.sqlite3");
    const bad = [
      undefined,
      null,
      42,
      {},
      "",
      "   ",
      "relative/path.sqlite3",
      "cho-sessions.sqlite3",
      ":memory:",
      "file:///tmp/cho-sessions.sqlite3",
      "file:/tmp/cho-sessions.sqlite3",
      `${dir}\0evil.sqlite3`,
    ];
    for (const databasePath of bad) {
      expectCode(() => openSessionStore({ databasePath }), "ERR_BAD_PATH");
    }
    expectCode(() => openSessionStore(), "ERR_BAD_PATH");
    expect(existsSync(probe)).toBe(false);
    expect(sidecars(probe)).toEqual([]);
  });

  it("refuses a foreign application id without modifying the file", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    craftDatabase(file, { applicationId: "other.app.v9" });
    const before = sha256Hex(file);
    expectCode(() => openSessionStore({ databasePath: file }), "ERR_FOREIGN_DB");
    expect(sha256Hex(file)).toBe(before);
    expect(sidecars(file)).toEqual([]);
  });

  it("refuses a newer schema version without modifying the file", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    craftDatabase(file, { schemaVersion: SESSION_STORE_SCHEMA_VERSION + 1, userVersion: SESSION_STORE_SCHEMA_VERSION + 1 });
    const before = sha256Hex(file);
    expectCode(() => openSessionStore({ databasePath: file }), "ERR_FUTURE_VERSION");
    expect(sha256Hex(file)).toBe(before);
    expect(sidecars(file)).toEqual([]);
  });

  it("refuses version-0-nonempty files without modifying them", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    const raw = openRaw(file);
    try {
      raw.exec("CREATE TABLE leftover(x TEXT)");
    } finally {
      raw.close();
    }
    const before = sha256Hex(file);
    expectCode(() => openSessionStore({ databasePath: file }), "ERR_SCHEMA_MISMATCH");
    expect(sha256Hex(file)).toBe(before);
  });

  it("refuses corrupt headers without modifying them", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    writeFileSync(file, Buffer.from("this is not a sqlite database file at all...", "utf8"));
    const before = sha256Hex(file);
    expectCode(() => openSessionStore({ databasePath: file }), "ERR_SCHEMA_MISMATCH");
    expect(sha256Hex(file)).toBe(before);
  });

  it("refuses metadata disagreements (empty/duplicated/bad-uuid meta)", () => {
    const dir = tempDir();
    // Empty meta with a stamped user_version.
    const emptyMeta = dbPath(dir, "empty-meta.sqlite3");
    {
      const raw = openRaw(emptyMeta);
      try {
        raw.exec(
          "CREATE TABLE meta(application_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL)"
        );
        raw.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
      } finally {
        raw.close();
      }
    }
    expectCode(() => openSessionStore({ databasePath: emptyMeta }), "ERR_SCHEMA_MISMATCH");

    // Duplicated meta rows.
    const dupMeta = dbPath(dir, "dup-meta.sqlite3");
    craftDatabase(dupMeta, {
      metaRows: [
        [SESSION_STORE_APPLICATION_ID, "11111111-2222-4333-8444-555555555555", SESSION_STORE_SCHEMA_VERSION, 1700000000000],
      ],
    });
    {
      const raw = openRaw(dupMeta);
      try {
        // PRIMARY KEY blocks a second identical row, so bypass via a copy.
        raw.exec("CREATE TABLE meta2 AS SELECT * FROM meta");
        raw.exec("DROP TABLE meta");
        raw.exec("ALTER TABLE meta2 RENAME TO meta");
        raw.prepare(
          "INSERT INTO meta(application_id, instance_uuid, schema_version, created_at_ms) VALUES (?, ?, ?, ?)"
        ).run("other.app", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", SESSION_STORE_SCHEMA_VERSION, 1700000000000);
      } finally {
        raw.close();
      }
    }
    expectCode(() => openSessionStore({ databasePath: dupMeta }), "ERR_SCHEMA_MISMATCH");

    // Malformed instance UUID.
    const badUuid = dbPath(dir, "bad-uuid.sqlite3");
    craftDatabase(badUuid, { instanceUuid: "not-a-uuid" });
    expectCode(() => openSessionStore({ databasePath: badUuid }), "ERR_SCHEMA_MISMATCH");

    // user_version diverged from the meta schema version.
    const drifted = dbPath(dir, "drifted.sqlite3");
    craftDatabase(drifted, { userVersion: SESSION_STORE_SCHEMA_VERSION + 10 });
    expectCode(() => openSessionStore({ databasePath: drifted }), "ERR_SCHEMA_MISMATCH");
  });

  it("refuses schema-shape mismatches without modifying the file", () => {
    const dir = tempDir();

    // Meta-only database: valid identity rows but none of the CHO tables.
    const metaOnly = dbPath(dir, "meta-only.sqlite3");
    craftDatabase(metaOnly);
    const metaBefore = sha256Hex(metaOnly);
    expectCode(() => openSessionStore({ databasePath: metaOnly }), "ERR_SCHEMA_MISMATCH");
    expect(sha256Hex(metaOnly)).toBe(metaBefore);
    expect(sidecars(metaOnly)).toEqual([]);

    // Missing table: a real store file with one table dropped afterwards.
    const dropped = dbPath(dir, "dropped.sqlite3");
    {
      const setup = openSessionStore({ databasePath: dropped });
      stores.push(setup);
      setup.close();
      stores.splice(stores.indexOf(setup), 1);
      const raw = openRaw(dropped);
      try {
        raw.exec("DROP TABLE events");
      } finally {
        raw.close();
      }
    }
    const droppedBefore = sha256Hex(dropped);
    expectCode(() => openSessionStore({ databasePath: dropped }), "ERR_SCHEMA_MISMATCH");
    expect(sha256Hex(dropped)).toBe(droppedBefore);

    // Missing constraint shape: projects without its UNIQUE/CHECK shape.
    const weak = dbPath(dir, "weak.sqlite3");
    {
      const raw = openRaw(weak);
      try {
        raw.exec(
          "CREATE TABLE meta(application_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL)"
        );
        raw.prepare(
          "INSERT INTO meta(application_id, instance_uuid, schema_version, created_at_ms) VALUES (?, ?, ?, ?)"
        ).run(
          SESSION_STORE_APPLICATION_ID,
          "11111111-2222-4333-8444-555555555555",
          SESSION_STORE_SCHEMA_VERSION,
          1700000000000
        );
        raw.exec(
          "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path_canonical TEXT NOT NULL, created_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0)"
        );
        raw.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
      } finally {
        raw.close();
      }
    }
    const weakBefore = sha256Hex(weak);
    expectCode(() => openSessionStore({ databasePath: weak }), "ERR_SCHEMA_MISMATCH");
    expect(sha256Hex(weak)).toBe(weakBefore);
    expect(sidecars(weak)).toEqual([]);
  });
});

describe("session store transactions", () => {
  it("commits and the commit survives close/reopen", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    const store = openFresh(dir);
    const returned = store.transaction((tx) => {
      const info = tx.run(PROJECT_INSERT, projectRow("p1"));
      expect(Number(info.changes)).toBe(1);
      return "receipt-1";
    });
    expect(returned).toBe("receipt-1");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = track(openSessionStore({ databasePath: file }));
    const row = reopened.transaction((tx) =>
      tx.get("SELECT id, name, path_canonical FROM projects WHERE id = ?", ["p1"])
    );
    expect({ ...row }).toMatchObject({ id: "p1", name: "name-p1", path_canonical: "/tmp/canonical-p1" });
  });

  it("rolls back a partial write when the callback throws, then propagates the original error", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    let seen;
    try {
      store.transaction((tx) => {
        tx.run(PROJECT_INSERT, projectRow("p-boom"));
        throw new Error("boom");
      });
    } catch (error) {
      seen = error;
    }
    expect(seen?.message).toBe("boom");
    expect(seen?.code).toBeUndefined();
    const row = store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-boom"]));
    expect(row).toBeUndefined();
  });

  it("rejects nested transactions without committing partial changes", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    let innerCode;
    try {
      store.transaction((tx) => {
        tx.run(PROJECT_INSERT, projectRow("p-outer"));
        try {
          store.transaction(() => {});
        } catch (error) {
          innerCode = error?.code;
          throw error;
        }
      });
    } catch (error) {
      expect(error?.code).toBe("ERR_INVALID_TX");
    }
    expect(innerCode).toBe("ERR_INVALID_TX");
    const row = store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-outer"]));
    expect(row).toBeUndefined();
  });

  it("rejects close inside a transaction and stays usable with nothing committed", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    expectCode(
      () =>
        store.transaction((tx) => {
          tx.run(PROJECT_INSERT, projectRow("p-close-tx"));
          store.close();
        }),
      "ERR_INVALID_TX"
    );
    // The store survived the rejected close and rolled the partial work back.
    const row = store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-close-tx"]));
    expect(row).toBeUndefined();
    store.transaction((tx) => {
      tx.run(PROJECT_INSERT, projectRow("p-after"));
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
  });

  it("rolls back async callbacks, expires helpers, and rejects microtask writes", async () => {
    const dir = tempDir();
    const store = openFresh(dir);
    expectCode(
      () =>
        store.transaction((tx) => {
          tx.run(PROJECT_INSERT, projectRow("p-async"));
          return Promise.resolve("late");
        }),
      "ERR_INVALID_TX"
    );
    expect(
      store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-async"]))
    ).toBeUndefined();

    // Escaped helper: captured capability is permanently invalid after return.
    let escaped;
    const value = store.transaction((tx) => {
      escaped = tx;
      return 42;
    });
    expect(value).toBe(42);
    expectCode(() => escaped.run("SELECT 1"), "ERR_INVALID_TX");
    expectCode(() => escaped.get("SELECT 1"), "ERR_INVALID_TX");
    expectCode(() => escaped.all("SELECT 1"), "ERR_INVALID_TX");

    // Microtask write after return races the expired helpers and must fail.
    expectCode(
      () =>
        store.transaction((tx) => {
          tx.run(PROJECT_INSERT, projectRow("p-micro"));
          return Promise.resolve().then(() => {
            tx.run(PROJECT_INSERT, projectRow("p-micro-2"));
          });
        }),
      "ERR_INVALID_TX"
    );
    await new Promise((resolve) => setImmediate(resolve));
    const rows = store.transaction((tx) => tx.all("SELECT id FROM projects WHERE id LIKE 'p-micro%'"));
    expect(rows).toEqual([]);
  });

  it("rejects a throwing then-getter without leaking writes or helpers", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    let saved;
    const error = expectCode(
      () =>
        store.transaction((tx) => {
          saved = tx;
          tx.run(PROJECT_INSERT, projectRow("p-getter"));
          return {
            get then() {
              throw new Error("getter-boom");
            },
          };
        }),
      "ERR_INVALID_TX"
    );
    expect(String(error.message)).not.toContain("getter-boom");
    expect(
      store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-getter"]))
    ).toBeUndefined();
    expectCode(() => saved.run("SELECT 1"), "ERR_INVALID_TX");
    // The next normal transaction is fully usable.
    store.transaction((tx) => {
      tx.run(PROJECT_INSERT, projectRow("p-getter-ok"));
    });
    const row = store.transaction((tx) =>
      tx.get("SELECT id FROM projects WHERE id = ?", ["p-getter-ok"])
    );
    expect({ ...row }).toMatchObject({ id: "p-getter-ok" });
  });

  it("rejects a custom thenable that reuses helpers without leaking writes", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    let saved;
    const sneaky = {
      then() {
        saved.run(PROJECT_INSERT, projectRow("p-then-sneak"));
      },
    };
    expectCode(
      () =>
        store.transaction((tx) => {
          saved = tx;
          tx.run(PROJECT_INSERT, projectRow("p-custom"));
          return sneaky;
        }),
      "ERR_INVALID_TX"
    );
    expect(
      store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-custom"]))
    ).toBeUndefined();
    expect(
      store.transaction((tx) => tx.get("SELECT id FROM projects WHERE id = ?", ["p-then-sneak"]))
    ).toBeUndefined();
    expectCode(() => saved.get("SELECT 1"), "ERR_INVALID_TX");
    // The next normal transaction is fully usable.
    store.transaction((tx) => {
      tx.run(PROJECT_INSERT, projectRow("p-custom-ok"));
    });
  });

  it("does not leak SQL text into public storage errors", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    const marker = "absent_table_xyz_unlikely";
    const error = expectCode(
      () => store.transaction((tx) => tx.get(`SELECT * FROM ${marker}`)),
      "ERR_STORAGE"
    );
    expect(String(error.message)).not.toContain(marker);
    // Stable generic message: no SQLite diagnostics suffix.
    expect(error.message).toBe("session store I/O failure (cannot prepare statement)");
    // The failed statement rolled back; the store is still usable.
    store.transaction((tx) => {
      tx.run(PROJECT_INSERT, projectRow("p-still-ok"));
    });
  });

  it("close is idempotent and use after close rejects with ERR_CLOSED", () => {
    const dir = tempDir();
    const store = openFresh(dir);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(() => store.close()).not.toThrow();
    expectCode(() => store.transaction(() => {}), "ERR_CLOSED");
  });

  it("surfaces bounded ERR_BUSY under a real competing lock with no write by the loser", () => {
    const dir = tempDir();
    const file = dbPath(dir);
    const store = openFresh(dir);
    const competitor = openRaw(file);
    try {
      competitor.exec("BEGIN IMMEDIATE");
      competitor.prepare(PROJECT_INSERT).run(...projectRow("p-holder"));

      const started = Date.now();
      const error = expectCode(
        () =>
          store.transaction((tx) => {
            tx.run(PROJECT_INSERT, projectRow("p-loser"));
          }),
        "ERR_BUSY"
      );
      expect(String(error.message)).not.toContain("p-loser");
      // Bounded by the 100ms busy policy, nowhere near a hang.
      expect(Date.now() - started).toBeLessThan(2_000);

      competitor.exec("ROLLBACK");
      // Loser wrote nothing; the rolled-back holder wrote nothing either.
      const rows = store.transaction((tx) => tx.all("SELECT id FROM projects"));
      expect(rows).toEqual([]);
      // The store is fully usable after the contention.
      store.transaction((tx) => {
        tx.run(PROJECT_INSERT, projectRow("p-winner"));
      });
    } finally {
      try {
        competitor.close();
      } catch {
        /* ignore cleanup failures */
      }
    }
  });

  it("two racing child-process initializers converge on one valid instance", async () => {
    const dir = tempDir();
    const file = dbPath(dir, "race.sqlite3");
    const moduleUrl = new URL("../server/session-store.mjs", import.meta.url).href;
    // Structured child protocol: success prints { ok: true, instanceId } and
    // exits 0; any failure prints { ok: false, code } and exits nonzero.
    const childScript = [
      `import { openSessionStore } from ${JSON.stringify(moduleUrl)};`,
      "let store;",
      "try {",
      "  store = openSessionStore({ databasePath: process.argv[1] });",
      '  console.log(JSON.stringify({ ok: true, instanceId: store.instanceId }));',
      "  store.close();",
      "} catch (error) {",
      '  console.log(JSON.stringify({ ok: false, code: error?.code ?? "unknown" }));',
      "  try { store?.close?.(); } catch {}",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");

    function runInitializer() {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, file], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        let settled = false;
        // A hung child is a failure with bounded cleanup, never a quiet pass.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          reject(new Error(`initializer timed out: ${stderr}`));
        }, 10_000);
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let parsed = null;
          try {
            parsed = JSON.parse(stdout.trim().split("\n").at(-1));
          } catch {
            parsed = null;
          }
          if (!parsed || typeof parsed !== "object") {
            reject(new Error(`unparseable initializer output (exit ${code}): ${stdout} ${stderr}`));
            return;
          }
          if (parsed.ok) {
            if (code !== 0) {
              reject(new Error(`initializer reported success with exit ${code}`));
              return;
            }
            resolve({ ok: true, instanceId: parsed.instanceId });
          } else {
            if (code === 0) {
              reject(new Error("initializer reported failure with exit 0"));
              return;
            }
            resolve({ ok: false, code: parsed.code });
          }
        });
      });
    }

    const results = await Promise.all([runInitializer(), runInitializer()]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Every loser lost to contention only: bounded ERR_BUSY, never anything else.
    for (const loser of losers) expect(loser.code).toBe("ERR_BUSY");
    if (winners.length === 2) {
      // Loser reused the winner: same lineage, never a reset.
      expect(winners[0].instanceId).toBe(winners[1].instanceId);
    }
    for (const winner of winners) expect(winner.instanceId).toMatch(UUID_RE);
    const seen = inspectDatabase(file);
    expect(seen.meta).toHaveLength(1);
    expect(seen.userVersion).toBe(SESSION_STORE_SCHEMA_VERSION);
    expect(seen.meta[0].instance_uuid).toBe(winners[0].instanceId);
    // Parent can open the raced file normally afterwards.
    const store = track(openSessionStore({ databasePath: file }));
    expect(store.instanceId).toBe(seen.meta[0].instance_uuid);
  }, 60_000);
});
