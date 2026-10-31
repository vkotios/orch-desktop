import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCodexClient } from "../server/codex-client.mjs";

type ClientOptions = Parameters<typeof openCodexClient>[0];
type SpawnFn = NonNullable<ClientOptions["spawnImpl"]>;
const tick = () => new Promise<void>((r) => setImmediate(r));
const frame = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const EXE = join(tmpdir(), "fake-codex-native");
const ARGS = ["app-server", "--stdio", "-c", "mcp_servers={}", "-c", "analytics.enabled=false"];

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn(() => true);
}
const orderOf = (c: FakeChild) => (c as unknown as { order: string[] }).order;
// Real native shapes (Codex 0.156.1): account/read RESULT is
// { account: { type, ... }, requiresOpenaiAuth }, model/list RESULT is
// { data: [{ id, displayName, ... }], nextCursor }. Replies stay synchronous
// to exercise the legitimate PassThrough loopback path. No default account:
// an unspecified spec must read as unsigned (null), never as chatgpt.
function accountFixture(spec: unknown) {
  if (spec === "chatgpt") return { account: { type: "chatgpt", email: "private", planType: "pro" }, requiresOpenaiAuth: true };
  if (spec === "apiKey") return { account: { type: "apiKey" } };
  if (spec === null || spec === undefined) return { account: null };
  return spec as Record<string, unknown>;
}
function autoReply(child: FakeChild, accountSpec: unknown) {
  const order: string[] = [];
  (child as unknown as { order: string[] }).order = order;
  let buf = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: string; method?: string };
      if (msg.id === undefined) { order.push(`notify:${msg.method}`); continue; }
      order.push(msg.method ?? "?");
      const result = msg.method === "initialize" ? {}
        : msg.method === "account/read" ? accountFixture(accountSpec)
        : { data: [{ id: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: false }, { id: "", displayName: "bad" }, { id: "o4-mini" }], nextCursor: null };
      child.stdout.write(frame({ id: msg.id, result }));
    }
  });
}
function fakeSpawn(seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }>, accountSpec?: unknown, auto = true): SpawnFn {
  return ((exe: string, args: string[], options: any) => {
    const child = new FakeChild();
    seen.push({ exe, args, options, child });
    if (auto) autoReply(child, accountSpec);
    return child;
  }) as unknown as SpawnFn;
}
const tempDir = () => mkdtempSync(join(tmpdir(), "codex-client-"));
function setEnv(vars: Record<string, string>) {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return () => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
afterEach(() => { vi.useRealTimers(); });

describe("codex client process connection", () => {
  it("handshakes in order with exact spawn args, stripped env, and idempotent close", async () => {
    const dir = tempDir();
    const restore = setEnv({ OPENAI_API_KEY: "parent-secret", openai_org_id: "x", NODE_OPTIONS: "--inspect", IGM_CONTROL_KEY: "k", CODEX_API_KEY: "bare", FOO_API_KEY: "k2", FOO_BASE_URL: "u", CODEX_HOME: "saved-home", KEEP_ME: "yes" });
    try {
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const spawnImpl = fakeSpawn(seen, "chatgpt");
      const client = await openCodexClient({ workspace: dir, spawnImpl, resolveExe: () => EXE });
      expect(seen).toHaveLength(1);
      expect(seen[0].exe).toBe(EXE);
      expect(seen[0].args).toEqual(ARGS);
      expect(seen[0].options.cwd).toBe(realpathSync(dir));
      expect(seen[0].options.shell).toBe(false);
      expect(seen[0].options.windowsHide).toBe(true);
      expect(seen[0].options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      const env = seen[0].options.env as Record<string, string | undefined>;
      for (const k of ["OPENAI_API_KEY", "openai_org_id", "NODE_OPTIONS", "IGM_CONTROL_KEY", "CODEX_API_KEY", "FOO_API_KEY", "FOO_BASE_URL"]) {
        expect(env[k], k).toBeUndefined();
      }
      expect(env["CODEX_HOME"]).toBe("saved-home");
      expect(env["KEEP_ME"]).toBe("yes");
      expect(process.env.OPENAI_API_KEY).toBe("parent-secret");
      expect(orderOf(seen[0].child)).toEqual(["initialize", "notify:initialized", "account/read", "model/list"]);
      expect(client.models).toEqual([{ id: "gpt-6-sol", name: "GPT-6 Sol", isDefault: false }, { id: "o4-mini", name: "o4-mini", isDefault: false }]);
      expect(client.pid).toBe(4242);
      expect(client.workspace).toBe(realpathSync(dir));
      expect(client.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(client.closed).toBe(false);
      seen[0].child.stdin.on("finish", () => seen[0].child.emit("close", 0, null));
      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.close()).resolves.toBeUndefined();
      expect(seen[0].child.stdin.writableEnded).toBe(true);
      await expect(client.request("late", {})).rejects.toMatchObject({ code: "CLOSED" });
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad workspaces and a non-absolute exe before spawning", async () => {
    const dir = tempDir();
    try {
      const file = join(dir, "f");
      writeFileSync(file, "x");
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const spawnImpl = fakeSpawn(seen, undefined, false);
      for (const workspace of ["", "   ", "relative/path", join(dir, "missing"), file]) {
        await expect(openCodexClient({ workspace, spawnImpl, resolveExe: () => EXE }), workspace).rejects.toThrow();
      }
      await expect(openCodexClient({ workspace: dir, spawnImpl, resolveExe: () => "codex" })).rejects.toThrow();
      expect(seen).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-chatgpt accounts without auto-login and cleans up", async () => {
    for (const accountSpec of ["apiKey" as const, null, undefined]) {
      const dir = tempDir();
      try {
        const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
        const pending = openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, accountSpec), resolveExe: () => EXE, onFatal: vi.fn() });
        seen[0].child.stdin.on("finish", () => seen[0].child.emit("close", 0, null));
        await expect(pending).rejects.toThrow(/ChatGPT.*no automatic login/i);
        expect(seen[0].child.stdin.writableEnded).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("fails a cold startup and a spawn error with bounded cleanup", async () => {
    vi.useFakeTimers();
    try {
      const dir = tempDir();
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const onFatal = vi.fn();
      const pending = openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, undefined, false), resolveExe: () => EXE, onFatal });
      seen[0].child.stdin.on("finish", () => seen[0].child.emit("close", 0, null));
      const assertion = expect(pending).rejects.toThrow(/startup failed at initialize/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(seen[0].child.kill).toHaveBeenCalledTimes(1);
      expect(seen[0].child.stdin.writableEnded).toBe(true);
      rmSync(dir, { recursive: true, force: true });
      const dir2 = tempDir();
      const errChild = new FakeChild();
      errChild.stdin.on("finish", () => errChild.emit("close", -2, null));
      const errSpawn = (() => {
        setTimeout(() => errChild.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), 0);
        return errChild;
      }) as unknown as SpawnFn;
      const assertion2 = expect(openCodexClient({ workspace: dir2, spawnImpl: errSpawn, resolveExe: () => EXE, onFatal: vi.fn() })).rejects.toThrow(/startup failed at initialize/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion2;
      rmSync(dir2, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails sticky once on transport faults and reports close", async () => {
    const dir = tempDir();
    try {
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const onFatal = vi.fn();
      const client = await openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, "chatgpt"), resolveExe: () => EXE, onFatal });
      const child = seen[0].child;
      child.stdout.emit("error", new Error("cable cut"));
      await tick();
      expect(client.closed).toBe(true);
      expect(onFatal).toHaveBeenCalledTimes(1);
      child.emit("exit", 1, null);
      await tick();
      expect(onFatal).toHaveBeenCalledTimes(1);
      await expect(client.request("m", {})).rejects.toMatchObject({ code: "CLOSED" });
      child.emit("close", 1, null);
      await expect(client.close()).resolves.toBeUndefined();
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a close that never lands within bounds", async () => {
    vi.useFakeTimers();
    try {
      const dir = tempDir();
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const client = await openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, "chatgpt"), resolveExe: () => EXE });
      const assertion = expect(client.close()).rejects.toThrow(/did not exit/);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(seen[0].child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      await expect(client.close()).rejects.toThrow(/did not exit/);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a stdio error during close truthfully and delivers owner fatal once", async () => {
    const dir = tempDir();
    try {
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const onFatal = vi.fn();
      const client = await openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, "chatgpt"), resolveExe: () => EXE, onFatal });
      const child = seen[0].child;
      const closing = client.close();
      child.stderr.emit("error", new Error("late stderr cut"));
      await expect(closing).rejects.toThrow(/process error/);
      expect(onFatal).toHaveBeenCalledTimes(1);
      child.stdin.emit("error", new Error("late stdin"));
      child.stdout.emit("error", new Error("late stdout"));
      await tick();
      expect(onFatal).toHaveBeenCalledTimes(1);
      await expect(client.close()).rejects.toThrow(/process error/);
      expect(onFatal).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers owner fatal once when close times out with state unknown", async () => {
    vi.useFakeTimers();
    try {
      const dir = tempDir();
      const seen: Array<{ exe: string; args: string[]; options: any; child: FakeChild }> = [];
      const onFatal = vi.fn();
      const client = await openCodexClient({ workspace: dir, spawnImpl: fakeSpawn(seen, "chatgpt"), resolveExe: () => EXE, onFatal });
      const assertion = expect(client.close()).rejects.toThrow(/did not exit/);
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
      expect(onFatal).toHaveBeenCalledTimes(1);
      await expect(client.close()).rejects.toThrow(/did not exit/);
      expect(onFatal).toHaveBeenCalledTimes(1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
