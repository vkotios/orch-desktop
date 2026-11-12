// CHO native conversation/restart acceptance probe (CHO-COMPLETE/20261112).
//
// Owned, opt-in live probe that drives the REAL product host
// (apps/desktop/server/host.mjs -> native-chat.mjs) through the real v1
// NDJSON protocol. It never launches a coding worker CLI itself: provider
// processes are started only by the real app host after explicit UI
// ownership (validate/trust/prepare).
//
// Default invocation REFUSES provider execution (zero provider starts).
// Live execution requires every opt-in flag:
//   node apps/desktop/scripts/native-acceptance.mjs --allow-live \
//     --controller codex --model <exact-catalogue-id> --output <fresh-receipt-path>
//
// Intended live flow (all against an isolated temporary fixture, never the
// user's default database, saved projects, or unrelated native sessions):
//   1. validate/trust/prepare the fixture project via the real host
//   2. reject a requested model absent from the returned catalogue (no fallback)
//   3. first benign no-tools marker turn -> poll to terminal -> save draft
//   4. stop/close host; reopen with the SAME database and a FRESH generation
//   5. list/hydrate the same conversation and draft; continue the native
//      session WITHOUT supplying the marker again
//   6. verify native identity preserved and the replay contains the marker
//      text exactly once in the continuation reply
// Close owned resources in finally. Record failure/uncertainty honestly and
// never mark pass when the model ignores the scenario.
//
// Deterministic tests inject a fixture host seam (openHost) instead of the
// real host. Seam tests cover orchestration only and do NOT prove live
// acceptance.
//
// Builtin Node only. No dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

const execFileAsync = promisify(execFile);

export const ACCEPTANCE_VERSION = 1;
export const ACCEPTANCE_TOOL = "native-acceptance";
export const DEFAULT_OP_TIMEOUT_MS = 120_000;
export const MIN_OP_TIMEOUT_MS = 5_000;
export const MAX_OP_TIMEOUT_MS = 600_000;
export const POLL_INTERVAL_MS = 500;
export const CONTROLLERS = ["codex", "claude"];
// Terminal provider outcomes (mirrors native-chat.mjs TERMINAL). Kept local
// so this probe never imports provider internals beyond the host boundary.
const TERMINAL_OUTCOMES = new Set(["completed", "failed", "interrupted", "unknown"]);
// Commands this probe will never send: no ownership/fence clearing and no
// proof-weakening recovery shortcuts.
const FORBIDDEN_COMMANDS = new Set([
  "native_chat_acknowledge_stranded",
  "native_chat_resolve_draft_conflict",
  "orch_claim",
  "orch_release",
]);

export class AcceptanceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AcceptanceError";
    this.code = code;
    this.details = details ?? null;
  }
}

function fail(code, message, details) {
  throw new AcceptanceError(code, message, details);
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// CLI argument parsing (no side effects; safe to unit test).
// ---------------------------------------------------------------------------
export function parseAcceptanceArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const parsed = {
    allowLive: false,
    controller: null,
    model: null,
    output: null,
    deadlineMs: DEFAULT_OP_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--allow-live") {
      parsed.allowLive = true;
    } else if (token === "--help" || token === "-h") {
      parsed.help = true;
    } else if (token === "--controller") {
      parsed.controller = args[index + 1] ?? null;
      index += 1;
    } else if (token.startsWith("--controller=")) {
      parsed.controller = token.slice("--controller=".length);
    } else if (token === "--model") {
      parsed.model = args[index + 1] ?? null;
      index += 1;
    } else if (token.startsWith("--model=")) {
      parsed.model = token.slice("--model=".length);
    } else if (token === "--output") {
      parsed.output = args[index + 1] ?? null;
      index += 1;
    } else if (token.startsWith("--output=")) {
      parsed.output = token.slice("--output=".length);
    } else if (token === "--deadline-ms") {
      parsed.deadlineMs = Number(args[index + 1]);
      index += 1;
    } else if (token.startsWith("--deadline-ms=")) {
      parsed.deadlineMs = Number(token.slice("--deadline-ms=".length));
    } else {
      fail("USAGE", `unknown argument: ${token}`);
    }
  }
  if (parsed.help) return parsed;
  if (!parsed.allowLive) return parsed;
  if (!CONTROLLERS.includes(parsed.controller)) {
    fail("USAGE", "--controller must be one of: codex, claude (required with --allow-live)");
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0 || parsed.model.length > 256) {
    fail("USAGE", "--model <exact-catalogue-id> is required with --allow-live");
  }
  if (typeof parsed.output !== "string" || parsed.output.length === 0) {
    fail("USAGE", "--output <fresh-receipt-path> is required with --allow-live");
  }
  if (!Number.isFinite(parsed.deadlineMs) ||
      parsed.deadlineMs < MIN_OP_TIMEOUT_MS || parsed.deadlineMs > MAX_OP_TIMEOUT_MS) {
    fail(
      "USAGE",
      `--deadline-ms must be between ${MIN_OP_TIMEOUT_MS} and ${MAX_OP_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export function usageText() {
  return [
    `${ACCEPTANCE_TOOL} v${ACCEPTANCE_VERSION} — owned native conversation/restart acceptance probe.`,
    "",
    "Refusal default: without --allow-live this tool starts no providers and runs no probes.",
    "",
    "Live (explicit opt-in only):",
    "  node apps/desktop/scripts/native-acceptance.mjs --allow-live \\",
    "    --controller codex|claude --model <exact-catalogue-id> \\",
    "    --output <fresh-private-receipt-path> [--deadline-ms 120000]",
    "",
    "Limits: isolated temp Git project + SQLite only; never the default app",
    "database, saved projects, or unrelated sessions. No auto-overwrite of the",
    "receipt. Does not sign, install, publish, or release anything.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Bounded helpers.
// ---------------------------------------------------------------------------
export function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) fail("USAGE", "deadline must be a positive number");
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AcceptanceError("TIMEOUT", `${label} exceeded ${ms}ms`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), gate]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export function countOccurrences(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ---------------------------------------------------------------------------
// Owned fixture: isolated temporary Git project + SQLite + liveness state.
// Never touches the user's default app database, saved projects, or
// unrelated native sessions. The caller owns cleanup (also in finally).
// ---------------------------------------------------------------------------
export function defaultDatabasePath() {
  return path.join(os.homedir(), ".cho-desktop", "sessions.sqlite3");
}

export async function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-native-acceptance-"));
  const fixture = {
    root,
    projectDir: path.join(root, "project"),
    databasePath: path.join(root, "sessions.sqlite3"),
    conversationId: crypto.randomUUID(),
    marker: `CHO-ACCEPTANCE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    gitInit: false,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  fixture.livenessPath = `${fixture.databasePath}.liveness.json`;
  try {
    fs.mkdirSync(fixture.projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.projectDir, "README.md"),
      "# isolated native acceptance fixture (do not reuse)\n",
    );
    if (options.git === false) return fixture;
    await execFileAsync("git", ["init", "--quiet", fixture.projectDir]);
    fixture.gitInit = true;
  } catch (err) {
    fixture.cleanup();
    fail("IO", `fixture git init failed: ${err?.message ?? err}`, { root });
  }
  if (fixture.databasePath === defaultDatabasePath()) {
    fixture.cleanup();
    fail("STATE", "fixture database resolved to the default app database; refusing");
  }
  return fixture;
}

export function assertFreshOutput(outputPath) {
  if (typeof outputPath !== "string" || outputPath.length === 0) fail("USAGE", "output path is required");
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) {
    fail("OUTPUT_EXISTS", `refusing to overwrite existing receipt: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Real host seam: drives the REAL product host over piped v1 NDJSON frames.
// Only the host starts native clients. Returns { request, close }.
// ---------------------------------------------------------------------------
export async function openRealHost({ generation, databasePath, deadlineMs = DEFAULT_OP_TIMEOUT_MS }) {
  if (!isUuid(generation)) fail("USAGE", "openRealHost requires a UUID generation");
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    fail("USAGE", "openRealHost requires an explicit databasePath");
  }
  if (databasePath === defaultDatabasePath()) {
    fail("REFUSAL", "refusing to open the default app database");
  }
  const { runHost } = await import("../server/host.mjs");
  const { encodeFrame } = await import("../server/protocol.mjs");
  const input = new PassThrough();
  const output = new PassThrough();
  const errorChunks = [];
  const errorStream = new PassThrough();
  errorStream.on("data", (chunk) => errorChunks.push(chunk));
  const done = runHost({ input, output, error: errorStream, generation, databasePath });
  done.catch(() => {});
  let seq = 0;
  const pending = new Map();
  let buffer = "";
  let hostEnded = false;
  done.then(() => {
    hostEnded = true;
    for (const [, entry] of pending) entry.reject(new AcceptanceError("STATE", "host ended before responding"));
    pending.clear();
  });
  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      let frame = null;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = frame && typeof frame.requestId === "string" ? pending.get(frame.requestId) : null;
      if (!entry) continue;
      pending.delete(frame.requestId);
      entry.resolve(frame);
    }
  });

  async function request(command, args = {}) {
    if (FORBIDDEN_COMMANDS.has(command)) {
      fail("REFUSAL", `probe must never send ${command}`);
    }
    if (hostEnded) fail("STATE", "host already ended");
    seq += 1;
    const requestId = `r${seq}`;
    const payload = Promise.resolve().then(() => new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      let frame;
      try {
        frame = encodeFrame({ v: 1, type: "request", generation, requestId, command, args });
      } catch (err) {
        pending.delete(requestId);
        reject(new AcceptanceError("PROTOCOL", `cannot encode ${command}: ${err?.message ?? err}`));
        return;
      }
      try {
        input.write(frame);
      } catch (err) {
        pending.delete(requestId);
        reject(new AcceptanceError("IO", `host input write failed: ${err?.message ?? err}`));
      }
    }));
    const frame = await withTimeout(payload, deadlineMs, `host request ${command}`);
    if (frame?.type === "error") {
      const info = frame.error && typeof frame.error === "object" ? frame.error : {};
      throw new AcceptanceError("COMMAND", `${command} failed: ${info.message ?? "unknown error"}`, {
        command,
        code: info.code ?? null,
      });
    }
    if (frame?.type !== "result") {
      throw new AcceptanceError("PROTOCOL", `${command} returned unexpected frame type ${String(frame?.type)}`);
    }
    return frame.result ?? {};
  }

  async function close() {
    try {
      await withTimeout(
        (async () => {
          try {
            await request("shutdown", {});
          } catch {
            // Best effort: EOF still stops the host.
          }
          try {
            input.end();
          } catch {
            // Already ended.
          }
          await done;
        })(),
        Math.min(deadlineMs, 15_000),
        "host shutdown",
      );
      return { closedCleanly: true };
    } catch (err) {
      try {
        input.destroy();
      } catch {
        // Best effort.
      }
      return { closedCleanly: false, detail: err?.message ?? String(err) };
    }
  }

  return { request, close, diagnostics: () => Buffer.concat(errorChunks).toString("utf8") };
}

// ---------------------------------------------------------------------------
// Core orchestration over an injected host seam ({ request, close }).
// openHost: async ({ generation, databasePath }) => { request, close }.
// Returns a receipt object (never secrets or raw credentials).
// ---------------------------------------------------------------------------
function record(cases, name, status, detail) {
  cases.push({ name, status, detail: detail ?? null });
}

function catalogueIds(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string")
    .map((entry) => entry.id);
}

function nativeIdentityOf(hydrated) {
  if (!hydrated || typeof hydrated !== "object") return null;
  const conversation = hydrated.conversation ?? hydrated;
  if (!conversation || typeof conversation !== "object") return null;
  if (typeof conversation.nativeThreadId === "string" && conversation.nativeThreadId.length > 0) {
    return { kind: "thread", value: conversation.nativeThreadId };
  }
  if (typeof conversation.nativeSessionUuid === "string" && conversation.nativeSessionUuid.length > 0) {
    return { kind: "session", value: conversation.nativeSessionUuid };
  }
  return null;
}

function isTerminalFor(event, turnId) {
  if (!event || typeof event !== "object") return false;
  if (event.turnId !== turnId) return false;
  if (event.kind === "error") return true;
  return typeof event.nativeOutcome === "string" && TERMINAL_OUTCOMES.has(event.nativeOutcome);
}

function isApprovalBlocker(event, turnId) {
  if (!event || typeof event !== "object") return false;
  if (typeof event.turnId === "string" && event.turnId !== turnId) return false;
  return typeof event.kind === "string" && event.kind.includes("approval");
}

async function prepareProject(request, { generation, projectDir, controller }) {
  const validated = await request("native_chat_validate_project", { path: projectDir, controller });
  if (typeof validated?.projectToken !== "string" || validated.projectToken.length === 0) {
    fail("PROTOCOL", "validate did not return a projectToken");
  }
  const prepared = await request("native_chat_prepare_project", {
    projectToken: validated.projectToken,
    trusted: true,
    controller,
  });
  return { validated, prepared, projectToken: validated.projectToken };
}

function requireCatalogueModel(prepared, model) {
  const ids = catalogueIds(prepared?.models);
  if (!ids.includes(model)) {
    fail("MODEL_ABSENT", `requested model ${model} is absent from the prepared project catalogue; refusing without fallback`, {
      catalogue: ids,
    });
  }
  return ids;
}

async function sendTurn(request, { generation, projectToken, controller, conversationId, turnId, prompt, model }) {
  const base = { generation, projectToken, sessionId: conversationId, turnId, prompt, model };
  if (controller === "claude") {
    return request("direct_chat_send", base);
  }
  return request("direct_chat_send", { ...base, role: "implement", effort: "low" });
}

async function pollTurnTerminal(request, { generation, projectToken, conversationId, turnId, deadlineMs }) {
  const startedAt = Date.now();
  const texts = [];
  const seenEvents = [];
  let terminal = null;
  for (;;) {
    if (Date.now() - startedAt > deadlineMs) {
      fail("TIMEOUT", `turn ${turnId} did not reach a terminal event within ${deadlineMs}ms`, {
        polledMs: Date.now() - startedAt,
        textChars: texts.join("").length,
      });
    }
    const polled = await request("native_chat_poll", { generation, projectToken, conversationId });
    const events = Array.isArray(polled?.events) ? polled.events : [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (typeof event.turnId === "string" && event.turnId !== turnId) continue;
      seenEvents.push(typeof event.kind === "string" ? event.kind : "unknown");
      if (typeof event.text === "string" && event.text.length > 0) texts.push(event.text);
      if (isApprovalBlocker(event, turnId)) {
        return { terminal: null, text: texts.join(""), blocked: event.kind, eventKinds: seenEvents };
      }
      if (isTerminalFor(event, turnId)) terminal = event;
    }
    if (terminal !== null) return { terminal, text: texts.join(""), blocked: null, eventKinds: seenEvents };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function runAcceptanceProbe({ openHost, controller, model, fixture, deadlineMs = DEFAULT_OP_TIMEOUT_MS }) {
  if (typeof openHost !== "function") fail("USAGE", "runAcceptanceProbe requires an openHost seam");
  if (!CONTROLLERS.includes(controller)) fail("USAGE", "controller must be codex or claude");
  if (typeof model !== "string" || model.length === 0) fail("USAGE", "model is required");
  if (!fixture || typeof fixture.projectDir !== "string" || typeof fixture.databasePath !== "string") {
    fail("USAGE", "fixture with projectDir and databasePath is required");
  }
  const startedAt = new Date().toISOString();
  const cases = [];
  const context = {
    tool: ACCEPTANCE_TOOL,
    version: ACCEPTANCE_VERSION,
    startedAt,
    controller,
    model,
    node: process.version,
    platform: process.platform,
    markerLength: typeof fixture.marker === "string" ? fixture.marker.length : 0,
  };
  const failReceipt = (reason, extra = {}) => ({
    ...context,
    finishedAt: new Date().toISOString(),
    result: "fail",
    reason,
    cases,
    ...extra,
  });

  const marker = fixture.marker;
  const conversationId = fixture.conversationId;
  const draftText = `acceptance draft for ${conversationId}`;
  let first = null;
  let second = null;
  try {
    // ---- Generation 1: validate/trust/prepare, catalogue gate, marker turn, draft.
    const generation1 = crypto.randomUUID();
    first = await openHost({ generation: generation1, databasePath: fixture.databasePath });
    const opened = await prepareProject(first.request, {
      generation: generation1,
      projectDir: fixture.projectDir,
      controller,
    });
    let catalogue;
    try {
      catalogue = requireCatalogueModel(opened.prepared, model);
    } catch (err) {
      if (err instanceof AcceptanceError && err.code === "MODEL_ABSENT") {
        record(cases, "catalogue-contains-model", "fail", { catalogue: err.details?.catalogue ?? [] });
        return failReceipt("MODEL_ABSENT", { catalogue: err.details?.catalogue ?? [] });
      }
      throw err;
    }
    record(cases, "catalogue-contains-model", "pass", { catalogueSize: catalogue.length });
    const token1 = opened.projectToken;
    record(cases, "validate-trust-prepare", "pass", { controller });
    const turn1 = crypto.randomUUID();
    const markerPrompt = `Reply with exactly this marker on a single line and nothing else: ${marker}\nDo not call any tools, do not run commands, do not ask questions.`;
    const ack1 = await sendTurn(first.request, {
      generation: generation1,
      projectToken: token1,
      controller,
      conversationId,
      turnId: turn1,
      prompt: markerPrompt,
      model,
    });
    const ackIdentity1 = typeof ack1?.nativeThreadId === "string"
      ? { kind: "thread", value: ack1.nativeThreadId }
      : null;
    const settled1 = await pollTurnTerminal(first.request, {
      generation: generation1,
      projectToken: token1,
      conversationId,
      turnId: turn1,
      deadlineMs,
    });
    if (settled1.blocked !== null) {
      record(cases, "first-turn-no-tools", "fail", { blocked: settled1.blocked });
      return failReceipt("APPROVAL_BLOCKED", { eventKinds: settled1.eventKinds });
    }
    const markerCount1 = countOccurrences(settled1.text, marker);
    if (settled1.terminal?.nativeOutcome !== "completed") {
      record(cases, "first-turn-no-tools", "fail", {
        outcome: settled1.terminal?.nativeOutcome ?? settled1.terminal?.kind ?? "unknown",
        markerCount: markerCount1,
      });
      return failReceipt("FIRST_TURN_NOT_COMPLETED");
    }
    if (markerCount1 < 1) {
      record(cases, "first-turn-marker", "fail", { markerCount: markerCount1 });
      return failReceipt("MARKER_NOT_ECHOED");
    }
    record(cases, "first-turn-no-tools", "pass", { outcome: "completed", markerCount: markerCount1 });
    const saveId = crypto.randomUUID();
    const saved = await first.request("native_chat_save_draft", {
      generation: generation1,
      projectToken: token1,
      conversationId,
      saveId,
      expectedVersion: 0,
      text: draftText,
    });
    if (saved?.saved !== true && saved?.receipt === undefined) {
      record(cases, "save-draft", "fail", {});
      return failReceipt("DRAFT_NOT_SAVED");
    }
    record(cases, "save-draft", "pass", {});
    const hydrate1 = await first.request("native_chat_hydrate_conversation", {
      generation: generation1,
      projectToken: token1,
      conversationId,
    });
    const identity1 = nativeIdentityOf(hydrate1) ?? ackIdentity1;
    if (identity1 === null) {
      record(cases, "hydrate-before-restart", "fail", {});
      return failReceipt("NO_NATIVE_IDENTITY");
    }
    record(cases, "hydrate-before-restart", "pass", { nativeIdentityKind: identity1.kind });
    const closed1 = await first.close();
    first = null;
    if (closed1?.closedCleanly !== true) {
      record(cases, "close-before-restart", "fail", { detail: closed1?.detail ?? null });
      return failReceipt("CLOSE_UNCLEAN", { closeDetail: closed1?.detail ?? null });
    }
    record(cases, "close-before-restart", "pass", {});

    // ---- Generation 2: reopen SAME database with a FRESH generation.
    const generation2 = crypto.randomUUID();
    second = await openHost({ generation: generation2, databasePath: fixture.databasePath });
    const reopened = await prepareProject(second.request, {
      generation: generation2,
      projectDir: fixture.projectDir,
      controller,
    });
    const catalogue2 = requireCatalogueModel(reopened.prepared, model);
    void catalogue2;
    record(cases, "reopen-prepare", "pass", { controller });
    const token2 = reopened.projectToken;
    const listed = await second.request("native_chat_list_conversations", {
      generation: generation2,
      projectToken: token2,
    });
    const found = Array.isArray(listed?.conversations)
      ? listed.conversations.some((entry) => entry && entry.id === conversationId)
      : false;
    if (!found) {
      record(cases, "list-after-restart", "fail", {});
      return failReceipt("CONVERSATION_MISSING_AFTER_RESTART");
    }
    record(cases, "list-after-restart", "pass", {});
    const hydrate2 = await second.request("native_chat_hydrate_conversation", {
      generation: generation2,
      projectToken: token2,
      conversationId,
    });
    const identity2 = nativeIdentityOf(hydrate2);
    if (identity2 === null || identity2.kind !== identity1.kind || identity2.value !== identity1.value) {
      record(cases, "identity-preserved", "fail", {
        before: identity1,
        after: identity2,
      });
      return failReceipt("IDENTITY_CHANGED");
    }
    record(cases, "identity-preserved", "pass", { nativeIdentityKind: identity2.kind });
    const draft = await second.request("native_chat_get_draft", {
      generation: generation2,
      projectToken: token2,
      conversationId,
    });
    if (draft?.draft?.text !== draftText) {
      record(cases, "draft-preserved", "fail", {});
      return failReceipt("DRAFT_MISMATCH");
    }
    record(cases, "draft-preserved", "pass", {});

    // ---- Continuation WITHOUT supplying the marker again.
    const turn2 = crypto.randomUUID();
    const resumePrompt = "Repeat the exact marker line from your previous reply in this conversation, on a single line and nothing else. Do not call any tools.";
    await sendTurn(second.request, {
      generation: generation2,
      projectToken: token2,
      controller,
      conversationId,
      turnId: turn2,
      prompt: resumePrompt,
      model,
    });
    const settled2 = await pollTurnTerminal(second.request, {
      generation: generation2,
      projectToken: token2,
      conversationId,
      turnId: turn2,
      deadlineMs,
    });
    if (settled2.blocked !== null) {
      record(cases, "continue-no-tools", "fail", { blocked: settled2.blocked });
      return failReceipt("APPROVAL_BLOCKED", { eventKinds: settled2.eventKinds });
    }
    if (settled2.terminal?.nativeOutcome !== "completed") {
      record(cases, "continue-no-tools", "fail", {
        outcome: settled2.terminal?.nativeOutcome ?? settled2.terminal?.kind ?? "unknown",
      });
      return failReceipt("CONTINUATION_NOT_COMPLETED");
    }
    record(cases, "continue-no-tools", "pass", { outcome: "completed" });
    const markerCount2 = countOccurrences(settled2.text, marker);
    const hydrate3 = await second.request("native_chat_hydrate_conversation", {
      generation: generation2,
      projectToken: token2,
      conversationId,
    });
    const identity3 = nativeIdentityOf(hydrate3);
    if (identity3 === null || identity3.kind !== identity1.kind || identity3.value !== identity1.value) {
      record(cases, "identity-preserved-after-continue", "fail", {
        before: identity1,
        after: identity3,
      });
      return failReceipt("IDENTITY_CHANGED");
    }
    record(cases, "identity-preserved-after-continue", "pass", { nativeIdentityKind: identity3.kind });
    if (markerCount2 !== 1) {
      record(cases, "replay-marker-once", "fail", {
        markerCount: markerCount2,
        textChars: settled2.text.length,
      });
      return failReceipt(markerCount2 === 0 ? "MARKER_NOT_REPLAYED" : "MARKER_REPLAYED_MULTIPLE_TIMES", {
        markerCount: markerCount2,
      });
    }
    record(cases, "replay-marker-once", "pass", { markerCount: markerCount2 });
    const closed2 = await second.request("native_chat_close", {
      generation: generation2,
      projectToken: token2,
    }).then(() => ({ closedCleanly: true })).catch((err) => ({ closedCleanly: false, detail: err?.message ?? String(err) }));
    // Owned resources are still released by the host close in finally; a
    // failed service-level close is recorded as uncertainty, not pass/fail.
    record(cases, "close-after-continue", closed2.closedCleanly ? "pass" : "fail", { ...closed2, advisory: true });
    return {
      ...context,
      finishedAt: new Date().toISOString(),
      result: "pass",
      cases,
      nativeIdentityKind: identity1.kind,
      generations: [generation1, generation2],
    };
  } catch (err) {
    if (err instanceof AcceptanceError) {
      return { ...failReceipt(err.code, { errorDetail: err.message }), errorCode: err.code };
    }
    return failReceipt("UNEXPECTED", { errorDetail: err?.message ?? String(err) });
  } finally {
    if (first !== null) {
      try {
        await first.close();
      } catch {
        // Close is best-effort here; the receipt already records the outcome.
      }
    }
    if (second !== null) {
      try {
        await second.close();
      } catch {
        // Same as above.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry. Default (no --allow-live): refuse BEFORE any fixture, host, or
// provider work, so refusal performs zero provider starts.
// ---------------------------------------------------------------------------
export async function runAcceptanceCli(argv, deps = {}) {
  const parsed = parseAcceptanceArgs(argv);
  if (parsed.help) {
    return { exitCode: 0, output: usageText() };
  }
  if (!parsed.allowLive) {
    return {
      exitCode: 2,
      output: "refused: live provider execution requires explicit --allow-live with --controller, --model and --output (zero provider starts performed)",
      code: "REFUSAL",
    };
  }
  const outputPath = assertFreshOutput(parsed.output);
  const openHost = deps.openHost ?? openRealHost;
  const createFixtureFn = deps.createFixture ?? createFixture;
  let fixture = null;
  try {
    fixture = await createFixtureFn();
  } catch (err) {
    return {
      exitCode: 1,
      output: `fixture setup failed: ${err?.message ?? err}`,
      code: err?.code ?? "IO",
    };
  }
  if (!fixture.databasePath.startsWith(`${fixture.root}${path.sep}`)) {
    fixture.cleanup();
    return { exitCode: 1, output: "fixture database is outside the owned fixture root; refusing", code: "STATE" };
  }
  let receipt = null;
  try {
    receipt = await runAcceptanceProbe({
      openHost: (args) => openHost({ ...args, deadlineMs: parsed.deadlineMs }),
      controller: parsed.controller,
      model: parsed.model,
      fixture,
      deadlineMs: parsed.deadlineMs,
    });
  } catch (err) {
    receipt = {
      tool: ACCEPTANCE_TOOL,
      version: ACCEPTANCE_VERSION,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      controller: parsed.controller,
      model: parsed.model,
      node: process.version,
      platform: process.platform,
      result: "fail",
      reason: err?.code ?? "UNEXPECTED",
      errorDetail: err?.message ?? String(err),
      cases: [],
    };
  } finally {
    try {
      fixture.cleanup();
    } catch {
      // Temp cleanup is best-effort; receipt already recorded.
    }
  }
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    fs.writeFileSync(outputPath, body, { mode: 0o600, flag: "wx" });
  } catch (err) {
    return { exitCode: 1, output: `receipt write failed: ${err?.message ?? err}`, code: "IO" };
  }
  const ok = receipt?.result === "pass";
  return {
    exitCode: ok ? 0 : 1,
    output: ok ? `pass: receipt written to ${outputPath}` : `fail (${receipt?.reason ?? "unknown"}): receipt written to ${outputPath}`,
    code: receipt?.reason ?? (ok ? "PASS" : "FAIL"),
    receipt,
  };
}

const invokedAsMain = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
    return entry !== null && entry === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  runAcceptanceCli(process.argv).then(
    (result) => {
      console.log(result.output);
      process.exit(result.exitCode);
    },
    (err) => {
      console.error(`error: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
