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
  assertFreshOutput,
  countOccurrences,
  createFixture,
  defaultDatabasePath,
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
function createFakeWorld(options = {}) {
  const catalogue = options.catalogue ?? ["test-model"];
  const stores = new Map();
  const log = [];
  const mode = options.mode ?? "echo"; // echo | ignore-marker | approval-block
  function storeFor(databasePath) {
    if (!stores.has(databasePath)) {
      stores.set(databasePath, { conversations: new Map(), drafts: new Map(), queued: [] });
    }
    return stores.get(databasePath);
  }
  async function openHost({ generation, databasePath }) {
    const store = storeFor(databasePath);
    let token = null;
    async function request(command, args = {}) {
      log.push({ command, generation, prompt: typeof args?.prompt === "string" ? args.prompt : null });
      if (command === "native_chat_validate_project") {
        token = `token-${generation}`;
        return { generation, projectToken: token };
      }
      if (command === "shutdown") return { generation, stopped: true };
      if (command === "native_chat_prepare_project") {
        // Mirrors the real service: the challenge token (not generation) gates prepare.
        if (args?.projectToken !== token || args?.trusted !== true) {
          throw new AcceptanceError("STATE", "bad project token or missing trust");
        }
        return { generation, models: catalogue.map((id) => ({ id })) };
      }
      if (args?.generation !== generation) {
        throw new AcceptanceError("STALE", "stale generation");
      }
      if (args?.projectToken !== token) throw new AcceptanceError("STATE", "unknown project token");
      switch (command) {
        case "direct_chat_send": {
          const { sessionId, turnId, prompt } = args;
          if (!sessionId || !turnId || !prompt) throw new AcceptanceError("STATE", "bad send args");
          let conversation = store.conversations.get(sessionId);
          if (!conversation) {
            conversation = { id: sessionId, nativeThreadId: "native-thread-1", turns: [] };
            store.conversations.set(sessionId, conversation);
          }
          conversation.turns.push({ turnId, prompt });
          if (mode === "approval-block") {
            store.queued.push({ kind: "approval_requested", turnId, sessionId, nativeOutcome: null });
          } else {
            const marker = options.marker;
            const reply = typeof marker === "string" && prompt.includes(marker)
              ? marker
              : (mode === "echo" ? marker : "the model replies without repeating anything");
            store.queued.push({ kind: "message_delta", turnId, sessionId, text: reply });
            store.queued.push({ kind: "turn_done", turnId, sessionId, nativeOutcome: "completed" });
          }
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
          return { generation, conversation: { conversationId: conversation.id, nativeThreadId: conversation.nativeThreadId } };
        }
        case "native_chat_close": {
          return { generation, closed: true };
        }
        default:
          throw new AcceptanceError("STATE", `unexpected command ${command}`);
      }
    }
    async function close() {
      return { closedCleanly: true };
    }
    return { request, close };
  }
  return { openHost, log };
}

function fakeFixture(marker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-acceptance-fake-"));
  dirs.push(root);
  return {
    root,
    projectDir: path.join(root, "project"),
    databasePath: path.join(root, "sessions.sqlite3"),
    conversationId: randomUUID(),
    marker: marker ?? `MARKER-${randomUUID().slice(0, 8).toUpperCase()}`,
    cleanup() {},
  };
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
      "save-draft", "hydrate-before-restart", "close-before-restart", "reopen-prepare",
      "list-after-restart", "identity-preserved", "draft-preserved", "continue-no-tools",
      "identity-preserved-after-continue", "replay-marker-once"]) {
      expect(byName.get(name)).toBe("pass");
    }
    // Continuation never re-supplies the marker; the peer echoes it exactly once.
    const sends = world.log.filter((entry) => entry.command === "direct_chat_send");
    expect(sends).toHaveLength(2);
    expect(sends[0].prompt).toContain(marker);
    expect(sends[1].prompt).not.toContain(marker);
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
});
