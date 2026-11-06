import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { integrateAssociationWorktree } from "../server/delegation-integrate.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-integrate-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  // Ensure a named branch (not detached).
  try {
    git(repo, ["checkout", "-B", "main"]);
  } catch {
    /* already on main/master */
  }
  const target = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const wt = path.join(repo, ".worktrees", "cho-05-delegate");
  git(repo, ["worktree", "add", "-b", "orch/cho-05/delegate", wt, "HEAD"]);
  fs.writeFileSync(path.join(wt, "feature.txt"), "from worker\n");
  git(wt, ["add", "feature.txt"]);
  git(wt, ["commit", "-m", "worker change"]);
  return { root, repo, wt, target };
}

describe("delegation integrate", () => {
  it("dry-runs and then merges an accepted association branch", { timeout: 30_000 }, async () => {
    const { repo, wt, target } = makeRepo();
    const association = {
      id: "assoc-1",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      disposition: "accepted",
      stage: "worktree",
    };
    let disposition = "accepted";
    const store = {
      get: () => ({ ...association, disposition }),
      setDisposition: (id, next, note) => {
        disposition = next;
        return { ...association, id, disposition: next, note };
      },
    };
    const preview = await integrateAssociationWorktree(store, { id: "assoc-1", dryRun: true });
    expect(preview.merged).toBe(false);
    expect(preview.sourceBranch).toBe("orch/cho-05/delegate");
    expect(preview.targetBranch).toBe(target);
    expect(preview.commits).toBeGreaterThanOrEqual(1);

    const result = await integrateAssociationWorktree(store, { id: "assoc-1" });
    expect(result.merged).toBe(true);
    expect(disposition).toBe("integrated");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
  });

  it("refuses integrate before Accept", async () => {
    const store = {
      get: () => ({
        id: "a",
        disposition: "none",
        stage: "worktree",
        repoPath: "/x",
        worktreePath: "/x/wt",
        wp: "cho-05",
        slice: "delegate",
      }),
      setDisposition: () => {
        throw new Error("should not set");
      },
    };
    await expect(integrateAssociationWorktree(store, { id: "a" })).rejects.toThrow(/Accept/);
  });
});
