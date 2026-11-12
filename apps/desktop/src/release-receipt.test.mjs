import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_LEVEL,
  artifactKind,
  collectArtifacts,
  stagedToSource,
  verifyReceipt,
  writeReceipt,
} from "../scripts/release-receipt.mjs";

// Absolute path to the CLI script, so child-process invocations work from any
// test working directory.
const SCRIPT = fileURLToPath(new URL("../scripts/release-receipt.mjs", import.meta.url));

// Full-length lowercase hex SHAs, as produced by `git rev-parse HEAD`.
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-receipt-"));
  tempRoots.push(root);
  const sourceRoot = path.join(root, "src");
  const runtimeDir = path.join(root, "runtime");
  const bundleDir = path.join(root, "bundle");
  // Source files (checked-out commit content).
  fs.mkdirSync(path.join(sourceRoot, "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"), "host-bytes\n");
  // Source manifest as a Windows checkout produces it: CRLF line endings
  // (the repo pins "* -text", so no EOL normalization happens).
  fs.writeFileSync(
    path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
    '{\r\n  "version": "v24.22.2"\r\n}\r\n',
  );
  // Staged runtime mirrors the source plus vendored binaries.
  fs.mkdirSync(path.join(runtimeDir, "app", "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "app", "apps", "desktop", "server", "host.mjs"),
    "host-bytes\n",
  );
  // Staged manifest is generated, not copied: exactly the bytes
  // prepare-runtime writes (JSON.stringify(manifest, null, 2) + LF).
  fs.writeFileSync(path.join(runtimeDir, "runtime-manifest.json"), '{\n  "version": "v24.22.2"\n}\n');
  fs.writeFileSync(path.join(runtimeDir, "node.exe"), "fake-binary\n");
  // Installer artifacts: all three intended kinds (MSI, NSIS setup, raw EXE).
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "msi-bytes\n");
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-setup.exe"), "nsis-bytes\n");
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0.exe"), "raw-bytes\n");
  return { root, sourceRoot, runtimeDir, bundleDir };
}

function makeGitTree() {
  const tree = makeTree();
  execFileSync("git", ["init"], { cwd: tree.sourceRoot, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tree.sourceRoot, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=cho-test", "-c", "user.email=cho-test@example.com", "commit", "-m", "fixture"],
    { cwd: tree.sourceRoot, stdio: "ignore" },
  );
  const head = execFileSync("git", ["-C", tree.sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  return { ...tree, commit: head };
}

describe("stagedToSource", () => {
  it("maps staged runtime paths back to source paths", () => {
    expect(stagedToSource("app/apps/desktop/server/host.mjs")).toBe("apps/desktop/server/host.mjs");
    expect(stagedToSource("app/orch/src/foo.mjs")).toBe("orch/src/foo.mjs");
    expect(stagedToSource("app/orch/src/adapters/nested.mjs")).toBe("orch/src/adapters/nested.mjs");
    expect(stagedToSource("app/orch/roster.example.json")).toBe("orch/roster.example.json");
    expect(stagedToSource("app/packages/acp-client/src/codex-app-server.ts")).toBe(
      "packages/acp-client/src/codex-app-server.ts",
    );
    expect(stagedToSource("app/packages/acp-client/src/claude-stream.ts")).toBe(
      "packages/acp-client/src/claude-stream.ts",
    );
    expect(stagedToSource("app/model-catalog.json")).toBe("model-catalog.json");
    expect(stagedToSource("runtime-manifest.json")).toBe("apps/desktop/runtime-manifest.json");
  });

  it("has no source counterpart for vendored binaries", () => {
    expect(stagedToSource("node.exe")).toBeNull();
    expect(stagedToSource("LICENSE.node")).toBeNull();
  });

  it("rejects staged files outside the exact prepare-runtime outputs", () => {
    // prepare-runtime stages named server modules only: type declarations,
    // fixtures and unknown modules have no trusted mapping.
    expect(stagedToSource("app/apps/desktop/server/bridge.d.mts")).toBeNull();
    expect(stagedToSource("app/apps/desktop/server/unknown.mjs")).toBeNull();
    expect(stagedToSource("app/apps/desktop/server/nested/host.mjs")).toBeNull();
    // orch/src stages *.mjs only, plus the roster example: nothing else.
    expect(stagedToSource("app/orch/src/data.json")).toBeNull();
    expect(stagedToSource("app/orch/package.json")).toBeNull();
    expect(stagedToSource("app/orch/roster.json")).toBeNull();
    // Only the two named ACP sources are staged.
    expect(stagedToSource("app/packages/acp-client/src/index.ts")).toBeNull();
    // Generated package metadata has no mapping and must fail, never skip.
    expect(stagedToSource("app/package.json")).toBeNull();
  });
});

describe("artifactKind", () => {
  it("distinguishes MSI, NSIS setup and raw executables", () => {
    expect(artifactKind("CHO-Desktop-0.1.0-x64.msi")).toBe("msi");
    expect(artifactKind("CHO-Desktop-0.1.0-setup.exe")).toBe("nsis");
    expect(artifactKind("CHO-Desktop-0.1.0.exe")).toBe("raw");
    expect(artifactKind("notes.txt")).toBeNull();
  });
});

describe("release receipt without git", () => {
  it("collects all three installer artifact kinds", async () => {
    const { bundleDir } = makeTree();
    const artifacts = await collectArtifacts(bundleDir);
    // Sort both sides with the same comparator: the assertion is about the
    // set of files, not the collation order.
    expect(artifacts.map((a) => a.file).sort()).toEqual(
      [
        "CHO-Desktop-0.1.0-setup.exe",
        "CHO-Desktop-0.1.0.exe",
        "CHO-Desktop-0.1.0-x64.msi",
      ].sort(),
    );
  });

  it("refuses verification without runtimeDir", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit: COMMIT });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("runtimeDir is required"))).toBe(true);
  });

  it("refuses candidate binding when the source HEAD cannot be resolved", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit: COMMIT });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("cannot resolve checked-out source HEAD"))).toBe(true);
  });

  it("writes a portable receipt with no absolute sourceRoot", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit: COMMIT });
    expect(receipt).not.toHaveProperty("sourceRoot");
    expect(JSON.stringify(receipt)).not.toContain(sourceRoot);
  });

  it("rejects a non-SHA commit or prHead at write time", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    await expect(
      writeReceipt({ bundleDir, runtimeDir, commit: "invented-not-a-commit" }),
    ).rejects.toThrow(/full lowercase hex SHA/);
    await expect(
      writeReceipt({ bundleDir, runtimeDir, commit: COMMIT, prHead: "nope" }),
    ).rejects.toThrow(/prHead/);
  });

  it("CLI verify requires --runtime-dir", async () => {
    const { sourceRoot, runtimeDir, bundleDir, root } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit: COMMIT });
    const receiptPath = path.join(root, "candidate-receipt.json");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          SCRIPT,
          "verify",
          "--receipt",
          receiptPath,
          "--bundle-dir",
          bundleDir,
          "--source-root",
          sourceRoot,
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      failed = true;
      expect(String(error?.stderr || error?.message)).toContain("missing --runtime-dir");
    }
    expect(failed).toBe(true);
  });
});

describe.runIf(HAS_GIT)("release receipt", () => {
  it("writes a built-local receipt and verifies it", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({
      bundleDir,
      runtimeDir,
      commit,
    });
    expect(receipt.evidenceLevel).toBe(EVIDENCE_LEVEL);
    expect(receipt.evidenceLevel).toBe("built-local");
    expect(receipt.artifacts).toHaveLength(3);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("records the PR head separately without changing candidate binding", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    expect(OTHER_COMMIT).not.toBe(commit);
    const receipt = await writeReceipt({
      bundleDir,
      runtimeDir,
      commit,
      prHead: OTHER_COMMIT,
    });
    expect(receipt.prHead).toBe(OTHER_COMMIT);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    const forged = { ...receipt, prHead: "invented-not-a-commit" };
    const checked = await verifyReceipt(forged, { bundleDir, sourceRoot, runtimeDir });
    expect(checked.ok).toBe(false);
    expect(checked.errors.some((e) => e.includes("prHead"))).toBe(true);
  });

  it("fails when an artifact is missing", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    fs.rmSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"));
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("missing artifact"))).toBe(true);
  });

  it("fails when a recorded artifact is absent from disk but the kinds still match", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    // Receipt trimmed to the MSI while the NSIS/raw outputs exist on disk.
    const trimmed = {
      ...receipt,
      artifacts: receipt.artifacts.filter((a) => a.file.endsWith(".msi")),
    };
    expect(trimmed.artifacts).toHaveLength(1);
    const { ok, errors } = await verifyReceipt(trimmed, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(
      errors.some((e) => e.includes("is not recorded in receipt") && e.includes("setup.exe")),
    ).toBe(true);
    expect(errors.some((e) => e.includes("missing required kind 'nsis'"))).toBe(true);
    expect(errors.some((e) => e.includes("missing required kind 'raw'"))).toBe(true);
  });

  it("fails when disk and receipt agree on a single artifact kind", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    // Only the MSI is built/kept: receipt and disk agree, but the candidate
    // is still incomplete because the NSIS and raw outputs are required.
    for (const f of fs.readdirSync(bundleDir)) {
      if (!f.endsWith(".msi")) fs.rmSync(path.join(bundleDir, f));
    }
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    expect(receipt.artifacts).toHaveLength(1);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("missing required kind 'nsis'"))).toBe(true);
    expect(errors.some((e) => e.includes("missing required kind 'raw'"))).toBe(true);
  });

  it("fails when an artifact hash mismatches", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "tampered\n");
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("sha256 mismatch"))).toBe(true);
  });

  it("fails when staged bytes differ from source bytes", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    // Source changed after staging: the staged copy no longer matches the commit.
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"),
      "different-bytes\n",
    );
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("differs from source"))).toBe(true);
  });

  it("fails when the staged runtime manifest differs from the source manifest", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
      '{"version":"tampered"}\n',
    );
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("runtime-manifest.json"))).toBe(true);
  });

  it("verifies a CRLF source manifest against the LF generated stage", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    // Fixture guard: the source manifest really carries CRLF endings and the
    // staged manifest really is the LF serialization, as on a Windows checkout.
    const sourceManifest = fs.readFileSync(
      path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
      "utf8",
    );
    const stagedManifest = fs.readFileSync(path.join(runtimeDir, "runtime-manifest.json"), "utf8");
    expect(sourceManifest).toContain("\r\n");
    expect(stagedManifest).not.toContain("\r");
    expect(stagedManifest).toBe('{\n  "version": "v24.22.2"\n}\n');
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("fails when the source manifest gains a field the stage lacks", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    // Every JSON field participates: an added source field changes the
    // serialization the stage must match, so it can never be skipped.
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
      '{\r\n  "version": "v24.22.2",\r\n  "extra": true\r\n}\r\n',
    );
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("runtime-manifest.json"))).toBe(true);
  });

  it("fails when the artifact list is empty", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    for (const f of fs.readdirSync(bundleDir)) fs.rmSync(path.join(bundleDir, f));
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("artifacts list is empty"))).toBe(true);
  });

  it("refuses receipts that claim installed or clean-machine acceptance", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    for (const level of ["installed", "clean-machine"]) {
      const { ok, errors } = await verifyReceipt(
        { ...receipt, evidenceLevel: level },
        { bundleDir, sourceRoot, runtimeDir },
      );
      expect(ok).toBe(false);
      expect(errors.some((e) => e.includes("evidenceLevel"))).toBe(true);
    }
  });

  it("rejects a non-SHA commit claim", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const { ok, errors } = await verifyReceipt(
      { ...(await writeReceipt({ bundleDir, runtimeDir, commit })), commit: "invented-not-a-commit" },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("not a full lowercase hex SHA"))).toBe(true);
  });

  it("fails when the receipt omits a staged file present in runtimeDir", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    // Receipt reduced to the vendored binary while the staged app file exists.
    const trimmed = {
      ...receipt,
      stagedRuntime: receipt.stagedRuntime.filter((s) => s.rel === "node.exe"),
    };
    expect(trimmed.stagedRuntime).toHaveLength(1);
    const { ok, errors } = await verifyReceipt(trimmed, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("not recorded in receipt"))).toBe(true);
  });

  it("fails when runtimeDir holds a file absent from the receipt", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    fs.writeFileSync(path.join(runtimeDir, "extra.dll"), "unrecorded\n");
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("not recorded in receipt"))).toBe(true);
  });

  it("fails on duplicate stagedRuntime entries", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const { ok, errors } = await verifyReceipt(
      { ...receipt, stagedRuntime: [...receipt.stagedRuntime, receipt.stagedRuntime[0]] },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("duplicate stagedRuntime entry"))).toBe(true);
  });

  it("fails on traversal and absolute staged or artifact paths", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const evil = { rel: "../evil.mjs", sha256: "0".repeat(64), bytes: 1 };
    const absolute = { rel: "/abs.mjs", sha256: "0".repeat(64), bytes: 1 };
    const forged = {
      ...receipt,
      stagedRuntime: [...receipt.stagedRuntime, evil, absolute],
      artifacts: [
        ...receipt.artifacts,
        { file: "../evil.msi", sha256: "0".repeat(64), bytes: 1 },
      ],
    };
    const { ok, errors } = await verifyReceipt(forged, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("unsafe stagedRuntime path"))).toBe(true);
    expect(errors.some((e) => e.includes("unsafe artifact path"))).toBe(true);
  });

  it("ignores a redirected receipt source field", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    // Attacker changes the real source, then points the receipt entry at an
    // unrelated file that still holds the old bytes. The trusted staging
    // rules must win over the receipt-supplied source field.
    fs.writeFileSync(path.join(sourceRoot, "unrelated.mjs"), "host-bytes\n");
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"),
      "changed-bytes\n",
    );
    const forged = {
      ...receipt,
      stagedRuntime: receipt.stagedRuntime.map((s) =>
        s.rel === "app/apps/desktop/server/host.mjs" ? { ...s, source: "unrelated.mjs" } : s,
      ),
    };
    const { ok, errors } = await verifyReceipt(forged, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(
      errors.some(
        (e) =>
          e.includes("differs from source") &&
          e.includes("app/apps/desktop/server/host.mjs"),
      ),
    ).toBe(true);
  });

  it("fails for staged files with no trusted source mapping", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    // A generated file (for example app package metadata) has no mapping in
    // the trusted staging rules, so it must fail — never be silently skipped.
    fs.mkdirSync(path.join(runtimeDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "app", "package.json"), '{"name":"generated"}\n');
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    expect(receipt.stagedRuntime.some((s) => s.rel === "app/package.json")).toBe(true);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("no trusted source mapping"))).toBe(true);
  });

  it("fails for staged orch files outside the allowed outputs", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    fs.mkdirSync(path.join(runtimeDir, "app", "orch"), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "app", "orch", "package.json"), "{}\n");
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(
      errors.some(
        (e) => e.includes("no trusted source mapping") && e.includes("app/orch/package.json"),
      ),
    ).toBe(true);
  });

  it("accepts the checked-out HEAD and rejects a mismatched well-formed SHA", async () => {
    const { sourceRoot, runtimeDir, bundleDir, commit } = makeGitTree();
    expect(OTHER_COMMIT).not.toBe(commit);
    const good = await writeReceipt({ bundleDir, runtimeDir, commit });
    const verified = await verifyReceipt(good, { bundleDir, sourceRoot, runtimeDir });
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
    const { ok, errors } = await verifyReceipt(
      { ...good, commit: OTHER_COMMIT },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("does not match checked-out source HEAD"))).toBe(true);
  });

  it("CLI verify accepts a complete candidate and fails on tampered bytes", async () => {
    const { sourceRoot, runtimeDir, bundleDir, root, commit } = makeGitTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, commit });
    const receiptPath = path.join(root, "candidate-receipt.json");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const verifyArgs = [
      SCRIPT,
      "verify",
      "--receipt",
      receiptPath,
      "--bundle-dir",
      bundleDir,
      "--source-root",
      sourceRoot,
      "--runtime-dir",
      runtimeDir,
    ];
    execFileSync(process.execPath, verifyArgs, { encoding: "utf8", stdio: "pipe" });
    fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "tampered\n");
    let failed = false;
    try {
      execFileSync(process.execPath, verifyArgs, { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      failed = true;
      expect(String(error?.stderr || error?.message)).toContain("sha256 mismatch");
    }
    expect(failed).toBe(true);
  });
});
