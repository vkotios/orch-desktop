import { describe, expect, it } from "vitest";
import { normalizeClaudeStreamEvent, type ClaudeStreamContext } from "./index";

const ctx: ClaudeStreamContext = { sessionId: "session-1", userMessageId: "user-1", messageId: "message-1", toolUseIds: new Set(["tool-1", "tool-2"]) };
const correlated = { session_id: "session-1", user_message_uuid: "user-1", user_message_uuids: ["user-1"], parent_tool_use_id: null };
const delta = { ...correlated, type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } };
const result = { ...correlated, type: "result", subtype: "success", is_error: false, terminal_reason: "completed", uuid: "result-not-turn" };
const map = (raw: unknown, context: ClaudeStreamContext = ctx) => normalizeClaudeStreamEvent("ui-1", context, raw);

describe("Claude stream normalization", () => {
  it("emits a correlated text delta without inventing provider identity", () => {
    const events = map(delta);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ harness: "claude", sessionId: "ui-1", kind: "message_delta", text: "Hello", nativeSessionId: "session-1", nativeUserMessageId: "user-1", nativeMessageId: "message-1" });
    expect(events[0]).not.toHaveProperty("raw");
    expect(events[0]).not.toHaveProperty("nativeTurnId");
    expect(map(delta, { sessionId: "session-1", userMessageId: "user-1" })[0]).not.toHaveProperty("nativeMessageId");
  });

  it.each([
    { session_id: undefined }, { session_id: "other" },
    { user_message_uuid: undefined }, { user_message_uuid: "other" },
    { user_message_uuids: undefined }, { user_message_uuids: [] },
    { user_message_uuids: ["user-1", "other"] }, { user_message_uuids: ["other"] },
    { parent_tool_use_id: "parent-tool" },
  ])("rejects wrong, missing or non-singleton correlation %#", (override) => {
    expect(map({ ...delta, ...override })).toEqual([]);
    expect(map({ ...result, ...override })).toEqual([]);
    expect(map({ ...correlated, ...override, type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "x", name: "Read" }] } })).toEqual([]);
  });

  it("ignores final assistant text and emits only actual valid tool uses", () => {
    const events = map({ ...correlated, type: "assistant", message: { id: "assistant-1", content: [
      { type: "text", text: "already streamed" }, { type: "tool_use", id: "tool-1", name: "Read" },
      { type: "tool_use", name: "Write" }, { type: "tool_use", id: "tool-2", name: "" },
    ] } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_call", toolCallId: "tool-1", toolTitle: "Read", toolStatus: "inProgress", nativeMessageId: "assistant-1" });
    expect(events.some((e) => e.kind === "message_delta" || e.kind === "model_verified")).toBe(false);
    expect(map({ ...correlated, type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Read" }] } })).toEqual([]);
  });

  it("accepts only known tool results and recognizes the native denial metadata array", () => {
    const raw = { type: "user", session_id: "session-1", parent_tool_use_id: null,
      message: { content: [
        { type: "tool_result", tool_use_id: "tool-1", is_error: true },
        { type: "tool_result", tool_use_id: "tool-2", is_error: true },
        { type: "tool_result", tool_use_id: "foreign", is_error: false },
      ] }, tool_result_meta: [{ id: "tool-1", non_execution_kind: "user-rejected" }] };
    expect(map(raw)).toEqual([
      expect.objectContaining({ kind: "tool_result", toolCallId: "tool-1", toolStatus: "declined" }),
      expect.objectContaining({ kind: "tool_result", toolCallId: "tool-2", toolStatus: "failed" }),
    ]);
    expect(map({ ...raw, session_id: undefined })).toEqual([]);
    expect(map({ ...raw, user_message_uuid: "other" })).toEqual([]);
    expect(map({ ...raw, parent_tool_use_id: "parent" })).toEqual([]);
    expect(map(raw, { sessionId: "session-1", userMessageId: "user-1" })).toEqual([]);
  });

  it("does not infer denial from result text or malformed metadata", () => {
    const raw = { type: "user", session_id: "session-1", message: { content: [
      { type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "user rejected" },
      { type: "tool_result", tool_use_id: "tool-2", is_error: "yes" },
    ] }, tool_result_meta: { id: "tool-1", non_execution_kind: "user-rejected" } };
    expect(map(raw)).toEqual([expect.objectContaining({ kind: "tool_result", toolCallId: "tool-1", toolStatus: "failed" })]);
    expect(map({ ...raw, message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } })[0]).toMatchObject({ toolStatus: "completed" });
  });

  it.each(["aborted_streaming", "aborted_tools"])("treats %s as interrupted even when is_error is true", (reason) => {
    expect(map({ ...result, terminal_reason: reason, is_error: true })[0]).toMatchObject({ kind: "status", nativeOutcome: "interrupted", text: "turn interrupted" });
  });

  it("requires explicit successful completion and leaves unknown non-error outcomes unresolved", () => {
    const complete = map(result);
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ kind: "turn_complete", nativeOutcome: "completed" });
    expect(complete[0]).not.toHaveProperty("nativeTurnId");
    expect(map({ ...result, terminal_reason: "unexpected" })).toEqual([]);
    expect(map({ ...result, subtype: "other" })).toEqual([]);
    expect(map({ ...result, is_error: undefined })).toEqual([]);
  });

  it("reports bounded failure text, with fallbacks", () => {
    const failure = map({ ...result, terminal_reason: "error", is_error: true, errors: ["", "x".repeat(250)], result: "fallback" });
    expect(failure[0]).toMatchObject({ kind: "error", nativeOutcome: "failed" });
    expect(failure[0].text).toBe("x".repeat(200));
    expect(map({ ...result, terminal_reason: "error", is_error: true, errors: [], result: "fallback" })[0].text).toBe("fallback");
    expect(map({ ...result, terminal_reason: "error", is_error: true })[0].text).toBe("Claude turn failed");
  });

  it("ignores malformed frames and unrelated stream blocks", () => {
    for (const raw of [null, [], "text", { ...delta, event: null }, { ...delta, event: { type: "content_block_delta", delta: { type: "text_delta", text: 1 } } }, { ...delta, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } } }]) {
      expect(map(raw)).toEqual([]);
    }
    expect(normalizeClaudeStreamEvent("", ctx, delta)).toEqual([]);
    expect(map(delta, { sessionId: "", userMessageId: "user-1" })).toEqual([]);
  });
});
