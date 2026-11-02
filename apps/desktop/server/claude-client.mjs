// Owns one Claude CLI process. Whole-tree termination belongs to the host job.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { resolveClaudeExe } from "../../../orch/src/adapters/claude.mjs";
import { createNativeRpc, NativeRpcError } from "./native-rpc.mjs";
import { claudeWireCodec } from "./claude-wire.mjs";

const STARTUP_MS = 15_000;
const REQUEST_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const bounded = (v, n = 128) => typeof v === "string" && v.length > 0 && v.length <= n;
const asError = (e) => e instanceof Error ? e : new Error(String(e));

function childEnvironment() {
  const result = {};
  const exact = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "NODE_OPTIONS", "NODE_PATH", "IGM_CONTROL_KEY", "IGM_INFERENCE_KEY", "AWS_BEARER_TOKEN_BEDROCK"]);
  const suffixes = ["_API_KEY", "_API_SECRET", "_AUTH_TOKEN", "_BASE_URL", "_API_BASE", "_API_ENDPOINT", "_ENDPOINT"];
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith("ANTHROPIC_") || upper.startsWith("CLAUDE_CODE_USE_") || upper.startsWith("OPENAI_") || exact.has(upper) || suffixes.some((s) => upper.endsWith(s))) continue;
    result[key] = value;
  }
  return result;
}

function workspacePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Claude workspace must be an absolute path");
  let real;
  try { real = fs.realpathSync(value); if (!fs.statSync(real).isDirectory()) throw new Error(); }
  catch { throw new Error("Claude workspace must be an existing directory"); }
  return real;
}

function modelsFrom(result) {
  if (!plain(result) || !plain(result.account) || result.account.apiProvider !== "firstParty" || !Array.isArray(result.models) || result.models.length === 0 || result.models.length > 128) throw new Error("invalid Claude initialize metadata or provider");
  const seen = new Set();
  const models = [];
  for (const model of result.models) {
    if (!plain(model) || !bounded(model.value) || !bounded(model.displayName, 512) || seen.has(model.value)) throw new Error("invalid or duplicate Claude model metadata");
    seen.add(model.value);
    const entry = { id: model.value, name: model.displayName, isDefault: model.value === "default" };
    if (model.resolvedModel !== undefined) {
      if (!bounded(model.resolvedModel)) throw new Error("invalid resolved Claude model");
      entry.resolvedModel = model.resolvedModel;
    }
    if (model.supportedEffortLevels !== undefined) {
      if (!Array.isArray(model.supportedEffortLevels) || model.supportedEffortLevels.length > 5 || model.supportedEffortLevels.some((v) => !EFFORTS.has(v)) || new Set(model.supportedEffortLevels).size !== model.supportedEffortLevels.length) throw new Error("invalid Claude effort metadata");
      entry.supportedEfforts = Object.freeze([...model.supportedEffortLevels]);
    }
    models.push(Object.freeze(entry));
  }
  return Object.freeze(models);
}

export async function openClaudeClient(options) {
  const started = Date.now();
  const opts = options ?? {};
  const workspace = workspacePath(opts.workspace);
  const metadata = opts.metadataOnly === true;
  if (opts.metadataOnly !== undefined && typeof opts.metadataOnly !== "boolean") throw new Error("invalid metadataOnly");
  if (metadata) {
    if (opts.model !== undefined || opts.sessionId !== undefined || opts.resume !== undefined || opts.effort !== undefined || opts.role !== undefined) throw new Error("metadata-only client cannot select a conversation");
  } else {
    if (!bounded(opts.model) || typeof opts.sessionId !== "string" || !UUID.test(opts.sessionId) || !["review", "implement"].includes(opts.role) || (opts.resume !== undefined && typeof opts.resume !== "boolean") || (opts.effort !== undefined && !EFFORTS.has(opts.effort))) throw new Error("invalid Claude conversation options");
  }
  const exe = (opts.resolveExe ?? resolveClaudeExe)();
  if (typeof exe !== "string" || !path.isAbsolute(exe)) throw new Error("Claude executable must resolve to an absolute path");
  const spawn = opts.spawnImpl ?? nodeSpawn;
  const env = childEnvironment();
  const remaining = () => STARTUP_MS - (Date.now() - started);
  const timeout = () => new Error("Claude client startup timed out after 15s");
  const notifyOwner = (e) => { try { opts.onFatal?.(asError(e)); } catch { /* owner callback */ } };
  const spawnOptions = { cwd: workspace, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env };

  // Persistent error guards remain installed even after cleanup.
  function own(args, onFault) {
    const child = spawn(exe, args, spawnOptions);
    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      try { child?.kill?.("SIGKILL"); } catch { /* ownership reported below */ }
      const error = new Error("Claude child did not expose piped stdio; cleanup uncertain");
      notifyOwner(error);
      throw error;
    }
    const owned = { child, closed: false, closing: false, error: null, code: null, closePromise: null };
    const fault = (err) => {
      if (owned.error === null) owned.error = asError(err);
      if (!owned.closing && !owned.closed) onFault(owned.error);
    };
    child.on("error", fault);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", fault);
    child.on("exit", (code, signal) => { if (!owned.closing && !owned.closed) onFault(new Error(`Claude child exited unexpectedly (${String(code)}, ${String(signal)})`)); });
    child.on("close", (code) => { owned.closed = true; owned.code = code; if (!owned.closing) onFault(new Error("Claude child closed unexpectedly")); });
    return owned;
  }
  function waitClose(owned, ms) {
    if (owned.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); owned.child.removeListener("close", done); resolve(true); };
      const timer = setTimeout(() => { owned.child.removeListener("close", done); resolve(false); }, Math.max(0, ms));
      timer.unref?.();
      owned.child.on("close", done);
    });
  }
  function closeOwned(owned, immediate = false) {
    if (owned.closePromise !== null) return owned.closePromise;
    owned.closing = true;
    owned.closePromise = (async () => {
      let signalError = null;
      try { owned.child.stdin.end(); } catch (err) { owned.error ??= asError(err); }
      if (!immediate && !owned.closed) await waitClose(owned, 3_000);
      if (!owned.closed) {
        try { owned.child.kill("SIGKILL"); } catch (err) { signalError = asError(err); }
        await waitClose(owned, 1_000);
      }
      if (!owned.closed || owned.error !== null) {
        const error = new Error(`Claude child cleanup uncertain${signalError ? `: ${signalError.message}` : owned.error ? `: ${owned.error.message}` : ": process did not close"}`);
        notifyOwner(error);
        throw error;
      }
    })();
    return owned.closePromise;
  }

  if (remaining() <= 0) throw timeout();
  let authFault = null;
  const auth = own(["auth", "status", "--json"], (e) => { authFault ??= e; });
  // Normal auth exit is expected; it must close before the main spawn.
  auth.closing = true;
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let authOverflow = false;
  auth.child.stdout.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (stdout.length + bytes.length > 65_536) authOverflow = true;
    else stdout = Buffer.concat([stdout, bytes]);
  });
  auth.child.stderr.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > 4096) authOverflow = true; });
  try { auth.child.stdin.end(); } catch (err) { auth.error ??= asError(err); }
  const authClosed = await waitClose(auth, remaining());
  if (!authClosed) {
    await closeOwned(auth, true);
    throw timeout();
  }
  if (auth.error || authFault || auth.code !== 0 || authOverflow) throw new Error("Claude authentication status failed");
  let status;
  try { status = JSON.parse(stdout.toString("utf8")); } catch { throw new Error("invalid Claude authentication status"); }
  if (!plain(status) || status.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") throw new Error("Claude subscription authentication required");
  if (remaining() <= 0) throw timeout();

  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "manual", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"];
  if (metadata) args.push("--tools", "", "--no-session-persistence");
  else {
    const tools = opts.role === "review" ? ["Read", "Grep", "Glob", "AskUserQuestion"] : ["Read", "Grep", "Glob", "Write", "Edit", "Bash", "AskUserQuestion"];
    args.push("--tools", tools.join(","), "--settings", JSON.stringify({ permissions: { ask: tools } }), "--model", opts.model);
    if (opts.effort !== undefined) args.push("--effort", opts.effort);
    args.push(opts.resume === true ? "--resume" : "--session-id", opts.sessionId);
  }
  let main;
  let peer = null;
  let fatalDelivered = false;
  let closed = false;
  let nativeSessionId = null;
  let closePromise = null;
  function fatal(err) {
    if (closed) return;
    closed = true;
    peer?.close("Claude client fatal");
    if (main && !main.closed) { try { main.child.kill("SIGKILL"); } catch { /* close reports uncertainty */ } }
    if (!fatalDelivered) { fatalDelivered = true; notifyOwner(err); }
  }
  main = own(args, fatal);
  // Drain stderr without retaining credentials or unbounded data.
  main.child.stderr.on("data", () => {});
  const doClose = () => {
    if (closePromise === null) {
      closed = true;
      main.closing = true;
      peer?.close("Claude client closed");
      closePromise = closeOwned(main);
    }
    return closePromise;
  };
  let models;
  let startupTimer;
  try {
    peer = createNativeRpc({ input: main.child.stdout, output: main.child.stdin, codec: claudeWireCodec, timeoutMs: REQUEST_MS,
      onFatal: fatal,
      onNotification: ({ method, params }) => {
        if (method === "claude/control_response_echo") return;
        if (method === "claude/control_cancel_request") {
          const id = params.requestId;
          peer.retire(id);
          opts.onCancel?.(id);
          return;
        }
        if (method !== "claude/event" || !plain(params)) throw new Error("invalid Claude event");
        if (Object.hasOwn(params, "session_id")) {
          if (metadata || params.session_id !== opts.sessionId) throw new Error("unexpected Claude session identity");
          nativeSessionId = params.session_id;
        }
        opts.onEvent?.(params);
      },
      onRequest: ({ id, method, params }) => {
        if (method !== "can_use_tool" || typeof opts.onRequest !== "function" || !plain(params)) throw new Error("unsupported Claude control request");
        opts.onRequest({ id, request: params });
      },
    });
    const left = remaining();
    if (left <= 0) throw timeout();
    const deadline = new Promise((_, reject) => { startupTimer = setTimeout(() => reject(timeout()), left); startupTimer.unref?.(); });
    const result = await Promise.race([peer.request("initialize", { hooks: null, agents: {}, skills: [] }), deadline]);
    models = modelsFrom(result);
    if (result.pid !== undefined && (!Number.isSafeInteger(result.pid) || result.pid !== main.child.pid)) throw new Error("Claude initialize pid does not match owned process");
    if (!metadata) {
      const selected = models.find((m) => m.id === opts.model);
      if (!selected) throw new Error("selected Claude model is absent from the native catalog");
      if (opts.effort !== undefined && !selected.supportedEfforts?.includes(opts.effort)) throw new Error("selected effort is not supported by the native model");
    }
    if (closed || remaining() <= 0) throw timeout();
  } catch (err) {
    try { await doClose(); } catch (cleanup) { throw new Error(`${asError(err).message} (cleanup also failed: ${asError(cleanup).message})`); }
    throw asError(err);
  } finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }

  const closedError = () => new NativeRpcError("CLOSED", "Claude client is closed");
  return {
    models, connectionId: crypto.randomUUID(), pid: main.child.pid,
    requestedSessionId: metadata ? null : opts.sessionId,
    get nativeSessionId() { return nativeSessionId; },
    get closed() { return closed; },
    sendUser({ uuid, prompt }) {
      if (closed) return Promise.reject(closedError());
      if (metadata || typeof uuid !== "string" || !UUID.test(uuid) || typeof prompt !== "string" || prompt.length === 0 || prompt.length > 65_536) return Promise.reject(new NativeRpcError("NOT_SENT", "invalid Claude user message"));
      return peer.notify("claude/user", { type: "user", uuid, session_id: opts.sessionId, parent_tool_use_id: null, client_composed: true, message: { role: "user", content: prompt } });
    },
    async interrupt() { if (closed) throw closedError(); await peer.request("interrupt", {}); },
    respond(id, decision) {
      if (closed) return Promise.reject(closedError());
      const keys = plain(decision) ? Object.keys(decision) : [];
      const allow = decision?.behavior === "allow" && plain(decision.updatedInput) && keys.every((k) => ["behavior", "updatedInput"].includes(k));
      const deny = decision?.behavior === "deny" && typeof decision.message === "string" && (decision.interrupt === undefined || typeof decision.interrupt === "boolean") && keys.every((k) => ["behavior", "message", "interrupt"].includes(k));
      if (!allow && !deny) return Promise.reject(new NativeRpcError("NOT_SENT", "invalid Claude permission decision"));
      return peer.respond(id, decision);
    },
    retire: (id) => closed ? false : peer.retire(id),
    close: doClose,
  };
}
