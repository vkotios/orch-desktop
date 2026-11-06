// Explicit Git integrate for an accepted association worktree.
// Accept ≠ integrate ≠ finish/cleanup. Host-owned; never called from renderer
// Git flags. Dry-run previews without mutating refs.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function wpKey(wp) {
  const s = String(wp ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s)) {
    throw new Error(`invalid work-package name "${s}"`);
  }
  return s.toLowerCase();
}

function sliceKey(slice) {
  const s = String(slice ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(s)) {
    throw new Error(`invalid slice id "${s}"`);
  }
  return s.toLowerCase();
}

async function git(cwd, gitArgs) {
  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout || '').trimEnd();
  } catch (err) {
    const stderr = err && typeof err === 'object' ? err.stderr : '';
    throw new Error(`git ${gitArgs[0]} failed: ${String(stderr || err?.message || err).slice(0, 400)}`);
  }
}

/**
 * @param {{ get: (id: string) => any, setDisposition: (id: string, disposition: string, note?: string|null) => any }} store
 * @param {{ id: string, dryRun?: boolean }} args
 */
export async function integrateAssociationWorktree(store, args) {
  const associationId = typeof args?.id === 'string' ? args.id : null;
  if (!associationId) throw new Error('delegation_integrate requires id');
  const dryRun = args?.dryRun === true;
  const association = store.get(associationId);
  if (!association) throw new Error('association not found');
  if (association.disposition !== 'accepted') {
    throw new Error('Integrate requires an accepted association (Accept first; Finish/cleanup stay separate)');
  }
  if (association.stage === 'running' || association.stage === 'launching' || association.stage === 'uncertain') {
    throw new Error(`Refuse integrate while stage is ${association.stage}; stop/settle the worker first`);
  }
  const worktreePath = association.worktreePath;
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new Error('association has no worktree path');
  }
  const resolvedWt = path.resolve(worktreePath);
  if (!fs.existsSync(resolvedWt)) throw new Error('worktree path does not exist');
  const repoRoot = path.resolve(association.repoPath);
  const rel = path.relative(repoRoot, resolvedWt);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('worktree path is outside the associated repository');
  }

  const expectedBranch = `orch/${wpKey(association.wp)}/${sliceKey(association.slice)}`;
  const wtBranch = await git(resolvedWt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (wtBranch !== expectedBranch) {
    throw new Error(`worktree branch is ${wtBranch}, expected ${expectedBranch}`);
  }
  const branchExists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${expectedBranch}`]);
  if (!branchExists) {
    throw new Error(`branch ${expectedBranch} is not present in the repository`);
  }

  const dirty = await git(resolvedWt, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty.trim().length > 0) {
    throw new Error('worktree has uncommitted changes; commit or discard before integrate');
  }

  const targetBranch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!targetBranch || targetBranch === 'HEAD') {
    throw new Error('repository is in detached HEAD; check out a branch before integrate');
  }
  if (targetBranch === expectedBranch) {
    throw new Error('repository is already checked out on the worktree branch; switch to the integration target first');
  }

  // Ignore untracked paths (implementation worktrees live under .worktrees/).
  const repoDirty = await git(repoRoot, ['status', '--porcelain', '-uno']);
  if (repoDirty.trim().length > 0) {
    throw new Error('repository working tree is dirty; commit or stash before integrate');
  }

  const ahead = await git(repoRoot, ['rev-list', '--count', `${targetBranch}..${expectedBranch}`]);
  const commitCount = Number.parseInt(ahead, 10) || 0;
  const preview = {
    associationId,
    repoPath: repoRoot,
    worktreePath: resolvedWt,
    sourceBranch: expectedBranch,
    targetBranch,
    commits: commitCount,
    dryRun,
    readOnlyPreview: dryRun,
  };

  if (dryRun) {
    return {
      ...preview,
      merged: false,
      note: `Would merge ${expectedBranch} into ${targetBranch} (${commitCount} commit(s)).`,
    };
  }

  await git(repoRoot, [
    'merge',
    '--no-ff',
    '-m',
    `Integrate ${association.wp}/${association.slice} via CHO desktop`,
    expectedBranch,
  ]);

  const updated = store.setDisposition(
    associationId,
    'integrated',
    `Merged ${expectedBranch} into ${targetBranch}. Finish/cleanup remain explicit.`,
  );

  return {
    ...preview,
    merged: true,
    association: updated,
    note: `Merged ${expectedBranch} into ${targetBranch}.`,
  };
}
