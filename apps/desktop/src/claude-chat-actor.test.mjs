import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeChatActor } from "../server/claude-chat-actor.mjs";

afterEach(() => vi.useRealTimers());
const args = (extra = {}) => ({ sessionId: "s1", turnId: "u1", model: "live", role: "review", effort: "high", prompt: "hello", ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  const events = [], fatals = [], clients = [];
  let opening = null, writing = null, closeError = null;
  const openClient = vi.fn(async (opts) => {
    if (opening) await opening.promise;
    const pending = new Map();
    const client = {
      opts, sends: [], responses: [], retires: [], interrupts: 0, closes: 0,
      sendUser: vi.fn(async (message) => { client.sends.push(message); if (writing) await writing.promise; }),
      interrupt: vi.fn(async () => { client.interrupts += 1; }),
      respond: vi.fn((id, decision) => { client.responses.push({ id, decision }); const d = deferred(); pending.set(id, d); return d.promise; }),
      retire: vi.fn((id) => { client.retires.push(id); const d = pending.get(id); if (d) { pending.delete(id); d.reject(Object.assign(new Error("retired"), { code: "NOT_SENT" })); } return true; }),
      close: vi.fn(async () => { client.closes += 1; if (closeError) throw closeError; }),
      resolve: (id) => { pending.get(id).resolve(); pending.delete(id); },
      reject: (id, error) => { pending.get(id).reject(error); pending.delete(id); },
      event: (raw) => opts.onEvent(raw),
      request: (id, request) => opts.onRequest({ id, request }),
      cancel: (id) => { client.retire(id); opts.onCancel(id); },
    };
    clients.push(client);
    return client;
  });
  const actor = createClaudeChatActor({ workspace: "workspace", generation: "g", models: [{ id: "live", supportedEfforts: ["high"] }], onEvent: (e) => events.push(e), onFatal: (e) => fatals.push(e), openClient });
  return { actor, clients, events, fatals, openClient, delayOpen: () => { opening = deferred(); return opening; }, delayWrite: () => { writing = deferred(); return writing; }, failClose: () => { closeError = new Error("cleanup failed"); } };
}
const corr = (ack) => ({ session_id: ack.requestedNativeSessionId, user_message_uuid: ack.requestedNativeUserMessageId, user_message_uuids: [ack.requestedNativeUserMessageId], parent_tool_use_id: null });
const assistant = (ack, blocks) => ({ ...corr(ack), type: "assistant", message: { id: "assistant-1", content: blocks } });
const terminal = (ack, reason = "completed") => ({ ...corr(ack), type: "result", subtype: "success", is_error: reason !== "completed", terminal_reason: reason });
const questionInput = () => ({ questions: [
  { header: "Style", question: "Which style?", options: [{ label: "Dark", description: "Dark theme" }, { label: "Light", description: "Light theme" }], multiSelect: false },
  { header: "Features", question: "Which features?", options: [{ label: "A", description: "Feature A" }, { label: "B", description: "Feature B" }], multiSelect: true },
], nativeExtra: { retained: true } });
const questionRequest = (id, input) => ({ subtype: "can_use_tool", tool_use_id: id, tool_name: "AskUserQuestion", input });
const questionBlock = (id, input) => ({ type: "tool_use", id, name: "AskUserQuestion", input });
const answerArgs = (id, answers) => ({ sessionId: "s1", turnId: "u1", clarificationId: id, answers });

describe("Claude clarification", () => {
  for (const order of ["request-first", "assistant-first"]) {
    it(`accepts an omitted assistant multiSelect default in ${order} order`, async () => {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
      const control = { questions: [questionInput().questions[0]], context: { source: "native" } };
      const assistantInput = structuredClone(control);
      delete assistantInput.questions[0].multiSelect;
      const originalControl = structuredClone(control), originalAssistant = structuredClone(assistantInput);
      const request = () => c.request("req-default", questionRequest("tool-default", control));
      const showTool = () => c.event(assistant(ack, [questionBlock("tool-default", assistantInput)]));
      if (order === "request-first") { request(); showTool(); } else { showTool(); request(); }
      const prompts = h.events.filter((e) => e.kind === "clarification");
      expect(prompts).toHaveLength(1);
      expect(prompts[0].questions).toHaveLength(1);
      const pending = h.actor.answer(answerArgs(prompts[0].clarificationId, { "Which style?": ["Light"] }));
      expect(c.responses).toEqual([{ id: "req-default", decision: { behavior: "allow", updatedInput: { ...originalControl, answers: { "Which style?": "Light" } } } }]);
      c.resolve("req-default");
      await expect(pending).resolves.toMatchObject({ submitted: true });
      expect(control).toEqual(originalControl);
      expect(assistantInput).toEqual(originalAssistant);
      expect(h.fatals).toHaveLength(0);
      await h.actor.close();
    });
  }

  it("keeps all other question input differences significant", async () => {
    const changes = [
      (q) => { q.questions[0].multiSelect = true; },
      (q) => { q.questions[0].multiSelect = null; },
      (q) => { q.questions[0].multiSelect = "false"; },
      (q) => { q.questions[0].question = "Different?"; },
      (q) => { q.questions[0].options.reverse(); },
      (q) => { q.questions[0].unrecognized = "different"; },
      (q) => { q.nativeExtra.retained = false; },
    ];
    for (const change of changes) {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
      const control = questionInput(); const different = structuredClone(control);
      change(different);
      c.request("req", questionRequest("tool", control));
      c.event(assistant(ack, [questionBlock("tool", different)]));
      expect(h.fatals).toHaveLength(1);
      expect(h.events.some((e) => e.kind === "clarification")).toBe(false);
      expect(c.responses).toHaveLength(0);
      await h.actor.close();
    }
  });

  it("does not apply the question default to other tools", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    c.request("req", { tool_use_id: "tool", tool_name: "Read", input: { questions: [{ label: "x", multiSelect: false }] } });
    c.event(assistant(ack, [{ type: "tool_use", id: "tool", name: "Read", input: { questions: [{ label: "x" }] } }]));
    expect(h.fatals).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "approval")).toBe(false);
    await h.actor.close();
  });

  for (const order of ["request-first", "assistant-first"]) {
    it(`correlates ${order} and sends only explicit answers using the original input`, async () => {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
      const input = questionInput(); const original = structuredClone(input);
      const request = () => c.request("req", questionRequest("tool", input));
      const showTool = () => c.event(assistant(ack, [questionBlock("tool", input)]));
      if (order === "request-first") { request(); expect(h.events).toHaveLength(0); showTool(); }
      else { showTool(); expect(h.events.some((e) => e.kind === "clarification")).toBe(false); request(); }
      const clarification = h.events.find((e) => e.kind === "clarification");
      expect(clarification).toMatchObject({ nativeItemId: "tool", isBlocking: true, nativeSessionId: ack.requestedNativeSessionId, questions: [{ id: "Which style?" }, { id: "Which features?", multiSelect: true }] });
      expect(clarification).not.toHaveProperty("nativeExtra");
      expect(h.events.some((e) => e.kind === "approval")).toBe(false);
      expect(c.responses).toHaveLength(0);
      const answering = h.actor.answer(answerArgs(clarification.clarificationId, { "Which style?": ["Light"], "Which features?": ["A", "B"] }));
      expect(c.responses).toEqual([{ id: "req", decision: { behavior: "allow", updatedInput: { ...original, answers: { "Which style?": "Light", "Which features?": "A, B" } } } }]);
      expect(input).toEqual(original);
      c.resolve("req");
      await expect(answering).resolves.toMatchObject({ generation: "g", controller: "claude", submitted: true, clarificationId: clarification.clarificationId });
      expect(h.events.filter((e) => e.kind === "clarification_resolved")).toHaveLength(1);
      expect(h.events.some((e) => e.nativeOutcome)).toBe(false);
      await expect(h.actor.send(args({ turnId: "u2" }))).rejects.toThrow(/active/);
      c.event(terminal(ack));
      expect(h.events.at(-1)).toMatchObject({ nativeOutcome: "completed" });
      await h.actor.close();
    });
  }

  it("keeps the question actionable after invalid, missing or extra answers", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0]; const input = questionInput();
    c.event(assistant(ack, [questionBlock("tool", input)])); c.request("req", questionRequest("tool", input));
    const id = h.events.find((e) => e.kind === "clarification").clarificationId;
    for (const answers of [null, {}, { "Which style?": ["Dark"] }, { "Which style?": ["Dark"], "Which features?": ["A"], extra: ["x"] }, { "Which style?": ["  "], "Which features?": ["A"] }]) {
      await expect(h.actor.answer(answerArgs(id, answers))).resolves.toMatchObject({ submitted: false, reason: "invalid" });
    }
    expect(c.responses).toHaveLength(0);
    const sent = h.actor.answer(answerArgs(id, { "Which style?": ["Dark"], "Which features?": ["A"] }));
    c.resolve("req"); await expect(sent).resolves.toMatchObject({ submitted: true });
    expect(h.fatals).toHaveLength(0);
    await h.actor.close();
  });

  it("returns stale for duplicate, foreign, withdrawn and completed-turn submissions", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0]; const input = questionInput();
    c.event(assistant(ack, [questionBlock("tool", input)])); c.request("req", questionRequest("tool", input));
    const id = h.events.find((e) => e.kind === "clarification").clarificationId;
    const valid = { "Which style?": ["Dark"], "Which features?": ["A"] };
    await expect(h.actor.answer({ ...answerArgs(id, valid), sessionId: "foreign" })).resolves.toMatchObject({ sessionId: "foreign", submitted: false, reason: "stale" });
    await expect(h.actor.answer({ ...answerArgs(id, valid), turnId: "foreign" })).resolves.toMatchObject({ turnId: "foreign", submitted: false, reason: "stale" });
    const sent = h.actor.answer(answerArgs(id, valid));
    await expect(h.actor.answer(answerArgs(id, valid))).resolves.toMatchObject({ submitted: false, reason: "stale" });
    c.resolve("req"); await sent;
    await expect(h.actor.answer(answerArgs(id, valid))).resolves.toMatchObject({ submitted: false, reason: "stale" });
    c.event(terminal(ack));
    await expect(h.actor.answer(answerArgs(id, null))).resolves.toMatchObject({ submitted: false, reason: "stale" });
    expect(c.responses).toHaveLength(1);
    await h.actor.close();
  });

  it("permits only explicit retry after a current response is known not sent", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0]; const input = questionInput();
    c.event(assistant(ack, [questionBlock("tool", input)])); c.request("req", questionRequest("tool", input));
    const id = h.events.find((e) => e.kind === "clarification").clarificationId;
    const answer = answerArgs(id, { "Which style?": ["Dark"], "Which features?": ["A"] });
    const first = h.actor.answer(answer);
    c.reject("req", Object.assign(new Error("not written"), { code: "NOT_SENT" }));
    await expect(first).resolves.toMatchObject({ submitted: false, reason: "not_sent" });
    expect(c.responses).toHaveLength(1);
    const second = h.actor.answer(answer); c.resolve("req");
    await expect(second).resolves.toMatchObject({ submitted: true });
    expect(h.fatals).toHaveLength(0);
    await h.actor.close();
  });

  for (const boundary of ["terminal", "cancel", "native withdrawal"]) {
    it(`retires an unwritten clarification answer on ${boundary}`, async () => {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0]; const input = questionInput();
      c.event(assistant(ack, [questionBlock("tool", input)])); c.request("req", questionRequest("tool", input));
      const id = h.events.find((e) => e.kind === "clarification").clarificationId;
      const data = answerArgs(id, { "Which style?": ["Dark"], "Which features?": ["A"] });
      const pending = h.actor.answer(data);
      if (boundary === "terminal") c.event(terminal(ack));
      if (boundary === "cancel") await h.actor.cancel({ sessionId: "s1", turnId: "u1" });
      if (boundary === "native withdrawal") c.cancel("req");
      await expect(pending).resolves.toMatchObject({ submitted: false, reason: "stale" });
      await expect(h.actor.answer(data)).resolves.toMatchObject({ submitted: false, reason: "stale" });
      expect(c.retires).toContain("req");
      expect(h.events.filter((e) => e.kind === "clarification_resolved")).toHaveLength(1);
      expect(h.fatals).toHaveLength(0);
      await h.actor.close();
    });
  }

  for (const firstKind of ["approval", "question"]) {
    it(`preserves a reused native request ID from ${firstKind} to the other kind`, async () => {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0]; const input = questionInput();
      c.event(assistant(ack, [questionBlock("question", input), { type: "tool_use", id: "read", name: "Read", input: { path: "file" } }]));
      const approval = () => c.request("same", { tool_use_id: "read", tool_name: "Read", input: { path: "file" } });
      const question = () => c.request("same", questionRequest("question", input));
      if (firstKind === "approval") approval(); else question();
      const firstEvent = h.events.find((e) => e.kind === (firstKind === "approval" ? "approval" : "clarification"));
      const first = firstKind === "approval" ? h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: firstEvent.approvalId, decision: "accept" }) : h.actor.answer(answerArgs(firstEvent.clarificationId, { "Which style?": ["Dark"], "Which features?": ["A"] }));
      c.resolve("same"); // transport admitted it; its promise continuation has not run
      if (firstKind === "approval") question(); else approval();
      await first;
      const secondEvent = h.events.find((e) => e.kind === (firstKind === "approval" ? "clarification" : "approval"));
      const second = firstKind === "approval" ? h.actor.answer(answerArgs(secondEvent.clarificationId, { "Which style?": ["Light"], "Which features?": ["B"] })) : h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: secondEvent.approvalId, decision: "decline" });
      c.resolve("same"); await second;
      expect(c.responses).toHaveLength(2);
      expect(h.fatals).toHaveLength(0);
      await h.actor.close();
    });
  }

  it("enforces four questions and the shared eight-request bound", async () => {
    const h = fixture(); await h.actor.send(args()); const c = h.clients[0];
    for (let i = 0; i < 4; i += 1) c.request(`q${i}`, questionRequest(`qt${i}`, questionInput()));
    for (let i = 0; i < 4; i += 1) c.request(`a${i}`, { tool_use_id: `at${i}`, tool_name: "Read", input: {} });
    expect(h.fatals).toHaveLength(0);
    c.request("overflow", { tool_use_id: "extra", tool_name: "Read", input: {} });
    expect(h.fatals).toHaveLength(1);
    await h.actor.close();
    const g = fixture(); await g.actor.send(args());
    for (let i = 0; i < 5; i += 1) g.clients[0].request(`q${i}`, questionRequest(`qt${i}`, questionInput()));
    expect(g.fatals).toHaveLength(1);
    await g.actor.close();
  });

  it("fails visibly for malformed or secret questions and mismatched assistant input", async () => {
    for (const input of [{ questions: [] }, { ...questionInput(), questions: [{ ...questionInput().questions[0], isSecret: true }] }]) {
      const h = fixture(); await h.actor.send(args());
      h.clients[0].request("req", questionRequest("tool", input));
      expect(h.fatals).toHaveLength(1);
      expect(h.events.some((e) => e.nativeOutcome === "unknown")).toBe(true);
      expect(h.clients[0].responses).toHaveLength(0);
      await h.actor.close();
    }
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    c.request("req", questionRequest("tool", questionInput()));
    const changed = questionInput(); changed.questions[0].question = "Changed?";
    c.event(assistant(ack, [questionBlock("tool", changed)]));
    expect(h.fatals).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "clarification")).toBe(false);
    await h.actor.close();
  });
});

describe("Claude chat actor", () => {
  it("distinguishes write submission from observed activation and preserves two-turn session identity", async () => {
    const h = fixture();
    const first = await h.actor.send(args());
    expect(first).toMatchObject({ generation: "g", controller: "claude", sessionId: "s1", turnId: "u1", submitted: true });
    expect(first).not.toHaveProperty("nativeSessionId");
    expect(h.events).toHaveLength(0);
    const c = h.clients[0];
    c.event({ ...corr(first), user_message_uuid: "foreign", type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "foreign" } } });
    expect(h.events).toHaveLength(0);
    const continuation = { session_id: first.requestedNativeSessionId, parent_tool_use_id: null, type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } };
    c.event(continuation);
    expect(h.events).toHaveLength(0);
    c.event({ ...corr(first), type: "stream_event", event: { type: "message_start", message: { id: "native-message" } } });
    c.event({ ...continuation, user_message_uuid: first.requestedNativeUserMessageId }); // partial correlation is rejected
    c.event(continuation);
    expect(h.events.at(-1)).toMatchObject({ kind: "message_delta", text: "hello", nativeMessageId: "native-message", nativeSessionId: first.requestedNativeSessionId, nativeUserMessageId: first.requestedNativeUserMessageId });
    c.event({ ...continuation, event: { type: "message_stop" } });
    c.event(continuation);
    expect(h.events.filter((e) => e.kind === "message_delta")).toHaveLength(1);
    c.event(terminal(first));
    const second = await h.actor.send(args({ turnId: "u2" }));
    expect(second.requestedNativeSessionId).toBe(first.requestedNativeSessionId);
    expect(second.requestedNativeUserMessageId).not.toBe(first.requestedNativeUserMessageId);
    expect(h.openClient).toHaveBeenCalledTimes(1);
    await expect(h.actor.send(args({ turnId: "u3" }))).rejects.toThrow(/active/);
    c.event(terminal(second, "aborted_tools"));
    expect(h.events.at(-1)).toMatchObject({ kind: "status", nativeOutcome: "interrupted" });
    await h.actor.close();
  });

  it("buffers a request until the correlated tool ID, name and exact input match", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    c.request("req", { subtype: "can_use_tool", tool_use_id: "tool", tool_name: "Read", input: { path: "a", options: { b: 2, a: 1 } } });
    expect(h.events).toHaveLength(0);
    c.event(assistant(ack, [{ type: "tool_use", id: "tool", name: "Read", input: { options: { a: 1, b: 2 }, path: "a" } }]));
    const approval = h.events.find((e) => e.kind === "approval");
    expect(approval).toMatchObject({ approvalType: "tool", nativeSessionId: ack.requestedNativeSessionId, decisions: ["accept", "decline", "cancel"] });
    const answer = h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: approval.approvalId, decision: "accept" });
    expect(c.responses).toEqual([{ id: "req", decision: { behavior: "allow", updatedInput: { path: "a", options: { b: 2, a: 1 } } } }]);
    await expect(h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: approval.approvalId, decision: "accept" })).rejects.toThrow(/already-answered/);
    c.resolve("req"); await answer;
    c.event({ type: "user", session_id: ack.requestedNativeSessionId, parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: true }] } });
    expect(h.events.at(-1)).toMatchObject({ kind: "tool_call", toolCallId: "tool", toolTitle: "Read", toolStatus: "failed" });
    await h.actor.close();
  });

  it("allows one anchored post-tool continuation and rejects uncredited or foreign messages", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    const base = { session_id: ack.requestedNativeSessionId, parent_tool_use_id: null };
    const start = (id) => ({ ...base, type: "stream_event", event: { type: "message_start", message: { id } } });
    const delta = { ...base, type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "read marker" } } };
    c.event(start("uncredited")); c.event(delta);
    expect(h.events).toHaveLength(0);
    c.event({ ...corr(ack), type: "stream_event", event: { type: "message_start", message: { id: "first" } } });
    c.event(assistant(ack, [{ type: "tool_use", id: "read-1", name: "Read", input: { path: "fixture" } }]));
    c.request("req-1", { tool_use_id: "read-1", tool_name: "Read", input: { path: "fixture" } });
    const approval = h.events.find((e) => e.kind === "approval");
    const answer = h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: approval.approvalId, decision: "accept" });
    c.resolve("req-1"); await answer;
    c.event({ ...base, type: "stream_event", event: { type: "message_stop" } });
    const toolResult = { ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1" }] } };
    c.event(toolResult);
    c.event(start("post-tool"));
    c.event(delta);
    expect(h.events.at(-1)).toMatchObject({ kind: "message_delta", text: "read marker", nativeMessageId: "post-tool" });
    const before = h.events.length;
    c.event({ ...base, type: "assistant", message: { id: "foreign", content: [{ type: "tool_use", id: "bad", name: "Read", input: {} }] } });
    expect(h.events).toHaveLength(before);
    c.event({ ...base, type: "assistant", message: { id: "post-tool", content: [{ type: "tool_use", id: "read-2", name: "Read", input: { path: "other" } }] } });
    expect(h.events.at(-1)).toMatchObject({ kind: "tool_call", toolCallId: "read-2" });
    c.event({ ...base, type: "stream_event", event: { type: "message_stop" } });
    c.event(toolResult); // a duplicate result cannot mint another credit
    c.event(start("uncredited-again")); c.event(delta);
    expect(h.events.filter((e) => e.kind === "message_delta")).toHaveLength(1);
    c.event(terminal(ack));
    expect(h.events.at(-1)).toMatchObject({ nativeOutcome: "completed" });
    expect(h.fatals).toHaveLength(0);
    await h.actor.close();
  });

  it("fails closed when a foreign start overlaps an anchored stream", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    const base = { session_id: ack.requestedNativeSessionId, parent_tool_use_id: null };
    c.event({ ...corr(ack), type: "stream_event", event: { type: "message_start", message: { id: "message-a" } } });
    c.event({ ...base, user_message_uuid: "foreign", user_message_uuids: ["foreign"], type: "stream_event", event: { type: "message_start", message: { id: "message-b" } } });
    c.event({ ...base, type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "wrong turn" } } });
    expect(h.fatals).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "message_delta")).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ kind: "error", nativeOutcome: "unknown" });
    await h.actor.close();
  });

  it("fails closed on mismatched tool input and rejects unsupported tools", async () => {
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    c.request("req", { tool_use_id: "tool", tool_name: "Read", input: { path: "a" } });
    c.event(assistant(ack, [{ type: "tool_use", id: "tool", name: "Read", input: { path: "b" } }]));
    expect(h.fatals).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "approval")).toBe(false);
    await expect(h.actor.send(args({ turnId: "u2" }))).rejects.toThrow(/closed/);
    await h.actor.close();
    const g = fixture(); await g.actor.send(args());
    g.clients[0].request("req", { tool_use_id: "x", tool_name: "Write", input: {} });
    expect(g.fatals).toHaveLength(1);
    await g.actor.close();
  });

  for (const boundary of ["terminal", "cancel", "native cancel"]) {
    it(`retires an in-flight approval on ${boundary}`, async () => {
      const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
      c.event(assistant(ack, [{ type: "tool_use", id: "tool", name: "Read", input: {} }]));
      c.request("req", { tool_use_id: "tool", tool_name: "Read", input: {} });
      const approval = h.events.find((e) => e.kind === "approval");
      const answer = h.actor.respond({ sessionId: "s1", turnId: "u1", approvalId: approval.approvalId, decision: "accept" });
      const rejection = expect(answer).rejects.toMatchObject({ code: "NOT_SENT" });
      if (boundary === "terminal") c.event(terminal(ack));
      if (boundary === "cancel") await h.actor.cancel({ sessionId: "s1", turnId: "u1" });
      if (boundary === "native cancel") c.cancel("req");
      await rejection;
      expect(c.retires).toContain("req");
      expect(h.events.filter((e) => e.kind === "approval_resolved")).toHaveLength(1);
      await h.actor.close();
    });
  }

  it("remembers cancellation while opening and interrupts only after the message write", async () => {
    const h = fixture(); const gate = h.delayOpen();
    const sent = h.actor.send(args());
    await h.actor.cancel({ sessionId: "s1", turnId: "u1" });
    gate.resolve();
    const ack = await sent;
    expect(h.clients[0].sends).toHaveLength(1);
    expect(h.clients[0].interrupts).toBe(1);
    h.clients[0].event(terminal(ack, "aborted_streaming"));
    expect(h.events.at(-1)).toMatchObject({ nativeOutcome: "interrupted" });
    await h.actor.close();
  });

  it("does not resurrect a terminal turn when its write resolves late", async () => {
    const h = fixture(); const gate = h.delayWrite();
    const sent = h.actor.send(args());
    await vi.waitFor(() => expect(h.clients[0]?.sends).toHaveLength(1));
    const c = h.clients[0];
    const ackIdentity = { requestedNativeSessionId: c.opts.sessionId, requestedNativeUserMessageId: c.sends[0].uuid };
    c.event(terminal(ackIdentity));
    gate.resolve();
    await expect(sent).resolves.toMatchObject({ submitted: true });
    expect(h.events.filter((e) => e.nativeOutcome === "completed")).toHaveLength(1);
    await h.actor.close();
  });

  it("closes a late-opening client", async () => {
    const h = fixture(); const gate = h.delayOpen();
    const sent = h.actor.send(args()); sent.catch(() => {});
    await Promise.resolve(); // opening has begun before shutdown
    const closing = h.actor.close();
    gate.resolve();
    await expect(sent).rejects.toThrow(/closed/);
    await closing;
    expect(h.clients[0].closes).toBe(1);
    expect(h.fatals).toHaveLength(0);
  });

  it("reports late-opening cleanup failure to the owner", async () => {
    const h = fixture(); const gate = h.delayOpen(); h.failClose();
    const sent = h.actor.send(args()); sent.catch(() => {});
    await Promise.resolve();
    const closing = h.actor.close(); gate.resolve();
    await expect(sent).rejects.toThrow(/closed/);
    await expect(closing).rejects.toThrow(/cleanup failed/);
    expect(h.fatals).toHaveLength(1);
  });

  it("bounds pending correlation and consumer silence", async () => {
    vi.useFakeTimers();
    const h = fixture(); const ack = await h.actor.send(args()); const c = h.clients[0];
    c.event({ type: "user", uuid: ack.requestedNativeUserMessageId, session_id: ack.requestedNativeSessionId, parent_tool_use_id: null, message: { role: "user", content: "hello" } });
    c.request("req", { tool_use_id: "tool", tool_name: "Read", input: {} });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.fatals).toHaveLength(1);
    await h.actor.close();
    const g = fixture(); const second = await g.actor.send(args());
    g.clients[0].event({ type: "user", uuid: second.requestedNativeUserMessageId, session_id: second.requestedNativeSessionId, parent_tool_use_id: null, message: { role: "user", content: "hello" } });
    await vi.advanceTimersByTimeAsync(29_000); g.actor.touch();
    await vi.advanceTimersByTimeAsync(29_000); expect(g.fatals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000); expect(g.fatals).toHaveLength(1);
    await g.actor.close();
  });
});
