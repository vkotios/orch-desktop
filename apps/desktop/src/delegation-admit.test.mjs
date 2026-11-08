import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitOrchRunArgs, stripPrivilegedOrchFlags } from "../server/delegation-admit.mjs";

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-admit-"));
  const repo = path.join(root, "repo");
  const wt = path.join(repo, ".worktrees", "slice");
  fs.mkdirSync(wt, { recursive: true });
  return { root, repo, wt };
}

describe("delegation admission", () => {
  it("strips privileged renderer flags", () => {
    const admitted = stripPrivilegedOrchFlags({
      ownerApprovedModel: true,
      allow: ["*"],
      by: "attacker",
      wp: "cho-05",
    });
    expect(admitted.ownerApprovedModel).toBeUndefined();
    expect(admitted.allow).toBeUndefined();
    expect(admitted.by).toBe("owner");
    expect(admitted.wp).toBe("cho-05");
  });

  it("admits orch_run only with conversation + approved route + contained worktree", () => {
    const { repo, wt } = fixtureRepo();
    const association = {
      id: "a1",
      conversationId: "11111111-1111-4111-8111-111111111111",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      disposition: "none",
      stage: "launching",
      cli: "codex",
      model: "gpt-test",
    };
    const admitted = admitOrchRunArgs(association, {
      associationId: "a1",
      cli: "codex",
      model: "gpt-test",
      dir: "C:/evil",
      ownerApprovedModel: true,
      force: true,
    });
    expect(admitted.dir).toBe(path.resolve(wt));
    expect(admitted.cli).toBe("codex");
    expect(admitted.model).toBe("gpt-test");
    expect(admitted.conversationId).toBe(association.conversationId);
    expect(admitted.ownerApprovedModel).toBeUndefined();
    expect(admitted.force).toBeUndefined();
    expect(admitted.by).toBe("owner");
  });

  it("refuses missing conversation, route mismatch, or foreign worktree", () => {
    const { repo, wt } = fixtureRepo();
    const base = {
      id: "a1",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      disposition: "none",
      cli: "codex",
      model: "gpt-test",
    };
    expect(() => admitOrchRunArgs({ ...base, conversationId: null }, {})).toThrow(/conversation-bound/);
    expect(() =>
      admitOrchRunArgs(
        { ...base, conversationId: "11111111-1111-4111-8111-111111111111" },
        { cli: "claude" },
      ),
    ).toThrow(/cli does not match/);
    expect(() =>
      admitOrchRunArgs(
        {
          ...base,
          conversationId: "11111111-1111-4111-8111-111111111111",
          worktreePath: path.join(os.tmpdir(), "outside-wt"),
        },
        {},
      ),
    ).toThrow(/worktree path/);
  });
});
