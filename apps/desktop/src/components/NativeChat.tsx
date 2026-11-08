import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Dialog, Icon } from "./Chrome";
import { FormattedMarkdown } from "./FormattedMarkdown";
import { NativeClarificationCard } from "./NativeClarificationCard";
import { OrchAgentsPanel } from "./OrchAgentsPanel";
import {
  nativeChatAcknowledgeStranded, nativeChatAnswer, nativeChatArchiveConversation, nativeChatCancel, nativeChatClose,
  nativeChatExportConversation, nativeChatGetDraft, nativeChatHydrateConversation,
  nativeChatImportTranscript, nativeChatListConversations, nativeChatListDraftConflicts, nativeChatPoll,
  nativeChatPrepareProject, nativeChatRenameConversation, nativeChatResolveDraftConflict,
  nativeChatRespond, nativeChatSaveDraft, nativeChatSend, nativeChatValidateProject,
  nativeChatPickProjectFolder,
  type NativeClarificationRequest, type NativeController, type NativeDecision, type NativeEffort,
  type NativeEventCursor, type NativeHydratedConversation, type NativeModelInfo,
  type NativePrepareResult, type NativeRecoveryUnresolved, type NativeRole, type NativeValidateResult,
} from "../lib/api";
import {
  applyNativeAck, applyNativeClarificationAck, applyNativePollBatch, beginNativeTurn, createNativeUiSession,
  defaultNativeModel, failNativeTurn, markNativeCancelling, markNativeClarificationAnswering, markNativeUnavailable,
  NATIVE_MAX_SESSIONS, NATIVE_POLL_INTERVAL_MS, type NativeUiSession,
} from "../lib/native-chat-state";
import { shouldSendOnComposerKey } from "../lib/composer-keyboard";
import "./native-chat.css";

type Project = NativePrepareResult;
type PollOwner = { project: Project; stopped: boolean; timer?: ReturnType<typeof setTimeout> };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const effortNames: NativeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const labelController = (controller: NativeController) => controller === "claude" ? "Claude" : "Codex";
function modelEfforts(controller: NativeController, model: NativeModelInfo | undefined): NativeEffort[] {
  return controller === "codex" ? effortNames.filter((e) => e !== "max") : effortNames.filter((e) => model?.supportedEfforts?.includes(e));
}
function createProjectChat(p: Project): NativeUiSession {
  const controller = p.controller ?? "codex";
  const model = defaultNativeModel(p.models);
  const available = modelEfforts(controller, p.models.find((m) => m.id === model));
  const effort = available.includes("medium") ? "medium" : available[0];
  return { ...createNativeUiSession(crypto.randomUUID(), model, "implement", effort, controller), effort };
}

function sessionFromHydrated(p: Project, hydrated: NativeHydratedConversation): NativeUiSession {
  const controller = hydrated.controller ?? p.controller ?? "codex";
  const model = hydrated.model && p.models.some((m) => m.id === hydrated.model)
    ? hydrated.model
    : defaultNativeModel(p.models);
  const role = hydrated.role === "review" ? "review" : "implement";
  const available = modelEfforts(controller, p.models.find((m) => m.id === model));
  const effort = (hydrated.effort && available.includes(hydrated.effort as NativeEffort)
    ? hydrated.effort
    : available.includes("medium") ? "medium" : available[0]) as NativeEffort | undefined;
  const base = createNativeUiSession(hydrated.conversationId, model, role, effort, controller);
  return {
    ...base,
    title: hydrated.title || base.title,
    messages: hydrated.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      tools: m.tools ?? [],
      outcome: m.outcome,
      isError: m.isError,
      isStreaming: false,
      nativeTurnId: m.nativeTurnId,
    })),
    nativeThreadId: hydrated.nativeThreadId,
    nativeSessionId: hydrated.nativeSessionUuid,
    threadStarted: hydrated.nativeThreadId !== null || hydrated.nativeSessionUuid !== null,
  };
}

type DraftMeta = {
  version: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  chain?: Promise<void>;
  inflight?: boolean;
  pendingText?: string | null;
};

export function NativeChat() {
  const [project, setProject] = useState<Project | null>(null);
  const [controller, setController] = useState<NativeController>("codex");
  const [challenge, setChallenge] = useState<NativeValidateResult | null>(null);
  const [path, setPath] = useState("");
  const [sessions, setSessions] = useState<NativeUiSession[]>([]);
  const sessionsRef = useRef<NativeUiSession[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [recoveryUnresolved, setRecoveryUnresolved] = useState<NativeRecoveryUnresolved[]>([]);
  const [lost, setLost] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [pendingDecisions, setPendingDecisions] = useState<string[]>([]);
  const decisionsRef = useRef(new Set<string>());
  const answerRef = useRef(new Set<string>());
  const ownerRef = useRef<PollOwner | null>(null);
  const sendRef = useRef(false);
  const actionRef = useRef(false);
  const mounted = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<Map<string, NativeEventCursor | null>>(new Map());
  const draftMetaRef = useRef<Map<string, DraftMeta>>(new Map());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const current = sessions.find((s) => s.id === selected);
  const projectController = project?.controller ?? controller;
  const controllerName = labelController(projectController);
  const availableEfforts = modelEfforts(projectController, project?.models.find((m) => m.id === current?.model));
  const busy = sessions.some((s) => s.busy) || sendPending;
  const visibleSessions = chatSearch.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(chatSearch.trim().toLowerCase()))
    : sessions;

  function changeSessions(fn: (current: NativeUiSession[]) => NativeUiSession[]) {
    const next = fn(sessionsRef.current);
    sessionsRef.current = next;
    if (mounted.current) setSessions(next);
  }

  function stopPolling(owner: PollOwner) {
    owner.stopped = true;
    if (owner.timer) clearTimeout(owner.timer);
    if (ownerRef.current === owner) ownerRef.current = null;
  }

  function hostLost(owner: PollOwner, message: string) {
    if (owner.stopped || ownerRef.current !== owner) return;
    stopPolling(owner);
    changeSessions((all) => all.map((s) => markNativeUnavailable(s, message)));
    decisionsRef.current.clear();
    if (mounted.current) {
      setPendingDecisions([]);
      setLost(true);
      setError(`${message} Restart CHO to start a new conversation.`);
    }
  }

  function startPolling(p: Project) {
    const owner: PollOwner = { project: p, stopped: false };
    ownerRef.current = owner;
    const poll = async () => {
      if (owner.stopped || ownerRef.current !== owner) return;
      try {
        const conversationId = selectedRef.current;
        const cursor = conversationId ? (cursorRef.current.get(conversationId) ?? null) : null;
        const batch = await nativeChatPoll(p.generation, p.projectToken, conversationId
          ? { conversationId, cursor }
          : undefined);
        if (owner.stopped || ownerRef.current !== owner) return;
        if (batch.generation !== p.generation) throw new Error("Host generation changed.");
        if (batch.conversationId && batch.cursor) {
          cursorRef.current.set(batch.conversationId, batch.cursor);
        }
        changeSessions((all) => applyNativePollBatch(all, p.generation, batch.events).sessions);
        if (sessionsRef.current.some((s) => s.unavailable)) {
          hostLost(owner, "The native conversation outcome is unknown.");
          return;
        }
        const delay = batch.hasMore ? 0 : NATIVE_POLL_INTERVAL_MS;
        owner.timer = setTimeout(poll, delay);
      } catch (e) {
        hostLost(owner, `The native host connection was lost: ${errorText(e)}`);
      }
    };
    void poll();
  }

  async function loadDraftFor(conversationId: string, p: Project) {
    try {
      const result = await nativeChatGetDraft(p.generation, p.projectToken, conversationId);
      if (!mounted.current || selectedRef.current !== conversationId) return;
      const prior = draftMetaRef.current.get(conversationId) ?? { version: 0 };
      // Keep in-flight save chain/timers and any newer local edit across load.
      if (typeof prior.pendingText === "string" && prior.pendingText.length > 0) {
        setDraft(prior.pendingText);
        draftMetaRef.current.set(conversationId, {
          ...prior,
          version: result.draft && typeof result.draft.version === "number" ? result.draft.version : prior.version,
        });
        return;
      }
      if (result.draft && typeof result.draft.text === "string") {
        setDraft(result.draft.text);
        draftMetaRef.current.set(conversationId, {
          ...prior,
          version: result.draft.version,
        });
      } else {
        setDraft("");
        draftMetaRef.current.set(conversationId, { ...prior, version: 0 });
      }
    } catch {
      if (mounted.current && selectedRef.current === conversationId) setDraft("");
    }
  }

  function cancelDraftTimer(conversationId: string) {
    const prior = draftMetaRef.current.get(conversationId);
    if (prior?.saveTimer) clearTimeout(prior.saveTimer);
    if (prior) {
      draftMetaRef.current.set(conversationId, {
        ...prior,
        saveTimer: undefined,
        pendingText: null,
      });
    }
  }

  function queueDraftSave(conversationId: string, text: string) {
    const owner = ownerRef.current;
    if (!owner || lost) return;
    const prior = draftMetaRef.current.get(conversationId) ?? { version: 0 };
    if (prior.saveTimer) clearTimeout(prior.saveTimer);
    const saveTimer = setTimeout(() => {
      const meta = draftMetaRef.current.get(conversationId) ?? { version: 0 };
      draftMetaRef.current.set(conversationId, { ...meta, saveTimer: undefined, pendingText: text });
      const run = async () => {
        let current = draftMetaRef.current.get(conversationId) ?? { version: 0 };
        while (typeof current.pendingText === "string") {
          const toSave = current.pendingText;
          current = { ...current, pendingText: null, inflight: true };
          draftMetaRef.current.set(conversationId, current);
          const session = sessionsRef.current.find((s) => s.id === conversationId);
          try {
            const result = await nativeChatSaveDraft({
              generation: owner.project.generation,
              projectToken: owner.project.projectToken,
              conversationId,
              saveId: crypto.randomUUID(),
              expectedVersion: current.version,
              text: toSave,
              modelRequested: session?.model ?? null,
              effort: session?.effort ?? null,
              role: session?.role ?? "implement",
            });
            const next = draftMetaRef.current.get(conversationId) ?? current;
            if (result.saved && result.receipt && typeof result.receipt.version === "number") {
              if (result.receipt.status === "conflict") {
                draftMetaRef.current.set(conversationId, {
                  ...next,
                  version: result.receipt.version,
                  inflight: false,
                });
                if (mounted.current && selectedRef.current === conversationId) {
                  setError("Draft conflict: another copy of this chat changed the draft. Resolve or re-edit before sending.");
                }
                break;
              }
              draftMetaRef.current.set(conversationId, {
                ...next,
                version: result.receipt.version,
                inflight: false,
              });
            } else {
              draftMetaRef.current.set(conversationId, { ...next, inflight: false });
            }
          } catch {
            const next = draftMetaRef.current.get(conversationId) ?? current;
            draftMetaRef.current.set(conversationId, { ...next, inflight: false });
            break;
          }
          current = draftMetaRef.current.get(conversationId) ?? { version: 0 };
        }
      };
      const chain = (meta.chain ?? Promise.resolve()).then(run, run);
      draftMetaRef.current.set(conversationId, {
        ...(draftMetaRef.current.get(conversationId) ?? meta),
        chain,
      });
    }, 400);
    draftMetaRef.current.set(conversationId, { ...prior, saveTimer, pendingText: text });
  }

  async function flushDraftClear(conversationId: string, session: NativeUiSession, owner: PollOwner) {
    cancelDraftTimer(conversationId);
    const meta = draftMetaRef.current.get(conversationId) ?? { version: 0 };
    const wait = meta.chain ?? Promise.resolve();
    await wait.catch(() => {});
    const latest = draftMetaRef.current.get(conversationId) ?? meta;
    try {
      const result = await nativeChatSaveDraft({
        generation: owner.project.generation,
        projectToken: owner.project.projectToken,
        conversationId,
        saveId: crypto.randomUUID(),
        expectedVersion: latest.version,
        text: "",
        modelRequested: session.model,
        effort: session.effort ?? null,
        role: session.role,
      });
      if (result.saved && result.receipt && typeof result.receipt.version === "number") {
        draftMetaRef.current.set(conversationId, { version: result.receipt.version });
      }
    } catch {
      // Clearing the durable draft is best-effort around send.
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const [conversationId, meta] of draftMetaRef.current) {
        if (meta.saveTimer) clearTimeout(meta.saveTimer);
        draftMetaRef.current.set(conversationId, {
          ...meta,
          saveTimer: undefined,
        });
      }
      const owner = ownerRef.current;
      if (owner) {
        stopPolling(owner);
        void nativeChatClose(owner.project.generation, owner.project.projectToken).catch(() => {});
      }
    };
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [current?.messages]);

  async function browseProject() {
    if (actionRef.current || challenge) return;
    actionRef.current = true;
    setLoading("Choose a project folder…");
    try {
      const selectedPath = await nativeChatPickProjectFolder();
      if (mounted.current && selectedPath !== null) {
        setPath(selectedPath); setError(""); setChallenge(null);
      }
    } catch (err) { if (mounted.current) setError(errorText(err)); }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  async function validate(e: FormEvent) {
    e.preventDefault();
    if (!path.trim() || actionRef.current) return;
    actionRef.current = true;
    setLoading("Checking project…"); setError("");
    try {
      const result = await nativeChatValidateProject(path.trim(), controller);
      if ((result.controller ?? "codex") !== controller) throw new Error("The host selected a different controller.");
      if (mounted.current) setChallenge(result);
    } catch (err) { if (mounted.current) setError(errorText(err)); }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  async function prepare() {
    if (!challenge || actionRef.current) return;
    const requested = challenge;
    const selectedController = requested.controller ?? "codex";
    actionRef.current = true; setLoading(`Opening ${labelController(selectedController)} and loading models…`); setError("");
    try {
      const p = await nativeChatPrepareProject(requested.projectToken, selectedController);
      if (p.generation !== requested.generation || p.projectToken !== requested.projectToken || p.path !== requested.path || (p.controller ?? "codex") !== selectedController) {
        await nativeChatClose(p.generation, p.projectToken).catch(() => {});
        throw new Error("The prepared project did not match the confirmed project.");
      }
      if (!mounted.current) { void nativeChatClose(p.generation, p.projectToken).catch(() => {}); return; }
      setChallenge(null); setProject(p); setLost(false);
      setRecoveryUnresolved(Array.isArray(p.recoveryUnresolved) ? p.recoveryUnresolved : []);
      if (typeof p.recoveryNotice === "string" && p.recoveryNotice.length > 0) {
        setError(p.recoveryNotice);
      }
      if (!p.models.length) setError(`${labelController(selectedController)} returned no available models. Close the project and try again.`);
      else {
        let opened = createProjectChat(p);
        let hydrateNotice = "";
        try {
          const listed = await nativeChatListConversations(p.generation, p.projectToken);
          const matching = [...listed.conversations]
            .filter((c) => (c.controller ?? "codex") === selectedController)
            .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
          const restored: NativeUiSession[] = [];
          for (const entry of matching.slice(0, NATIVE_MAX_SESSIONS)) {
            try {
              const hydrated = await nativeChatHydrateConversation(p.generation, p.projectToken, entry.id);
              if (!hydrated.conversation) continue;
              const session = sessionFromHydrated(p, hydrated.conversation);
              if (hydrated.conversation.hasMoreEvents) {
                hydrateNotice = "Earlier transcript pages exist for one or more chats; only the recent window was loaded.";
                if (mounted.current) setHistoryTruncated(true);
              }
              if (!hydrated.conversation.nativeThreadId && !hydrated.conversation.nativeSessionUuid && session.messages.length > 0) {
                hydrateNotice = hydrateNotice || "A prior native session is unbound; continuing may start a new provider context. Prefer an explicit new chat if unsure.";
              }
              if (hydrated.conversation.eventCursor) {
                cursorRef.current.set(session.id, hydrated.conversation.eventCursor);
              }
              restored.push(session);
            } catch (err) {
              hydrateNotice = `Could not restore chat ${entry.id}: ${errorText(err)}`;
            }
          }
          if (restored.length > 0) {
            opened = restored[0];
            changeSessions(() => restored);
            setSelected(opened.id);
            if (hydrateNotice) setError(hydrateNotice);
            void loadDraftFor(opened.id, p);
            startPolling(p);
            return;
          }
        } catch (err) {
          setError(`Could not load conversation history: ${errorText(err)}. Starting a fresh chat.`);
        }
        changeSessions(() => [opened]); setSelected(opened.id);
        void loadDraftFor(opened.id, p);
      }
      startPolling(p);
    } catch (err) { if (mounted.current) { setChallenge(null); setError(errorText(err)); } }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  function newChat() {
    if (!project || lost || sessionsRef.current.length >= NATIVE_MAX_SESSIONS) return;
    const session = createProjectChat(project);
    changeSessions((all) => [...all, session]);
    setSelected(session.id);
    setDraft("");
    cursorRef.current.set(session.id, null);
    draftMetaRef.current.set(session.id, { version: 0 });
  }

  async function flushDraftFor(conversationId: string) {
    const owner = ownerRef.current;
    if (!owner || lost) {
      cancelDraftTimer(conversationId);
      return;
    }
    cancelDraftTimer(conversationId);
    const meta = draftMetaRef.current.get(conversationId) ?? { version: 0 };
    await (meta.chain ?? Promise.resolve()).catch(() => {});
    const latest = draftMetaRef.current.get(conversationId) ?? meta;
    const text = typeof latest.pendingText === "string"
      ? latest.pendingText
      : (selectedRef.current === conversationId ? draft : null);
    if (typeof text !== "string") return;
    const session = sessionsRef.current.find((s) => s.id === conversationId);
    try {
      const result = await nativeChatSaveDraft({
        generation: owner.project.generation,
        projectToken: owner.project.projectToken,
        conversationId,
        saveId: crypto.randomUUID(),
        expectedVersion: latest.version,
        text,
        modelRequested: session?.model ?? null,
        effort: session?.effort ?? null,
        role: session?.role ?? "implement",
      });
      if (result.saved && result.receipt && typeof result.receipt.version === "number") {
        draftMetaRef.current.set(conversationId, {
          version: result.receipt.version,
          pendingText: null,
        });
        if (result.receipt.status === "conflict" && mounted.current) {
          setError("Draft conflict while switching chats. Resolve it before sending.");
        }
      }
    } catch {
      /* best-effort flush */
    }
  }

  function selectChat(id: string) {
    if (id === selected) return;
    const previous = selected;
    if (previous) void flushDraftFor(previous);
    setSelected(id);
    if (project) {
      void loadDraftFor(id, project);
      void nativeChatListDraftConflicts(project.generation, project.projectToken, id)
        .then((listed) => {
          const open = listed.conflicts.filter((c) => c.resolution === "open" || !c.resolution);
          if (open.length > 0 && mounted.current && selectedRef.current === id) {
            setError(`Open draft conflict(s): ${open.length}. Use Resolve draft conflict.`);
          }
        })
        .catch(() => {});
    } else setDraft("");
  }

  async function closeProject() {
    const owner = ownerRef.current;
    if (!project || !owner || sendRef.current || sessionsRef.current.some((s) => s.busy) || actionRef.current) return;
    actionRef.current = true; setLoading("Closing project…");
    stopPolling(owner);
    try {
      await nativeChatClose(project.generation, project.projectToken);
      if (!mounted.current) return;
      setProject(null); setChallenge(null); setSelected(""); setDraft(""); setPath(""); setError("");
      decisionsRef.current.clear(); setPendingDecisions([]);
      changeSessions(() => []);
    } catch (e) {
      changeSessions((all) => all.map((s) => markNativeUnavailable(s, "Project close could not be confirmed.")));
      if (mounted.current) { setLost(true); setError(`Project close could not be confirmed: ${errorText(e)}. Restart CHO.`); }
    } finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  async function send() {
    const owner = ownerRef.current;
    const session = sessionsRef.current.find((s) => s.id === selected);
    const prompt = draft.trim();
    if (!owner || !session || !prompt || prompt.length > 65536 || sendRef.current ||
        sessionsRef.current.some((s) => s.busy) || session.unavailable || !session.model) return;
    sendRef.current = true; setSendPending(true);
    const turnId = crypto.randomUUID();
    const retainedPrompt = prompt;
    changeSessions((all) => all.map((s) => s.id === session.id ? beginNativeTurn(s, turnId, prompt) : s));
    setDraft(""); setError("");
    void flushDraftClear(session.id, session, owner);
    try {
      const response = await nativeChatSend({ generation: owner.project.generation, projectToken: owner.project.projectToken,
        sessionId: session.id, turnId, model: session.model, prompt, role: session.role, ...(session.effort ? { effort: session.effort } : {}) });
      if (owner.stopped || ownerRef.current !== owner) return;
      if (response.generation !== owner.project.generation || response.sessionId !== session.id || response.turnId !== turnId || (response.controller ?? "codex") !== session.controller) {
        throw new Error("The host acknowledged a different conversation.");
      }
      changeSessions((all) => all.map((s) => s.id === session.id ? applyNativeAck(s, response, owner.project.generation) : s));
      if (sessionsRef.current.some((s) => s.unavailable)) hostLost(owner, "The native conversation identity could not be verified.");
    } catch (e) {
      if (!owner.stopped && ownerRef.current === owner) {
        const note = `Send outcome could not be confirmed: ${errorText(e)}`;
        changeSessions((all) => all.map((s) => s.id === session.id ? failNativeTurn(s, turnId, note, "unknown") : s));
        // Restore the prompt when acknowledgement never arrived.
        if (mounted.current && selectedRef.current === session.id) {
          setDraft(retainedPrompt);
          queueDraftSave(session.id, retainedPrompt);
        }
        hostLost(owner, note);
      }
    } finally { sendRef.current = false; if (mounted.current) setSendPending(false); }
  }

  async function stop() {
    const owner = ownerRef.current;
    const s = sessionsRef.current.find((item) => item.id === selected);
    if (!owner || !s?.activeTurnId || s.cancelling) return;
    const turnId = s.activeTurnId;
    changeSessions((all) => all.map((item) => item.id === s.id ? markNativeCancelling(item) : item));
    try { await nativeChatCancel({ generation: owner.project.generation, projectToken: owner.project.projectToken, sessionId: s.id, turnId }); }
    catch (e) {
      if (owner.stopped || ownerRef.current !== owner) return;
      const latest = sessionsRef.current.find((item) => item.id === s.id);
      if (latest?.activeTurnId === turnId && mounted.current) {
        setError(`Cancellation could not be confirmed: ${errorText(e)}. Waiting for the turn outcome.`);
      }
    }
  }

  async function decide(approvalId: string, decision: NativeDecision) {
    const owner = ownerRef.current;
    const s = sessionsRef.current.find((item) => item.id === selected);
    const approval = s?.approvals.find((a) => a.approvalId === approvalId && a.turnId === s.activeTurnId);
    if (!owner || !s || !approval || !approval.decisions.includes(decision) || decisionsRef.current.has(approvalId)) return;
    decisionsRef.current.add(approvalId); setPendingDecisions([...decisionsRef.current]);
    try {
      await nativeChatRespond({ generation: owner.project.generation, projectToken: owner.project.projectToken,
        sessionId: s.id, turnId: approval.turnId, approvalId, decision });
      if (!owner.stopped && ownerRef.current === owner) {
        changeSessions((all) => all.map((item) => item.id === s.id
          ? { ...item, approvals: item.approvals.filter((a) => !(a.approvalId === approvalId && a.turnId === approval.turnId)) }
          : item));
      }
    } catch (e) { hostLost(owner, `Approval response could not be confirmed: ${errorText(e)}`); }
  }

  async function answerClarification(request: NativeClarificationRequest, answers: Record<string, string[]>) {
    const owner = ownerRef.current;
    const session = sessionsRef.current.find((item) => item.id === selected);
    const latest = session?.clarifications.find((q) => q.clarificationId === request.clarificationId && q.turnId === request.turnId);
    if (!owner || !session || session.id !== selected || !latest) return;
    const turnId = latest.turnId;
    const clarificationId = latest.clarificationId;
    if (!session.activeTurnId || session.activeTurnId !== turnId) return;
    if (session.cancelling || session.unavailable || lost) return;
    if (latest.answering || answerRef.current.has(clarificationId)) return;
    answerRef.current.add(clarificationId);
    changeSessions((all) => all.map((item) => item.id === session.id ? markNativeClarificationAnswering(item, clarificationId, turnId) : item));
    const generation = owner.project.generation;
    const projectToken = owner.project.projectToken;
    const sessionId = session.id;
    try {
      const ack = await nativeChatAnswer({ generation, projectToken, sessionId, turnId, clarificationId, answers });
      if (owner.stopped || ownerRef.current !== owner) return;
      if (!ack || ack.generation !== generation || ack.sessionId !== sessionId ||
          ack.turnId !== turnId || ack.clarificationId !== clarificationId) return;
      changeSessions((all) => all.map((item) => item.id === sessionId ? applyNativeClarificationAck(item, ack, generation) : item));
    } catch {
      if (!owner.stopped && ownerRef.current === owner && mounted.current) {
        setError("Could not confirm the answer. Stop this turn before trying again.");
      }
    } finally {
      answerRef.current.delete(clarificationId);
    }
  }

  function updateSettings(patch: Partial<Pick<NativeUiSession, "model" | "role" | "effort">>) {
    changeSessions((all) => all.map((s) => {
      if (s.id !== selected || s.busy || sendRef.current) return s;
      const started = s.threadStarted || s.messages.length > 0;
      if (!started) return { ...s, ...patch };
      return s.controller === "codex" && Object.keys(patch).every((key) => key === "effort")
        ? { ...s, ...patch } : s;
    }));
  }
  function chooseModel(model: string) {
    const available = modelEfforts(projectController, project?.models.find((m) => m.id === model));
    const effort = current?.effort && available.includes(current.effort) ? current.effort
      : available.includes("medium") ? "medium" : available[0];
    updateSettings({ model, effort });
  }
  function composerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnComposerKey(e)) { e.preventDefault(); void send(); }
  }

  return <div className="native-shell">
    <aside className="native-sidebar">
      <div className="native-brand"><Icon name="terminal" size={18} /><strong>CHO</strong><span>{controllerName} · Preview</span></div>
      <p className="native-muted">Conversation text is stored locally and restored when you reopen this project.</p>
      {project && <><div className="native-project"><Icon name="folder" size={16} /><div><strong>{project.name}</strong><small title={project.path}>{project.path}</small></div></div>
        <button className="native-button" onClick={newChat} disabled={lost || !project.models.length || sessions.length >= NATIVE_MAX_SESSIONS}><Icon name="plus" size={15} /> New chat</button>
        <OrchAgentsPanel repoPath={project.path} conversationId={selected || null} disabled={lost || busy || Boolean(loading)} />
        <label className="native-search">
          <span className="sr-only">Search chats</span>
          <input
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            placeholder="Search chats"
            disabled={lost}
          />
        </label>
        <nav aria-label="Chats" className="native-chat-list">{visibleSessions.map((s) => <button key={s.id} className={s.id === selected ? "selected" : ""} onClick={() => selectChat(s.id)}><Icon name="chat" size={15} /><span>{s.title}</span>{s.busy && <span aria-label="Working">·</span>}</button>)}</nav>
        {selected && !lost ? (
          <div className="native-orch-actions">
            <button
              type="button"
              className="native-button"
              disabled={busy || Boolean(loading)}
              onClick={() => {
                const title = window.prompt("Rename chat", current?.title || "Chat");
                if (!title || !project) return;
                void nativeChatRenameConversation(project.generation, project.projectToken, selected, title)
                  .then(() => changeSessions((all) => all.map((s) => s.id === selected ? { ...s, title } : s)))
                  .catch((err) => setError(errorText(err)));
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="native-button"
              disabled={busy || Boolean(loading)}
              onClick={() => {
                if (!project) return;
                void nativeChatExportConversation(project.generation, project.projectToken, selected)
                  .then((result) => {
                    const blob = new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `cho-conversation-${selected.slice(0, 8)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setLoading("Exported conversation.");
                    setTimeout(() => { if (mounted.current) setLoading(""); }, 1500);
                  })
                  .catch((err) => setError(errorText(err)));
              }}
            >
              Export
            </button>
            <label className="native-button" style={{ display: "inline-flex", cursor: busy || loading ? "not-allowed" : "pointer" }}>
              Import
              <input
                type="file"
                accept="application/json,.json"
                hidden
                disabled={busy || Boolean(loading)}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || !project) return;
                  setLoading("Importing transcript…");
                  void file.text().then(async (raw) => {
                    const parsed = JSON.parse(raw) as {
                      format?: string;
                      conversation?: { title?: string; controller?: string; messages?: Array<{ role?: string; text?: string }> };
                      messages?: Array<{ role?: string; text?: string }>;
                      title?: string;
                    };
                    const messages = Array.isArray(parsed.conversation?.messages)
                      ? parsed.conversation.messages
                      : Array.isArray(parsed.messages)
                        ? parsed.messages
                        : null;
                    if (!messages) throw new Error("Import file has no messages array");
                    const imported = await nativeChatImportTranscript({
                      generation: project.generation,
                      projectToken: project.projectToken,
                      source: "file-import",
                      sourceKey: `${file.name}:${file.size}:${file.lastModified}`,
                      title: parsed.conversation?.title || parsed.title || file.name.replace(/\.json$/i, ""),
                      controller: (parsed.conversation?.controller === "claude" ? "claude" : controller),
                      messages,
                    });
                    const hydrated = await nativeChatHydrateConversation(
                      project.generation,
                      project.projectToken,
                      imported.conversationId,
                    );
                    if (!hydrated.conversation) throw new Error("Imported conversation could not be hydrated");
                    const session = sessionFromHydrated(project, hydrated.conversation);
                    changeSessions((all) => [...all, session].slice(0, NATIVE_MAX_SESSIONS));
                    setSelected(session.id);
                    setLoading(imported.created ? "Imported transcript." : "Opened previously imported transcript.");
                    setTimeout(() => { if (mounted.current) setLoading(""); }, 1500);
                  }).catch((err) => {
                    if (mounted.current) {
                      setLoading("");
                      setError(errorText(err));
                    }
                  });
                }}
              />
            </label>
            <button
              type="button"
              className="native-button"
              disabled={busy || Boolean(loading)}
              onClick={() => {
                if (!project) return;
                void nativeChatArchiveConversation(project.generation, project.projectToken, selected, true)
                  .then(() => {
                    changeSessions((all) => all.filter((s) => s.id !== selected));
                    const next = sessionsRef.current.find((s) => s.id !== selected);
                    setSelected(next?.id || "");
                    setDraft("");
                  })
                  .catch((err) => setError(errorText(err)));
              }}
            >
              Archive
            </button>
            {historyTruncated ? (
              <button
                type="button"
                className="native-button"
                disabled={busy || Boolean(loading)}
                onClick={() => {
                  if (!project || !selected) return;
                  setLoading("Loading more history…");
                  void nativeChatHydrateConversation(project.generation, project.projectToken, selected, {
                    maxEventPages: 256,
                    turnLimit: 300,
                  })
                    .then((result) => {
                      if (!result.conversation) throw new Error("Conversation not found.");
                      const session = sessionFromHydrated(project, result.conversation);
                      changeSessions((all) => all.map((s) => (s.id === selected ? session : s)));
                      setHistoryTruncated(Boolean(result.conversation.hasMoreEvents));
                      setError(result.conversation.hasMoreEvents
                        ? "Loaded a larger history window; more pages may still remain."
                        : "");
                    })
                    .catch((err) => setError(errorText(err)))
                    .finally(() => { if (mounted.current) setLoading(""); });
                }}
              >
                Load more history
              </button>
            ) : null}
            <button
              type="button"
              className="native-button"
              disabled={busy || Boolean(loading)}
              onClick={() => {
                if (!project) return;
                void nativeChatListDraftConflicts(project.generation, project.projectToken, selected)
                  .then(async (listed) => {
                    const open = listed.conflicts.filter((c) => c.resolution === "open" || !c.resolution);
                    if (open.length === 0) {
                      setError("");
                      setLoading("No open draft conflicts.");
                      setTimeout(() => { if (mounted.current) setLoading(""); }, 1500);
                      return;
                    }
                    const conflict = open[0];
                    const keepLocal = window.confirm(
                      `Draft conflict at base v${conflict.baseVersion}. OK keeps the current composer text; Cancel drops the conflicting save.`,
                    );
                    await nativeChatResolveDraftConflict({
                      generation: project.generation,
                      projectToken: project.projectToken,
                      conversationId: selected,
                      conflictId: conflict.saveId,
                      resolutionId: crypto.randomUUID(),
                      expectedVersion: conflict.baseVersion,
                      action: keepLocal ? "kept" : "dropped",
                      ...(keepLocal ? { text: draft } : {}),
                    });
                    setError("");
                    setLoading(keepLocal ? "Kept local draft." : "Dropped conflicting draft save.");
                    setTimeout(() => { if (mounted.current) setLoading(""); }, 1500);
                  })
                  .catch((err) => setError(errorText(err)));
              }}
            >
              Resolve draft conflict
            </button>
          </div>
        ) : null}
        <button className="native-close-project" onClick={() => void closeProject()} disabled={busy || Boolean(loading) || lost}>Close project</button></>}
    </aside>
    <main className="native-main">
      <header className="native-header"><span>{project?.name || "Open a project"}</span>{current && <span>{controllerName} · {current.role === "review" ? "Read-only" : "Editing"}</span>}</header>
      <div className="native-content">
        {(error || loading) && <div role={error ? "alert" : "status"} className={error ? "native-notice error" : "native-notice"}>{error || loading}</div>}
        {project && recoveryUnresolved.length > 0 ? (
          <div className="native-notice" role="status">
            <p>{recoveryUnresolved.length} prior-host stranded turn(s). Mark unknown explicitly — this host will not adopt them.</p>
            <div className="native-orch-actions">
              {recoveryUnresolved.slice(0, 8).map((row) => (
                <button
                  key={row.operationId}
                  type="button"
                  className="native-button"
                  disabled={busy || Boolean(loading) || lost}
                  onClick={() => {
                    setLoading("Acknowledging stranded turn…");
                    void nativeChatAcknowledgeStranded({
                      generation: project.generation,
                      projectToken: project.projectToken,
                      conversationId: row.conversationId,
                      turnId: row.turnId,
                      operationId: row.operationId,
                    }).then((result) => {
                      const remaining = Array.isArray(result.recoveryUnresolved) ? result.recoveryUnresolved : [];
                      setRecoveryUnresolved(remaining);
                      setError(typeof result.recoveryNotice === "string" && result.recoveryNotice.length > 0
                        ? result.recoveryNotice
                        : remaining.length === 0 ? "" : error);
                      setLoading(result.acknowledged === false && result.alreadyTerminal
                        ? "Turn was already terminal."
                        : "Marked stranded turn unknown.");
                      setTimeout(() => { if (mounted.current) setLoading(""); }, 1500);
                    }).catch((err) => {
                      setLoading("");
                      setError(errorText(err));
                    });
                  }}
                >
                  Mark unknown ({row.turnId.slice(0, 8)})
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {!project && <section className="native-empty"><h1>Open a project</h1><p>Choose an existing project directory for this conversation.</p><form onSubmit={validate}><label htmlFor="native-controller">Controller</label><select id="native-controller" value={controller} disabled={Boolean(loading) || Boolean(challenge)} onChange={(e) => setController(e.target.value as NativeController)}><option value="codex">Codex</option><option value="claude">Claude</option></select><label htmlFor="native-path">Project path</label><div className="native-path-row"><input id="native-path" value={path} onChange={(e) => { setPath(e.target.value); setChallenge(null); }} placeholder="Path to a project" disabled={Boolean(loading)} /><button type="button" className="native-button" onClick={() => void browseProject()} disabled={Boolean(loading) || Boolean(challenge)}><Icon name="folder" size={15} /> Browse…</button><button className="native-primary" disabled={!path.trim() || Boolean(loading)}>Continue</button></div></form></section>}
        {project && current && <><div className="native-settings"><label>Model <select value={current.model} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => chooseModel(e.target.value)}>{project.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Access <select value={current.role} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => updateSettings({ role: e.target.value as NativeRole })}><option value="implement">Editing</option><option value="review">Read-only</option></select></label><label>Effort <select value={current.effort ?? ""} disabled={((current.threadStarted || current.messages.length > 0) && current.controller === "claude") || current.busy || sendPending || lost || !availableEfforts.length} onChange={(e) => updateSettings({ effort: e.target.value as NativeEffort })}>{availableEfforts.length ? availableEfforts.map((e) => <option key={e} value={e}>{e === "xhigh" ? "Extra high" : e === "max" ? "Max" : e[0].toUpperCase() + e.slice(1)}</option>) : <option value="">Default</option>}</select></label></div>
          {(current.threadStarted || current.messages.length > 0) && <p className="native-hint">{current.controller === "codex" ? "Start a new chat to change the model or access." : "Start a new chat to change these settings."}</p>}
          {projectController === "claude" && current.role === "review" && <p className="native-hint">Review mode limits Claude to read tools.</p>}
          <div className="native-messages" aria-live="polite">{current.messages.length === 0 && <div className="native-welcome"><h1>What would you like to work on?</h1><p>Ask {controllerName} about this project or describe a change.</p></div>}{current.messages.map((m) => {
            const waitingClarifications = current.clarifications.filter((r) => r.turnId === m.id);
            const waitingOnClarification = m.isStreaming && !m.text && waitingClarifications.some((r) => !r.answering);
            const answeringClarification = m.isStreaming && !m.text && waitingClarifications.some((r) => r.answering);
            const emptyStatus = waitingOnClarification
              ? "Waiting for your answer…"
              : answeringClarification
                ? "Submitting answer…"
                : m.isStreaming
                  ? "Starting…"
                  : null;
            return <article className={`native-message ${m.role}`} key={m.id}><div className="native-message-label">{m.role === "user" ? "You" : controllerName}</div>{m.text ? <FormattedMarkdown text={m.text} repoPath={project.path} /> : emptyStatus ? <span className="native-muted">{emptyStatus}</span> : null}{m.tools.map((t) => <div className="native-tool" key={t.id}>{t.title} · {t.status}</div>)}{m.statusText && <p className="native-muted">{m.statusText}</p>}{m.outcome && <p className={m.isError ? "native-outcome error" : "native-outcome"}>{m.outcome}{m.outcomeNote ? `: ${m.outcomeNote}` : ""}</p>}{waitingClarifications.map((r) => <NativeClarificationCard key={r.clarificationId} request={r} disabled={lost || current.cancelling || current.unavailable} onAnswer={(answers) => void answerClarification(r, answers)} />)}</article>;
          })}<div ref={bottomRef} /></div>
          <div className="native-approvals">{current.approvals.map((a) => <section className="native-approval" key={a.approvalId} aria-label="Approval request"><strong>{a.approvalType === "command" ? "Command approval" : a.approvalType === "file" ? "File change approval" : "Tool approval"}</strong><pre>{a.text}</pre><div>{a.decisions.length ? a.decisions.map((d) => <button key={d} className="native-button" disabled={pendingDecisions.includes(a.approvalId) || current.cancelling || lost} onClick={() => void decide(a.approvalId, d)}>{d === "accept" ? "Accept" : d === "decline" ? "Decline" : "Cancel"}</button>) : <span>No supported decisions are available.</span>}</div></section>)}</div>
          <div className="native-composer"><label className="sr-only" htmlFor="native-prompt">Message {controllerName}</label><textarea id="native-prompt" value={draft} onChange={(e) => { const text = e.target.value; setDraft(text); if (current) queueDraftSave(current.id, text); }} onKeyDown={composerKey} placeholder={`Message ${controllerName}…`} disabled={lost || current.unavailable} rows={3} /><div className="native-composer-actions"><span>Enter to send · Shift+Enter for a new line</span>{current.busy ? <button className="native-button" onClick={() => void stop()} disabled={current.cancelling || lost}><Icon name="stop" size={14} />{current.cancelling ? "Stopping…" : "Stop"}</button> : <button className="native-primary" onClick={() => void send()} disabled={!draft.trim() || draft.length > 65536 || busy || lost || !current.model}><Icon name="arrow" size={15} /> Send</button>}</div></div></>}
      </div>
    </main>
    {challenge && <Dialog title="Trust this project?" subtitle={`${labelController(challenge.controller ?? "codex")} may read or change files according to the access you choose.`} onClose={() => { if (!loading) setChallenge(null); }}><p>Confirm this project directory:</p><p className="native-confirm-path">{challenge.path}</p><div className="native-dialog-actions"><button className="native-button" disabled={Boolean(loading)} onClick={() => setChallenge(null)}>Cancel</button><button className="native-primary" disabled={Boolean(loading)} onClick={() => void prepare()}>Trust and continue</button></div></Dialog>}
  </div>;
}
