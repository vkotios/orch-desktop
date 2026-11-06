import { beforeEach, describe, expect, it, vi } from "vitest";

const callHost = vi.fn();

vi.mock("./api", () => ({
  callHost: (...args: unknown[]) => callHost(...args),
}));

const { startAgentTask } = await import("./agent-task");

const task = {
  repo: "C:/project",
  wp: "WP-UI",
  slice: "s1",
  cli: "codex",
  model: "fixture-model",
  handoffText: "Inspect src/example.ts",
  effort: "high",
};
const ok = (output: object = {}) => ({
  ok: true,
  exitCode: 0,
  output,
  text: "",
});

function association(patch: Record<string, unknown> = {}) {
  return {
    id: "assoc-1",
    conversationId: null,
    repoPath: task.repo,
    wp: task.wp,
    slice: task.slice,
    stage: "claimed",
    disposition: "none",
    worktreePath: null,
    runId: null,
    reviewId: null,
    cli: task.cli,
    model: task.model,
    note: null,
    updatedAtMs: 1,
    createdAtMs: 1,
    ...patch,
  };
}

beforeEach(() => {
  callHost.mockReset();
  callHost.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "delegation_upsert") {
      return { association: association(args) };
    }
    if (command === "delegation_list") {
      return { associations: [] };
    }
    throw new Error(`unexpected callHost ${command}`);
  });
});

describe("agent task preparation", () => {
  it("filters open associations by conversation and refuses cross-chat adoption", async () => {
    callHost.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "delegation_list") {
        return {
          associations: [
            association({
              id: "other-chat",
              conversationId: "conv-b",
              stage: "running",
              runId: "run-other",
            }),
          ],
        };
      }
      if (command === "delegation_upsert") {
        return { association: association(args) };
      }
      throw new Error(`unexpected callHost ${command}`);
    });
    const invoke = vi.fn();
    await expect(
      startAgentTask(invoke, { ...task, conversationId: "conv-a", associationId: "other-chat" }),
    ).rejects.toThrow(/another conversation/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks launch without run id as uncertain instead of running", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok({ path: "C:/project/.worktrees/wp-ui-s1" }))
      .mockResolvedValueOnce(ok({}));
    await expect(startAgentTask(invoke, task)).rejects.toThrow(/run id/);
    const stages = callHost.mock.calls
      .filter((call) => call[0] === "delegation_upsert")
      .map((call) => (call[1] as { stage?: string }).stage);
    expect(stages).toContain("uncertain");
    expect(stages).not.toContain("running");
  });

  it("launches only after claiming and creating a worktree, using the returned path", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok({ path: "C:/project/.worktrees/wp-ui-s1" }))
      .mockResolvedValueOnce(ok({ id: "run-1" }));
    await startAgentTask(invoke, task);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "orch_claim",
      "orch_worktree_create",
      "orch_run",
    ]);
    expect(invoke.mock.calls[2][1]).toMatchObject({
      associationId: "assoc-1",
      dir: "C:/project/.worktrees/wp-ui-s1",
      wp: "WP-UI",
      handoffText: task.handoffText,
    });
    expect(invoke.mock.calls[2][1].by).toBeUndefined();
    expect(invoke.mock.calls[2][1].ownerApprovedModel).toBeUndefined();
    expect(callHost.mock.calls.some((call) => call[0] === "delegation_upsert")).toBe(true);
  });

  it("does not create a worktree or launch when another claimant holds the package", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      exitCode: 3,
      output: null,
      text: "Claim held by another controller",
    });
    await expect(startAgentTask(invoke, task)).rejects.toThrow("Claim held");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to the main repository if worktree preparation fails", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    await expect(startAgentTask(invoke, task)).rejects.toThrow("remains claimed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects empty instructions before creating any resources", async () => {
    const invoke = vi.fn();
    await expect(
      startAgentTask(invoke, { ...task, handoffText: "  " }),
    ).rejects.toThrow("instructions");
    expect(invoke).not.toHaveBeenCalled();
    expect(callHost).not.toHaveBeenCalled();
  });
});
