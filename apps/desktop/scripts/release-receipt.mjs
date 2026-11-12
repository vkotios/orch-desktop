#!/usr/bin/env node
// Windows candidate release receipt: write and verify machine-readable build
// receipts for the private manual candidate pipeline.
//
// Evidence level is ALWAYS "built-local": this receipt proves that the listed
// installer artifacts were built from the listed commit on the build machine
// and that the staged runtime bytes match the checked-out source bytes. It is
// NOT installed-app or clean-machine acceptance (see AC-01/AC-13 and
// docs/WINDOWS_CANDIDATE_ACCEPTANCE.md). The verifier refuses any receipt that
// claims an "installed" or "clean-machine" evidence level.
//
// Pure Node (built-ins only), portable across Windows/CI runners:
//
//   node apps/desktop/scripts/release-receipt.mjs write \
//     --bundle-dir apps/desktop/src-tauri/target/release/bundle \
//     --runtime-dir apps/desktop/src-tauri/.runtime \
//     --commit <sha> [--pr-head <sha>] --out candidate-receipt.json
//
//   node apps/desktop/scripts/release-receipt.mjs verify \
//     --receipt candidate-receipt.json \
//     --bundle-dir <dir> --source-root . --runtime-dir <dir>
//
// Exit code: 0 = ok, 1 = usage/verify failure.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_SCHEMA_VERSION = 1;
// The only evidence level this pipeline may assert. Anything stronger must
// come from the owner-executed acceptance procedure, never from this script.
export const EVIDENCE_LEVEL = 'built-local';
const REFUSED_LEVELS = new Set(['installed', 'clean-machine', 'installed-clean-machine']);

// Installer artifact kinds in candidate-dist. All three are intentionally
// desired: the MSI installer, the NSIS installer (ships as *-setup.exe),
// and the raw app executable. The raw EXE is NOT a standalone installer:
// it requires the bundled runtime staged next to it (see prepare-runtime).
const ARTIFACT_EXTS = new Set(['.msi', '.exe']);
const REQUIRED_ARTIFACT_KINDS = ['msi', 'nsis', 'raw'];
const HEX64 = /^[0-9a-f]{64}$/;
// Full object-format SHAs only: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase.
// Short prefixes and branch/tag names are never valid commit claims.
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Staged files with no source counterpart. These are vendored binaries pinned
// by apps/desktop/runtime-manifest.json and verified by recorded bytes only;
// every other staged file must map to a checked-out source file (see
// stagedToSource). Anything unmapped is a verification failure, never a skip.
const VENDORED_BINARIES = new Set(['node.exe', 'LICENSE.node']);

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function sha256File(absPath) {
  const bytes = await readFile(absPath);
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

/** Installer artifacts are .msi / .exe files (NSIS ships as *-setup.exe). */
export function isArtifactFile(rel) {
  return ARTIFACT_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * Artifact kind from the file name: 'msi' for the MSI installer, 'nsis'
 * for the NSIS installer (*-setup.exe), 'raw' for any other .exe (the raw
 * app executable, which needs the bundled runtime and is not a standalone
 * installer), or null for non-artifact files.
 */
export function artifactKind(file) {
  const base = toPosix(String(file)).split('/').pop().toLowerCase();
  if (base.endsWith('.msi')) return 'msi';
  if (base.endsWith('.exe')) return base.endsWith('-setup.exe') ? 'nsis' : 'raw';
  return null;
}

async function walkFiles(root) {
  const out = [];
  const pending = ['.'];
  while (pending.length > 0) {
    const rel = pending.pop();
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relEntry = rel === '.' ? entry.name : path.join(rel, entry.name);
      if (entry.isDirectory()) pending.push(relEntry);
      else if (entry.isFile()) out.push(relEntry);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * True when rel is a portable relative path that is safe to join to a root:
 * posix separators only, never absolute, no drive letter, no empty / . / ..
 * segments, no NUL. Receipt-supplied paths are untrusted until they pass this.
 */
function isSafePosixRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  const segs = rel.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

/**
 * Resolve the checked-out source HEAD for sourceRoot, or null when it cannot
 * be determined (not a git checkout, git unavailable). Never throws.
 */
function gitHead(sourceRoot) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { timeout: 15000 }, (error, stdout) => {
        if (error) return resolve(null);
        const sha = String(stdout).trim().toLowerCase();
        resolve(COMMIT_RE.test(sha) ? sha : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// Exact prepare-runtime outputs. Keep in sync with
// apps/desktop/scripts/prepare-runtime.mjs: SERVER_MODULES (named server
// modules copied flat), ACP_TS_MODULES (named TypeScript sources),
// orch/src copied recursively for *.mjs only, plus orch/roster.example.json
// and the root model-catalog.json. Anything else staged under app/ has no
// trusted source counterpart and fails verification.
const STAGED_SERVER_MODULES = new Set([
  'host.mjs',
  'protocol.mjs',
  'bridge.mjs',
  'native-rpc.mjs',
  'codex-client.mjs',
  'event-mailbox.mjs',
  'native-chat.mjs',
  'native-clarification.mjs',
  'claude-wire.mjs',
  'claude-client.mjs',
  'claude-chat-actor.mjs',
  'delegation-admit.mjs',
  'delegation-integrate.mjs',
  'delegation-integrate-evidence.mjs',
  'delegation-associations.mjs',
  'native-session-persistence.mjs',
  'session-store.mjs',
  'session-store-schema.mjs',
  'session-store-migrate.mjs',
  'session-store-restore.mjs',
  'session-records.mjs',
  'session-bindings.mjs',
  'session-turns.mjs',
  'session-message-deltas.mjs',
  'session-tool-facts.mjs',
  'session-turn-outcomes.mjs',
  'session-events.mjs',
  'session-bodies.mjs',
  'session-approvals.mjs',
  'session-clarifications.mjs',
  'session-stops.mjs',
  'session-producer-transaction.mjs',
]);
const STAGED_ACP_MODULES = new Set([
  'packages/acp-client/src/codex-app-server.ts',
  'packages/acp-client/src/claude-stream.ts',
]);

/** Map a staged-runtime relative path to its source-root relative path, or null when it has no source counterpart (vendored binaries and anything outside the exact prepare-runtime outputs). */
export function stagedToSource(stagedRel) {
  const rel = toPosix(stagedRel);
  if (rel === 'runtime-manifest.json') return 'apps/desktop/runtime-manifest.json';
  if (!rel.startsWith('app/')) return null;
  const inner = rel.slice('app/'.length);
  if (inner.startsWith('apps/desktop/server/')) {
    const base = inner.slice('apps/desktop/server/'.length);
    if (!base.includes('/') && STAGED_SERVER_MODULES.has(base)) return inner;
    return null;
  }
  if (STAGED_ACP_MODULES.has(inner)) return inner;
  if (inner === 'orch/roster.example.json') return inner;
  if (inner.startsWith('orch/src/') && inner.endsWith('.mjs')) return inner;
  if (inner === 'model-catalog.json') return inner;
  return null;
}

/** Hash every file under root; returns [{ rel (posix), sha256, bytes }] sorted. */
export async function hashTree(root, accept) {
  const files = await walkFiles(root);
  const out = [];
  for (const rel of files) {
    if (accept && !accept(toPosix(rel))) continue;
    const abs = path.join(root, rel);
    const { sha256, bytes } = await sha256File(abs);
    out.push({ rel: toPosix(rel), sha256, bytes });
  }
  return out;
}

/** Collect installer artifacts under bundleDir. */
export async function collectArtifacts(bundleDir) {
  return hashTree(bundleDir, isArtifactFile).then((entries) =>
    entries.map(({ rel, sha256, bytes }) => ({ file: rel, sha256, bytes })),
  );
}

/**
 * Build a receipt object. staged entries carry the hash of the staged bytes;
 * verification compares them against freshly hashed source bytes.
 * `commit` is the exact checked-out commit that was built (for PR runs this
 * is the synthetic merge SHA, which is the valid candidate identity).
 * `prHead` is informational only: the PR head SHA from trusted workflow
 * metadata, recorded so the merge commit is never mislabeled as the PR head.
 * The receipt carries no absolute sourceRoot: it is build-machine-local and
 * would make the receipt non-portable. Verification binds to the sourceRoot
 * it is given on its own host.
 */
export async function writeReceipt({ bundleDir, runtimeDir, commit, prHead, nodeVersion }) {
  if (!commit || typeof commit !== 'string') throw new Error('release-receipt: commit is required');
  if (!COMMIT_RE.test(commit)) {
    throw new Error('release-receipt: commit must be a full lowercase hex SHA (40 or 64 chars)');
  }
  if (prHead !== undefined && prHead !== null && prHead !== '') {
    if (typeof prHead !== 'string' || !COMMIT_RE.test(prHead)) {
      throw new Error('release-receipt: prHead must be a full lowercase hex SHA (40 or 64 chars) when provided');
    }
  }
  const artifacts = await collectArtifacts(bundleDir);
  const stagedRuntime = await hashTree(runtimeDir);
  const staged = stagedRuntime.map((e) => ({ ...e, source: stagedToSource(e.rel) }));
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    evidenceLevel: EVIDENCE_LEVEL,
    commit,
    nodeVersion: nodeVersion || process.version,
    builtAt: new Date().toISOString(),
    artifacts,
    stagedRuntime: staged,
  };
  if (prHead) receipt.prHead = prHead;
  return receipt;
}

/**
 * Verify a receipt against on-disk bytes. Returns { ok, errors }.
 * Complete verification REQUIRES runtimeDir: without the staged runtime
 * directory a receipt stripped down to a single vendored binary would
 * verify, so absence is a failure, never a skip. Fails on: wrong schema,
 * refused evidence level, missing runtimeDir, malformed commit claim, or a
 * commit claim that cannot be bound because the source HEAD cannot be
 * resolved (an extracted non-git source tree refuses verification instead
 * of silently skipping candidate binding), missing/duplicate/unsafe
 * artifact paths, artifact hash/size mismatch, installer artifacts on disk
 * that are not recorded in the receipt, a missing required artifact kind
 * (msi, nsis, raw), missing/duplicate/unsafe staged paths, staged files
 * with no trusted source mapping (other than vendored binaries), missing
 * source files, staged-vs-source byte mismatch, staged-on-disk drift, or
 * any other inventory difference between the receipt and the runtime
 * directory (omitted, added, or duplicate entries). The receipt's own
 * `source` fields are never trusted: the source counterpart always comes
 * from stagedToSource(). The informational `prHead` field, when present,
 * is shape-checked only and never used for binding.
 */
export async function verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir }) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return { ok: false, errors: ['receipt is not an object'] };
  if (!runtimeDir || typeof runtimeDir !== 'string') {
    errors.push('runtimeDir is required: complete verification needs the staged runtime directory');
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RECEIPT_SCHEMA_VERSION}, got ${String(receipt.schemaVersion)}`);
  }
  if (receipt.evidenceLevel !== EVIDENCE_LEVEL || REFUSED_LEVELS.has(receipt.evidenceLevel)) {
    errors.push(`evidenceLevel '${String(receipt.evidenceLevel)}' is not verifiable by this pipeline; expected '${EVIDENCE_LEVEL}'`);
  }
  if (!receipt.commit || typeof receipt.commit !== 'string') {
    errors.push('commit is missing');
  } else if (!COMMIT_RE.test(receipt.commit)) {
    errors.push(`commit '${receipt.commit}' is not a full lowercase hex SHA (40 or 64 chars)`);
  } else {
    const head = await gitHead(sourceRoot);
    if (head === null) {
      errors.push(`cannot resolve checked-out source HEAD for '${sourceRoot}': not a git checkout or git unavailable; refusing candidate binding`);
    } else if (receipt.commit !== head) {
      errors.push(`commit ${receipt.commit} does not match checked-out source HEAD ${head}`);
    }
  }
  if (receipt.prHead !== undefined && receipt.prHead !== null) {
    if (typeof receipt.prHead !== 'string' || !COMMIT_RE.test(receipt.prHead)) {
      errors.push(`prHead '${String(receipt.prHead)}' is not a full lowercase hex SHA (40 or 64 chars)`);
    }
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    errors.push('artifacts list is empty: no installer artifact recorded');
  } else {
    const seenArtifacts = new Set();
    const seenKinds = new Set();
    for (const a of receipt.artifacts) {
      if (!a || typeof a.file !== 'string' || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) {
        errors.push(`malformed artifact entry: ${JSON.stringify(a)}`);
        continue;
      }
      if (!isSafePosixRel(a.file)) {
        errors.push(`unsafe artifact path: ${JSON.stringify(a.file)}`);
        continue;
      }
      if (seenArtifacts.has(a.file)) {
        errors.push(`duplicate artifact entry: ${a.file}`);
        continue;
      }
      seenArtifacts.add(a.file);
      seenKinds.add(artifactKind(a.file));
      const abs = path.join(bundleDir, a.file);
      let st = null;
      try {
        st = await stat(abs);
      } catch {
        errors.push(`missing artifact: ${a.file}`);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`artifact is not a file: ${a.file}`);
        continue;
      }
      const actual = await sha256File(abs);
      if (actual.sha256 !== a.sha256) errors.push(`artifact sha256 mismatch: ${a.file}`);
      if (typeof a.bytes === 'number' && actual.bytes !== a.bytes) {
        errors.push(`artifact size mismatch: ${a.file} (receipt ${a.bytes}, disk ${actual.bytes})`);
      }
    }
    // All three artifact kinds are intentionally desired: a receipt that
    // records only the MSI while the NSIS/raw outputs exist (or vice versa)
    // is not a complete candidate.
    for (const kind of REQUIRED_ARTIFACT_KINDS) {
      if (!seenKinds.has(kind)) {
        const hint = kind === 'msi' ? 'MSI installer (.msi)'
          : kind === 'nsis' ? 'NSIS installer (*-setup.exe)'
          : 'raw app executable (.exe other than *-setup.exe; needs the bundled runtime, not a standalone installer)';
        errors.push(`artifacts missing required kind '${kind}': no ${hint} recorded`);
      }
    }
    // Complete artifact inventory: every installer artifact on disk must be
    // recorded in the receipt, so a receipt listing only one of the
    // on-disk EXE/MSI/NSIS outputs cannot verify as complete.
    let onDiskArtifacts = null;
    try {
      onDiskArtifacts = await collectArtifacts(bundleDir);
    } catch {
      errors.push(`cannot read bundleDir: ${bundleDir}`);
    }
    if (onDiskArtifacts) {
      for (const { file } of onDiskArtifacts) {
        if (!seenArtifacts.has(file)) {
          errors.push(`installer artifact on disk is not recorded in receipt: ${file}`);
        }
      }
    }
  }
  if (!Array.isArray(receipt.stagedRuntime) || receipt.stagedRuntime.length === 0) {
    errors.push('stagedRuntime list is empty: staged runtime bytes not recorded');
  } else {
    const seenStaged = new Set();
    for (const s of receipt.stagedRuntime) {
      if (!s || typeof s.rel !== 'string' || typeof s.sha256 !== 'string' || !HEX64.test(s.sha256)) {
        errors.push(`malformed stagedRuntime entry: ${JSON.stringify(s)}`);
        continue;
      }
      if (!isSafePosixRel(s.rel)) {
        errors.push(`unsafe stagedRuntime path: ${JSON.stringify(s.rel)}`);
        continue;
      }
      if (seenStaged.has(s.rel)) {
        errors.push(`duplicate stagedRuntime entry: ${s.rel}`);
        continue;
      }
      seenStaged.add(s.rel);
      // Staged bytes on disk must still match the receipt (when a runtime dir is available).
      if (runtimeDir) {
        try {
          const onDisk = await sha256File(path.join(runtimeDir, s.rel));
          if (onDisk.sha256 !== s.sha256) errors.push(`staged runtime drift on disk: ${s.rel}`);
          if (typeof s.bytes === 'number' && onDisk.bytes !== s.bytes) {
            errors.push(`staged runtime size drift on disk: ${s.rel} (receipt ${s.bytes}, disk ${onDisk.bytes})`);
          }
        } catch {
          errors.push(`staged runtime file missing on disk: ${s.rel}`);
        }
      }
      // Staged bytes must equal the current source bytes. The mapping always
      // comes from the trusted staging rules — a receipt-supplied `source`
      // field is untrusted and ignored, so redirecting it cannot hide a
      // source change. Files with no trusted mapping fail unless they are
      // vendored binaries with recorded bytes; nothing is silently skipped.
      const sourceRel = stagedToSource(s.rel);
      if (!sourceRel) {
        if (!VENDORED_BINARIES.has(s.rel)) {
          errors.push(`staged file has no trusted source mapping: ${s.rel}`);
        }
        continue;
      }
      let srcHash;
      try {
        srcHash = (await sha256File(path.join(sourceRoot, sourceRel))).sha256;
      } catch {
        errors.push(`source file missing for staged entry ${s.rel} (expected ${sourceRel})`);
        continue;
      }
      if (srcHash !== s.sha256) errors.push(`staged runtime differs from source: ${s.rel} != ${sourceRel}`);
    }
    // Complete inventory: when the staged runtime directory is available,
    // every file on disk must be recorded in the receipt and vice versa.
    if (runtimeDir) {
      let actual = null;
      try {
        actual = await hashTree(runtimeDir);
      } catch {
        errors.push(`cannot read runtimeDir: ${runtimeDir}`);
      }
      if (actual) {
        for (const { rel } of actual) {
          if (!seenStaged.has(rel)) {
            errors.push(`staged runtime file on disk is not recorded in receipt: ${rel}`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function usage() {
  return [
    'usage:',
    '  write  --bundle-dir <dir> --runtime-dir <dir> --commit <sha> --out <file> [--pr-head <sha>]',
    '  verify --receipt <file> --bundle-dir <dir> --source-root <dir> --runtime-dir <dir>',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
}

const invokedDirectly = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  let args = {};
  try {
    args = parseArgs(rest);
    if (command === 'write') {
      for (const k of ['bundle-dir', 'runtime-dir', 'commit', 'out']) {
        if (!args[k]) throw new Error(`missing --${k}`);
      }
      const receipt = await writeReceipt({
        bundleDir: args['bundle-dir'],
        runtimeDir: args['runtime-dir'],
        commit: args.commit,
        prHead: args['pr-head'],
      });
      await writeFile(args.out, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      console.log(`release-receipt: wrote ${receipt.artifacts.length} artifact(s), ${receipt.stagedRuntime.length} staged file(s) -> ${args.out}`);
    } else if (command === 'verify') {
      for (const k of ['receipt', 'bundle-dir', 'source-root', 'runtime-dir']) {
        if (!args[k]) throw new Error(`missing --${k}`);
      }
      const receipt = JSON.parse(await readFile(args.receipt, 'utf8'));
      const { ok, errors } = await verifyReceipt(receipt, {
        bundleDir: args['bundle-dir'],
        sourceRoot: args['source-root'],
        runtimeDir: args['runtime-dir'],
      });
      if (ok) {
        console.log(`release-receipt: VERIFIED ${receipt.artifacts.length} artifact(s), ${receipt.stagedRuntime.length} staged file(s) at evidence level '${receipt.evidenceLevel}' (built-local only, not clean-machine acceptance)`);
      } else {
        for (const e of errors) console.error(`release-receipt: FAIL: ${e}`);
        process.exitCode = 1;
      }
    } else {
      throw new Error(`unknown command: ${String(command)}`);
    }
  } catch (error) {
    console.error(`release-receipt: ${error?.message || error}\n${usage()}`);
    process.exitCode = 1;
  }
}
