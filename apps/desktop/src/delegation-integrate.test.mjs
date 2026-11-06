import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { integrateAssociationWorktree } from "../server/delegation-integrate.mjs";
import { deriveReviewInspection } from "../server/delegation-integrate-evidence.mjs";

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

const okHooks = {
  inspectRun: async () => ({ ok: true, terminal: true }),
  inspectGate: async () => ({ ok: true, converged: true }),
  inspectReview: async () => ({ ok: true, clean: true }),
};

describe("delegation integrate", () => {
  it("dry-runs with a preview token and merges only when refs still match", { timeout: 30_000 }, async () => {
    const { repo, wt, target } = makeRepo();
    const association = {
      id: "assoc-1",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      disposition: "accepted",
      stage: "recorded",
      runId: "run-1",
    };
    let disposition = "accepted";
    const store = {
      get: () => ({ ...association, disposition }),
      setDisposition: (id, next, note) => {
        disposition = next;
        return { ...association, id, disposition: next, note };
      },
    };
    const preview = await integrateAssociationWorktree(store, { id: "assoc-1", dryRun: true }, okHooks);
    expect(preview.merged).toBe(false);
    expect(preview.previewToken).toMatch(/\./);
    expect(preview.sourceBranch).toBe("orch/cho-05/delegate");
    expect(preview.targetBranch).toBe(target);
    expect(preview.sourceSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(preview.commits).toBeGreaterThanOrEqual(1);

    // A new commit after preview must invalidate apply.
    fs.writeFileSync(path.join(wt, "extra.txt"), "after preview\n");
    git(wt, ["add", "extra.txt"]);
    git(wt, ["commit", "-m", "after preview"]);
    await expect(
      integrateAssociationWorktree(store, { id: "assoc-1", previewToken: preview.previewToken }, okHooks),
    ).rejects.toThrow(/stale|sourceSha/);

    // Refresh preview and apply.
    const preview2 = await integrateAssociationWorktree(store, { id: "assoc-1", dryRun: true }, okHooks);
    const result = await integrateAssociationWorktree(
      store,
      { id: "assoc-1", previewToken: preview2.previewToken },
      okHooks,
    );
    expect(result.merged).toBe(true);
    expect(disposition).toBe("integrated");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "extra.txt"))).toBe(true);
  });

  it("refuses integrate before Accept and without gate/review hooks", async () => {
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
    await expect(integrateAssociationWorktree(store, { id: "a" }, okHooks)).rejects.toThrow(/Accept/);
    const { repo, wt } = makeRepo();
    await expect(
      integrateAssociationWorktree(
        {
          get: () => ({
            id: "b",
            disposition: "accepted",
            stage: "recorded",
            repoPath: repo,
            worktreePath: wt,
            wp: "cho-05",
            slice: "delegate",
            runId: null,
          }),
          setDisposition: () => null,
        },
        { id: "b", dryRun: true },
        {},
      ),
    ).rejects.toThrow(/gate inspection/);
  });

  it("binds review inspection to the Git-resolved source SHA, not association fields", { timeout: 30_000 }, async () => {
    const { repo, wt } = makeRepo();
    const reviewedSha = git(repo, ["rev-parse", "orch/cho-05/delegate"]);
    // Extra commit after the successful review of reviewedSha.
    fs.writeFileSync(path.join(wt, "later.txt"), "unreviewed\n");
    git(wt, ["add", "later.txt"]);
    git(wt, ["commit", "-m", "after review"]);
    const currentSha = git(repo, ["rev-parse", "orch/cho-05/delegate"]);
    expect(currentSha).not.toBe(reviewedSha);

    const association = {
      id: "assoc-sha",
      repoPath: repo,
      worktreePath: wt,
      wp: "cho-05",
      slice: "delegate",
      disposition: "accepted",
      stage: "recorded",
      runId: "run-1",
      // Renderer/stale fields must be ignored even if somehow present.
      sourceSha: reviewedSha,
      reviewedCommit: reviewedSha,
    };
    const seen = [];
    const hooks = {
      inspectRun: async () => ({ ok: true, terminal: true }),
      inspectGate: async () => ({ ok: true, converged: true }),
      inspectReview: async (assoc, ctx) => {
        seen.push(ctx?.sourceSha);
        return deriveReviewInspection(
          {
            ok: true,
            reviews: [
              {
                id: "rev-old",
                wp: assoc.wp,
                slice: assoc.slice,
                implementer_run: assoc.runId,
                containment: "clean",
                outcome: "reviewed",
                finished_at: "2026-11-06T10:00:00Z",
                commit: reviewedSha,
              },
            ],
          },
          {
            wp: assoc.wp,
            runId: assoc.runId,
            slice: assoc.slice,
            sourceSha: ctx?.sourceSha,
          },
        );
      },
    };
    await expect(
      integrateAssociationWorktree(
        { get: () => association, setDisposition: () => association },
        { id: "assoc-sha", dryRun: true },
        hooks,
      ),
    ).rejects.toThrow(/not a successful clean review|No exact review|source SHA|review/i);
    expect(seen).toEqual([currentSha]);
  });
});
