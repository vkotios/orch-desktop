// Host-owned orch mutation admission (ORCH-09). Renderer flags never
// self-authorize models, force release, or choose execution directories.
// Pure helpers so admission rules can be unit-tested without booting runHost.

import fs from "node:fs";
import path from "node:path";

/**
 * Admit orch_run args against a host association record.
 * Derives dir/wp/slice/cli/model from the association; strips renderer force/
 * ownerApprovedModel/allow; requires conversation + approved route binding.
 *
 * @param {object|null} association
 * @param {object} rawArgs
 * @returns {object} admitted args
 */
export function admitOrchRunArgs(association, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? { ...rawArgs }
    : {};
  delete args.ownerApprovedModel;
  delete args.allow;
  delete args.force;
  args.by = "owner";

  if (!association || typeof association !== "object") {
    throw new Error("orch_run association not found");
  }
  if (association.disposition !== "none") {
    throw new Error("orch_run association is no longer open");
  }
  if (typeof association.conversationId !== "string" || association.conversationId.length === 0) {
    throw new Error("orch_run requires a conversation-bound association");
  }
  if (typeof association.cli !== "string" || association.cli.length === 0) {
    throw new Error("orch_run requires an approved-route cli on the association");
  }
  if (typeof association.model !== "string" || association.model.length === 0) {
    throw new Error("orch_run requires an approved-route model on the association");
  }
  if (typeof association.worktreePath !== "string" || association.worktreePath.length === 0) {
    throw new Error("orch_run association has no worktree path yet");
  }
  if (typeof association.repoPath !== "string" || association.repoPath.length === 0) {
    throw new Error("orch_run association has no prepared project repoPath");
  }

  const worktreePath = path.resolve(association.worktreePath);
  const repoRoot = path.resolve(association.repoPath);
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error("orch_run prepared project path is missing");
  }
  if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
    throw new Error("orch_run worktree path does not exist");
  }
  const rel = path.relative(repoRoot, worktreePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("orch_run worktree path is outside the associated repository");
  }

  // Renderer-supplied route must match the recorded approved route, then host
  // overwrites so execution cannot drift from the association receipt.
  if (typeof args.cli === "string" && args.cli.length > 0 && args.cli !== association.cli) {
    throw new Error("orch_run cli does not match the association approved route");
  }
  if (typeof args.model === "string" && args.model.length > 0 && args.model !== association.model) {
    throw new Error("orch_run model does not match the association approved route");
  }
  if (
    typeof args.conversationId === "string"
    && args.conversationId.length > 0
    && args.conversationId !== association.conversationId
  ) {
    throw new Error("orch_run conversationId does not match the association");
  }

  args.dir = worktreePath;
  args.wp = association.wp;
  args.slice = association.slice;
  args.cli = association.cli;
  args.model = association.model;
  args.conversationId = association.conversationId;
  args.by = "owner";
  return args;
}

/**
 * Strip privileged renderer flags from any orch command args.
 * @param {object} rawArgs
 */
export function stripPrivilegedOrchFlags(rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? { ...rawArgs }
    : {};
  delete args.ownerApprovedModel;
  delete args.allow;
  if ("by" in args) args.by = "owner";
  return args;
}
