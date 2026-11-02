import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createNativeRpc } from "../server/native-rpc.mjs";
import type { NativeRpcOptions } from "../server/native-rpc.mjs";
import { MAX_FRAME_BYTES } from "../server/protocol.mjs";

const tick = () => new Promise<void>((r) => setImmediate(r));
const frame = (obj: unknown) => `${JSON.stringify(obj)}\n`;

function makePeer(overrides: Partial<NativeRpcOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const notifications: unknown[] = [];
  const requests: unknown[] = [];
  const onFatal = vi.fn();
  const peer = createNativeRpc({
    input,
    output,
    onNotification: (m) => { notifications.push(m); },
    onRequest: (m) => { requests.push(m); },
    onFatal,
    ...overrides,
  });
  return {
    input, output, peer, onFatal, notifications, requests,
    lines: () => Buffer.concat(chunks).toString("utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)),
  };
}

describe("native rpc peer", () => {
  it("reassembles fragmented unicode and coalesced frames; notifications never resolve rpc", async () => {
    const h = makePeer();
    const pending = h.peer.request("thread/start", { q: 1 });
    const split = Buffer.from(frame({ method: "ready", params: { text: "héllo ✓ 🎉" } }), "utf8");
    const cut = split.indexOf(Buffer.from("✓")) + 1; // inside a multibyte char
    h.input.write(split.subarray(0, cut));
    await tick();
    h.input.write(Buffer.concat([split.subarray(cut), Buffer.from(frame({ method: "progress", params: {} }))])); // coalesced
    await tick();
    expect(h.notifications).toHaveLength(2);
    const waiting = Symbol("waiting");
    await expect(Promise.race([pending, tick().then(() => waiting)])).resolves.toBe(waiting);
    const id = h.lines().find((l) => l.method === "thread/start").id;
    h.input.write(frame({ id, result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
    expect(h.peer.closed).toBe(false);
    h.peer.close();
  });

  it("answers numeric server id 0 exactly once", async () => {
    const h = makePeer();
    h.input.write(frame({ id: 0, method: "prompt", params: { t: 1 } }));
    await tick();
    expect(h.requests).toEqual([{ id: 0, method: "prompt", params: { t: 1 } }]);
    await h.peer.respond(0, { ok: true });
    expect(h.lines()).toEqual([{ id: 0, result: { ok: true } }]);
    await expect(h.peer.respond(0, { late: true })).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.lines()).toHaveLength(1); // the duplicate answer is never written
    expect(h.peer.closed).toBe(false);
    h.peer.close();
  });

  it("does not retire a response being written or discard the next frame", async () => {
    const h = makePeer();
    h.input.write(frame({ id: 0, method: "prompt", params: {} }));
    h.input.write(frame({ id: "0", method: "other", params: {} }));
    await tick();
    const originalWrite = h.output.write.bind(h.output);
    let later: Promise<void> | undefined;
    const writeSpy = vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      const accepted = originalWrite(chunk as any, cb as any);
      if (!later) {
        later = h.peer.notify("later", {});
        expect(h.peer.retire(0)).toBe(true);
      }
      return accepted;
    }) as any);
    const answer = h.peer.respond(0, { decision: "decline" });
    await expect(answer).resolves.toBeUndefined();
    await expect(later).resolves.toBeUndefined();
    writeSpy.mockRestore();
    await h.peer.respond("0", { ok: true });
    expect(h.lines()).toEqual([
      { id: 0, result: { decision: "decline" } },
      { method: "later", params: {} },
      { id: "0", result: { ok: true } },
    ]);
    expect(h.onFatal).not.toHaveBeenCalled();
    h.peer.close();
  });

  it("matches out-of-order results and stays healthy after a remote error", async () => {
    const h = makePeer();
    const a = h.peer.request("a", {});
    const b = h.peer.request("b", {});
    await tick();
    const [first, second] = h.lines().map((l) => l.id);
    h.input.write(frame({ id: second, result: "two" }) + frame({ id: first, error: { code: -32602, message: "bad" } }));
    await expect(b).resolves.toBe("two");
    await expect(a).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    expect(h.peer.closed).toBe(false);
    const c = h.peer.request("c", {});
    await tick();
    h.input.write(frame({ id: h.lines().at(-1).id, result: 1 }));
    await expect(c).resolves.toBe(1);
    h.peer.close();
  });

  it("closes sticky on malformed, oversize, deep, invalid-utf8 and truncated input", async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    const valid = Buffer.from(frame({ id: "r1", method: "m", params: {} }), "utf8");
    const corrupt = Buffer.from(valid);
    corrupt[10] = 0xff; // ',' -> invalid UTF-8 byte, JSON structure intact
    const cases: Array<{ name: string; act: (input: PassThrough) => void }> = [
      { name: "malformed", act: (input) => { input.write("{not json\n"); } },
      { name: "oversize", act: (input) => { input.write(Buffer.alloc(MAX_FRAME_BYTES + 16, 0x61)); } },
      { name: "deep", act: (input) => { input.write(frame({ id: "d", method: "m", params: deep })); } },
      { name: "invalid-utf8", act: (input) => { input.write(corrupt); } },
      { name: "truncated", act: (input) => { input.write('{"id":1'); input.end(); } },
      { name: "clean-eof", act: (input) => { input.end(); } },
    ];
    for (const c of cases) {
      const h = makePeer();
      const pending = h.peer.request("m", {});
      pending.catch(() => {});
      c.act(h.input);
      await tick();
      await tick();
      expect(h.peer.closed).toBe(true);
      expect(h.onFatal).toHaveBeenCalledTimes(1);
      await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      h.input.write("{also bad\n"); // late traffic after closure changes nothing
      await tick();
      expect(h.onFatal).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds pending outbound requests without poisoning the peer", async () => {
    const h = makePeer();
    const pending = Array.from({ length: 8 }, (_, i) => h.peer.request(`m${i}`, {}));
    await expect(h.peer.request("m8", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.closed).toBe(false);
    for (const id of h.lines().map((l) => l.id)) h.input.write(frame({ id, result: true }));
    await expect(Promise.all(pending)).resolves.toHaveLength(8);
    h.peer.close();
  });

  it("holds the next write under backpressure and caps the outgoing queue", async () => {
    const h = makePeer();
    const writeSpy = vi.spyOn(h.output, "write").mockReturnValue(false);
    const first = h.peer.notify("n0", {});
    first.catch(() => {});
    await tick();
    expect(writeSpy).toHaveBeenCalledTimes(1); // admitted; nothing further is written
    const queued: Array<Promise<void>> = [];
    for (let i = 0; i < 16; i += 1) {
      const p = h.peer.notify(`n${i}`, {});
      p.catch(() => {});
      queued.push(p);
    }
    await expect(h.peer.notify("overflow", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.closed).toBe(false);
    writeSpy.mockReturnValue(true);
    h.output.emit("drain");
    await tick();
    await tick();
    await expect(Promise.all([first, ...queued])).resolves.toHaveLength(17);
    expect(writeSpy).toHaveBeenCalledTimes(17);
    h.peer.close();
    writeSpy.mockRestore();
  });

  it("treats an async write error as fatal with the written request unknown", async () => {
    const h = makePeer();
    const writeSpy = vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      if (typeof cb === "function") queueMicrotask(() => (cb as (err: Error) => void)(new Error("boom")));
      return true;
    }) as any);
    const pending = h.peer.request("m", {});
    await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(h.peer.closed).toBe(true);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });

  it("rejects pending work on close instead of succeeding silently", async () => {
    const h = makePeer();
    const written = h.peer.request("m", {});
    h.peer.close("done");
    await expect(written).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(h.peer.request("late", {})).rejects.toMatchObject({ code: "CLOSED" });
    await expect(h.peer.notify("late", {})).rejects.toMatchObject({ code: "CLOSED" });
    await expect(h.peer.respond(0, {})).rejects.toMatchObject({ code: "CLOSED" });
    expect(h.onFatal).not.toHaveBeenCalled();
    h.peer.close("again"); // idempotent
  });

  it("expires a queued request as not-sent but a written timeout as unknown and sticky", async () => {
    const q = makePeer({ timeoutMs: 20 });
    const block = vi.spyOn(q.output, "write").mockReturnValue(false);
    const primer = q.peer.notify("block", {}); // admitted (write false), holds the pump
    primer.catch(() => {});
    await tick();
    await expect(q.peer.request("queued", {})).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(q.peer.closed).toBe(false); // no poison for a frame that never wrote
    expect(q.onFatal).not.toHaveBeenCalled();
    expect(block).toHaveBeenCalledTimes(1);
    block.mockReturnValue(true);
    q.output.emit("drain");
    await tick();
    await tick();
    expect(block).toHaveBeenCalledTimes(1); // the expired frame is never written late
    await primer;
    block.mockRestore();
    const next = q.peer.request("next", {});
    await tick();
    q.input.write(frame({ id: q.lines().at(-1).id, result: 1 }));
    await expect(next).resolves.toBe(1);
    q.peer.close();

    const w = makePeer({ timeoutMs: 20 });
    const first = w.peer.request("first", {});
    const second = w.peer.request("second", {});
    await expect(first).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(second).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(w.peer.closed).toBe(true);
    expect(w.onFatal).toHaveBeenCalledTimes(1);
    w.input.write(frame({ id: "late", result: 1 }));
    await tick();
    expect(w.onFatal).toHaveBeenCalledTimes(1);
  });

  it("treats a result for a queued-unsent request as a fatal protocol fault", async () => {
    const h = makePeer();
    const block = vi.spyOn(h.output, "write").mockReturnValue(false);
    const first = h.peer.request("a", {});
    first.catch(() => {});
    const second = h.peer.request("b", {});
    second.catch(() => {});
    await tick();
    expect(block).toHaveBeenCalledTimes(1); // rpc-2 is still queued, never sent
    h.input.write(frame({ id: "rpc-2", result: "late" }));
    await tick();
    await expect(second).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(first).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(h.peer.closed).toBe(true);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    block.mockReturnValue(true);
    h.output.emit("drain");
    await tick();
    expect(block).toHaveBeenCalledTimes(1); // the queued frame is never written late
    block.mockRestore();
  });

  it("poisons on a duplicate inbound id while its response is still queued", async () => {
    const h = makePeer();
    const block = vi.spyOn(h.output, "write").mockReturnValue(false);
    const primer = h.peer.notify("block", {});
    primer.catch(() => {});
    await tick();
    h.input.write(frame({ id: 0, method: "prompt", params: {} }));
    await tick();
    const answer = h.peer.respond(0, { ok: true }); // queued behind the block
    answer.catch(() => {});
    await expect(h.peer.respond(0, { again: true })).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(block).toHaveBeenCalledTimes(1); // the duplicate answer is never written
    h.input.write(frame({ id: 0, method: "prompt", params: {} }));
    await tick();
    await tick();
    expect(h.requests).toHaveLength(1); // onRequest ran exactly once
    await expect(answer).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.closed).toBe(true);
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    block.mockRestore();

    const g = makePeer(); // legal reuse only after the prior response was sent
    g.input.write(frame({ id: 0, method: "prompt" }));
    await tick();
    await g.peer.respond(0, 1);
    g.input.write(frame({ id: 0, method: "prompt" }));
    await tick();
    expect(g.requests).toHaveLength(2);
    expect(g.peer.closed).toBe(false);
    await g.peer.respond(0, 2);
    g.peer.close();
  });

  it("passes coalesced frames above the bound with a split prefix, fails oversize tails", async () => {
    const h = makePeer();
    const pad = "x".repeat(900);
    const total = 1200; // coalesced total exceeds 1MiB; each frame is valid alone
    const frames = Array.from({ length: total }, (_, i) => frame({ method: "tick", params: { i, pad } }));
    const head = Buffer.from(frames[0], "utf8");
    const cut = Math.floor(head.length / 2);
    h.input.write(head.subarray(0, cut));
    await tick();
    h.input.write(Buffer.concat([head.subarray(cut), ...frames.slice(1).map((f) => Buffer.from(f, "utf8"))]));
    await tick();
    await tick();
    expect(h.notifications).toHaveLength(total);
    expect(h.peer.closed).toBe(false);
    h.peer.close();

    const g = makePeer(); // exact-bound frame passes, one byte more fails
    const probe = JSON.stringify({ method: "m", params: { pad: "" } });
    const exact = MAX_FRAME_BYTES - 1 - probe.length;
    expect(exact).toBeGreaterThan(0);
    g.input.write(`${JSON.stringify({ method: "m", params: { pad: "x".repeat(exact) } })}\n`);
    await tick();
    expect(g.notifications).toHaveLength(1);
    expect(g.peer.closed).toBe(false);
    g.input.write(`${JSON.stringify({ method: "m", params: { pad: "x".repeat(exact + 1) } })}\n`);
    await tick();
    await tick();
    expect(g.peer.closed).toBe(true);
    expect(g.onFatal).toHaveBeenCalledTimes(1);

    const over = makePeer(); // oversize incomplete tail fails with a prefix carried
    over.input.write(Buffer.from('{"method":"p', "utf8"));
    await tick();
    over.input.write(Buffer.alloc(MAX_FRAME_BYTES, 0x61));
    await tick();
    await tick();
    expect(over.peer.closed).toBe(true);
    expect(over.onFatal).toHaveBeenCalledTimes(1);
  });

  it("writes each frame once when a server request arrives reentrantly during write", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onFatal = vi.fn();
    const seen: unknown[] = [];
    const origWrite = output.write.bind(output);
    let peer!: ReturnType<typeof createNativeRpc>;
    let nested = false;
    const answers: Array<Promise<void>> = [];
    const writeSpy = vi.spyOn(output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      seen.push(JSON.parse(Buffer.from(chunk as Uint8Array).toString("utf8")));
      if (!nested) {
        nested = true;
        // Synchronous reentry during the first write: a nested server
        // request answered from onRequest, then the native result.
        input.emit("data", Buffer.from(frame({ id: 0, method: "approve", params: {} }), "utf8"));
        input.emit("data", Buffer.from(frame({ id: "rpc-1", result: {} }), "utf8"));
      }
      return (origWrite as any)(chunk, cb);
    }) as any);
    peer = createNativeRpc({
      input,
      output,
      onRequest: (msg) => { answers.push(peer.respond((msg as { id: number }).id, { decision: "decline" })); },
      onFatal,
    });
    const pending = peer.request("turn/start", {});
    await expect(pending).resolves.toEqual({});
    await expect(Promise.all(answers)).resolves.toHaveLength(1);
    await tick();
    expect(seen).toEqual([
      { id: "rpc-1", method: "turn/start", params: {} },
      { id: 0, result: { decision: "decline" } },
    ]);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(peer.closed).toBe(false);
    expect(onFatal).not.toHaveBeenCalled();
    peer.close();
    writeSpy.mockRestore();
  });

  it("rejects malformed request options or signals as not-sent without allocating", async () => {
    const h = makePeer();
    const bad: unknown[] = [null, 42, "x", [], { signal: null }, { signal: {} }, { signal: { aborted: false } }];
    for (const options of bad) {
      await expect(h.peer.request("m", {}, options as never)).rejects.toMatchObject({ code: "NOT_SENT" });
    }
    expect(h.peer.closed).toBe(false);
    expect(h.lines()).toHaveLength(0);
    const pending = Array.from({ length: 8 }, (_, i) => h.peer.request(`ok${i}`, {}));
    await tick();
    expect(h.lines()).toHaveLength(8); // pending/queue capacity retained
    for (const l of h.lines()) h.input.write(frame({ id: l.id, result: true }));
    await expect(Promise.all(pending)).resolves.toHaveLength(8);
    h.peer.close();
  });

  it("refuses a pre-aborted signal with no write and capacity retained", async () => {
    const h = makePeer();
    const controller = new AbortController();
    controller.abort();
    await expect(h.peer.request("turn/steer", { answer: "yes" }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.lines()).toHaveLength(0);
    expect(h.peer.closed).toBe(false);
    const next = h.peer.request("next", {});
    await tick();
    expect(h.lines()).toHaveLength(1);
    h.input.write(frame({ id: h.lines()[0].id, result: "ok" }));
    await expect(next).resolves.toBe("ok");
    h.peer.close();
  });

  it("aborts a queued steer behind backpressure and drains unrelated frames", async () => {
    const h = makePeer();
    const origWrite = h.output.write.bind(h.output);
    let hold = true;
    const writeSpy = vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      if (hold) {
        // Accepted by the transport but backpressured: capture bytes via the
        // real write path, then report false so the pump waits for drain.
        (origWrite as any)(chunk, cb);
        return false;
      }
      return (origWrite as any)(chunk, cb);
    }) as any);
    const primer = h.peer.notify("block", {});
    primer.catch(() => {});
    await tick();
    const controller = new AbortController();
    const steer = h.peer.request("turn/steer", { answer: "yes" }, { signal: controller.signal });
    steer.catch(() => {});
    const later = h.peer.request("turn/poll", {});
    await tick();
    controller.abort();
    await expect(steer).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(h.peer.closed).toBe(false);
    expect(h.onFatal).not.toHaveBeenCalled();
    hold = false;
    h.output.emit("drain");
    await tick();
    await tick();
    const methods = h.lines().map((l) => l.method ?? "(response)");
    expect(methods).toContain("block");
    expect(methods).toContain("turn/poll");
    expect(methods).not.toContain("turn/steer"); // never written late
    await primer;
    const pollId = h.lines().find((l) => l.method === "turn/poll").id;
    h.input.write(frame({ id: pollId, result: "polled" }));
    await expect(later).resolves.toBe("polled");
    const healthy = h.peer.request("after", {});
    await tick();
    h.input.write(frame({ id: h.lines().at(-1).id, result: 1 }));
    await expect(healthy).resolves.toBe(1);
    writeSpy.mockRestore();
    h.peer.close();
  });

  it("ignores an abort once the request is written and keeps the native result", async () => {
    const h = makePeer();
    const controller = new AbortController();
    const pending = h.peer.request("turn/steer", {}, { signal: controller.signal });
    await tick();
    expect(h.lines()).toHaveLength(1);
    controller.abort();
    await tick();
    expect(h.peer.closed).toBe(false);
    h.input.write(frame({ id: h.lines()[0].id, result: "done" }));
    await expect(pending).resolves.toBe("done");
    h.peer.close();
  });

  it("treats an abort synchronously inside write as already written", async () => {
    const h = makePeer();
    const origWrite = h.output.write.bind(h.output);
    const controller = new AbortController();
    const writeSpy = vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      controller.abort(); // fires during dispatch, after ownership is claimed
      return (origWrite as any)(chunk, cb);
    }) as any);
    const pending = h.peer.request("m", {}, { signal: controller.signal });
    await tick();
    writeSpy.mockRestore();
    expect(h.lines()).toHaveLength(1);
    h.input.write(frame({ id: h.lines()[0].id, result: 1 }));
    await expect(pending).resolves.toBe(1);
    expect(h.peer.closed).toBe(false);
    h.peer.close();
  });

  it("settles a queued abort exactly once against close and deadline", async () => {
    const h = makePeer();
    const block = vi.spyOn(h.output, "write").mockReturnValue(false);
    const primer = h.peer.notify("block", {});
    primer.catch(() => {});
    await tick();
    const controller = new AbortController();
    const steer = h.peer.request("turn/steer", {}, { signal: controller.signal });
    steer.catch(() => {});
    controller.abort();
    h.peer.close("owner");
    await expect(steer).rejects.toMatchObject({ code: "NOT_SENT" });
    // The primer was already handed to output.write (false still means
    // accepted), so its notify already resolved correctly.
    await primer;
    expect(h.onFatal).not.toHaveBeenCalled();
    block.mockRestore();

    const q = makePeer({ timeoutMs: 20 });
    const hold = vi.spyOn(q.output, "write").mockReturnValue(false);
    const first = q.peer.notify("block", {});
    first.catch(() => {});
    await tick();
    const qc = new AbortController();
    const queued = q.peer.request("queued", {}, { signal: qc.signal });
    queued.catch(() => {});
    qc.abort(); // wins before the 20ms queued expiry
    await expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
    await new Promise((r) => setTimeout(r, 60)); // past expiry: no second settle
    expect(q.peer.closed).toBe(false);
    expect(q.onFatal).not.toHaveBeenCalled();
    hold.mockRestore();
    q.peer.close();
  });

  it("detaches the abort listener on every settle path", async () => {
    const tracked = () => {
      const c = new AbortController();
      const add = vi.spyOn(c.signal, "addEventListener");
      const remove = vi.spyOn(c.signal, "removeEventListener");
      return { c, add, remove };
    };
    const detached = (t: { add: { mock: { calls: unknown[][] } }; remove: ReturnType<typeof vi.fn> }) => {
      expect(t.add.mock.calls).toHaveLength(1);
      expect(t.remove).toHaveBeenCalledWith("abort", t.add.mock.calls[0][1]);
    };
    // Completion through dispatch.
    {
      const h = makePeer();
      const t = tracked();
      const pending = h.peer.request("m", {}, { signal: t.c.signal });
      await tick();
      h.input.write(frame({ id: h.lines()[0].id, result: 1 }));
      await expect(pending).resolves.toBe(1);
      detached(t);
      h.peer.close();
    }
    // Remote error.
    {
      const h = makePeer();
      const t = tracked();
      const pending = h.peer.request("m", {}, { signal: t.c.signal });
      await tick();
      h.input.write(frame({ id: h.lines()[0].id, error: { code: -1, message: "no" } }));
      await expect(pending).rejects.toMatchObject({ code: "REMOTE_ERROR" });
      detached(t);
      h.peer.close();
    }
    // Queued expiry.
    {
      const h = makePeer({ timeoutMs: 20 });
      const hold = vi.spyOn(h.output, "write").mockReturnValue(false);
      const first = h.peer.notify("block", {});
      first.catch(() => {});
      await tick();
      const t = tracked();
      const queued = h.peer.request("q", {}, { signal: t.c.signal });
      queued.catch(() => {});
      await expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
      detached(t);
      expect(h.peer.closed).toBe(false);
      hold.mockRestore();
      h.peer.close();
    }
    // Owner close with a queued request.
    {
      const h = makePeer();
      const hold = vi.spyOn(h.output, "write").mockReturnValue(false);
      const first = h.peer.notify("block", {});
      first.catch(() => {});
      await tick();
      const t = tracked();
      const queued = h.peer.request("q", {}, { signal: t.c.signal });
      queued.catch(() => {});
      h.peer.close("owner");
      await expect(queued).rejects.toMatchObject({ code: "NOT_SENT" }); // never written
      detached(t);
      hold.mockRestore();
    }
    // Fatal with a written request.
    {
      const h = makePeer();
      const t = tracked();
      const pending = h.peer.request("m", {}, { signal: t.c.signal });
      pending.catch(() => {});
      await tick();
      h.input.write("{bad\n");
      await tick();
      await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      detached(t);
    }
    // Queued abort itself.
    {
      const h = makePeer();
      const hold = vi.spyOn(h.output, "write").mockReturnValue(false);
      const first = h.peer.notify("block", {});
      first.catch(() => {});
      await tick();
      const t = tracked();
      const queued = h.peer.request("q", {}, { signal: t.c.signal });
      queued.catch(() => {});
      t.c.abort();
      await expect(queued).rejects.toMatchObject({ code: "NOT_SENT" });
      detached(t);
      hold.mockRestore();
      h.peer.close();
    }
  });

  it("writes nothing further when close runs synchronously during write", async () => {
    const h = makePeer();
    const origWrite = h.output.write.bind(h.output);
    let closed = false;
    const writeSpy = vi.spyOn(h.output, "write").mockImplementation(((chunk: unknown, cb: unknown) => {
      if (!closed) {
        closed = true;
        h.peer.close("owner");
      }
      return (origWrite as any)(chunk, cb);
    }) as any);
    const first = h.peer.request("a", {});
    first.catch(() => {});
    await tick();
    await expect(first).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); // handed over before the close
    await expect(h.peer.notify("b", {})).rejects.toMatchObject({ code: "CLOSED" });
    expect(writeSpy).toHaveBeenCalledTimes(1); // no writes after closure
    expect(h.peer.closed).toBe(true);
    expect(h.onFatal).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
