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

  it("acknowledges prior-host stranded turns without adopting their hostGeneration", { timeout: 20_000 }, () => {
    const first = makePersistence();
    const project = first.persistence.ensureProject({
      pathCanonical: "C:/synthetic/prior-ack",
      name: "prior-ack",
    });
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const operationId = randomUUID();
    first.persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence: first.evidence,
    });
    first.persistence.beginTurn({
      conversationId, turnId, operationId, prompt: "prior stranded", effort: "low", evidence: first.evidence,
    });
    first.persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-p", evidence: first.evidence });
    first.persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence: first.evidence });
    first.persistence.releaseProducer({ conversationId, evidence: first.evidence });
    first.persistence.close();

    const connectionId = randomUUID();
    const second = createNativeSessionPersistence({
      databasePath: join(first.dir, "sessions.sqlite3"),
      hostGeneration: randomUUID(),
      livenessPath: join(first.dir, "liveness-2.json"),
      verifyOwnerEvidence: (facts) => facts?.evidence?.connectionId === connectionId,
    });
    owned.push(second);
    const evidence = { connectionId };
    second.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    const reconciled = second.reconcileStrandedTurns({ projectId: project.id, evidence });
    expect(reconciled.settled).toEqual([]);
    expect(reconciled.unresolved).toEqual([
      expect.objectContaining({ conversationId, turnId, operationId }),
    ]);
    const ack = second.acknowledgePriorOwnerTurn({
      conversationId, turnId, operationId, evidence,
    });
    expect(ack).toMatchObject({ acknowledged: true, turnId, operationId });
    const after = second.reconcileStrandedTurns({ projectId: project.id, evidence });
    expect(after.unresolved).toEqual([]);
    expect(after.settled).toEqual([]);
    const hydrated = second.hydrateConversation({ projectId: project.id, conversationId });
    expect(hydrated?.messages.some((m) => m.role === "assistant" && m.outcome === "unknown")).toBe(true);
  });

  it("refuses prior-owner acknowledgement when current owner proof is rejected", { timeout: 20_000 }, () => {
    const first = makePersistence();
    const project = first.persistence.ensureProject({
      pathCanonical: "C:/synthetic/prior-deny",
      name: "prior-deny",
    });
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const operationId = randomUUID();
    first.persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence: first.evidence,
    });
    first.persistence.beginTurn({
      conversationId, turnId, operationId, prompt: "deny me", effort: "low", evidence: first.evidence,
    });
    first.persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-d", evidence: first.evidence });
    first.persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence: first.evidence });
    first.persistence.releaseProducer({ conversationId, evidence: first.evidence });
    first.persistence.close();

    let allow = true;
    const connectionId = randomUUID();
    const second = createNativeSessionPersistence({
      databasePath: join(first.dir, "sessions.sqlite3"),
      hostGeneration: randomUUID(),
      livenessPath: join(first.dir, "liveness-deny.json"),
      verifyOwnerEvidence: (facts) => allow && facts?.evidence?.connectionId === connectionId,
    });
    owned.push(second);
    const evidence = { connectionId };
    second.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    allow = false;
    expect(() =>
      second.acknowledgePriorOwnerTurn({
        conversationId, turnId, operationId, evidence: { connectionId: "revoked" },
      }),
    ).toThrow(/not verified|ERR_OWNER_UNVERIFIED|ownership/i);
  });

  it("hydrates imported history plus later native turns on the same conversation", { timeout: 20_000 }, () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/import-continue",
      name: "import-continue",
    });
    const imported = persistence.importTranscript({
      projectId: project.id,
      source: "continue-fixture",
      sourceKey: "continue-1",
      title: "Continued import",
      controller: "codex",
      messages: [
        { role: "user", text: "imported q" },
        { role: "assistant", text: "imported a" },
      ],
    });
    const turnId = randomUUID();
    const operationId = randomUUID();
    persistence.ensureConversation({
      projectId: project.id,
      conversationId: imported.conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    persistence.beginTurn({
      conversationId: imported.conversationId,
      turnId,
      operationId,
      prompt: "new question",
      effort: "low",
      evidence,
    });
    persistence.afterThreadStart({
      conversationId: imported.conversationId,
      nativeThreadId: "thread-import-cont",
      evidence,
    });
    persistence.afterTurnWritten({
      conversationId: imported.conversationId, turnId, operationId, evidence,
    });
    persistence.afterObserved({
      conversationId: imported.conversationId, turnId, operationId,
      nativeIdentity: "thread-import-cont", nativeTurnId: "native-import-cont", evidence,
    });
    persistence.appendDelta({
      conversationId: imported.conversationId, turnId, operationId, partId: randomUUID(),
      nativeMessageId: "i-cont", text: "new answer", evidence,
    });
    persistence.settleTurn({
      conversationId: imported.conversationId, turnId, operationId, outcome: "completed",
      nativeIdentity: "thread-import-cont", nativeTurnId: "native-import-cont", evidence,
    });

    const hydrated = persistence.hydrateConversation({
      projectId: project.id,
      conversationId: imported.conversationId,
    });
    expect(hydrated?.imported).toBe(true);
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "imported q", imported: true }),
      expect.objectContaining({ role: "assistant", text: "imported a", imported: true }),
      expect.objectContaining({ role: "user", text: "new question" }),
      expect.objectContaining({ role: "assistant", text: "new answer", outcome: "completed" }),
    ]);
    const exported = persistence.exportConversation({
      projectId: project.id,
      conversationId: imported.conversationId,
    });
    expect(exported?.conversation.messages).toHaveLength(4);
    expect(exported?.truncated).toBe(false);
  });

  it("exports with full hydrate caps and pages multi-turn history", { timeout: 30_000 }, () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/paging-export",
      name: "paging-export",
    });
    const conversationId = randomUUID();
    persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-page", evidence });
    for (let i = 0; i < 5; i += 1) {
      const turnId = randomUUID();
      const operationId = randomUUID();
      persistence.beginTurn({
        conversationId, turnId, operationId, prompt: `q${i}`, effort: "low", evidence,
      });
      persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
      persistence.afterObserved({
        conversationId, turnId, operationId,
        nativeIdentity: "thread-page", nativeTurnId: `native-${i}`, evidence,
      });
      persistence.appendDelta({
        conversationId, turnId, operationId, partId: randomUUID(),
        nativeMessageId: `m-${i}`, text: `a${i}`, evidence,
      });
      persistence.settleTurn({
        conversationId, turnId, operationId, outcome: "completed",
        nativeIdentity: "thread-page", nativeTurnId: `native-${i}`, evidence,
      });
    }
    const narrow = persistence.hydrateConversation({
      projectId: project.id,
      conversationId,
      maxEventPages: 1,
      turnLimit: 2,
    });
    expect(narrow?.messages.length).toBeLessThanOrEqual(4);
    expect(narrow?.hasMoreTurns).toBe(true);
    expect(narrow?.turnsLoaded).toBe(2);
    const exported = persistence.exportConversation({
      projectId: project.id,
      conversationId,
    });
    expect(exported?.conversation.messages.length).toBe(10);
    expect(exported?.truncated).toBe(false);
    expect(exported?.truncation).toEqual({ events: false, turns: false });
  });

  it("exports all turns past the UI 500-turn window and discloses turn-cap truncation on hydrate", {
    timeout: 180_000,
  }, () => {
    const { persistence, evidence } = makePersistence();
    const project = persistence.ensureProject({
      pathCanonical: "C:/synthetic/export-501",
      name: "export-501",
    });
    const conversationId = randomUUID();
    persistence.ensureConversation({
      projectId: project.id,
      conversationId,
      controller: "codex",
      modelRequested: "gpt-test",
      effort: "low",
      role: "implement",
      evidence,
    });
    persistence.afterThreadStart({ conversationId, nativeThreadId: "thread-501", evidence });
    const turnCount = 501;
    for (let i = 0; i < turnCount; i += 1) {
      const turnId = randomUUID();
      const operationId = randomUUID();
      persistence.beginTurn({
        conversationId, turnId, operationId, prompt: `q${i}`, effort: "low", evidence,
      });
      persistence.afterTurnWritten({ conversationId, turnId, operationId, evidence });
      persistence.afterObserved({
        conversationId, turnId, operationId,
        nativeIdentity: "thread-501", nativeTurnId: `native-${i}`, evidence,
      });
      persistence.appendDelta({
        conversationId, turnId, operationId, partId: randomUUID(),
        nativeMessageId: `m-${i}`, text: `a${i}`, evidence,
      });
      persistence.settleTurn({
        conversationId, turnId, operationId, outcome: "completed",
        nativeIdentity: "thread-501", nativeTurnId: `native-${i}`, evidence,
      });
    }

    const uiWindow = persistence.hydrateConversation({
      projectId: project.id,
      conversationId,
      maxEventPages: 512,
      turnLimit: 500,
    });
    expect(uiWindow?.turnsLoaded).toBe(500);
    expect(uiWindow?.hasMoreTurns).toBe(true);
    // UI hydrate previously claimed truncated:false when only the turn axis was hit.
    expect(uiWindow?.hasMoreEvents === true || uiWindow?.hasMoreTurns === true).toBe(true);

    const exported = persistence.exportConversation({
      projectId: project.id,
      conversationId,
    });
    expect(exported?.conversation.turnsLoaded).toBe(501);
    expect(exported?.conversation.hasMoreTurns).toBe(false);
    expect(exported?.conversation.messages.length).toBe(turnCount * 2);
    expect(exported?.truncated).toBe(false);
    expect(exported?.truncation).toEqual({ events: false, turns: false });
  });
});
