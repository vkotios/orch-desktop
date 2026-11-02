import { describe, expect, it } from "vitest";
import type { NativeClaudeSendAck, NativeClarificationAck, NativeCodexSendAck, NativeOutcomeKind, NativePollEvent } from "./api";
import { applyNativeAck, applyNativeClarificationAck, applyNativePollBatch, applyNativeUiEvent, beginNativeTurn,
  createNativeUiSession, failNativeTurn, markNativeCancelling, markNativeUnavailable, markNativeClarificationAnswering, resetNativeClarificationAnswering } from "./native-chat-state";

const generation = "g1";
const event = (kind: NativePollEvent["kind"], extra: Partial<NativePollEvent> = {}): NativePollEvent =>
  ({ generation, sessionId: "s1", turnId: "t1", kind, ...extra });
const ack = (extra: Partial<NativeCodexSendAck> = {}): NativeCodexSendAck =>
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

describe("native clarifications", () => {
  const questions = [{ id: "q1", header: "Choice", question: "Which?", options: [{ label: "A", description: "First" }], multiSelect: false, isOther: true }];
  const prompt = (extra: Partial<NativePollEvent> = {}) => event("clarification", {
    clarificationId: "c1", nativeItemId: "item-1", isBlocking: true, questions, ...extra,
  });
  const answerAck = (extra: Partial<NativeClarificationAck> = {}): NativeClarificationAck => ({
    generation, controller: "codex", sessionId: "s1", turnId: "t1", clarificationId: "c1", queued: true, ...extra,
  });
  const claude = () => beginNativeTurn(createNativeUiSession("s1", "model", "review", "medium", "claude"), "t1", "hello");

  it("keeps queue acknowledgement separate from answer submission and turn completion", () => {
    let s = applyNativeUiEvent(started(), event("approval", { approvalId: "a1", approvalType: "command", decisions: ["decline"] }), generation);
    s = applyNativeUiEvent(s, prompt(), generation);
    s = applyNativeUiEvent(s, prompt({ clarificationId: "c2", nativeItemId: "item-2" }), generation);
    expect(s.clarifications).toHaveLength(2);
    expect(s.clarifications[0].answering).toBe(false);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    expect(s.clarifications[0].answering).toBe(true);
    s = applyNativeClarificationAck(s, answerAck(), generation);
    expect(s.clarifications).toHaveLength(2);
    s = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: true }), generation);
    expect(s.clarifications.map((q) => q.clarificationId)).toEqual(["c2"]);
    expect(s.approvals.map((a) => a.approvalId)).toEqual(["a1"]);
    expect(s).toMatchObject({ busy: true, activeTurnId: "t1" });
    expect(s.messages[1].isStreaming).toBe(true);
  });

  it.each(["invalid", "not_sent"] as const)("retains %s questions for explicit correction or resubmission", (reason) => {
    let s = applyNativeUiEvent(started(), prompt(), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    s = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: false, reason, message: "x".repeat(600) }), generation);
    expect(s.clarifications[0]).toMatchObject({ answering: false, answerError: "x".repeat(512) });
    expect(s.busy).toBe(true);
    expect(markNativeClarificationAnswering(s, "c1", "t1").clarifications[0]).toMatchObject({ answering: true, answerError: undefined });
  });

  it("removes a stale response but ignores stale generations and foreign question ACKs", () => {
    const s = applyNativeUiEvent(started(), prompt(), generation);
    expect(applyNativeClarificationAck(s, answerAck({ generation: "old" }), generation)).toBe(s);
    expect(applyNativeClarificationAck(s, answerAck({ clarificationId: "foreign" }), generation)).toBe(s);
    expect(applyNativeClarificationAck(s, answerAck({ queued: false, reason: "stale" }), generation).clarifications).toEqual([]);
  });

  it("does not relock a prompt when an invalid result precedes the queue ACK", () => {
    let s = applyNativeUiEvent(started(), prompt(), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    s = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: false, reason: "invalid", message: "Choose an answer" }), generation);
    expect(s.clarifications[0]).toMatchObject({ answering: false, answerError: "Choose an answer" });
    const afterAck = applyNativeClarificationAck(s, answerAck(), generation);
    expect(afterAck.clarifications[0]).toMatchObject({ answering: false, answerError: "Choose an answer" });
  });

  it("does not revive a submitted prompt when the result precedes the queue ACK", () => {
    let s = applyNativeUiEvent(started(), prompt(), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    s = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: true }), generation);
    expect(s.clarifications).toEqual([]);
    expect(applyNativeClarificationAck(s, answerAck(), generation)).toBe(s);
    expect(s).toMatchObject({ busy: true, activeTurnId: "t1" });
  });

  it("routes stale answer results by exact turn and prompt", () => {
    let s = applyNativeUiEvent(started(), prompt(), generation);
    s = applyNativeUiEvent(s, prompt({ clarificationId: "c2", nativeItemId: "item-2" }), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    expect(applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: false, reason: "stale", turnId: "old" }), generation)).toBe(s);
    s = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: false, reason: "stale" }), generation);
    expect(s.clarifications.map((q) => q.clarificationId)).toEqual(["c2"]);
  });

  it("clears optimistic pending state on a local pre-queue failure", () => {
    let s = applyNativeUiEvent(started(), prompt(), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    expect(markNativeClarificationAnswering(s, "c1", "t1")).toBe(s);
    expect(resetNativeClarificationAnswering(s, "c1", "old")).toBe(s);
    s = resetNativeClarificationAnswering(s, "c1", "t1", "Invalid answer");
    expect(s.clarifications[0]).toMatchObject({ answering: false, answerError: "Invalid answer" });
  });

  it("supports Claude's question IDs and verifies identity before resolution", () => {
    let s = applyNativeUiEvent(claude(), prompt({ controller: "claude", nativeSessionId: "ns", nativeUserMessageId: "nu",
      questions: [{ id: "Original question?", header: "", question: "Original question?", options: null, multiSelect: false, isOther: true }] }), generation);
    expect(s.clarifications[0].questions[0].id).toBe("Original question?");
    const wrong = applyNativeUiEvent(s, event("clarification_resolved", { controller: "claude", nativeSessionId: "ns", nativeUserMessageId: "other", clarificationId: "c1" }), generation);
    expect(wrong).toMatchObject({ unavailable: true, busy: false, clarifications: [] });
    s = applyNativeUiEvent(s, event("clarification_answered", { controller: "claude", nativeSessionId: "ns", nativeUserMessageId: "nu", clarificationId: "c1", submitted: true }), generation);
    expect(s).toMatchObject({ clarifications: [], busy: true, unavailable: false });
  });

  it("fails closed for wrong controller on a current answer without inventing native IDs", () => {
    const s = applyNativeUiEvent(started(), prompt(), generation);
    const result = applyNativeClarificationAck(s, answerAck({ controller: "claude" }), generation);
    expect(result).toMatchObject({ unavailable: true, busy: false, clarifications: [] });
    expect(result.messages[1].outcome).toBe("unknown");
  });

  it("checks Codex native turn identity before resolving a question", () => {
    const s = applyNativeUiEvent(started(), prompt({ nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    const bad = applyNativeUiEvent(s, event("clarification_resolved", { clarificationId: "c1", nativeThreadId: "thread", nativeTurnId: "foreign" }), generation);
    expect(bad).toMatchObject({ unavailable: true, busy: false, clarifications: [] });
    const valid = applyNativeUiEvent(s, event("clarification_resolved", { clarificationId: "c1", nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    expect(valid).toMatchObject({ unavailable: false, busy: true, clarifications: [] });
  });

  it("checks native identity and controller before applying an answer result", () => {
    const s = applyNativeUiEvent(started(), prompt({ nativeThreadId: "thread", nativeTurnId: "turn" }), generation);
    const bad = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: true, nativeThreadId: "thread", nativeTurnId: "foreign" }), generation);
    expect(bad).toMatchObject({ unavailable: true, busy: false, clarifications: [] });
    const wrongController = applyNativeUiEvent(s, event("clarification_answered", { clarificationId: "c1", submitted: true, controller: "claude" }), generation);
    expect(wrongController.unavailable).toBe(true);
  });

  it("ignores old/foreign prompts, caps and deduplicates current prompts", () => {
    let s = started();
    expect(applyNativeUiEvent(s, prompt({ turnId: "old" }), generation)).toBe(s);
    expect(applyNativeUiEvent(s, prompt({ sessionId: "other" }), generation)).toBe(s);
    expect(applyNativeUiEvent(s, prompt({ generation: "old" }), generation)).toBe(s);
    for (const clarificationId of ["c1", "c1", "c2", "c3", "c4", "c5"]) {
      s = applyNativeUiEvent(s, prompt({ clarificationId }), generation);
    }
    expect(s.clarifications.map((q) => q.clarificationId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(applyNativeUiEvent(s, prompt({ questions: Array(5).fill(questions[0]) }), generation).clarifications).toHaveLength(4);
  });

  it("clears on cancellation and host loss while retaining partial text", () => {
    let s = applyNativeUiEvent(started(), event("message_delta", { text: "partial" }), generation);
    s = applyNativeUiEvent(s, prompt(), generation);
    s = markNativeClarificationAnswering(s, "c1", "t1");
    const cancelling = markNativeCancelling(s);
    expect(cancelling).toMatchObject({ clarifications: [], cancelling: true, busy: true });
    expect(applyNativeUiEvent(cancelling, prompt({ clarificationId: "late" }), generation).clarifications).toEqual([]);
    const lost = markNativeUnavailable(s, "host lost");
    expect(lost).toMatchObject({ clarifications: [], unavailable: true, busy: false });
    expect(lost.messages[1]).toMatchObject({ text: "partial", outcome: "unknown" });
  });

  it("does not revive a terminal turn or let its late ACK remove a new prompt", () => {
    const s = applyNativeUiEvent(started(), prompt(), generation);
    const result = applyNativePollBatch([s], generation, [
      event("turn_complete", { nativeOutcome: "completed" }), prompt({ clarificationId: "late" }),
    ]).sessions[0];
    expect(result).toMatchObject({ clarifications: [], busy: false });
    let next = beginNativeTurn(result, "t2", "next");
    next = applyNativeUiEvent(next, prompt({ turnId: "t2" }), generation);
    expect(applyNativeClarificationAck(next, answerAck(), generation)).toBe(next);
    expect(applyNativeUiEvent(next, event("clarification_answered", { clarificationId: "c1", submitted: true }), generation)).toBe(next);
    expect(next.clarifications).toHaveLength(1);
  });
});

describe("Claude conversation identities", () => {
  const claudeStart = () => beginNativeTurn(createNativeUiSession("s1", "model", "review", "medium", "claude"), "t1", "hello");
  const pending = (extra: Partial<NativeClaudeSendAck> = {}): NativeClaudeSendAck => ({
    generation, controller: "claude", sessionId: "s1", turnId: "t1", submitted: true,
    requestedNativeSessionId: "native-session", requestedNativeUserMessageId: "native-user", ...extra,
  });
  const observed = (kind: NativePollEvent["kind"], extra: Partial<NativePollEvent> = {}): NativePollEvent =>
    event(kind, { controller: "claude", nativeSessionId: "native-session", nativeUserMessageId: "native-user", ...extra });

  it("keeps requested identity separate until a correlated event arrives", () => {
    let s = applyNativeAck(claudeStart(), pending(), generation);
    expect(s).toMatchObject({ nativeSessionId: null, requestedNativeSessionId: "native-session", busy: true, threadStarted: true });
    expect(s.messages[1]).not.toHaveProperty("nativeSessionId");
    s = applyNativeUiEvent(s, observed("message_delta", { text: "hi", nativeMessageId: "assistant" }), generation);
    expect(s.messages[1]).toMatchObject({ text: "hi", nativeSessionId: "native-session", nativeUserMessageId: "native-user", nativeMessageId: "assistant" });
    expect(s.messages[1]).not.toHaveProperty("nativeTurnId");
  });

  it("validates terminal-before-ACK without resurrecting and detects a conflicting ACK", () => {
    const terminal = applyNativeUiEvent(claudeStart(), observed("turn_complete", { nativeOutcome: "completed" }), generation);
    const settled = applyNativeAck(terminal, pending(), generation);
    expect(settled).toMatchObject({ busy: false, activeTurnId: null, unavailable: false, threadStarted: true });
    expect(settled.messages[1].outcome).toBe("completed");
    const mismatch = applyNativeAck(terminal, pending({ requestedNativeUserMessageId: "wrong" }), generation);
    expect(mismatch.unavailable).toBe(true);
    expect(mismatch.messages[1].outcome).toBe("unknown");
  });

  it("fails closed on conflicting observed IDs and ignores stale turns and generations", () => {
    let s = applyNativeAck(claudeStart(), pending(), generation);
    expect(applyNativeUiEvent(s, observed("message_delta", { generation: "old", text: "stale" }), generation)).toBe(s);
    expect(applyNativeUiEvent(s, observed("message_delta", { turnId: "old", text: "stale" }), generation)).toBe(s);
    s = applyNativeUiEvent(s, observed("message_delta", { nativeUserMessageId: "other", text: "wrong" }), generation);
    expect(s).toMatchObject({ unavailable: true, busy: false });
    expect(s.messages[1]).toMatchObject({ text: "", outcome: "unknown" });
  });

  it("does not let a late ACK bind a new turn's identity", () => {
    let s = applyNativeUiEvent(claudeStart(), observed("turn_complete", { nativeOutcome: "completed" }), generation);
    s = beginNativeTurn(s, "t2", "next");
    s = applyNativeAck(s, pending(), generation);
    expect(s).toMatchObject({ activeTurnId: "t2", busy: true, nativeSessionId: "native-session" });
    expect(s.messages[3]).not.toHaveProperty("requestedNativeUserMessageId");
  });

  it("rejects a different session on a continuing chat and ignores stale ACKs", () => {
    let s = applyNativeAck(claudeStart(), pending(), generation);
    expect(applyNativeAck(s, pending({ generation: "old" }), generation)).toBe(s);
    s = applyNativeUiEvent(s, observed("turn_complete", { nativeOutcome: "completed" }), generation);
    s = beginNativeTurn(s, "t2", "next");
    s = applyNativeAck(s, pending({ turnId: "t2", requestedNativeSessionId: "foreign", requestedNativeUserMessageId: "new-user" }), generation);
    expect(s).toMatchObject({ unavailable: true, busy: false });
  });

  it("supports tool approval without inventing granted choices", () => {
    const s = applyNativeUiEvent(claudeStart(), observed("approval", { approvalId: "a", approvalType: "tool", decisions: [] }), generation);
    expect(s.approvals[0]).toMatchObject({ approvalType: "tool", decisions: [] });
  });
});
