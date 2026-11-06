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
    livenessPath: join(dir, "liveness.json"),
    verifyOwnerEvidence: (facts) => {
      if (facts?.action === "dead" && facts?.evidence?.reason === "host-reclaim") {
        return Number.isSafeInteger(facts.evidence.priorPid) && facts.evidence.priorPid !== process.pid;
      }
      return facts?.evidence?.connectionId === connectionId;
    },
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

  it("journals Claude request/bind/observe/delta/outcome", () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/claude-persist",
      name: "claude-persist",
    });
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const operationId = randomUUID();
    const sessionUuid = randomUUID();
    const inputUuid = randomUUID();
    persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "claude",
      modelRequested: "claude-test",
      effort: "high",
      role: "implement",
      evidence,
    });
    persistence.setRequestedClaudeSession({
      conversationId,
      sessionUuid,
      evidence,
    });
    persistence.beginTurn({
      conversationId,
      turnId,
      operationId,
      prompt: "hi claude",
      effort: "high",
      claudeInputUuid: inputUuid,
      evidence,
    });
    persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
    persistence.afterClaudeSessionBound({
      conversationId,
      nativeSessionUuid: sessionUuid,
      evidence,
    });
    persistence.afterObserved({
      conversationId,
      turnId,
      operationId,
      nativeIdentity: sessionUuid,
      nativeTurnId: null,
      claudeInputUuid: inputUuid,
      evidence,
    });
    persistence.appendDelta({
      conversationId,
      turnId,
      operationId,
      partId: randomUUID(),
      nativeMessageId: "msg-1",
      text: "hello from claude",
      evidence,
    });
    persistence.settleTurn({
      conversationId,
      turnId,
      operationId,
      outcome: "completed",
      nativeIdentity: sessionUuid,
      nativeTurnId: null,
      claudeInputUuid: inputUuid,
      evidence,
    });
    const hydrated = persistence.hydrateConversation({
      projectId: project.id,
      conversationId,
    });
    expect(hydrated?.nativeSessionUuid).toBe(sessionUuid);
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hi claude" }),
      expect.objectContaining({ role: "assistant", text: "hello from claude", outcome: "completed" }),
    ]);
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

  it("preserves a multibyte character split across the 16 KiB body chunk boundary", () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/unicode-boundary",
      name: "unicode-boundary",
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
      conversationId, turnId, operationId, prompt: "unicode", effort: "low", evidence,
    });
    persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-u", evidence });
    persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
    persistence.afterObserved({
      conversationId, turnId, operationId,
      nativeIdentity: "thread-u", nativeTurnId: "native-u", evidence,
    });
    const text = `${"a".repeat(16383)}€ tail`;
    persistence.appendDelta({
      conversationId, turnId, operationId, partId: randomUUID(),
      nativeMessageId: "i-u", text, evidence,
    });
    persistence.settleTurn({
      conversationId, turnId, operationId, outcome: "completed",
      nativeIdentity: "thread-u", nativeTurnId: "native-u", evidence,
    });
    const hydrated = persistence.hydrateConversation({
      projectId: project.id,
      conversationId,
    });
    expect(hydrated?.messages[1]?.text).toBe(text);
    expect(hydrated?.messages[1]?.text.length).toBe(16389);
  });

  it("imports a transcript into large_bodies and hydrates without event-store tip-0 snapshots", () => {
    const { persistence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/import",
      name: "import",
    });
    const imported = persistence.importTranscript({
      projectId: project.id,
      source: "test-fixture",
      sourceKey: "fixture-1",
      title: "Imported chat",
      controller: "codex",
      messages: [
        { role: "user", text: "hello import" },
        { role: "assistant", text: "imported reply" },
      ],
    });
    expect(imported.created).toBe(true);
    expect(imported.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const hydrated = persistence.hydrateConversation({
      projectId: project.id,
      conversationId: imported.conversationId,
    });
    expect(hydrated?.imported).toBe(true);
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello import", imported: true }),
      expect.objectContaining({ role: "assistant", text: "imported reply", imported: true }),
    ]);

    // Idempotent receipt: same source/key returns the same conversation.
    const again = persistence.importTranscript({
      projectId: project.id,
      source: "test-fixture",
      sourceKey: "fixture-1",
      messages: [{ role: "user", text: "ignored" }],
    });
    expect(again).toEqual({
      created: false,
      conversationId: imported.conversationId,
      importBatchId: null,
    });
  });

  it("reconciles stranded turns for the current host without labeling them prior-owner", () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/reconcile",
      name: "reconcile",
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
      conversationId, turnId, operationId, prompt: "stranded", effort: "low", evidence,
    });
    persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-r", evidence });
    persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
    persistence.afterObserved({
      conversationId, turnId, operationId,
      nativeIdentity: "thread-r", nativeTurnId: "native-r", evidence,
    });

    const result = persistence.reconcileStrandedTurns({
      projectId: project.id,
      evidence,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.settled).toEqual([
      expect.objectContaining({ conversationId, turnId, operationId }),
    ]);
  });
});
