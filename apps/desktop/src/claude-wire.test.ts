import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createNativeRpc } from "../server/native-rpc.mjs";
import type { NativeRpcOptions } from "../server/native-rpc.mjs";
import { claudeWireCodec } from "../server/claude-wire.mjs";
import { MAX_FRAME_BYTES, MAX_JSON_DEPTH } from "../server/protocol.mjs";

const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = { type: "user", uuid: "user-1", session_id: "session-1", parent_tool_use_id: null, client_composed: true, message: { role: "user", content: "hello" } };
afterEach(() => vi.useRealTimers());

function harness(overrides: Partial<NativeRpcOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const onFatal = vi.fn();
  const onRequest = vi.fn();
  const onNotification = vi.fn();
  const peer = createNativeRpc({ input, output, codec: claudeWireCodec, onFatal, onRequest, onNotification, ...overrides });
  return { input, output, peer, onFatal, onRequest, onNotification, lines: () => Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)) };
}

describe("Claude wire codec through native RPC", () => {
  it("rejects an invalid codec before attaching stream listeners", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() => createNativeRpc({ input, output, codec: { encode: () => ({}) } as any })).toThrow(/codec/);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("drain")).toBe(0);
  });
  it("maps initialize, user, tool approval, events, and split UTF-8", async () => {
    const h = harness();
    const pending = h.peer.request("initialize", { hooks: {} });
    expect(h.lines()).toEqual([{ type: "control_request", request_id: "rpc-1", request: { hooks: {}, subtype: "initialize" } }]);
    h.input.write(frame({ type: "control_response", response: { subtype: "success", request_id: "rpc-1" } }));
    await expect(pending).resolves.toEqual({});
    await h.peer.notify("claude/user", user);
    expect(h.lines()[1]).toEqual(user);
    const bytes = Buffer.from(frame({ type: "assistant", message: { content: "héllo ✓" } }));
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    h.input.write(bytes.subarray(0, cut));
    h.input.write(bytes.subarray(cut));
    expect(h.onNotification).toHaveBeenCalledWith({ method: "claude/event", params: { type: "assistant", message: { content: "héllo ✓" } } });
    h.input.write(frame({ type: "control_request", request_id: "tool-1", request: { subtype: "can_use_tool", tool_name: "Read" } }));
    expect(h.onRequest).toHaveBeenCalledWith({ id: "tool-1", method: "can_use_tool", params: { subtype: "can_use_tool", tool_name: "Read" } });
    await h.peer.respond("tool-1", { behavior: "allow" });
    expect(h.lines()[2]).toEqual({ type: "control_response", response: { subtype: "success", request_id: "tool-1", response: { behavior: "allow" } } });
    h.peer.close();
  });

  it("rejects malformed outbound frames without poisoning the peer", async () => {
    const h = harness();
    await expect(h.peer.request("initialize", { subtype: "override" })).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(h.peer.notify("claude/user", { ...user, session_id: "" })).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(h.peer.notify("other", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(h.peer.request("initialize", { big: "x".repeat(MAX_FRAME_BYTES) })).rejects.toMatchObject({ code: "NOT_SENT" });
    let deep: unknown = {};
    for (let i = 0; i < MAX_JSON_DEPTH; i += 1) deep = { deep };
    await expect(h.peer.request("initialize", { deep })).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.closed).toBe(false);
    await h.peer.notify("claude/user", user);
    h.peer.close();
  });

  it("faults once on invalid control frames and unknown correlations", () => {
    for (const bad of [
      { type: "control_response", response: { subtype: "success", request_id: "rpc-1", response: 1 } },
      { type: "control_response", response: { subtype: "error", request_id: "rpc-1", error: {} } },
      { type: "control_response", response: { subtype: "success", request_id: "unknown" } },
      { type: "control_future" },
    ]) {
      const h = harness();
      h.input.write(frame(bad));
      expect(h.peer.closed).toBe(true);
      expect(h.onFatal).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves remote errors and faults on duplicate responses", async () => {
    const h = harness();
    const pending = h.peer.request("initialize", {});
    h.input.write(frame({ type: "control_response", response: { subtype: "error", request_id: "rpc-1", error: "no" } }));
    await expect(pending).rejects.toMatchObject({ code: "REMOTE_ERROR", message: expect.stringContaining("CLAUDE_CONTROL_ERROR") });
    h.input.write(frame({ type: "control_response", response: { subtype: "success", request_id: "rpc-1" } }));
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it("bounds the actual and transformed envelopes in both directions", async () => {
    const oversized = "x".repeat(MAX_FRAME_BYTES);
    const h = harness();
    h.input.write(frame({ type: "assistant", text: oversized }));
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    const codec = { encode: () => ({ big: oversized }), decode: () => ({ method: "m", params: oversized }) };
    const out = harness({ codec });
    await expect(out.peer.notify("m", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(out.peer.closed).toBe(false);
    out.input.write(frame({ type: "x" }));
    expect(out.onFatal).toHaveBeenCalledTimes(1);
    let deep: unknown = {};
    for (let i = 0; i < MAX_JSON_DEPTH; i += 1) deep = { deep };
    const actual = harness();
    actual.input.write(frame({ type: "event", deep }));
    expect(actual.onFatal).toHaveBeenCalledTimes(1);
    const transformed = harness({ codec: { encode: () => ({ deep }), decode: () => ({ method: "m", params: deep }) } });
    await expect(transformed.peer.notify("m", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    transformed.input.write(frame({ type: "x" }));
    expect(transformed.onFatal).toHaveBeenCalledTimes(1);
  });

  it("keeps queued expiry NOT_SENT and written expiry OUTCOME_UNKNOWN", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 20 });
    const write = vi.spyOn(h.output, "write").mockReturnValue(false);
    await h.peer.notify("claude/user", user);
    const queued = h.peer.request("initialize", {});
    const queuedCheck = expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
    await vi.advanceTimersByTimeAsync(20);
    await queuedCheck;
    expect(h.peer.closed).toBe(false);
    write.mockRestore();
    h.output.emit("drain");
    const written = h.peer.request("initialize", {});
    const writtenCheck = expect(written).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await vi.advanceTimersByTimeAsync(20);
    await writtenCheck;
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it("faults on a native response for an unwritten request", async () => {
    const h = harness();
    vi.spyOn(h.output, "write").mockReturnValue(false);
    await h.peer.notify("claude/user", user);
    const pending = h.peer.request("initialize", {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "NOT_SENT" });
    h.input.write(frame({ type: "control_response", response: { subtype: "success", request_id: "rpc-1", response: {} } }));
    await rejected;
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it("fails written requests on write error", async () => {
    const h = harness();
    vi.spyOn(h.output, "write").mockImplementation(((_chunk: unknown, cb: (err: Error) => void) => { queueMicrotask(() => cb(new Error("broken"))); return true; }) as any);
    await expect(h.peer.request("initialize", {})).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(h.onFatal).toHaveBeenCalledTimes(1);
  });

  it("retires a queued control response during a reentrant write without dropping other frames", async () => {
    const h = harness();
    h.input.write(frame({ type: "control_request", request_id: "a", request: { subtype: "can_use_tool" } }) + frame({ type: "control_request", request_id: "b", request: { subtype: "can_use_tool" } }));
    h.onNotification.mockImplementation((message: { method: string; params: unknown }) => { if (message.method === "claude/control_cancel_request") h.peer.retire((message.params as { requestId: string }).requestId); });
    const original = h.output.write.bind(h.output);
    let queued: Promise<void> | undefined;
    let next: Promise<void> | undefined;
    vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      const result = original(chunk as any, cb as any);
      if (!queued) {
        queued = h.peer.respond("b", { behavior: "allow" });
        queued.catch(() => {});
        next = h.peer.notify("claude/user", user);
        h.input.write(frame({ type: "control_cancel_request", request_id: "b" }) + frame({ type: "control_cancel_request", request_id: "a" }));
      }
      return result;
    }) as any);
    const current = h.peer.respond("a", { behavior: "deny" });
    await expect(current).resolves.toBeUndefined();
    await expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(next).resolves.toBeUndefined();
    expect(h.lines()).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "a", response: { behavior: "deny" } } }, user]);
    expect(h.onFatal).not.toHaveBeenCalled();
    h.peer.close();
  });
});
