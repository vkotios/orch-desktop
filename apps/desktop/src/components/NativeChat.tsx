import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Dialog, Icon } from "./Chrome";
import { FormattedMarkdown } from "./FormattedMarkdown";
import { NativeClarificationCard } from "./NativeClarificationCard";
import { OrchAgentsPanel } from "./OrchAgentsPanel";
import {
  nativeChatAnswer, nativeChatCancel, nativeChatClose, nativeChatHydrateConversation,
  nativeChatListConversations, nativeChatPoll, nativeChatPrepareProject,
  nativeChatRespond, nativeChatSend, nativeChatValidateProject, nativeChatPickProjectFolder,
  type NativeClarificationRequest, type NativeController, type NativeDecision, type NativeEffort,
  type NativeHydratedConversation, type NativeModelInfo, type NativePrepareResult,
  type NativeRole, type NativeValidateResult,
} from "../lib/api";
import {
  applyNativeAck, applyNativeClarificationAck, applyNativePollBatch, beginNativeTurn, createNativeUiSession,
  defaultNativeModel, failNativeTurn, markNativeCancelling, markNativeClarificationAnswering, markNativeUnavailable,
  NATIVE_MAX_SESSIONS, NATIVE_POLL_INTERVAL_MS, type NativeUiSession,
} from "../lib/native-chat-state";
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

export function NativeChat() {
  const [project, setProject] = useState<Project | null>(null);
  const [controller, setController] = useState<NativeController>("codex");
  const [challenge, setChallenge] = useState<NativeValidateResult | null>(null);
  const [path, setPath] = useState("");
  const [sessions, setSessions] = useState<NativeUiSession[]>([]);
  const sessionsRef = useRef<NativeUiSession[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
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
  const current = sessions.find((s) => s.id === selected);
  const projectController = project?.controller ?? controller;
  const controllerName = labelController(projectController);
  const availableEfforts = modelEfforts(projectController, project?.models.find((m) => m.id === current?.model));
  const busy = sessions.some((s) => s.busy) || sendPending;

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
        const batch = await nativeChatPoll(p.generation, p.projectToken);
        if (owner.stopped || ownerRef.current !== owner) return;
        if (batch.generation !== p.generation) throw new Error("Host generation changed.");
        changeSessions((all) => applyNativePollBatch(all, p.generation, batch.events).sessions);
        if (sessionsRef.current.some((s) => s.unavailable)) {
          hostLost(owner, "The native conversation outcome is unknown.");
          return;
        }
        owner.timer = setTimeout(poll, NATIVE_POLL_INTERVAL_MS);
      } catch (e) {
        hostLost(owner, `The native host connection was lost: ${errorText(e)}`);
      }
    };
    void poll();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
      if (!p.models.length) setError(`${labelController(selectedController)} returned no available models. Close the project and try again.`);
      else {
        let opened = createProjectChat(p);
        try {
          const listed = await nativeChatListConversations(p.generation, p.projectToken);
          const latest = [...listed.conversations]
            .filter((c) => (c.controller ?? "codex") === selectedController)
            .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
          if (latest) {
            const hydrated = await nativeChatHydrateConversation(p.generation, p.projectToken, latest.id);
            if (hydrated.conversation) opened = sessionFromHydrated(p, hydrated.conversation);
          }
        } catch {
          // Fresh chat if durable history is unavailable; dual-write still proceeds on send.
        }
        changeSessions(() => [opened]); setSelected(opened.id);
      }
      startPolling(p);
    } catch (err) { if (mounted.current) { setChallenge(null); setError(errorText(err)); } }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  function newChat() {
    if (!project || lost || sessionsRef.current.length >= NATIVE_MAX_SESSIONS) return;
    const session = createProjectChat(project);
    changeSessions((all) => [...all, session]); setSelected(session.id); setDraft("");
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
    changeSessions((all) => all.map((s) => s.id === session.id ? beginNativeTurn(s, turnId, prompt) : s));
    setDraft(""); setError("");
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  }

  return <div className="native-shell">
    <aside className="native-sidebar">
      <div className="native-brand"><Icon name="terminal" size={18} /><strong>CHO</strong><span>{controllerName} · Preview</span></div>
      <p className="native-muted">Conversation text is stored locally and restored when you reopen this project.</p>
      {project && <><div className="native-project"><Icon name="folder" size={16} /><div><strong>{project.name}</strong><small title={project.path}>{project.path}</small></div></div>
        <button className="native-button" onClick={newChat} disabled={lost || !project.models.length || sessions.length >= NATIVE_MAX_SESSIONS}><Icon name="plus" size={15} /> New chat</button>
        <OrchAgentsPanel repoPath={project.path} disabled={lost || busy || Boolean(loading)} />
        <nav aria-label="Chats" className="native-chat-list">{sessions.map((s) => <button key={s.id} className={s.id === selected ? "selected" : ""} onClick={() => { setSelected(s.id); setDraft(""); }}><Icon name="chat" size={15} /><span>{s.title}</span>{s.busy && <span aria-label="Working">·</span>}</button>)}</nav>
        <button className="native-close-project" onClick={() => void closeProject()} disabled={busy || Boolean(loading) || lost}>Close project</button></>}
    </aside>
    <main className="native-main">
      <header className="native-header"><span>{project?.name || "Open a project"}</span>{current && <span>{controllerName} · {current.role === "review" ? "Read-only" : "Editing"}</span>}</header>
      <div className="native-content">
        {(error || loading) && <div role={error ? "alert" : "status"} className={error ? "native-notice error" : "native-notice"}>{error || loading}</div>}
        {!project && <section className="native-empty"><h1>Open a project</h1><p>Choose an existing project directory for this conversation.</p><form onSubmit={validate}><label htmlFor="native-controller">Controller</label><select id="native-controller" value={controller} disabled={Boolean(loading) || Boolean(challenge)} onChange={(e) => setController(e.target.value as NativeController)}><option value="codex">Codex</option><option value="claude">Claude</option></select><label htmlFor="native-path">Project path</label><div className="native-path-row"><input id="native-path" value={path} onChange={(e) => { setPath(e.target.value); setChallenge(null); }} placeholder="Path to a project" disabled={Boolean(loading)} /><button type="button" className="native-button" onClick={() => void browseProject()} disabled={Boolean(loading) || Boolean(challenge)}><Icon name="folder" size={15} /> Browse…</button><button className="native-primary" disabled={!path.trim() || Boolean(loading)}>Continue</button></div></form></section>}
        {project && current && <><div className="native-settings"><label>Model <select value={current.model} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => chooseModel(e.target.value)}>{project.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Access <select value={current.role} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => updateSettings({ role: e.target.value as NativeRole })}><option value="implement">Editing</option><option value="review">Read-only</option></select></label><label>Effort <select value={current.effort ?? ""} disabled={((current.threadStarted || current.messages.length > 0) && current.controller === "claude") || current.busy || sendPending || lost || !availableEfforts.length} onChange={(e) => updateSettings({ effort: e.target.value as NativeEffort })}>{availableEfforts.length ? availableEfforts.map((e) => <option key={e} value={e}>{e === "xhigh" ? "Extra high" : e === "max" ? "Max" : e[0].toUpperCase() + e.slice(1)}</option>) : <option value="">Default</option>}</select></label></div>
          {(current.threadStarted || current.messages.length > 0) && <p className="native-hint">{current.controller === "codex" ? "Start a new chat to change the model or access." : "Start a new chat to change these settings."}</p>}
          {projectController === "claude" && current.role === "review" && <p className="native-hint">Review mode limits Claude to read tools.</p>}
          <div className="native-messages" aria-live="polite">{current.messages.length === 0 && <div className="native-welcome"><h1>What would you like to work on?</h1><p>Ask {controllerName} about this project or describe a change.</p></div>}{current.messages.map((m) => <article className={`native-message ${m.role}`} key={m.id}><div className="native-message-label">{m.role === "user" ? "You" : controllerName}</div>{m.text ? <FormattedMarkdown text={m.text} /> : m.isStreaming ? <span className="native-muted">Starting…</span> : null}{m.tools.map((t) => <div className="native-tool" key={t.id}>{t.title} · {t.status}</div>)}{m.statusText && <p className="native-muted">{m.statusText}</p>}{m.outcome && <p className={m.isError ? "native-outcome error" : "native-outcome"}>{m.outcome}{m.outcomeNote ? `: ${m.outcomeNote}` : ""}</p>}{current.clarifications.filter((r) => r.turnId === m.id).map((r) => <NativeClarificationCard key={r.clarificationId} request={r} disabled={lost || current.cancelling || current.unavailable} onAnswer={(answers) => void answerClarification(r, answers)} />)}</article>)}<div ref={bottomRef} /></div>
          <div className="native-approvals">{current.approvals.map((a) => <section className="native-approval" key={a.approvalId} aria-label="Approval request"><strong>{a.approvalType === "command" ? "Command approval" : a.approvalType === "file" ? "File change approval" : "Tool approval"}</strong><pre>{a.text}</pre><div>{a.decisions.length ? a.decisions.map((d) => <button key={d} className="native-button" disabled={pendingDecisions.includes(a.approvalId) || current.cancelling || lost} onClick={() => void decide(a.approvalId, d)}>{d === "accept" ? "Accept" : d === "decline" ? "Decline" : "Cancel"}</button>) : <span>No supported decisions are available.</span>}</div></section>)}</div>
          <div className="native-composer"><label className="sr-only" htmlFor="native-prompt">Message {controllerName}</label><textarea id="native-prompt" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={composerKey} placeholder={`Message ${controllerName}…`} disabled={lost || current.unavailable} rows={3} /><div className="native-composer-actions"><span>Enter to send · Shift+Enter for a new line</span>{current.busy ? <button className="native-button" onClick={() => void stop()} disabled={current.cancelling || lost}><Icon name="stop" size={14} />{current.cancelling ? "Stopping…" : "Stop"}</button> : <button className="native-primary" onClick={() => void send()} disabled={!draft.trim() || draft.length > 65536 || busy || lost || !current.model}><Icon name="arrow" size={15} /> Send</button>}</div></div></>}
      </div>
    </main>
    {challenge && <Dialog title="Trust this project?" subtitle={`${labelController(challenge.controller ?? "codex")} may read or change files according to the access you choose.`} onClose={() => { if (!loading) setChallenge(null); }}><p>Confirm this project directory:</p><p className="native-confirm-path">{challenge.path}</p><div className="native-dialog-actions"><button className="native-button" disabled={Boolean(loading)} onClick={() => setChallenge(null)}>Cancel</button><button className="native-primary" disabled={Boolean(loading)} onClick={() => void prepare()}>Trust and continue</button></div></Dialog>}
  </div>;
}
