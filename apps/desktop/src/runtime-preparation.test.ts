import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareRuntime } from "../scripts/prepare-runtime.mjs";

const VERSION = "v24.22.2";
const NODE_URL = `https://nodejs.org/dist/${VERSION}/win-x64/node.exe`;
const LICENSE_URL = `https://raw.githubusercontent.com/nodejs/node/${VERSION}/LICENSE`;
const NODE_BYTES = Buffer.from("fake-node.exe-bytes");
const LICENSE_BYTES = Buffer.from("fake-license-bytes");
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

let TMP = "";
async function tmpBase(): Promise<string> {
  TMP ||= await realpath(tmpdir());
  return TMP;
}

function buildManifest(nodeSha = sha(NODE_BYTES), licenseSha = sha(LICENSE_BYTES)) {
  return {
    schemaVersion: 1,
    version: VERSION,
    platform: "win32",
    arch: "x64",
    executable: { url: NODE_URL, sha256: nodeSha },
    license: { url: LICENSE_URL, sha256: licenseSha },
    provenance: {
      releaseDate: "2026-01-02",
      releaseIndexUrl: "https://nodejs.org/dist/index.json",
      checksumsUrl: `https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`,
    },
  };
}

function fakeFetch(bodies: Record<string, Buffer>) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const impl = (async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const body = bodies[url];
    if (!body) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(body));
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const failingFetch = ((async () => new Response(null, { status: 500 })) as unknown as typeof fetch);
const bodies = () => ({ [NODE_URL]: NODE_BYTES, [LICENSE_URL]: LICENSE_BYTES });

async function makeSourceRoot(extra: Record<string, string> = {}, root = ""): Promise<string> {
  const out = root || (await mkdtemp(join(await tmpBase(), "rtsrc-")));
  const base: Record<string, string> = {
    "apps/desktop/server/host.mjs": "export const host = 1;\n",
    "apps/desktop/server/protocol.mjs": "export const protocol = 1;\n",
    "apps/desktop/server/bridge.mjs": "export const bridge = 1;\n",
    "apps/desktop/server/native-rpc.mjs": "export const nativeRpc = 1;\n",
    "apps/desktop/server/codex-client.mjs": "export const codexClient = 1;\n",
    "apps/desktop/server/event-mailbox.mjs": "export const eventMailbox = 1;\n",
    "apps/desktop/server/native-chat.mjs": "export const nativeChat = 1;\n",
    "apps/desktop/server/native-clarification.mjs": "export const nativeClarification = 1;\n",
    "apps/desktop/server/claude-wire.mjs": "export const wire = 1;\n",
    "apps/desktop/server/claude-client.mjs": "export const claudeClient = 1;\n",
    "apps/desktop/server/claude-chat-actor.mjs": "export const actor = 1;\n",
    "apps/desktop/server/delegation-admit.mjs": "export const admit = 1;\n",
    "apps/desktop/server/delegation-integrate.mjs": "export const integrate = 1;\n",
    "apps/desktop/server/delegation-integrate-evidence.mjs": "export const evidence = 1;\n",
    "apps/desktop/server/delegation-associations.mjs": "export const associations = 1;\n",
    "apps/desktop/server/native-session-persistence.mjs": "export const persistence = 1;\n",
    "apps/desktop/server/session-store.mjs": "export const store = 1;\n",
    "apps/desktop/server/session-store-schema.mjs": "export const schema = 1;\n",
    "apps/desktop/server/session-store-migrate.mjs": "export const migrate = 1;\n",
    "apps/desktop/server/session-store-restore.mjs": "export const restore = 1;\n",
    "apps/desktop/server/session-records.mjs": "export const records = 1;\n",
    "apps/desktop/server/session-bindings.mjs": "export const bindings = 1;\n",
    "apps/desktop/server/session-turns.mjs": "export const turns = 1;\n",
    "apps/desktop/server/session-message-deltas.mjs": "export const deltas = 1;\n",
    "apps/desktop/server/session-tool-facts.mjs": "export const facts = 1;\n",
    "apps/desktop/server/session-turn-outcomes.mjs": "export const outcomes = 1;\n",
    "apps/desktop/server/session-events.mjs": "export const events = 1;\n",
    "apps/desktop/server/session-bodies.mjs": "export const bodies = 1;\n",
    "apps/desktop/server/session-approvals.mjs": "export const approvals = 1;\n",
    "apps/desktop/server/session-clarifications.mjs": "export const clarifications = 1;\n",
    "apps/desktop/server/session-stops.mjs": "export const stops = 1;\n",
    "apps/desktop/server/session-producer-transaction.mjs": "export const producerTx = 1;\n",
    "packages/acp-client/src/claude-stream.ts": "export const claudeStream = 1;\n",
    "packages/acp-client/src/codex-app-server.ts": "export const codexAppServer = 1;\n",
    "apps/desktop/server/notes.txt": "not staged\n",
    "orch/src/index.mjs": "export const x = 1;\n",
    "orch/src/nested/deep.mjs": "export const y = 2;\n",
    "orch/src/tool.cjs": "not staged\n",
    "orch/roster.example.json": "{}\n",
    "orch/roster.json": "private\n",
    "orch/.state/ledger.json": "private\n",
    "orch.config.json": "private\n",
    "node_modules/pkg/index.js": "private\n",
    ".git/config": "private\n",
    "model-catalog.json": "{}\n",
    ...extra,
  };
  for (const [rel, content] of Object.entries(base)) {
    const full = join(out, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return out;
}

async function makeManifestFile(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(await tmpBase(), "rtman-"));
  const file = join(dir, "runtime-manifest.json");
  await writeFile(file, JSON.stringify(manifest));
  return file;
}

async function makeOutputDir(): Promise<string> {
  return join(await mkdtemp(join(await tmpBase(), "rtout-")), "runtime-test-output");
}

async function listRelative(dir: string, base: string = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await listRelative(join(dir, e.name), base, out);
    else out.push(join(dir, e.name).slice(base.length + 1));
  }
  return out.sort();
}

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await listRelative(dir)) {
    out.push(`${rel}:${sha(await readFile(join(dir, rel)))}`);
  }
  return out.sort();
}

describe("prepareRuntime", () => {
  it("stages verified resources and only the allowlist", async () => {
    const sourceRoot = await makeSourceRoot();
    const outputDir = await makeOutputDir();
    const { impl, calls } = fakeFetch(bodies());
    const result = await prepareRuntime({ manifestPath: await makeManifestFile(buildManifest()), sourceRoot, outputDir, fetchImpl: impl });
    expect(result).toEqual({ version: VERSION, outputDir });
    expect(calls.map((c) => (c.init as { redirect?: string })?.redirect)).toEqual(["error", "error"]);
    expect(await readFile(join(outputDir, "node.exe"))).toEqual(NODE_BYTES);
    expect(await readFile(join(outputDir, "LICENSE.node"))).toEqual(LICENSE_BYTES);
    expect(JSON.parse(await readFile(join(outputDir, "runtime-manifest.json"), "utf8")).version).toBe(VERSION);
    expect(await readFile(join(outputDir, "app", "apps", "desktop", "server", "bridge.mjs"), "utf8")).toBe("export const bridge = 1;\n");
    expect(await readFile(join(outputDir, "app", "apps", "desktop", "server", "native-chat.mjs"), "utf8")).toBe("export const nativeChat = 1;\n");
    expect(await readFile(join(outputDir, "app", "apps", "desktop", "server", "native-clarification.mjs"), "utf8")).toBe("export const nativeClarification = 1;\n");
    expect(await readFile(join(outputDir, "app", "packages", "acp-client", "src", "codex-app-server.ts"), "utf8")).toBe("export const codexAppServer = 1;\n");
    const expected = ["LICENSE.node", "node.exe", "runtime-manifest.json"];
    for (const name of [
      "bridge.mjs", "host.mjs", "protocol.mjs", "native-rpc.mjs", "codex-client.mjs",
      "event-mailbox.mjs", "native-chat.mjs", "native-clarification.mjs", "claude-wire.mjs",
      "claude-client.mjs", "claude-chat-actor.mjs", "delegation-admit.mjs",
      "delegation-integrate.mjs", "delegation-integrate-evidence.mjs",
      "delegation-associations.mjs", "native-session-persistence.mjs", "session-store.mjs",
      "session-store-schema.mjs", "session-store-migrate.mjs", "session-store-restore.mjs", "session-records.mjs",
      "session-bindings.mjs", "session-turns.mjs", "session-message-deltas.mjs",
      "session-tool-facts.mjs", "session-turn-outcomes.mjs", "session-events.mjs",
      "session-bodies.mjs", "session-approvals.mjs", "session-clarifications.mjs",
      "session-stops.mjs", "session-producer-transaction.mjs",
    ]) expected.push(join("app", "apps", "desktop", "server", name));
    expected.push(join("app", "packages", "acp-client", "src", "codex-app-server.ts"));
    expected.push(join("app", "packages", "acp-client", "src", "claude-stream.ts"));
    expected.push(join("app", "model-catalog.json"), join("app", "orch", "roster.example.json"), join("app", "orch", "src", "index.mjs"), join("app", "orch", "src", "nested", "deep.mjs"));
    expect(await listRelative(outputDir)).toEqual(expected.sort());
  });

  it("rejects checksum mismatch and preserves the previous good output", async () => {
    const sourceRoot = await makeSourceRoot();
    const outputDir = await makeOutputDir();
    const manifestPath = await makeManifestFile(buildManifest());
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl });
    const bad = buildManifest("0".repeat(64));
    await expect(
      prepareRuntime({ manifestPath: await makeManifestFile(bad), sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(await readFile(join(outputDir, "node.exe"))).toEqual(NODE_BYTES);
    expect(await readFile(join(outputDir, "LICENSE.node"))).toEqual(LICENSE_BYTES);
  });

  it("preserves the exact previous output when a late source copy fails", async () => {
    const sourceRoot = await makeSourceRoot();
    const outputDir = await makeOutputDir();
    const manifestPath = await makeManifestFile(buildManifest());
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl });
    const before = await snapshot(outputDir);
    await rm(join(sourceRoot, "apps", "desktop", "server", "bridge.mjs"));
    await expect(prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl })).rejects.toThrow(/allowlisted/);
    expect(await snapshot(outputDir)).toEqual(before);
  }, 15_000);

  it("replaces output wholesale so stale and unexpected files vanish", async () => {
    const sourceRoot = await makeSourceRoot();
    const outputDir = await makeOutputDir();
    const manifestPath = await makeManifestFile(buildManifest());
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl });
    await writeFile(join(outputDir, "rogue.txt"), "stale\n");
    await writeFile(join(outputDir, "app", "orch", "roster.json"), "private\n");
    await rm(join(sourceRoot, "orch", "src", "nested", "deep.mjs"));
    await writeFile(join(sourceRoot, "orch", "src", "index.mjs"), "export const x = 2;\n");
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: fakeFetch(bodies()).impl });
    const files = await listRelative(outputDir);
    expect(files).not.toContain("rogue.txt");
    expect(files).not.toContain(join("app", "orch", "roster.json"));
    expect(files).not.toContain(join("app", "orch", "src", "nested", "deep.mjs"));
    expect(await readFile(join(outputDir, "app", "orch", "src", "index.mjs"), "utf8")).toBe("export const x = 2;\n");
    expect(await readFile(join(outputDir, "node.exe"))).toEqual(NODE_BYTES);
  });

  it("rejects invalid output paths", async () => {
    const manifestPath = await makeManifestFile(buildManifest());
    const base = await mkdtemp(join(await tmpBase(), "rtcase-"));
    const badName = join(base, "not-a-runtime");
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: await makeSourceRoot(), outputDir: badName, fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/basename/);
    const same = await makeSourceRoot({}, join(base, "runtime-test-output"));
    await expect(prepareRuntime({ manifestPath, sourceRoot: same, outputDir: same, fetchImpl: fakeFetch(bodies()).impl })).rejects.toThrow(/must not be the source root/);
    const outer = join(base, "outer");
    const innerSrc = await makeSourceRoot({}, join(outer, "runtime-test-output", "inner-src"));
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: innerSrc, outputDir: join(outer, "runtime-test-output"), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/must not contain the source root/);
    const inner = await makeSourceRoot();
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: inner, outputDir: join(inner, "runtime-test-output"), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/must not reside in the source root/);
  });

  it("rejects symlink/junction ancestors for sources, output and entries", async () => {
    const manifestPath = await makeManifestFile(buildManifest());
    const base = await mkdtemp(join(await tmpBase(), "rtlink-"));
    const sourceRoot = await makeSourceRoot();
    const viaLink = join(base, "src-link");
    await symlink(sourceRoot, viaLink, "junction");
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: viaLink, outputDir: await makeOutputDir(), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/symlink|junction/);
    const parentReal = await mkdtemp(join(await tmpBase(), "rtparent-"));
    const parentLink = join(base, "parent-link");
    await symlink(parentReal, parentLink, "junction");
    await expect(
      prepareRuntime({ manifestPath, sourceRoot, outputDir: join(parentLink, "runtime-test-output"), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/symlink|junction/);
    const evilDir = await mkdtemp(join(await tmpBase(), "rtevil-"));
    await writeFile(join(evilDir, "evil.mjs"), "evil\n");
    const dirSwapped = await makeSourceRoot();
    await rm(join(dirSwapped, "orch", "src"), { recursive: true, force: true });
    await symlink(evilDir, join(dirSwapped, "orch", "src"), "junction");
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: dirSwapped, outputDir: await makeOutputDir(), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/symlink|junction/);
    const nestedSwapped = await makeSourceRoot();
    await rm(join(nestedSwapped, "orch", "src", "nested"), { recursive: true, force: true });
    await symlink(evilDir, join(nestedSwapped, "orch", "src", "nested"), "junction");
    await expect(
      prepareRuntime({ manifestPath, sourceRoot: nestedSwapped, outputDir: await makeOutputDir(), fetchImpl: fakeFetch(bodies()).impl }),
    ).rejects.toThrow(/symlink|junction/);
  });

  it("enforces streamed byte caps early and rejects redirects", async () => {
    const sourceRoot = await makeSourceRoot();
    const manifestPath = await makeManifestFile(buildManifest());
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 400) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const streamed = (async (url: string) => (url === LICENSE_URL ? new Response(stream) : new Response(NODE_BYTES))) as unknown as typeof fetch;
    await expect(prepareRuntime({ manifestPath, sourceRoot, outputDir: await makeOutputDir(), fetchImpl: streamed })).rejects.toThrow(/exceeds limit/);
    expect(pulls).toBeLessThan(400);
    const redir = (async () => Response.redirect(NODE_URL, 302)) as unknown as typeof fetch;
    await expect(prepareRuntime({ manifestPath, sourceRoot, outputDir: await makeOutputDir(), fetchImpl: redir })).rejects.toThrow(/HTTP 302/);
  });

  it("rejects invalid manifests and unpinned provenance", async () => {
    const sourceRoot = await makeSourceRoot();
    const { impl } = fakeFetch({});
    const floating = buildManifest();
    floating.version = "latest";
    await expect(prepareRuntime({ manifestPath: await makeManifestFile(floating), sourceRoot, outputDir: await makeOutputDir(), fetchImpl: impl })).rejects.toThrow(/pinned/);
    const evil = buildManifest();
    evil.executable.url = "https://evil.example.com/node.exe";
    await expect(prepareRuntime({ manifestPath: await makeManifestFile(evil), sourceRoot, outputDir: await makeOutputDir(), fetchImpl: impl })).rejects.toThrow(/pinned official URL/);
    const evilProv = buildManifest();
    evilProv.provenance.checksumsUrl = "https://evil.example.com/SHASUMS256.txt";
    await expect(prepareRuntime({ manifestPath: await makeManifestFile(evilProv), sourceRoot, outputDir: await makeOutputDir(), fetchImpl: impl })).rejects.toThrow(/SHASUMS/);
    const noDate = buildManifest();
    noDate.provenance.releaseDate = "";
    await expect(prepareRuntime({ manifestPath: await makeManifestFile(noDate), sourceRoot, outputDir: await makeOutputDir(), fetchImpl: impl })).rejects.toThrow(/releaseDate/);
    await expect(prepareRuntime({ manifestPath: join(await tmpBase(), "rt-missing-manifest.json"), sourceRoot, outputDir: await makeOutputDir(), fetchImpl: impl })).rejects.toThrow(/cannot read manifest/);
  });

  it("reuses the verified cache and refreshes source modules", async () => {
    const sourceRoot = await makeSourceRoot();
    const outputDir = await makeOutputDir();
    const manifestPath = await makeManifestFile(buildManifest());
    const first = fakeFetch(bodies());
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: first.impl });
    expect(first.calls.map((c) => c.url).sort()).toEqual([LICENSE_URL, NODE_URL].sort());
    await writeFile(join(sourceRoot, "orch", "src", "index.mjs"), "export const x = 2;\n");
    const second = fakeFetch(bodies());
    await prepareRuntime({ manifestPath, sourceRoot, outputDir, fetchImpl: second.impl });
    expect(second.calls).toEqual([]);
    expect(await readFile(join(outputDir, "app", "orch", "src", "index.mjs"), "utf8")).toBe("export const x = 2;\n");
  });

  it("enforces download caps and HTTP failures", async () => {
    const sourceRoot = await makeSourceRoot();
    const manifestPath = await makeManifestFile(buildManifest());
    const bigLicense = { [NODE_URL]: NODE_BYTES, [LICENSE_URL]: Buffer.alloc(5 * 1024 * 1024 + 1) };
    await expect(prepareRuntime({ manifestPath, sourceRoot, outputDir: await makeOutputDir(), fetchImpl: fakeFetch(bigLicense).impl })).rejects.toThrow(/exceeds limit/);
    await expect(prepareRuntime({ manifestPath, sourceRoot, outputDir: await makeOutputDir(), fetchImpl: failingFetch })).rejects.toThrow(/HTTP/);
  });

  it("stages the real host import closure without source-tree fallback", async () => {
    const prepareMod = (await import("../scripts/prepare-runtime.mjs")) as {
      SERVER_MODULES?: string[];
    };
    const serverModules = prepareMod.SERVER_MODULES;
    expect(Array.isArray(serverModules) && serverModules.length > 11).toBe(true);
    const { pathToFileURL } = await import("node:url");
    const repoServer = join(dirname(fileURLToPath(import.meta.url)), "..", "server");
    const sourceRoot = await makeSourceRoot();
    for (const name of serverModules as string[]) {
      await writeFile(
        join(sourceRoot, "apps", "desktop", "server", name),
        await readFile(join(repoServer, name)),
      );
    }
    const outputDir = await makeOutputDir();
    await prepareRuntime({
      manifestPath: await makeManifestFile(buildManifest()),
      sourceRoot,
      outputDir,
      fetchImpl: fakeFetch(bodies()).impl,
    });
    const stagedServer = join(outputDir, "app", "apps", "desktop", "server");
    for (const name of [
      "host.mjs",
      "delegation-admit.mjs",
      "delegation-integrate.mjs",
      "delegation-integrate-evidence.mjs",
      "delegation-associations.mjs",
      "native-session-persistence.mjs",
      "session-store-migrate.mjs",
    ]) {
      expect(await readFile(join(stagedServer, name), "utf8")).toContain("export");
    }
    // Load outside Vite so the staged tree is the only resolution root.
    const { spawnSync } = await import("node:child_process");
    const stagedHost = pathToFileURL(join(stagedServer, "host.mjs")).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(stagedHost)}).then((m) => { if (typeof m.runHost !== "function") process.exit(2); }).catch((e) => { console.error(e); process.exit(1); })`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(probe.status, probe.stderr || probe.stdout).toBe(0);
  }, 30_000);
});
