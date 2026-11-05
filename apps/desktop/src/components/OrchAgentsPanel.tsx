import { useState } from "react";
import { callHost, type OrchCommandResult, type OrchDashboardData } from "../lib/api";
import { startAgentTask } from "../lib/agent-task";
import { Icon } from "./Chrome";

type Props = {
  repoPath: string;
  disabled?: boolean;
};

export function OrchAgentsPanel({ repoPath, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [wp, setWp] = useState("cho-03");
  const [slice, setSlice] = useState("delegate");
  const [cli, setCli] = useState("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [handoffText, setHandoffText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<OrchDashboardData | null>(null);

  async function refresh() {
    try {
      const data = await callHost<OrchDashboardData>("orch_dashboard");
      setDashboard(data);
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
    setStatus("Starting delegated run…");
    try {
      const result = await startAgentTask(callHost, {
        repo: repoPath,
        wp,
        slice,
        cli,
        model,
        handoffText,
        effort,
      });
      setStatus(result.text || "Agent started in an isolated worktree.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
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

  return (
    <section className="native-orch-panel" aria-label="Delegated agents">
      <header className="native-orch-header">
        <strong>Agents</strong>
        <button type="button" className="native-close-project" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>
      <p className="native-muted">
        Claim a work package, create a worktree, and launch a worker through orch. Accept/integrate remain explicit.
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
          Start agent
        </button>
      </div>
      <div className="native-orch-runs" aria-live="polite">
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
