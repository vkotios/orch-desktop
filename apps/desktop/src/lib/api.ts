import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { HarnessId } from "@cho-desktop/acp-client";

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  provider: string;
  transport: string;
  defaultModel: string;
  suggestedModels: string[];
  roles: string[];
  envStripped: string[];
  installed: boolean;
  executablePath: string | null;
  authHint: string;
}

export interface RepositoryInfo {
  path: string;
  name: string;
  branch: string;
  adopted: boolean;
}

export interface StreamEventPayload {
  sessionId: string;
  turnId: string;
  harness: HarnessId;
  kind:
    | "status"
    | "message_delta"
    | "thought_delta"
    | "tool_call"
    | "model_verified"
    | "error"
    | "turn_complete";
  text?: string;
  model?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolStatus?: string;
  executablePath?: string;
  pid?: number;
  exitCode?: number;
}

export interface OrchClaim {
  wp: string;
  by: string;
  claimed_at?: string;
  session?: string;
  note?: string;
}

export interface OrchWorktree {
  id?: string;
  wp: string;
  slice: string;
  branch?: string;
  path: string;
  base?: string;
}

export interface OrchRunSummary {
  id: string;
  cli: string;
  model_requested?: string;
  model_canonical?: string;
  model_actual?: string | null;
  role?: string;
  status: string;
  derived_status?: string;
  derived_reason?: string;
  wp?: string | null;
  slice?: string | null;
  dir?: string;
  repository?: string | null;
  worker_pid?: number | null;
  created_at?: string;
  started_at?: string;
  ended_at?: string | null;
  exit_code?: number | null;
}

export interface OrchRunDetail {
  runId: string;
  status: OrchRunSummary & Record<string, any>;
  result: Record<string, any> | null;
  cleanResponseText: string;
  toolCalls: Array<{
    id: string;
    title: string;
    detail: string;
    status: string;
  }>;
  thoughts: string[];
  verifiedModel: string | null;
  logs: {
    stdout: string;
    stderr: string;
    keeper: string;
  };
}

export interface OrchRosterEntry {
  cli: string;
  model: string;
  family?: string;
  lane?: string;
  workloads?: string[];
  cost_class?: string;
  requires_permission?: boolean;
  playbook_note?: string;
}

export interface OrchDashboardData {
  repoRoot: string;
  repositories?: RepositoryInfo[];
  rosterSource: string;
  claims: OrchClaim[];
  worktrees: OrchWorktree[];
  runs: OrchRunSummary[];
  roster: OrchRosterEntry[];
  catalog: Array<{
    id: string;
    provider: string;
    name: string;
    model: string;
    contextTokens?: number;
  }>;
  harnesses: HarnessInfo[];
}

export interface OrchCommandResult<T = any> {
  ok: boolean;
  exitCode: number;
  output: T | null;
  text: string;
  error?: string | null;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Dual-transport RPC helper: uses Tauri `invoke` when running inside the native Rust shell,
 * or transparently calls the local Node 24 bridge (`/api/invoke`) in standalone desktop mode.
 */
export async function callHost<T>(
  command: string,
  args: Record<string, any> = {},
): Promise<T> {
  if (isTauriRuntime()) {
    // Prefer the generic host_invoke for orch/discovery so new allow-listed
    // commands do not each need a dedicated Tauri command wrapper.
    if (
      command === "discover_harnesses" ||
      command === "orch_dashboard" ||
      command.startsWith("orch_")
    ) {
      return tauriInvoke<T>("host_invoke", { command, args });
    }
    return tauriInvoke<T>(command, { args });
  }
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("The local host is unavailable. Start it and try again.");
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Host command ${command} failed`);
  }
  return data.result as T;
}

/**
 * Subscribes to real-time stream events from either Tauri Event IPC or the Node 24 SSE bridge.
 */
export function subscribeStreamEvents(
  handler: (payload: StreamEventPayload) => void,
): () => void {
  if (isTauriRuntime()) {
    let unlistenFn: (() => void) | null = null;
    tauriListen<StreamEventPayload>("cho:stream", (event) => {
      handler(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }

  const es = new EventSource("/api/events");
  const listener = (evt: MessageEvent) => {
    try {
      const payload = JSON.parse(evt.data) as StreamEventPayload;
      handler(payload);
    } catch {
      /* ignore malformed SSE frame */
    }
  };
  es.addEventListener("cho:stream", listener as EventListener);
  return () => {
    es.removeEventListener("cho:stream", listener as EventListener);
    es.close();
  };
}

/* ============================================================================
 * Native Codex chat (Tauri shell, first milestone).
 *
 * The native view talks to the exact backend contract through fixed Tauri
 * commands. Each command takes a single `{ args: payload }` object — never the
 * loose legacy `cho:stream` branch, which carries no native events. Outside
 * the Tauri runtime the same payload shape goes through the bridge.
 * ========================================================================== */

export type NativeRole = "implement" | "review";
export type NativeController = "codex" | "claude";
export type NativeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type NativeOutcomeKind =
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";
export type NativeDecision = "accept" | "decline" | "cancel";

export interface NativeClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
  multiSelect: boolean;
  isOther: boolean;
}

export interface NativeClarificationRequest {
  clarificationId: string;
  nativeItemId: string;
  isBlocking: boolean;
  questions: NativeClarificationQuestion[];
  sessionId: string;
  turnId: string;
  answering: boolean;
  answerError?: string;
}

export interface NativeClarificationAck {
  generation: string;
  controller: NativeController;
  sessionId: string;
  turnId: string;
  clarificationId: string;
  queued: boolean;
  reason?: "stale";
}

export interface NativeClarificationAnswerArgs {
  generation: string;
  projectToken: string;
  sessionId: string;
  turnId: string;
  clarificationId: string;
  answers: Record<string, string[]>;
}

export interface NativeModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
  resolvedModel?: string;
  supportedEfforts?: NativeEffort[];
}

export interface NativeValidateResult {
  controller?: NativeController;
  generation: string;
  path: string;
  name: string;
  projectToken: string;
}

export interface NativePrepareResult {
  controller?: NativeController;
  generation: string;
  projectToken: string;
  path: string;
  name: string;
  models: NativeModelInfo[];
}

interface NativeAckBase {
  generation: string;
  sessionId: string;
  turnId: string;
}

export interface NativeCodexSendAck extends NativeAckBase {
  controller?: "codex";
  nativeThreadId: string;
  nativeTurnId: string;
}

export interface NativeClaudeSendAck extends NativeAckBase {
  controller: "claude";
  submitted: true;
  requestedNativeSessionId: string;
  requestedNativeUserMessageId: string;
}
export type NativeSendAck = NativeCodexSendAck | NativeClaudeSendAck;

/**
 * One event drained from the backend mailbox. Every event carries the host
 * generation plus the UI session/turn it belongs to; events for the active
 * native turn additionally carry the actual native thread/turn ids once known.
 */
export interface NativePollEvent {
  generation: string;
  kind:
    | "message_delta"
    | "tool_call"
    | "status"
    | "approval"
    | "approval_resolved"
    | "clarification"
    | "clarification_resolved"
    | "clarification_answered"
    | "turn_complete"
    | "error";
  sessionId?: string;
  turnId?: string;
  harness?: string;
  controller?: NativeController;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeSessionId?: string;
  nativeUserMessageId?: string;
  nativeMessageId?: string;
  text?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolStatus?: string;
  nativeOutcome?: NativeOutcomeKind;
  approvalId?: string;
  approvalType?: "command" | "file" | "tool";
  decisions?: NativeDecision[];
  clarificationId?: string;
  nativeItemId?: string;
  isBlocking?: boolean;
  questions?: NativeClarificationQuestion[];
  submitted?: boolean;
  reason?: "stale" | "invalid" | "not_sent";
  message?: string;
}

export interface NativePollResult {
  generation: string;
  events: NativePollEvent[];
}

/** Fixed native transport: `invoke(command, { args: payload })` only. */
async function invokeNative<T>(
  command: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(command, { args: payload });
  }
  return callHost<T>(command, payload);
}

export function nativeChatPickProjectFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.reject(new Error("Folder selection is available only in the desktop app."));
  return tauriInvoke<string | null>("native_pick_project_folder");
}

export function nativeChatValidateProject(
  path: string,
  controller: NativeController = "codex",
): Promise<NativeValidateResult> {
  return invokeNative<NativeValidateResult>("native_chat_validate_project", {
    path,
    controller,
  });
}

export function nativeChatPrepareProject(
  projectToken: string,
  controller: NativeController = "codex",
): Promise<NativePrepareResult> {
  return invokeNative<NativePrepareResult>("native_chat_prepare_project", {
    projectToken,
    controller,
    trusted: true,
  });
}

export interface NativeSendArgs {
  generation: string;
  projectToken: string;
  sessionId: string;
  turnId: string;
  model: string;
  prompt: string;
  role: NativeRole;
  effort?: NativeEffort;
}

export function nativeChatSend(args: NativeSendArgs): Promise<NativeSendAck> {
  return invokeNative<NativeSendAck>("direct_chat_send", { ...args });
}

export function nativeChatPoll(
  generation: string,
  projectToken: string,
): Promise<NativePollResult> {
  return invokeNative<NativePollResult>("native_chat_poll", {
    generation,
    projectToken,
  });
}

export interface NativeRespondArgs {
  generation: string;
  projectToken: string;
  sessionId: string;
  turnId: string;
  approvalId: string;
  decision: NativeDecision;
}

export function nativeChatRespond(
  args: NativeRespondArgs,
): Promise<unknown> {
  return invokeNative<unknown>("native_chat_respond", { ...args });
}

export function nativeChatAnswer(args: NativeClarificationAnswerArgs): Promise<NativeClarificationAck> {
  return invokeNative<NativeClarificationAck>("native_chat_answer", { ...args });
}

export interface NativeCancelArgs {
  generation: string;
  projectToken: string;
  sessionId: string;
  turnId: string;
}

export function nativeChatCancel(
  args: NativeCancelArgs,
): Promise<{ cancelling: boolean }> {
  return invokeNative<{ cancelling: boolean }>("direct_chat_cancel", {
    ...args,
  });
}

export function nativeChatClose(
  generation: string,
  projectToken: string,
): Promise<unknown> {
  return invokeNative<unknown>("native_chat_close", {
    generation,
    projectToken,
  });
}

export interface NativeConversationSummary {
  id: string;
  controller: NativeController;
  title: string;
  modelRequested: string | null;
  role: NativeRole | null;
  effort: NativeEffort | null;
  updatedAtMs: number;
}

export interface NativeHydratedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: Array<{ id: string; title: string; status: string }>;
  outcome?: NativeOutcomeKind;
  isError?: boolean;
  isStreaming: boolean;
  nativeTurnId?: string;
}

export interface NativeHydratedConversation {
  conversationId: string;
  projectId: string;
  controller: NativeController;
  model: string | null;
  role: NativeRole | null;
  effort: NativeEffort | null;
  title: string;
  nativeThreadId: string | null;
  nativeSessionUuid: string | null;
  messages: NativeHydratedMessage[];
  eventTip: number;
  hasMoreEvents: boolean;
}

export function nativeChatListConversations(
  generation: string,
  projectToken: string,
): Promise<{ generation: string; projectId?: string; conversations: NativeConversationSummary[] }> {
  return invokeNative("native_chat_list_conversations", { generation, projectToken });
}

export function nativeChatHydrateConversation(
  generation: string,
  projectToken: string,
  conversationId: string,
): Promise<{ generation: string; conversation: NativeHydratedConversation | null }> {
  return invokeNative("native_chat_hydrate_conversation", {
    generation,
    projectToken,
    conversationId,
  });
}
