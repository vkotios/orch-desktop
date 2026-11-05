// CHO-03 native dual-write adapter — Vitest coverage for the Codex happy path.

import { describe, it, afterEach, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createNativeSessionPersistence } from "../server/native-session-persistence.mjs";

const owned = [];
const dirs = [];

function makePersistence() {
  const dir = mkdtempSync(join(tmpdir(), "native-persist-"));
  dirs.push(dir);
  const hostGeneration = randomUUID();
  const connectionId = randomUUID();
  const persistence = createNativeSessionPersistence({
    databasePath: join(dir, "sessions.sqlite3"),
    hostGeneration,
    verifyOwnerEvidence: (facts) =>
      facts?.evidence?.connectionId === connectionId,
  });
  owned.push(persistence);
  return { persistence, hostGeneration, evidence: { connectionId }, dir };
}

afterEach(() => {
  for (const p of owned) {
    try { p.close(); } catch { /* already closed */ }
  }
  owned.length = 0;
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

describe("native-session-persistence Codex dual-write", () => {
  it("journals project, turn, delta, and completed outcome", () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/native-persist",
      name: "native-persist",
    });
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const operationId = randomUUID();

    persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    persistence.beginTurn({
      conversationId,
      turnId,
      operationId,
      prompt: "say hello",
      effort: "low",
      evidence,
    });
    persistence.afterThreadStart({
      conversationId,
      nativeThreadId: "thread-1",
      evidence,
    });
    persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
    persistence.afterObserved({
      conversationId,
      turnId,
      operationId,
      nativeIdentity: "thread-1",
      nativeTurnId: "turn-native-1",
      evidence,
    });
    persistence.appendDelta({
      conversationId,
      turnId,
      operationId,
      partId: randomUUID(),
      nativeMessageId: "item-1",
      text: "hello ",
      evidence,
    });
    persistence.appendDelta({
      conversationId,
      turnId,
      operationId,
      partId: randomUUID(),
      nativeMessageId: "item-1",
      text: "world",
      evidence,
    });
    persistence.settleTurn({
      conversationId,
      turnId,
      operationId,
      outcome: "completed",
      nativeIdentity: "thread-1",
      nativeTurnId: "turn-native-1",
      evidence,
    });

    const page = persistence.pollHistory({
      projectId: project.id,
      conversationId,
      cursor: null,
      limit: 32,
    });
    expect(page.events.length).toBeGreaterThanOrEqual(3);
    const kinds = page.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "message_delta").length).toBe(2);
    expect(kinds).toContain("turn_outcome");

    const snap = persistence.getSnapshot({ projectId: project.id, conversationId });
    expect(snap).not.toBeNull();
    expect(snap.state.lastTurnOutcome.outcome).toBe("completed");
  });

  it("reuses an existing project row for the same path", () => {
    const { persistence } = makePersistence();
    const first = persistence.ensureProject({
      pathCanonical: "C:/synthetic/same-path",
      name: "one",
    });
    const second = persistence.ensureProject({
      pathCanonical: "C:/synthetic/same-path",
      name: "two",
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
  });

  it("hydrates user and assistant messages from durable deltas", () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/hydrate",
      name: "hydrate",
    });
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const operationId = randomUUID();
    persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    persistence.beginTurn({
      conversationId, turnId, operationId, prompt: "ping", effort: "low", evidence,
    });
    persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-h", evidence });
    persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
    persistence.afterObserved({
      conversationId, turnId, operationId,
      nativeIdentity: "thread-h", nativeTurnId: "native-h", evidence,
    });
    persistence.appendDelta({
      conversationId, turnId, operationId, partId: randomUUID(),
      nativeMessageId: "i1", text: "pong", evidence,
    });
    persistence.settleTurn({
      conversationId, turnId, operationId, outcome: "completed",
      nativeIdentity: "thread-h", nativeTurnId: "native-h", evidence,
    });

    const hydrated = persistence.hydrateConversation({
      projectId: project.id,
      conversationId,
    });
    expect(hydrated).not.toBeNull();
    expect(hydrated?.nativeThreadId).toBe("thread-h");
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "ping" }),
      expect.objectContaining({ role: "assistant", text: "pong", outcome: "completed" }),
    ]);
  });
});
