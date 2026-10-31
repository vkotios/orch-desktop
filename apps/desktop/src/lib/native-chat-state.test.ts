import { describe, expect, it } from "vitest";
import type { NativeOutcomeKind, NativePollEvent, NativeSendAck } from "./api";
import { applyNativeAck, applyNativePollBatch, applyNativeUiEvent, beginNativeTurn,
  createNativeUiSession, failNativeTurn, markNativeCancelling, markNativeUnavailable } from "./native-chat-state";

const generation = "g1";
const event = (kind: NativePollEvent["kind"], extra: Partial<NativePollEvent> = {}): NativePollEvent =>
  ({ generation, sessionId: "s1", turnId: "t1", kind, ...extra });
const ack = (extra: Partial<NativeSendAck> = {}): NativeSendAck =>
  ({ generation, sessionId: "s1", turnId: "t1", nativeThreadId: "thread", nativeTurnId: "turn", ...extra });
const started = () => beginNativeTurn(createNativeUiSession("s1", "model"), "t1", "hello");

describe("native conversation state", () => {
  it("keeps one native thread across two terminal turns", () => {
    let s = applyNativeAck(started(), ack(), generation);
    s = applyNativeUiEvent(s, event("turn_complete", { nativeOutcome: "completed", nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    s = beginNativeTurn(s, "t2", "again");
    expect(s.nativeTurnId).toBeNull();
    s = applyNativeAck(s, ack({ turnId: "t2", nativeTurnId: "turn2" }), generation);
    expect(s.threadStarted).toBe(true);
    expect(s.nativeThreadId).toBe("thread");
    expect(s.nativeTurnId).toBe("turn2");
  });

  it.each<[NativeOutcomeKind, NativePollEvent["kind"]]>([
    ["completed", "turn_complete"], ["failed", "error"],
    ["interrupted", "status"], ["unknown", "error"],
  ])("finishes %s without losing partial content", (outcome, kind) => {
    let s = applyNativeUiEvent(started(), event("message_delta", { text: "partial" }), generation);
    s = applyNativeUiEvent(s, event("approval", { approvalId: "a", approvalType: "command", decisions: ["decline"] }), generation);
    s = markNativeCancelling(s);
    s = applyNativeUiEvent(s, event(kind, { nativeOutcome: outcome, text: "reason" }), generation);
    expect(s.busy).toBe(false);
    expect(s.cancelling).toBe(false);
    expect(s.approvals).toEqual([]);
    expect(s.messages[1]).toMatchObject({ text: "partial", outcome, isStreaming: false });
    expect(s.unavailable).toBe(outcome === "unknown");
  });

  it("keeps a diagnostic error pending and does not fabricate tool ids", () => {
    let s = applyNativeUiEvent(started(), event("error", { text: "stopping" }), generation);
    s = applyNativeUiEvent(s, event("tool_call", { toolTitle: "tool" }), generation);
    expect(s.busy).toBe(true);
    expect(s.messages[1]).toMatchObject({ statusText: "stopping", isStreaming: true, tools: [] });
  });

  it("binds an early delta and rejects a conflicting acknowledgement", () => {
    let s = applyNativeUiEvent(started(), event("message_delta", { text: "early", nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    expect(s.threadStarted).toBe(true);
    s = applyNativeAck(s, ack({ nativeTurnId: "other" }), generation);
    expect(s.unavailable).toBe(true);
    expect(s.messages[1]).toMatchObject({ text: "early", outcome: "unknown", isStreaming: false });
    expect(beginNativeTurn(s, "t2", "again")).toBe(s);
  });

  it("validates a late ACK after terminal without resurrecting the turn", () => {
    const terminal = applyNativeUiEvent(started(), event("turn_complete", { nativeOutcome: "completed", nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    const valid = applyNativeAck(terminal, ack(), generation);
    expect(valid).toMatchObject({ threadStarted: true, busy: false, activeTurnId: null, unavailable: false });
    const bad = applyNativeAck(terminal, ack({ nativeTurnId: "other" }), generation);
    expect(bad.unavailable).toBe(true);
    expect(bad.messages[1].outcome).toBe("unknown");
  });

  it("ignores stale generations and turns, including approval resolution", () => {
    let s = applyNativeUiEvent(started(), event("approval", { approvalId: "a", approvalType: "command", decisions: [] }), generation);
    expect(s.approvals[0].decisions).toEqual([]);
    expect(applyNativeAck(s, ack({ generation: "old" }), generation)).toBe(s);
    expect(applyNativePollBatch([s], generation, [event("message_delta", { generation: "old", text: "bad" })]).sessions[0]).toBe(s);
    s = applyNativeUiEvent(s, event("approval_resolved", { turnId: "old", approvalId: "a" }), generation);
    expect(s.approvals).toHaveLength(1);
    s = applyNativeUiEvent(s, event("approval_resolved", { approvalId: "a" }), generation);
    expect(s.approvals).toHaveLength(0);
  });

  it("marks local failure, host loss and cancellation truthfully", () => {
    const cancelling = markNativeCancelling(started());
    expect(cancelling).toMatchObject({ busy: true, cancelling: true });
    const failed = failNativeTurn(cancelling, "t1", "not sent", "failed");
    expect(failed).toMatchObject({ busy: false, unavailable: false });
    const lost = markNativeUnavailable(started(), "host lost");
    expect(lost).toMatchObject({ busy: false, unavailable: true });
    expect(lost.messages[1]).toMatchObject({ outcome: "unknown", isStreaming: false });
    expect(beginNativeTurn(lost, "t2", "again")).toBe(lost);
  });
});
