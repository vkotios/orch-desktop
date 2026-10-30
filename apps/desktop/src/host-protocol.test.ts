import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeFrame,
  encodeFrame,
  validateEnvelope,
  type HostEnvelope,
} from "../server/protocol.mjs";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../server/host-wire-fixtures.json", import.meta.url)), "utf-8"),
) as { schemaVersion: number; cases: Array<{ name: string; field: string; value: string; repeat: number; valid: boolean }> };

const GEN = "gen-1";
const asEnvelope = (value: unknown): HostEnvelope => value as HostEnvelope;
const bad = (fn: () => unknown, code: string, label = "") => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code, label).toBe(code);
    return;
  }
  expect.unreachable(`expected ProtocolError ${code} (${label})`);
};

const request = { v: 1, type: "request", requestId: "r-1", generation: GEN, command: "orch_run", args: { wp: "X" } };
const result = { v: 1, type: "result", requestId: "r-1", generation: GEN, result: { id: "run-1" } };
const failure = { v: 1, type: "error", requestId: "r-1", generation: GEN, error: { code: "HOST_GONE", message: "dead" } };
const events = (["ready", "stream", "stopping"] as const).map((event) => ({
  v: 1, type: "event", requestId: null, generation: GEN, event, payload: { kind: "status" },
}));

describe("host wire protocol", () => {
  it("exposes version 1 with a 1MiB frame bound", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("round-trips all envelope types through one LF-terminated frame", () => {
    for (const env of [request, result, failure, ...events]) {
      const frame = encodeFrame(asEnvelope(env));
      expect(frame.endsWith("\n")).toBe(true);
      expect(frame.slice(0, -1)).not.toContain("\n");
      expect(decodeFrame(frame)).toEqual(env);
    }
  });

  it("keeps falsy results distinct from errors", () => {
    for (const value of [false, 0, "", null]) {
      const frame = encodeFrame(asEnvelope({ ...result, result: value }));
      const back = decodeFrame(frame);
      expect(back.type).toBe("result");
      expect((back as { result: unknown }).result).toBe(value);
    }
  });

  it("enforces the byte bound exactly, counting multibyte chars", () => {
    const fixed = encodeFrame(asEnvelope({ ...result, result: "" })).length;
    const pad = MAX_FRAME_BYTES - fixed;
    const exact = encodeFrame(asEnvelope({ ...result, result: "a".repeat(pad) }));
    expect(new TextEncoder().encode(exact).length).toBe(MAX_FRAME_BYTES);
    expect(decodeFrame(exact).type).toBe("result");
    bad(() => encodeFrame(asEnvelope({ ...result, result: "a".repeat(pad + 1) })), "MESSAGE_TOO_LARGE");
    bad(() => encodeFrame(asEnvelope({ ...result, result: "é".repeat(pad) })), "MESSAGE_TOO_LARGE");
    bad(() => decodeFrame(`"x"${"y".repeat(MAX_FRAME_BYTES)}\n`), "MESSAGE_TOO_LARGE");
  });

  it("rejects malformed, truncated and multiple frames", () => {
    bad(() => decodeFrame("not json\n"), "INVALID_JSON");
    bad(() => decodeFrame(""), "INVALID_JSON");
    const frame = encodeFrame(asEnvelope(request));
    bad(() => decodeFrame(frame.slice(0, frame.length - 5)), "INVALID_JSON");
    bad(() => decodeFrame(frame + frame), "INVALID_ENVELOPE");
    bad(() => decodeFrame(frame.slice(0, -1) + "\n" + frame), "INVALID_ENVELOPE");
    bad(() => decodeFrame(42 as unknown as string), "INVALID_ENVELOPE");
  });

  it("rejects unknown version, type and event explicitly", () => {
    bad(() => decodeFrame(JSON.stringify({ ...request, v: 2 }) + "\n"), "UNSUPPORTED_VERSION");
    bad(() => decodeFrame(JSON.stringify({ ...request, type: "reply" }) + "\n"), "INVALID_ENVELOPE");
    bad(() => decodeFrame(JSON.stringify({ ...events[0], event: "explode" }) + "\n"), "INVALID_ENVELOPE");
  });

  it("rejects missing and invalid fields", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["generation", { ...request, generation: "" }],
      ["generation", { ...request, generation: "g".repeat(129) }],
      ["requestId", { ...request, requestId: "" }],
      ["requestId", { ...request, requestId: "r".repeat(129) }],
      ["requestId", { ...request, requestId: null }],
      ["command", { ...request, command: "Bad-Name" }],
      ["command", { ...request, command: "9starts_digit" }],
      ["command", { ...request, command: "a".repeat(81) }],
      ["args", { ...request, args: [] }],
      ["args", { ...request, args: null }],
      ["error", { ...failure, error: { code: "", message: "m" } }],
      ["error", { ...failure, error: { code: "E", message: 7 } }],
      ["payload", { ...events[1], payload: [] }],
      ["event-id", { ...events[1], requestId: 7 }],
    ];
    for (const [label, env] of cases) {
      bad(() => encodeFrame(asEnvelope(env)), "INVALID_ENVELOPE", label);
    }
    bad(() => decodeFrame("{}\n"), "UNSUPPORTED_VERSION");
    // Unsolicited events may carry null; solicited events may carry an id.
    expect(decodeFrame(encodeFrame(asEnvelope({ ...events[0], requestId: "r-9" })))).toMatchObject({ requestId: "r-9" });
  });

  it("rejects stale generation and mismatched correlation, never reassociating", () => {
    const frame = encodeFrame(asEnvelope(request));
    bad(() => decodeFrame(frame, { generation: "gen-2" }), "STALE_GENERATION");
    bad(() => decodeFrame(frame, { requestId: "r-2" }), "CORRELATION_MISMATCH");
    bad(() => decodeFrame(encodeFrame(asEnvelope(events[0])), { requestId: "r-1" }), "CORRELATION_MISMATCH");
    expect(decodeFrame(frame, { generation: GEN, requestId: "r-1" })).toEqual(request);
  });

  it("enforces the canonical frame bound in direct validation", () => {
    const fixed = encodeFrame(asEnvelope({ ...result, result: "" })).length;
    const pad = MAX_FRAME_BYTES - fixed;
    const exact = { ...result, result: "a".repeat(pad) };
    expect(validateEnvelope(asEnvelope(exact))).toEqual(exact);
    bad(() => validateEnvelope(asEnvelope({ ...result, result: "a".repeat(pad + 1) })), "MESSAGE_TOO_LARGE", "one over");
    bad(() => validateEnvelope(asEnvelope({ ...result, result: "x".repeat(MAX_FRAME_BYTES + 1) })), "MESSAGE_TOO_LARGE", "huge");
  });

  it("applies the canonical bound to LF-less decoding", () => {
    const fixed = encodeFrame(asEnvelope({ ...result, result: "" })).length;
    const pad = MAX_FRAME_BYTES - fixed;
    const exactFrame = encodeFrame(asEnvelope({ ...result, result: "a".repeat(pad) }));
    expect(new TextEncoder().encode(exactFrame).length).toBe(MAX_FRAME_BYTES);
    expect(decodeFrame(exactFrame.slice(0, -1))).toEqual({ ...result, result: "a".repeat(pad) });
    bad(() => decodeFrame(JSON.stringify({ ...result, result: "a".repeat(pad + 1) })), "MESSAGE_TOO_LARGE", "no LF one over");
  });

  it("bounds JSON nesting depth and never throws RangeError", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    // Convention: the envelope root is depth 1, so a result payload may
    // nest at most MAX_JSON_DEPTH - 1 arrays/objects.
    const nestArrays = (levels: number): unknown => {
      let value: unknown = 0;
      for (let i = 0; i < levels; i += 1) value = [value];
      return value;
    };
    const atLimit = { ...result, result: nestArrays(MAX_JSON_DEPTH - 1) };
    expect(validateEnvelope(asEnvelope(atLimit)).type).toBe("result");
    expect(decodeFrame(encodeFrame(asEnvelope(atLimit)))).toEqual(atLimit);
    bad(() => validateEnvelope(asEnvelope({ ...result, result: nestArrays(MAX_JSON_DEPTH) })), "INVALID_ENVELOPE", "one over");
    bad(() => encodeFrame(asEnvelope({ ...result, result: nestArrays(6000) })), "INVALID_ENVELOPE", "encode deep");
    const deep = `{"v":1,"type":"result","requestId":"r-1","generation":"${GEN}","result":${"[".repeat(6000)}0${"]".repeat(6000)}}\n`;
    expect(deep.endsWith("]}\n")).toBe(true);
    bad(() => decodeFrame(deep), "INVALID_ENVELOPE", "decode deep");
  });

  it("fixture-driven ID and errorCode bounds match UTF-16 semantics", () => {
    for (const c of FIXTURE.cases) {
      const repeated = c.value.repeat(c.repeat);
      const env: Record<string, unknown> = {
        v: 1, type: "error", generation: "gen-1", requestId: "r1",
        error: { code: "E", message: "test" },
      };
      if (c.field === "generation") env.generation = repeated;
      else if (c.field === "requestId") env.requestId = repeated;
      else (env.error as Record<string, unknown>).code = repeated;
      if (c.valid) {
        expect(() => validateEnvelope(asEnvelope(env)), c.name).not.toThrow();
      } else {
        bad(() => validateEnvelope(asEnvelope(env)), "INVALID_ENVELOPE", c.name);
      }
    }
  });

  it("accepts v:1.0 and rejects non-numeric v", () => {
    expect(decodeFrame(JSON.stringify({ ...request, v: 1.0 }) + "\n").type).toBe("request");
    bad(() => decodeFrame(JSON.stringify({ ...request, v: true }) + "\n"), "UNSUPPORTED_VERSION");
    bad(() => decodeFrame(JSON.stringify({ ...request, v: "1" }) + "\n"), "UNSUPPORTED_VERSION");
  });

  it("rejects event without requestId field, accepts explicit null", () => {
    const { requestId: _, ...noRid } = events[0];
    bad(() => decodeFrame(JSON.stringify(noRid) + "\n"), "INVALID_ENVELOPE");
    expect(decodeFrame(JSON.stringify({ ...events[0], requestId: null }) + "\n").type).toBe("event");
  });

  it("rejects values JSON would silently drop or coerce", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const badResults: unknown[] = [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 0, BigInt(1), Symbol("s"), cyclic];
    for (const value of badResults) {
      bad(() => encodeFrame(asEnvelope({ ...result, result: value })), "INVALID_ENVELOPE");
    }
    bad(() => encodeFrame(asEnvelope({ ...request, args: { f: (() => 0) as unknown } })), "INVALID_ENVELOPE");
  });
});
