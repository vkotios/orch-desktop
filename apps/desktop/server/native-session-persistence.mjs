// Native-chat dual-write adapter onto the CHO-03 session store.
//
// Keeps the live mailbox path intact while journaling Codex turn lifecycle,
// message deltas, and terminal outcomes into SQLite. Construction opens the
// store; the caller owns close(). Provider I/O never runs inside store
// transactions. verifyOwnerEvidence is supplied by the host/native-chat owner.

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionStore } from "./session-store.mjs";
import { createSessionRecords } from "./session-records.mjs";
import { createSessionBindings } from "./session-bindings.mjs";
import { createSessionTurns } from "./session-turns.mjs";
import { createSessionMessageDeltas } from "./session-message-deltas.mjs";
import { createSessionToolFacts } from "./session-tool-facts.mjs";
import { createSessionTurnOutcomes } from "./session-turn-outcomes.mjs";
import { createSessionEvents } from "./session-events.mjs";
import { createSessionBodies } from "./session-bodies.mjs";

function defaultLivenessPath() {
  if (typeof process.env.CHO_PRODUCER_LIVENESS === "string" && process.env.CHO_PRODUCER_LIVENESS.trim()) {
    return path.resolve(process.env.CHO_PRODUCER_LIVENESS.trim());
  }
  return path.join(os.homedir(), ".cho-desktop", "producer-liveness.json");
}

function processSignalState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "invalid";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : null;
    if (code === "ESRCH") return "gone";
    // EPERM/EACCES mean the process may still exist; treat as uncertain.
    if (code === "EPERM" || code === "EACCES") return "uncertain";
    return "uncertain";
  }
}

function processIsAlive(pid) {
  return processSignalState(pid) === "alive";
}

function sleepMs(ms) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* spin briefly while waiting for the liveness lock */
  }
}

function readOwnProcessCreatedAt() {
  try {
    if (process.platform === "win32") {
      const raw = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CreationDate`,
        ],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      );
      const text = String(raw || "").trim();
      return text.length > 0 ? text : null;
    }
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close <= open) return null;
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function withLivenessLock(filePath, fn) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 2000;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        // Stale lock recovery: only steal when the locker pid is gone.
        try {
          const locker = Number(fs.readFileSync(lockPath, "utf8"));
          if (Number.isSafeInteger(locker) && processSignalState(locker) === "gone") {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* retry or throw below */
        }
        throw new Error("producer liveness map is locked by another host");
      }
      sleepMs(25);
    }
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readLivenessMap(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.entries
      && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)
      ? { ...parsed.entries }
      : {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
}

function writeLivenessMap(filePath, entries) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function cryptoRandomSuffix() {
  return randomUUID().slice(0, 8);
}

function updateLivenessMap(filePath, mutator) {
  return withLivenessLock(filePath, () => {
    const entries = readLivenessMap(filePath);
    const next = mutator(entries) ?? entries;
    writeLivenessMap(filePath, next);
    return next;
  });
}

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
  const livenessPath = typeof options.livenessPath === "string" && options.livenessPath.length > 0
    ? options.livenessPath
    : defaultLivenessPath();

  const store = openSessionStore({ databasePath });
  const records = createSessionRecords({ store, now });
  const bindings = createSessionBindings({ store, verifyOwnerEvidence, now });
  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const deltas = createSessionMessageDeltas({ store, verifyOwnerEvidence, now });
  const toolFacts = createSessionToolFacts({ store, verifyOwnerEvidence, now });
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

    // Reclaim a held fence only with proof the prior owner process is dead,
    // or release+reclaim when this same host process lost its in-memory meta.
    let fence = bindings.getProducer({ projectId, conversationId });
    if (fence?.state === "held") {
      updateLivenessMap(livenessPath, (entries) => {
        const prior = entries[conversationId];
        const priorPid = prior && Number.isSafeInteger(prior.pid) ? prior.pid : null;
        const priorHost = prior && typeof prior.hostGeneration === "string" ? prior.hostGeneration : null;
        const priorCreatedAt = prior && typeof prior.createdAt === "string" ? prior.createdAt : null;
        const sameOwnerRecord =
          prior
          && prior.ownerToken === fence.ownerToken
          && prior.generation === fence.generation;
        const signal = priorPid != null ? processSignalState(priorPid) : "invalid";
        if (
          sameOwnerRecord
          && priorHost === hostGeneration
          && priorPid === process.pid
        ) {
          bindings.settleProducer({
            projectId,
            conversationId,
            ownerToken: fence.ownerToken,
            generation: fence.generation,
            state: "released",
            evidence,
          });
          delete entries[conversationId];
          return entries;
        }
        if (
          sameOwnerRecord
          && priorPid != null
          && priorHost != null
          && priorHost !== hostGeneration
          && signal === "gone"
        ) {
          bindings.settleProducer({
            projectId,
            conversationId,
            ownerToken: fence.ownerToken,
            generation: fence.generation,
            state: "dead",
            evidence: {
              ...(evidence && typeof evidence === "object" ? evidence : {}),
              reason: "host-reclaim",
              priorPid,
              priorHostGeneration: priorHost,
              ...(priorCreatedAt ? { priorCreatedAt, identityVerdict: "gone" } : { identityVerdict: "gone" }),
            },
          });
          delete entries[conversationId];
          return entries;
        }
        if ((signal === "alive" || signal === "uncertain") && priorHost !== hostGeneration) {
          throw new Error(
            signal === "uncertain"
              ? "session producer fence owner liveness is uncertain; close the other CHO host or start a new chat"
              : "session producer fence is held by another live host",
          );
        }
        if (fence.state === "held") {
          throw new Error(
            "session producer fence is still held and prior owner liveness cannot be proven; close the other CHO host or start a new chat",
          );
        }
        return entries;
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

    const createdAt = readOwnProcessCreatedAt();
    updateLivenessMap(livenessPath, (entries) => {
      entries[conversationId] = {
        pid: process.pid,
        hostGeneration,
        ownerToken: claim.ownerToken,
        generation: claim.generation,
        projectId,
        claimedAtMs: typeof now === "function" ? now() : Date.now(),
        ...(createdAt ? { createdAt } : {}),
      };
      return entries;
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

  function releaseProducer({ conversationId, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) return null;
    const result = bindings.settleProducer({
      projectId: meta.projectId,
      conversationId,
      ownerToken: meta.ownerToken,
      generation: meta.ownerGeneration,
      state: "released",
      evidence,
    });
    updateLivenessMap(livenessPath, (entries) => {
      if (entries[conversationId]) delete entries[conversationId];
      return entries;
    });
    conversations.delete(conversationId);
    return result;
  }

  function releaseAllProducers({ evidence = null } = {}) {
    assertOpen();
    const ids = [...conversations.keys()];
    for (const conversationId of ids) {
      try {
        releaseProducer({ conversationId, evidence });
      } catch {
        // Best-effort release during shutdown; caller still closes the store.
      }
    }
  }

  function readBodyText(projectId, conversationId, bodyId) {
    const meta = bodies.getBody({ projectId, conversationId, bodyId });
    if (!meta || meta.byteLength === 0) return "";
    let offset = 0;
    const chunks = [];
    while (offset < meta.byteLength) {
      const chunk = bodies.readBodyChunk({
        projectId,
        conversationId,
        bodyId,
        offsetBytes: offset,
        lengthBytes: 16384,
      });
      if (chunk.lengthBytes > 0) {
        chunks.push(Buffer.from(chunk.dataBase64, "base64"));
      }
      if (chunk.eof) break;
      offset = chunk.nextOffsetBytes;
    }
    // Decode once across chunk boundaries so a multibyte character split at
    // 16 KiB is preserved (SESSION message-delta Unicode requirement).
    return Buffer.concat(chunks).toString("utf8");
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
    /** @type {Map<string, Array<{ id: string, title: string, status: string }>>} */
    const toolsByTurn = new Map();
    /** @type {Map<string, string>} */
    const outcomesByTurn = new Map();
    let cursor = null;
    let tip = 0;
    let hasMoreEvents = false;
    let eventCursor = null;
    for (let pageGuard = 0; pageGuard < 64; pageGuard += 1) {
      const page = events.pollEvents({
        projectId,
        conversationId,
        cursor,
        limit: 32,
      });
      tip = page.tip ?? tip;
      eventCursor = page.cursor ?? eventCursor;
      for (const event of page.events) {
        if (event.kind === "message_delta") {
          const turnId = event.payload?.turnId;
          const bodyId = event.payload?.bodyRef?.id ?? event.payload?.partId;
          if (typeof turnId !== "string" || typeof bodyId !== "string") continue;
          const text = readBodyText(projectId, conversationId, bodyId);
          const list = deltaTexts.get(turnId) ?? [];
          list.push(text);
          deltaTexts.set(turnId, list);
        } else if (event.kind === "tool_fact") {
          const turnId = event.payload?.turnId;
          const toolCallId = event.payload?.toolCallId;
          const toolTitle = event.payload?.toolTitle;
          const toolStatus = event.payload?.toolStatus;
          if (
            typeof turnId !== "string" ||
            typeof toolCallId !== "string" ||
            typeof toolTitle !== "string" ||
            typeof toolStatus !== "string"
          ) {
            continue;
          }
          const list = toolsByTurn.get(turnId) ?? [];
          const existing = list.findIndex((t) => t.id === toolCallId);
          const step = { id: toolCallId, title: toolTitle, status: toolStatus };
          if (existing === -1) list.push(step);
          else list[existing] = step;
          toolsByTurn.set(turnId, list);
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
        tools: toolsByTurn.get(turn.id) ?? [],
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
      eventCursor,
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

  function beginTurn({
    conversationId,
    turnId,
    operationId,
    prompt,
    effort = null,
    claudeInputUuid = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(turnId, "turnId");
    requireUuid(operationId, "operationId");
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("beginTurn requires a nonempty prompt");
    }
    if (meta.controller === "claude") {
      requireUuid(claudeInputUuid, "claudeInputUuid");
    } else if (claudeInputUuid !== null) {
      throw new Error("claudeInputUuid is Claude-only");
    }
    const scope = scopeOf(meta, evidence);
    turns.queueTurn({
      ...scope,
      turnId,
      operationId,
      prompt,
      ...(effort != null ? { effort } : {}),
      claudeInputUuid: meta.controller === "claude" ? claudeInputUuid : null,
    });
    turns.beginDispatch({ ...scope, turnId, operationId });
    return scope;
  }

  function setRequestedClaudeSession({ conversationId, sessionUuid, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    if (meta.controller !== "claude") throw new Error("setRequestedClaudeSession is Claude-only");
    requireUuid(sessionUuid, "sessionUuid");
    bindings.setRequestedClaudeSession({
      projectId: meta.projectId,
      conversationId: meta.conversationId,
      ownerToken: meta.ownerToken,
      generation: meta.ownerGeneration,
      sessionUuid,
      evidence,
    });
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

  function afterClaudeSessionBound({ conversationId, nativeSessionUuid, evidence = null }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    if (meta.controller !== "claude") throw new Error("afterClaudeSessionBound is Claude-only");
    requireUuid(nativeSessionUuid, "nativeSessionUuid");
    if (meta.boundNative) return;
    bindings.bindNativeRef({
      projectId: meta.projectId,
      conversationId: meta.conversationId,
      ownerToken: meta.ownerToken,
      generation: meta.ownerGeneration,
      controller: "claude",
      nativeSessionUuid,
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

  function appendToolFact({
    conversationId,
    turnId,
    operationId,
    factId,
    toolCallId,
    phase,
    toolTitle,
    toolStatus,
    summaryText,
    nativeMessageId = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(factId, "factId");
    const args = {
      ...scopeOf(meta, evidence),
      turnId,
      operationId,
      factId,
      toolCallId,
      phase,
      toolTitle,
      toolStatus,
      expectedSeq: meta.expectedSeq,
    };
    if (summaryText !== undefined) args.summaryText = summaryText;
    if (nativeMessageId != null) args.nativeMessageId = nativeMessageId;
    const result = toolFacts.appendToolFact(args);
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

  function pollHistory({ projectId, conversationId, cursor = null, limit = 32 }) {
    assertOpen();
    return events.pollEvents({
      projectId,
      conversationId,
      cursor,
      limit: Math.min(32, Math.max(1, limit ?? 32)),
    });
  }

  /**
   * Expand durable events into native-chat poll shape (text inlined from bodies).
   * Live mailbox events remain authoritative for approvals/clarifications.
   */
  function pollUiCatchup({
    projectId,
    conversationId,
    cursor = null,
    generation,
    limit = 32,
  }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    const conversation = records.getConversation({ projectId, conversationId });
    if (!conversation) {
      return { events: [], cursor: null, tip: 0, hasMore: false };
    }
    const page = events.pollEvents({
      projectId,
      conversationId,
      cursor,
      limit: Math.min(32, Math.max(1, limit ?? 32)),
    });
    const harness = conversation.controller;
    const uiEvents = [];
    for (const event of page.events) {
      if (event.kind === "message_delta") {
        const turnId = event.payload?.turnId;
        const bodyId = event.payload?.bodyRef?.id ?? event.payload?.partId;
        const partId = typeof event.payload?.partId === "string"
          ? event.payload.partId
          : (typeof bodyId === "string" ? bodyId : null);
        const nativeMessageId = event.payload?.nativeMessageId;
        if (typeof turnId !== "string" || typeof bodyId !== "string") continue;
        uiEvents.push({
          kind: "message_delta",
          source: "durable",
          seq: event.seq,
          ...(partId ? { partId } : {}),
          generation,
          harness,
          controller: harness,
          sessionId: conversationId,
          turnId,
          text: readBodyText(projectId, conversationId, bodyId),
          ...(typeof nativeMessageId === "string" ? { nativeItemId: nativeMessageId, nativeMessageId } : {}),
        });
      } else if (event.kind === "turn_outcome") {
        const turnId = event.payload?.turnId;
        const outcome = event.payload?.outcome;
        if (typeof turnId !== "string" || typeof outcome !== "string") continue;
        uiEvents.push({
          kind: outcome === "failed" || outcome === "unknown" ? "error" : "turn_complete",
          source: "durable",
          seq: event.seq,
          generation,
          harness,
          controller: harness,
          sessionId: conversationId,
          turnId,
          nativeOutcome: outcome,
          ...(outcome === "failed" || outcome === "unknown"
            ? { text: `Turn ended: ${outcome}` }
            : {}),
        });
      } else if (event.kind === "tool_fact") {
        const turnId = event.payload?.turnId;
        const toolCallId = event.payload?.toolCallId;
        const toolTitle = event.payload?.toolTitle;
        const toolStatus = event.payload?.toolStatus;
        if (
          typeof turnId !== "string" ||
          typeof toolCallId !== "string" ||
          typeof toolTitle !== "string" ||
          typeof toolStatus !== "string"
        ) {
          continue;
        }
        uiEvents.push({
          kind: "tool_call",
          source: "durable",
          seq: event.seq,
          generation,
          harness,
          controller: harness,
          sessionId: conversationId,
          turnId,
          toolCallId,
          toolTitle,
          toolStatus,
        });
      }
    }
    return {
      events: uiEvents,
      cursor: page.cursor ?? null,
      tip: page.tip ?? 0,
      hasMore: page.hasMore === true,
    };
  }

  function getDraft({ projectId, conversationId }) {
    assertOpen();
    return records.getDraft({ projectId, conversationId });
  }

  function saveDraft({ projectId, conversationId, saveId, expectedVersion, text }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    requireUuid(saveId, "saveId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("saveDraft requires a nonnegative expectedVersion");
    }
    if (typeof text !== "string") throw new Error("saveDraft requires text");
    return records.saveDraft({
      projectId,
      conversationId,
      saveId,
      expectedVersion,
      text,
    });
  }

  function getSnapshot({ projectId, conversationId }) {
    assertOpen();
    return events.getSnapshot({ projectId, conversationId });
  }

  /**
   * On reopen, settle stranded nonterminal turns as unknown. Never redispatches
   * execution; ownership must still verify for each conversation fence.
   */
  function reconcileStrandedTurns({ projectId, evidence = null } = {}) {
    assertOpen();
    requireUuid(projectId, "projectId");
    const conversationsList = records.listConversations({
      projectId,
      limit: 100,
      offset: 0,
      includeArchived: false,
    });
    const settled = [];
    for (const conversation of conversationsList) {
      const rows = store.transaction((tx) =>
        tx.all(
          `SELECT t.id AS turn_id, o.id AS operation_id, o.state AS op_state
           FROM turns t
           JOIN operations o ON o.turn_id = t.id AND o.conversation_id = t.conversation_id
           WHERE t.conversation_id = ?
             AND t.outcome IS NULL
             AND o.state IN ('queued', 'dispatching', 'written', 'observed')
           ORDER BY t.seq ASC
           LIMIT 32`,
          conversation.id,
        ),
      );
      for (const row of rows) {
        try {
          // Ensure a producer fence exists so settle authorization can succeed.
          ensureConversation({
            projectId,
            conversationId: conversation.id,
            controller: conversation.controller,
            modelRequested: conversation.modelRequested ?? null,
            effort: conversation.effort ?? null,
            role: conversation.role ?? "implement",
            evidence,
          });
          settleTurn({
            conversationId: conversation.id,
            turnId: row.turn_id,
            operationId: row.operation_id,
            outcome: "unknown",
            evidence,
          });
          settled.push({
            conversationId: conversation.id,
            turnId: row.turn_id,
            operationId: row.operation_id,
            priorOpState: row.op_state,
          });
        } catch {
          // Leave the turn for a later host that can prove ownership.
        }
      }
    }
    return settled;
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
    setRequestedClaudeSession,
    afterThreadStart,
    afterClaudeSessionBound,
    afterTurnWritten,
    afterObserved,
    appendDelta,
    appendToolFact,
    settleTurn,
    pollHistory,
    pollUiCatchup,
    getDraft,
    saveDraft,
    getSnapshot,
    listConversations,
    hydrateConversation,
    reconcileStrandedTurns,
    releaseProducer,
    releaseAllProducers,
    close,
  });
}
