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
//     --source-root . --commit <sha> --out candidate-receipt.json
//
//   node apps/desktop/scripts/release-receipt.mjs verify \
//     --receipt candidate-receipt.json \
//     --bundle-dir <dir> --source-root . [--runtime-dir <dir>]
//
// Exit code: 0 = ok, 1 = usage/verify failure.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_SCHEMA_VERSION = 1;
// The only evidence level this pipeline may assert. Anything stronger must
// come from the owner-executed acceptance procedure, never from this script.
export const EVIDENCE_LEVEL = 'built-local';
const REFUSED_LEVELS = new Set(['installed', 'clean-machine', 'installed-clean-machine']);

const ARTIFACT_EXTS = new Set(['.msi', '.exe']);
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function sha256File(absPath) {
  const bytes = await readFile(absPath);
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

/** Installer artifacts are .msi / .exe files (NSIS ships as *-setup.exe). */
export function isArtifactFile(rel) {
  return ARTIFACT_EXTS.has(path.extname(rel).toLowerCase());
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

/** Map a staged-runtime relative path to its source-root relative path, or null when it has no source counterpart (vendored binaries). */
export function stagedToSource(stagedRel) {
  const rel = toPosix(stagedRel);
  if (rel === 'runtime-manifest.json') return 'apps/desktop/runtime-manifest.json';
  if (!rel.startsWith('app/')) return null;
  const inner = rel.slice('app/'.length);
  if (inner.startsWith('apps/desktop/server/')) return inner;
  if (inner.startsWith('packages/acp-client/src/')) return inner;
  if (inner.startsWith('orch/')) return inner;
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
 */
export async function writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit, nodeVersion }) {
  if (!commit || typeof commit !== 'string') throw new Error('release-receipt: commit is required');
  const artifacts = await collectArtifacts(bundleDir);
  const stagedRuntime = await hashTree(runtimeDir);
  const staged = stagedRuntime.map((e) => ({ ...e, source: stagedToSource(e.rel) }));
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    evidenceLevel: EVIDENCE_LEVEL,
    commit,
    nodeVersion: nodeVersion || process.version,
    builtAt: new Date().toISOString(),
    artifacts,
    stagedRuntime: staged,
    sourceRoot: toPosix(path.resolve(sourceRoot)),
  };
}

/**
 * Verify a receipt against on-disk bytes. Returns { ok, errors }.
 * Fails on: wrong schema, refused evidence level, missing artifact,
 * artifact hash/size mismatch, missing source file, staged-vs-source
 * byte mismatch, or staged-on-disk drift when runtimeDir is provided.
 */
export async function verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir = null }) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return { ok: false, errors: ['receipt is not an object'] };
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RECEIPT_SCHEMA_VERSION}, got ${String(receipt.schemaVersion)}`);
  }
  if (receipt.evidenceLevel !== EVIDENCE_LEVEL || REFUSED_LEVELS.has(receipt.evidenceLevel)) {
    errors.push(`evidenceLevel '${String(receipt.evidenceLevel)}' is not verifiable by this pipeline; expected '${EVIDENCE_LEVEL}'`);
  }
  if (!receipt.commit || typeof receipt.commit !== 'string') errors.push('commit is missing');
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    errors.push('artifacts list is empty: no installer artifact recorded');
  } else {
    for (const a of receipt.artifacts) {
      if (!a || typeof a.file !== 'string' || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) {
        errors.push(`malformed artifact entry: ${JSON.stringify(a)}`);
        continue;
      }
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
  }
  if (!Array.isArray(receipt.stagedRuntime) || receipt.stagedRuntime.length === 0) {
    errors.push('stagedRuntime list is empty: staged runtime bytes not recorded');
  } else {
    for (const s of receipt.stagedRuntime) {
      if (!s || typeof s.rel !== 'string' || typeof s.sha256 !== 'string' || !HEX64.test(s.sha256)) {
        errors.push(`malformed stagedRuntime entry: ${JSON.stringify(s)}`);
        continue;
      }
      // Staged bytes on disk must still match the receipt (when a runtime dir is available).
      if (runtimeDir) {
        try {
          const onDisk = await sha256File(path.join(runtimeDir, s.rel));
          if (onDisk.sha256 !== s.sha256) errors.push(`staged runtime drift on disk: ${s.rel}`);
        } catch {
          errors.push(`staged runtime file missing on disk: ${s.rel}`);
        }
      }
      // Staged bytes must equal the current source bytes; vendored binaries have no source.
      const sourceRel = typeof s.source === 'string' ? s.source : stagedToSource(s.rel);
      if (!sourceRel) continue;
      let srcHash;
      try {
        srcHash = (await sha256File(path.join(sourceRoot, sourceRel))).sha256;
      } catch {
        errors.push(`source file missing for staged entry ${s.rel} (expected ${sourceRel})`);
        continue;
      }
      if (srcHash !== s.sha256) errors.push(`staged runtime differs from source: ${s.rel} != ${sourceRel}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function usage() {
  return [
    'usage:',
    '  write  --bundle-dir <dir> --runtime-dir <dir> --source-root <dir> --commit <sha> --out <file>',
    '  verify --receipt <file> --bundle-dir <dir> --source-root <dir> [--runtime-dir <dir>]',
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
      for (const k of ['bundle-dir', 'runtime-dir', 'source-root', 'commit', 'out']) {
        if (!args[k]) throw new Error(`missing --${k}`);
      }
      const receipt = await writeReceipt({
        bundleDir: args['bundle-dir'],
        runtimeDir: args['runtime-dir'],
        sourceRoot: args['source-root'],
        commit: args.commit,
      });
      await writeFile(args.out, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      console.log(`release-receipt: wrote ${receipt.artifacts.length} artifact(s), ${receipt.stagedRuntime.length} staged file(s) -> ${args.out}`);
    } else if (command === 'verify') {
      for (const k of ['receipt', 'bundle-dir', 'source-root']) {
        if (!args[k]) throw new Error(`missing --${k}`);
      }
      const receipt = JSON.parse(await readFile(args.receipt, 'utf8'));
      const { ok, errors } = await verifyReceipt(receipt, {
        bundleDir: args['bundle-dir'],
        sourceRoot: args['source-root'],
        runtimeDir: args['runtime-dir'] || null,
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
