import type { OrchCommandResult } from "./api";

type Invoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<OrchCommandResult>;
interface AgentTask {
  repo: string;
  wp: string;
  slice: string;
  cli: string;
  model: string;
  handoffText: string;
  effort: string;
}

/** Prepare an isolated task before allowing the coordinator to launch its worker. */
export async function startAgentTask(invoke: Invoke, task: AgentTask) {
  if (!task.wp.trim() || !task.slice.trim() || !task.handoffText.trim()) {
    throw new Error("Add a work package, task ID, and instructions first.");
  }
  const claim = await invoke("orch_claim", { wp: task.wp, by: "owner" });
  if (!claim.ok)
    throw new Error(claim.text || "Could not claim this work package.");

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

  const result = await invoke("orch_run", {
    cli: task.cli,
    model: task.model,
    dir: worktree.output.path,
    by: "owner",
    wp: task.wp,
    slice: task.slice,
    handoffText: task.handoffText,
    effort: task.effort,
  });
  if (!result.ok)
    throw new Error(
      `${result.text || "The agent could not be started."} The prepared worktree and claim have been retained.`,
    );
  return result;
}
