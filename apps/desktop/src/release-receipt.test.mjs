import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EVIDENCE_LEVEL,
  collectArtifacts,
  stagedToSource,
  verifyReceipt,
  writeReceipt,
} from "../scripts/release-receipt.mjs";

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

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-receipt-"));
  const sourceRoot = path.join(root, "src");
  const runtimeDir = path.join(root, "runtime");
  const bundleDir = path.join(root, "bundle");
  // Source files (checked-out commit content).
  fs.mkdirSync(path.join(sourceRoot, "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"), "host-bytes\n");
  fs.writeFileSync(
    path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
    '{"version":"v24.22.2"}\n',
  );
  // Staged runtime mirrors the source plus vendored binaries.
  fs.mkdirSync(path.join(runtimeDir, "app", "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "app", "apps", "desktop", "server", "host.mjs"),
    "host-bytes\n",
  );
  fs.writeFileSync(path.join(runtimeDir, "runtime-manifest.json"), '{"version":"v24.22.2"}\n');
  fs.writeFileSync(path.join(runtimeDir, "node.exe"), "fake-binary\n");
  // Installer artifacts.
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "msi-bytes\n");
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-setup.exe"), "nsis-bytes\n");
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
  return tree;
}

describe("stagedToSource", () => {
  it("maps staged runtime paths back to source paths", () => {
    expect(stagedToSource("app/apps/desktop/server/host.mjs")).toBe("apps/desktop/server/host.mjs");
    expect(stagedToSource("app/orch/src/foo.mjs")).toBe("orch/src/foo.mjs");
    expect(stagedToSource("app/model-catalog.json")).toBe("model-catalog.json");
    expect(stagedToSource("runtime-manifest.json")).toBe("apps/desktop/runtime-manifest.json");
  });

  it("has no source counterpart for vendored binaries", () => {
    expect(stagedToSource("node.exe")).toBeNull();
    expect(stagedToSource("LICENSE.node")).toBeNull();
  });
});

describe("release receipt", () => {
  it("writes a built-local receipt and verifies it", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({
      bundleDir,
      runtimeDir,
      sourceRoot,
      commit: COMMIT,
    });
    expect(receipt.evidenceLevel).toBe(EVIDENCE_LEVEL);
    expect(receipt.evidenceLevel).toBe("built-local");
    expect(receipt.artifacts).toHaveLength(2);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("collects only installer artifacts", async () => {
    const { bundleDir } = makeTree();
    fs.writeFileSync(path.join(bundleDir, "notes.txt"), "not an installer\n");
    const artifacts = await collectArtifacts(bundleDir);
    expect(artifacts.map((a) => a.file).sort()).toEqual([
      "CHO-Desktop-0.1.0-setup.exe",
      "CHO-Desktop-0.1.0-x64.msi",
    ]);
  });

  it("fails when an artifact is missing", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    fs.rmSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"));
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("missing artifact"))).toBe(true);
  });

  it("fails when an artifact hash mismatches", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "tampered\n");
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("sha256 mismatch"))).toBe(true);
  });

  it("fails when staged bytes differ from source bytes", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
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
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "runtime-manifest.json"),
      '{"version":"tampered"}\n',
    );
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("runtime-manifest.json"))).toBe(true);
  });

  it("fails when the artifact list is empty", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    for (const f of fs.readdirSync(bundleDir)) fs.rmSync(path.join(bundleDir, f));
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("artifacts list is empty"))).toBe(true);
  });

  it("refuses receipts that claim installed or clean-machine acceptance", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
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
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    await expect(
      writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "invented-not-a-commit" }),
    ).rejects.toThrow(/full lowercase hex SHA/);
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    const { ok, errors } = await verifyReceipt(
      { ...receipt, commit: "invented-not-a-commit" },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("not a full lowercase hex SHA"))).toBe(true);
  });

  it("fails when the receipt omits a staged file present in runtimeDir", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
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
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    fs.writeFileSync(path.join(runtimeDir, "extra.dll"), "unrecorded\n");
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("not recorded in receipt"))).toBe(true);
  });

  it("fails on duplicate stagedRuntime entries", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    const { ok, errors } = await verifyReceipt(
      { ...receipt, stagedRuntime: [...receipt.stagedRuntime, receipt.stagedRuntime[0]] },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("duplicate stagedRuntime entry"))).toBe(true);
  });

  it("fails on traversal and absolute staged or artifact paths", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
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
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
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
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    // A generated file (for example app package metadata) has no mapping in
    // the trusted staging rules, so it must fail — never be silently skipped.
    fs.mkdirSync(path.join(runtimeDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "app", "package.json"), '{"name":"generated"}\n');
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: COMMIT });
    expect(receipt.stagedRuntime.some((s) => s.rel === "app/package.json")).toBe(true);
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("no trusted source mapping"))).toBe(true);
  });
});

describe.runIf(HAS_GIT)("commit binding to source HEAD", () => {
  it("accepts the checked-out HEAD and rejects a mismatched well-formed SHA", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeGitTree();
    const head = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const good = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: head });
    const verified = await verifyReceipt(good, { bundleDir, sourceRoot, runtimeDir });
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(OTHER_COMMIT).not.toBe(head);
    const { ok, errors } = await verifyReceipt(
      { ...good, commit: OTHER_COMMIT },
      { bundleDir, sourceRoot, runtimeDir },
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("does not match checked-out source HEAD"))).toBe(true);
  });
});
