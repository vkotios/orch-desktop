import { useState } from "react";
import { callHost, type OrchCommandResult, type OrchDashboardData } from "../lib/api";
import {
  acceptDelegation,
  discardDelegation,
  finishDelegation,
  listDelegations,
  startAgentTask,
  type DelegationAssociation,
} from "../lib/agent-task";
import { Icon } from "./Chrome";

type Props = {
  repoPath: string;
  conversationId?: string | null;
  disabled?: boolean;
};

function isOpenDisposition(disposition: DelegationAssociation["disposition"]) {
  return disposition === "none" || disposition === "accepted";
}

export function OrchAgentsPanel({ repoPath, conversationId = null, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [wp, setWp] = useState("cho-05");
  const [slice, setSlice] = useState("delegate");
  const [cli, setCli] = useState("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [handoffText, setHandoffText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<OrchDashboardData | null>(null);
  const [associations, setAssociations] = useState<DelegationAssociation[]>([]);
  const [resumeId, setResumeId] = useState<string | null>(null);

  async function refresh() {
    try {
      const [data, listed] = await Promise.all([
        callHost<OrchDashboardData>("orch_dashboard"),
        listDelegations(repoPath),
      ]);
      setDashboard(data);
      setAssociations(listed);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function autoPick() {
    setBusy(true);
    setError("");
    try {
      const res = await callHost<OrchCommandResult>("orch_pick", {
        workload: "implement",
        size: "S",
      });
      if (res.output?.cli && res.output?.model) {
        setCli(String(res.output.cli));
        setModel(String(res.output.model));
        setStatus(`Picked ${res.output.cli} / ${res.output.model}`);
      } else {
        setStatus(res.text || "No eligible pick returned.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function spawn() {
    if (!handoffText.trim() || !model.trim()) {
      setError("Add a model and handoff instructions first.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus(resumeId ? "Resuming delegated run…" : "Starting delegated run…");
    try {
      const result = await startAgentTask(callHost, {
        repo: repoPath,
        wp,
        slice,
        cli,
        model,
        handoffText,
        effort,
        conversationId,
        associationId: resumeId,
      });
      setStatus(result.text || "Agent started in an isolated worktree.");
      setResumeId(result.association?.id ?? null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function onAccept(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await acceptDelegation(callHost, item.id, item.runId);
      setStatus(`Accepted ${item.wp}/${item.slice} (no Git mutation).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFinish(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await finishDelegation(callHost, item);
      setStatus(`Finished ${item.wp} in orch (not a Git merge).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await discardDelegation(callHost, item);
      setStatus(`Discarded ${item.wp}/${item.slice}.`);
      if (resumeId === item.id) setResumeId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="native-button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        <Icon name="activity" size={15} /> Agents
      </button>
    );
  }

  const runs = dashboard?.runs ?? [];
  const openAssociations = associations.filter((item) => isOpenDisposition(item.disposition));

  return (
    <section className="native-orch-panel" aria-label="Delegated agents">
      <header className="native-orch-header">
        <strong>Agents</strong>
        <button type="button" className="native-close-project" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>
      <p className="native-muted">
        Claim, worktree, and run are recoverable. Accept records a decision only. Finish closes the orch claim; it does not merge Git. Integrate remains unavailable until an explicit Git path exists.
      </p>
      {(error || status) && (
        <div role={error ? "alert" : "status"} className={error ? "native-notice error" : "native-notice"}>
          {error || status}
        </div>
      )}
      <div className="native-orch-form">
        <label>
          Work package
          <input value={wp} onChange={(e) => setWp(e.target.value)} disabled={busy} />
        </label>
        <label>
          Slice
          <input value={slice} onChange={(e) => setSlice(e.target.value)} disabled={busy} />
        </label>
        <label>
          CLI
          <input value={cli} onChange={(e) => setCli(e.target.value)} disabled={busy} />
        </label>
        <label>
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} placeholder="model id" />
        </label>
        <label>
          Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={busy}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
        <label className="native-orch-handoff">
          Handoff
          <textarea
            value={handoffText}
            onChange={(e) => setHandoffText(e.target.value)}
            disabled={busy}
            rows={4}
            placeholder="Instructions for the worker"
          />
        </label>
      </div>
      <div className="native-orch-actions">
        <button type="button" className="native-button" onClick={() => void autoPick()} disabled={busy || disabled}>
          Auto-pick
        </button>
        <button type="button" className="native-button" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button type="button" className="native-primary" onClick={() => void spawn()} disabled={busy || disabled}>
          {resumeId ? "Resume agent" : "Start agent"}
        </button>
      </div>
      <div className="native-orch-runs" aria-live="polite">
        <p className="native-muted">Open associations</p>
        {openAssociations.length === 0 ? (
          <p className="native-muted">None yet.</p>
        ) : (
          <ul>
            {openAssociations.slice(0, 8).map((item) => (
              <li key={item.id}>
                <strong>{item.wp}/{item.slice}</strong> · {item.stage} · {item.disposition}
                {item.runId ? ` · ${item.runId}` : ""}
                {item.worktreePath ? (
                  <small className="native-muted" title={item.worktreePath}>
                    Worktree: {item.worktreePath}
                  </small>
                ) : null}
                <div className="native-orch-actions">
                  <button
                    type="button"
                    className="native-button"
                    disabled={busy}
                    onClick={() => {
                      setResumeId(item.id);
                      setWp(item.wp);
                      setSlice(item.slice);
                      if (item.cli) setCli(item.cli);
                      if (item.model) setModel(item.model);
                    }}
                  >
                    Use for resume
                  </button>
                  {item.disposition === "none" ? (
                    <button type="button" className="native-button" disabled={busy} onClick={() => void onAccept(item)}>
                      Accept
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="native-button"
                    disabled={busy}
                    title="Closes the orch work package. Does not merge or cherry-pick."
                    onClick={() => void onFinish(item)}
                  >
                    Finish
                  </button>
                  <button
                    type="button"
                    className="native-button"
                    disabled
                    title="Git integration is not available yet. Finish is coordinator closure only."
                  >
                    Integrate
                  </button>
                  <button type="button" className="native-button" disabled={busy} onClick={() => void onDiscard(item)}>
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="native-muted">Recent orch runs</p>
        {runs.length === 0 ? (
          <p className="native-muted">No orch runs yet.</p>
        ) : (
          <ul>
            {runs.slice(0, 8).map((run) => (
              <li key={run.id}>
                <strong>{run.id}</strong> · {run.cli}/{run.model_requested || run.model_canonical || "?"} ·{" "}
                {run.derived_status || run.status}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
