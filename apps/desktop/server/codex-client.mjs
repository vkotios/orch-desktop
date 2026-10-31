// Owned Codex app-server process connection: the bounded dependency slice for a
// first native conversation. Spawns the saved-login Codex CLI as
// `app-server --stdio` and performs the metadata handshake only (initialize,
// account/read, model/list). It starts no threads, turns, or tools; the caller
// supplies explicit thread sandbox and approval policy in a later slice.
//
// Process ownership: the native host owns the full descendant tree through its
// Windows job object. This module signals only the directly owned ChildProcess
// (stdin EOF, then SIGKILL when a bounded wait expires). Killing the parent
// PID is never treated as proof that descendants are gone; whole-tree
// termination belongs to the host job owner, and the fault callback may
// terminate that job.
//
// Env hygiene: the child inherits a filtered copy of process.env. ALL OPENAI_*
// entries, NODE_OPTIONS/NODE_PATH, IGM_CONTROL_KEY/IGM_INFERENCE_KEY,
// CODEX_API_KEY (saved CODEX_HOME login only, no bare key fallback), and common
// provider key/base overrides are stripped case-insensitively. The parent
// environment is never mutated, credentials never enter argv/logs, and no auth
// files are read here.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createNativeRpc, NativeRpcError } from "./native-rpc.mjs";
import { resolveCodexExe } from "../../../orch/src/adapters/codex.mjs";

const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 3_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_MAX_BYTES = 4096;
const STDERR_EXCERPT_MAX_CHARS = 1024;

const CLIENT_INFO = Object.freeze({ name: "cho_desktop", title: "CHO Desktop", version: "0.1.0" });
const SPAWN_ARGS = Object.freeze(["app-server", "--stdio", "-c", "mcp_servers={}", "-c", "analytics.enabled=false"]);

// Exact names stripped case-insensitively, plus the prefix/suffix classes below.
const STRIP_EXACT = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "IGM_CONTROL_KEY",
  "IGM_INFERENCE_KEY",
  "CODEX_API_KEY",
  "OLLAMA_HOST",
]);
const STRIP_SUFFIXES = ["_API_KEY", "_API_SECRET", "_AUTH_TOKEN", "_BASE_URL", "_API_BASE", "_API_ENDPOINT", "_ENDPOINT"];

function shouldStripEnvName(name) {
  const upper = String(name).toUpperCase();
  if (upper.startsWith("OPENAI_")) return true;
  if (STRIP_EXACT.has(upper)) return true;
  return STRIP_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

function buildChildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || shouldStripEnvName(key)) continue;
    env[key] = value;
  }
  return env;
}

function resolveWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    throw new Error("codex client requires a nonempty workspace path");
  }
  if (!path.isAbsolute(workspace)) {
    throw new Error(`codex client workspace must be an absolute path: ${workspace}`);
  }
  let stat = null;
  try {
    stat = fs.statSync(workspace);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`codex client workspace is not an existing directory: ${workspace}`);
  }
  try {
    return fs.realpathSync(workspace);
  } catch {
    throw new Error(`codex client workspace cannot be resolved: ${workspace}`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Accepts a bare array or { models: [...] } / { data: [...] }; keeps valid
// nonempty ids only, defaults a missing name to the id, never invents flags.
function normalizeModels(listed) {
  const raw = Array.isArray(listed)
    ? listed
    : isPlainObject(listed) && Array.isArray(listed.models)
      ? listed.models
      : isPlainObject(listed) && Array.isArray(listed.data)
        ? listed.data
        : [];
  const models = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
    models.push(Object.freeze({ id: entry.id, name, isDefault: entry.isDefault === true }));
  }
  return Object.freeze(models);
}

export async function openCodexClient(options) {
  const opts = options ?? {};
  const workspace = resolveWorkspace(opts.workspace);
  const resolveExe = opts.resolveExe ?? resolveCodexExe;
  const exe = resolveExe();
  if (typeof exe !== "string" || exe.length === 0 || !path.isAbsolute(exe)) {
    throw new Error("codex client requires an absolute native executable path from resolveCodexExe");
  }
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const connectionId = crypto.randomUUID();

  const state = {
    closed: false,
    closing: false,
    fatalDelivered: false,
    sawClose: false,
    exitInfo: null,
    spawnError: null,
    stderrTail: Buffer.alloc(0),
    closePromise: null,
    peer: null,
    models: null,
  };

  const stderrContext = () => {
    if (state.stderrTail.length === 0) return "no codex stderr captured";
    let text = state.stderrTail.toString("utf8");
    if (text.length > STDERR_EXCERPT_MAX_CHARS) text = `...${text.slice(-STDERR_EXCERPT_MAX_CHARS)}`;
    return `codex stderr tail: ${text}`;
  };

  let child;
  try {
    child = spawnImpl(exe, [...SPAWN_ARGS], {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(),
    });
  } catch (err) {
    throw new Error(`codex client failed to spawn ${exe}: ${err?.message ?? err}`);
  }
  if (child === null || child === undefined || !child.stdout || !child.stdin) {
    try {
      child?.kill?.("SIGKILL");
    } catch {
      // Best effort; the missing-stdio error below is what the caller sees.
    }
    throw new Error("codex client spawn did not return piped stdio");
  }

  function deliverFatal(error) {
    if (state.fatalDelivered) return;
    state.fatalDelivered = true;
    if (typeof opts.onFatal === "function") {
      try {
        opts.onFatal(error);
      } catch {
        // The owner callback must not break teardown.
      }
    }
  }

  function failSticky(error) {
    if (state.closed) return;
    state.closed = true;
    if (state.peer !== null) {
      try {
        state.peer.close("codex client fatal");
      } catch {
        // Already torn down by the peer itself.
      }
    }
    deliverFatal(error);
  }

  function onChildError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (state.spawnError === null) state.spawnError = error;
    if (state.closing || state.closed) return;
    failSticky(new Error(`Codex process error: ${error.message}; ${stderrContext()}`));
  }

  function onChildExit(code, signal) {
    state.exitInfo = { code, signal };
    if (state.closing || state.closed) return;
    failSticky(new Error(`Codex process exited unexpectedly (code ${String(code)}, signal ${String(signal)}); ${stderrContext()}`));
  }

  function onChildClose() {
    state.sawClose = true;
    if (state.closing || state.closed) return;
    failSticky(new Error(`Codex stdio closed unexpectedly; ${stderrContext()}`));
  }

  function onPeerFatal(err) {
    if (state.closing || state.closed) return;
    // A stdout fault can leave the child alive: signal the owned process so
    // nothing is orphaned here. Tree cleanup stays with the host job owner.
    if (state.exitInfo === null && !state.sawClose) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort; close observes the outcome.
      }
    }
    failSticky(new Error(`Codex connection failed: ${err?.message ?? err}; ${stderrContext()}`));
  }

  // Guards are registered before any asynchronous error can arrive.
  child.on("error", onChildError);
  child.on("exit", onChildExit);
  child.on("close", onChildClose);
  const onStderr = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    const next = state.stderrTail.length === 0 ? buf : Buffer.concat([state.stderrTail, buf]);
    state.stderrTail = next.length > STDERR_TAIL_MAX_BYTES
      ? Buffer.from(next.subarray(-STDERR_TAIL_MAX_BYTES))
      : next;
  };
  if (child.stderr !== null && child.stderr !== undefined && typeof child.stderr.on === "function") {
    child.stderr.on("data", onStderr);
  }

  async function handshake(peer) {
    const step = async (name, fn) => {
      try {
        return await fn();
      } catch (err) {
        throw new Error(`codex client startup failed at ${name}: ${err?.message ?? err}`);
      }
    };
    await step("initialize", () => peer.request("initialize", { clientInfo: { ...CLIENT_INFO } }));
    await step("initialized", () => peer.notify("initialized"));
    const account = await step("account/read", () => peer.request("account/read", { refreshToken: false }));
    if (!isPlainObject(account) || account.type !== "chatgpt") {
      const seen = isPlainObject(account) && typeof account.type === "string"
        ? ` (reported type ${JSON.stringify(account.type)})`
        : "";
      throw new Error(`Codex saved sign-in is not a ChatGPT subscription${seen}. Sign in with \`codex login\` using ChatGPT and retry; no automatic login was attempted.`);
    }
    const listed = await step("model/list", () => peer.request("model/list", { includeHidden: false, limit: 100 }));
    return normalizeModels(listed);
  }

  // "closed" covers an observed child close; "error" covers a spawn failure;
  // anything else is a timeout. Never leaves timers or listeners behind.
  function waitChildSettled(ms) {
    if (state.sawClose) return Promise.resolve("closed");
    if (state.spawnError !== null) return Promise.resolve("error");
    return new Promise((resolve) => {
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
      };
      const onClose = () => {
        cleanup();
        resolve("closed");
      };
      const onError = () => {
        cleanup();
        resolve("error");
      };
      timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
      child.on("close", onClose);
      child.on("error", onError);
    });
  }

  function detachGuards() {
    child.removeListener("error", onChildError);
    child.removeListener("exit", onChildExit);
    child.removeListener("close", onChildClose);
    if (child.stderr !== null && child.stderr !== undefined && typeof child.stderr.removeListener === "function") {
      child.stderr.removeListener("data", onStderr);
    }
  }

  async function runClose() {
    state.closing = true;
    state.closed = true;
    if (state.peer !== null) {
      try {
        state.peer.close("codex client closed");
      } catch {
        // Already torn down.
      }
    }
    try {
      if (child.stdin !== null && child.stdin !== undefined && typeof child.stdin.end === "function") {
        try {
          child.stdin.end();
        } catch {
          // Reported below when the wait below expires.
        }
      }
      const spawnFailure = () => new Error(
        `codex client close observed a Codex process error: ${state.spawnError?.message ?? state.spawnError}; ${stderrContext()}`,
      );
      let settled = await waitChildSettled(CLOSE_WAIT_MS);
      if (settled === "error") throw spawnFailure();
      if (settled !== "closed") {
        let signalError = null;
        try {
          child.kill("SIGKILL");
        } catch (err) {
          signalError = err;
        }
        settled = await waitChildSettled(KILL_WAIT_MS);
        if (settled === "error" && state.spawnError !== null) throw spawnFailure();
        if (settled !== "closed") {
          const signalNote = signalError === null ? "" : `; SIGKILL failed: ${signalError?.message ?? signalError}`;
          throw new Error(
            `codex client close timed out: owned Codex process (pid ${String(child.pid)}) did not exit within 3s after stdin EOF plus 1s after SIGKILL${signalNote}; ${stderrContext()}`,
          );
        }
      }
    } finally {
      detachGuards();
    }
  }

  function doClose() {
    if (state.closePromise === null) state.closePromise = runClose();
    return state.closePromise;
  }

  let startupTimer = null;
  try {
    const peer = createNativeRpc({
      input: child.stdout,
      output: child.stdin,
      onNotification: opts.onNotification,
      onRequest: opts.onRequest,
      onFatal: onPeerFatal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    state.peer = peer;
    const startupTimedOut = new Promise((_, reject) => {
      startupTimer = setTimeout(() => {
        reject(new Error(`codex client startup timed out after 15s (resolve, spawn, and metadata); ${stderrContext()}`));
      }, STARTUP_TIMEOUT_MS);
      if (typeof startupTimer.unref === "function") startupTimer.unref();
    });
    try {
      state.models = await Promise.race([handshake(peer), startupTimedOut]);
    } finally {
      if (startupTimer !== null) clearTimeout(startupTimer);
    }
  } catch (err) {
    try {
      await doClose();
    } catch (cleanupErr) {
      throw new Error(`${err?.message ?? err} (cleanup also failed: ${cleanupErr?.message ?? cleanupErr})`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  const closedError = () => new NativeRpcError("CLOSED", "codex client is closed");
  const peer = state.peer;
  return {
    request: (method, params) => (state.closed ? Promise.reject(closedError()) : peer.request(method, params)),
    notify: (method, params) => (state.closed ? Promise.reject(closedError()) : peer.notify(method, params)),
    respond: (id, result) => (state.closed ? Promise.reject(closedError()) : peer.respond(id, result)),
    close: () => doClose(),
    get closed() {
      return state.closed;
    },
    get pid() {
      return child.pid;
    },
    get workspace() {
      return workspace;
    },
    get models() {
      return state.models;
    },
    get connectionId() {
      return connectionId;
    },
  };
}
