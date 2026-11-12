// Deterministic tests for the native acceptance probe.
//
// These tests inject a fixture host seam (openHost) and NEVER start the real
// product host or any provider. They cover orchestration only: refusal,
// catalogue gating, bounded errors, fixture ownership, and the two-generation
// restart flow. They do NOT prove live acceptance; only an explicit,
// authorized live run of scripts/native-acceptance.mjs does that.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AcceptanceError,
  CLAUDE_SEND_EFFORTS,
  CODEX_SEND_EFFORTS,
  SEND_ROLES,
  assertFreshOutput,
  countOccurrences,
  createFixture,
  defaultDatabasePath,
  describeProbeSource,
  openRealHost,
  parseAcceptanceArgs,
  runAcceptanceCli,
  runAcceptanceProbe,
  usageText,
  withTimeout,
} from "../scripts/native-acceptance.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-test-"));
  dirs.push(dir);
  return path.join(dir, "receipt.json");
}

// In-memory fixture host seam shared across "restarts" by databasePath.
// Implements just the command subset the probe uses, with generation +
// projectToken ownership checks (no fence-clearing shortcuts exist here).
// direct_chat_send enforces the real request contracts (role always
// required; effort required for Codex and catalogue-bound for Claude) and
// hydration returns real-shaped user/assistant messages so content checks
// cannot pass on an empty transcript.
function createFakeWorld(options = {}) {
  const catalogue = (options.catalogue ?? ["test-model"]).map((entry) =>
    typeof entry === "string" ? { id: entry } : entry);
  const stores = new Map();
  const log = [];
  const mode = options.mode ?? "echo"; // echo | ignore-marker | approval-block
  const closeMode = options.closeMode ?? "ok"; // ok | fail-service | fail-host | throw-host | fail-final-host-close
  let closes = 0;
  function storeFor(databasePath) {
    if (!stores.has(databasePath)) {
      stores.set(databasePath, { conversations: new Map(), drafts: new Map(), queued: [], controller: "codex" });
    }
    return stores.get(databasePath);
  }
  function checkSendContract(store, generation, token, args) {
    if (args?.generation !== generation) throw new AcceptanceError("STALE", "stale generation");
    if (args?.projectToken !== token) throw new AcceptanceError("STATE", "unknown project token");
    if (!SEND_ROLES.includes(args?.role)) {
      throw new AcceptanceError("STATE", "direct_chat_send role must be implement or review");
    }
    const entry = catalogue.find((candidate) => candidate.id === args?.model) ?? null;
    if (entry === null) {
      throw new AcceptanceError("STATE", `unknown model ${String(args?.model)} for the prepared project`);
    }
    if (store.controller === "claude") {
      if (args?.effort !== undefined && !CLAUDE_SEND_EFFORTS.includes(args.effort)) {
        throw new AcceptanceError("STATE", "direct_chat_send effort must be low, medium, high, xhigh or max");
      }
      if (args?.effort !== undefined && Array.isArray(entry.supportedEfforts) &&
          !entry.supportedEfforts.includes(args.effort)) {
        throw new AcceptanceError("STATE", "unknown Claude model or unsupported effort");
      }
    } else if (!CODEX_SEND_EFFORTS.includes(args?.effort)) {
      throw new AcceptanceError("STATE", "direct_chat_send effort must be low, medium, high, or xhigh");
    }
    if (typeof args?.sessionId !== "string" || args.sessionId.length === 0 ||
        typeof args?.turnId !== "string" || args.turnId.length === 0 ||
        typeof args?.prompt !== "string" || args.prompt.length === 0) {
      throw new AcceptanceError("STATE", "bad send args");
    }
  }
  async function openHost({ generation, databasePath }) {
    const store = storeFor(databasePath);
    let token = null;
    async function request(command, args = {}) {
      log.push({
        command,
        generation,
        role: args?.role ?? null,
        effort: args?.effort ?? null,
        prompt: typeof args?.prompt === "string" ? args.prompt : null,
      });
      if (command === "native_chat_validate_project") {
        token = `token-${generation}`;
        store.controller = args?.controller ?? "codex";
        return { generation, projectToken: token };
      }
      if (command === "shutdown") return { generation, stopped: true };
      if (command === "native_chat_prepare_project") {
        // Mirrors the real service: the challenge token (not generation) gates prepare.
        if (args?.projectToken !== token || args?.trusted !== true) {
          throw new AcceptanceError("STATE", "bad project token or missing trust");
        }
        return {
          generation,
          models: catalogue.map(({ id, supportedEfforts }) =>
            (supportedEfforts ? { id, supportedEfforts: [...supportedEfforts] } : { id })),
        };
      }
      if (args?.generation !== generation) {
        throw new AcceptanceError("STALE", "stale generation");
      }
      if (args?.projectToken !== token) throw new AcceptanceError("STATE", "unknown project token");
      switch (command) {
        case "direct_chat_send": {
          checkSendContract(store, generation, token, args);
          const { sessionId, turnId, prompt } = args;
          let conversation = store.conversations.get(sessionId);
          if (!conversation) {
            conversation = { id: sessionId, nativeThreadId: "native-thread-1", turns: [] };
            store.conversations.set(sessionId, conversation);
          }
          let reply = "";
          if (mode === "approval-block") {
            store.queued.push({ kind: "approval_requested", turnId, sessionId, nativeOutcome: null });
          } else {
            const marker = options.marker;
            reply = typeof marker === "string" && prompt.includes(marker)
              ? marker
              : (mode === "echo" ? marker : "the model replies without repeating anything");
            store.queued.push({ kind: "message_delta", turnId, sessionId, text: reply });
            store.queued.push({ kind: "turn_done", turnId, sessionId, nativeOutcome: "completed" });
          }
          conversation.turns.push({ turnId, prompt, replyText: reply });
          return { generation, sessionId, turnId, nativeThreadId: conversation.nativeThreadId };
        }
        case "native_chat_poll": {
          const events = store.queued.splice(0);
          return { generation, events, cursor: null, tip: 0, hasMore: false };
        }
        case "native_chat_save_draft": {
          store.drafts.set(args.conversationId, { text: args.text, saveId: args.saveId });
          return { generation, saved: true, receipt: { version: 1 } };
        }
        case "native_chat_get_draft": {
          return { generation, draft: store.drafts.get(args.conversationId) ?? null };
        }
        case "native_chat_list_conversations": {
          return { generation, conversations: [...store.conversations.values()].map((c) => ({ id: c.id })) };
        }
        case "native_chat_hydrate_conversation": {
          const conversation = store.conversations.get(args.conversationId);
          if (!conversation) return { generation, conversation: null };
          const messages = [];
          for (const turn of conversation.turns) {
            messages.push({ id: `user-${turn.turnId}`, role: "user", text: turn.prompt, tools: [], isStreaming: false });
            messages.push({
              id: turn.turnId,
              role: "assistant",
              text: turn.replyText,
              tools: [],
              outcome: "completed",
              isStreaming: false,
            });
          }
          return {
            generation,
            conversation: { conversationId: conversation.id, nativeThreadId: conversation.nativeThreadId, messages },
          };
        }
        case "native_chat_close": {
          if (closeMode === "fail-service") {
            throw new AcceptanceError("STATE", "native close failed: owned client did not release");
          }
          return { generation, closed: true };
        }
        default:
          throw new AcceptanceError("STATE", `unexpected command ${command}`);
      }
    }
    async function close() {
      closes += 1;
      if (closeMode === "throw-host") throw new Error("host close threw: owned pipes did not settle");
      if (closeMode === "fail-host" || (closeMode === "fail-final-host-close" && closes >= 2)) {
        return { closedCleanly: false, detail: "host close reported unclean" };
      }
      return { closedCleanly: true };
    }
    return { request, close };
  }
  return { openHost, log };
}

function fakeFixture(marker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-fake-"));
  dirs.push(root);
  const fixture = {
    root,
    projectDir: path.join(root, "project"),
    databasePath: path.join(root, "sessions.sqlite3"),
    conversationId: randomUUID(),
    marker: marker ?? `MARKER-${randomUUID().slice(0, 8).toUpperCase()}`,
    cleaned: false,
    cleanup() {
      fixture.cleaned = true;
    },
  };
  return fixture;
}

describe("native acceptance probe (seam only, never live)", () => {
  it("refuses without --allow-live and starts zero providers", async () => {
    let starts = 0;
    const openHost = async () => { starts += 1; throw new Error("must not start"); };
    const result = await runAcceptanceCli(["node", "native-acceptance.mjs"], { openHost });
    expect(result.exitCode).toBe(2);
    expect(result.code).toBe("REFUSAL");
    expect(starts).toBe(0);
  });

  it("usage requires controller, model and output with --allow-live", async () => {
    await expect(runAcceptanceCli(["node", "x", "--allow-live", "--controller", "codex"], {}))
      .rejects.toMatchObject({ code: "USAGE" });
    expect(parseAcceptanceArgs(["node", "x", "--help"]).help).toBe(true);
    expect(usageText()).toContain("--allow-live");
  });

  it("rejects a requested model absent from the catalogue without fallback", async () => {
    const marker = "MARKER-ABSENT-1";
    const world = createFakeWorld({ catalogue: ["other-model"], marker });
    const output = tempOutput();
    const fixture = fakeFixture(marker);
    const result = await runAcceptanceCli(
      ["node", "x", "--allow-live", "--controller", "codex", "--model", "missing-model", "--output", output,
        "--deadline-ms", "10000"],
      { openHost: world.openHost, createFixture: async () => fixture },
    );
    expect(result.exitCode).toBe(1);
    expect(result.receipt?.reason).toBe("MODEL_ABSENT");
    expect(result.receipt?.cases?.[0]).toMatchObject({ name: "catalogue-contains-model", status: "fail" });
    // No fallback: no provider turn was ever sent after the catalogue miss.
    expect(world.log.some((entry) => entry.command === "direct_chat_send")).toBe(false);
    // Receipt records the catalogue basis, not secrets.
    const written = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(written.reason).toBe("MODEL_ABSENT");
  });

  it("bounds operations and refuses to overwrite receipts", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "never"))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect(countOccurrences("aa-aa-aa", "aa")).toBe(3);
    expect(countOccurrences("nothing here", "MARKER")).toBe(0);
    const output = tempOutput();
    fs.writeFileSync(output, "{}\n");
    expect(() => assertFreshOutput(output)).toThrowError(AcceptanceError);
    await expect(runAcceptanceCli(
      ["node", "x", "--allow-live", "--controller", "codex", "--model", "m", "--output", output,
        "--deadline-ms", "10000"],
      { openHost: async () => { throw new Error("must not start"); } },
    )).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  });

  it("drives the real product host framing with zero provider starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-host-"));
    dirs.push(dir);
    const host = await openRealHost({
      generation: randomUUID(),
      databasePath: path.join(dir, "sessions.sqlite3"),
      deadlineMs: 10_000,
    });
    try {
      // ping never creates the native service, so no provider can start here.
      const pong = await host.request("ping", {});
      expect(pong?.ok).toBe(true);
      await expect(host.request("no_such_command_xyz", {})).rejects.toMatchObject({ code: "COMMAND" });
    } finally {
      const closed = await host.close();
      expect(closed.closedCleanly).toBe(true);
    }
  });

  it("owns fresh isolated fixture state (never the default database)", async () => {
    const first = await createFixture();
    const second = await createFixture();
    try {
      expect(first.root).not.toBe(second.root);
      expect(first.databasePath.startsWith(first.root)).toBe(true);
      expect(first.databasePath).not.toBe(defaultDatabasePath());
      expect(first.conversationId).not.toBe(second.conversationId);
      expect(fs.existsSync(path.join(first.projectDir, ".git"))).toBe(true);
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(first.root)).toBe(false);
  });

  it("drives the two-generation restart flow and passes on an echoing peer", async () => {
    const marker = "MARKER-ECHO-1";
    const world = createFakeWorld({ catalogue: ["test-model"], marker, mode: "echo" });
    const fixture = fakeFixture(marker);
    const receipt = await runAcceptanceProbe({
      openHost: world.openHost,
      controller: "codex",
      model: "test-model",
      fixture,
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("pass");
    expect(receipt.nativeIdentityKind).toBe("thread");
    expect(receipt.generations).toHaveLength(2);
    expect(receipt.generations[0]).not.toBe(receipt.generations[1]);
    const byName = new Map(receipt.cases.map((c) => [c.name, c.status]));
    for (const name of ["catalogue-contains-model", "validate-trust-prepare", "first-turn-no-tools",
      "save-draft", "hydrate-before-restart", "hydrate-content-before-restart",
      "close-before-restart", "reopen-prepare", "list-after-restart", "identity-preserved",
      "draft-preserved", "continue-no-tools", "identity-preserved-after-continue",
      "replay-marker-once", "hydrate-content-after-continue", "close-after-continue", "host-close"]) {
      expect(byName.get(name)).toBe("pass");
    }
    // Continuation never re-supplies the marker; the peer echoes it exactly once.
    const sends = world.log.filter((entry) => entry.command === "direct_chat_send");
    expect(sends).toHaveLength(2);
    expect(sends[0].prompt).toContain(marker);
    expect(sends[1].prompt).not.toContain(marker);
    // Both turns use the no-tools role with a catalogue effort.
    for (const send of sends) {
      expect(send.role).toBe("review");
      expect(send.effort).toBe("low");
    }
    // Receipt context carries truthful probe source provenance.
    expect(typeof receipt.source?.probeDigest === "string" && receipt.source.probeDigest.length === 64).toBe(true);
    const commit = receipt.source?.commit;
    expect(commit === "unknown" || /^[0-9a-f]{40}$/i.test(commit)).toBe(true);
    // No ownership/fence clearing or conflict-resolution shortcuts, ever.
    const forbidden = ["native_chat_acknowledge_stranded", "native_chat_resolve_draft_conflict", "orch_claim", "orch_release"];
    for (const command of forbidden) {
      expect(world.log.some((entry) => entry.command === command)).toBe(false);
    }
  });

  it("fails honestly when the peer ignores the marker scenario", async () => {
    const marker = "MARKER-IGNORED-1";
    const world = createFakeWorld({ catalogue: ["test-model"], marker, mode: "ignore-marker" });
    const receipt = await runAcceptanceProbe({
      openHost: world.openHost,
      controller: "codex",
      model: "test-model",
      fixture: fakeFixture(marker),
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("fail");
    expect(receipt.reason).toBe("MARKER_NOT_REPLAYED");
  });

  it("fails honestly when the first turn is blocked by an approval", async () => {
    const marker = "MARKER-BLOCKED-1";
    const world = createFakeWorld({ catalogue: ["test-model"], marker, mode: "approval-block" });
    const receipt = await runAcceptanceProbe({
      openHost: world.openHost,
      controller: "codex",
      model: "test-model",
      fixture: fakeFixture(marker),
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("fail");
    expect(receipt.reason).toBe("APPROVAL_BLOCKED");
  });

  it("sends the review role with a catalogue-supported effort for claude", async () => {
    const marker = "MARKER-CLAUDE-1";
    const world = createFakeWorld({
      catalogue: [{ id: "claude-model", supportedEfforts: ["high"] }],
      marker,
      mode: "echo",
    });
    const receipt = await runAcceptanceProbe({
      openHost: world.openHost,
      controller: "claude",
      model: "claude-model",
      fixture: fakeFixture(marker),
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("pass");
    // The real Claude path refuses a send without a TOOLS role, so the probe
    // must send one; effort comes from the catalogue entry.
    const sends = world.log.filter((entry) => entry.command === "direct_chat_send");
    expect(sends).toHaveLength(2);
    for (const send of sends) {
      expect(send.role).toBe("review");
      expect(send.effort).toBe("high");
    }
    expect(sends[0].prompt).toContain(marker);
    expect(sends[1].prompt).not.toContain(marker);
  });

  it("fixture seam enforces the real send contracts", async () => {
    const world = createFakeWorld({
      catalogue: [{ id: "m", supportedEfforts: ["high"] }],
      marker: "MARKER-CONTRACT-1",
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-contract-"));
    dirs.push(root);
    const generation = randomUUID();
    const host = await world.openHost({ generation, databasePath: path.join(root, "sessions.sqlite3") });
    const validated = await host.request("native_chat_validate_project", { path: root, controller: "claude" });
    await host.request("native_chat_prepare_project", { projectToken: validated.projectToken, trusted: true });
    const base = {
      generation,
      projectToken: validated.projectToken,
      sessionId: randomUUID(),
      turnId: randomUUID(),
      prompt: "hi",
      model: "m",
    };
    // The real Claude path refuses a missing, unknown, or miscatalogued role/effort.
    await expect(host.request("direct_chat_send", base)).rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, role: "chat", effort: "high" }))
      .rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, role: "review", effort: "low" }))
      .rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, role: "review", effort: "high", model: "nope" }))
      .rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, role: "review", effort: "high" }))
      .resolves.toMatchObject({ sessionId: base.sessionId });
    await host.close();
  });

  it("fixture seam requires an effort for codex sends", async () => {
    const world = createFakeWorld({ catalogue: ["m2"], marker: "MARKER-CONTRACT-2" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-contract-"));
    dirs.push(root);
    const generation = randomUUID();
    const host = await world.openHost({ generation, databasePath: path.join(root, "sessions.sqlite3") });
    const validated = await host.request("native_chat_validate_project", { path: root });
    await host.request("native_chat_prepare_project", { projectToken: validated.projectToken, trusted: true });
    const base = {
      generation,
      projectToken: validated.projectToken,
      sessionId: randomUUID(),
      turnId: randomUUID(),
      prompt: "hi",
      model: "m2",
      role: "implement",
    };
    await expect(host.request("direct_chat_send", base)).rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, effort: "ultra" }))
      .rejects.toMatchObject({ code: "STATE" });
    await expect(host.request("direct_chat_send", { ...base, effort: "low" }))
      .resolves.toMatchObject({ sessionId: base.sessionId });
    await host.close();
  });

  it("fails closed and retains the fixture when the owned service close fails", async () => {
    const marker = "MARKER-CLOSE-1";
    const world = createFakeWorld({ catalogue: ["test-model"], marker, mode: "echo", closeMode: "fail-service" });
    const output = tempOutput();
    const fixture = fakeFixture(marker);
    const result = await runAcceptanceCli(
      ["node", "x", "--allow-live", "--controller", "codex", "--model", "test-model", "--output", output,
        "--deadline-ms", "10000"],
      { openHost: world.openHost, createFixture: async () => fixture },
    );
    expect(result.exitCode).toBe(1);
    expect(result.receipt?.reason).toBe("CLOSE_UNCLEAN");
    expect(result.receipt?.retainFixture).toBe(true);
    expect(result.receipt?.fixtureRoot).toBe(fixture.root);
    expect(fixture.cleaned).toBe(false);
    const byName = new Map(result.receipt.cases.map((c) => [c.name, c.status]));
    expect(byName.get("close-after-continue")).toBe("fail");
    expect(byName.get("host-close")).toBeUndefined();
  });

  it("fails closed and retains the fixture when the final host close is unclean", async () => {
    const marker = "MARKER-CLOSE-2";
    const world = createFakeWorld({
      catalogue: ["test-model"],
      marker,
      mode: "echo",
      closeMode: "fail-final-host-close",
    });
    const output = tempOutput();
    const fixture = fakeFixture(marker);
    const result = await runAcceptanceCli(
      ["node", "x", "--allow-live", "--controller", "codex", "--model", "test-model", "--output", output,
        "--deadline-ms", "10000"],
      { openHost: world.openHost, createFixture: async () => fixture },
    );
    expect(result.exitCode).toBe(1);
    expect(result.receipt?.reason).toBe("CLOSE_UNCLEAN");
    expect(result.receipt?.retainFixture).toBe(true);
    expect(result.receipt?.fixtureRoot).toBe(fixture.root);
    expect(fixture.cleaned).toBe(false);
    const byName = new Map(result.receipt.cases.map((c) => [c.name, c.status]));
    expect(byName.get("close-after-continue")).toBe("pass");
    expect(byName.get("host-close")).toBe("fail");
  });

  it("fails closed when the pre-restart host close throws", async () => {
    const marker = "MARKER-CLOSE-3";
    const world = createFakeWorld({ catalogue: ["test-model"], marker, mode: "echo", closeMode: "throw-host" });
    const receipt = await runAcceptanceProbe({
      openHost: world.openHost,
      controller: "codex",
      model: "test-model",
      fixture: fakeFixture(marker),
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("fail");
    expect(receipt.reason).toBe("CLOSE_UNCLEAN");
    expect(receipt.retainFixture).toBe(true);
    const closeCase = receipt.cases.find((c) => c.name === "close-before-restart");
    expect(closeCase).toMatchObject({ status: "fail", detail: { thrown: true } });
  });

  it("drives the two-generation flow through the real host with an injected deterministic peer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-real-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "sessions.sqlite3");
    const marker = "MARKER-REAL-1";
    // Deterministic Codex peer: one marker echo per turn, completed at once.
    // Runs inside the REAL host/service (same framing, same SQLite durable
    // store); no live provider starts.
    let peerConnections = 0;
    function makePeer() {
      peerConnections += 1;
      const peer = {
        models: [{ id: "gpt-test", name: "GPT Test", isDefault: true }],
        connectionId: `peer-conn-${peerConnections}`,
        handlers: null,
        turns: 0,
        async request(method, params) {
          if (method === "thread/start") return { thread: { id: "th-peer-1" } };
          if (method === "thread/resume") return {};
          if (method === "turn/start") {
            peer.turns += 1;
            const turnId = `tu-peer-${peer.turns}`;
            const threadId = params.threadId;
            setImmediate(() => {
              // Real peers announce the turn first so the service binds and
              // observes it; deltas before activation are never journaled.
              peer.handlers.onNotification({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
              peer.handlers.onNotification({
                method: "item/agentMessage/delta",
                params: { threadId, turnId, itemId: `i-peer-${peer.turns}`, delta: marker },
              });
              peer.handlers.onNotification({
                method: "turn/completed",
                params: { threadId, turn: { id: turnId, status: "completed" } },
              });
            });
            return { turn: { id: turnId } };
          }
          throw new Error(`unexpected native request ${method}`);
        },
        async respond() {
          return undefined;
        },
        retire() {
          return true;
        },
        async close() {
          return undefined;
        },
      };
      return peer;
    }
    const openHost = ({ generation, databasePath }) => openRealHost({
      generation,
      databasePath,
      deadlineMs: 10_000,
      openClient: async (opts) => {
        const peer = makePeer();
        peer.handlers = opts;
        return peer;
      },
    });
    const projectDir = path.join(dir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const fixture = { root: dir, projectDir, databasePath: dbPath, conversationId: randomUUID(), marker, cleanup() {} };
    const receipt = await runAcceptanceProbe({
      openHost,
      controller: "codex",
      model: "gpt-test",
      fixture,
      deadlineMs: 10_000,
    });
    expect(receipt.result).toBe("pass");
    expect(receipt.nativeIdentityKind).toBe("thread");
    const byName = new Map(receipt.cases.map((c) => [c.name, c.status]));
    for (const name of ["replay-marker-once", "hydrate-content-before-restart",
      "hydrate-content-after-continue", "close-after-continue", "host-close"]) {
      expect(byName.get(name)).toBe("pass");
    }
  });

  it("reports probe source without inventing a candidate", async () => {
    const source = await describeProbeSource();
    expect(typeof source.probeDigest === "string" && source.probeDigest.length === 64).toBe(true);
    expect(source.commit === "unknown" || /^[0-9a-f]{40}$/i.test(source.commit)).toBe(true);
    expect(typeof source.root === "string").toBe(true);
  });
});
