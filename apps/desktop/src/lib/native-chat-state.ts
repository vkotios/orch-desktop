import type {
  NativeEffort,
  NativeController,
  NativeClarificationAck,
  NativeClarificationRequest,
  NativeModelInfo,
  NativeOutcomeKind,
  NativePollEvent,
  NativeRole,
  NativeSendAck,
} from "./api";

/**
 * Pure UI state for the native Codex chat view.
 *
 * The component owns the polling loop and all RPC; this module owns the
 * routing rules so they stay testable without a host:
 * - an event applies only to its exact UI session/turn (stale, finished, or
 *   foreign turns never resurrect or pollute active state);
 * - contradictory native identities make the session unavailable;
 * - terminal outcomes always release the active turn and pending approvals.
 */

export const NATIVE_POLL_INTERVAL_MS = 150;
export const NATIVE_MAX_SESSIONS = 8;
export const NATIVE_MAX_APPROVALS = 8;
export const NATIVE_MAX_CLARIFICATIONS = 4;
export const NATIVE_ACTIVATION_TIMEOUT_MS = 15_000;

export interface NativeToolStep {
  id: string;
  title: string;
  status: string;
}

export interface NativeChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: NativeToolStep[];
  statusText?: string;
  outcome?: NativeOutcomeKind;
  outcomeNote?: string;
  isError?: boolean;
  isStreaming: boolean;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeSessionId?: string;
  nativeUserMessageId?: string;
  nativeMessageId?: string;
  requestedNativeSessionId?: string;
  requestedNativeUserMessageId?: string;
}

export interface NativeApprovalRequest {
  approvalId: string;
  approvalType: "command" | "file" | "tool";
  text: string;
  decisions: Array<"accept" | "decline" | "cancel">;
  sessionId: string;
  turnId: string;
}

export interface NativeUiSession {
  id: string;
  controller: NativeController;
  title: string;
  model: string;
  role: NativeRole;
  effort?: NativeEffort;
  messages: NativeChatMessage[];
  approvals: NativeApprovalRequest[];
  clarifications: NativeClarificationRequest[];
  activeTurnId: string | null;
  busy: boolean;
  cancelling: boolean;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  nativeSessionId: string | null;
  requestedNativeSessionId: string | null;
  /** Model/role lock once the native thread exists (first send). */
  threadStarted: boolean;
  unavailable: boolean;
  /** True once any live (non-durable) event has advanced the active turn. */
  liveTurnProgress: boolean;
  /** Durable part ids already applied for the active turn (dedupe). */
  appliedDurableParts: string[];
}

export function defaultNativeModel(models: NativeModelInfo[]): string {
  return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? "";
}

export function createNativeUiSession(
  id: string,
  model: string,
  role: NativeRole = "implement",
  effort: NativeEffort | undefined = "medium",
  controller: NativeController = "codex",
): NativeUiSession {
  return {
    id,
    controller,
    title: "New chat",
    model,
    role,
    effort,
    messages: [],
    approvals: [],
    clarifications: [],
    activeTurnId: null,
    busy: false,
    cancelling: false,
    nativeThreadId: null,
    nativeTurnId: null,
    nativeSessionId: null,
    requestedNativeSessionId: null,
    threadStarted: false,
    unavailable: false,
    liveTurnProgress: false,
    appliedDurableParts: [],
  };
}

/** Records the user prompt plus an assistant placeholder for a fresh UI turn. */
export function beginNativeTurn(
  session: NativeUiSession,
  turnId: string,
  prompt: string,
): NativeUiSession {
  if (session.activeTurnId || session.unavailable) return session;
  const title =
    session.messages.length === 0
      ? prompt.slice(0, 42) + (prompt.length > 42 ? "…" : "")
      : session.title;
  return {
    ...session,
    title,
    messages: [
      ...session.messages,
      { id: `user-${turnId}`, role: "user", text: prompt, tools: [], isStreaming: false },
      { id: turnId, role: "assistant", text: "", tools: [], isStreaming: true },
    ],
    activeTurnId: turnId,
    busy: true,
    cancelling: false,
    nativeTurnId: null,
    liveTurnProgress: false,
    appliedDurableParts: [],
  };
}

function assistantByTurn(
  session: NativeUiSession,
  turnId: string,
): { index: number } {
  return {
    index: session.messages.findIndex(
      (m) => m.id === turnId && m.role === "assistant",
    ),
  };
}

function finishTurn(
  session: NativeUiSession,
  turnId: string,
  outcome: NativeOutcomeKind,
  note: string | undefined,
  isError: boolean,
): NativeUiSession {
  const { index } = assistantByTurn(session, turnId);
  const messages =
    index === -1
      ? session.messages
      : session.messages.map((m, i) =>
          i === index
            ? {
                ...m,
                isStreaming: false,
                statusText: undefined,
                outcome,
                outcomeNote: note || undefined,
                isError: m.isError || isError,
              }
            : m,
        );
  return {
    ...session,
    messages,
    approvals: [],
    clarifications: [],
    activeTurnId: null,
    busy: false,
    cancelling: false,
    nativeTurnId: null,
    liveTurnProgress: false,
    appliedDurableParts: [],
  };
}

/**
 * Applies the send acknowledgement. A terminal outcome may already have been
 * applied from an early event batch; its recorded identity still validates the
 * ACK without resurrecting the turn.
 */
export function applyNativeAck(
  session: NativeUiSession,
  ack: NativeSendAck,
  generation: string,
): NativeUiSession {
  if (ack.generation !== generation || ack.sessionId !== session.id) return session;
  const message = session.messages.find((m) => m.id === ack.turnId && m.role === "assistant");
  if (!message) return session;
  if (ack.controller === "claude") {
    const mismatch = session.controller !== "claude" || ack.submitted !== true ||
      !ack.requestedNativeSessionId || !ack.requestedNativeUserMessageId ||
      (session.requestedNativeSessionId && session.requestedNativeSessionId !== ack.requestedNativeSessionId) ||
      (session.nativeSessionId && session.nativeSessionId !== ack.requestedNativeSessionId) ||
      (message.nativeSessionId && message.nativeSessionId !== ack.requestedNativeSessionId) ||
      (message.nativeUserMessageId && message.nativeUserMessageId !== ack.requestedNativeUserMessageId) ||
      (message.requestedNativeSessionId && message.requestedNativeSessionId !== ack.requestedNativeSessionId) ||
      (message.requestedNativeUserMessageId && message.requestedNativeUserMessageId !== ack.requestedNativeUserMessageId);
    if (mismatch) {
      const note = "The host acknowledged a different provider turn.";
      return markNativeUnavailable(updateAssistant(session, ack.turnId, (m) => ({ ...m, outcome: "unknown", outcomeNote: note, isError: true, isStreaming: false })), note);
    }
    const bound = updateAssistant(session, ack.turnId, (m) => ({ ...m,
      requestedNativeSessionId: ack.requestedNativeSessionId,
      requestedNativeUserMessageId: ack.requestedNativeUserMessageId }));
    return { ...bound, requestedNativeSessionId: ack.requestedNativeSessionId, threadStarted: true };
  }
  if (
    session.controller !== "codex" ||
    (session.nativeThreadId && session.nativeThreadId !== ack.nativeThreadId) ||
    (message.nativeThreadId && message.nativeThreadId !== ack.nativeThreadId) ||
    (message.nativeTurnId && message.nativeTurnId !== ack.nativeTurnId)
  ) {
    const note = "The host acknowledged a different provider turn.";
    const marked = updateAssistant(session, ack.turnId, (m) => ({ ...m, outcome: "unknown", outcomeNote: note, isError: true, isStreaming: false }));
    return markNativeUnavailable(marked, note);
  }
  const bound = updateAssistant(session, ack.turnId, (m) => ({ ...m, nativeThreadId: ack.nativeThreadId, nativeTurnId: ack.nativeTurnId }));
  return {
    ...bound,
    nativeThreadId: ack.nativeThreadId,
    nativeTurnId: session.activeTurnId === ack.turnId ? ack.nativeTurnId : session.nativeTurnId,
    threadStarted: true,
  };
}

function updateAssistant(
  session: NativeUiSession,
  turnId: string,
  update: (m: NativeChatMessage) => NativeChatMessage,
): NativeUiSession {
  const { index } = assistantByTurn(session, turnId);
  if (index === -1) return session;
  return {
    ...session,
    messages: session.messages.map((m, i) => (i === index ? update(m) : m)),
  };
}

export function applyNativeUiEvent(
  session: NativeUiSession,
  event: NativePollEvent,
  generation: string,
): NativeUiSession {
  if (event.generation !== generation || event.sessionId !== session.id ||
      !event.turnId || session.activeTurnId !== event.turnId) {
    return session;
  }
  // Catch-up recovers lost poll text by stable part identity on both live and
  // durable delivery. Ignore durable terminals when the turn is already finished.
  if (event.source === "durable" && (event.kind === "turn_complete" || event.kind === "error" || event.nativeOutcome) && !session.busy) {
    return session;
  }
  if (
    event.kind === "message_delta" &&
    typeof event.partId === "string" &&
    session.appliedDurableParts.includes(event.partId)
  ) {
    return session;
  }
  const turnId = event.turnId;
  const message = session.messages.find((m) => m.id === turnId && m.role === "assistant");
  if (!message) return session;
  if (event.source !== "durable") {
    session = { ...session, liveTurnProgress: true };
  }
  const controller = event.controller ?? "codex";
  if (controller !== session.controller) return markNativeUnavailable(session, "Conflicting native controller.");
  if (controller === "claude") {
    if (event.nativeThreadId || event.nativeTurnId ||
        (event.nativeSessionId && session.nativeSessionId && event.nativeSessionId !== session.nativeSessionId) ||
        (event.nativeSessionId && session.requestedNativeSessionId && event.nativeSessionId !== session.requestedNativeSessionId) ||
        (event.nativeSessionId && message.requestedNativeSessionId && event.nativeSessionId !== message.requestedNativeSessionId) ||
        (event.nativeSessionId && message.nativeSessionId && event.nativeSessionId !== message.nativeSessionId) ||
        (event.nativeUserMessageId && message.requestedNativeUserMessageId && event.nativeUserMessageId !== message.requestedNativeUserMessageId) ||
        (event.nativeUserMessageId && message.nativeUserMessageId && event.nativeUserMessageId !== message.nativeUserMessageId)) {
      return markNativeUnavailable(session, "Conflicting native conversation identity.");
    }
    if (event.nativeSessionId || event.nativeUserMessageId || event.nativeMessageId) {
      session = updateAssistant(session, turnId, (m) => ({ ...m,
        nativeSessionId: event.nativeSessionId ?? m.nativeSessionId,
        nativeUserMessageId: event.nativeUserMessageId ?? m.nativeUserMessageId,
        nativeMessageId: event.nativeMessageId ?? m.nativeMessageId }));
      session = { ...session, nativeSessionId: event.nativeSessionId ?? session.nativeSessionId,
        threadStarted: session.threadStarted || Boolean(event.nativeSessionId) };
    }
  } else if (event.nativeSessionId || event.nativeUserMessageId || event.nativeMessageId) {
    return markNativeUnavailable(session, "Conflicting native controller identity.");
  }
  if ((event.nativeThreadId && session.nativeThreadId && event.nativeThreadId !== session.nativeThreadId) ||
      (event.nativeThreadId && message.nativeThreadId && event.nativeThreadId !== message.nativeThreadId) ||
      (event.nativeTurnId && message.nativeTurnId && event.nativeTurnId !== message.nativeTurnId)) {
    return markNativeUnavailable(session, "Conflicting native turn identity.");
  }
  if (event.nativeThreadId || event.nativeTurnId) {
    session = updateAssistant(session, turnId, (m) => ({
      ...m, nativeThreadId: event.nativeThreadId ?? m.nativeThreadId,
      nativeTurnId: event.nativeTurnId ?? m.nativeTurnId,
    }));
    session = { ...session, nativeThreadId: event.nativeThreadId ?? session.nativeThreadId,
      nativeTurnId: event.nativeTurnId ?? session.nativeTurnId,
      threadStarted: session.threadStarted || Boolean(event.nativeThreadId) };
  }

  if (event.nativeOutcome) {
    const outcome = event.nativeOutcome;
    const finished = finishTurn(session, turnId, outcome, outcome === "completed" ? undefined : event.text,
      outcome === "failed" || outcome === "unknown");
    return outcome === "unknown" ? { ...finished, unavailable: true } : finished;
  }

  switch (event.kind) {
    case "message_delta": {
      if (!event.text) return session;
      let next = updateAssistant(session, turnId, (m) => ({
        ...m,
        text: m.text + (event.text as string),
      }));
      if (typeof event.partId === "string") {
        next = {
          ...next,
          appliedDurableParts: [...next.appliedDurableParts, event.partId],
        };
      }
      return next;
    }
    case "tool_call": {
      if (!event.toolCallId) return session;
      const step: NativeToolStep = {
        id: event.toolCallId,
        title: event.toolTitle || "tool",
        status: event.toolStatus || "running",
      };
      return updateAssistant(session, turnId, (m) => {
        const existing = m.tools.findIndex((t) => t.id === step.id);
        const tools =
          existing === -1
            ? [...m.tools, step]
            : m.tools.map((t, i) => (i === existing ? step : t));
        return { ...m, tools };
      });
    }
    case "status": {
      if (!event.text) return session;
      return updateAssistant(session, turnId, (m) => ({
        ...m,
        statusText: event.text,
      }));
    }
    case "approval": {
      if (!event.approvalId || !event.approvalType) return session;
      if (
        session.approvals.some((a) => a.approvalId === event.approvalId) ||
        session.approvals.length >= NATIVE_MAX_APPROVALS
      ) {
        return session;
      }
      const approval: NativeApprovalRequest = {
        approvalId: event.approvalId,
        approvalType: event.approvalType,
        text: (event.text || "").slice(0, 4096),
        decisions: (event.decisions ?? []).filter((d) => d === "accept" || d === "decline" || d === "cancel"),
        sessionId: session.id,
        turnId,
      };
      return { ...session, approvals: [...session.approvals, approval] };
    }
    case "approval_resolved": {
      if (!event.approvalId) return session;
      return { ...session, approvals: session.approvals.filter((a) => a.approvalId !== event.approvalId || a.turnId !== turnId) };
    }
    case "clarification": {
      if (session.cancelling || !event.clarificationId || !event.nativeItemId ||
          typeof event.isBlocking !== "boolean" || !Array.isArray(event.questions) ||
          event.questions.length === 0 || event.questions.length > 4 ||
          session.clarifications.length >= NATIVE_MAX_CLARIFICATIONS ||
          session.clarifications.some((q) => q.clarificationId === event.clarificationId)) return session;
      if (!event.questions.every((q) => q && typeof q.id === "string" && q.id.length > 0 &&
          typeof q.header === "string" && typeof q.question === "string" &&
          typeof q.multiSelect === "boolean" && typeof q.isOther === "boolean" &&
          (q.options === null || (Array.isArray(q.options) && q.options.length <= 8 &&
            q.options.every((o) => o && typeof o.label === "string" && typeof o.description === "string"))))) return session;
      const clarification: NativeClarificationRequest = {
        clarificationId: event.clarificationId, nativeItemId: event.nativeItemId,
        isBlocking: event.isBlocking, questions: event.questions, sessionId: session.id, turnId, answering: false,
      };
      return { ...session, clarifications: [...session.clarifications, clarification] };
    }
    case "clarification_resolved": {
      if (!event.clarificationId) return session;
      return { ...session, clarifications: session.clarifications.filter((q) => q.clarificationId !== event.clarificationId || q.turnId !== turnId) };
    }
    case "clarification_answered": {
      if (!event.clarificationId || typeof event.submitted !== "boolean") return session;
      const matching = session.clarifications.some((q) => q.clarificationId === event.clarificationId && q.turnId === turnId);
      if (!matching) return session;
      if (event.submitted || event.reason === "stale") {
        return { ...session, clarifications: session.clarifications.filter((q) => !(q.clarificationId === event.clarificationId && q.turnId === turnId)) };
      }
      if (event.reason !== "invalid" && event.reason !== "not_sent") return session;
      return { ...session, clarifications: session.clarifications.map((q) => q.clarificationId === event.clarificationId && q.turnId === turnId
        ? { ...q, answering: false, answerError: typeof event.message === "string" ? event.message.slice(0, 512) : undefined }
        : q) };
    }
    case "error": {
      return updateAssistant(session, turnId, (m) => ({ ...m, statusText: event.text || "The turn reported an error.", isError: true }));
    }
    default:
      return session;
  }
}

export interface NativePollBatchResult {
  sessions: NativeUiSession[];
  consumed: number;
  stale: number;
}

/** Applies one drained mailbox batch; stale generations are never replayed. */
export function applyNativePollBatch(
  sessions: NativeUiSession[],
  generation: string,
  events: NativePollEvent[],
): NativePollBatchResult {
  let next = sessions;
  let consumed = 0;
  let stale = 0;
  for (const event of events) {
    if (event.generation !== generation) {
      stale += 1;
      continue;
    }
    const index = next.findIndex((s) => s.id === event.sessionId);
    if (index === -1) continue;
    const updated = applyNativeUiEvent(next[index], event, generation);
    if (updated !== next[index]) {
      next = next.map((s, i) => (i === index ? updated : s));
      consumed += 1;
    }
  }
  return { sessions: next, consumed, stale };
}

/** Marks a turn as stopping; displayed approvals are invalidated with it. */
export function markNativeCancelling(session: NativeUiSession): NativeUiSession {
  if (!session.activeTurnId || session.cancelling) return session;
  return { ...session, cancelling: true, approvals: [], clarifications: [] };
}

/** Mark the current prompt before invoking the queued answer command. */
export function markNativeClarificationAnswering(session: NativeUiSession, clarificationId: string, turnId: string): NativeUiSession {
  if (session.activeTurnId !== turnId || session.cancelling || session.unavailable) return session;
  const question = session.clarifications.find((q) => q.clarificationId === clarificationId && q.turnId === turnId);
  if (!question || question.answering) return session;
  return { ...session, clarifications: session.clarifications.map((q) => q === question ? { ...q, answering: true, answerError: undefined } : q) };
}

/** Clear local pending state when submission fails before it can be queued. */
export function resetNativeClarificationAnswering(session: NativeUiSession, clarificationId: string, turnId: string, message?: string): NativeUiSession {
  if (session.activeTurnId !== turnId) return session;
  const question = session.clarifications.find((q) => q.clarificationId === clarificationId && q.turnId === turnId);
  if (!question) return session;
  return { ...session, clarifications: session.clarifications.map((q) => q === question ? { ...q, answering: false, answerError: message?.slice(0, 512) } : q) };
}

/** Queue admission is not answer submission or provider completion. */
export function applyNativeClarificationAck(
  session: NativeUiSession, ack: NativeClarificationAck, generation: string,
): NativeUiSession {
  if (ack.generation !== generation || ack.sessionId !== session.id ||
      !session.activeTurnId || ack.turnId !== session.activeTurnId ||
      !session.clarifications.some((q) => q.clarificationId === ack.clarificationId && q.turnId === ack.turnId)) return session;
  if (ack.controller !== session.controller) return markNativeUnavailable(session, "Conflicting native controller.");
  if (ack.queued === false && ack.reason === "stale") {
    return { ...session, clarifications: session.clarifications.filter((q) => !(q.clarificationId === ack.clarificationId && q.turnId === ack.turnId)) };
  }
  return session;
}

export function failNativeTurn(session: NativeUiSession, turnId: string, note: string, outcome: "failed" | "unknown"): NativeUiSession {
  if (session.activeTurnId !== turnId) return session;
  const finished = finishTurn(session, turnId, outcome, note, true);
  return outcome === "unknown" ? { ...finished, unavailable: true } : finished;
}

export function markNativeUnavailable(session: NativeUiSession, note: string): NativeUiSession {
  const stopped = session.activeTurnId ? failNativeTurn(session, session.activeTurnId, note, "unknown") : session;
  return { ...stopped, unavailable: true, approvals: [], clarifications: [], busy: false, cancelling: false };
}
