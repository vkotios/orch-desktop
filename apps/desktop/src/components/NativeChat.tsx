import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Dialog, Icon } from "./Chrome";
import { FormattedMarkdown } from "./FormattedMarkdown";
import {
  nativeChatCancel, nativeChatClose, nativeChatPoll, nativeChatPrepareProject,
  nativeChatRespond, nativeChatSend, nativeChatValidateProject,
  type NativeDecision, type NativeEffort, type NativePrepareResult,
  type NativeRole, type NativeValidateResult,
} from "../lib/api";
import {
  applyNativeAck, applyNativePollBatch, beginNativeTurn, createNativeUiSession,
  defaultNativeModel, failNativeTurn, markNativeCancelling, markNativeUnavailable,
  NATIVE_MAX_SESSIONS, NATIVE_POLL_INTERVAL_MS, type NativeUiSession,
} from "../lib/native-chat-state";
import "./native-chat.css";

type Project = NativePrepareResult;
type PollOwner = { project: Project; stopped: boolean; timer?: ReturnType<typeof setTimeout> };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function NativeChat() {
  const [project, setProject] = useState<Project | null>(null);
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
  const ownerRef = useRef<PollOwner | null>(null);
  const sendRef = useRef(false);
  const actionRef = useRef(false);
  const mounted = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const current = sessions.find((s) => s.id === selected);
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

  async function validate(e: FormEvent) {
    e.preventDefault();
    if (!path.trim() || actionRef.current) return;
    actionRef.current = true;
    setLoading("Checking project…"); setError("");
    try {
      const result = await nativeChatValidateProject(path.trim());
      if (mounted.current) setChallenge(result);
    } catch (err) { if (mounted.current) setError(errorText(err)); }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  async function prepare() {
    if (!challenge || actionRef.current) return;
    const requested = challenge;
    actionRef.current = true; setLoading("Opening Codex and loading models…"); setError("");
    try {
      const p = await nativeChatPrepareProject(requested.projectToken);
      if (p.generation !== requested.generation || p.projectToken !== requested.projectToken || p.path !== requested.path) {
        await nativeChatClose(p.generation, p.projectToken).catch(() => {});
        throw new Error("The prepared project did not match the confirmed project.");
      }
      if (!mounted.current) { void nativeChatClose(p.generation, p.projectToken).catch(() => {}); return; }
      setChallenge(null); setProject(p); setLost(false);
      if (!p.models.length) setError("Codex returned no available models. Close the project and try again.");
      else {
        const first = createNativeUiSession(crypto.randomUUID(), defaultNativeModel(p.models));
        changeSessions(() => [first]); setSelected(first.id);
      }
      startPolling(p);
    } catch (err) { if (mounted.current) { setChallenge(null); setError(errorText(err)); } }
    finally { actionRef.current = false; if (mounted.current) setLoading(""); }
  }

  function newChat() {
    if (!project || lost || sessionsRef.current.length >= NATIVE_MAX_SESSIONS) return;
    const session = createNativeUiSession(crypto.randomUUID(), defaultNativeModel(project.models));
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
        sessionId: session.id, turnId, model: session.model, prompt, role: session.role, effort: session.effort });
      if (owner.stopped || ownerRef.current !== owner) return;
      if (response.generation !== owner.project.generation || response.sessionId !== session.id || response.turnId !== turnId) {
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

  function updateSettings(patch: Partial<Pick<NativeUiSession, "model" | "role" | "effort">>) {
    changeSessions((all) => all.map((s) => s.id === selected && !s.threadStarted && !s.messages.length && !s.busy && !sendRef.current ? { ...s, ...patch } : s));
  }
  function composerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  }

  return <div className="native-shell">
    <aside className="native-sidebar">
      <div className="native-brand"><Icon name="terminal" size={18} /><strong>CHO</strong><span>Codex · Preview</span></div>
      <p className="native-muted">Chats are kept only while this window is open.</p>
      {project && <><div className="native-project"><Icon name="folder" size={16} /><div><strong>{project.name}</strong><small title={project.path}>{project.path}</small></div></div>
        <button className="native-button" onClick={newChat} disabled={lost || !project.models.length || sessions.length >= NATIVE_MAX_SESSIONS}><Icon name="plus" size={15} /> New chat</button>
        <nav aria-label="Chats" className="native-chat-list">{sessions.map((s) => <button key={s.id} className={s.id === selected ? "selected" : ""} onClick={() => { setSelected(s.id); setDraft(""); }}><Icon name="chat" size={15} /><span>{s.title}</span>{s.busy && <span aria-label="Working">·</span>}</button>)}</nav>
        <button className="native-close-project" onClick={() => void closeProject()} disabled={busy || Boolean(loading) || lost}>Close project</button></>}
    </aside>
    <main className="native-main">
      <header className="native-header"><span>{project?.name || "Open a project"}</span>{current && <span>Codex · {current.role === "review" ? "Read-only" : "Editing"}</span>}</header>
      <div className="native-content">
        {(error || loading) && <div role={error ? "alert" : "status"} className={error ? "native-notice error" : "native-notice"}>{error || loading}</div>}
        {!project && <section className="native-empty"><h1>Open a project</h1><p>Choose an existing project directory for this conversation.</p><form onSubmit={validate}><label htmlFor="native-path">Project path</label><div className="native-path-row"><input id="native-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Path to a project" disabled={Boolean(loading)} /><button className="native-primary" disabled={!path.trim() || Boolean(loading)}>Continue</button></div></form></section>}
        {project && current && <><div className="native-settings"><label>Model <select value={current.model} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => updateSettings({ model: e.target.value })}>{project.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Access <select value={current.role} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => updateSettings({ role: e.target.value as NativeRole })}><option value="implement">Editing</option><option value="review">Read-only</option></select></label><label>Effort <select value={current.effort} disabled={current.threadStarted || current.messages.length > 0 || current.busy || sendPending || lost} onChange={(e) => updateSettings({ effort: e.target.value as NativeEffort })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label></div>
          {(current.threadStarted || current.messages.length > 0) && <p className="native-hint">Start a new chat to change these settings.</p>}
          <div className="native-messages" aria-live="polite">{current.messages.length === 0 && <div className="native-welcome"><h1>What would you like to work on?</h1><p>Ask Codex about this project or describe a change.</p></div>}{current.messages.map((m) => <article className={`native-message ${m.role}`} key={m.id}><div className="native-message-label">{m.role === "user" ? "You" : "Codex"}</div>{m.text ? <FormattedMarkdown text={m.text} /> : m.isStreaming ? <span className="native-muted">Starting…</span> : null}{m.tools.map((t) => <div className="native-tool" key={t.id}>{t.title} · {t.status}</div>)}{m.statusText && <p className="native-muted">{m.statusText}</p>}{m.outcome && <p className={m.isError ? "native-outcome error" : "native-outcome"}>{m.outcome}{m.outcomeNote ? `: ${m.outcomeNote}` : ""}</p>}</article>)}<div ref={bottomRef} /></div>
          <div className="native-approvals">{current.approvals.map((a) => <section className="native-approval" key={a.approvalId} aria-label="Approval request"><strong>{a.approvalType === "command" ? "Command approval" : "File change approval"}</strong><pre>{a.text}</pre><div>{a.decisions.length ? a.decisions.map((d) => <button key={d} className="native-button" disabled={pendingDecisions.includes(a.approvalId) || current.cancelling || lost} onClick={() => void decide(a.approvalId, d)}>{d === "accept" ? "Accept" : d === "decline" ? "Decline" : "Cancel"}</button>) : <span>No supported decisions are available.</span>}</div></section>)}</div>
          <div className="native-composer"><label className="sr-only" htmlFor="native-prompt">Message Codex</label><textarea id="native-prompt" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={composerKey} placeholder="Message Codex…" disabled={lost || current.unavailable} rows={3} /><div className="native-composer-actions"><span>Enter to send · Shift+Enter for a new line</span>{current.busy ? <button className="native-button" onClick={() => void stop()} disabled={current.cancelling || lost}><Icon name="stop" size={14} />{current.cancelling ? "Stopping…" : "Stop"}</button> : <button className="native-primary" onClick={() => void send()} disabled={!draft.trim() || draft.length > 65536 || busy || lost || !current.model}><Icon name="arrow" size={15} /> Send</button>}</div></div></>}
      </div>
    </main>
    {challenge && <Dialog title="Trust this project?" subtitle="Codex may read or change files according to the access you choose." onClose={() => { if (!loading) setChallenge(null); }}><p>Confirm this project directory:</p><p className="native-confirm-path">{challenge.path}</p><div className="native-dialog-actions"><button className="native-button" disabled={Boolean(loading)} onClick={() => setChallenge(null)}>Cancel</button><button className="native-primary" disabled={Boolean(loading)} onClick={() => void prepare()}>Trust and continue</button></div></Dialog>}
  </div>;
}
