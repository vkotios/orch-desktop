// One prepared project's Claude conversations; the facade owns trust and mailbox.
import crypto from "node:crypto";
import { openClaudeClient } from "./claude-client.mjs";
import { parseClaudeClarification, encodeClaudeClarificationAnswer } from "./native-clarification.mjs";
import { normalizeClaudeStreamEvent } from "../../../packages/acp-client/src/claude-stream.ts";

const ACTIVATION_MS = 15_000;
const LEASE_MS = 30_000;
const MAX_TOOLS = 64;
const MAX_APPROVALS = 8;
const MAX_CLARIFICATIONS = 4;
const TOOL_INPUT_BYTES = 65_536;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const TOOLS = { review: new Set(["Read", "Grep", "Glob", "AskUserQuestion"]), implement: new Set(["Read", "Grep", "Glob", "Write", "Edit", "Bash", "AskUserQuestion"]) };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const idOk = (v) => typeof v === "string" && v.length > 0 && v.length <= 128;
const errorOf = (v) => v instanceof Error ? v : new Error(String(v));

// Native JSON input is retained privately; canonical order permits structural
// comparison of the independently received assistant and control frames.
function canonical(v, depth = 0) {
  if (depth > 64) throw new Error("Claude tool input exceeds depth bound");
  if (Array.isArray(v)) return v.map((x) => canonical(x, depth + 1));
  if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k], depth + 1)]));
  return v;
}
function snapshot(value) {
  if (!plain(value)) throw new Error("Claude tool input must be an object");
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > TOOL_INPUT_BYTES) throw new Error("Claude tool input exceeds bound");
  const copy = JSON.parse(text);
  return { value: copy, key: JSON.stringify(canonical(copy)) };
}

// The CLI may add only this native default between assistant and control
// frames. The original snapshots remain unchanged for the answer payload.
function questionComparisonKey(input) {
  const value = input.value;
  if (!Array.isArray(value.questions)) return input.key;
  const questions = value.questions.map((q) => plain(q) && !Object.hasOwn(q, "multiSelect") ? { ...q, multiSelect: false } : q);
  return JSON.stringify(canonical({ ...value, questions }));
}

export function createClaudeChatActor(options) {
  const { workspace, generation, models, onEvent, onFatal } = options ?? {};
  if (typeof workspace !== "string" || !idOk(generation) || !Array.isArray(models) || typeof onEvent !== "function" || typeof onFatal !== "function") throw new TypeError("invalid Claude actor options");
  const openClient = options.openClient ?? openClaudeClient;
  const sessions = new Map();
  let active = null;
  let dead = false;
  let closed = false;
  let closePromise = null;
  let fatalDelivered = false;

  function emit(a, event) {
    onEvent({ ...event, generation, controller: "claude", harness: "claude", sessionId: a.sessionId, turnId: a.turnId });
  }
  function clearTimers(a) {
    if (!a) return;
    clearTimeout(a.activationTimer);
    clearTimeout(a.leaseTimer);
    a.activationTimer = null;
    a.leaseTimer = null;
  }
  function retireAll(a) {
    for (const rec of a.approvals.values()) {
      clearTimeout(rec.timer);
      a.session.client?.retire(rec.requestId);
      if (rec.approvalId) emit(a, { kind: "approval_resolved", approvalId: rec.approvalId, ...(a.observed ? identities(a) : {}) });
    }
    a.approvals.clear();
    for (const rec of a.clarifications.values()) {
      clearTimeout(rec.timer);
      a.session.client?.retire(rec.requestId);
      if (rec.clarificationId) emit(a, { kind: "clarification_resolved", clarificationId: rec.clarificationId, ...(a.observed ? identities(a) : {}) });
    }
    a.clarifications.clear();
  }
  function identities(a) { return { nativeSessionId: a.session.nativeId, nativeUserMessageId: a.userId }; }
  function stopClients() {
    for (const session of sessions.values()) {
      if (session.client) { try { Promise.resolve(session.client.close()).catch(() => {}); } catch { /* close reports cleanup */ } }
    }
  }
  function fatal(raw) {
    if (dead || closed) return;
    dead = true;
    const error = errorOf(raw);
    const a = active;
    active = null;
    if (a) {
      clearTimers(a);
      try { retireAll(a); } catch { /* owner notification is mandatory */ }
      try { emit(a, { kind: "error", text: "Claude turn outcome is unknown", nativeOutcome: "unknown", ...(a.observed ? identities(a) : {}) }); } catch { /* owner notification is mandatory */ }
      a.abort(error);
    }
    stopClients();
    if (!fatalDelivered) { fatalDelivered = true; try { onFatal(error); } catch { /* owner callback */ } }
  }
  function guarded(fn) { try { fn(); } catch (err) { fatal(err); } }
  function lease(a) {
    clearTimeout(a.leaseTimer);
    a.leaseTimer = setTimeout(() => { if (active === a) fatal(new Error("Claude consumer lease expired")); }, LEASE_MS);
    a.leaseTimer.unref?.();
  }
  function activationDeadline(a, text) {
    clearTimeout(a.activationTimer);
    a.activationTimer = setTimeout(() => { if (active === a) fatal(new Error(text)); }, ACTIVATION_MS);
    a.activationTimer.unref?.();
  }
  function settle(a) {
    if (active !== a) return;
    active = null;
    clearTimers(a);
    retireAll(a);
  }
  function activate(a) {
    if (a.observed) return;
    a.observed = true;
    if (!a.interruptSent) {
      clearTimeout(a.activationTimer);
      a.activationTimer = null;
    }
    emit(a, { kind: "status", text: "Claude turn started", ...identities(a) });
  }
  function correlated(a, raw) {
    return raw.session_id === a.session.nativeId && raw.parent_tool_use_id == null && raw.user_message_uuid === a.userId && Array.isArray(raw.user_message_uuids) && raw.user_message_uuids.length === 1 && raw.user_message_uuids[0] === a.userId;
  }
  function interrupt(a) {
    if (active !== a || !a.cancelPending || !a.submitted || a.interruptSent) return;
    a.interruptSent = true;
    activationDeadline(a, "Claude turn did not terminate after interruption");
    try { Promise.resolve(a.session.client.interrupt()).catch((err) => { if (active === a) fatal(new Error(`Claude interrupt failed: ${errorOf(err).message}`)); }); }
    catch (err) { fatal(new Error(`Claude interrupt failed: ${errorOf(err).message}`)); }
  }
  function promote(a, rec) {
    const tool = a.tools.get(rec.toolId);
    if (!tool) return;
    if (tool.name !== rec.name || tool.input.key !== rec.input.key) throw new Error("Claude permission request does not match assistant tool use");
    if (tool.requested) throw new Error("duplicate Claude permission request for tool");
    tool.requested = true;
    clearTimeout(rec.timer);
    rec.timer = null;
    rec.approvalId = crypto.randomUUID();
    const detail = JSON.stringify(rec.input.value);
    emit(a, { kind: "approval", approvalId: rec.approvalId, approvalType: "tool", text: `${rec.name}: ${detail}`.slice(0, 4096), decisions: ["accept", "decline", "cancel"], ...identities(a) });
  }
  function promoteQuestion(a, rec) {
    const tool = a.tools.get(rec.toolId);
    if (!tool) return;
    if (tool.name !== rec.name || questionComparisonKey(tool.input) !== questionComparisonKey(rec.input)) throw new Error("Claude permission request does not match assistant tool use");
    if (tool.requested) throw new Error("duplicate Claude permission request for tool");
    tool.requested = true;
    clearTimeout(rec.timer);
    rec.timer = null;
    rec.clarificationId = crypto.randomUUID();
    emit(a, { kind: "clarification", clarificationId: rec.clarificationId, nativeItemId: rec.toolId, isBlocking: true, questions: rec.parsed.questions, ...identities(a) });
  }
  function receiveRequest(session, message) {
    const a = active;
    if (!a || a.session !== session || !plain(message) || !idOk(message.id) || !plain(message.request)) throw new Error("unexpected Claude permission request");
    const req = message.request;
    if (!idOk(req.tool_use_id) || !idOk(req.tool_name) || !TOOLS[session.role].has(req.tool_name)) throw new Error("invalid or disallowed Claude tool request");
    const question = req.tool_name === "AskUserQuestion";
    const previous = a.approvals.get(message.id);
    // The peer permits ID reuse only once the previous response was written.
    if (previous?.responding) a.approvals.delete(message.id);
    const previousQuestion = a.clarifications.get(message.id);
    if (previousQuestion?.responding) a.clarifications.delete(message.id);
    if (a.cancelPending || a.approvals.has(message.id) || a.clarifications.has(message.id) || [...a.approvals.values(), ...a.clarifications.values()].some((r) => r.toolId === req.tool_use_id) || a.approvals.size + a.clarifications.size >= MAX_APPROVALS || (question && a.clarifications.size >= MAX_CLARIFICATIONS)) throw new Error("duplicate or unavailable Claude permission request");
    const rec = { requestId: message.id, toolId: req.tool_use_id, name: req.tool_name, input: snapshot(req.input), parsed: null, approvalId: null, clarificationId: null, responding: false, timer: null };
    // A malformed or unsupported question rejects here so the turn fails
    // visibly instead of stranding a pending native request.
    if (question) {
      rec.parsed = parseClaudeClarification(rec.input.value);
      if (rec.input.value.questions.some((q) => Object.hasOwn(q, "isSecret") && q.isSecret !== false)) throw new Error("Claude secret clarification questions are not supported");
    }
    (question ? a.clarifications : a.approvals).set(message.id, rec);
    rec.timer = setTimeout(() => {
      const current = question ? a.clarifications.get(rec.requestId) : a.approvals.get(rec.requestId);
      if (active === a && current === rec) fatal(new Error("Claude tool request did not correlate with assistant output"));
    }, ACTIVATION_MS);
    rec.timer.unref?.();
    if (question) promoteQuestion(a, rec);
    else promote(a, rec);
  }
  function receiveCancel(session, requestId) {
    const a = active;
    if (!a || a.session !== session) return;
    const rec = a.approvals.get(requestId);
    if (rec) {
      clearTimeout(rec.timer);
      a.approvals.delete(requestId);
      if (rec.approvalId) emit(a, { kind: "approval_resolved", approvalId: rec.approvalId, ...(a.observed ? identities(a) : {}) });
      return;
    }
    const pending = a.clarifications.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    a.clarifications.delete(requestId);
    if (pending.clarificationId) emit(a, { kind: "clarification_resolved", clarificationId: pending.clarificationId, ...(a.observed ? identities(a) : {}) });
  }
  function receiveEvent(session, raw) {
    const a = active;
    if (!a || a.session !== session || !plain(raw)) return;
    const isCorrelated = correlated(a, raw);
    const hasCorrelation = Object.hasOwn(raw, "user_message_uuid") || Object.hasOwn(raw, "user_message_uuids");
    const replay = raw.type === "user" && raw.session_id === session.nativeId && raw.parent_tool_use_id == null && raw.uuid === a.userId && plain(raw.message) && raw.message.role === "user" && (typeof raw.message.content === "string" || Array.isArray(raw.message.content)) && (!hasCorrelation || isCorrelated);
    if (isCorrelated || replay) activate(a);
    if (raw.type === "stream_event") {
      if (!plain(raw.event) || raw.session_id !== session.nativeId || raw.parent_tool_use_id != null) return;
      if (raw.event.type === "message_start") {
        if (a.streamMessageId !== null) throw new Error("overlapping Claude stream starts");
        const continuation = !hasCorrelation && a.observed && a.continuationCredit;
        if ((!isCorrelated && !continuation) || !idOk(raw.event.message?.id)) return;
        a.continuationCredit = false;
        a.streamMessageId = raw.event.message.id;
        a.messageId = a.streamMessageId;
      } else {
        if (a.streamMessageId === null || (hasCorrelation && !isCorrelated)) return;
      }
    }
    const anchoredAssistant = raw.type === "assistant" && !hasCorrelation && a.observed && a.streamMessageId !== null && raw.session_id === session.nativeId && raw.parent_tool_use_id == null && raw.message?.id === a.streamMessageId;
    if (raw.type === "assistant" && (isCorrelated || anchoredAssistant) && plain(raw.message) && idOk(raw.message.id) && Array.isArray(raw.message.content)) {
      a.messageId = raw.message.id;
      for (const block of raw.message.content) {
        if (!plain(block) || block.type !== "tool_use") continue;
        if (!idOk(block.id) || !idOk(block.name) || !TOOLS[session.role].has(block.name) || a.tools.has(block.id) || a.tools.size >= MAX_TOOLS) throw new Error("invalid, duplicate or disallowed Claude assistant tool use");
        a.tools.set(block.id, { name: block.name, input: snapshot(block.input), requested: false, resultSeen: false });
        for (const rec of a.approvals.values()) if (rec.toolId === block.id) promote(a, rec);
        for (const rec of a.clarifications.values()) if (rec.toolId === block.id) promoteQuestion(a, rec);
      }
    }
    const context = { sessionId: session.nativeId, userMessageId: a.userId, messageId: a.messageId, streamMessageId: a.streamMessageId ?? undefined, toolUseIds: new Set(a.tools.keys()) };
    const mapped = normalizeClaudeStreamEvent(a.sessionId, context, raw);
    if (raw.type === "stream_event" && raw.event.type === "message_stop") a.streamMessageId = null;
    if (raw.type === "result" && isCorrelated && mapped.length === 0) throw new Error("malformed Claude terminal outcome");
    for (const event of mapped) {
      if (event.kind === "tool_result") {
        const tool = a.tools.get(event.toolCallId);
        if (!tool || tool.resultSeen) continue;
        tool.resultSeen = true;
        a.continuationCredit = true;
      }
      const mappedEvent = event.kind === "tool_result" ? { ...event, kind: "tool_call", toolTitle: a.tools.get(event.toolCallId)?.name } : event.kind === "error" ? { ...event, text: "Claude turn failed" } : event;
      emit(a, mappedEvent);
      if (["completed", "failed", "interrupted"].includes(event.nativeOutcome)) settle(a);
    }
  }
  function sessionClient(session) {
    if (session.opening) return session.opening;
    const token = {};
    session.token = token;
    const valid = () => !closed && !dead && session.token === token;
    session.opening = Promise.resolve().then(() => {
      if (!valid()) throw new Error("Claude actor is closed");
      return openClient({ workspace, model: session.model, role: session.role, effort: session.effort, sessionId: session.nativeId,
      resume: session.resume === true,
      onEvent: (raw) => { if (valid()) guarded(() => receiveEvent(session, raw)); },
      onRequest: (message) => { if (valid()) guarded(() => receiveRequest(session, message)); },
      onCancel: (id) => { if (valid()) guarded(() => receiveCancel(session, id)); },
      onFatal: (err) => { if (valid()) fatal(err); },
      });
    }).then(async (client) => {
      if (!valid()) {
        try { await client.close(); } catch (err) { session.lateCleanupError = errorOf(err); throw err; }
        throw new Error("Claude actor is closed");
      }
      session.client = client;
      return client;
    });
    return session.opening;
  }
  async function send(args) {
    if (closed || dead) throw new Error("Claude actor is closed");
    if (!plain(args) || !idOk(args.sessionId) || !idOk(args.turnId) || !idOk(args.model) || !Object.hasOwn(TOOLS, args.role) || (args.effort !== undefined && !EFFORTS.has(args.effort)) || typeof args.prompt !== "string" || !args.prompt.length || args.prompt.length > 65_536) throw new Error("invalid Claude send arguments");
    const model = models.find((m) => m.id === args.model);
    if (!model || (args.effort !== undefined && !model.supportedEfforts?.includes(args.effort))) throw new Error("unknown Claude model or unsupported effort");
    // Optional preassigned UUIDs let the host dual-write setRequestedClaudeSession
    // / queueTurn before any CLI launch (CHO-03 persistence contract).
    const requestedSessionId = args.requestedNativeSessionId;
    const requestedUserId = args.requestedNativeUserMessageId;
    if (requestedSessionId !== undefined && !idOk(requestedSessionId)) throw new Error("invalid Claude requestedNativeSessionId");
    if (requestedUserId !== undefined && !idOk(requestedUserId)) throw new Error("invalid Claude requestedNativeUserMessageId");
    let session = sessions.get(args.sessionId);
    if (!session) {
      if (sessions.size >= 8) throw new Error("too many Claude sessions");
      session = {
        nativeId: requestedSessionId ?? crypto.randomUUID(),
        model: args.model, role: args.role, effort: args.effort,
        resume: args.resume === true,
        admitted: new Set(), client: null, opening: null, token: null, lateCleanupError: null,
      };
      sessions.set(args.sessionId, session);
    } else if (requestedSessionId !== undefined && session.nativeId !== requestedSessionId) {
      throw new Error("Claude requestedNativeSessionId does not match the existing session");
    } else if (args.resume === true) {
      session.resume = true;
    }
    if (session.admitted.has(args.turnId)) throw new Error("Claude turn already admitted");
    if (session.admitted.size >= 256) throw new Error("Claude turn history exhausted");
    if (active) throw new Error("another provider turn is already active");
    if (session.model !== args.model || session.role !== args.role || session.effort !== args.effort) throw new Error("Claude session model, role and effort are immutable");
    session.admitted.add(args.turnId);
    let abort;
    const aborted = new Promise((_, reject) => { abort = reject; });
    aborted.catch(() => {});
    const a = {
      session, sessionId: args.sessionId, turnId: args.turnId,
      userId: requestedUserId ?? crypto.randomUUID(),
      observed: false, submitted: false, cancelPending: false, interruptSent: false,
      messageId: undefined, streamMessageId: null, continuationCredit: false,
      tools: new Map(), approvals: new Map(), clarifications: new Map(),
      abort, activationTimer: null, leaseTimer: null,
    };
    active = a;
    activationDeadline(a, "Claude turn did not activate within 15s");
    lease(a);
    let writeAttempted = false;
    try {
      const client = await Promise.race([sessionClient(session), aborted]);
      if (active !== a) throw new Error("Claude turn was closed");
      writeAttempted = true;
      await Promise.race([client.sendUser({ uuid: a.userId, prompt: args.prompt }), aborted]);
      if (closed || dead) throw new Error("Claude actor is closed");
      a.submitted = true;
      interrupt(a);
      return { generation, controller: "claude", sessionId: args.sessionId, turnId: args.turnId, submitted: true, requestedNativeSessionId: session.nativeId, requestedNativeUserMessageId: a.userId };
    } catch (err) {
      if (active === a) {
        if (writeAttempted && err?.code === "NOT_SENT" && !a.observed) { settle(a); emit(a, { kind: "error", text: "Claude message was not sent" }); }
        else fatal(err);
      }
      throw errorOf(err);
    }
  }
  async function cancel(args) {
    if (closed || dead) throw new Error("Claude actor is closed");
    const a = active;
    if (!plain(args) || !a || args.sessionId !== a.sessionId || args.turnId !== a.turnId) throw new Error("no matching active Claude turn");
    try { retireAll(a); } catch (err) { fatal(err); throw err; }
    a.cancelPending = true;
    interrupt(a);
    return { generation, controller: "claude", sessionId: a.sessionId, turnId: a.turnId, cancelling: true };
  }
  async function respond(args) {
    if (closed || dead) throw new Error("Claude actor is closed");
    const a = active;
    if (!plain(args) || !a || args.sessionId !== a.sessionId || args.turnId !== a.turnId || !["accept", "decline", "cancel"].includes(args.decision)) throw new Error("invalid Claude approval response");
    const rec = [...a.approvals.values()].find((r) => r.approvalId === args.approvalId);
    if (!rec || rec.responding) throw new Error("unknown or already-answered approval");
    if (!a.session.client) throw new Error("Claude client is not ready");
    rec.responding = true;
    const decision = args.decision === "accept" ? { behavior: "allow", updatedInput: rec.input.value } : { behavior: "deny", message: "The user declined this tool action.", interrupt: true };
    try { await a.session.client.respond(rec.requestId, decision); }
    catch (err) {
      if (active === a && a.approvals.get(rec.requestId) === rec) fatal(new Error(`Claude approval response failed: ${errorOf(err).message}`));
      throw err;
    }
    finally { if (a.approvals.get(rec.requestId) === rec) a.approvals.delete(rec.requestId); }
    return { generation, controller: "claude", approvalId: rec.approvalId, acknowledged: true };
  }
  async function answer(args) {
    if (closed || dead) throw new Error("Claude actor is closed");
    if (!plain(args) || !idOk(args.sessionId) || !idOk(args.turnId) || !idOk(args.clarificationId)) throw new Error("invalid Claude clarification answer");
    const a = active;
    const receipt = (submitted, extra) => ({ generation, controller: "claude", sessionId: args.sessionId, turnId: args.turnId, clarificationId: args.clarificationId, submitted, ...extra });
    if (!a || args.sessionId !== a.sessionId || args.turnId !== a.turnId || a.cancelPending) return receipt(false, { reason: "stale" });
    const rec = [...a.clarifications.values()].find((r) => r.clarificationId === args.clarificationId);
    if (!rec || rec.responding) return receipt(false, { reason: "stale" });
    let decision;
    try {
      decision = encodeClaudeClarificationAnswer(rec.input.value, rec.parsed, args.answers);
    } catch (err) {
      return receipt(false, { reason: "invalid", message: errorOf(err).message.slice(0, 512) });
    }
    if (!a.session.client) throw new Error("Claude client is not ready");
    rec.responding = true;
    try {
      await a.session.client.respond(rec.requestId, decision);
    } catch (err) {
      const fault = errorOf(err);
      if (fault?.code === "NOT_SENT") {
        if (active === a && a.clarifications.get(rec.requestId) === rec) {
          rec.responding = false;
          return receipt(false, { reason: "not_sent" });
        }
        return receipt(false, { reason: "stale" });
      }
      if (active === a && a.clarifications.get(rec.requestId) === rec) fatal(new Error(`Claude clarification response failed: ${fault.message}`));
      throw err;
    }
    if (a.clarifications.get(rec.requestId) === rec) {
      a.clarifications.delete(rec.requestId);
      emit(a, { kind: "clarification_resolved", clarificationId: rec.clarificationId, ...(a.observed ? identities(a) : {}) });
    }
    return receipt(true, {});
  }
  function touch() { if (active && !dead && !closed) lease(active); }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const a = active;
    active = null;
    if (a) { clearTimers(a); try { retireAll(a); } catch { /* shutdown continues */ } a.abort(new Error("Claude actor is closed")); }
    closePromise = (async () => {
      const results = await Promise.allSettled([...sessions.values()].map(async (session) => {
        session.token = null;
        if (session.opening) { try { await session.opening; } catch { /* late open closes itself */ } }
        if (session.lateCleanupError) throw session.lateCleanupError;
        if (session.client) await session.client.close();
      }));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) { const err = errorOf(failed.reason); if (!fatalDelivered) { fatalDelivered = true; try { onFatal(err); } catch { /* owner callback */ } } throw err; }
    })();
    return closePromise;
  }
  async function forgetSession(id) {
    if (active?.sessionId === id) throw new Error("Cannot evict an active Claude session");
    const session = sessions.get(id);
    if (!session) return;
    session.token = null;
    if (session.opening) await session.opening;
    if (session.lateCleanupError) throw session.lateCleanupError;
    if (session.client) await session.client.close();
    sessions.delete(id);
  }
  return { send, cancel, respond, answer, touch, close, forgetSession };
}
