import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHost } from "../server/host.mjs";
import type { HostDispatch, HostRunOptions, HostServiceContext, HostFatalCallback } from "../server/host.mjs";
import { encodeFrame, MAX_FRAME_BYTES } from "../server/protocol.mjs";
import type { JsonObject, RequestEnvelope } from "../server/protocol.mjs";

const GEN = "gen-host-test";
const req = (requestId: string, generation: string, command: string, args: JsonObject = {}): RequestEnvelope =>
  ({ v: 1, type: "request", requestId, generation, command, args });
interface Harness { input: PassThrough; done: Promise<void>; frames: () => any[]; errors: () => string; }

function makeHarness(dispatch?: HostDispatch, generation = GEN, extra: Partial<HostRunOptions> = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  output.on("data", (c: Buffer) => { out.push(c); });
  error.on("data", (c: Buffer) => { err.push(c); });
  const done = runHost({ input, output, error, generation, dispatch, ...extra });
  return {
    input, done,
    frames: () => Buffer.concat(out).toString("utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)),
    errors: () => Buffer.concat(err).toString("utf8"),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("host bootstrap", () => {
  it("emits exactly one ready event before reading requests", async () => {
    const h = makeHarness();
    await tick();
    h.input.end();
    await h.done;
    const ready = h.frames().filter((f) => f.event === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ v: 1, type: "event", requestId: null, generation: GEN, event: "ready", payload: { protocolVersion: 1 } });
    expect(typeof ready[0].payload.pid).toBe("number");
  });
  it("answers ping and stops on EOF", async () => {
    const h = makeHarness();
    h.input.write(encodeFrame(req("r1", GEN, "ping")));
    h.input.end();
    await h.done;
    const [ready, res] = h.frames();
    expect(ready.event).toBe("ready");
    expect(res).toMatchObject({ v: 1, type: "result", requestId: "r1", generation: GEN });
    expect(res.result).toMatchObject({ ok: true });
    expect(typeof res.result.pid).toBe("number");
    expect(h.errors()).toBe("");
  });
  it("handles split chunks, split UTF8, CRLF and multiple frames per chunk", async () => {
    const h = makeHarness();
    const f1 = encodeFrame(req("r1", GEN, "ping", { text: "héllo ✓ 🎉" }));
    const buf = Buffer.from(f1, "utf8");
    const cut = buf.indexOf(Buffer.from("✓")) + 1; // inside a multibyte char
    h.input.write(buf.subarray(0, cut));
    await tick();
    h.input.write(buf.subarray(cut));
    const f2 = encodeFrame(req("r2", GEN, "ping")).replace(/\n$/, "\r\n");
    const f3 = encodeFrame(req("r3", GEN, "ping"));
    h.input.write(f2 + f3); // two frames in one chunk
    h.input.end();
    await h.done;
    expect(h.frames().filter((f) => f.type === "result").map((f) => f.requestId)).toEqual(["r1", "r2", "r3"]);
  });
  it("processes requests serially in sender order", async () => {
    const seen: string[] = [];
    const dispatch: HostDispatch = async (_cmd, args) => {
      if ((args as { n?: number }).n === 1) await new Promise((r) => setTimeout(r, 30));
      seen.push(`${_cmd}:${(args as { n?: number }).n}`);
      return { n: (args as { n?: number }).n };
    };
    const h = makeHarness(dispatch);
    h.input.write(encodeFrame(req("r1", GEN, "orch_dashboard", { n: 1 })));
    h.input.write(encodeFrame(req("r2", GEN, "orch_dashboard", { n: 2 })));
    h.input.end();
    await h.done;
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(["r1", "r2"]);
    expect(res.map((f) => f.result)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(seen).toEqual(["orch_dashboard:1", "orch_dashboard:2"]);
  });
  it("consumes a large coalesced chunk one frame at a time behind a slow dispatcher", async () => {
    let active = 0;
    let overlaps = 0;
    const order: number[] = [];
    const dispatch: HostDispatch = async (_cmd, args) => {
      if (active > 0) overlaps += 1;
      active += 1;
      const n = (args as { n?: number }).n as number;
      order.push(n);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return { n };
    };
    const frames: string[] = [];
    for (let n = 1; n <= 12; n += 1) frames.push(encodeFrame(req(`r${n}`, GEN, "orch_dashboard", { n, pad: "x".repeat(100_000) })));
    const bulk = Buffer.from(frames.join("") + "{not json\n", "utf8");
    expect(bulk.length).toBeGreaterThan(MAX_FRAME_BYTES); // aggregate over the frame cap
    const h = makeHarness(dispatch);
    await tick(); // let the host attach before the single bulk chunk arrives
    h.input.emit("data", bulk); // one coalesced chunk, as a fast pipe can deliver
    await h.done;
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(overlaps).toBe(0); // at most one dispatch active at any time
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(frames.map((_, i) => `r${i + 1}`));
    expect(h.errors()).not.toBe(""); // the malformed tail closes the host afterwards
  });
  it("rejects unknown and mutating commands without dispatching", async () => {
    let calls = 0;
    const dispatch: HostDispatch = async () => { calls += 1; return {}; };
    const h = makeHarness(dispatch);
    for (const [id, cmd] of [["r1", "bogus_cmd"], ["r2", "orch_claim"], ["r3", "orch_cancel"]] as const) {
      h.input.write(encodeFrame(req(id, GEN, cmd)));
    }
    h.input.write(encodeFrame(req("r4", GEN, "ping")));
    h.input.end();
    await h.done;
    const errs = h.frames().filter((f) => f.type === "error");
    expect(errs).toHaveLength(3); // native commands (e.g. direct_chat_send) route to the service; see below
    for (const e of errs) expect(e.error.code).toBe("COMMAND_NOT_ALLOWED");
    expect(calls).toBe(0);
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(1); // host keeps serving after rejections
  });
  it("delegates allowlisted bridge commands to the dispatcher", async () => {
    const dispatch: HostDispatch = async (cmd, _args) => ({ via: cmd });
    const h = makeHarness(dispatch);
    h.input.write(encodeFrame(req("r1", GEN, "discover_harnesses")));
    h.input.write(encodeFrame(req("r2", GEN, "orch_dashboard")));
    h.input.end();
    await h.done;
    expect(h.frames().filter((f) => f.type === "result").map((f) => f.result)).toEqual([{ via: "discover_harnesses" }, { via: "orch_dashboard" }]);
  });
  it("returns STALE_GENERATION without executing", async () => {
    let calls = 0;
    const dispatch: HostDispatch = async () => { calls += 1; return {}; };
    const h = makeHarness(dispatch);
    h.input.write(encodeFrame(req("r1", "other-generation", "orch_dashboard")));
    h.input.write(encodeFrame(req("r1", GEN, "ping"))); // same ID still fresh here
    h.input.end();
    await h.done;
    const [ready, stale, pong] = h.frames();
    expect(ready.event).toBe("ready");
    expect(stale.type).toBe("error");
    expect(stale.error.code).toBe("STALE_GENERATION");
    expect(stale.generation).toBe(GEN); // correlated to the current generation
    expect(stale.requestId).toBe("r1");
    expect(pong.type).toBe("result");
    expect(calls).toBe(0);
  });
  it("rejects duplicate, reordered and malformed sender IDs", async () => {
    const h = makeHarness();
    for (const l of [
      encodeFrame(req("r1", GEN, "ping")),
      encodeFrame(req("r1", GEN, "ping")), // duplicate
      encodeFrame(req("r2", GEN, "bogus_cmd")), // consumes r2, rejected by allowlist
      encodeFrame(req("r2", GEN, "ping")), // duplicate of consumed r2
      encodeFrame(req("r1", GEN, "ping")), // reordered
      encodeFrame(req("nope", GEN, "ping")), // bad sender-ID format
      encodeFrame(req("r3", GEN, "ping")), // host still serves
    ]) h.input.write(l);
    h.input.end();
    await h.done;
    const got = h.frames().slice(1); // skip ready
    expect(got.map((f) => f.type)).toEqual(["result", "error", "error", "error", "error", "error", "result"]);
    expect(got[1].error.code).toBe("DUPLICATE_REQUEST_ID");
    expect(got[3].error.code).toBe("DUPLICATE_REQUEST_ID");
    expect(got[4].error.code).toBe("DUPLICATE_REQUEST_ID");
    expect(got[2].error.code).toBe("COMMAND_NOT_ALLOWED");
    expect(got[5].error.code).toBe("INVALID_ENVELOPE");
  });
  it("terminates on malformed input without fabricating a response", async () => {
    const h = makeHarness();
    h.input.write("{not json\n");
    await h.done; // terminates; no EOF needed
    expect(h.frames()).toHaveLength(1); // ready only
    expect(h.errors()).not.toBe("");
  });
  it("terminates on overlong unterminated input", async () => {
    const h = makeHarness();
    h.input.write(Buffer.alloc(MAX_FRAME_BYTES + 16, 0x61));
    await h.done;
    expect(h.frames()).toHaveLength(1); // ready only
    expect(h.errors()).not.toBe("");
  });
  it("terminates fail-closed on a short unterminated frame at EOF", async () => {
    const h = makeHarness();
    h.input.write('{"v":1,"type":"request"');
    h.input.end();
    await h.done;
    expect(h.frames()).toHaveLength(1); // ready only, no success fabricated
    expect(h.errors()).not.toBe("");
  });
  it("acknowledges shutdown then stops without EOF", async () => {
    const h = makeHarness();
    h.input.write(encodeFrame(req("r1", GEN, "ping")));
    h.input.write(encodeFrame(req("r2", GEN, "shutdown")));
    await h.done;
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(["r1", "r2"]);
    expect(res[1].result).toEqual({ ok: true });
  });
  it("dispatches nothing after a shutdown frame in the same chunk", async () => {
    let calls = 0;
    const dispatch: HostDispatch = async () => { calls += 1; return { ok: true }; };
    const h = makeHarness(dispatch);
    await tick(); // let the host attach before the single bulk chunk arrives
    h.input.emit("data", Buffer.from(
      encodeFrame(req("r1", GEN, "orch_dashboard"))
      + encodeFrame(req("r2", GEN, "shutdown"))
      + encodeFrame(req("r3", GEN, "orch_dashboard")),
      "utf8"));
    await h.done;
    expect(calls).toBe(1); // r3 is never dispatched after the shutdown ack
    expect(h.frames().map((f) => f.requestId)).toEqual([null, "r1", "r2"]);
    expect(h.errors()).toBe("");
  });
  it("finishes an accepted request before a later malformed frame closes the host", async () => {
    let calls = 0;
    const dispatch: HostDispatch = async () => { calls += 1; return { ok: true }; };
    const h = makeHarness(dispatch);
    await tick(); // let the host attach before the single bulk chunk arrives
    h.input.emit("data", Buffer.from(
      encodeFrame(req("r1", GEN, "orch_dashboard")) + "{not json\n" + encodeFrame(req("r2", GEN, "orch_dashboard")),
      "utf8"));
    await h.done;
    expect(calls).toBe(1); // r2 is never reached after the malformed frame
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(["r1"]); // r1's response landed first
    expect(h.errors()).not.toBe("");
  });
  it("accepts one chunk over 1MiB holding only individually valid frames", async () => {
    const pad = "x".repeat(100_000);
    const sent: string[] = [];
    for (let n = 1; n <= 12; n += 1) sent.push(encodeFrame(req(`r${n}`, GEN, "ping", { pad })));
    for (const f of sent) expect(Buffer.byteLength(f)).toBeLessThan(MAX_FRAME_BYTES);
    const bulk = Buffer.from(sent.join(""), "utf8");
    expect(bulk.length).toBeGreaterThan(MAX_FRAME_BYTES);
    const h = makeHarness();
    await tick(); // let the host attach before the single bulk chunk arrives
    h.input.emit("data", bulk); // one aggregate chunk, as a fast pipe can deliver
    h.input.end();
    await h.done;
    expect(h.frames().filter((f) => f.type === "result").map((f) => f.requestId)).toEqual(sent.map((_, i) => `r${i + 1}`));
    expect(h.errors()).toBe("");
  });
  it("accepts a frame at exactly the byte bound and rejects past it", async () => {
    const base = encodeFrame(req("r1", GEN, "ping", { pad: "" }));
    const exact = encodeFrame(req("r1", GEN, "ping", { pad: "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(base)) }));
    expect(Buffer.byteLength(exact)).toBe(MAX_FRAME_BYTES);
    const h = makeHarness();
    h.input.write(exact);
    h.input.end();
    await h.done;
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(1);
    expect(h.errors()).toBe("");
    const over = makeHarness();
    over.input.write(`${"a".repeat(MAX_FRAME_BYTES)}\n`); // one frame, one byte past the bound
    await over.done;
    expect(over.frames()).toHaveLength(1); // ready only
    expect(over.errors()).not.toBe("");
  });
  it("accepts a byte-bound frame split across arbitrary chunk boundaries", async () => {
    const base = encodeFrame(req("r1", GEN, "ping", { pad: "" }));
    const exact = encodeFrame(req("r1", GEN, "ping", { pad: "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(base)) }));
    expect(Buffer.byteLength(exact)).toBe(MAX_FRAME_BYTES);
    const buf = Buffer.from(exact, "utf8");
    const cut = Math.floor(buf.length / 3);
    const h = makeHarness();
    await tick();
    h.input.write(buf.subarray(0, cut));
    await tick();
    h.input.write(buf.subarray(cut, 2 * cut));
    await tick();
    h.input.write(buf.subarray(2 * cut));
    h.input.end();
    await h.done;
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(1);
    expect(h.errors()).toBe("");
  });
  it("rejects invalid UTF-8 instead of decoding replacement characters", async () => {
    const frame = Buffer.from(encodeFrame(req("r1", GEN, "ping", { text: "ok" })), "utf8");
    const okBytes = Buffer.from("ok", "utf8");
    const okIdx = frame.indexOf(okBytes);
    expect(okIdx).toBeGreaterThan(-1); // sanity: "ok" exists in the frame
    frame[okIdx + 1] = 0xff; // corrupt 'k' → invalid UTF-8 byte, JSON structure intact
    const h = makeHarness();
    h.input.write(frame);
    await h.done;
    expect(h.frames()).toHaveLength(1); // ready only
    expect(h.errors()).toMatch(/UTF-8/);
  });
  it("settles instead of hanging when output closes while backpressured", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    vi.spyOn(output, "write").mockReturnValue(false); // full buffer: drain never comes
    const done = runHost({ input, output, error, generation: GEN });
    await tick();
    output.destroy(); // close while the ready frame waits for drain
    await done;
  });
  it("holds the next request while a backpressured response awaits drain", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const writes: string[] = [];
    vi.spyOn(output, "write").mockImplementation((chunk: any) => { writes.push(String(chunk)); return false; });
    const calls: string[] = [];
    const dispatch: HostDispatch = async (cmd) => { calls.push(cmd); return { ok: true }; };
    const done = runHost({ input, output, error, generation: GEN, dispatch });
    await tick();
    output.emit("drain"); // flush the ready frame
    input.write(encodeFrame(req("r1", GEN, "orch_dashboard")) + encodeFrame(req("r2", GEN, "orch_dashboard")));
    await tick();
    await tick();
    expect(calls).toHaveLength(1); // r2 waits: r1's result has not drained
    expect(writes).toHaveLength(2); // ready + r1's result
    output.emit("drain");
    await tick();
    await tick();
    expect(calls).toHaveLength(2);
    expect(writes).toHaveLength(3); // r2's result is buffered, awaiting drain
    input.end();
    output.emit("drain");
    await done;
    expect(writes).toHaveLength(3);
  });
  it("writes no late result when a dispatch outlives an input error", async () => {
    let started = false;
    let release: (value: unknown) => void = () => {};
    const dispatch: HostDispatch = async () => { started = true; return new Promise<unknown>((r) => { release = r; }); };
    const h = makeHarness(dispatch);
    h.input.write(encodeFrame(req("r1", GEN, "orch_dashboard")));
    await tick();
    await tick();
    expect(started).toBe(true);
    h.input.destroy(new Error("boom"));
    await h.done;
    release({ late: true }); // dispatch resolves only after the host already settled
    await tick();
    await tick();
    expect(h.frames()).toHaveLength(1); // ready only; the late result is dropped
  });
});

describe("native chat service wiring", () => {
  interface Fake {
    calls: Array<{ command: string; args: unknown }>;
    closes: number;
    contexts: HostServiceContext[];
    fireFatal: HostFatalCallback | null;
    failWith: Error | null;
    handle: (command: string, args: unknown) => Promise<unknown>;
    close: () => Promise<void>;
  }
  function fakeService(): Fake {
    const fake: Fake = {
      calls: [],
      closes: 0,
      contexts: [],
      fireFatal: null,
      failWith: null,
      handle: async (command, args) => {
        fake.calls.push({ command, args });
        if (fake.failWith) throw fake.failWith;
        return { echo: command };
      },
      close: async () => { fake.closes += 1; },
    };
    return fake;
  }
  const factoryFor = (fake: Fake) => (ctx: HostServiceContext) => {
    fake.contexts.push(ctx);
    fake.fireFatal = ctx.onFatal;
    return fake;
  };

  it("forwards native commands with actual args, exactly one result each", async () => {
    const fake = fakeService();
    const h = makeHarness(undefined, GEN, { serviceFactory: factoryFor(fake) });
    h.input.write(encodeFrame(req("r1", GEN, "native_chat_validate_project", { path: "C:\\proj" })));
    h.input.write(encodeFrame(req("r2", GEN, "direct_chat_send", { text: "hi" })));
    h.input.end();
    await h.done;
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(["r1", "r2"]);
    expect(res.map((f) => f.result)).toEqual([{ echo: "native_chat_validate_project" }, { echo: "direct_chat_send" }]);
    expect(fake.calls).toEqual([
      { command: "native_chat_validate_project", args: { path: "C:\\proj" } },
      { command: "direct_chat_send", args: { text: "hi" } },
    ]);
    expect(fake.contexts).toHaveLength(1); // singleton service, host generation
    expect(fake.contexts[0].generation).toBe(GEN);
    expect(fake.closes).toBe(1); // EOF closed the service
    expect(h.errors()).toBe("");
  });
  it("creates the service lazily and never routes native commands to dispatch", async () => {
    let dispatchCalls = 0;
    const dispatch: HostDispatch = async () => { dispatchCalls += 1; return {}; };
    let factoryCalls = 0;
    const fake = fakeService();
    const factory = (ctx: HostServiceContext) => { factoryCalls += 1; return factoryFor(fake)(ctx); };
    const h = makeHarness(dispatch, GEN, { serviceFactory: factory });
    h.input.write(encodeFrame(req("r1", GEN, "ping")));
    h.input.write(encodeFrame(req("r2", GEN, "discover_harnesses")));
    await tick();
    await tick();
    expect(factoryCalls).toBe(0); // ready/discovery/ping start no provider
    h.input.write(encodeFrame(req("r3", GEN, "native_chat_poll")));
    h.input.write(encodeFrame(req("r4", GEN, "native_chat_respond", { text: "ok" })));
    h.input.end();
    await h.done;
    expect(factoryCalls).toBe(1);
    expect(dispatchCalls).toBe(1); // discover_harnesses only; native slice bypasses dispatch
    expect(fake.calls.map((c) => c.command)).toEqual(["native_chat_poll", "native_chat_respond"]);
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(4);
  });
  it("reports invalid UI requests as ordinary COMMAND_FAILED, never fatal", async () => {
    const fake = fakeService();
    fake.failWith = new Error("bad project path");
    const fatals: unknown[] = [];
    const h = makeHarness(undefined, GEN, { serviceFactory: factoryFor(fake), onFatal: (r: unknown) => { fatals.push(r); } });
    h.input.write(encodeFrame(req("r1", GEN, "native_chat_validate_project", { path: 42 })));
    h.input.write(encodeFrame(req("r2", GEN, "ping"))); // host keeps serving
    h.input.end();
    await h.done;
    const [err, pong] = h.frames().slice(1);
    expect(err.type).toBe("error");
    expect(err.error.code).toBe("COMMAND_FAILED");
    expect(err.error.message).toBe("bad project path");
    expect(pong.type).toBe("result");
    expect(fatals).toEqual([]);
    expect(h.errors()).toBe("");
  });
  it("routes service onFatal through the injected callback and settles", async () => {
    const fake = fakeService();
    const fatals: unknown[] = [];
    const h = makeHarness(undefined, GEN, { serviceFactory: factoryFor(fake), onFatal: (r: unknown) => { fatals.push(r); } });
    h.input.write(encodeFrame(req("r1", GEN, "direct_chat_send", { text: "hi" })));
    for (let i = 0; i < 100 && h.frames().length < 2; i += 1) await tick();
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(1);
    const fire = fake.fireFatal;
    expect(typeof fire).toBe("function");
    fire!("producer lost");
    await h.done;
    expect(fatals).toEqual(["producer lost"]);
    expect(fake.closes).toBe(1);
    expect(h.frames().filter((f) => f.type === "result")).toHaveLength(1); // still exactly one
  });
  it("closes the service on shutdown before acknowledging", async () => {
    const fake = fakeService();
    const h = makeHarness(undefined, GEN, { serviceFactory: factoryFor(fake) });
    h.input.write(encodeFrame(req("r1", GEN, "native_chat_poll")));
    h.input.write(encodeFrame(req("r2", GEN, "shutdown")));
    await h.done;
    expect(fake.closes).toBe(1);
    const res = h.frames().filter((f) => f.type === "result");
    expect(res.map((f) => f.requestId)).toEqual(["r1", "r2"]);
  });
});

describe("host child process", () => {
  const HOST = fileURLToPath(new URL("../server/host.mjs", import.meta.url));
  const DEADLINE = 10_000;

  function spawnHost() {
    const cwd = mkdtempSync(join(tmpdir(), "orch-host-"));
    const path = (process.env.PATH ?? "").split(delimiter).filter((p) => !p.toLowerCase().includes("node")).join(delimiter);
    const child = spawn(process.execPath, [HOST], { cwd, env: { ...process.env, PATH: path }, stdio: ["pipe", "pipe", "pipe"] });
    return { child, cwd };
  }

  function frameReader(stream: Readable) {
    let buf = "";
    const frames: any[] = [];
    stream.setEncoding("utf8");
    const onData = (c: string) => { buf += c; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { frames.push(JSON.parse(l)); } catch { /* skip malformed line */ } } } };
    stream.on("data", onData);
    return { frames: () => frames, wait: (n: number) => new Promise<void>((res, rej) => { if (frames.length >= n) return res(); const iv = setInterval(() => { if (frames.length >= n) { clearInterval(iv); clearTimeout(t); res(); } }, 20); const t = setTimeout(() => { clearInterval(iv); rej(new Error("frame timeout")); }, DEADLINE); }), close: () => { stream.removeListener("data", onData); } };
  }

  async function awaitExit(child: ReturnType<typeof spawn>) {
    await new Promise<void>((res, rej) => { if (child.exitCode !== null || child.signalCode !== null) return res(); const t = setTimeout(() => rej(new Error("child did not exit")), DEADLINE); child.on("exit", () => { clearTimeout(t); res(); }); });
  }

  function cleanup(child: ReturnType<typeof spawn>, cwd: string) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return awaitExit(child).then(() => rmSync(cwd, { recursive: true, force: true }));
  }

  it("ready PID matches child; two pings correlate; shutdown exits with stdin open", async () => {
    const { child, cwd } = spawnHost();
    const stderr: string[] = [];
    child.stderr!.on("data", (c: Buffer) => { stderr.push(c.toString()); });
    const rd = frameReader(child.stdout!);
    try {
      await rd.wait(1);
      const ready = rd.frames()[0];
      expect(ready.event).toBe("ready");
      expect(typeof ready.generation).toBe("string");
      expect(ready.generation.length).toBeGreaterThan(0);
      expect(ready.payload.pid).toBe(child.pid);
      const gen = ready.generation as string;
      child.stdin!.write(encodeFrame(req("r1", gen, "ping")));
      child.stdin!.write(encodeFrame(req("r2", gen, "ping")));
      await rd.wait(3);
      const [r1, r2] = rd.frames().slice(1);
      expect(r1).toMatchObject({ v: 1, type: "result", requestId: "r1", generation: gen });
      expect(r1.result.pid).toBe(child.pid);
      expect(r2).toMatchObject({ v: 1, type: "result", requestId: "r2", generation: gen });
      expect(r2.result.pid).toBe(child.pid);
      expect(child.stdin!.writable).toBe(true);
      child.stdin!.write(encodeFrame(req("r3", gen, "shutdown")));
      await rd.wait(4);
      expect(rd.frames()[3]).toMatchObject({ v: 1, type: "result", requestId: "r3", generation: gen, result: { ok: true } });
      await awaitExit(child);
    } finally { rd.close(); await cleanup(child, cwd); }
  }, DEADLINE + 5_000);

  it("malformed input terminates child without fabricated success", async () => {
    const { child, cwd } = spawnHost();
    const stderr: string[] = [];
    child.stderr!.on("data", (c: Buffer) => { stderr.push(c.toString()); });
    const rd = frameReader(child.stdout!);
    try {
      await rd.wait(1);
      expect(rd.frames()[0].event).toBe("ready");
      child.stdin!.write("{not json\n");
      await awaitExit(child);
      expect(rd.frames()).toHaveLength(1);
    } finally { rd.close(); await cleanup(child, cwd); }
  }, DEADLINE + 5_000);
});
