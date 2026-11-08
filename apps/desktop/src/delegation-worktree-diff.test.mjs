import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDelegationAssociations } from "../server/delegation-associations.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/**
 * Mirrors host.mjs readAssociationWorktreeDiff overlay semantics for an
 * isolated fixture. Keeps the product rule under test without booting runHost.
 */
async function overlayDiff({ repoRoot, worktreePath, branch }) {
  const baseline = git(repoRoot, ["merge-base", "HEAD", branch]);
  const nameStatus = git(repoRoot, [
    "diff", "--name-status", "--no-ext-diff", `${baseline}...${branch}`,
  ]);
  const files = nameStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t/);
      return { status: parts[0] || "M", path: parts[parts.length - 1], dirty: false };
    });
  const porcelain = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  const dirtyFiles = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).replace(/\\/g, "/"),
      dirty: true,
    }));
  const seen = new Set(files.map((f) => f.path));
  for (const dirty of dirtyFiles) {
    if (!seen.has(dirty.path)) {
      files.push(dirty);
      seen.add(dirty.path);
    } else {
      const idx = files.findIndex((f) => f.path === dirty.path);
      if (idx >= 0) files[idx] = { ...files[idx], dirty: true, worktreeStatus: dirty.status };
    }
  }
  return { baseline, files, dirtyCount: dirtyFiles.length };
}

describe("delegation worktree diff dirty overlay", () => {
  it("includes committed branch changes plus dirty and untracked worktree files", { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-diff-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    try { git(repo, ["checkout", "-B", "main"]); } catch { /* ok */ }
    const wt = path.join(repo, ".worktrees", "cho-05-delegate");
    git(repo, ["worktree", "add", "-b", "orch/cho-05/delegate", wt, "HEAD"]);
    fs.writeFileSync(path.join(wt, "feature.txt"), "committed\n");
    git(wt, ["add", "feature.txt"]);
    git(wt, ["commit", "-m", "worker"]);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty\n");
    fs.writeFileSync(path.join(wt, "untracked.txt"), "new\n");

    const storePath = path.join(root, "assoc.json");
    const store = createDelegationAssociations({ filePath: storePath });
    const association = store.upsert({
      id: "assoc-diff-1",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      stage: "recorded",
      disposition: "none",
      runId: "run-1",
    });
    expect(association.worktreePath).toBe(wt);

    const result = await overlayDiff({
      repoRoot: repo,
      worktreePath: wt,
      branch: "orch/cho-05/delegate",
    });
    expect(result.dirtyCount).toBeGreaterThanOrEqual(2);
    expect(result.files.some((f) => f.path === "feature.txt")).toBe(true);
    expect(result.files.some((f) => f.path === "dirty.txt" && f.dirty)).toBe(true);
    expect(result.files.some((f) => f.path === "untracked.txt" && f.dirty)).toBe(true);
  });
});
