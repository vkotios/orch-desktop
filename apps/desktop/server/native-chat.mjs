// Native first-conversation chat service (CHO-04).
//
// Owner-authorised backend for one usable native Codex conversation over the
// owned saved-ChatGPT app-server connection. Importing or calling the factory
// starts nothing; only `native_chat_prepare_project` opens the client (via
// injected `openClient` in tests, else `openCodexClient`). Trust is explicit
// and canonical only: one opaque challenge per validation (5min TTL, no
// persistence, no cwd fallback), consumed once by preparation. At most 8 UI
// sessions and one active provider turn app-wide. turn/start carries only the
// current prompt, never history. ACK is not activation: early events stash
// until turn/started binds, terminals before ACK settle without resurrection,
// and a 15s activation deadline faults explicitly.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createEventMailbox } from "./event-mailbox.mjs";
import { openCodexClient } from "./codex-client.mjs";
import { NATIVE_RPC_MAX_PENDING_INBOUND } from "./native-rpc.mjs";
import {
  parseCodexClarification,
  encodeCodexClarificationAnswer,
  parseCodexAsyncClarification,
  encodeCodexAsyncClarificationAnswer,
} from "./native-clarification.mjs";
import { normalizeCodexAppServerEvent } from "../../../packages/acp-client/src/codex-app-server.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ACTIVATION_TIMEOUT_MS = 15_000;
const CONSUMER_LEASE_MS = 30_000;
const MAX_SESSIONS = 8;
const MAX_ADMITTED_TURNS = 256;
const MAX_PENDING_APPROVALS = 8;
const MAX_PENDING_CLARIFICATIONS = 4;
const MAX_SEEN_ASYNC_ITEMS = 64;
const MAX_ID_CHARS = 128;
const MAX_PROMPT_CHARS = 65536;
const MAX_APPROVAL_TEXT = 4096;
const MAX_ERROR_TEXT = 2048;
const MAX_EARLY_STASH = 64;

const ROLES = new Set(["implement", "review"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DECISIONS = new Set(["accept", "decline", "cancel"]);
const MAPPED = new Set(["item/agentMessage/delta", "item/started", "item/completed", "turn/completed"]);
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
const isValidId = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_ID_CHARS;
const messageOf = (e) => (e instanceof Error ? e.message : String(e));
const boundText = (v, n) => { const s = String(v ?? ""); return s.length > n ? s.slice(0, n) : s; };
const isResolvedMethod = (m) => m === "serverRequest/resolved";
const nonEmptyString = (v) => (typeof v === "string" && v.length > 0 ? v : null);

// turn/completed carries the turn as params.turn.id; other events use turnId.
function eventTurnId(method, params) {
  if (method === "turn/completed") return nonEmptyString(isPlainObject(params.turn) ? params.turn.id : null);
  return nonEmptyString(params.turnId);
}
function extractThreadId(r) {
  if (!isPlainObject(r)) return null;
  return nonEmptyString(isPlainObject(r.thread) ? r.thread.id : null) ?? nonEmptyString(r.threadId);
}
function extractTurnId(r) {
  if (!isPlainObject(r)) return null;
  return nonEmptyString(isPlainObject(r.turn) ? r.turn.id : null) ?? nonEmptyString(r.turnId) ?? nonEmptyString(r.id);
}
function approvalText(params, itemId) {
  const parts = [];
  if (params.command !== undefined) parts.push(typeof params.command === "string" ? params.command : JSON.stringify(params.command));
  if (nonEmptyString(params.reason) !== null) parts.push(params.reason);
  if (parts.length === 0) parts.push("Review the requested action before approving or declining.");
  return boundText(parts.join("\n"), MAX_APPROVAL_TEXT);
}

export function createNativeChatService(options) {
  const generation = options?.generation;
  if (typeof generation !== "string" || generation.length === 0) throw new TypeError("createNativeChatService requires a nonempty generation");
  const onFatal = options?.onFatal;
  if (typeof onFatal !== "function") throw new TypeError("createNativeChatService requires an onFatal callback");
  const openClient = options?.openClient ?? ((o) => openCodexClient({
    workspace: o.workspace, onNotification: o.onNotification, onRequest: o.onRequest, onFatal: o.onFatal,
  }));

  const openClaude = options?.openClaudeClient ?? (async (o) => (await import("./claude-client.mjs")).openClaudeClient(o));
  const createClaudeActor = options?.createClaudeActor ?? (async (o) => (await import("./claude-chat-actor.mjs")).createClaudeChatActor(o));

  const mailbox = createEventMailbox();
  const state = {
    closed: false, dead: false, challenge: null, prepared: null, context: null,
    sessions: new Map(), active: null, approvals: new Map(), clarifications: new Map(),
    pendingSteers: new Set(), answerJobs: new Map(),
    // Durable project row for the prepared workspace (Codex dual-write).
    durableProject: null,
  };

  function ownerEvidence() {
    const prepared = state.prepared;
    if (!prepared || prepared.controller !== "codex") return null;
    return { connectionId: prepared.connectionId ?? prepared.client?.connectionId ?? null };
  }
  function verifyPersistenceOwner(facts) {
    // Bindings/turns pass { action, projectId, conversationId, ownerToken,
    // generation, evidence }. Live Codex writes require the prepared
    // connection id to match the evidence supplied by this service.
    if (state.dead || state.closed) return false;
    const prepared = state.prepared;
    if (!prepared || prepared.controller !== "codex") return false;
    const liveId = prepared.connectionId ?? prepared.client?.connectionId ?? null;
    if (liveId === null) return false;
    const evidence = facts !== null && typeof facts === "object" ? facts.evidence : null;
    return evidence !== null && typeof evidence === "object" && evidence.connectionId === liveId;
  }

  // Optional CHO-03 dual-write. Unit tests omit databasePath; the host passes
  // one so Codex turns journal into SQLite while the mailbox stays live.
  let persistence = options?.persistence ?? null;
  const persistenceDatabasePath =
    persistence === null && typeof options?.databasePath === "string" && options.databasePath.length > 0
      ? options.databasePath
      : null;
  if (persistence !== null && (typeof persistence !== "object" || typeof persistence.ensureProject !== "function")) {
    throw new TypeError("createNativeChatService persistence must expose the native session persistence API");
  }
  async function ensurePersistence() {
    if (persistence !== null) return persistence;
    if (persistenceDatabasePath === null) return null;
    const { createNativeSessionPersistence } = await import("./native-session-persistence.mjs");
    persistence = createNativeSessionPersistence({
      databasePath: persistenceDatabasePath,
      hostGeneration: generation,
      verifyOwnerEvidence: verifyPersistenceOwner,
    });
    return persistence;
  }
  function durablePersist(label, fn) {
    if (!persistence) return;
    try { fn(); }
    catch (err) { throw new Error(`durable ${label} failed: ${messageOf(err)}`); }
  }

  function notifyOwner(err) {
    try { onFatal(err); } catch { /* owner callback must not break teardown */ }
  }
  function clearTimer(a) {
    if (a?.timer != null) { clearTimeout(a.timer); a.timer = null; }
  }
  function clearLease(a) {
    if (a?.leaseTimer != null) { clearTimeout(a.leaseTimer); a.leaseTimer = null; }
  }
  function renewLease(a) {
    clearLease(a);
    a.leaseTimer = setTimeout(() => {
      if (state.active === a) fatalize(new Error("native chat consumer lease expired"));
    }, CONSUMER_LEASE_MS);
    a.leaseTimer.unref?.();
  }
  // Whole-service terminal fault: drop the turn and displayable approvals,
  // stop the producer, and always notify the owner even when the queue is full.
  function fatalize(raw) {
    const error = raw instanceof Error ? raw : new Error(String(raw));
    if (state.dead || state.closed) return;
    state.dead = true;
    const a = state.active;
    state.active = null;
    clearTimer(a);
    clearLease(a);
    state.approvals.clear();
    clearClarifications(false);
    try {
      if (state.prepared?.controller === "claude" || state.context?.controller === "claude") throw new Error("actor owns Claude outcomes");
      const event = { kind: "error", text: boundText(`native chat fatal: ${messageOf(error)}`, MAX_ERROR_TEXT), nativeOutcome: "unknown", generation, harness: "codex" };
      if (a !== null) {
        event.sessionId = a.sessionId; event.turnId = a.turnId;
        if (a.nativeThreadId !== null) event.nativeThreadId = a.nativeThreadId;
        if (a.nativeTurnId !== null) event.nativeTurnId = a.nativeTurnId;
      }
      mailbox.push(event);
    } catch { /* a full queue never suppresses the owner notification */ }
    if (state.context) state.context.cancelled = true;
    const client = state.prepared?.actor ?? state.prepared?.client ?? null;
    if (typeof client?.close === "function") {
      try { Promise.resolve(client.close()).catch((err) => notifyOwner(err instanceof Error ? err : new Error(String(err)))); }
      catch (err) { notifyOwner(err instanceof Error ? err : new Error(String(err))); }
    }
    notifyOwner(error);
  }
  function enqueue(event) {
    try { mailbox.push(event); } catch (err) { fatalize(new Error(`native event queue overflow: ${messageOf(err)}`)); throw err; }
  }
  function queueError(a, text) {
    const event = { kind: "error", text: boundText(text, MAX_ERROR_TEXT), generation, harness: "codex", sessionId: a.sessionId, turnId: a.turnId };
    if (a.nativeThreadId !== null) event.nativeThreadId = a.nativeThreadId;
    if (a.nativeTurnId !== null) event.nativeTurnId = a.nativeTurnId;
    enqueue(event);
  }
  function retireInbound(id) {
    try { return state.prepared?.client?.retire?.(id) === true; } catch { return false; }
  }
  function interruptOnce(a) {
    if (a.interruptSent) return;
    a.interruptSent = true;
    clearTimer(a);
    a.timer = setTimeout(() => {
      if (state.active === a) fatalize(new Error("native turn did not terminate within 15s after interrupt"));
    }, ACTIVATION_TIMEOUT_MS);
    a.timer.unref?.();
    sendInterrupt(a);
  }
  function sendInterrupt(a) {
    const client = state.prepared?.client ?? null;
    if (client === null || a.nativeThreadId === null || a.nativeTurnId === null) return;
    let pending;
    try {
      pending = client.request("turn/interrupt", { threadId: a.nativeThreadId, turnId: a.nativeTurnId });
    } catch (err) { if (state.active === a) fatalize(new Error(`interrupt failed: ${messageOf(err)}`)); return; }
    Promise.resolve(pending).then(undefined, (err) => {
      if (state.active === a) fatalize(new Error(`interrupt failed: ${messageOf(err)}`));
    });
  }
  // Invalidate every pending UI approval (single active turn owns them all):
  // retire the native request and queue one approval_resolved each.
  function invalidateApprovals() {
    for (const [, rec] of state.approvals) {
      retireInbound(rec.requestId);
      enqueue({ kind: "approval_resolved", approvalId: rec.approvalId, generation, harness: "codex", sessionId: rec.sessionId, turnId: rec.turnId, nativeThreadId: rec.nativeThreadId, nativeTurnId: rec.nativeTurnId });
    }
    state.approvals.clear();
  }
  function clarificationEvent(rec, kind) {
    return { kind, clarificationId: rec.clarificationId, generation, controller: "codex", harness: "codex",
      sessionId: rec.sessionId, turnId: rec.turnId, nativeThreadId: rec.parsed.nativeThreadId,
      nativeTurnId: rec.parsed.nativeTurnId, nativeItemId: rec.parsed.nativeItemId };
  }
  function clearClarifications(emit = true) {
    for (const rec of state.clarifications.values()) {
      if (rec.requestId !== undefined) retireInbound(rec.requestId);
      if (emit) enqueue(clarificationEvent(rec, "clarification_resolved"));
    }
    state.clarifications.clear();
    for (const pending of state.pendingSteers) pending.controller.abort();
  }
  function releaseReusedRequest(id) {
    for (const [key, rec] of state.approvals) if (rec.responding && rec.requestId === id) state.approvals.delete(key);
    for (const [key, rec] of state.clarifications) {
      if (rec.responding && rec.requestId === id) {
        state.clarifications.delete(key);
        enqueue(clarificationEvent(rec, "clarification_resolved"));
      }
    }
  }
  function registerClarification(a, parsed, requestId) {
    if (state.clarifications.size >= MAX_PENDING_CLARIFICATIONS) throw new Error("too many pending native clarifications");
    const clarificationId = crypto.randomUUID();
    const rec = { clarificationId, parsed, requestId, sessionId: a.sessionId, turnId: a.turnId,
      connectionId: state.prepared.client.connectionId, responding: false };
    state.clarifications.set(clarificationId, rec);
    enqueue({ ...clarificationEvent(rec, "clarification"), isBlocking: parsed.isBlocking, questions: parsed.questions });
  }
  // Only a known not-admitted failure may release the turn locally.
  function failActiveTurn(a, text) {
    if (state.active === a) state.active = null;
    clearTimer(a);
    clearLease(a);
    a.stash.length = 0;
    invalidateApprovals();
    clearClarifications();
    queueError(a, text);
  }
  function settleTerminal(a) {
    a.terminal = true;
    if (state.active === a) state.active = null;
    clearTimer(a);
    clearLease(a);
    a.stash.length = 0;
    invalidateApprovals();
    clearClarifications();
  }
  function durableSettle(a, outcome) {
    if (!persistence || !a.operationId || !a.observed) return;
    durablePersist("settle", () => {
      persistence.settleTurn({
        conversationId: a.sessionId,
        turnId: a.turnId,
        operationId: a.operationId,
        outcome,
        nativeIdentity: a.nativeThreadId,
        nativeTurnId: a.nativeTurnId,
        evidence: ownerEvidence(),
      });
    });
  }
  function deliverMapped(a, mapped) {
    let terminal = false;
    let terminalOutcome = null;
    for (const item of mapped) {
      if (item.kind === "model_verified") continue; // the selected model is never verified here
      if (typeof item.nativeOutcome === "string" && TERMINAL.has(item.nativeOutcome)) {
        terminal = true;
        terminalOutcome = item.nativeOutcome;
      }
      if (item.kind === "message_delta" && persistence && a.operationId && a.observed) {
        const partId = crypto.randomUUID();
        durablePersist("message delta", () => {
          persistence.appendDelta({
            conversationId: a.sessionId,
            turnId: a.turnId,
            operationId: a.operationId,
            partId,
            nativeMessageId: typeof item.nativeItemId === "string" ? item.nativeItemId : partId,
            text: typeof item.text === "string" ? item.text : "",
            evidence: ownerEvidence(),
          });
        });
      }
      enqueue({ ...item, generation, turnId: a.turnId });
    }
    if (terminal) {
      if (terminalOutcome) durableSettle(a, terminalOutcome);
      settleTerminal(a);
    }
  }
  function deliverNotification(a, method, params) {
    const item = params.item;
    if (!a.cancelPending && !a.interruptSent && method === "item/completed" && isPlainObject(item) && item.type === "agentMessage" && item.delivery === "async" && item.questions != null) {
      const parsed = parseCodexAsyncClarification(params);
      if (!a.seenAsyncItems.has(parsed.nativeItemId)) {
        if (a.seenAsyncItems.size >= MAX_SEEN_ASYNC_ITEMS) throw new Error("too many async clarification items");
        a.seenAsyncItems.add(parsed.nativeItemId);
        registerClarification(a, parsed, undefined);
      }
    }
    const mapped = normalizeCodexAppServerEvent(a.sessionId, { threadId: a.nativeThreadId, turnId: a.nativeTurnId }, { method, params });
    if (mapped.length > 0) deliverMapped(a, mapped);
  }
  function flushStash(a) {
    if (a.stash.length === 0 || a.nativeTurnId === null) return;
    for (const raw of a.stash.splice(0, a.stash.length)) {
      if (eventTurnId(raw.method, raw.params) !== a.nativeTurnId) continue;
      deliverNotification(a, raw.method, raw.params);
      if (state.active !== a) return;
    }
  }
  // Provisional bind from turn/started; false means a conflicting turn id.
  function bindActivation(a, nativeTurnId) {
    if (a.ackTurnId !== null && a.ackTurnId !== nativeTurnId) {
      fatalize(new Error("native turn ACK does not match the activated turn"));
      return false;
    }
    if (a.nativeTurnId !== null) return a.nativeTurnId === nativeTurnId;
    a.nativeTurnId = nativeTurnId;
    a.activated = true;
    if (persistence && a.operationId && !a.observed && a.nativeThreadId !== null) {
      durablePersist("observe", () => {
        persistence.afterObserved({
          conversationId: a.sessionId,
          turnId: a.turnId,
          operationId: a.operationId,
          nativeIdentity: a.nativeThreadId,
          nativeTurnId,
          evidence: ownerEvidence(),
        });
      });
      a.observed = true;
    }
    clearTimer(a);
    flushStash(a);
    if (state.active === a && a.cancelPending) interruptOnce(a);
    return true;
  }
  function handleTurnStarted(params) {
    const a = state.active;
    if (a === null || a.nativeThreadId === null || params.threadId !== a.nativeThreadId) return;
    const nativeTurnId = nonEmptyString(isPlainObject(params.turn) ? params.turn.id : null);
    if (nativeTurnId !== null && !bindActivation(a, nativeTurnId)) fatalize(new Error("native turn ACK does not match the activated turn"));
  }
  function handleNotification(message) {
    const method = message?.method;
    if (typeof method !== "string") return;
    const params = message?.params;
    if (isResolvedMethod(method)) { handleResolved(isPlainObject(params) ? params : null); return; }
    if (!isPlainObject(params)) return;
    if (method === "turn/started") { handleTurnStarted(params); return; }
    if (!MAPPED.has(method)) return;
    const a = state.active;
    if (a === null || a.nativeThreadId === null || params.threadId !== a.nativeThreadId) return;
    const turnId = eventTurnId(method, params);
    if (turnId === null) return;
    if (a.nativeTurnId === null) {
      if (a.stash.length >= MAX_EARLY_STASH) { fatalize(new Error("native turn overflowed the pre-activation event buffer")); return; }
      a.stash.push({ method, params }); // early but valid; replayed at bind, never lost
      if (method === "turn/completed" && turnId === a.ackTurnId) {
        a.nativeTurnId = turnId;
        flushStash(a);
      }
      return;
    }
    if (turnId !== a.nativeTurnId) return; // old turn on a reused thread is not rebound
    deliverNotification(a, method, params);
  }
  function handleResolved(params) {
    if (params == null) return;
    for (const [key, rec] of state.clarifications) {
      if (rec.requestId !== undefined && rec.requestId === params.requestId) {
        if (params.threadId !== undefined && params.threadId !== rec.parsed.nativeThreadId) { fatalize(new Error("clarification resolution has wrong thread")); return; }
        state.clarifications.delete(key);
        retireInbound(rec.requestId);
        enqueue(clarificationEvent(rec, "clarification_resolved"));
        return;
      }
    }
    for (const [approvalId, rec] of state.approvals) {
      if (rec.requestId === params.requestId) { // === keeps numeric 0 distinct from "0"
        state.approvals.delete(approvalId);
        retireInbound(params.requestId);
        enqueue({ kind: "approval_resolved", approvalId: rec.approvalId, generation, harness: "codex", sessionId: rec.sessionId, turnId: rec.turnId, nativeThreadId: rec.nativeThreadId, nativeTurnId: rec.nativeTurnId });
        return;
      }
    }
  }
  function handleApprovalRequest(id, method, params) {
    const a = state.active;
    const shaped = isPlainObject(params) && nonEmptyString(params.threadId) !== null && nonEmptyString(params.turnId) !== null && nonEmptyString(params.itemId) !== null;
    if (!shaped || a === null || !a.activated || params.threadId !== a.nativeThreadId || params.turnId !== a.nativeTurnId) {
      retireInbound(id);
      fatalize(new Error("invalid, foreign, or pre-activation native approval request"));
      return;
    }
    const hasChoices = Object.hasOwn(params, "availableDecisions");
    const decisions = !hasChoices ? ["accept", "decline", "cancel"] :
      Array.isArray(params.availableDecisions) ? [...new Set(params.availableDecisions.filter((d) => DECISIONS.has(d)))] : [];
    if (decisions.length === 0) {
      retireInbound(id);
      fatalize(new Error("native approval request offered no supported decisions"));
      return;
    }
    // The peer admits reuse only after the earlier response was handed to
    // the transport. Its promise continuation may not have run yet.
    releaseReusedRequest(id);
    if (state.approvals.size >= MAX_PENDING_APPROVALS || state.approvals.size + [...state.clarifications.values()].filter((rec) => rec.requestId !== undefined).length >= NATIVE_RPC_MAX_PENDING_INBOUND) {
      retireInbound(id);
      fatalize(new Error("too many pending native approvals"));
      return;
    }
    const approvalId = crypto.randomUUID();
    state.approvals.set(approvalId, { approvalId, sessionId: a.sessionId, turnId: a.turnId, nativeThreadId: params.threadId, nativeTurnId: params.turnId, nativeItemId: params.itemId, requestId: id, connectionId: state.prepared.client.connectionId, decisions, responding: false });
    enqueue({ kind: "approval", approvalId, approvalType: method === "item/fileChange/requestApproval" ? "file" : "command", text: approvalText(params, params.itemId), decisions, nativeItemId: params.itemId, generation, harness: "codex", sessionId: a.sessionId, turnId: a.turnId, nativeThreadId: params.threadId, nativeTurnId: params.turnId });
  }
  function handleUnsupportedRequest(id, method) {
    retireInbound(id);
    const a = state.active;
    if (a === null) {
      fatalize(new Error(`unsupported native request with no active turn: ${method}`));
      return;
    }
    queueError(a, `unsupported native request: ${method}`);
    invalidateApprovals();
    clearClarifications();
    if (a.activated) interruptOnce(a);
    else a.cancelPending = true;
  }
  function handleRequest(message) {
    const id = message?.id;
    const method = message?.method;
    if (typeof method !== "string") { retireInbound(id); fatalize(new Error("malformed native request")); return; }
    if (method === "item/tool/requestUserInput") {
      const a = state.active;
      try {
        const parsed = parseCodexClarification(message?.params);
        if (!a || !a.activated || a.cancelPending || a.interruptSent || parsed.nativeThreadId !== a.nativeThreadId || parsed.nativeTurnId !== a.nativeTurnId) throw new Error("foreign or inactive clarification");
        releaseReusedRequest(id);
        if (state.approvals.size + [...state.clarifications.values()].filter((rec) => rec.requestId !== undefined).length >= NATIVE_RPC_MAX_PENDING_INBOUND) throw new Error("too many pending native requests");
        registerClarification(a, parsed, id);
      } catch (err) { retireInbound(id); fatalize(new Error(`invalid native clarification: ${messageOf(err)}`)); }
      return;
    }
    if (APPROVALS.has(method)) { handleApprovalRequest(id, method, message?.params); return; }
    handleUnsupportedRequest(id, method);
  }

  function requireLive() {
    if (state.closed || state.dead) throw new Error("native chat service is closed");
  }
  function requireGeneration(args) {
    if (!isPlainObject(args) || args.generation !== generation) throw new Error(`stale generation ${String(args?.generation)}`);
  }
  function requireToken(args) {
    if (state.prepared === null) throw new Error("no prepared project; validate and prepare a project first");
    if (!isPlainObject(args) || args.projectToken !== state.prepared.projectToken) throw new Error("unknown project token");
  }
  function canonicalize(dir) {
    let stat = null;
    try { stat = fs.statSync(dir); } catch { stat = null; }
    if (stat === null || !stat.isDirectory()) throw new Error(`project path is not an existing directory: ${dir}`);
    try { return fs.realpathSync(dir); } catch { throw new Error(`project path cannot be resolved: ${dir}`); }
  }

  function cmdValidateProject(args) {
    requireLive();
    if (!isPlainObject(args) || typeof args.path !== "string" || args.path.length === 0) throw new Error("native_chat_validate_project requires a path string");
    if (!path.isAbsolute(args.path)) throw new Error(`project path must be absolute: ${args.path}`);
    const controller = args.controller ?? "codex";
    if (controller !== "codex" && controller !== "claude") throw new Error("unknown native controller");
    const canonical = canonicalize(args.path);
    const projectToken = crypto.randomUUID();
    state.challenge = { controller, projectToken, path: canonical, name: path.basename(canonical) || canonical, expiresAt: Date.now() + CHALLENGE_TTL_MS };
    return { generation, controller, path: canonical, name: state.challenge.name, projectToken };
  }

  async function cmdPrepareProject(args) {
    requireLive();
    if (!isPlainObject(args) || typeof args.projectToken !== "string" || args.projectToken.length === 0) throw new Error("native_chat_prepare_project requires a projectToken");
    if (args.trusted !== true) throw new Error("native_chat_prepare_project requires explicit trusted:true");
    const pending = state.challenge;
    if (pending === null || pending.projectToken !== args.projectToken) throw new Error("stale or unknown project challenge; validate the project first");
    if (args.controller !== undefined && args.controller !== pending.controller) throw new Error("controller does not match project challenge");
    if (Date.now() > pending.expiresAt) { state.challenge = null; throw new Error("project challenge expired; validate the project again"); }
    if (state.prepared !== null || state.context !== null || state.closing) throw new Error("a project is already prepared or preparing; close it before preparing another");
    state.challenge = null;
    const canonical = canonicalize(pending.path);
    if (canonical !== pending.path) throw new Error("project path changed since validation; validate the project again");
    let finish;
    const context = { controller: pending.controller, cancelled: false, cleanupError: null, done: new Promise((resolve) => { finish = resolve; }) };
    state.context = context;
    const current = () => state.context === context && !context.cancelled && !state.closed && !state.dead;
    let owned = null;
    try {
      if (pending.controller === "claude") {
        owned = await openClaude({ workspace: canonical, metadataOnly: true, onFatal: (err) => { if (current()) fatalize(err); } });
        if (!current()) throw new Error("preparing project was closed or superseded");
        const models = (Array.isArray(owned.models) ? owned.models : []).map((m) => ({ ...m, ...(m.supportedEfforts ? { supportedEfforts: [...m.supportedEfforts] } : {}) }));
        // A prepared project is never exposed while its metadata process is live.
        const metadata = owned;
        owned = null;
        try { await closeClient(metadata); }
        catch (err) { context.cleanupError = err; state.dead = true; throw err; }
        if (!current()) throw new Error("preparing project was closed or superseded");
        owned = await createClaudeActor({ workspace: canonical, generation, models,
          onEvent: (event) => { if (current()) { try { enqueue(event); } catch { /* enqueue fatalizes */ } } },
          onFatal: (err) => { if (current()) fatalize(err); },
          ...(options?.openClaudeClient ? { openClient: options.openClaudeClient } : {}),
        });
        if (!current()) throw new Error("preparing project was closed or superseded");
        state.prepared = { controller: "claude", projectToken: pending.projectToken, path: canonical, name: pending.name, models, actor: owned };
      } else {
        owned = await openClient({
          workspace: canonical,
          onNotification: (m) => { if (current()) { try { handleNotification(m); } catch (err) { fatalize(err); } } },
          onRequest: (m) => { if (current()) { try { handleRequest(m); } catch (err) { fatalize(err); } } },
          onFatal: (err) => { if (current()) fatalize(err); },
        });
        if (!current()) throw new Error("preparing project was closed or superseded");
        const models = (Array.isArray(owned.models) ? owned.models : [])
          .filter((m) => isPlainObject(m) && typeof m.id === "string" && m.id.length > 0)
          .map((m) => Object.freeze({ id: m.id, name: nonEmptyString(m.name) ?? m.id, isDefault: m.isDefault === true }));
        state.prepared = { controller: "codex", projectToken: pending.projectToken, path: canonical, name: pending.name, models: Object.freeze(models), client: owned, connectionId: owned.connectionId };
        const durable = await ensurePersistence();
        if (durable) {
          state.durableProject = durable.ensureProject({ pathCanonical: canonical, name: pending.name });
        }
      }
      owned = null; // transferred to prepared project
      const models = state.prepared.models.map((m) => ({ ...m, ...(m.supportedEfforts ? { supportedEfforts: [...m.supportedEfforts] } : {}) }));
      return { generation, controller: pending.controller, projectToken: pending.projectToken, path: canonical, name: pending.name, models };
    } catch (err) {
      if (owned !== null) {
        try { await closeClient(owned); } catch (cleanupErr) { context.cleanupError = cleanupErr; state.dead = true; throw cleanupErr; }
      }
      if (!current() && state.context === context && !context.cancelled) context.cancelled = true;
      throw new Error(`preparing project failed: ${messageOf(err)}`);
    } finally {
      if (state.context === context && state.prepared === null && !context.cancelled) state.context = null;
      finish();
    }
  }

  async function cmdSend(args) {
    requireLive();
    requireGeneration(args);
    requireToken(args);
    if (state.prepared.controller === "claude") return state.prepared.actor.send(args);
    if (!isValidId(args.sessionId)) throw new Error("direct_chat_send requires a bounded nonempty sessionId");
    if (!isValidId(args.turnId)) throw new Error("direct_chat_send requires a bounded nonempty turnId");
    if (typeof args.prompt !== "string" || args.prompt.length === 0 || args.prompt.length > MAX_PROMPT_CHARS) throw new Error("direct_chat_send requires a nonempty prompt of at most 65536 chars");
    if (!ROLES.has(args.role)) throw new Error("direct_chat_send role must be implement or review");
    if (!EFFORTS.has(args.effort)) throw new Error("direct_chat_send effort must be low, medium, high, or xhigh");
    const prepared = state.prepared;
    if (!prepared.models.some((m) => m.id === args.model)) throw new Error(`unknown model ${String(args.model)} for the prepared project`);
    let session = state.sessions.get(args.sessionId);
    if (session === undefined) {
      if (state.sessions.size >= MAX_SESSIONS) throw new Error("too many chat sessions (max 8); start a new chat after closing");
      session = { sessionId: args.sessionId, role: null, model: null, nativeThreadId: null, admitted: new Set() };
      state.sessions.set(args.sessionId, session);
    }
    if (session.admitted.has(args.turnId)) throw new Error(`turnId was already admitted for session ${args.sessionId}`);
    if (session.admitted.size >= MAX_ADMITTED_TURNS) throw new Error("turn history exhausted (max 256); start a new chat");
    if (state.active !== null || state.pendingSteers.size) throw new Error("another provider turn is already active or its answer is settling");
    if (session.nativeThreadId !== null && (session.role !== args.role || session.model !== args.model)) {
      throw new Error("session role/model are immutable after the native thread was created; start a new chat");
    }
    session.admitted.add(args.turnId);
    const client = prepared.client;
    const a = {
      sessionId: args.sessionId, turnId: args.turnId, nativeThreadId: session.nativeThreadId,
      nativeTurnId: null, ackTurnId: null, activated: false, terminal: false, cancelPending: false,
      interruptSent: false, timer: null, stash: [], seenAsyncItems: new Set(),
      operationId: null, observed: false, written: false,
    };
    state.active = a; // pending before any provider request so early events bind here
    renewLease(a);
    const timer = setTimeout(() => {
      if (state.active === a) fatalize(new Error("native turn did not activate within 15s"));
    }, ACTIVATION_TIMEOUT_MS);
    try { timer.unref?.(); } catch { /* timer fakes may lack unref */ }
    a.timer = timer;
    let turnRequested = false;
    try {
      const durable = await ensurePersistence();
      if (durable && state.durableProject) {
        // UI session/turn ids are already UUIDs; use them as store conversation/turn ids.
        durable.ensureConversation({
          projectId: state.durableProject.id,
          conversationId: args.sessionId,
          controller: "codex",
          modelRequested: args.model,
          effort: args.effort,
          role: args.role,
          evidence: ownerEvidence(),
        });
        a.operationId = crypto.randomUUID();
        durable.beginTurn({
          conversationId: args.sessionId,
          turnId: args.turnId,
          operationId: a.operationId,
          prompt: args.prompt,
          effort: args.effort,
          evidence: ownerEvidence(),
        });
      }
      if (session.nativeThreadId === null) {
        const threadResult = await client.request("thread/start", { model: args.model, modelProvider: "openai", cwd: prepared.path, sandbox: args.role === "review" ? "read-only" : "workspace-write", approvalPolicy: "untrusted", config: { mcp_servers: {} } });
        const threadId = extractThreadId(threadResult);
        if (threadId === null) throw new Error("native thread/start did not return result.thread.id");
        session.nativeThreadId = threadId; session.role = args.role; session.model = args.model;
        a.nativeThreadId = threadId;
        if (durable && a.operationId) {
          durablePersist("bind native thread", () => {
            durable.afterThreadStart({
              conversationId: args.sessionId,
              nativeThreadId: threadId,
              evidence: ownerEvidence(),
            });
          });
        }
      }
      if (state.active !== a) throw new Error("native chat service is closed");
      turnRequested = true;
      const turnResult = await client.request("turn/start", { threadId: a.nativeThreadId, input: [{ type: "text", text: args.prompt }], effort: args.effort });
      if (state.prepared !== prepared) throw new Error("native chat service is closed or turn was superseded");
      if (state.active !== a && !a.terminal) throw new Error("native chat service is closed or turn was superseded");
      const ackTurnId = extractTurnId(turnResult);
      if (ackTurnId === null) {
        const error = new Error("native turn/start did not acknowledge turn.id");
        if (a.terminal) fatalize(error);
        throw error;
      }
      if (a.nativeTurnId !== null && a.nativeTurnId !== ackTurnId) {
        const error = new Error("native turn ACK does not match the activated turn");
        fatalize(error);
        throw error;
      }
      if (state.dead || state.closed) throw new Error("native chat service is closed");
      a.ackTurnId = ackTurnId;
      if (durable && a.operationId && !a.written) {
        durablePersist("record written", () => {
          durable.afterTurnWritten({
            conversationId: args.sessionId,
            turnId: args.turnId,
            operationId: a.operationId,
            evidence: ownerEvidence(),
          });
        });
        a.written = true;
      }
      if (state.active === a && a.nativeTurnId === null) {
        const earlyTerminal = a.stash.find((raw) => raw.method === "turn/completed");
        if (earlyTerminal && eventTurnId(earlyTerminal.method, earlyTerminal.params) !== ackTurnId) {
          const error = new Error("native turn ACK does not match the terminal turn");
          fatalize(error);
          throw error;
        }
        if (earlyTerminal) {
          a.nativeTurnId = ackTurnId;
          if (durable && a.operationId && !a.observed) {
            durablePersist("early observe", () => {
              durable.afterObserved({
                conversationId: args.sessionId,
                turnId: args.turnId,
                operationId: a.operationId,
                nativeIdentity: a.nativeThreadId,
                nativeTurnId: ackTurnId,
                evidence: ownerEvidence(),
              });
            });
            a.observed = true;
          }
          flushStash(a);
        }
      }
      return { generation, sessionId: args.sessionId, turnId: args.turnId, nativeThreadId: a.nativeThreadId, nativeTurnId: a.nativeTurnId ?? ackTurnId };
    } catch (err) {
      if (state.active === a) {
        if (!turnRequested || err?.code === "REMOTE_ERROR" || err?.code === "NOT_SENT") failActiveTurn(a, `chat send failed: ${messageOf(err)}`);
        else fatalize(new Error(`chat send failed: ${messageOf(err)}`));
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  function cmdPoll(args) {
    requireLive();
    requireGeneration(args);
    requireToken(args);
    if (state.prepared.controller === "claude") state.prepared.actor.touch();
    else if (state.active !== null) renewLease(state.active);
    return { generation, events: mailbox.drain() };
  }

  async function cmdRespond(args) {
    requireLive();
    requireGeneration(args);
    requireToken(args);
    if (state.prepared.controller === "claude") return state.prepared.actor.respond(args);
    if (!isValidId(args.sessionId)) throw new Error("native_chat_respond requires a bounded nonempty sessionId");
    if (!isValidId(args.turnId)) throw new Error("native_chat_respond requires a bounded nonempty turnId");
    if (typeof args.approvalId !== "string" || args.approvalId.length === 0) throw new Error("native_chat_respond requires an approvalId");
    if (!DECISIONS.has(args.decision)) throw new Error("native_chat_respond decision must be accept, decline, or cancel");
    const rec = state.approvals.get(args.approvalId);
    if (rec === undefined || rec.responding) throw new Error("unknown or already-answered approval");
    if (rec.sessionId !== args.sessionId || rec.turnId !== args.turnId) throw new Error("approval does not belong to this session turn");
    if (rec.connectionId !== state.prepared.client.connectionId) throw new Error("approval belongs to a closed connection");
    if (!rec.decisions.includes(args.decision)) throw new Error(`decision ${args.decision} was not offered for this approval`);
    rec.responding = true; // consume once, but retain identity for retirement while queued
    try {
      await state.prepared.client.respond(rec.requestId, { decision: args.decision });
    } finally {
      if (state.approvals.get(args.approvalId) === rec) state.approvals.delete(args.approvalId);
    }
    return { generation, approvalId: args.approvalId, acknowledged: true };
  }

  async function cmdAnswer(args) {
    requireLive(); requireGeneration(args); requireToken(args);
    if (state.prepared.controller === "claude") return state.prepared.actor.answer(args);
    const receipt = (submitted, reason, message) => ({ generation, controller: "codex", sessionId: args.sessionId,
      turnId: args.turnId, clarificationId: args.clarificationId, submitted,
      ...(reason ? { reason } : {}), ...(message ? { message: boundText(message, 256) } : {}) });
    const a = state.active;
    const rec = state.clarifications.get(args.clarificationId);
    if (!a || !rec || rec.responding || a.cancelPending || a.interruptSent ||
        rec.sessionId !== args.sessionId || rec.turnId !== args.turnId ||
        a.sessionId !== args.sessionId || a.turnId !== args.turnId ||
        rec.connectionId !== state.prepared.client.connectionId) return receipt(false, "stale");
    let encoded;
    try {
      encoded = rec.requestId === undefined ? encodeCodexAsyncClarificationAnswer(rec.parsed, args.answers)
        : encodeCodexClarificationAnswer(rec.parsed, args.answers);
    } catch (err) { return receipt(false, "invalid", messageOf(err)); }
    const client = state.prepared.client;
    rec.responding = true;
    let pending;
    try {
      if (rec.requestId === undefined) {
        const controller = new AbortController();
        pending = { controller };
        state.pendingSteers.add(pending);
        const expectedTurnId = rec.parsed.nativeTurnId;
        const response = await client.request("turn/steer", { threadId: rec.parsed.nativeThreadId, expectedTurnId,
          input: [{ type: "text", text: encoded }] }, { signal: controller.signal });
        if (!isPlainObject(response) || response.turnId !== expectedTurnId) throw new Error("native steer ACK did not match the expected turn");
      } else {
        await client.respond(rec.requestId, encoded);
      }
      if (state.clarifications.get(rec.clarificationId) === rec) {
        state.clarifications.delete(rec.clarificationId);
        enqueue(clarificationEvent(rec, "clarification_resolved"));
      }
      return receipt(true);
    } catch (err) {
      const current = state.clarifications.get(rec.clarificationId) === rec && state.active === a && !state.dead && !state.closed;
      if (err?.code === "NOT_SENT") {
        if (current) rec.responding = false;
        return receipt(false, current ? "not_sent" : "stale");
      }
      fatalize(new Error("native clarification response failed; outcome unknown"));
      throw new Error("native clarification response failed; outcome unknown");
    } finally {
      if (pending) state.pendingSteers.delete(pending);
    }
  }

  function cmdQueueAnswer(args) {
    requireLive(); requireGeneration(args); requireToken(args);
    const prepared = state.prepared;
    const controller = prepared.controller;
    if (!isValidId(args.sessionId) || !isValidId(args.turnId) || !isValidId(args.clarificationId)) throw new Error("invalid clarification answer identity");
    const admission = (queued, reason) => ({ generation, controller, sessionId: args.sessionId, turnId: args.turnId,
      clarificationId: args.clarificationId, queued, ...(reason ? { reason } : {}) });
    const key = JSON.stringify([prepared.projectToken, args.sessionId, args.turnId, args.clarificationId]);
    if (state.answerJobs.has(key) || state.answerJobs.size >= MAX_PENDING_CLARIFICATIONS) return admission(false, "stale");
    let rec;
    if (controller === "codex") {
      const a = state.active;
      rec = state.clarifications.get(args.clarificationId);
      if (!a || !rec || rec.responding || a.cancelPending || a.interruptSent || a.sessionId !== args.sessionId ||
          a.turnId !== args.turnId || rec.sessionId !== args.sessionId || rec.turnId !== args.turnId ||
          rec.connectionId !== prepared.client.connectionId) return admission(false, "stale");
    }
    const context = state.context;
    const job = {};
    state.answerJobs.set(key, job);
    Promise.resolve().then(() => cmdAnswer(args)).then((result) => {
      if (state.prepared !== prepared || state.context !== context || state.closed || state.dead) return;
      const identity = rec ? { nativeThreadId: rec.parsed.nativeThreadId, nativeTurnId: rec.parsed.nativeTurnId } : {};
      enqueue({ kind: "clarification_answered", generation, controller, harness: controller,
        sessionId: args.sessionId, turnId: args.turnId, clarificationId: args.clarificationId,
        submitted: result.submitted === true, ...(result.reason ? { reason: result.reason } : {}),
        ...(result.message ? { message: boundText(result.message, 256) } : {}), ...identity });
    }).catch(() => {
      if (state.prepared === prepared && state.context === context && !state.closed && !state.dead) fatalize(new Error("native clarification answer outcome unknown"));
    }).finally(() => {
      if (state.answerJobs.get(key) === job) state.answerJobs.delete(key);
    });
    return admission(true);
  }

  function cmdCancel(args) {
    requireLive();
    requireGeneration(args);
    requireToken(args);
    if (state.prepared.controller === "claude") return state.prepared.actor.cancel(args);
    if (!isValidId(args.sessionId)) throw new Error("direct_chat_cancel requires a bounded nonempty sessionId");
    if (!isValidId(args.turnId)) throw new Error("direct_chat_cancel requires a bounded nonempty turnId");
    const a = state.active;
    if (a === null || a.sessionId !== args.sessionId || a.turnId !== args.turnId) throw new Error("no matching active turn to cancel");
    invalidateApprovals();
    clearClarifications();
    if (a.activated) interruptOnce(a);
    else a.cancelPending = true; // ACK is not activation: interrupt once the real turn binds
    return { generation, sessionId: args.sessionId, turnId: args.turnId, cancelling: true };
  }

  async function closeClient(client) {
    if (client === null) return;
    try { await client.close(); } catch (err) { const error = err instanceof Error ? err : new Error(String(err)); notifyOwner(error); throw error; }
  }

  function resetProject() {
    if (state.closing) return state.closing;
    const context = state.context;
    if (context) context.cancelled = true;
    if (state.active !== null) { const a = state.active; state.active = null; clearTimer(a); clearLease(a); }
    clearClarifications(false);
    state.approvals.clear();
    state.sessions.clear();
    state.challenge = null;
    const owned = state.prepared?.actor ?? state.prepared?.client ?? null;
    state.prepared = null;
    const closing = (async () => {
      try {
        if (context) await context.done;
        if (context?.cleanupError) throw context.cleanupError;
        try { await closeClient(owned); } catch (err) { state.dead = true; throw err; }
        while (mailbox.size) mailbox.drain();
      } finally {
        if (state.context === context) state.context = null;
        state.closing = null;
      }
    })();
    state.closing = closing;
    return closing;
  }

  async function cmdClose(args) {
    requireLive();
    requireGeneration(args);
    if (state.prepared !== null && (!isPlainObject(args) || args.projectToken !== state.prepared.projectToken)) throw new Error("unknown project token");
    await resetProject();
    return { generation, closed: true };
  }

  async function handle(command, args) {
    switch (command) {
      case "native_chat_validate_project": return cmdValidateProject(args);
      case "native_chat_prepare_project": return cmdPrepareProject(args);
      case "direct_chat_send": return cmdSend(args);
      case "native_chat_poll": return cmdPoll(args);
      case "native_chat_respond": return cmdRespond(args);
      case "native_chat_answer": return cmdQueueAnswer(args);
      case "direct_chat_cancel": return cmdCancel(args);
      case "native_chat_close": return cmdClose(args);
      default: throw new Error(`unknown command ${String(command)}`);
    }
  }

  async function close() {
    if (state.closed) { if (state.closing) await state.closing; return; }
    state.closed = true;
    await resetProject();
    if (persistence && typeof persistence.close === "function") {
      try { persistence.close(); } catch { /* store close is best-effort on shutdown */ }
      persistence = null;
    }
  }

  return { handle, close };
}
