import { beforeEach, describe, expect, it, vi } from "vitest";

const callHost = vi.fn();

vi.mock("./api", () => ({
  callHost: (...args: unknown[]) => callHost(...args),
}));

const { adoptUncertainDelegation, integrateDelegation, startAgentTask } =
  await import("./agent-task");

const task = {
  repo: "C:/project",
  wp: "WP-UI",
  slice: "s1",
  cli: "codex",
  model: "fixture-model",
  handoffText: "Inspect src/example.ts",
  effort: "high",
  conversationId: "conv-a",
};
const ok = (output: object = {}) => ({
  ok: true,
  exitCode: 0,
  output,
  text: "",
});

function association(
  patch: Partial<import("./agent-task").DelegationAssociation> = {},
): import("./agent-task").DelegationAssociation {
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

  it("adopts an uncertain association with a recorded run without relaunching", async () => {
    const invoke = vi.fn().mockResolvedValue(ok({ id: "run-1" }));
    const result = await adoptUncertainDelegation(
      invoke,
      association({
        stage: "uncertain",
        runId: "run-1",
        worktreePath: "C:/project/.worktrees/WP-UI",
      }),
    );
    expect(invoke).toHaveBeenCalledWith("orch_run_detail", { runId: "run-1" });
    expect(callHost).toHaveBeenCalledWith(
      "delegation_upsert",
      expect.objectContaining({ id: "assoc-1", stage: "running", runId: "run-1" }),
    );
    expect(result.association.stage).toBe("running");
  });

  it("refuses adopt when uncertain association has no run id", async () => {
    const invoke = vi.fn();
    await expect(
      adoptUncertainDelegation(invoke, association({ stage: "uncertain", runId: null })),
    ).rejects.toThrow("No run id");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops before claim when mocked orch_scope denial is surfaced by start prep", async () => {
    // Desktop journey: a denied scope must not create worktrees or launch.
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      exitCode: 4,
      output: null,
      text: "Scope denied for this work package",
    });
    // Simulate an earlier scope gate by failing the claim with a scope message
    // (host admission still binds associationId; no relaunch).
    await expect(startAgentTask(invoke, task)).rejects.toThrow(/Scope denied|Claim/);
    expect(invoke.mock.calls.every((call) => call[0] !== "orch_run")).toBe(true);
    expect(invoke.mock.calls.every((call) => call[0] !== "orch_worktree_create")).toBe(true);
  });

  it("requires Accept before Integrate and uses host delegation_integrate", async () => {
    const invoke = vi.fn();
    await expect(integrateDelegation(invoke, association({ disposition: "none" }))).rejects.toThrow(
      /Accept/,
    );
    expect(callHost).not.toHaveBeenCalled();
    callHost.mockResolvedValueOnce({
      associationId: "assoc-1",
      sourceBranch: "orch/wp-ui/s1",
      targetBranch: "main",
      sourceSha: "a".repeat(40),
      targetSha: "b".repeat(40),
      commits: 1,
      merged: false,
      dryRun: true,
      previewToken: "token.sig",
      note: "preview",
    });
    const preview = await integrateDelegation(
      invoke,
      association({ disposition: "accepted", stage: "recorded" }),
      { previewOnly: true },
    );
    expect(preview.dryRun).toBe(true);
    expect(callHost).toHaveBeenCalledWith(
      "delegation_integrate",
      expect.objectContaining({ id: "assoc-1", dryRun: true }),
    );
    await expect(
      integrateDelegation(invoke, association({ disposition: "accepted", stage: "recorded" })),
    ).rejects.toThrow(/previewToken/);
  });
});
