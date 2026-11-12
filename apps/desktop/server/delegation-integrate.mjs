// Explicit Git integrate for an accepted association worktree.
// Accept ≠ integrate ≠ finish/cleanup. Host-owned; never called from renderer
// Git flags. Dry-run returns an immutable preview token; apply rechecks it.

import crypto from 'node:crypto';
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

function encodePreviewToken(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHash('sha256').update(`cho-integrate-v1:${json}`).digest('base64url');
  return `${body}.${sig}`;
}

function decodePreviewToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Integrate apply requires the preview token from dry-run');
  }
  const [body, sig] = token.split('.');
  const json = Buffer.from(body, 'base64url').toString('utf8');
  const expected = crypto.createHash('sha256').update(`cho-integrate-v1:${json}`).digest('base64url');
  if (sig !== expected) throw new Error('Integrate preview token is invalid');
  const payload = JSON.parse(json);
  if (!payload || typeof payload !== 'object') throw new Error('Integrate preview token is malformed');
  return payload;
}

/** Serialize integrate mutations per association so concurrent apply cannot race. */
const integrateInFlight = new Map();

/**
 * @param {{ get: (id: string) => any, setDisposition: (id: string, disposition: string, note?: string|null) => any }} store
 * @param {{ id: string, dryRun?: boolean, previewToken?: string }} args
 * @param {{ inspectRun?: (runId: string) => Promise<{ ok: boolean, terminal?: boolean, text?: string }>, inspectGate?: (wp: string) => Promise<{ ok: boolean, converged?: boolean, text?: string }>, inspectReview?: (association: object, ctx: { sourceSha: string }) => Promise<{ ok: boolean, clean?: boolean, text?: string }> }} [hooks]
 */
export async function integrateAssociationWorktree(store, args, hooks = {}) {
  const associationId = typeof args?.id === 'string' ? args.id : null;
  if (!associationId) throw new Error('delegation_integrate requires id');
  if (integrateInFlight.has(associationId)) {
    throw new Error('Integrate already in progress for this association; wait for the in-flight receipt');
  }
  integrateInFlight.set(associationId, Date.now());
  try {
    return await integrateAssociationWorktreeUnlocked(store, args, hooks);
  } finally {
    integrateInFlight.delete(associationId);
  }
}

async function integrateAssociationWorktreeUnlocked(store, args, hooks = {}) {
  const associationId = typeof args?.id === 'string' ? args.id : null;
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

  const repoDirty = await git(repoRoot, ['status', '--porcelain', '-uno']);
  if (repoDirty.trim().length > 0) {
    throw new Error('repository working tree is dirty; commit or stash before integrate');
  }

  // Resolve the actual candidate SHA from Git before review evidence checks.
  // Do not trust renderer/association sourceSha fields (they are not stored).
  const sourceSha = await git(repoRoot, ['rev-parse', expectedBranch]);
  const targetSha = await git(repoRoot, ['rev-parse', 'HEAD']);

  if (association.runId && typeof hooks.inspectRun === 'function') {
    const run = await hooks.inspectRun(association.runId);
    if (!run?.ok) {
      throw new Error(run?.text || 'Could not inspect the recorded run before integrate');
    }
    if (run.terminal !== true) {
      throw new Error('Refuse integrate while the recorded run is not terminal');
    }
  } else if (association.runId && !hooks.inspectRun) {
    throw new Error('Integrate requires host run inspection when a run id is recorded');
  }

  if (typeof hooks.inspectGate === 'function') {
    const gate = await hooks.inspectGate(association);
    if (!gate?.ok || gate.converged !== true) {
      throw new Error(gate?.text || 'Integrate requires a converged orch gate');
    }
  } else {
    throw new Error('Integrate requires host gate inspection');
  }

  if (typeof hooks.inspectReview === 'function') {
    const review = await hooks.inspectReview(association, { sourceSha });
    if (!review?.ok || review.clean !== true) {
      throw new Error(review?.text || 'Integrate requires clean independent review containment');
    }
  } else {
    throw new Error('Integrate requires host review inspection');
  }

  const ahead = await git(repoRoot, ['rev-list', '--count', `${targetSha}..${sourceSha}`]);
  const commitCount = Number.parseInt(ahead, 10) || 0;
  const previewPayload = {
    v: 1,
    associationId,
    repoPath: repoRoot,
    worktreePath: resolvedWt,
    sourceBranch: expectedBranch,
    targetBranch,
    sourceSha,
    targetSha,
    commits: commitCount,
  };

  if (dryRun) {
    const previewToken = encodePreviewToken(previewPayload);
    return {
      ...previewPayload,
      previewToken,
      dryRun: true,
      merged: false,
      note: `Would merge ${expectedBranch} (${sourceSha.slice(0, 8)}) into ${targetBranch} (${targetSha.slice(0, 8)}); ${commitCount} commit(s).`,
    };
  }

  const expected = decodePreviewToken(args.previewToken);
  for (const key of ['associationId', 'repoPath', 'worktreePath', 'sourceBranch', 'targetBranch', 'sourceSha', 'targetSha', 'commits']) {
    if (expected[key] !== previewPayload[key]) {
      throw new Error(
        `Integrate preview is stale (${key} changed). Refresh the dry-run preview before applying.`,
      );
    }
  }

  let mergeOk = false;
  try {
    await git(repoRoot, [
      'merge',
      '--no-ff',
      '-m',
      `Integrate ${association.wp}/${association.slice} via CHO desktop`,
      sourceSha,
    ]);
    mergeOk = true;
  } catch (err) {
    let mergeHead = null;
    try { mergeHead = await git(repoRoot, ['rev-parse', '--verify', 'MERGE_HEAD']); } catch { /* no verified merge to abort */ }
    if (mergeHead === sourceSha && await git(repoRoot, ['rev-parse', 'HEAD']) === targetSha) {
      const conflicts = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
      try { await git(repoRoot, ['merge', '--abort']); }
      catch (abortError) { throw new Error(`Integrate failed; merge abort also failed. Inspect the merge state before retrying: ${abortError.message}`); }
      throw new Error(`Integrate conflicted${conflicts ? ` in ${conflicts.split('\n').join(', ')}` : ''}; merge aborted and target checkout restored. Resolve the branch conflicts before retrying.`);
    }
    throw err;
  }

  try {
    const updated = await Promise.resolve(store.setDisposition(
      associationId,
      'integrated',
      `Merged ${expectedBranch} (${sourceSha.slice(0, 12)}) into ${targetBranch}. Finish/cleanup remain explicit.`,
    ));
    return {
      ...previewPayload,
      previewToken: args.previewToken,
      dryRun: false,
      merged: true,
      association: updated,
      note: `Merged ${expectedBranch} into ${targetBranch}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      mergeOk
        ? `Git merge succeeded but association receipt failed: ${message}. Inspect ${repoRoot} at HEAD; do not re-merge until the association is reconciled.`
        : message,
    );
  }
}
