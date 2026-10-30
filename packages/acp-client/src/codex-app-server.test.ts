import { describe, expect, it } from "vitest";
import { normalizeCodexAppServerEvent } from "./codex-app-server";

const context = { threadId: "thread-1", turnId: "turn-1" };

function deltaNotification(params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Hello",
      ...params,
    },
  };
}

function itemNotification(
  method: string,
  item: unknown,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    method,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item,
      ...params,
    },
  };
}

function turnNotification(turn: unknown, threadId = "thread-1") {
  return {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId, turn },
  };
}

describe("normalizeCodexAppServerEvent delta", () => {
  it("emits text chunks as message_delta with native correlation", () => {
    const events = normalizeCodexAppServerEvent("s1", context, deltaNotification({}));
    expect(events).toEqual([
      {
        harness: "codex",
        sessionId: "s1",
        kind: "message_delta",
        text: "Hello",
        nativeThreadId: "thread-1",
        nativeTurnId: "turn-1",
        nativeItemId: "item-1",
      },
    ]);
  });

  it("emits whitespace-only deltas", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      deltaNotification({ delta: "   " }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("message_delta");
    expect(events[0]?.text).toBe("   ");
  });

  it("ignores stale or foreign thread/turn pairs", () => {
    expect(
      normalizeCodexAppServerEvent("s1", context, deltaNotification({ threadId: "other" })),
    ).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", context, deltaNotification({ turnId: "other" })),
    ).toEqual([]);
  });

  it("requires non-empty session and context identifiers", () => {
    const raw = deltaNotification({});
    expect(normalizeCodexAppServerEvent("", context, raw)).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", { threadId: "", turnId: "turn-1" }, raw),
    ).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", { threadId: "thread-1", turnId: "" }, raw),
    ).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", context, deltaNotification({ threadId: undefined })),
    ).toEqual([]);
  });
});

describe("normalizeCodexAppServerEvent framing guards", () => {
  it("ignores foreign RPC requests carrying an id field, including id 0", () => {
    const request = {
      jsonrpc: "2.0",
      id: 0,
      method: "thread/start",
      params: { threadId: "thread-1" },
    };
    expect(normalizeCodexAppServerEvent("s1", context, request)).toEqual([]);
    const idZeroDelta = { ...deltaNotification({}), id: 0 };
    expect(normalizeCodexAppServerEvent("s1", context, idZeroDelta)).toEqual([]);
    const response = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    expect(normalizeCodexAppServerEvent("s1", context, response)).toEqual([]);
  });

  it("ignores null, arrays, unknown methods and malformed params", () => {
    expect(normalizeCodexAppServerEvent("s1", context, null)).toEqual([]);
    expect(normalizeCodexAppServerEvent("s1", context, [])).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", context, {
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
    ).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", context, deltaNotification({ delta: 42 })),
    ).toEqual([]);
    expect(
      normalizeCodexAppServerEvent("s1", context, deltaNotification({ itemId: "" })),
    ).toEqual([]);
  });
});

describe("normalizeCodexAppServerEvent tool lifecycle", () => {
  it("maps commandExecution start and completion without raw blobs", () => {
    const started = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/started", {
        id: "cmd-1",
        type: "commandExecution",
        command: "rm -rf /",
        cwd: "/tmp",
        status: "inProgress",
      }),
    );
    expect(started[0]?.kind).toBe("tool_call");
    expect(started[0]?.toolCallId).toBe("cmd-1");
    expect(started[0]?.toolStatus).toBe("inProgress");
    expect(started[0]?.nativeItemId).toBe("cmd-1");
    const completed = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "cmd-1",
        type: "commandExecution",
        command: "rm -rf /",
        aggregatedOutput: "secret output",
        exitCode: 1,
        status: "failed",
      }),
    );
    expect(completed[0]?.kind).toBe("tool_result");
    expect(completed[0]?.toolStatus).toBe("failed");
    expect(completed[0]?.text).toBe("exit code 1");
    for (const event of [...started, ...completed]) {
      expect(JSON.stringify(event)).not.toContain("rm -rf");
      expect(JSON.stringify(event)).not.toContain("secret output");
    }
  });

  it("maps fileChange start and completion with bounded change counts", () => {
    const started = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/started", {
        id: "patch-1",
        type: "fileChange",
        changes: [{ path: "a.ts", kind: "update", diff: "huge" }],
        status: "inProgress",
      }),
    );
    expect(started[0]?.kind).toBe("tool_call");
    expect(started[0]?.toolCallId).toBe("patch-1");
    expect(started[0]?.toolStatus).toBe("inProgress");
    const completed = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "patch-1",
        type: "fileChange",
        changes: [
          { path: "a.ts", kind: "update", diff: "huge" },
          { path: "b.ts", kind: "add", diff: "huge" },
        ],
        status: "completed",
      }),
    );
    expect(completed[0]?.kind).toBe("tool_result");
    expect(completed[0]?.toolStatus).toBe("completed");
    expect(completed[0]?.text).toBe("2 file(s) changed");
    expect(JSON.stringify(completed)).not.toContain("huge");
  });

  it("ignores unknown item types and items without native ids", () => {
    for (const type of ["agentMessage", "reasoning", "webSearch", "mcpToolCall"]) {
      expect(
        normalizeCodexAppServerEvent(
          "s1",
          context,
          itemNotification("item/started", { id: "x", type, text: "hi" }),
        ),
      ).toEqual([]);
    }
    expect(
      normalizeCodexAppServerEvent(
        "s1",
        context,
        itemNotification("item/started", { type: "commandExecution", status: "inProgress" }),
      ),
    ).toEqual([]);
  });

  it("rejects tool events with missing, malformed or unknown native status", () => {
    const badStatuses: unknown[] = [undefined, 42, "", "succeeded", "in_progress"];
    for (const method of ["item/started", "item/completed"]) {
      for (const type of ["commandExecution", "fileChange"]) {
        for (const status of badStatuses) {
          const item: Record<string, unknown> = { id: "x-1", type };
          if (status !== undefined) {
            item.status = status;
          }
          expect(
            normalizeCodexAppServerEvent("s1", context, itemNotification(method, item)),
          ).toEqual([]);
        }
      }
    }
  });

  it("preserves native failure and declined outcomes without claiming success", () => {
    const declined = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", { id: "patch-9", type: "fileChange", status: "declined" }),
    );
    expect(declined[0]?.kind).toBe("tool_result");
    expect(declined[0]?.toolStatus).toBe("declined");
    const declinedCommand = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "cmd-9",
        type: "commandExecution",
        status: "declined",
      }),
    );
    expect(declinedCommand).toHaveLength(1);
    expect(declinedCommand[0]?.kind).toBe("tool_result");
    expect(declinedCommand[0]?.toolCallId).toBe("cmd-9");
    expect(declinedCommand[0]?.nativeItemId).toBe("cmd-9");
    expect(declinedCommand[0]?.nativeThreadId).toBe("thread-1");
    expect(declinedCommand[0]?.nativeTurnId).toBe("turn-1");
    expect(declinedCommand[0]?.toolStatus).toBe("declined");
    expect(declinedCommand[0]?.kind).not.toBe("turn_complete");
    expect(declinedCommand[0]?.nativeOutcome).toBeUndefined();
    const failedCommand = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "cmd-2",
        type: "commandExecution",
        exitCode: 0,
        status: "failed",
      }),
    );
    expect(failedCommand[0]?.kind).toBe("tool_result");
    expect(failedCommand[0]?.toolStatus).toBe("failed");
    expect(failedCommand[0]?.toolStatus).not.toBe("completed");
    const succeededCommand = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "cmd-3",
        type: "commandExecution",
        exitCode: 0,
        status: "completed",
      }),
    );
    expect(succeededCommand[0]?.toolStatus).toBe("completed");
    expect(succeededCommand[0]?.text).toBe("exit code 0");
  });

  it("never replays final agentMessage item text on item/completed", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      itemNotification("item/completed", {
        id: "item-1",
        type: "agentMessage",
        text: "Full final answer",
      }),
    );
    expect(events).toEqual([]);
  });
});

describe("normalizeCodexAppServerEvent terminal turn", () => {
  it("maps completed turns to turn_complete", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      turnNotification({
        id: "turn-1",
        items: [{ id: "item-1", type: "agentMessage", text: "Hello" }],
        status: "completed",
      }),
    );
    expect(events).toEqual([
      {
        harness: "codex",
        sessionId: "s1",
        kind: "turn_complete",
        nativeThreadId: "thread-1",
        nativeTurnId: "turn-1",
        nativeOutcome: "completed",
      },
    ]);
  });

  it("maps failed turns to error with the native message", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      turnNotification({
        id: "turn-1",
        items: [{ id: "item-1", type: "agentMessage", text: "Hello" }],
        status: "failed",
        error: { message: "boom" },
      }),
    );
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.text).toBe("boom");
    expect(events[0]?.nativeOutcome).toBe("failed");
  });

  it("falls back to a stable message when a failed turn has no usable error", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      turnNotification({ id: "turn-1", items: [], status: "failed" }),
    );
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.text).toBe("Codex turn failed");
    expect(events[0]?.nativeOutcome).toBe("failed");
  });

  it("maps interrupted turns to status without turn_complete", () => {
    const events = normalizeCodexAppServerEvent(
      "s1",
      context,
      turnNotification({ id: "turn-1", items: [], status: "interrupted" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("status");
    expect(events[0]?.nativeOutcome).toBe("interrupted");
  });

  it("ignores inProgress, missing, unrecognized and foreign turns", () => {
    for (const turn of [
      { id: "turn-1", items: [], status: "inProgress" },
      { id: "turn-1", items: [] },
      { id: "turn-1", items: [], status: "paused" },
      { id: "other", items: [], status: "completed" },
      null,
    ]) {
      expect(normalizeCodexAppServerEvent("s1", context, turnNotification(turn))).toEqual(
        [],
      );
    }
    expect(
      normalizeCodexAppServerEvent(
        "s1",
        context,
        turnNotification({ id: "turn-1", items: [], status: "completed" }, "other"),
      ),
    ).toEqual([]);
  });
});

describe("normalizeCodexAppServerEvent identity honesty", () => {
  it("fabricates no native identifiers, model truth or raw payloads", () => {
    const samples = [
      deltaNotification({}),
      itemNotification("item/started", {
        id: "cmd-9",
        type: "commandExecution",
        status: "inProgress",
      }),
      turnNotification({ id: "turn-1", items: [], status: "completed" }),
    ];
    for (const raw of samples) {
      const events = normalizeCodexAppServerEvent("s9", context, raw);
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.nativeThreadId).toBe("thread-1");
      expect(event?.nativeTurnId).toBe("turn-1");
      expect(event?.model).toBeUndefined();
      expect(event).not.toHaveProperty("raw");
      if (event?.nativeItemId !== undefined) {
        expect(["item-1", "cmd-9"]).toContain(event.nativeItemId);
      }
    }
  });
});
