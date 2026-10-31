import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PassThrough } from "node:stream";
import { createNativeChatService } from "../server/native-chat.mjs";
import { createNativeRpc } from "../server/native-rpc.mjs";

const GEN = "gen-1";
const tick = () => new Promise((r) => setImmediate(r));
const frame = (o) => `${JSON.stringify(o)}\n`;

const dirs = [];
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "nchat-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let connCounter = 0;
class FakeClient {
  constructor(models) {
    this.models = models ?? [{ id: "gpt-test", name: "GPT Test", isDefault: true }];
    this.connectionId = `conn-${(connCounter += 1)}`;
    this.handlers = null;
    this.requests = [];
    this.responded = [];
    this.retired = [];
    this.closes = 0;
    this.closed = false;
    this.closeImpl = null;
    this.threadIds = 0;
    this.turnIds = 0;
    this.threadImpl = null;
    this.turnImpl = null;
    this.interruptImpl = null;
    this.deferTurns = false;
    this.pendingTurns = [];
  }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threadIds += 1;
      if (this.threadImpl) return this.threadImpl(params, this.threadIds);
      return { thread: { id: `th-${this.threadIds}` } };
    }
    if (method === "turn/start") {
      this.turnIds += 1;
      const n = this.turnIds;
      if (this.turnImpl) return this.turnImpl(params, n);
      if (this.deferTurns) return new Promise((resolve) => { this.pendingTurns.push({ resolve, n }); });
      return { turn: { id: `tu-${n}` } };
    }
    if (method === "turn/interrupt") {
      if (this.interruptImpl) return this.interruptImpl(params);
      return {};
    }
    throw new Error(`unexpected native request ${method}`);
  }
  async respond(id, result) {
    this.responded.push({ id, result });
    return undefined;
  }
  retire(id) {
    this.retired.push(id);
    return true;
  }
  async close() {
    this.closes += 1;
    this.closed = true;
    if (this.closeImpl) return this.closeImpl();
    return undefined;
  }
  note(method, params) {
    this.handlers.onNotification({ method, params });
  }
  req(id, method, params) {
    this.handlers.onRequest({ id, method, params });
  }
  resolveTurn(id) {
    const p = this.pendingTurns.shift();
    if (!p) throw new Error("no pending turn/start");
    p.resolve({ turn: { id } });
  }
}

function makeService(models) {
  const client = new FakeClient(models);
  const fatals = [];
  const openClient = vi.fn(async (opts) => {
    client.handlers = opts;
    return client;
  });
  const svc = createNativeChatService({ generation: GEN, onFatal: (e) => fatals.push(e), openClient });
  return { svc, client, fatals, openClient };
}

async function prepared(models) {
  const h = makeService(models);
  const dir = tempDir();
  const validated = await h.svc.handle("native_chat_validate_project", { path: dir });
  const info = await h.svc.handle("native_chat_prepare_project", { projectToken: validated.projectToken, trusted: true });
  return { ...h, dir, validated, token: validated.projectToken, info };
}

const sendFor = (token, over = {}) => ({
  generation: GEN, projectToken: token, sessionId: "s1", turnId: "u1",
  model: "gpt-test", prompt: "hello", role: "implement", effort: "medium", ...over,
});
const pollFor = (svc, token) => svc.handle("native_chat_poll", { generation: GEN, projectToken: token });
function completeTurn(client, threadId, turnId, status, errorMessage) {
  const turn = { id: turnId, status };
  if (status === "failed") turn.error = { message: errorMessage ?? "boom" };
  client.note("turn/completed", { threadId, turn });
}

describe("validate/prepare trust", () => {
  it("requires an absolute existing directory and returns the canonical path", async () => {
    const { svc } = makeService();
    const file = join(tempDir(), "f");
    writeFileSync(file, "x");
    await expect(svc.handle("native_chat_validate_project", { path: "relative/x" })).rejects.toThrow(/absolute/);
    await expect(svc.handle("native_chat_validate_project", { path: join(tempDir(), "missing") })).rejects.toThrow(/existing directory/);
    await expect(svc.handle("native_chat_validate_project", { path: file })).rejects.toThrow(/existing directory/);
    const dir = tempDir();
    const v = await svc.handle("native_chat_validate_project", { path: dir });
    expect(v).toEqual({ generation: GEN, path: realpathSync(dir), name: basename(realpathSync(dir)), projectToken: expect.any(String) });
  });

  it("prepare consumes the challenge once and needs explicit trust", async () => {
    const h = await prepared();
    expect(h.info.models).toEqual([{ id: "gpt-test", name: "GPT Test", isDefault: true }]);
    expect(h.client.requests).toHaveLength(0); // no thread/turn at prepare
    await expect(h.svc.handle("native_chat_prepare_project", { projectToken: h.token, trusted: true })).rejects.toThrow(/stale or unknown/);
    await expect(h.svc.handle("native_chat_prepare_project", { projectToken: "nope", trusted: true })).rejects.toThrow();
    const v2 = await h.svc.handle("native_chat_validate_project", { path: h.dir });
    await expect(h.svc.handle("native_chat_prepare_project", { projectToken: v2.projectToken, trusted: "yes" })).rejects.toThrow(/trusted/);
    await expect(h.svc.handle("native_chat_prepare_project", { projectToken: v2.projectToken, trusted: true })).rejects.toThrow(/already prepared/);
  });

  it("a failed prepare retains no trust and allows fresh validation", async () => {
    const failing = createNativeChatService({
      generation: GEN,
      onFatal: () => {},
      openClient: async () => { throw new Error("metadata unavailable"); },
    });
    const dir = tempDir();
    const v = await failing.handle("native_chat_validate_project", { path: dir });
    await expect(failing.handle("native_chat_prepare_project", { projectToken: v.projectToken, trusted: true })).rejects.toThrow(/preparing project failed/);
    await expect(failing.handle("direct_chat_send", sendFor(v.projectToken))).rejects.toThrow(/no prepared project/);
    const v2 = await failing.handle("native_chat_validate_project", { path: dir });
    await expect(v2.projectToken).not.toBe(v.projectToken);
  });

  it("rejects a different prepared project until explicit close", async () => {
    const h = await prepared();
    const dir2 = tempDir();
    const v2 = await h.svc.handle("native_chat_validate_project", { path: dir2 });
    await expect(h.svc.handle("native_chat_prepare_project", { projectToken: v2.projectToken, trusted: true })).rejects.toThrow(/already prepared/);
    await h.svc.handle("native_chat_close", { generation: GEN, projectToken: h.token });
    const v3 = await h.svc.handle("native_chat_validate_project", { path: dir2 });
    const info = await h.svc.handle("native_chat_prepare_project", { projectToken: v3.projectToken, trusted: true });
    expect(info.path).toBe(realpathSync(dir2));
  });
});

describe("send validation and threads", () => {
  it("rejects stale generation, wrong tokens, and bad send fields", async () => {
    const h = await prepared();
    const badGen = { ...sendFor(h.token), generation: "old" };
    await expect(h.svc.handle("direct_chat_send", badGen)).rejects.toThrow(/stale/);
    await expect(h.svc.handle("direct_chat_send", sendFor("wrong"))).rejects.toThrow(/project token/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { model: "ghost" }))).rejects.toThrow(/unknown model/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { role: "chat" }))).rejects.toThrow(/role/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { effort: "ultra" }))).rejects.toThrow(/effort/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { prompt: "" }))).rejects.toThrow(/prompt/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { prompt: "x".repeat(65537) }))).rejects.toThrow(/prompt/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { sessionId: "" }))).rejects.toThrow(/sessionId/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "t".repeat(129) }))).rejects.toThrow(/turnId/);
    await expect(pollFor(h.svc, "wrong")).rejects.toThrow(/project token/);
    await expect(h.svc.handle("native_chat_poll", { generation: "old", projectToken: h.token })).rejects.toThrow(/stale/);
  });

  it("creates one thread for two turns, never sends history, refuses replay", async () => {
    const h = await prepared();
    const first = await h.svc.handle("direct_chat_send", sendFor(h.token, { prompt: "first" }));
    expect(first).toEqual({ generation: GEN, sessionId: "s1", turnId: "u1", nativeThreadId: "th-1", nativeTurnId: "tu-1" });
    expect(h.client.requests[0]).toEqual({
      method: "thread/start",
      params: { model: "gpt-test", modelProvider: "openai", cwd: h.dir, sandbox: "workspace-write", approvalPolicy: "untrusted", config: { mcp_servers: {} } },
    });
    expect(h.client.requests[1]).toEqual({
      method: "turn/start",
      params: { threadId: "th-1", input: [{ type: "text", text: "first" }], effort: "medium" },
    });
    completeTurn(h.client, "th-1", "tu-1", "completed");
    const events = await pollFor(h.svc, h.token);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ kind: "turn_complete", nativeOutcome: "completed", sessionId: "s1", turnId: "u1", harness: "codex", generation: GEN });
    const second = await h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2", prompt: "second" }));
    expect(second.nativeThreadId).toBe("th-1");
    expect(second.nativeTurnId).toBe("tu-2");
    expect(h.client.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(h.client.requests.at(-1).params.input).toEqual([{ type: "text", text: "second" }]);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { prompt: "replay" }))).rejects.toThrow(/already admitted/);
    completeTurn(h.client, "th-1", "tu-2", "completed");
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u3", role: "review" }))).rejects.toThrow(/immutable/);
  });

  it("uses read-only sandbox for review sessions", async () => {
    const h = await prepared();
    await h.svc.handle("direct_chat_send", sendFor(h.token, { sessionId: "rev", turnId: "t1", role: "review" }));
    expect(h.client.requests[0].params.sandbox).toBe("read-only");
  });

  it("guards one active provider turn app-wide", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const first = h.svc.handle("direct_chat_send", sendFor(h.token));
    first.catch(() => {});
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/already active/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { sessionId: "s2", turnId: "t1" }))).rejects.toThrow(/already active/);
    h.client.resolveTurn("tu-1");
    await expect(first).resolves.toMatchObject({ nativeTurnId: "tu-1" });
    completeTurn(h.client, "th-1", "tu-1", "completed");
  });

  it("fails closed when the provider never returns a turn id", async () => {
    const h = await prepared();
    h.client.turnImpl = async () => ({ nope: true });
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token))).rejects.toThrow(/turn.id/);
    expect(h.fatals).toHaveLength(1);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);
  });
});

describe("races and terminal outcomes", () => {
  it("binds an early turn/started plus delta before the ACK", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-9" } });
    h.client.note("item/agentMessage/delta", { threadId: "th-1", turnId: "tu-9", itemId: "i-1", delta: "hel" });
    h.client.note("item/agentMessage/delta", { threadId: "th-1", turnId: "tu-9", itemId: "i-1", delta: "lo" });
    h.client.resolveTurn("tu-9");
    await expect(sent).resolves.toEqual({ generation: GEN, sessionId: "s1", turnId: "u1", nativeThreadId: "th-1", nativeTurnId: "tu-9" });
    const { events } = await pollFor(h.svc, h.token);
    const deltas = events.filter((e) => e.kind === "message_delta");
    expect(deltas.map((e) => e.text).join("")).toBe("hello");
    expect(deltas[0]).toMatchObject({ sessionId: "s1", turnId: "u1", harness: "codex", nativeThreadId: "th-1", nativeTurnId: "tu-9", generation: GEN });
  });

  it("rejects an ACK that does not match the activated turn", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-real" } });
    h.client.resolveTurn("tu-other");
    await expect(sent).rejects.toThrow(/ACK does not match/);
    expect(h.fatals).toHaveLength(1);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);
  });

  it("settles a terminal that arrives before the ACK without resurrecting", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-7" } });
    completeTurn(h.client, "th-1", "tu-7", "completed");
    h.client.resolveTurn("tu-7");
    await expect(sent).resolves.toMatchObject({ nativeThreadId: "th-1", nativeTurnId: "tu-7" });
    const { events } = await pollFor(h.svc, h.token);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "turn_complete", nativeOutcome: "completed" });
    h.client.deferTurns = false;
    const next = await h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }));
    expect(next.nativeThreadId).toBe("th-1");
  });

  it("fails closed on a mismatched ACK even after a terminal", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-real" } });
    completeTurn(h.client, "th-1", "tu-real", "completed");
    h.client.resolveTurn("tu-other");
    await expect(sent).rejects.toThrow(/ACK does not match/);
    expect(h.fatals).toHaveLength(1);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);
  });

  it("reports failed and interrupted distinctly and releases the turn", async () => {
    const h = await prepared();
    const a = await h.svc.handle("direct_chat_send", sendFor(h.token));
    completeTurn(h.client, a.nativeThreadId, a.nativeTurnId, "failed", "kaput");
    let polled = await pollFor(h.svc, h.token);
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]).toMatchObject({ kind: "error", text: "kaput", nativeOutcome: "failed", turnId: "u1" });
    const b = await h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }));
    completeTurn(h.client, b.nativeThreadId, b.nativeTurnId, "interrupted");
    polled = await pollFor(h.svc, h.token);
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]).toMatchObject({ kind: "status", nativeOutcome: "interrupted", turnId: "u2" });
    const c = await h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u3" }));
    expect(c.nativeThreadId).toBe("th-1");
  });

  it("ignores foreign thread notifications", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-other", turn: { id: "tu-x" } });
    h.client.note("item/agentMessage/delta", { threadId: "th-other", turnId: "tu-x", itemId: "i-1", delta: "lost" });
    h.client.resolveTurn("tu-1");
    await expect(sent).resolves.toMatchObject({ nativeTurnId: "tu-1" });
    const { events } = await pollFor(h.svc, h.token);
    expect(events).toHaveLength(0);
  });

  it("faults when activation never arrives and clears the timer on close", async () => {
    vi.useFakeTimers();
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.fatals[0].message).toMatch(/activate/);
    h.client.resolveTurn("tu-late");
    await expect(sent).rejects.toThrow(/closed/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);

    const h2 = await prepared();
    h2.client.deferTurns = true;
    const pending = h2.svc.handle("direct_chat_send", sendFor(h2.token));
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0); // enter turn/start before closing the project
    await h2.svc.handle("native_chat_close", { generation: GEN, projectToken: h2.token });
    expect(h2.client.closes).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h2.fatals).toHaveLength(0);
    h2.client.resolveTurn("tu-z");
    await expect(pending).rejects.toThrow(/closed/);
  });
});

describe("approval requests", () => {
  async function activeTurn() {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-1" } });
    h.client.resolveTurn("tu-1");
    await expect(sent).resolves.toMatchObject({ nativeTurnId: "tu-1" });
    return h;
  }
  const approvalParams = (over = {}) => ({
    threadId: "th-1", turnId: "tu-1", itemId: "item-7",
    command: "rm -rf /tmp/x", reason: "cleanup", availableDecisions: ["accept", "decline"], ...over,
  });

  it("offers a command approval on numeric id 0 and answers exactly once", async () => {
    const h = await activeTurn();
    h.client.req(0, "item/commandExecution/requestApproval", approvalParams());
    const { events } = await pollFor(h.svc, h.token);
    expect(events).toHaveLength(1);
    const [approval] = events;
    expect(approval).toMatchObject({
      kind: "approval", approvalType: "command", decisions: ["accept", "decline"],
      nativeItemId: "item-7", sessionId: "s1", turnId: "u1",
      harness: "codex", generation: GEN, nativeThreadId: "th-1", nativeTurnId: "tu-1",
    });
    expect(approval.text).toContain("rm -rf /tmp/x");
    expect(typeof approval.approvalId).toBe("string");
    const ack = await h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: approval.approvalId, decision: "accept",
    });
    expect(ack).toEqual({ generation: GEN, approvalId: approval.approvalId, acknowledged: true });
    expect(h.client.responded).toEqual([{ id: 0, result: { decision: "accept" } }]);
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: approval.approvalId, decision: "accept",
    })).rejects.toThrow(/already-answered/);
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: "missing", decision: "accept",
    })).rejects.toThrow(/unknown/);
  });

  it("enforces offered decisions, file type, and text bounds", async () => {
    const h = await activeTurn();
    h.client.req(11, "item/fileChange/requestApproval", { threadId: "th-1", turnId: "tu-1", itemId: "f-1", command: "x".repeat(5000), availableDecisions: ["decline"] });
    const { events } = await pollFor(h.svc, h.token);
    expect(events[0]).toMatchObject({ kind: "approval", approvalType: "file" });
    expect(events[0].text.length).toBeLessThanOrEqual(4096);
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: events[0].approvalId, decision: "accept",
    })).rejects.toThrow(/not offered/);
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: events[0].approvalId, decision: "maybe",
    })).rejects.toThrow(/accept, decline, or cancel/);
    const ack = await h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: events[0].approvalId, decision: "decline",
    });
    expect(ack.acknowledged).toBe(true);
  });

  it("ignores foreign approvals and rejects stale or cross-turn answers", async () => {
    const h = await activeTurn();
    h.client.req(5, "item/commandExecution/requestApproval", approvalParams({ turnId: "tu-other", itemId: "evil" }));
    h.client.req(6, "item/commandExecution/requestApproval", approvalParams({ threadId: "th-other", itemId: "evil" }));
    expect((await pollFor(h.svc, h.token)).events).toHaveLength(0);
    expect(h.client.retired).toEqual(expect.arrayContaining([5, 6]));
    expect(h.client.responded).toHaveLength(0);
    h.client.req(7, "item/commandExecution/requestApproval", approvalParams({ itemId: "mine" }));
    const { events } = await pollFor(h.svc, h.token);
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "other-turn",
      approvalId: events[0].approvalId, decision: "accept",
    })).rejects.toThrow(/does not belong/);
    completeTurn(h.client, "th-1", "tu-1", "completed");
    await expect(h.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1",
      approvalId: events[0].approvalId, decision: "accept",
    })).rejects.toThrow(/already-answered/);
  });

  it("invalidates pending approvals on terminal and on provider resolution", async () => {
    const h = await activeTurn();
    h.client.req(0, "item/commandExecution/requestApproval", approvalParams({ itemId: "a" }));
    h.client.req(1, "item/commandExecution/requestApproval", approvalParams({ itemId: "b" }));
    await pollFor(h.svc, h.token);
    completeTurn(h.client, "th-1", "tu-1", "completed");
    const polled = await pollFor(h.svc, h.token);
    const resolved = polled.events.filter((e) => e.kind === "approval_resolved");
    expect(resolved).toHaveLength(2);
    expect(h.client.retired).toEqual(expect.arrayContaining([0, 1]));

    const h2 = await activeTurn();
    h2.client.req(0, "item/commandExecution/requestApproval", approvalParams({ itemId: "c" }));
    const [ask] = (await pollFor(h2.svc, h2.token)).events;
    h2.client.note("serverRequest/resolved", { requestId: 0 });
    const after = await pollFor(h2.svc, h2.token);
    expect(after.events).toEqual([expect.objectContaining({ kind: "approval_resolved", approvalId: ask.approvalId })]);
    expect(h2.client.retired).toContain(0);
    await expect(h2.svc.handle("native_chat_respond", {
      generation: GEN, projectToken: h2.token, sessionId: "s1", turnId: "u1",
      approvalId: ask.approvalId, decision: "accept",
    })).rejects.toThrow(/already-answered/);
  });
});

describe("cancel", () => {
  it("does not interrupt on ACK alone and retains the activation deadline", async () => {
    vi.useFakeTimers();
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    await h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1" });
    expect(h.client.requests.filter((r) => r.method === "turn/interrupt")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.fatals[0].message).toMatch(/activate/);
    expect(sent.nativeTurnId).toBe("tu-1");
  });

  it("fails closed when interrupt fails, but ignores a late failure after terminal", async () => {
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    h.client.note("turn/started", { threadId: "th-1", turn: { id: sent.nativeTurnId } });
    h.client.interruptImpl = () => Promise.reject(new Error("interrupt broken"));
    await h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1" });
    await tick();
    expect(h.fatals[0].message).toMatch(/interrupt broken/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);

    const next = await prepared();
    let rejectInterrupt;
    next.client.interruptImpl = () => new Promise((_, reject) => { rejectInterrupt = reject; });
    const first = await next.svc.handle("direct_chat_send", sendFor(next.token));
    next.client.note("turn/started", { threadId: "th-1", turn: { id: first.nativeTurnId } });
    await next.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: next.token, sessionId: "s1", turnId: "u1" });
    completeTurn(next.client, "th-1", first.nativeTurnId, "interrupted");
    await next.svc.handle("direct_chat_send", sendFor(next.token, { turnId: "u2" }));
    rejectInterrupt(new Error("late"));
    await tick();
    expect(next.fatals).toHaveLength(0);
  });

  it("clears the termination timer on terminal", async () => {
    vi.useFakeTimers();
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    h.client.note("turn/started", { threadId: "th-1", turn: { id: sent.nativeTurnId } });
    await h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1" });
    completeTurn(h.client, "th-1", sent.nativeTurnId, "interrupted");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fatals).toHaveLength(0);
  });
  it("waits for activation when cancelling early and never reports stopped", async () => {
    const h = await prepared();
    h.client.deferTurns = true;
    const sent = h.svc.handle("direct_chat_send", sendFor(h.token));
    sent.catch(() => {});
    await tick();
    const cancelled = await h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1" });
    expect(cancelled).toEqual({ generation: GEN, sessionId: "s1", turnId: "u1", cancelling: true });
    expect((await pollFor(h.svc, h.token)).events).toHaveLength(0);
    expect(h.client.requests.filter((r) => r.method === "turn/interrupt")).toHaveLength(0);
    h.client.note("turn/started", { threadId: "th-1", turn: { id: "tu-1" } });
    h.client.resolveTurn("tu-1");
    await expect(sent).resolves.toMatchObject({ nativeTurnId: "tu-1" });
    await tick();
    expect(h.client.requests.filter((r) => r.method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: "th-1", turnId: "tu-1" } },
    ]);
    completeTurn(h.client, "th-1", "tu-1", "interrupted");
    const polled = await pollFor(h.svc, h.token);
    expect(polled.events).toHaveLength(1);
    expect(polled.events[0]).toMatchObject({ kind: "status", nativeOutcome: "interrupted" });
  });

  it("interrupts an active turn at once and requires the exact current turn", async () => {
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    h.client.note("turn/started", { threadId: sent.nativeThreadId, turn: { id: sent.nativeTurnId } });
    await expect(h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "nope" })).rejects.toThrow(/no matching active turn/);
    const cancelled = await h.svc.handle("direct_chat_cancel", { generation: GEN, projectToken: h.token, sessionId: "s1", turnId: "u1" });
    expect(cancelled.cancelling).toBe(true);
    expect(h.client.requests.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: "th-1", turnId: sent.nativeTurnId } });
  });
});

describe("unsupported requests, overflow, and close", () => {
  it("fails the turn visibly on unknown requests and never auto-accepts", async () => {
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    h.client.note("turn/started", { threadId: sent.nativeThreadId, turn: { id: sent.nativeTurnId } });
    h.client.req(9, "clarification/request", { threadId: "th-1", turnId: sent.nativeTurnId });
    const { events } = await pollFor(h.svc, h.token);
    expect(events.some((e) => e.kind === "error" && /unsupported native request/.test(e.text))).toBe(true);
    expect(h.client.responded).toHaveLength(0);
    expect(h.client.retired).toContain(9);
    expect(h.client.requests.at(-1).method).toBe("turn/interrupt");
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/already active/);
    completeTurn(h.client, "th-1", sent.nativeTurnId, "interrupted");
    const retry = await h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }));
    expect(retry.nativeThreadId).toBe("th-1");
  });

  it("notifies the owner once on mailbox overflow and stops the service", async () => {
    const h = await prepared();
    const sent = await h.svc.handle("direct_chat_send", sendFor(h.token));
    h.client.note("turn/started", { threadId: sent.nativeThreadId, turn: { id: sent.nativeTurnId } });
    for (let n = 0; n < 256; n += 1) {
      h.client.note("item/agentMessage/delta", { threadId: "th-1", turnId: sent.nativeTurnId, itemId: `i-${n}`, delta: "x" });
    }
    h.client.note("item/agentMessage/delta", { threadId: "th-1", turnId: sent.nativeTurnId, itemId: "i-overflow", delta: "x" });
    expect(h.fatals).toHaveLength(1);
    expect(h.client.closes).toBe(1);
    await expect(pollFor(h.svc, h.token)).rejects.toThrow(/closed/);
    await expect(h.svc.handle("direct_chat_send", sendFor(h.token, { turnId: "u2" }))).rejects.toThrow(/closed/);
  });

  it("closes the owned client, erases everything, and stays reusable via explicit close", async () => {
    const h = await prepared();
    await h.svc.handle("direct_chat_send", sendFor(h.token));
    const done = await h.svc.handle("native_chat_close", { generation: GEN, projectToken: h.token });
    expect(done).toEqual({ generation: GEN, closed: true });
    expect(h.client.closes).toBe(1);
    await expect(pollFor(h.svc, h.token)).rejects.toThrow(/no prepared project/);
    await expect(h.svc.handle("native_chat_close", { generation: GEN, projectToken: h.token })).resolves.toEqual({ generation: GEN, closed: true });
    await expect(h.svc.handle("native_chat_close", { generation: "old", projectToken: h.token })).rejects.toThrow(/stale/);
    const dir2 = tempDir();
    const v = await h.svc.handle("native_chat_validate_project", { path: dir2 });
    const info = await h.svc.handle("native_chat_prepare_project", { projectToken: v.projectToken, trusted: true });
    expect(info.path).toBe(realpathSync(dir2));
    await h.svc.close();
    await h.svc.close();
    await expect(h.svc.handle("native_chat_validate_project", { path: dir2 })).rejects.toThrow(/closed/);
  });

  it("reports cleanup failure to the owner and throws", async () => {
    const h = await prepared();
    h.client.closeImpl = async () => { throw new Error("close exploded"); };
    await expect(h.svc.close()).rejects.toThrow(/close exploded/);
    expect(h.fatals).toHaveLength(1);
    expect(h.fatals[0].message).toMatch(/close exploded/);
  });
});

describe("native rpc retire", () => {
  function livePeer() {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (c) => { chunks.push(Buffer.from(c)); });
    const fatal = [];
    const peer = createNativeRpc({ input, output, onFatal: (e) => fatal.push(e) });
    return { input, output, peer, fatal, lines: () => Buffer.concat(chunks).toString("utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)) };
  }

  it("forgets exactly one pending inbound id without a late write", async () => {
    const h = livePeer();
    h.input.write(frame({ id: 0, method: "approval", params: {} }));
    await tick();
    const origWrite = h.output.write.bind(h.output);
    h.output.write = (chunk, cb) => {
      origWrite(chunk, cb);
      return false; // the notification is admitted and holds the pump
    };
    const primer = h.peer.notify("block", {});
    const answered = h.peer.respond(0, { decision: "accept" });
    answered.catch(() => {});
    await tick();
    expect(h.peer.retire(0)).toBe(true);
    await expect(answered).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.retire(0)).toBe(false);
    h.output.write = origWrite;
    h.output.emit("drain");
    await tick();
    await expect(primer).resolves.toBeUndefined();
    expect(h.lines()).toEqual([{ method: "block", params: {} }]); // no late answer
    await expect(h.peer.respond(0, { late: true })).rejects.toMatchObject({ code: "NOT_SENT" });
    await h.peer.notify("later", {});
    expect(h.lines()).toEqual([{ method: "block", params: {} }, { method: "later", params: {} }]);
    expect(h.fatal).toHaveLength(0);
    h.peer.close();
  });

  it("keeps numeric 0 distinct from string ids and unrelated traffic healthy", async () => {
    const h = livePeer();
    h.input.write(frame({ id: 0, method: "a", params: {} }));
    h.input.write(frame({ id: "0", method: "b", params: {} }));
    h.input.write(frame({ id: "other", method: "c", params: {} }));
    await tick();
    expect(h.peer.retire(0)).toBe(true);
    expect(h.peer.retire("missing")).toBe(false);
    await h.peer.respond("0", { ok: 1 });
    await h.peer.respond("other", { ok: 2 });
    expect(h.lines()).toEqual([{ id: "0", result: { ok: 1 } }, { id: "other", result: { ok: 2 } }]);
    const pending = h.peer.request("m", {});
    await tick();
    h.input.write(frame({ id: h.lines().at(-1).id, result: "fine" }));
    await expect(pending).resolves.toBe("fine");
    expect(h.fatal).toHaveLength(0);
    h.peer.close();
  });
});
