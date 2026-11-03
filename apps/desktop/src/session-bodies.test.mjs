// CHO-03 S2d bounded body tests: real temp SQLite fixtures only, never
// the actual user app-data. Projects/conversations come from the S2a
// records API, fences from the S2b bindings API. Covers factory/validation,
// empty/multilingual fidelity, idempotent reuse and conflicts, input
// bounds, scoped/historical reads, byte chunks with split code points,
// proof handling across two connections, stored-corruption detection, and
// outer composition. No implementation-mirroring mocks: corruption seeds
// use trusted store transactions and fidelity checks use raw SQL or
// independent hashing.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../server/session-store.mjs";
import { createSessionRecords } from "../server/session-records.mjs";
import { createSessionBindings } from "../server/session-bindings.mjs";
import { createSessionBodies } from "../server/session-bodies.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "cho-session-bodies-"));
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
const B1 = uid(201);
const B2 = uid(202);
const B3 = uid(203);
const T1 = uid(301);
const T2 = uid(302);
const H1 = uid(311);

function makeClock(start = 1700000000000) {
  let tick = start;
  return () => tick++;
}

const strictTrue = () => true;

function openFresh(dir, name, options = {}) {
  const file = dbPath(dir, name);
  const store = openSessionStore({ databasePath: file });
  stores.push(store);
  const clock = options.clock ?? makeClock();
  const records = createSessionRecords({ store, now: clock });
  const bindings = createSessionBindings({
    store,
    verifyOwnerEvidence: options.verifier ?? strictTrue,
    now: clock,
  });
  const bodies = createSessionBodies({
    store,
    verifyOwnerEvidence: options.bodyVerifier ?? strictTrue,
    now: clock,
  });
  return { file, store, records, bindings, bodies, clock };
}

function seedChat(records, bindings, projectId, conversationId, ownerToken) {
  records.createProject({
    id: projectId,
    name: "p",
    pathCanonical: `/tmp/${projectId}`,
  });
  records.createConversation({
    id: conversationId,
    projectId,
    controller: "codex",
  });
  bindings.claimProducer({
    projectId,
    conversationId,
    ownerToken,
    expectedGeneration: 0,
    evidence: null,
  });
}

function scope(projectId, conversationId, ownerToken, extra = {}) {
  return {
    projectId,
    conversationId,
    ownerToken,
    ownerGeneration: 1,
    hostGeneration: H1,
    evidence: null,
    ...extra,
  };
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error?.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

describe("factory and surface", () => {
  it("rejects bad dependencies and exposes a frozen surface", () => {
    const dir = tempDir();
    const { store } = openFresh(dir, "a.sqlite3");
    expectCode(() => createSessionBodies(null), "ERR_INVALID_RECORD");
    expectCode(() => createSessionBodies({}), "ERR_INVALID_RECORD");
    expectCode(
      () => createSessionBodies({ store: {}, verifyOwnerEvidence: strictTrue }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () => createSessionBodies({ store, verifyOwnerEvidence: true }),
      "ERR_INVALID_RECORD"
    );
    expectCode(
      () =>
        createSessionBodies({
          store,
          verifyOwnerEvidence: strictTrue,
          now: 42,
        }),
      "ERR_INVALID_RECORD"
    );
    const bodies = createSessionBodies({ store, verifyOwnerEvidence: strictTrue });
    expect(Object.isFrozen(bodies)).toBe(true);
    expect(Object.keys(bodies).sort()).toEqual([
      "getBody",
      "inTransaction",
      "putBody",
      "readBodyChunk",
    ]);
    expect(Object.isFrozen(bodies.inTransaction)).toBe(false);
  });
});

describe("put/get fidelity", () => {
  it("stores empty body and exact whitespace/multilingual/non-BMP bytes", () => {
    const dir = tempDir();
    const { store, records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    const empty = bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "" }));
    expect(empty.created).toBe(true);
    expect(empty.body).toEqual({
      id: B1,
      conversationId: C1,
      byteLength: 0,
      sha256Hex: createHash("sha256").update("", "utf8").digest("hex"),
      createdAtMs: 1700000000003,
    });
    const text = "  héllo\n世界🌍\t tail  ";
    const first = bodies.putBody(scope(P1, C1, T1, { bodyId: B2, text }));
    expect(first.created).toBe(true);
    const expectedBytes = Buffer.byteLength(text, "utf8");
    const expectedHash = createHash("sha256").update(text, "utf8").digest("hex");
    expect(first.body.byteLength).toBe(expectedBytes);
    expect(first.body.sha256Hex).toBe(expectedHash);
    const meta = bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B2 });
    expect(meta).toEqual(first.body);
    expect(meta).not.toHaveProperty("text");
    expect(meta).not.toHaveProperty("evidence");
    // Independent raw read-back confirms byte fidelity and hash.
    const raw = store.transaction((tx) =>
      tx.get("SELECT body_text FROM large_bodies WHERE id = ?", [B2])
    );
    expect(raw.body_text).toBe(text);
    expect(Buffer.byteLength(raw.body_text, "utf8")).toBe(expectedBytes);
    expect(createHash("sha256").update(raw.body_text, "utf8").digest("hex")).toBe(
      expectedHash
    );
    const chunk = bodies.readBodyChunk({
      projectId: P1,
      conversationId: C1,
      bodyId: B2,
    });
    expect(chunk.totalBytes).toBe(expectedBytes);
    expect(chunk.sha256Hex).toBe(expectedHash);
    expect(Buffer.from(chunk.dataBase64, "base64").toString("utf8")).toBe(text);
    expect(chunk.eof).toBe(true);
  });
});

describe("idempotency and ownership", () => {
  it("replays exact content without rewrite; conflicts on text/chat; second owner may reuse", () => {
    const dir = tempDir();
    const { store, records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    records.createConversation({ id: C2, projectId: P1, controller: "codex" });
    bindings.claimProducer({
      projectId: P1,
      conversationId: C2,
      ownerToken: T1,
      expectedGeneration: 0,
      evidence: null,
    });
    const first = bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "abc" }));
    expect(first.created).toBe(true);
    const replay = bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "abc" }));
    expect(replay.created).toBe(false);
    expect(replay.body).toEqual(first.body);
    expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "abd" })),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    expectCode(
      () => bodies.putBody(scope(P1, C2, T1, { bodyId: B1, text: "abc" })),
      "ERR_IDEMPOTENCY_CONFLICT"
    );
    // A different verified current owner may exactly reuse immutable content.
    bindings.settleProducer({
      projectId: P1,
      conversationId: C1,
      ownerToken: T1,
      generation: 1,
      state: "released",
      evidence: null,
    });
    bindings.claimProducer({
      projectId: P1,
      conversationId: C1,
      ownerToken: T2,
      expectedGeneration: 1,
      evidence: null,
    });
    const reuse = bodies.putBody(
      scope(P1, C1, T2, { bodyId: B1, text: "abc", ownerGeneration: 2 })
    );
    expect(reuse.created).toBe(false);
    expect(reuse.body).toEqual(first.body);
    // Stale owner cannot write even with exact content.
    expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B3, text: "abc" })),
      "ERR_FENCE_CONFLICT"
    );
    // No partial row from the rejected conflict.
    const missing = bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B3 });
    expect(missing).toBe(null);
    expect(
      store.transaction((tx) =>
        tx.get("SELECT id FROM large_bodies WHERE id = ?", [B3])
      )
    ).toBe(undefined);
  });

  it("two live connections enforce the fence", () => {
    const dir = tempDir();
    const a = openFresh(dir, "shared.sqlite3");
    seedChat(a.records, a.bindings, P1, C1, T1);
    const file = dbPath(dir, "shared.sqlite3");
    const storeB = openSessionStore({ databasePath: file });
    stores.push(storeB);
    const bodiesB = createSessionBodies({
      store: storeB,
      verifyOwnerEvidence: strictTrue,
    });
    expectCode(
      () =>
        bodiesB.putBody(scope(P1, C1, T2, { bodyId: B1, text: "x" })),
      "ERR_FENCE_CONFLICT"
    );
    const ok = a.bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" }));
    expect(ok.created).toBe(true);
  });
});

describe("input bounds and clock", () => {
  it("rejects malformed ids, NUL, lone surrogates, overflow, and bad clocks without echo", () => {
    const dir = tempDir();
    const { records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    const good = scope(P1, C1, T1, { bodyId: B1, text: "x" });
    expectCode(() => bodies.putBody({ ...good, projectId: "nope" }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, bodyId: "B1" }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, ownerGeneration: 0 }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, text: "a\0b" }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, text: "\ud800" }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, text: 42 }), "ERR_INVALID_RECORD");
    expectCode(() => bodies.putBody({ ...good, text: "x".repeat(1048577) }), "ERR_INVALID_RECORD");
    const huge = "x".repeat(1048576 + 1);
    const err = expectCode(
      () => bodies.putBody({ ...good, text: huge }),
      "ERR_INVALID_RECORD"
    );
    expect(String(err?.message)).not.toContain(huge.slice(0, 16));
    // Exact 1MiB boundary passes; one byte over rejects.
    const ok1m = bodies.putBody(scope(P1, C1, T1, { bodyId: B2, text: "y".repeat(1048576) }));
    expect(ok1m.created).toBe(true);
    expect(ok1m.body.byteLength).toBe(1048576);
    expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B3, text: "y".repeat(1048577) })),
      "ERR_INVALID_RECORD"
    );
    // Multibyte byte-count boundary: 524288 x U+00E9 is exactly 1MiB.
    const dir2 = tempDir();
    const f2 = openFresh(dir2, "b.sqlite3");
    seedChat(f2.records, f2.bindings, P1, C1, T1);
    const even = "\u00e9".repeat(524288);
    expect(Buffer.byteLength(even, "utf8")).toBe(1048576);
    expect(f2.bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: even })).created).toBe(true);
    expectCode(
      () => f2.bodies.putBody(scope(P1, C1, T1, { bodyId: B2, text: "\u00e9".repeat(524289) })),
      "ERR_INVALID_RECORD"
    );
    // Bad clocks reject without echo. Shared setup stays good; only the
    // bodies layer under test gets the bad clock, so seedChat succeeds and
    // the put itself must reject with the static clock error.
    const negSetup = openFresh(tempDir(), "c.sqlite3");
    seedChat(negSetup.records, negSetup.bindings, P1, C1, T1);
    const negBodies = createSessionBodies({
      store: negSetup.store,
      verifyOwnerEvidence: strictTrue,
      now: () => -1,
    });
    const negErr = expectCode(
      () => negBodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" })),
      "ERR_INVALID_RECORD"
    );
    expect(String(negErr?.message)).not.toContain("-1");
    expect(
      negSetup.store.transaction((tx) =>
        tx.get("SELECT id FROM large_bodies WHERE id = ?", [B1])
      )
    ).toBe(undefined);
    const throwSetup = openFresh(tempDir(), "d.sqlite3");
    seedChat(throwSetup.records, throwSetup.bindings, P1, C1, T1);
    const throwBodies = createSessionBodies({
      store: throwSetup.store,
      verifyOwnerEvidence: strictTrue,
      now: () => {
        throw new Error("boom");
      },
    });
    const throwErr = expectCode(
      () => throwBodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" })),
      "ERR_INVALID_RECORD"
    );
    expect(String(throwErr?.message)).not.toContain("boom");
    expect(
      throwSetup.store.transaction((tx) =>
        tx.get("SELECT id FROM large_bodies WHERE id = ?", [B1])
      )
    ).toBe(undefined);
  });
});

describe("scoped and historical reads", () => {
  it("verifies project/chat, scopes by conversation, and stays readable after release", () => {
    const dir = tempDir();
    const { records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    records.createConversation({ id: C2, projectId: P1, controller: "codex" });
    bindings.claimProducer({
      projectId: P1,
      conversationId: C2,
      ownerToken: T1,
      expectedGeneration: 0,
      evidence: null,
    });
    bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "scoped" }));
    expectCode(
      () => bodies.getBody({ projectId: P2, conversationId: C1, bodyId: B1 }),
      "ERR_NOT_FOUND"
    );
    expect(
      bodies.getBody({ projectId: P1, conversationId: C2, bodyId: B1 })
    ).toBe(null);
    expectCode(
      () =>
        bodies.readBodyChunk({ projectId: P1, conversationId: C2, bodyId: B1 }),
      "ERR_NOT_FOUND"
    );
    expect(
      bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B3 })
    ).toBe(null);
    bindings.settleProducer({
      projectId: P1,
      conversationId: C1,
      ownerToken: T1,
      generation: 1,
      state: "released",
      evidence: null,
    });
    const meta = bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 });
    expect(meta?.byteLength).toBe(6);
    expect(meta).not.toHaveProperty("text");
    expect(meta).not.toHaveProperty("body_text");
    const chunk = bodies.readBodyChunk({
      projectId: P1,
      conversationId: C1,
      bodyId: B1,
    });
    expect(chunk).not.toHaveProperty("text");
    expect(chunk).not.toHaveProperty("body_text");
    expect(Buffer.from(chunk.dataBase64, "base64").toString("utf8")).toBe("scoped");
  });
});

describe("byte chunks", () => {
  it("walks split code points, reconstructs exact bytes and hash, and validates bounds", () => {
    const dir = tempDir();
    const { records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    const text = "A🌍B\u00e9C";
    const put = bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text }));
    const total = put.body.byteLength;
    // Byte 1..2 splits the 4-byte emoji: clients decode incrementally.
    const first = bodies.readBodyChunk({
      projectId: P1,
      conversationId: C1,
      bodyId: B1,
      offsetBytes: 1,
      lengthBytes: 1,
    });
    expect(first.lengthBytes).toBe(1);
    expect(first.nextOffsetBytes).toBe(2);
    expect(first.eof).toBe(false);
    let offset = 0;
    const parts = [];
    while (true) {
      const page = bodies.readBodyChunk({
        projectId: P1,
        conversationId: C1,
        bodyId: B1,
        offsetBytes: offset,
        lengthBytes: 2,
      });
      expect(page.offsetBytes).toBe(offset);
      parts.push(Buffer.from(page.dataBase64, "base64"));
      offset = page.nextOffsetBytes;
      if (page.eof) break;
    }
    const assembled = Buffer.concat(parts);
    expect(assembled.toString("utf8")).toBe(text);
    expect(createHash("sha256").update(assembled).digest("hex")).toBe(
      put.body.sha256Hex
    );
    // End offset is a legal zero-byte read; past end rejects.
    const end = bodies.readBodyChunk({
      projectId: P1,
      conversationId: C1,
      bodyId: B1,
      offsetBytes: total,
    });
    expect(end).toMatchObject({
      lengthBytes: 0,
      dataBase64: "",
      nextOffsetBytes: total,
      eof: true,
    });
    expectCode(
      () =>
        bodies.readBodyChunk({
          projectId: P1,
          conversationId: C1,
          bodyId: B1,
          offsetBytes: total + 1,
        }),
      "ERR_INVALID_RECORD"
    );
    for (const bad of [
      { offsetBytes: null },
      { offsetBytes: -1 },
      { offsetBytes: 1.5 },
      { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
      { lengthBytes: null },
      { lengthBytes: 0 },
      { lengthBytes: 16385 },
      { lengthBytes: 1.5 },
    ]) {
      expectCode(
        () =>
          bodies.readBodyChunk({
            projectId: P1,
            conversationId: C1,
            bodyId: B1,
            ...bad,
          }),
        "ERR_INVALID_RECORD"
      );
    }
    // Empty body: end read is zero bytes with eof.
    bodies.putBody(scope(P1, C1, T1, { bodyId: B2, text: "" }));
    const emptyEnd = bodies.readBodyChunk({
      projectId: P1,
      conversationId: C1,
      bodyId: B2,
      offsetBytes: 0,
    });
    expect(emptyEnd).toMatchObject({ lengthBytes: 0, eof: true, totalBytes: 0 });
  });

  it("reads bounded slices from SQLite without fetching full text into JS", () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    const seenSql = [];
    const wrapped = {
      instanceId: store.instanceId,
      transaction: (fn) =>
        store.transaction((tx) => {
          const observed = {
            run: (sql, ...rest) => {
              seenSql.push(sql);
              return tx.run(sql, ...rest);
            },
            get: (sql, ...rest) => {
              seenSql.push(sql);
              const row = tx.get(sql, ...rest);
              if (row && typeof row === "object" && "body_text" in row) {
                throw new Error("full text fetched");
              }
              return row;
            },
            all: (sql, ...rest) => {
              seenSql.push(sql);
              return tx.all(sql, ...rest);
            },
          };
          return fn(observed);
        }),
      close: () => store.close(),
    };
    const bodies = createSessionBodies({
      store: wrapped,
      verifyOwnerEvidence: strictTrue,
    });
    const bodiesReal = createSessionBodies({ store, verifyOwnerEvidence: strictTrue });
    bodiesReal.putBody(scope(P1, C1, T1, { bodyId: B1, text: "hello 🌍 world" }));
    seenSql.length = 0;
    bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 });
    bodies.readBodyChunk({ projectId: P1, conversationId: C1, bodyId: B1 });
    expect(seenSql.length).toBeGreaterThan(0);
    for (const sql of seenSql) {
      expect(String(sql)).not.toMatch(/SELECT body_text/i);
      expect(String(sql)).not.toContain("SELECT *");
    }
  });
});

describe("proof handling", () => {
  it("denies false, non-boolean, throwing, and async proof without leaks", () => {
    for (const verifier of [
      () => false,
      () => 1,
      () => "true",
      () => {
        throw new Error("secret-evidence-failure");
      },
      () => Promise.resolve(true),
    ]) {
      const dir = tempDir();
      const f = openFresh(dir, "p.sqlite3", { bodyVerifier: verifier });
      seedChat(f.records, f.bindings, P1, C1, T1);
      const err = expectCode(
        () => f.bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" })),
        "ERR_OWNER_UNVERIFIED"
      );
      expect(String(err?.message)).not.toContain("secret");
    }
  });

  it("passes frozen facts including host generation", () => {
    const dir = tempDir();
    const seen = [];
    const f = openFresh(dir, "p.sqlite3", {
      bodyVerifier: (facts) => {
        seen.push(facts);
        return true;
      },
    });
    seedChat(f.records, f.bindings, P1, C1, T1);
    f.bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" }));
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).toMatchObject({
      action: "live",
      projectId: P1,
      conversationId: C1,
      ownerToken: T1,
      generation: 1,
      hostGeneration: H1,
    });
  });
});

describe("stored corruption", () => {
  it("detects malformed stored rows on metadata/chunk and exact-retry paths", () => {
    const dir = tempDir();
    const { store, records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "hello" }));
    // Malformed hash shape: metadata and chunk reject.
    store.transaction((tx) =>
      tx.run("UPDATE large_bodies SET sha256_hex = ? WHERE id = ?", ["zzz", B1])
    );
    expectCode(
      () => bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 }),
      "ERR_STORAGE"
    );
    expectCode(
      () => bodies.readBodyChunk({ projectId: P1, conversationId: C1, bodyId: B1 }),
      "ERR_STORAGE"
    );
    // Byte-length mismatch: metadata detects the SQL length divergence.
    store.transaction((tx) =>
      tx.run("UPDATE large_bodies SET sha256_hex = ?, byte_len = ? WHERE id = ?", [
        createHash("sha256").update("hello", "utf8").digest("hex"),
        999,
        B1,
      ])
    );
    expectCode(
      () => bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 }),
      "ERR_STORAGE"
    );
    // Tampered text: exact put retry detects the content/hash mismatch.
    store.transaction((tx) =>
      tx.run(
        "UPDATE large_bodies SET byte_len = ?, sha256_hex = ?, body_text = ? WHERE id = ?",
        [
          Buffer.byteLength("hello", "utf8"),
          createHash("sha256").update("hello", "utf8").digest("hex"),
          "hellO",
          B1,
        ]
      )
    );
    // Metadata shape still reads (valid hex/length), but exact retry fails.
    expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "hello" })),
      "ERR_STORAGE"
    );
    // Bad timestamp and non-text storage both reject.
    store.transaction((tx) =>
      tx.run("UPDATE large_bodies SET created_at_ms = ? WHERE id = ?", [-5, B1])
    );
    expectCode(
      () => bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 }),
      "ERR_STORAGE"
    );
  });

  it("rejects a corrupt oversized stored row from metadata preflight without loading body text", () => {
    const dir = tempDir();
    const { store, records, bindings } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    // Synthetic corrupt row: 1MiB+1 bytes of body with metadata claiming
    // the oversized length. A putBody exact-ID retry with ordinary valid
    // text must fail ERR_STORAGE from the metadata preflight, never by
    // loading the full stored body into JS.
    const corrupt = "z".repeat(1048576 + 1);
    store.transaction((tx) =>
      tx.run(
        "INSERT INTO large_bodies(id, conversation_id, byte_len, sha256_hex, body_text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [
          B1,
          C1,
          1048577,
          createHash("sha256").update(corrupt, "utf8").digest("hex"),
          corrupt,
          1700000000003,
        ]
      )
    );
    const wrapped = {
      instanceId: store.instanceId,
      transaction: (fn) =>
        store.transaction((tx) => {
          const observed = {
            run: (sql, ...rest) => tx.run(sql, ...rest),
            get: (sql, ...rest) => {
              const row = tx.get(sql, ...rest);
              if (row && typeof row === "object" && "body_text" in row) {
                throw new Error("full text fetched");
              }
              return row;
            },
            all: (sql, ...rest) => tx.all(sql, ...rest),
          };
          return fn(observed);
        }),
      close: () => store.close(),
    };
    const bodies = createSessionBodies({
      store: wrapped,
      verifyOwnerEvidence: strictTrue,
    });
    const err = expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "ordinary valid" })),
      "ERR_STORAGE"
    );
    expect(String(err?.message)).not.toContain("full text fetched");
    // Non-text stored body (bound Uint8Array blob, valid timestamp) rejects
    // on metadata and chunk reads alike.
    store.transaction((tx) =>
      tx.run(
        "INSERT INTO large_bodies(id, conversation_id, byte_len, sha256_hex, body_text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [
          B2,
          C1,
          3,
          createHash("sha256").update("abc", "utf8").digest("hex"),
          new Uint8Array([97, 98, 99]),
          1700000000004,
        ]
      )
    );
    const bodiesReal = createSessionBodies({ store, verifyOwnerEvidence: strictTrue });
    expectCode(
      () => bodiesReal.getBody({ projectId: P1, conversationId: C1, bodyId: B2 }),
      "ERR_STORAGE"
    );
    expectCode(
      () => bodiesReal.readBodyChunk({ projectId: P1, conversationId: C1, bodyId: B2 }),
      "ERR_STORAGE"
    );
  });
});

describe("composition and transaction boundary", () => {
  it("composes body writes with outer mutations atomically and enforces lineage", () => {
    const dir = tempDir();
    const { store, records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    // Successful outer compose persists both the body and the trusted row.
    store.transaction((tx) => {
      const inner = bodies.inTransaction(tx);
      inner.putBody(scope(P1, C1, T1, { bodyId: B1, text: "composed" }));
      tx.run(
        "INSERT INTO events(conversation_id, seq, event_key, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [C1, 1, "k1", "note", "{}", 1700000000009]
      );
    });
    expect(bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 })?.byteLength).toBe(8);
    // Aborted outer compose rolls both back together.
    let aborted = null;
    try {
      store.transaction((tx) => {
        const inner = bodies.inTransaction(tx);
        inner.putBody(scope(P1, C1, T1, { bodyId: B2, text: "rolled" }));
        tx.run(
          "INSERT INTO events(conversation_id, seq, event_key, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          [C1, 2, "k2", "note", "{}", 1700000000010]
        );
        throw new Error("outer-abort");
      });
    } catch (error) {
      aborted = error;
    }
    expect(aborted?.message).toBe("outer-abort");
    expect(
      bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B2 })
    ).toBe(null);
    expect(
      store.transaction((tx) =>
        tx.get("SELECT seq FROM events WHERE conversation_id = ? AND seq = ?", [C1, 2])
      )
    ).toBe(undefined);
  });

  it("rejects expired, foreign, nested, and closed-store use", () => {
    const dir = tempDir();
    const { store, records, bindings, bodies } = openFresh(dir, "a.sqlite3");
    seedChat(records, bindings, P1, C1, T1);
    let saved;
    store.transaction((tx) => {
      saved = tx;
    });
    expectCode(() => bodies.inTransaction(saved), "ERR_INVALID_TX");
    const foreign = openFresh(tempDir(), "f.sqlite3");
    let foreignTx;
    foreign.store.transaction((tx) => {
      foreignTx = tx;
      expectCode(() => bodies.inTransaction(tx), "ERR_STORAGE");
    });
    void foreignTx;
    expectCode(
      () =>
        store.transaction((tx) => {
          const inner = bodies.inTransaction(tx);
          inner.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" }));
          bodies.putBody(scope(P1, C1, T1, { bodyId: B2, text: "y" }));
        }),
      "ERR_INVALID_TX"
    );
    expect(
      bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 })
    ).toBe(null);
    store.close();
    expectCode(
      () => bodies.putBody(scope(P1, C1, T1, { bodyId: B1, text: "x" })),
      "ERR_CLOSED"
    );
    expectCode(
      () => bodies.getBody({ projectId: P1, conversationId: C1, bodyId: B1 }),
      "ERR_CLOSED"
    );
  });
});
