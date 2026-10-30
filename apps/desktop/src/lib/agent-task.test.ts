import { describe, expect, it, vi } from "vitest";
import { startAgentTask } from "./agent-task";

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

describe("agent task preparation", () => {
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
      dir: "C:/project/.worktrees/wp-ui-s1",
      by: "owner",
      wp: "WP-UI",
      handoffText: task.handoffText,
    });
  });

  it("does not create a worktree or launch when another claimant holds the package", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        exitCode: 3,
        output: null,
        text: "Claim held by another controller",
      });
    await expect(startAgentTask(invoke, task)).rejects.toThrow("Claim held");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to the main repository if worktree preparation fails", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    await expect(startAgentTask(invoke, task)).rejects.toThrow(
      "remains claimed",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects empty instructions before creating any resources", async () => {
    const invoke = vi.fn();
    await expect(
      startAgentTask(invoke, { ...task, handoffText: "  " }),
    ).rejects.toThrow("instructions");
    expect(invoke).not.toHaveBeenCalled();
  });
});
