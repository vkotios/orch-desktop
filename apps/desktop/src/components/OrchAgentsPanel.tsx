import { useState } from "react";
import { callHost, type OrchCommandResult, type OrchDashboardData } from "../lib/api";
import {
  abandonDelegation,
  acceptDelegation,
  adoptUncertainDelegation,
  cancelDelegationRun,
  discardDelegation,
  finishDelegation,
  integrateDelegation,
  listDelegations,
  readDelegationDiff,
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
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [diffText, setDiffText] = useState("");
  const [diffTitle, setDiffTitle] = useState("");

  async function refresh() {
    try {
      const [data, listed] = await Promise.all([
        callHost<OrchDashboardData>("orch_dashboard"),
        listDelegations(repoPath, conversationId),
      ]);
      setDashboard(data);
      setAssociations(listed);
      setError("");
      const nextEvidence: Record<string, string> = {};
      for (const item of listed.filter((a) => isOpenDisposition(a.disposition)).slice(0, 8)) {
        const parts: string[] = [];
        try {
          const gate = await callHost<OrchCommandResult>("orch_gate_status", {
            wp: item.wp,
            slice: item.slice,
          });
          parts.push(`gate: ${gate.text || JSON.stringify(gate.output || {}).slice(0, 160)}`);
        } catch (err) {
          parts.push(`gate: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (item.runId) {
          try {
            const detail = await callHost<OrchCommandResult>("orch_run_detail", {
              runId: item.runId,
            });
            parts.push(`run: ${detail.text || JSON.stringify(detail.output || {}).slice(0, 160)}`);
          } catch (err) {
            parts.push(`run: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            const scope = await callHost<OrchCommandResult>("orch_scope", {
              runId: item.runId,
            });
            parts.push(`scope: ${scope.text || JSON.stringify(scope.output || {}).slice(0, 120)}`);
          } catch (err) {
            parts.push(`scope: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          const cleanup = await callHost<OrchCommandResult>("orch_cleanup", {
            wp: item.wp,
          });
          parts.push(`cleanup preview: ${cleanup.text || JSON.stringify(cleanup.output || {}).slice(0, 160)}`);
        } catch (err) {
          parts.push(`cleanup preview: ${err instanceof Error ? err.message : String(err)}`);
        }
        nextEvidence[item.id] = parts.join(" · ");
      }
      setEvidence(nextEvidence);
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

  async function onAdoptUncertain(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await adoptUncertainDelegation(callHost, item);
      setStatus(`Adopted uncertain association ${item.wp}/${item.slice}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onAbandonUncertain(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await abandonDelegation(item.id);
      setStatus(`Abandoned uncertain association ${item.wp}/${item.slice}.`);
      if (resumeId === item.id) setResumeId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onShowDiff(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      const diff = await readDelegationDiff(item.id);
      const lines = [
        `Worktree: ${diff.worktreePath}`,
        `Files: ${diff.files.length}`,
        ...diff.files.slice(0, 40).map((f) => `${f.status} ${f.path}`),
        "",
        diff.patch || "(no patch summary)",
      ];
      setDiffTitle(`${item.wp}/${item.slice} changes`);
      setDiffText(lines.join("\n"));
      setStatus(`Loaded read-only diff for ${item.wp}/${item.slice}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCancelRun(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      await cancelDelegationRun(callHost, item);
      setStatus(`Cancel requested for ${item.runId}.`);
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
      const preview = await callHost<OrchCommandResult>("orch_cleanup", {
        associationId: item.id,
        wp: item.wp,
      });
      const previewText = preview.text || JSON.stringify(preview.output || {}).slice(0, 240);
      const confirmed = window.confirm(
        `Finish ${item.wp}/${item.slice}? This closes the orch claim and may remove the worktree (not a Git merge).\n\nCleanup preview:\n${previewText}`,
      );
      if (!confirmed) {
        setStatus("Finish cancelled.");
        return;
      }
      await finishDelegation(callHost, item);
      setStatus(`Finished ${item.wp} in orch (not a Git merge).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onIntegrate(item: DelegationAssociation) {
    setBusy(true);
    setError("");
    try {
      const preview = await integrateDelegation(callHost, item, { previewOnly: true });
      const confirmed = window.confirm(
        `Integrate ${item.wp}/${item.slice}?\nThis merges ${preview.sourceBranch} into ${preview.targetBranch} (${preview.commits} commit(s)).\nFinish/cleanup remain separate.\n\n${preview.note}`,
      );
      if (!confirmed) {
        setStatus("Integrate cancelled.");
        return;
      }
      const result = await integrateDelegation(callHost, item);
      setStatus(result.note || `Integrated ${item.wp}.`);
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
        Claim, worktree, and run are recoverable. Accept records a decision only. Integrate merges the worktree branch after Accept (with dry-run confirm). Finish closes the orch claim and may remove the worktree; it does not merge Git. Uncertain stages need inspect/adopt before relaunch.
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
                {item.note ? <small className="native-muted">{item.note}</small> : null}
                {item.worktreePath ? (
                  <small className="native-muted" title={item.worktreePath}>
                    Worktree: {item.worktreePath}
                  </small>
                ) : null}
                {evidence[item.id] ? (
                  <small className="native-muted" title={evidence[item.id]}>
                    Evidence: {evidence[item.id]}
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
                  {item.worktreePath ? (
                    <button
                      type="button"
                      className="native-button"
                      disabled={busy}
                      title="Read-only changed-file summary for the owned worktree."
                      onClick={() => void onShowDiff(item)}
                    >
                      Diff
                    </button>
                  ) : null}
                  {item.runId && item.disposition === "none" && item.stage !== "uncertain" ? (
                    <button
                      type="button"
                      className="native-button"
                      disabled={busy}
                      title="Request orch cancel for the recorded run. Does not discard the worktree."
                      onClick={() => void onCancelRun(item)}
                    >
                      Stop worker
                    </button>
                  ) : null}
                  {item.stage === "uncertain" ? (
                    <>
                      <button
                        type="button"
                        className="native-button"
                        disabled={busy || !item.runId}
                        title="Reattach a recorded run without relaunching."
                        onClick={() => void onAdoptUncertain(item)}
                      >
                        Adopt
                      </button>
                      <button
                        type="button"
                        className="native-button"
                        disabled={busy}
                        onClick={() => void onAbandonUncertain(item)}
                      >
                        Abandon uncertain
                      </button>
                    </>
                  ) : null}
                  {item.disposition === "none" && item.stage !== "uncertain" ? (
                    <button type="button" className="native-button" disabled={busy} onClick={() => void onAccept(item)}>
                      Accept
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="native-button"
                    disabled={busy || item.stage === "uncertain"}
                    title="Closes the orch work package and may delete the worktree. Does not merge or cherry-pick."
                    onClick={() => void onFinish(item)}
                  >
                    Finish
                  </button>
                  <button
                    type="button"
                    className="native-button"
                    disabled={busy || item.disposition !== "accepted" || item.stage === "uncertain"}
                    title="Merge the accepted worktree branch into the repository HEAD after a dry-run preview. Not Finish/cleanup."
                    onClick={() => void onIntegrate(item)}
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
        {diffText ? (
          <section className="native-orch-diff" aria-label={diffTitle || "Worktree changes"}>
            <header className="native-orch-header">
              <strong>{diffTitle || "Worktree changes"}</strong>
              <button type="button" className="native-close-project" onClick={() => { setDiffText(""); setDiffTitle(""); }}>
                Close diff
              </button>
            </header>
            <pre className="native-orch-diff-body">{diffText}</pre>
          </section>
        ) : null}
      </div>
    </section>
  );
}
