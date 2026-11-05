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
  disposition: "none" | "accepted" | "integrated" | "discarded";
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

/**
 * Prepare an isolated task before allowing the coordinator to launch its worker.
 * Persists recoverable stage markers after each successful side effect.
 */
export async function startAgentTask(invoke: OrchInvoke, task: AgentTask) {
  if (!task.wp.trim() || !task.slice.trim() || !task.handoffText.trim()) {
    throw new Error("Add a work package, task ID, and instructions first.");
  }

  let association = await upsertAssociation({
    ...(task.associationId ? { id: task.associationId } : {}),
    conversationId: task.conversationId ?? null,
    repoPath: task.repo,
    wp: task.wp,
    slice: task.slice,
    cli: task.cli,
    model: task.model,
    stage: "claimed",
    disposition: "none",
  });

  const listed = await callHost<{ associations: DelegationAssociation[] }>(
    "delegation_list",
    { repoPath: task.repo },
  );
  const prior = task.associationId
    ? listed.associations.find((item) => item.id === task.associationId) ?? null
    : null;

  let worktreePath = prior?.worktreePath ?? null;
  let runId = prior?.runId ?? null;

  if (!worktreePath) {
    const claim = await invoke("orch_claim", { wp: task.wp, by: "owner" });
    if (!claim.ok) {
      throw new Error(claim.text || "Could not claim this work package.");
    }
    association = await upsertAssociation({
      id: association.id,
      stage: "claimed",
    });

    const worktree = await invoke("orch_worktree_create", {
      repo: task.repo,
      wp: task.wp,
      slice: task.slice,
      by: "owner",
    });
    if (
      !worktree.ok ||
      typeof worktree.output?.path !== "string" ||
      !worktree.output.path
    ) {
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

  if (!runId) {
    const result = await invoke("orch_run", {
      cli: task.cli,
      model: task.model,
      dir: worktreePath,
      by: "owner",
      wp: task.wp,
      slice: task.slice,
      handoffText: task.handoffText,
      effort: task.effort,
    });
    if (!result.ok) {
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
    association = await upsertAssociation({
      id: association.id,
      stage: "running",
      worktreePath,
      runId,
    });
    return { ...result, association };
  }

  return {
    ok: true,
    text: "Resumed an existing delegated run association.",
    output: { id: runId, path: worktreePath },
    association,
  };
}

/** Record acceptance only — never merges, pushes, or deletes worktrees. */
export async function acceptDelegation(
  invoke: OrchInvoke,
  associationId: string,
  runId: string | null,
) {
  if (runId) {
    const recorded = await invoke("orch_record", {
      runId,
      disposition: "accepted",
      notes: "Accepted from CHO desktop; integrate/discard remain explicit.",
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

/** Explicit finish/integration — separate from acceptance. */
export async function integrateDelegation(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  const finished = await invoke("orch_finish", {
    wp: association.wp,
    by: "owner",
  });
  if (!finished.ok) {
    throw new Error(
      finished.text || "Could not finish/integrate this work package.",
    );
  }
  return callHost<{ association: DelegationAssociation }>(
    "delegation_set_disposition",
    {
      id: association.id,
      disposition: "integrated",
      note: "Integrated via orch_finish.",
    },
  );
}

/** Explicit discard — cleanup + release; not implied by acceptance. */
export async function discardDelegation(
  invoke: OrchInvoke,
  association: DelegationAssociation,
) {
  const cleanup = await invoke("orch_cleanup", {
    wp: association.wp,
    apply: true,
    by: "owner",
  });
  if (!cleanup.ok) {
    throw new Error(
      cleanup.text || "Could not clean up the delegated worktree.",
    );
  }
  const released = await invoke("orch_release", {
    wp: association.wp,
    by: "owner",
    force: true,
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

export async function listDelegations(repoPath: string) {
  const result = await callHost<{ associations: DelegationAssociation[] }>(
    "delegation_list",
    { repoPath },
  );
  return result.associations ?? [];
}
