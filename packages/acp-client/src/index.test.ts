import { describe, expect, it } from "vitest";
import {
  encodeNdjsonFrame,
  NdjsonFrameDecoder,
  normalizeHarnessEvent,
} from "./index";

describe("ACP NDJSON framing", () => {
  it("encodes valid JSON-RPC frames with trailing newline", () => {
    const frame = encodeNdjsonFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame.trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
  });

  it("decodes chunked and multi-line NDJSON frames", () => {
    const decoder = new NdjsonFrameDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":1')).toEqual([]);
    const frames = decoder.push(',"result":{"ok":true}}\n{"jsonrpc":"2.0","method":"session/update"}\n');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });
});

describe("normalizeHarnessEvent", () => {
  it("normalizes Claude and Grok stream-json assistant and result events", () => {
    const assistantEvents = normalizeHarnessEvent("claude", "s1", {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-5",
        content: [
          { type: "thinking", thinking: "Checking files..." },
          { type: "text", text: "Hello from Claude CLI" },
        ],
      },
    });
    expect(assistantEvents.map((e) => e.kind)).toEqual([
      "model_verified",
      "thought_delta",
      "message_delta",
    ]);
  });

  it("normalizes Grok ACP session/update chunks", () => {
    const events = normalizeHarnessEvent("grok", "s2", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from Grok ACP" },
        },
      },
    });
    expect(events).toEqual([
      {
        harness: "grok",
        sessionId: "s2",
        kind: "message_delta",
        text: "Hello from Grok ACP",
        raw: expect.any(Object),
      },
    ]);
  });

  it("normalizes Codex item.completed and turn.completed events", () => {
    const events = normalizeHarnessEvent("codex", "s3", {
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Hello from Codex CLI" },
    });
    expect(events[0]?.text).toBe("Hello from Codex CLI");
  });
});
