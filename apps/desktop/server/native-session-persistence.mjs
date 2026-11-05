// Native-chat dual-write adapter onto the CHO-03 session store.
//
// Keeps the live mailbox path intact while journaling Codex turn lifecycle,
// message deltas, and terminal outcomes into SQLite. Construction opens the
// store; the caller owns close(). Provider I/O never runs inside store
// transactions. verifyOwnerEvidence is supplied by the host/native-chat owner.

import { randomUUID } from "node:crypto";
import { openSessionStore } from "./session-store.mjs";
import { createSessionRecords } from "./session-records.mjs";
import { createSessionBindings } from "./session-bindings.mjs";
import { createSessionTurns } from "./session-turns.mjs";
import { createSessionMessageDeltas } from "./session-message-deltas.mjs";
import { createSessionTurnOutcomes } from "./session-turn-outcomes.mjs";
import { createSessionEvents } from "./session-events.mjs";
import { createSessionBodies } from "./session-bodies.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function requireUuid(value, label) {
  if (!isUuid(value)) throw new Error(`native session persistence requires a UUID ${label}`);
  return value;
}

/**
 * @param {{
 *   databasePath: string,
 *   hostGeneration: string,
 *   verifyOwnerEvidence: (evidence: unknown) => boolean,
 *   now?: () => number,
 * }} options
 */
export function createNativeSessionPersistence(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("createNativeSessionPersistence requires options");
  }
  const { databasePath, hostGeneration, verifyOwnerEvidence, now = Date.now } = options;
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("createNativeSessionPersistence requires databasePath");
  }
  requireUuid(hostGeneration, "hostGeneration");
  if (typeof verifyOwnerEvidence !== "function") {
    throw new TypeError("createNativeSessionPersistence requires verifyOwnerEvidence");
  }

  const store = openSessionStore({ databasePath });
  const records = createSessionRecords({ store, now });
  const bindings = createSessionBindings({ store, verifyOwnerEvidence, now });
  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const deltas = createSessionMessageDeltas({ store, verifyOwnerEvidence, now });
  const outcomes = createSessionTurnOutcomes({ store, verifyOwnerEvidence, now });
  const events = createSessionEvents({ store, verifyOwnerEvidence, now });
  const bodies = createSessionBodies({ store, verifyOwnerEvidence, now });

  /** @type {Map<string, { id: string, pathCanonical: string, name: string }>} */
  const projectsByPath = new Map();
  /**
   * @type {Map<string, {
   *   projectId: string,
   *   conversationId: string,
   *   controller: "codex"|"claude",
   *   ownerToken: string,
   *   ownerGeneration: number,
   *   expectedSeq: number,
   *   boundNative: boolean,
   * }>}
   */
  const conversations = new Map();
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error("native session persistence is closed");
  }

  function findProjectByPath(pathCanonical) {
    const cached = projectsByPath.get(pathCanonical);
    if (cached) return cached;
    const listed = records.listProjects({ limit: 100, offset: 0, includeArchived: true });
    for (const project of listed) {
      projectsByPath.set(project.pathCanonical, project);
    }
    return projectsByPath.get(pathCanonical) ?? null;
  }

  function ensureProject({ pathCanonical, name }) {
    assertOpen();
    if (typeof pathCanonical !== "string" || pathCanonical.length === 0) {
      throw new Error("ensureProject requires pathCanonical");
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("ensureProject requires name");
    }
    const existing = findProjectByPath(pathCanonical);
    if (existing) return existing;
    const project = records.createProject({
      id: randomUUID(),
      name: name.slice(0, 256),
      pathCanonical,
    });
    projectsByPath.set(pathCanonical, project);
    return project;
  }

  function ensureConversation({
    projectId,
    conversationId,
    controller,
    modelRequested = null,
    effort = null,
    role = "implement",
    evidence = null,
  }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    if (controller !== "codex" && controller !== "claude") {
      throw new Error("ensureConversation controller must be codex or claude");
    }
    let meta = conversations.get(conversationId);
    if (meta) return meta;

    const existing = records.getConversation({ projectId, conversationId });
    if (!existing) {
      records.createConversation({
        id: conversationId,
        projectId,
        controller,
        title: "",
        modelRequested,
        effort,
        role,
      });
    }

    // Reclaim a fence left held by a previous host process so reopen can write.
    let fence = bindings.getProducer({ projectId, conversationId });
    if (fence?.state === "held") {
      bindings.settleProducer({
        projectId,
        conversationId,
        ownerToken: fence.ownerToken,
        generation: fence.generation,
        state: "dead",
        evidence: { ...(evidence && typeof evidence === "object" ? evidence : {}), reason: "host-reclaim" },
      });
      fence = bindings.getProducer({ projectId, conversationId });
    }

    const ownerToken = randomUUID();
    const expectedGeneration = fence == null ? 0 : fence.generation;
    const claim = bindings.claimProducer({
      projectId,
      conversationId,
      ownerToken,
      expectedGeneration,
      evidence,
    });

    const tip = events.getSnapshot({ projectId, conversationId });
    const native = bindings.getNativeRef({ projectId, conversationId });
    meta = {
      projectId,
      conversationId,
      controller,
      ownerToken: claim.ownerToken,
      ownerGeneration: claim.generation,
      expectedSeq: tip?.lastSeq ?? 0,
      boundNative: native != null && (
        (controller === "codex" && typeof native.nativeThreadId === "string")
        || (controller === "claude" && typeof native.nativeSessionUuid === "string")
      ),
    };
    conversations.set(conversationId, meta);
    return meta;
  }

  function readBodyText(projectId, conversationId, bodyId) {
    const meta = bodies.getBody({ projectId, conversationId, bodyId });
    if (!meta || meta.byteLength === 0) return "";
    let offset = 0;
    const parts = [];
    while (offset < meta.byteLength) {
      const chunk = bodies.readBodyChunk({
        projectId,
        conversationId,
        bodyId,
        offsetBytes: offset,
        lengthBytes: 16384,
      });
      if (chunk.lengthBytes > 0) {
        parts.push(Buffer.from(chunk.dataBase64, "base64").toString("utf8"));
      }
      if (chunk.eof) break;
      offset = chunk.nextOffsetBytes;
    }
    return parts.join("");
  }

  function listConversations({ projectId, limit = 50 }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    return records.listConversations({ projectId, limit, offset: 0, includeArchived: false });
  }

  /**
   * Rebuild a UI-shaped transcript from durable turns + message_delta bodies.
   * Does not restore live approvals/clarifications (still memory-only).
   */
  function hydrateConversation({ projectId, conversationId }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    const conversation = records.getConversation({ projectId, conversationId });
    if (!conversation) return null;
    // listTurns strips prompts by design; hydrate each turn via getTurn.
    const turnSummaries = turns.listTurns({ projectId, conversationId, limit: 100, offset: 0 });
    /** @type {Map<string, string[]>} */
    const deltaTexts = new Map();
    /** @type {Map<string, string>} */
    const outcomesByTurn = new Map();
    let cursor = null;
    let tip = 0;
    let hasMoreEvents = false;
    for (let pageGuard = 0; pageGuard < 64; pageGuard += 1) {
      const page = events.pollEvents({
        projectId,
        conversationId,
        cursor,
        limit: 32,
      });
      tip = page.tip ?? tip;
      for (const event of page.events) {
        if (event.kind === "message_delta") {
          const turnId = event.payload?.turnId;
          const bodyId = event.payload?.bodyRef?.id ?? event.payload?.partId;
          if (typeof turnId !== "string" || typeof bodyId !== "string") continue;
          const text = readBodyText(projectId, conversationId, bodyId);
          const list = deltaTexts.get(turnId) ?? [];
          list.push(text);
          deltaTexts.set(turnId, list);
        } else if (event.kind === "turn_outcome") {
          const turnId = event.payload?.turnId;
          const outcome = event.payload?.outcome;
          if (typeof turnId === "string" && typeof outcome === "string") {
            outcomesByTurn.set(turnId, outcome);
          }
        }
      }
      if (!page.hasMore) {
        hasMoreEvents = false;
        break;
      }
      cursor = page.cursor;
      hasMoreEvents = true;
    }

    const messages = [];
    for (const summary of turnSummaries) {
      const turn = turns.getTurn({
        projectId,
        conversationId,
        turnId: summary.id,
      });
      if (!turn) continue;
      let prompt = typeof turn.prompt === "string" ? turn.prompt : "";
      if (!prompt && turn.promptRef) {
        prompt = readBodyText(projectId, conversationId, turn.promptRef);
      }
      messages.push({
        id: `user-${turn.id}`,
        role: "user",
        text: prompt,
        tools: [],
        isStreaming: false,
      });
      const outcome = outcomesByTurn.get(turn.id) ?? turn.outcome ?? undefined;
      const assistantText = (deltaTexts.get(turn.id) ?? []).join("");
      const terminal = outcome === "completed" || outcome === "failed"
        || outcome === "interrupted" || outcome === "unknown";
      messages.push({
        id: turn.id,
        role: "assistant",
        text: assistantText,
        tools: [],
        outcome,
        isError: outcome === "failed" || outcome === "unknown",
        isStreaming: !terminal && turn.intentState !== "completed",
        nativeTurnId: turn.nativeTurnId ?? undefined,
      });
    }

    const native = bindings.getNativeRef({ projectId, conversationId });
    return {
      conversationId,
      projectId,
      controller: conversation.controller,
      model: conversation.modelRequested,
      role: conversation.role,
      effort: conversation.effort,
      title: conversation.title || "Chat",
      nativeThreadId: native?.nativeThreadId ?? null,
      nativeSessionUuid: native?.nativeSessionUuid ?? null,
      messages,
      eventTip: tip,
      hasMoreEvents,
    };
  }

  function scopeOf(meta, evidence) {
    return {
      projectId: meta.projectId,
      conversationId: meta.conversationId,
      ownerToken: meta.ownerToken,
      ownerGeneration: meta.ownerGeneration,
      hostGeneration,
      evidence,
    };
  }

  function beginTurn({ conversationId, turnId, operationId, prompt, effort = null, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(turnId, "turnId");
    requireUuid(operationId, "operationId");
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("beginTurn requires a nonempty prompt");
    }
    const scope = scopeOf(meta, evidence);
    turns.queueTurn({
      ...scope,
      turnId,
      operationId,
      prompt,
      ...(effort != null ? { effort } : {}),
      ...(meta.controller === "claude" ? {} : { claudeInputUuid: null }),
    });
    turns.beginDispatch({ ...scope, turnId, operationId });
    return scope;
  }

  function afterThreadStart({ conversationId, nativeThreadId, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    if (meta.controller !== "codex") throw new Error("afterThreadStart is Codex-only");
    if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
      throw new Error("afterThreadStart requires nativeThreadId");
    }
    if (meta.boundNative) return;
    bindings.bindNativeRef({
      projectId: meta.projectId,
      conversationId: meta.conversationId,
      ownerToken: meta.ownerToken,
      generation: meta.ownerGeneration,
      controller: "codex",
      nativeThreadId,
      evidence,
    });
    meta.boundNative = true;
  }

  function afterTurnWritten({ conversationId, turnId, operationId, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    turns.recordWritten({
      ...scopeOf(meta, evidence),
      turnId,
      operationId,
    });
  }

  function afterObserved({
    conversationId,
    turnId,
    operationId,
    nativeIdentity,
    nativeTurnId,
    claudeInputUuid = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    turns.recordObserved({
      ...scopeOf(meta, evidence),
      turnId,
      operationId,
      nativeFact: {
        nativeIdentity,
        nativeTurnId,
        claudeInputUuid,
      },
    });
  }

  function appendDelta({
    conversationId,
    turnId,
    operationId,
    partId,
    nativeMessageId,
    text,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(partId, "partId");
    const result = deltas.appendMessageDelta({
      ...scopeOf(meta, evidence),
      turnId,
      operationId,
      partId,
      nativeMessageId,
      text,
      expectedSeq: meta.expectedSeq,
    });
    meta.expectedSeq = result.cursor.seq;
    return result;
  }

  function settleTurn({
    conversationId,
    turnId,
    operationId,
    outcome,
    nativeIdentity = null,
    nativeTurnId = null,
    claudeInputUuid = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    const scope = scopeOf(meta, evidence);
    const args = {
      ...scope,
      turnId,
      operationId,
      outcome,
      expectedSeq: meta.expectedSeq,
    };
    if (outcome === "completed" || outcome === "interrupted") {
      args.nativeFact = {
        nativeIdentity,
        nativeTurnId,
        claudeInputUuid,
      };
    } else if (nativeIdentity != null || nativeTurnId != null) {
      args.nativeFact = {
        nativeIdentity,
        nativeTurnId,
        claudeInputUuid,
      };
    }
    const result = outcomes.settleTurn(args);
    meta.expectedSeq = result.cursor.seq;
    return result;
  }

  function pollHistory({ projectId, conversationId, cursor = null, limit = 64 }) {
    assertOpen();
    return events.pollEvents({ projectId, conversationId, cursor, limit });
  }

  function getSnapshot({ projectId, conversationId }) {
    assertOpen();
    return events.getSnapshot({ projectId, conversationId });
  }

  function close() {
    if (closed) return;
    closed = true;
    conversations.clear();
    projectsByPath.clear();
    store.close();
  }

  return Object.freeze({
    store,
    ensureProject,
    ensureConversation,
    beginTurn,
    afterThreadStart,
    afterTurnWritten,
    afterObserved,
    appendDelta,
    settleTurn,
    pollHistory,
    getSnapshot,
    listConversations,
    hydrateConversation,
    close,
  });
}
