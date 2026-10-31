import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openClaudeClient } from "../server/claude-client.mjs";

const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const messageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const frame = (v: unknown) => `${JSON.stringify(v)}\n`;

class Child extends EventEmitter {
  pid = 123;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  writes: any[] = [];
  kill = vi.fn(() => { this.end(); return true; });
  closeOnEnd = true;
  closed = false;
  echoResponses = false;
  constructor(public auth: boolean, public reply = true) {
    super();
    this.stdin = new Writable({ write: (chunk, _enc, callback) => {
      const value = JSON.parse(chunk.toString());
      this.writes.push(value);
      if (this.echoResponses && value.type === "control_response") this.emitFrame(value);
      if (this.reply && value.type === "control_request") queueMicrotask(() => this.emitFrame({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: value.request.subtype === "initialize" ? { pid: this.pid, account: { apiProvider: "firstParty" }, models: [{ value: "default", displayName: "Default", resolvedModel: "actual", supportedEffortLevels: ["low", "high"] }] } : {} } }));
      callback();
    }, final: (callback) => { callback(); if (this.closeOnEnd) queueMicrotask(() => this.end()); } });
  }
  emitFrame(value: unknown) { this.stdout.write(frame(value)); }
  end() { if (this.closed) return; this.closed = true; this.emit("exit", 0, null); this.emit("close", 0, null); }
}

function fixture(options: { authStatus?: unknown; holdAuth?: boolean; reply?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-client-")); dirs.push(dir);
  const children: Child[] = [];
  const calls: Array<{ args: string[]; options: any }> = [];
  const spawn = vi.fn((_exe: string, args: string[], spawnOptions: any) => {
    const auth = args[0] === "auth";
    const child = new Child(auth, options.reply !== false);
    children.push(child); calls.push({ args, options: spawnOptions });
    if (auth) {
      child.closeOnEnd = false;
      if (!options.holdAuth) queueMicrotask(() => { child.stdout.write(JSON.stringify(options.authStatus ?? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); child.end(); });
    }
    return child;
  });
  return { dir, children, calls, spawn, options: { workspace: dir, resolveExe: () => resolve(dir, "claude.exe"), spawnImpl: spawn as any } };
}

describe("owned Claude client", () => {
  it("authenticates first and uses filtered environment and a read-only tool list", async () => {
    vi.stubEnv("aNtHrOpIc_API_KEY", "secret");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "secret");
    vi.stubEnv("MY_API_ENDPOINT", "secret");
    const h = fixture();
    const client = await openClaudeClient({ ...h.options, model: "default", sessionId: session, role: "review", effort: "high" });
    expect(h.calls).toHaveLength(2);
    expect(h.children[0].closed).toBe(true);
    expect(h.calls[0].args).toEqual(["auth", "status", "--json"]);
    expect(h.calls[0].options.env).toEqual(h.calls[1].options.env);
    expect(h.calls[1].options).toMatchObject({ shell: false, windowsHide: true, cwd: h.dir, stdio: ["pipe", "pipe", "pipe"] });
    for (const key of ["aNtHrOpIc_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "OPENAI_API_KEY", "MY_API_ENDPOINT"]) expect(h.calls[1].options.env[key]).toBeUndefined();
    expect(process.env.aNtHrOpIc_API_KEY).toBe("secret");
    const args = h.calls[1].args;
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ permissions: { ask: ["Read", "Grep", "Glob"] } });
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--session-id");
    expect(client.models).toEqual([{ id: "default", name: "Default", isDefault: true, resolvedModel: "actual", supportedEfforts: ["low", "high"] }]);
    expect(Object.isFrozen(client.models)).toBe(true);
    await client.close();
  });

  it("supports metadata-only and rejects non-first-party auth before a main spawn", async () => {
    const h = fixture();
    const client = await openClaudeClient({ ...h.options, metadataOnly: true });
    expect(h.calls[1].args).toContain("--no-session-persistence");
    await expect(client.sendUser({ uuid: messageId, prompt: "hello" })).rejects.toMatchObject({ code: "NOT_SENT" });
    await client.close();
    const bad = fixture({ authStatus: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" } });
    await expect(openClaudeClient({ ...bad.options, metadataOnly: true })).rejects.toThrow(/authentication/);
    expect(bad.calls).toHaveLength(1);
  });

  it("rejects a model or effort absent from live metadata and closes the child", async () => {
    const h = fixture();
    await expect(openClaudeClient({ ...h.options, model: "unknown", sessionId: session, role: "implement" })).rejects.toThrow(/catalog/);
    expect(h.children[1].closed).toBe(true);
    const e = fixture();
    await expect(openClaudeClient({ ...e.options, model: "default", sessionId: session, role: "review", effort: "max" })).rejects.toThrow(/effort/);
    expect(e.children[1].closed).toBe(true);
  });

  it("writes a user frame without inventing activation; control cancellation retires queued replies", async () => {
    const h = fixture();
    const onEvent = vi.fn(); const onRequest = vi.fn(); const onCancel = vi.fn();
    const client = await openClaudeClient({ ...h.options, model: "default", sessionId: session, role: "implement", resume: true, onEvent, onRequest, onCancel });
    expect(h.calls[1].args).toContain("--resume");
    expect(h.calls[1].args).not.toContain("--session-id");
    await client.sendUser({ uuid: messageId, prompt: "hello" });
    expect(client.nativeSessionId).toBeNull();
    expect(h.children[1].writes.at(-1)).toEqual({ type: "user", uuid: messageId, session_id: session, parent_tool_use_id: null, client_composed: true, message: { role: "user", content: "hello" } });
    h.children[1].emitFrame({ type: "assistant", session_id: session, message: {} });
    expect(client.nativeSessionId).toBe(session);
    expect(onEvent).toHaveBeenCalledTimes(1);
    const input = h.children[1].stdin;
    const original = input.write.bind(input);
    const blocked = vi.spyOn(input, "write").mockImplementation(((chunk: unknown, cb: unknown) => { original(chunk as any, cb as any); return false; }) as any);
    await client.sendUser({ uuid: messageId, prompt: "block" });
    h.children[1].emitFrame({ type: "control_request", request_id: "tool-1", request: { subtype: "can_use_tool", tool_name: "Read" } });
    expect(onRequest).toHaveBeenCalledWith({ id: "tool-1", request: { subtype: "can_use_tool", tool_name: "Read" } });
    await expect(client.respond("tool-1", { behavior: "allow", updatedInput: {}, updatedPermissions: [] } as any)).rejects.toMatchObject({ code: "NOT_SENT" });
    const queued = client.respond("tool-1", { behavior: "allow", updatedInput: {} });
    const rejected = expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(client.respond("tool-1", { behavior: "deny", message: "duplicate" })).rejects.toMatchObject({ code: "NOT_SENT" });
    h.children[1].emitFrame({ type: "control_cancel_request", request_id: "tool-1" });
    expect(onCancel).toHaveBeenCalledWith("tool-1");
    await rejected;
    await expect(client.respond("tool-1", { behavior: "deny", message: "no" })).rejects.toMatchObject({ code: "NOT_SENT" });
    blocked.mockRestore();
    input.emit("drain");
    expect(h.children[1].writes.some((w) => w.type === "control_response")).toBe(false);
    await client.interrupt();
    expect(h.children[1].writes.at(-1).request.subtype).toBe("interrupt");
    await client.close();
  });

  it("fails sticky once on a mismatched native session", async () => {
    const h = fixture(); const onFatal = vi.fn();
    const client = await openClaudeClient({ ...h.options, model: "default", sessionId: session, role: "review", onFatal });
    h.children[1].emitFrame({ type: "result", session_id: "wrong" });
    expect(client.closed).toBe(true);
    expect(onFatal).toHaveBeenCalledTimes(1);
    await expect(client.sendUser({ uuid: messageId, prompt: "x" })).rejects.toMatchObject({ code: "CLOSED" });
    await client.close();
  });

  it("ignores replayed permission responses, including reentrant allow and deny", async () => {
    const h = fixture(); const onFatal = vi.fn(); const onEvent = vi.fn(); const onRequest = vi.fn();
    const client = await openClaudeClient({ ...h.options, model: "default", sessionId: session, role: "review", onFatal, onEvent, onRequest });
    const child = h.children[1]; child.echoResponses = true;
    for (const [id, decision] of [["a", { behavior: "allow", updatedInput: { path: "fixture" } }], ["b", { behavior: "deny", message: "declined", interrupt: true }]] as const) {
      child.emitFrame({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Read" } });
      await expect(client.respond(id, decision)).resolves.toBeUndefined();
    }
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
    expect(client.closed).toBe(false);
    await client.close();
  });

  it("kills and reaps a timed-out auth child before refusing startup", async () => {
    vi.useFakeTimers();
    const h = fixture({ holdAuth: true });
    const opening = openClaudeClient({ ...h.options, metadataOnly: true });
    const failure = expect(opening).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(h.calls).toHaveLength(1);
    expect(h.children[0].kill).toHaveBeenCalledTimes(1);
    expect(h.children[0].closed).toBe(true);
  });

  it("signals uncertain auth cleanup and never starts a second child", async () => {
    vi.useFakeTimers();
    const h = fixture({ holdAuth: true }); const onFatal = vi.fn();
    const opening = openClaudeClient({ ...h.options, metadataOnly: true, onFatal });
    const failure = expect(opening).rejects.toThrow(/cleanup uncertain/);
    h.children[0].kill.mockImplementation(() => true);
    await vi.advanceTimersByTimeAsync(16_000);
    await failure;
    expect(h.calls).toHaveLength(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("bounds initialization within the startup budget and closes the main child", async () => {
    vi.useFakeTimers();
    const h = fixture({ reply: false });
    const opening = openClaudeClient({ ...h.options, metadataOnly: true });
    const failure = expect(opening).rejects.toThrow(/expired|timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(h.children[1].closed).toBe(true);
  });

  it("reports uncertain cleanup when a child fails to close after SIGKILL", async () => {
    vi.useFakeTimers();
    const h = fixture(); const onFatal = vi.fn();
    const client = await openClaudeClient({ ...h.options, metadataOnly: true, onFatal });
    const child = h.children[1]; child.closeOnEnd = false; child.kill.mockImplementation(() => true);
    const closing = client.close();
    expect(client.close()).toBe(closing);
    const failure = expect(closing).rejects.toThrow(/cleanup uncertain/);
    await vi.advanceTimersByTimeAsync(4_000);
    await failure;
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});
