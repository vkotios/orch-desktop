import type { NormalizedStreamEvent } from "./index";

export interface CodexAppServerContext {
  threadId: string;
  turnId: string;
}

export type CodexAppServerOutcome = "completed" | "failed" | "interrupted";

export interface CodexAppServerEvent extends NormalizedStreamEvent {
  nativeThreadId: string;
  nativeTurnId: string;
  nativeItemId?: string;
  nativeOutcome?: CodexAppServerOutcome;
}

const MAX_TEXT_LENGTH = 200;
const FALLBACK_TURN_ERROR = "Codex turn failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function boundText(value: string): string {
  if (value.length > MAX_TEXT_LENGTH) {
    return value.slice(0, MAX_TEXT_LENGTH);
  }
  return value;
}

/**
 * Native lifecycle labels consumed from the installed app-server schemas
 * (CommandExecutionStatus / PatchApplyStatus as surfaced on completed items).
 * Only these labels are accepted; a missing, malformed or unknown status is
 * rejected by the caller with [] so the mapper never invents a completion or
 * success outcome.
 */
const COMMAND_EXECUTION_STATUSES = new Set(["inProgress", "completed", "failed", "declined"]);
const FILE_CHANGE_STATUSES = new Set(["inProgress", "completed", "failed", "declined"]);

function nativeToolStatus(
  item: Record<string, unknown>,
  isCommand: boolean,
): string | undefined {
  const allowed = isCommand ? COMMAND_EXECUTION_STATUSES : FILE_CHANGE_STATUSES;
  if (typeof item.status === "string" && allowed.has(item.status)) {
    return item.status;
  }
  return undefined;
}

function baseEvent(
  sessionId: string,
  context: CodexAppServerContext,
): Pick<CodexAppServerEvent, "harness" | "sessionId" | "nativeThreadId" | "nativeTurnId"> {
  return {
    harness: "codex",
    sessionId,
    nativeThreadId: context.threadId,
    nativeTurnId: context.turnId,
  };
}

function normalizeDelta(
  sessionId: string,
  context: CodexAppServerContext,
  params: Record<string, unknown>,
): CodexAppServerEvent[] {
  if (params.threadId !== context.threadId || params.turnId !== context.turnId) {
    return [];
  }
  if (!nonEmpty(params.itemId)) {
    return [];
  }
  if (typeof params.delta !== "string") {
    return [];
  }
  return [
    {
      ...baseEvent(sessionId, context),
      kind: "message_delta",
      text: params.delta,
      nativeItemId: params.itemId,
    },
  ];
}

function summarizeCommandResult(item: Record<string, unknown>): string | undefined {
  if (typeof item.exitCode === "number" && Number.isInteger(item.exitCode)) {
    return `exit code ${item.exitCode}`;
  }
  return undefined;
}

function summarizeFileChange(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return `${changes.length} file(s) changed`;
}

function normalizeItemEvent(
  sessionId: string,
  context: CodexAppServerContext,
  params: Record<string, unknown>,
  phase: "started" | "completed",
): CodexAppServerEvent[] {
  if (params.threadId !== context.threadId || params.turnId !== context.turnId) {
    return [];
  }
  const item = params.item;
  if (!isRecord(item)) {
    return [];
  }
  if (item.type !== "commandExecution" && item.type !== "fileChange") {
    return [];
  }
  if (!nonEmpty(item.id)) {
    return [];
  }
  const isCommand = item.type === "commandExecution";
  const toolTitle = isCommand ? "command" : "fileChange";
  const status = nativeToolStatus(item, isCommand);
  if (status === undefined) {
    return [];
  }
  if (phase === "started") {
    const event: CodexAppServerEvent = {
      ...baseEvent(sessionId, context),
      kind: "tool_call",
      toolCallId: item.id,
      toolTitle,
      toolStatus: status,
      nativeItemId: item.id,
    };
    if (!isCommand) {
      event.text = summarizeFileChange(item);
    }
    return [event];
  }
  const event: CodexAppServerEvent = {
    ...baseEvent(sessionId, context),
    kind: "tool_result",
    toolCallId: item.id,
    toolTitle,
    toolStatus: status,
    nativeItemId: item.id,
  };
  if (isCommand) {
    const summary = summarizeCommandResult(item);
    if (summary !== undefined) {
      event.text = summary;
    }
  } else {
    event.text = summarizeFileChange(item);
  }
  return [event];
}

function normalizeTurnCompleted(
  sessionId: string,
  context: CodexAppServerContext,
  params: Record<string, unknown>,
): CodexAppServerEvent[] {
  if (params.threadId !== context.threadId) {
    return [];
  }
  const turn = params.turn;
  if (!isRecord(turn)) {
    return [];
  }
  if (turn.id !== context.turnId) {
    return [];
  }
  if (turn.status === "completed") {
    return [
      {
        ...baseEvent(sessionId, context),
        kind: "turn_complete",
        nativeOutcome: "completed",
      },
    ];
  }
  if (turn.status === "failed") {
    const error = isRecord(turn.error) ? turn.error : null;
    const message =
      error !== null && typeof error.message === "string" && error.message.length > 0
        ? boundText(error.message)
        : FALLBACK_TURN_ERROR;
    return [
      {
        ...baseEvent(sessionId, context),
        kind: "error",
        text: message,
        nativeOutcome: "failed",
      },
    ];
  }
  if (turn.status === "interrupted") {
    return [
      {
        ...baseEvent(sessionId, context),
        kind: "status",
        text: "turn interrupted",
        nativeOutcome: "interrupted",
      },
    ];
  }
  return [];
}

/**
 * Normalize Codex app-server notifications for one continuing session turn.
 * Pure mapping only: no session ownership, persistence, approval handling or
 * de-duplication. Unknown or malformed input returns [].
 *
 * Validation is limited to the fields the mapper consumes (method framing,
 * thread/turn/item ids, item type/status, turn status/error). Other payload
 * content, such as the turn items array, is not schema-validated.
 */
export function normalizeCodexAppServerEvent(
  sessionId: string,
  context: CodexAppServerContext,
  raw: unknown,
): CodexAppServerEvent[] {
  if (!nonEmpty(sessionId)) {
    return [];
  }
  if (!isRecord(context) || !nonEmpty(context.threadId) || !nonEmpty(context.turnId)) {
    return [];
  }
  if (!isRecord(raw)) {
    return [];
  }
  if ("id" in raw) {
    return [];
  }
  if (typeof raw.method !== "string") {
    return [];
  }
  if (!isRecord(raw.params)) {
    return [];
  }
  switch (raw.method) {
    case "item/agentMessage/delta":
      return normalizeDelta(sessionId, context, raw.params);
    case "item/started":
      return normalizeItemEvent(sessionId, context, raw.params, "started");
    case "item/completed":
      return normalizeItemEvent(sessionId, context, raw.params, "completed");
    case "turn/completed":
      return normalizeTurnCompleted(sessionId, context, raw.params);
    default:
      return [];
  }
}
