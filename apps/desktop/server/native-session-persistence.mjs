// Native-chat dual-write adapter onto the CHO-03 session store.
//
// Keeps the live mailbox path intact while journaling Codex turn lifecycle,
// message deltas, and terminal outcomes into SQLite. Construction opens the
// store; the caller owns close(). Provider I/O never runs inside store
// transactions. verifyOwnerEvidence is supplied by the host/native-chat owner.

import { createHash, randomUUID } from "node:crypto";
import { verifyIdentity } from "../../../orch/src/procs.mjs";
import { creationPoint } from "../../../orch/src/process-time.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionStore } from "./session-store.mjs";
import { migrateSessionStore } from "./session-store-migrate.mjs";
import { createSessionRecords } from "./session-records.mjs";
import { createSessionBindings } from "./session-bindings.mjs";
import { createSessionTurns } from "./session-turns.mjs";
import { createSessionMessageDeltas } from "./session-message-deltas.mjs";
import { createSessionToolFacts } from "./session-tool-facts.mjs";
import { createSessionTurnOutcomes } from "./session-turn-outcomes.mjs";
import { createSessionEvents } from "./session-events.mjs";
import { createSessionBodies } from "./session-bodies.mjs";
import { createSessionApprovals } from "./session-approvals.mjs";
import { createSessionClarifications } from "./session-clarifications.mjs";
import { createProducerAuthorizer } from "./session-producer-transaction.mjs";

function boundHydratedTranscript(payload, latest = true) {
  const ceiling = 900 * 1024;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > ceiling) {
    payload.hasMoreBytes = true;
    for (const key of ["historicalClarifications", "historicalApprovals", "messages"]) {
      const items = payload[key];
      if (!Array.isArray(items)) continue;
      const slice = (count) => {
        let start = key === "messages" && latest ? items.length - count : 0;
        let end = key === "messages" && latest ? items.length : count;
        if (key === "messages") {
          if (start > 0 && items[start]?.turnSeq != null && items[start - 1]?.turnSeq === items[start].turnSeq) start++;
          if (end < items.length && items[end - 1]?.turnSeq != null && items[end]?.turnSeq === items[end - 1].turnSeq) end--;
        }
        return items.slice(start, Math.max(start, end));
      };
      let lo = 0, hi = items.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        payload[key] = slice(mid);
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= ceiling) lo = mid;
        else hi = mid - 1;
      }
      payload[key] = slice(lo);
      if (key !== "messages" && payload[key].length < items.length) payload.historyMetadataTruncated = true;
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= ceiling) break;
    }
  }
  const firstTurn = payload.messages.find((m) => m.turnSeq != null);
  const firstImport = payload.messages.find((m) => m.importIndex != null);
  if (latest && firstTurn && (payload.hasMoreTurns || payload.hasMoreBytes)) payload.beforeTurnSeq = firstTurn.turnSeq;
  if (latest && firstImport?.importIndex > 0) payload.beforeImportedIndex = firstImport.importIndex;
  return payload;
}

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

function readProcessSnapshotSync(pid) {
  try {
    const helper = new URL("../../../orch/src/procs.mjs", import.meta.url).href;
    const script = `import {readProcessTable} from ${JSON.stringify(helper)}; const rows = await readProcessTable({pids:[Number(process.argv[1])],deadlineMs:3000}); process.stdout.write(JSON.stringify(rows));`;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, String(pid)],
      { encoding: "utf8", timeout: 4500, windowsHide: true }));
  } catch { return null; }
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
 *   verifyPendingApproval?: (facts: unknown) => boolean,
 *   verifyPendingQuestion?: (facts: unknown) => boolean,
 *   now?: () => number,
 * }} options
 */
export function createNativeSessionPersistence(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("createNativeSessionPersistence requires options");
  }
  const { databasePath, hostGeneration, verifyOwnerEvidence, now = Date.now } = options;
  const processSnapshot = typeof options.processTable === "function" ? options.processTable : readProcessSnapshotSync;
  let ownCreatedAt;
  function readOwnProcessCreatedAt() {
    if (ownCreatedAt === undefined) ownCreatedAt = processSnapshot(process.pid)?.find((row) => row.pid === process.pid)?.createdAt ?? null;
    return ownCreatedAt;
  }
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("createNativeSessionPersistence requires databasePath");
  }
  requireUuid(hostGeneration, "hostGeneration");
  if (typeof verifyOwnerEvidence !== "function") {
    throw new TypeError("createNativeSessionPersistence requires verifyOwnerEvidence");
  }
  const verifyPendingApproval =
    typeof options.verifyPendingApproval === "function"
      ? options.verifyPendingApproval
      : () => false;
  const verifyPendingQuestion =
    typeof options.verifyPendingQuestion === "function"
      ? options.verifyPendingQuestion
      : () => false;
  const livenessPath = typeof options.livenessPath === "string" && options.livenessPath.length > 0
    ? options.livenessPath
    : defaultLivenessPath();

  if (fs.existsSync(databasePath)) {
    // Fail-closed open still requires an explicit migrate for older schemas.
    migrateSessionStore({ databasePath });
  }
  const store = openSessionStore({ databasePath });
  const records = createSessionRecords({ store, now });
  const bindings = createSessionBindings({ store, verifyOwnerEvidence, now });
  const turns = createSessionTurns({ store, verifyOwnerEvidence, now });
  const deltas = createSessionMessageDeltas({ store, verifyOwnerEvidence, now });
  const toolFacts = createSessionToolFacts({ store, verifyOwnerEvidence, now });
  const outcomes = createSessionTurnOutcomes({ store, verifyOwnerEvidence, now });
  const events = createSessionEvents({ store, verifyOwnerEvidence, now });
  const bodies = createSessionBodies({ store, verifyOwnerEvidence, now });
  const approvals = createSessionApprovals({
    store,
    verifyOwnerEvidence,
    verifyPendingApproval,
    now,
  });
  const clarifications = createSessionClarifications({
    store,
    verifyOwnerEvidence,
    verifyPendingQuestion,
    now,
  });
  const authorizer = createProducerAuthorizer({ verifyOwnerEvidence });

  // Export pages past the UI hydrate window (512 event pages / 500 turns);
  // both axes disclose via hasMoreEvents / hasMoreTurns (+ export.truncation).
  const EXPORT_EVENT_PAGE_CEILING = 10_000;
  const EXPORT_TURN_CEILING = 10_000;
  const LIST_TURNS_PAGE = 100;

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
        const key = `${store.instanceId}:${conversationId}`;
        const prior = entries[key] ?? entries[conversationId];
        const priorPid = prior && Number.isSafeInteger(prior.pid) ? prior.pid : null;
        const priorHost = prior && typeof prior.hostGeneration === "string" ? prior.hostGeneration : null;
        const priorCreatedAt = prior && typeof prior.createdAt === "string" ? prior.createdAt : null;
        const sameOwnerRecord =
          prior
          && prior.ownerToken === fence.ownerToken
          && prior.generation === fence.generation;
        const signal = priorPid != null ? processSignalState(priorPid) : "invalid";
        // Legacy locale-formatted timestamps are ambiguous; only canonical
        // native creation identities can prove PID reuse.
        const identity = sameOwnerRecord && signal === "alive" && creationPoint(priorCreatedAt)
          ? verifyIdentity(priorPid, priorCreatedAt, processSnapshot(priorPid)).verdict : null;
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
          delete entries[key];
          if (entries[conversationId]?.ownerToken === fence.ownerToken) delete entries[conversationId];
          return entries;
        }
        if (
          sameOwnerRecord
          && priorPid != null
          && priorHost != null
          && priorHost !== hostGeneration
          && (signal === "gone" || identity === "mismatch")
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
              ...(priorCreatedAt ? { priorCreatedAt } : {}),
              identityVerdict: identity === "mismatch" ? "mismatch" : "gone",
            },
          });
          delete entries[key];
          if (entries[conversationId]?.ownerToken === fence.ownerToken) delete entries[conversationId];
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
      entries[`${store.instanceId}:${conversationId}`] = {
        instanceId: store.instanceId,
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
      hostGeneration,
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
      delete entries[`${store.instanceId}:${conversationId}`];
      if (entries[conversationId]?.ownerToken === meta.ownerToken) delete entries[conversationId];
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

  function listConversations({ projectId, limit = 50, offset = 0, query = "", includeArchived = false }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    return records.listConversations({
      projectId,
      limit,
      offset,
      includeArchived: includeArchived === true,
      query: typeof query === "string" ? query : "",
    });
  }

  /**
   * Journal a live mailbox approval before any UI decision. Does not grant a
   * response right by itself; the host must keep the live pending map in sync.
   */
  function registerApproval({
    conversationId,
    turnId,
    approvalId,
    nativeRequestId,
    connectionId,
    nativeItemId,
    approvalType,
    decisions,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(turnId, "turnId");
    requireUuid(approvalId, "approvalId");
    return approvals.registerApproval({
      ...scopeOf(meta, evidence),
      turnId,
      operationId: approvalId,
      nativeRequestId,
      connectionId,
      nativeItemId,
      approvalType,
      decisions,
      pendingEvidence,
    });
  }

  function decideApproval({
    conversationId,
    turnId,
    approvalId,
    decision,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return approvals.decideApproval({
      ...scopeOf(meta, evidence),
      turnId,
      operationId: approvalId,
      decision,
      pendingEvidence,
    });
  }

  function beginApprovalDispatch({
    conversationId,
    turnId,
    approvalId,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return approvals.beginApprovalDispatch({
      ...scopeOf(meta, evidence),
      turnId,
      operationId: approvalId,
      pendingEvidence,
    });
  }

  function settleApproval({
    conversationId,
    turnId,
    approvalId,
    outcome,
    request = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    const args = {
      ...scopeOf(meta, evidence),
      turnId,
      operationId: approvalId,
      outcome,
    };
    if (request !== null) args.request = request;
    return approvals.settleApproval(args);
  }

  function getApproval({ projectId, conversationId, approvalId }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    requireUuid(approvalId, "approvalId");
    return approvals.getApproval({ projectId, conversationId, operationId: approvalId });
  }

  function registerClarification({
    conversationId,
    turnId,
    clarificationId,
    route,
    connectionId,
    nativeItemId,
    nativeRequestId = null,
    questions,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return clarifications.registerClarification({
      ...scopeOf(meta, evidence),
      turnId,
      clarificationId,
      route,
      connectionId,
      nativeItemId,
      nativeRequestId,
      questions,
      pendingEvidence,
    });
  }

  function queueClarificationAnswer({
    conversationId,
    turnId,
    clarificationId,
    operationId,
    answers,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return clarifications.queueAnswer({
      ...scopeOf(meta, evidence),
      turnId,
      clarificationId,
      operationId,
      answers,
      pendingEvidence,
    });
  }

  function beginClarificationAnswerDispatch({
    conversationId,
    turnId,
    clarificationId,
    operationId,
    pendingEvidence = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return clarifications.beginAnswerDispatch({
      ...scopeOf(meta, evidence),
      turnId,
      clarificationId,
      operationId,
      pendingEvidence,
    });
  }

  function settleClarificationAnswer({
    conversationId,
    turnId,
    clarificationId,
    operationId,
    outcome,
    request = null,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    const args = {
      ...scopeOf(meta, evidence),
      turnId,
      clarificationId,
      operationId,
      outcome,
    };
    if (request !== null) args.request = request;
    return clarifications.settleAnswer(args);
  }

  function retireClarification({
    conversationId,
    turnId,
    clarificationId,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    return clarifications.retireClarification({
      ...scopeOf(meta, evidence),
      turnId,
      clarificationId,
    });
  }

  /**
   * Read-only export of hydrated transcript + metadata. Native execution
   * permissions are never included.
   *
   * Export pages beyond the UI hydrate window (up to safety ceilings). If a
   * ceiling is hit, truncated is true and truncation names the limiting axis.
   */
  function exportConversation({ projectId, conversationId, messageOffset = 0, expectedEventTip }) {
    if (!Number.isSafeInteger(messageOffset) || messageOffset < 0) throw new Error("Invalid export message offset");
    const hydrated = hydrateConversation({ projectId, conversationId,
      maxEventPages: EXPORT_EVENT_PAGE_CEILING, turnLimit: EXPORT_TURN_CEILING,
      latest: false, includeParts: false, bound: false });
    if (!hydrated) return null;
    if (expectedEventTip !== undefined && expectedEventTip !== hydrated.eventTip) throw new Error("Conversation changed during export; restart the export");
    const totalMessages = hydrated.messages.length;
    if (messageOffset > totalMessages) throw new Error("Export offset exceeds history");
    hydrated.messages = hydrated.messages.slice(messageOffset);
    boundHydratedTranscript(hydrated, false);
    const nextOffset = messageOffset + hydrated.messages.length;
    if (nextOffset === messageOffset && nextOffset < totalMessages) throw new Error("An individual turn exceeds the export page byte ceiling");
    const truncation = { events: Boolean(hydrated.hasMoreEvents), turns: Boolean(hydrated.hasMoreTurns),
      ...(hydrated.hasMoreBytes ? { bytes: true } : {}), ...(hydrated.historyMetadataTruncated ? { metadata: true } : {}) };
    return { format: "cho.session.export.v1", exportedAtMs: Date.now(), projectId, conversation: hydrated,
      truncated: truncation.events || truncation.turns || Boolean(truncation.bytes), truncation,
      pagination: { offset: messageOffset, nextOffset: nextOffset < totalMessages ? nextOffset : null, totalMessages } };
  }

  /**
   * Import a prior export or plain message list as a read-only transcript.
   * Creates a new conversation with NULL native ids and no producer fence.
   * Messages land in an immutable body (not the editable draft or a snapshot).
   */
  function importTranscript({
    projectId,
    source,
    sourceKey,
    title = "",
    controller = "codex",
    messages = [],
  }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    if (typeof source !== "string" || source.length === 0 || source.length > 128) {
      throw new Error("importTranscript requires a bounded source");
    }
    if (typeof sourceKey !== "string" || sourceKey.length === 0 || sourceKey.length > 512) {
      throw new Error("importTranscript requires a bounded sourceKey");
    }
    if (controller !== "codex" && controller !== "claude") {
      throw new Error("importTranscript controller must be codex or claude");
    }
    if (!Array.isArray(messages)) throw new Error("importTranscript requires messages array");
    if (messages.length > EXPORT_TURN_CEILING * 2) {
      throw new Error("importTranscript refuses more than 20000 messages (explicit bound)");
    }
    const existing = store.transaction((tx) =>
      tx.get("SELECT conversation_id AS conversationId FROM imports WHERE source = ? AND source_key = ?", [
        source,
        sourceKey,
      ]),
    );
    if (existing?.conversationId) {
      return {
        created: false,
        conversationId: existing.conversationId,
        importBatchId: null,
      };
    }
    const conversationId = randomUUID();
    const importBatchId = randomUUID();
    const stamp = typeof now === "function" ? now() : Date.now();
    const importedMessages = messages.map((m, index) => {
      const role = m && typeof m.role === "string" ? m.role.slice(0, 32) : "assistant";
      const text = m && typeof m.text === "string" ? m.text : "";
      return {
        id: `import-${importBatchId}-${index}`,
        role: role === "user" ? "user" : "assistant",
        text,
        tools: [],
        isStreaming: false,
        imported: true,
      };
    });
    // Store imported transcript in large_bodies — never in snapshots.
    // Event-store integrity forbids any snapshot row when tip is 0.
    const projection = JSON.stringify({
      v: 1,
      kind: "imported_transcript",
      importBatchId,
      importedMessages,
    });
    const byteLen = Buffer.byteLength(projection, "utf8");
    if (byteLen > 1_048_576) {
      throw new Error("importTranscript refuses payloads over 1MiB UTF-8");
    }
    const sha256Hex = createHash("sha256").update(projection, "utf8").digest("hex");
    // Atomic: conversation + immutable body + import receipt, or nothing.
    store.transaction((tx) => {
      tx.run(
        `INSERT INTO conversations(
           id, project_id, title, controller, model_requested, model_reported, served_verified,
           requested_claude_session_uuid, effort, role, parent_conversation_id,
           created_at_ms, updated_at_ms, archived
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'implement', NULL, ?, ?, 0)`,
        [
          conversationId,
          projectId,
          typeof title === "string" ? title.slice(0, 256) : "",
          controller,
          stamp,
          stamp,
        ],
      );
      tx.run(
        "INSERT INTO large_bodies(id, conversation_id, byte_len, sha256_hex, body_text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [importBatchId, conversationId, byteLen, sha256Hex, projection, stamp],
      );
      tx.run(
        "INSERT INTO imports(source, source_key, conversation_id, import_batch_id, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        [source, sourceKey, conversationId, importBatchId, stamp],
      );
    });
    return { created: true, conversationId, importBatchId };
  }

  /**
   * Page listTurns (API limit 100) up to turnCap. Probes one past the cap so
   * callers can disclose turn truncation even when the last page is full.
   */
  function listTurnSummariesPaged({ projectId, conversationId, turnCap, latest, beforeTurnSeq }) {
    const total = store.transaction((tx) => tx.get(
      "SELECT COUNT(*) AS count FROM turns WHERE conversation_id = ? AND seq < ?", [conversationId, beforeTurnSeq ?? Number.MAX_SAFE_INTEGER],
    )).count;
    const startOffset = latest ? Math.max(0, total - turnCap) : 0;
    /** @type {Array<{ id: string, seq: number }>} */
    const turnSummaries = [];
    for (let offset = startOffset; turnSummaries.length < turnCap; offset += LIST_TURNS_PAGE) {
      const pageLimit = Math.min(LIST_TURNS_PAGE, turnCap - turnSummaries.length, total - offset);
      if (pageLimit <= 0) return { turnSummaries, hasMoreTurns: startOffset > 0 };
      const page = turns.listTurns({ projectId, conversationId, limit: pageLimit, offset });
      turnSummaries.push(...page);
      if (page.length < pageLimit) {
        return { turnSummaries, hasMoreTurns: startOffset > 0 };
      }
    }
    const probe = turns.listTurns({
      projectId,
      conversationId,
      limit: 1,
      offset: startOffset + turnSummaries.length,
    });
    return { turnSummaries, hasMoreTurns: startOffset > 0 || (!latest && probe.length > 0) };
  }

  /**
   * Rebuild a UI-shaped transcript from durable turns + message_delta bodies.
   * Does not restore live approvals/clarifications (still memory-only).
   */
  function hydrateConversation({ projectId, conversationId, maxEventPages = 64, turnLimit = 100, latest = true, includeParts = true, bound = true, beforeTurnSeq, beforeImportedIndex }) {
    assertOpen();
    requireUuid(projectId, "projectId");
    requireUuid(conversationId, "conversationId");
    const conversation = records.getConversation({ projectId, conversationId });
    if (!conversation) return null;

    // Imported transcripts live in large_bodies (keyed by import_batch_id),
    // never in the event-store snapshot table (tip-0 snapshots are illegal).
    // Later native turns append after the import prefix — do not always short-circuit.
    const importRow = store.transaction((tx) =>
      tx.get(
        "SELECT import_batch_id AS importBatchId from imports WHERE conversation_id = ?",
        [conversationId],
      ),
    );
    /** @type {Array<{ id: string, role: string, text: string, tools: unknown[], isStreaming: boolean, imported: boolean }>} */
    const importedMessages = [];
    if (importRow?.importBatchId) {
      const body = store.transaction((tx) =>
        tx.get(
          "SELECT body_text AS bodyText FROM large_bodies WHERE id = ? AND conversation_id = ?",
          [importRow.importBatchId, conversationId],
        ),
      );
      if (body?.bodyText) {
        try {
          const projection = JSON.parse(body.bodyText);
          if (
            projection?.kind === "imported_transcript" &&
            Array.isArray(projection.importedMessages)
          ) {
            for (const [importIndex, item] of projection.importedMessages.entries()) {
              if (beforeImportedIndex !== undefined && importIndex >= beforeImportedIndex) break;
              importedMessages.push({
                id: item.id,
                importIndex,
                role: item.role === "user" ? "user" : "assistant",
                text: typeof item.text === "string" ? item.text : "",
                tools: [],
                isStreaming: false,
                imported: true,
              });
            }
          }
        } catch {
          throw Object.assign(new Error("imported transcript body is unreadable"), {
            code: "ERR_STORAGE",
          });
        }
      }
    }

    const requestedPages = Number.isSafeInteger(maxEventPages) ? maxEventPages : 64;
    const requestedTurns = Number.isSafeInteger(turnLimit) ? turnLimit : 100;
    const pageCap = Math.min(
      EXPORT_EVENT_PAGE_CEILING,
      Math.max(1, requestedPages),
    );
    const turnCap = Math.min(
      EXPORT_TURN_CEILING,
      Math.max(1, requestedTurns),
    );
    const { turnSummaries, hasMoreTurns } = listTurnSummariesPaged({
      projectId,
      conversationId,
      turnCap,
      latest, beforeTurnSeq,
    });

    // Import-only conversations have no event tip/snapshot; return the body.
    if (importedMessages.length > 0 && turnSummaries.length === 0) {
      const native = bindings.getNativeRef({ projectId, conversationId });
      return (bound ? boundHydratedTranscript : (value) => value)({
        conversationId,
        projectId,
        controller: conversation.controller,
        model: conversation.modelRequested,
        role: conversation.role,
        effort: conversation.effort,
        title: conversation.title || "Chat",
        nativeThreadId: native?.nativeThreadId ?? null,
        nativeSessionUuid: native?.nativeSessionUuid ?? null,
        messages: importedMessages,
        eventTip: 0,
        eventCursor: null,
        hasMoreEvents: false,
        hasMoreTurns: false,
        turnsLoaded: 0,
        turnLimit: turnCap,
        historicalClarifications: [],
        historicalApprovals: [],
        imported: true,
        importBatchId: importRow.importBatchId,
      }, latest);
    }

    /** @type {Map<string, Array<{partId: string, text: string, seq: number, order: number}>>} */
    const deltaTexts = new Map();
    /** @type {Map<string, Array<{ id: string, title: string, status: string }>>} */
    const toolsByTurn = new Map();
    /** @type {Map<string, string>} */
    const outcomesByTurn = new Map();
    // Start at the selected recent window, not at the beginning of an arbitrarily
    // long event stream. Export uses an oldest-first window and starts at zero.
    const firstSeq = latest && turnSummaries.length > 0 ? store.transaction((tx) => tx.get(
      `SELECT MIN(e.seq) AS seq FROM events e JOIN turns t
       ON t.conversation_id = e.conversation_id AND t.id = json_extract(e.payload_json, '$.turnId')
       WHERE e.conversation_id = ? AND t.seq >= ?`,
      [conversationId, turnSummaries[0].seq],
    )).seq : null;
    let cursor = firstSeq > 1 ? { instanceId: store.instanceId, conversationId, seq: firstSeq - 1 } : null;
    let tip = 0;
    let hasMoreEvents = false;
    let eventCursor = null;
    for (let pageGuard = 0; pageGuard < pageCap; pageGuard += 1) {
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
          list.push({ partId: event.payload.partId ?? bodyId, text, seq: event.seq, order: list.length });
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

    const messages = [...importedMessages];
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
        turnSeq: turn.seq,
        role: "user",
        text: prompt,
        tools: [],
        isStreaming: false,
      });
      const outcome = outcomesByTurn.get(turn.id) ?? turn.outcome ?? undefined;
      const parts = deltaTexts.get(turn.id) ?? [];
      const assistantText = parts.map((part) => part.text).join("");
      const terminal = outcome === "completed" || outcome === "failed"
        || outcome === "interrupted" || outcome === "unknown";
      messages.push({
        id: turn.id,
        turnSeq: turn.seq,
        role: "assistant",
        text: assistantText,
        ...(includeParts ? { parts } : {}),
        tools: toolsByTurn.get(turn.id) ?? [],
        // Optional DTO fields must be omitted when absent: the strict
        // result-frame encoder rejects `undefined` (e.g. Claude turns carry
        // no Codex-style nativeTurnId; unfinished turns carry no outcome).
        ...(outcome !== undefined ? { outcome } : {}),
        isError: outcome === "failed" || outcome === "unknown",
        isStreaming: !terminal && turn.intentState !== "completed",
        ...(turn.nativeTurnId != null ? { nativeTurnId: turn.nativeTurnId } : {}),
      });
    }

    const native = bindings.getNativeRef({ projectId, conversationId });
    // Historical journals only — never actionable authority to replay decisions.
    const historical = store.transaction((tx) => {
      const clarRows = tx.all(
        `SELECT id, turn_id AS turnId, status, native_question_id AS nativeQuestionId,
                answered_at_ms AS answeredAtMs
         FROM clarifications WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 50`,
        [conversationId],
      ) || [];
      const approvalRows = tx.all(
        `SELECT id, turn_id AS turnId, state, decision, settled_at_ms AS settledAtMs, created_at_ms AS createdAtMs
         FROM operations WHERE conversation_id = ? AND kind = 'approval'
         ORDER BY created_at_ms DESC LIMIT 50`,
        [conversationId],
      ) || [];
      return {
        clarifications: clarRows.map((row) => ({
          ...row,
          actionable: false,
          historical: true,
        })),
        approvals: approvalRows.map((row) => ({
          ...row,
          actionable: false,
          historical: true,
        })),
      };
    });
    return (bound ? boundHydratedTranscript : (value) => value)({
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
      hasMoreTurns,
      turnsLoaded: turnSummaries.length,
      turnLimit: turnCap,
      historicalClarifications: historical.clarifications,
      historicalApprovals: historical.approvals,
      ...(importedMessages.length > 0
        ? { imported: true, importBatchId: importRow.importBatchId }
        : {}),
    }, latest);
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
          ...(typeof nativeMessageId === "string"
            ? harness === "claude" ? { nativeMessageId } : { nativeItemId: nativeMessageId }
            : {}),
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

  function listDraftConflicts({ projectId, conversationId }) {
    assertOpen();
    return records.listDraftConflicts({ projectId, conversationId });
  }

  function resolveDraftConflict(args) {
    assertOpen();
    return records.resolveDraftConflict(args);
  }

  function renameConversation({ projectId, conversationId, title }) {
    assertOpen();
    return records.renameConversation({ projectId, conversationId, title });
  }

  function setConversationArchived({ projectId, conversationId, archived }) {
    assertOpen();
    return records.setConversationArchived({ projectId, conversationId, archived });
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

  function listStrandedTurnRows(conversationId) {
    return store.transaction((tx) =>
      tx.all(
        `SELECT t.id AS turn_id, o.id AS operation_id, o.state AS op_state,
                o.owner_generation AS owner_generation, o.host_generation AS host_generation
         FROM turns t
         JOIN operations o ON o.turn_id = t.id AND o.conversation_id = t.conversation_id
         WHERE t.conversation_id = ?
           AND t.outcome IS NULL
           AND o.kind = 'handoff'
           AND o.state IN ('queued', 'dispatching', 'written', 'observed')
         ORDER BY t.seq ASC
         LIMIT 32`,
        conversationId,
      ),
    );
  }

  /**
   * Explicit S5 recovery for a stranded prior-host turn. Requires a live claim
   * on the conversation. Marks the turn unknown without rewriting the prior
   * operation's hostGeneration (no adoption).
   */
  function acknowledgePriorOwnerTurn({
    conversationId,
    turnId,
    operationId,
    evidence = null,
  }) {
    assertOpen();
    const meta = conversations.get(conversationId);
    if (!meta) throw new Error(`unknown conversation ${conversationId}`);
    requireUuid(turnId, "turnId");
    requireUuid(operationId, "operationId");
    if (!evidence || typeof evidence !== "object") {
      throw new Error("acknowledgePriorOwnerTurn requires owner evidence");
    }
    const stamp = typeof now === "function" ? now() : Date.now();
    const result = store.transaction((tx) => {
      // Current live owner must pass fence + verifyOwnerEvidence inside this
      // writer transaction. Prior-op hostGeneration is preserved (no adoption),
      // but the new writer is still the checked current producer.
      authorizer.authorizeLiveWrite(tx, {
        projectId: meta.projectId,
        conversationId,
        ownerToken: meta.ownerToken,
        ownerGeneration: meta.ownerGeneration,
        hostGeneration,
        evidence,
      });
      const op = tx.get(
        `SELECT id, conversation_id, turn_id, kind, owner_generation, host_generation,
                state, history_json, payload_hash, settled_at_ms
         FROM operations WHERE id = ?`,
        [operationId],
      );
      if (!op || op.conversation_id !== conversationId || op.turn_id !== turnId) {
        throw new Error("stranded operation not found for conversation/turn");
      }
      if (op.kind !== "handoff") {
        throw new Error("acknowledgePriorOwnerTurn applies only to handoff operations");
      }
      if (op.host_generation === hostGeneration && op.owner_generation === meta.ownerGeneration) {
        throw new Error(
          "operation belongs to the current host; use reconcileStrandedTurns instead of prior-owner ack",
        );
      }
      if (!["queued", "dispatching", "written", "observed"].includes(op.state)) {
        throw new Error(`operation state ${op.state} is not stranded`);
      }
      const turn = tx.get(
        "SELECT id, outcome FROM turns WHERE conversation_id = ? AND id = ?",
        [conversationId, turnId],
      );
      if (!turn) throw new Error("stranded turn not found");
      if (turn.outcome != null) {
        return { acknowledged: false, alreadyTerminal: true, outcome: turn.outcome };
      }
      // Receipt/history must satisfy session-turns parse rules (terminal kind only).
      // Prior-host provenance is preserved on the operation row itself.
      const receipt = JSON.stringify({
        v: 1,
        kind: "terminal",
        outcome: "unknown",
        hash: op.payload_hash,
        nativeIdentity: null,
        nativeTurnId: null,
        claudeInputUuid: null,
      });
      let history = [];
      try {
        history = JSON.parse(op.history_json || "[]");
        if (!Array.isArray(history)) history = [];
      } catch {
        history = [];
      }
      if (history.some((entry) => entry && entry.kind === "terminal")) {
        throw new Error("stranded operation already has a terminal history fact");
      }
      history.push({
        kind: "terminal",
        atMs: stamp,
        outcome: "unknown",
        nativeIdentity: null,
        nativeTurnId: null,
        claudeInputUuid: null,
      });
      const movedTurn = tx.run(
        `UPDATE turns SET intent_state = 'unknown', outcome = 'unknown'
         WHERE conversation_id = ? AND id = ? AND outcome IS NULL`,
        [conversationId, turnId],
      );
      if (Number(movedTurn.changes) !== 1) {
        throw new Error("could not mark stranded turn unknown");
      }
      // Keep prior host_generation / owner_generation unchanged — never adopt.
      const movedOp = tx.run(
        `UPDATE operations SET state = 'unknown', history_json = ?, result_json = ?, settled_at_ms = ?
         WHERE id = ? AND state IN ('queued', 'dispatching', 'written', 'observed')`,
        [JSON.stringify(history), receipt, stamp, operationId],
      );
      if (Number(movedOp.changes) !== 1) {
        throw new Error("could not settle stranded prior-owner operation");
      }
      return {
        acknowledged: true,
        conversationId,
        turnId,
        operationId,
        priorHostGeneration: op.host_generation,
        priorOwnerGeneration: op.owner_generation,
      };
    });
    return result;
  }

  /**
   * On reopen, attempt to settle stranded nonterminal turns as unknown under
   * the *current* producer only when provenance still matches. Never adopt or
   * forge the previous host's ownership; surface unresolved rows explicitly.
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
    const unresolved = [];
    for (const conversation of conversationsList) {
      const rows = listStrandedTurnRows(conversation.id);
      for (const row of rows) {
        const meta = conversations.get(conversation.id);
        // Compare against the persistence module's hostGeneration and the
        // live claim's ownerGeneration. Cached meta must carry hostGeneration
        // (set by ensureConversation); fall back to the module constant.
        const liveHostGeneration =
          typeof meta?.hostGeneration === "string" ? meta.hostGeneration : hostGeneration;
        if (
          !meta ||
          meta.ownerGeneration !== row.owner_generation ||
          liveHostGeneration !== row.host_generation
        ) {
          unresolved.push({
            conversationId: conversation.id,
            turnId: row.turn_id,
            operationId: row.operation_id,
            priorOpState: row.op_state,
            priorOwnerGeneration: row.owner_generation,
            priorHostGeneration: row.host_generation,
            reason:
              "ERR_FENCE_CONFLICT: stranded turn belongs to a prior host/producer; explicit recovery required (not auto-adopted)",
          });
          continue;
        }
        try {
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
        } catch (err) {
          unresolved.push({
            conversationId: conversation.id,
            turnId: row.turn_id,
            operationId: row.operation_id,
            priorOpState: row.op_state,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return { settled, unresolved };
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
    listDraftConflicts,
    resolveDraftConflict,
    renameConversation,
    setConversationArchived,
    getSnapshot,
    listConversations,
    hydrateConversation,
    exportConversation,
    importTranscript,
    registerApproval,
    decideApproval,
    beginApprovalDispatch,
    settleApproval,
    getApproval,
    registerClarification,
    queueClarificationAnswer,
    beginClarificationAnswerDispatch,
    settleClarificationAnswer,
    retireClarification,
    acknowledgePriorOwnerTurn,
    reconcileStrandedTurns,
    releaseProducer,
    releaseAllProducers,
    close,
  });
}
