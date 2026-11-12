import type { OrchCommandResult } from "./api";
import { callHost } from "./api";

type OrchInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<OrchCommandResult>;

export interface AgentTask {
  repo: string;
  wp: string;
  slice: string;
  cli: string;
  model: string;
  handoffText: string;
  effort: string;
  conversationId?: string | null;
  associationId?: string | null;
}

export interface DelegationAssociation {
  id: string;
  conversationId: string | null;
  repoPath: string;
  wp: string;
  slice: string;
  stage: string;
  disposition: "none" | "accepted" | "finished" | "discarded" | "integrated";
  worktreePath: string | null;
  runId: string | null;
  reviewId: string | null;
  cli: string | null;
  model: string | null;
  note: string | null;
  updatedAtMs: number;
  createdAtMs: number;
}

async function upsertAssociation(
  patch: Record<string, unknown>,
): Promise<DelegationAssociation> {
  const result = await callHost<{ association: DelegationAssociation }>(
    "delegation_upsert",
    patch,
  );
  if (!result?.association?.id) {
    throw new Error("Could not persist the delegation association.");
  }
  return result.association;
}

function sameConversation(
  item: DelegationAssociation,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return true;
  return item.conversationId === conversationId;
}

/**
 * Prepare an isolated task before allowing the coordinator to launch its worker.
 * Persists recoverable intent markers before each side effect and refuses to
 * relaunch when a previous attempt may still own resources.
 */
export async function startAgentTask(invoke: OrchInvoke, task: AgentTask) {
  if (!task.wp.trim() || !task.slice.trim() || !task.handoffText.trim()) {
    throw new Error("Add a work package, task ID, and instructions first.");
  }

  if (typeof task.conversationId !== "string" || task.conversationId.length === 0) {
    throw new Error("Delegation requires an active conversation so the host can bind admission.");
  }
  const listed = await callHost<{ associations: DelegationAssociation[] }>(
    "delegation_list",
    {
      repoPath: task.repo,
      conversationId: task.conversationId,
    },
  );
  const prior = (
    task.associationId
      ? listed.associations.find((item) => item.id === task.associationId)
      : listed.associations.find(
          (item) =>
            item.disposition === "none" &&
            item.wp === task.wp &&
            item.slice === task.slice &&
            sameConversation(item, task.conversationId),
        )
  ) ?? null;

  if (prior && task.conversationId && prior.conversationId && prior.conversationId !== task.conversationId) {
    throw new Error(
      "That association belongs to another conversation; start a new task or resume it from its own chat.",
    );
  }

  if (prior?.stage === "uncertain" || prior?.stage === "launching" && !prior.runId) {
    throw new Error(
      "A previous worker launch is uncertain for this association. Inspect or adopt it before retrying.",
    );
  }
  if (prior?.stage === "preparing_worktree" && !prior.worktreePath) {
    throw new Error(
      "Worktree preparation was interrupted for this association. Inspect it before retrying.",
    );
  }
  if (prior?.runId && prior.disposition === "none") {
    return {
      ok: true,
      text: "Resumed an existing delegated run association.",
      output: { id: prior.runId, path: prior.worktreePath },
      association: prior,
    };
  }

  // Intent record before any orch side effect.
  let association = await upsertAssociation({
    ...(prior?.id ? { id: prior.id } : task.associationId ? { id: task.associationId } : {}),
    conversationId: task.conversationId ?? prior?.conversationId ?? null,
    repoPath: task.repo,
    wp: task.wp,
    slice: task.slice,
    cli: task.cli,
    model: task.model,
    stage: "intent_claim",
    disposition: "none",
    worktreePath: prior?.worktreePath ?? null,
    runId: prior?.runId ?? null,
    note: "Intent recorded before claim/worktree/launch side effects.",
  });

  let worktreePath = association.worktreePath;
  let runId = association.runId;

  if (runId) {
    return {
      ok: true,
      text: "Resumed an existing delegated run association.",
      output: { id: runId, path: worktreePath },
      association,
    };
  }

  if (!worktreePath) {
    association = await upsertAssociation({
      id: association.id,
      stage: "preparing_worktree",
    });
    const claim = await invoke("orch_claim", {
      associationId: association.id,
      wp: task.wp,
    });
    if (!claim.ok) {
      await upsertAssociation({
        id: association.id,
        stage: "uncertain",
        note: claim.text || "Claim failed before worktree creation.",
      }).catch(() => {});
      throw new Error(claim.text || "Could not claim this work package.");
    }
    association = await upsertAssociation({
      id: association.id,
      stage: "claimed",
    });

    const worktree = await invoke("orch_worktree_create", {
      associationId: association.id,
      repo: task.repo,
      wp: task.wp,
      slice: task.slice,
    });
    if (
      !worktree.ok ||
      typeof worktree.output?.path !== "string" ||
      !worktree.output.path
    ) {
      await upsertAssociation({
        id: association.id,
        stage: "uncertain",
        note: worktree.text || "Worktree creation failed after claim.",
      }).catch(() => {});
      throw new Error(
        `${worktree.text || "Could not prepare an isolated worktree."} The work package remains claimed; inspect it before retrying.`,
      );
    }
    worktreePath = worktree.output.path;
    association = await upsertAssociation({
      id: association.id,
      stage: "worktree",
      worktreePath,
    });
  }

  association = await upsertAssociation({
    id: association.id,
    stage: "launching",
    worktreePath,
  });

  const result = await invoke("orch_run", {
    cli: task.cli,
    model: task.model,
    associationId: association.id,
    conversationId: association.conversationId ?? task.conversationId ?? undefined,
    // dir is host-admitted from the association worktree; passed here for
    // local/dev bridge compatibility and stripped/re-derived by the host.
    dir: worktreePath,
    wp: task.wp,
    slice: task.slice,
    handoffText: task.handoffText,
    effort: task.effort,
  });
  if (!result.ok) {
    await upsertAssociation({
      id: association.id,
      stage: "uncertain",
      worktreePath,
      note: result.text || "orch_run failed after launch intent.",
    }).catch(() => {});
    throw new Error(
      `${result.text || "The agent could not be started."} The prepared worktree and claim have been retained.`,
    );
  }
  runId =
    typeof result.output?.id === "string"
      ? result.output.id
      : typeof result.output?.run_id === "string"
        ? result.output.run_id
        : null;
  if (!runId) {
    association = await upsertAssociation({
      id: association.id,
      stage: "uncertain",
      worktreePath,
      note: "orch_run returned ok without a run id; inspect before relaunching.",
    });
    throw new Error(
      "The coordinator did not return a run id. The association is marked uncertain; inspect or adopt it before retrying.",
    );
  }
  association = await upsertAssociation({
    id: association.id,
    stage: "running",
    worktreePath,
    runId,
  });
  return { ...result, association };
}

/** Mark an uncertain association abandoned so a new launch may proceed. */
export async function abandonDelegation(associationId: string, note?: string) {
  return callHost<{ association: DelegationAssociation }>("delegation_abandon", {
    id: associationId,
    note: note ?? "Abandoned after uncertain recovery.",
  });
}

/**
 * Adopt an uncertain association when orch still reports a live run id.
 * Never relaunches; only reattaches observed identity under host authority.
 */
export async function adoptUncertainDelegation(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  if (association.stage !== "uncertain") {
    throw new Error("Only uncertain associations can be adopted.");
  }
  let runId = association.runId;
  let worktreePath = association.worktreePath;
  if (runId) {
    const detail = await invoke("orch_run_detail", { runId });
    if (!detail.ok) {
      throw new Error(detail.text || "Could not inspect the recorded run before adopt.");
    }
  } else {
    throw new Error(
      "No run id was recorded for this uncertain association. Abandon it or inspect orch manually before retrying.",
    );
  }
  return callHost<{ association: DelegationAssociation }>("delegation_adopt", {
    id: association.id,
    note: "Adopted after uncertain recovery; not relaunched.",
  });
}

export async function readDelegationDiff(
  associationId: string,
  filePath?: string,
) {
  return callHost<{
    associationId: string;
    worktreePath: string;
    repoPath: string;
    files: Array<{ status: string; path: string }>;
    path: string | null;
    patch: string | null;
    readOnly: boolean;
  }>("delegation_worktree_diff", {
    id: associationId,
    ...(filePath ? { path: filePath } : {}),
  });
}

/** Record acceptance only — never merges, pushes, or deletes worktrees. */
export async function acceptDelegation(
  invoke: OrchInvoke,
  associationId: string,
  runId: string | null,
) {
  if (runId) {
    const recorded = await invoke("orch_record", {
      associationId,
      runId,
      disposition: "accepted",
      notes: "Accepted from CHO desktop; finish/discard remain explicit.",
    });
    if (!recorded.ok) {
      throw new Error(recorded.text || "Could not record acceptance in orch.");
    }
  }
  return callHost<{ association: DelegationAssociation }>(
    "delegation_set_disposition",
    {
      id: associationId,
      disposition: "accepted",
      note: "Accepted without Git mutation.",
    },
  );
}

/**
 * Explicit coordinator finish/cleanup for the work package.
 * This is not Git integration (merge/cherry-pick); keep that separate.
 */
export async function finishDelegation(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  const preview = await invoke("orch_cleanup", {
    associationId: association.id,
    wp: association.wp,
  });
  const finished = await invoke("orch_finish", {
    associationId: association.id,
    wp: association.wp,
  });
  if (!finished.ok) {
    throw new Error(
      `${finished.text || "Could not finish this work package in orch."}${
        preview.text ? ` Cleanup preview: ${preview.text}` : ""
      }`,
    );
  }
  return callHost<{ association: DelegationAssociation }>(
    "delegation_set_disposition",
    {
      id: association.id,
      disposition: "finished",
      note: "Finished via orch_finish (no Git merge). Worktree cleanup may remove the isolated tree.",
    },
  );
}

/** Cancel a live orch run bound to an association. Does not discard the worktree. */
export async function cancelDelegationRun(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  if (!association.runId) {
    throw new Error("This association has no run id to cancel.");
  }
  const cancelled = await invoke("orch_cancel", {
    associationId: association.id,
    runId: association.runId,
  });
  if (!cancelled.ok) {
    throw new Error(cancelled.text || "Could not cancel the delegated run.");
  }
  return callHost<{ association: DelegationAssociation }>("delegation_upsert", {
    id: association.id,
    stage: "uncertain",
    note: "Worker cancel requested from CHO desktop; inspect before relaunch.",
  });
}

/**
 * Explicit Git merge of the association worktree branch into the repo HEAD.
 * Requires prior Accept. Dry-run when previewOnly. Not Finish/cleanup.
 */
export async function integrateDelegation(
  _invoke: OrchInvoke,
  association: DelegationAssociation,
  options: { previewOnly?: boolean; previewToken?: string } = {},
) {
  if (association.disposition !== "accepted") {
    throw new Error("Accept the result before Integrate. Finish remains a separate orch closure.");
  }
  if (!options.previewOnly && !options.previewToken) {
    throw new Error("Integrate apply requires the previewToken from dry-run.");
  }
  return callHost<{
    associationId: string;
    sourceBranch: string;
    targetBranch: string;
    sourceSha: string;
    targetSha: string;
    commits: number;
    merged: boolean;
    dryRun: boolean;
    previewToken?: string;
    note: string;
    association?: DelegationAssociation;
  }>("delegation_integrate", {
    id: association.id,
    ...(options.previewOnly
      ? { dryRun: true }
      : { previewToken: options.previewToken }),
  });
}

/** Explicit discard — cleanup + release; not implied by acceptance. */
export async function discardDelegation(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  // Dry-run first so the UI/error path can surface retention reasons.
  const preview = await invoke("orch_cleanup", {
    associationId: association.id,
    wp: association.wp,
  });
  const cleanup = await invoke("orch_cleanup", {
    associationId: association.id,
    wp: association.wp,
    apply: true,
  });
  if (!cleanup.ok) {
    throw new Error(
      `${cleanup.text || "Could not clean up the delegated worktree."}${
        preview.text ? ` Preview: ${preview.text}` : ""
      }`,
    );
  }
  const released = await invoke("orch_release", {
    associationId: association.id,
    wp: association.wp,
    reason: "discarded from CHO desktop",
  });
  if (!released.ok) {
    throw new Error(
      `${released.text || "Cleanup applied but claim release failed."} Inspect the work package before retrying.`,
    );
  }
  return callHost<{ association: DelegationAssociation }>(
    "delegation_set_disposition",
    {
      id: association.id,
      disposition: "discarded",
      note: "Discarded via cleanup + release.",
    },
  );
}

export async function listDelegations(repoPath: string, conversationId?: string | null) {
  const result = await callHost<{ associations: DelegationAssociation[] }>(
    "delegation_list",
    {
      repoPath,
      ...(conversationId ? { conversationId } : {}),
    },
  );
  return result.associations ?? [];
}
