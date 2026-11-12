import { describe, expect, it } from "vitest";
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

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cho-receipt-"));
  const sourceRoot = path.join(root, "src");
  const runtimeDir = path.join(root, "runtime");
  const bundleDir = path.join(root, "bundle");
  // Source files (checked-out commit content).
  fs.mkdirSync(path.join(sourceRoot, "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"), "host-bytes\n");
  // Staged runtime mirrors the source plus a vendored binary.
  fs.mkdirSync(path.join(runtimeDir, "app", "apps", "desktop", "server"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "app", "apps", "desktop", "server", "host.mjs"),
    "host-bytes\n",
  );
  fs.writeFileSync(path.join(runtimeDir, "node.exe"), "fake-binary\n");
  // Installer artifacts.
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "msi-bytes\n");
  fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-setup.exe"), "nsis-bytes\n");
  return { root, sourceRoot, runtimeDir, bundleDir };
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
      commit: "abc123",
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
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "abc123" });
    fs.rmSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"));
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("missing artifact"))).toBe(true);
  });

  it("fails when an artifact hash mismatches", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "abc123" });
    fs.writeFileSync(path.join(bundleDir, "CHO-Desktop-0.1.0-x64.msi"), "tampered\n");
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("sha256 mismatch"))).toBe(true);
  });

  it("fails when staged bytes differ from source bytes", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "abc123" });
    // Source changed after staging: the staged copy no longer matches the commit.
    fs.writeFileSync(
      path.join(sourceRoot, "apps", "desktop", "server", "host.mjs"),
      "different-bytes\n",
    );
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("differs from source"))).toBe(true);
  });

  it("fails when the artifact list is empty", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    for (const f of fs.readdirSync(bundleDir)) fs.rmSync(path.join(bundleDir, f));
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "abc123" });
    const { ok, errors } = await verifyReceipt(receipt, { bundleDir, sourceRoot, runtimeDir });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("artifacts list is empty"))).toBe(true);
  });

  it("refuses receipts that claim installed or clean-machine acceptance", async () => {
    const { sourceRoot, runtimeDir, bundleDir } = makeTree();
    const receipt = await writeReceipt({ bundleDir, runtimeDir, sourceRoot, commit: "abc123" });
    for (const level of ["installed", "clean-machine"]) {
      const { ok, errors } = await verifyReceipt(
        { ...receipt, evidenceLevel: level },
        { bundleDir, sourceRoot, runtimeDir },
      );
      expect(ok).toBe(false);
      expect(errors.some((e) => e.includes("evidenceLevel"))).toBe(true);
    }
  });
});
