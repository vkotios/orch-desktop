// Stages the pinned Windows x64 runtime into apps/desktop/src-tauri/.runtime.
// Promotion: complete stage is generated, old output renamed to backup, then
// stage renamed to output. If promotion fails the backup is retained for
// manual recovery; a failed run may leave the output absent until restored.
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const PINNED_VERSION = 'v24.22.2';
const NODE_ORIGIN = 'https://nodejs.org';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const NODE_LIMIT = 150 * 1024 * 1024;
const LICENSE_LIMIT = 5 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SERVER_MODULES = ['host.mjs', 'protocol.mjs', 'bridge.mjs'];
const OUTPUT_NAMES = new Set(['.runtime', 'runtime-test-output']);
const STAGE_PREFIX = '.runtime-stage-';
const BACKUP_PREFIX = '.runtime-backup-';

const fail = (message) => { throw new Error(`prepare-runtime: ${message}`); };
const officialUrls = (version) => ({
  executable: `${NODE_ORIGIN}/dist/${version}/win-x64/node.exe`,
  license: `${RAW_ORIGIN}/nodejs/node/${version}/LICENSE`,
});
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return x === y || (process.platform === 'win32' && x.toLowerCase() === y.toLowerCase());
};

function requireProvenance(provenance, version) {
  if (!provenance || typeof provenance !== 'object') fail('manifest provenance is required');
  if (typeof provenance.releaseDate !== 'string' || !DATE_RE.test(provenance.releaseDate)) {
    fail('manifest provenance.releaseDate must be YYYY-MM-DD');
  }
  if (provenance.releaseIndexUrl !== `${NODE_ORIGIN}/dist/index.json`) fail('manifest provenance.releaseIndexUrl must be the pinned index URL');
  if (provenance.checksumsUrl !== `${NODE_ORIGIN}/dist/${version}/SHASUMS256.txt`) {
    fail('manifest provenance.checksumsUrl must be the pinned SHASUMS URL');
  }
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest must be a JSON object');
  if (value.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
  if (value.version !== PINNED_VERSION) fail(`manifest version must be pinned to ${PINNED_VERSION}`);
  if (value.platform !== 'win32' || value.arch !== 'x64') fail('manifest must target platform win32 and arch x64');
  const urls = officialUrls(value.version);
  for (const key of ['executable', 'license']) {
    const entry = value[key];
    if (!entry || typeof entry !== 'object') fail(`manifest ${key} is required`);
    if (entry.url !== urls[key]) fail(`manifest ${key}.url must be the pinned official URL`);
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) {
      fail(`manifest ${key}.sha256 must be 64 lowercase hex chars`);
    }
  }
  requireProvenance(value.provenance, value.version);
  return value;
}

// Canonical form of the nearest existing ancestor plus any missing tail.
// Lets callers notice a symlink/junction ancestor without touching the tree.
async function canonicalExisting(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(await realpath(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function assertNoSymlink(p, label) {
  const abs = path.resolve(p);
  const stat = await lstat(abs).catch(() => null);
  if (stat?.isSymbolicLink()) fail(`${label} must not be a symlink: ${abs}`);
  if (!samePath(await canonicalExisting(abs), abs)) fail(`${label} resolves through a symlink/junction: ${abs}`);
  return stat;
}

function assertOwnedSibling(p, parent) {
  const abs = path.resolve(p);
  if (path.dirname(abs) !== path.resolve(parent)) fail('owned path must sit alongside the output');
  if (!path.basename(abs).startsWith(BACKUP_PREFIX)) fail('owned path is not a runtime backup');
}

async function resolveOutputDir(outputDir, sourceRoot) {
  const src = path.resolve(sourceRoot);
  const out = path.resolve(outputDir);
  await assertNoSymlink(src, 'sourceRoot');
  await assertNoSymlink(out, 'outputDir');
  await assertNoSymlink(path.dirname(out), 'output parent');
  if (!OUTPUT_NAMES.has(path.basename(out))) fail('outputDir basename must be .runtime or runtime-test-output');
  if (samePath(out, src)) fail('outputDir must not be the source root');
  if (src.startsWith(out + path.sep)) fail('outputDir must not contain the source root');
  const blessed = path.join(src, 'apps', 'desktop', 'src-tauri', '.runtime');
  if (out.startsWith(src + path.sep) && !samePath(out, blessed)) {
    fail('outputDir must not reside in the source root except apps/desktop/src-tauri/.runtime');
  }
  return { out, src };
}

async function readLimited(response, limit, label) {
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail(`${label} size exceeds limit ${limit}`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length === 0) fail(`${label} download is empty`);
    return bytes;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > limit) fail(`${label} size ${bytes.length} exceeds limit ${limit}`);
  return bytes;
}

async function loadBinary(fetchImpl, entry, cachedPath, limit, label) {
  try {
    const cached = await readFile(cachedPath);
    if (sha256Hex(cached) === entry.sha256) return cached;
  } catch {
    // Cache miss or stale cache: download below, never trust the filename.
  }
  let response;
  try {
    response = await fetchImpl(entry.url, { redirect: 'error' });
  } catch (error) {
    fail(`${label} download failed: ${error?.message || error}`);
  }
  if (!response || !response.ok) fail(`${label} download failed with HTTP ${response?.status}`);
  const bytes = await readLimited(response, limit, label);
  if (sha256Hex(bytes) !== entry.sha256) fail(`${label} sha256 mismatch`);
  return bytes;
}

async function copySingle(from, to, label) {
  if (!(await assertNoSymlink(from, `allowlisted source ${label}`))?.isFile()) fail(`allowlisted source missing or not a file: ${label}`);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function copyTree(from, to, accept, label) {
  if (!(await assertNoSymlink(from, `allowlisted source dir ${label}`))?.isDirectory()) fail(`allowlisted source dir missing: ${label}`);
  const pending = ['.'];
  while (pending.length > 0) {
    const rel = pending.pop();
    const entries = await readdir(path.join(from, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relEntry = rel === '.' ? entry.name : path.join(rel, entry.name);
      const full = path.join(from, relEntry);
      const stat = await assertNoSymlink(full, `staged entry ${label}/${relEntry}`);
      if (stat && stat.isDirectory()) pending.push(relEntry);
      else if (entry.isFile() && accept(relEntry)) {
        const dest = path.join(to, relEntry);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(full, dest);
      }
    }
  }
}

export async function prepareRuntime(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('a fetch implementation is required');
  const { out: outputDir, src: sourceRoot } = await resolveOutputDir(
    options.outputDir || path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', '.runtime'),
    options.sourceRoot || REPO_ROOT,
  );
  const manifestPath = options.manifestPath || path.join(REPO_ROOT, 'apps', 'desktop', 'runtime-manifest.json');
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    fail(`cannot read manifest: ${manifestPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('manifest is not valid JSON');
  }
  const manifest = validateManifest(parsed);
  const [nodeBuf, licenseBuf] = await Promise.all([
    loadBinary(fetchImpl, manifest.executable, path.join(outputDir, 'node.exe'), NODE_LIMIT, 'node.exe'),
    loadBinary(fetchImpl, manifest.license, path.join(outputDir, 'LICENSE.node'), LICENSE_LIMIT, 'LICENSE.node'),
  ]);
  const parent = path.dirname(outputDir);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, STAGE_PREFIX));
  let backup = null;
  try {
    await writeFile(path.join(stage, 'node.exe'), nodeBuf);
    await writeFile(path.join(stage, 'LICENSE.node'), licenseBuf);
    await writeFile(path.join(stage, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const app = path.join(stage, 'app');
    const serverDir = path.join(sourceRoot, 'apps', 'desktop', 'server');
    const orchSrc = path.join(sourceRoot, 'orch', 'src');
    for (const name of SERVER_MODULES) await copySingle(path.join(serverDir, name), path.join(app, 'apps', 'desktop', 'server', name), `server/${name}`);
    await copyTree(orchSrc, path.join(app, 'orch', 'src'), (rel) => rel.endsWith('.mjs'), 'orch/src');
    await copySingle(path.join(sourceRoot, 'orch', 'roster.example.json'), path.join(app, 'orch', 'roster.example.json'), 'orch/roster.example.json');
    await copySingle(path.join(sourceRoot, 'model-catalog.json'), path.join(app, 'model-catalog.json'), 'model-catalog.json');
    const prior = await lstat(outputDir).catch(() => null);
    if (prior) {
      if (prior.isSymbolicLink()) fail('existing output must not be a symlink');
      backup = path.join(parent, `${BACKUP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      assertOwnedSibling(backup, parent);
      if (await lstat(backup).catch(() => null)) fail('backup collision, refusing to promote');
      await rename(outputDir, backup);
    }
    try {
      await rename(stage, outputDir);
    } catch (error) {
      if (backup) {
        try { await rename(backup, outputDir); } catch (restoreErr) {
          fail(`promote failed AND backup restore failed; backup retained at ${backup}: ${restoreErr?.message || restoreErr}`);
        }
      }
      fail(`promote staged runtime failed: ${error?.message || error}`);
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  if (backup) {
    assertOwnedSibling(backup, parent);
    try { await rm(backup, { recursive: true, force: true }); }
    catch (cleanupErr) {
      console.warn(`prepare-runtime: output published but backup cleanup failed; retained at ${backup}: ${cleanupErr?.message || cleanupErr}`);
    }
  }
  return { version: manifest.version, outputDir };
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareRuntime().then(
    (r) => console.log(`prepare-runtime: staged ${r.version} -> ${r.outputDir}`),
    (e) => { console.error(`prepare-runtime: FAILED: ${e?.message || e}`); process.exitCode = 1; },
  );
}
