import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { createNativeSessionPersistence } from "../server/native-session-persistence.mjs";
import { createDelegationAssociations } from "../server/delegation-associations.mjs";
import { restoreSessionStore } from "../server/session-store-restore.mjs";
import { runHost } from "../server/host.mjs";
import { encodeFrame } from "../server/protocol.mjs";
import { applyNativeUiEvent, createNativeUiSession } from "./lib/native-chat-state.ts";
import { collectTranscriptExport } from "./lib/transcript-export.ts";

const stores = [], dirs = [];
afterEach(() => { for (const p of stores.splice(0)) p.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-opus-")); dirs.push(dir);
  const open = (birth = "ms:100", databasePath = path.join(dir, "sessions.sqlite3")) => {
    const p = createNativeSessionPersistence({ databasePath, hostGeneration: randomUUID(),
      livenessPath: path.join(dir, "liveness.json"), verifyOwnerEvidence: () => true,
      verifyPendingApproval: () => true,
      verifyPendingQuestion: () => true,
      processTable: () => [{ pid: process.pid, createdAt: birth, ppid: 0, name: "fixture" }] });
    stores.push(p); return p;
  };
  const p = open(), project = p.ensureProject({ pathCanonical: dir, name: "fixture" }), conversationId = randomUUID();
  p.ensureConversation({ projectId: project.id, conversationId, controller: "codex", evidence: {} });
  p.afterThreadStart({ conversationId, nativeThreadId: "thread-fixture", evidence: {} });
  const write = (index, chunks, observed = () => {}) => {
    const turnId = randomUUID(), operationId = randomUUID(), scope = { conversationId, turnId, operationId, evidence: {} };
    p.beginTurn({ ...scope, prompt: `q${index}` }); p.afterTurnWritten(scope);
    p.afterObserved({ ...scope, nativeIdentity: "thread-fixture", nativeTurnId: `native-${index}` });
    observed(scope);
    for (const text of chunks) p.appendDelta({ ...scope, partId: randomUUID(), nativeMessageId: `m-${index}`, text });
    p.settleTurn({ ...scope, outcome: "completed", nativeIdentity: "thread-fixture", nativeTurnId: `native-${index}` });
  };
  return { dir, p, projectId: project.id, conversationId, write, open };
}

it("OPUS-01: hydrate/poll across the 2048-event boundary preserves every part once", { timeout: 30_000 }, () => {
  const f = fixture(), chunks = Array.from({ length: 2050 }, (_, i) => `[${i}]`);
  f.write(0, chunks);
  const scope = { projectId: f.projectId, conversationId: f.conversationId };
  const h = f.p.hydrateConversation(scope);
  expect(h.hasMoreEvents).toBe(true);
  expect(h.messages[1].parts.length).toBeGreaterThan(0);
  const generation = randomUUID();
  let ui = { ...createNativeUiSession(f.conversationId, "fixture"), messages: h.messages, nativeThreadId: h.nativeThreadId };
  let cursor = h.eventCursor;
  for (;;) {
    const page = f.p.pollUiCatchup({ ...scope, cursor, generation });
    for (const event of page.events) {
      ui = applyNativeUiEvent(ui, event, generation);
      ui = applyNativeUiEvent(ui, event, generation);
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  expect(ui.messages[1].text).toBe(chunks.join(""));
  expect(ui.busy).toBe(false);
});

it("OPUS-02/03: byte windows retain complete recent turns, older pages and exports recover all history", { timeout: 30_000 }, async () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) f.write(i, [`${i}:` + "x".repeat(20_000)], (scope) => {
    if (i === 59) {
      f.p.registerApproval({ conversationId: f.conversationId, turnId: scope.turnId, approvalId: randomUUID(),
        nativeRequestId: "request", connectionId: randomUUID(), nativeItemId: "item", approvalType: "command", decisions: ["accept", "decline"], evidence: {} });
      f.p.registerClarification({ conversationId: f.conversationId, turnId: scope.turnId, clarificationId: randomUUID(),
        route: "codex_request", connectionId: randomUUID(), nativeItemId: "question", nativeRequestId: 42,
        questions: [{ id: "q", header: "Pick", question: "Which?", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: false, isOther: true }], evidence: {} });
    }
  });
  const scope = { projectId: f.projectId, conversationId: f.conversationId };
  let h = f.p.hydrateConversation(scope);
  expect(h.messages.at(-2).text).toBe("q59");
  const seen = new Map();
  for (let guard = 0; guard < 20; guard++) {
    expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThan(1024 * 1024);
    expect(h.messages[0].role).toBe("user");
    expect(h.messages.at(-1).role).toBe("assistant");
    for (const m of h.messages) seen.set(m.id, m);
    if (!h.beforeTurnSeq || h.beforeTurnSeq <= 1) break;
    h = f.p.hydrateConversation({ ...scope, beforeTurnSeq: h.beforeTurnSeq, maxEventPages: 10_000 });
  }
  expect([...seen.values()].filter((m) => m.role === "user")).toHaveLength(60);
  const downloaded = await collectTranscriptExport(async (options) => {
    const payload = f.p.exportConversation({ ...scope, ...options });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024 * 1024);
    return { export: payload };
  });
  expect(downloaded.truncated).toBe(false);
  expect(downloaded.conversation.messages).toHaveLength(120);
  expect(downloaded.conversation.historicalApprovals).toHaveLength(1);
  expect(downloaded.conversation.historicalClarifications).toHaveLength(1);
  expect(downloaded.conversation.messages[0].text).toBe("q0");
  expect(downloaded.conversation.messages.at(-2).text).toBe("q59");
});

it("OPUS-08: a supported 210k-character export can be re-imported", () => {
  const f = fixture(), text = "x".repeat(210_326);
  const imported = f.p.importTranscript({ projectId: f.projectId, source: "long", sourceKey: "1", messages: [{ role: "assistant", text }] });
  const exported = f.p.exportConversation({ projectId: f.projectId, conversationId: imported.conversationId });
  expect(exported.truncated).toBe(false);
  const copy = f.p.importTranscript({ projectId: f.projectId, source: "long", sourceKey: "2", messages: exported.conversation.messages });
  expect(f.p.hydrateConversation({ projectId: f.projectId, conversationId: copy.conversationId }).messages[0].text).toBe(text);
});

it("OPUS-09: matching birth refuses recovery; a verified PID reuse permits it", () => {
  const f = fixture(); f.p.close();
  const same = f.open();
  expect(() => same.ensureConversation({ projectId: f.projectId, conversationId: f.conversationId, controller: "codex", evidence: {} })).toThrow(/live host/);
  same.close();
  const reused = f.open("ms:200");
  const claimed = reused.ensureConversation({ projectId: f.projectId, conversationId: f.conversationId, controller: "codex", evidence: {} });
  expect(claimed.ownerGeneration).toBe(2);
});

it("OPUS-10: explicit clone ownership reset permits fresh context without resuming source identity", () => {
  const f = fixture(), clonePath = path.join(f.dir, "clone.sqlite3");
  const receipt = restoreSessionStore({ sourcePath: path.join(f.dir, "sessions.sqlite3"), databasePath: clonePath, resetNativeOwnership: true });
  expect(receipt.copiedFencesReleased).toBe(1);
  const clone = f.open("ms:100", clonePath);
  clone.ensureConversation({ projectId: f.projectId, conversationId: f.conversationId, controller: "codex", evidence: {} });
  expect(clone.hydrateConversation({ projectId: f.projectId, conversationId: f.conversationId }).nativeThreadId).toBeNull();
  expect(f.p.hydrateConversation({ projectId: f.projectId, conversationId: f.conversationId }).nativeThreadId).toBe("thread-fixture");
  const entries = JSON.parse(fs.readFileSync(path.join(f.dir, "liveness.json"), "utf8")).entries;
  expect(Object.keys(entries)).toHaveLength(2);
});

it("OPUS-04/05: real host enforces recovery transitions, immutable bindings and association-scoped mutations", async () => {
  const f = fixture(), file = path.join(f.dir, "delegations.json"), associationId = "a";
  const associations = createDelegationAssociations({ filePath: file });
  associations.upsert({ id: associationId, conversationId: f.conversationId, repoPath: f.dir, wp: "WP", slice: "s", cli: "codex", model: "fixture", stage: "uncertain", runId: "run-1", worktreePath: f.dir });
  associations.upsert({ id: "launch", conversationId: f.conversationId, repoPath: f.dir, wp: "LAUNCH", slice: "s", cli: "codex", model: "fixture", stage: "worktree", worktreePath: f.dir });
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough(), chunks = [], dispatched = [];
  output.on("data", (b) => chunks.push(b));
  let wrongRun = false;
  const done = runHost({ input, output, error, generation: "g", delegationFilePath: file,
    serviceFactory: () => ({ handle: async () => ({}), close: async () => {}, authorizeDelegationAssociation: async (a) => {
      if (a.repoPath !== f.dir || a.conversationId !== f.conversationId) throw new Error("prepared project mismatch"); return a;
    } }),
    dispatch: async (command, args) => {
      dispatched.push({ command, args });
      if (command === "orch_run") throw new Error("injected post-intent dispatch failure");
      return { runId: wrongRun ? "other" : "run-1", status: { id: "run-1", status: "running", dir: f.dir, wp: "WP" } };
    } });
  let n = 0;
  async function request(command, args) {
    const requestId = `r${++n}`;
    input.write(encodeFrame({ v: 1, type: "request", generation: "g", requestId, command, args }));
    for (let guard = 0; guard < 200; guard++) {
      await new Promise((r) => setTimeout(r, 2));
      const frame = Buffer.concat(chunks).toString().split("\n").filter(Boolean).map(JSON.parse).find((r) => r.requestId === requestId);
      if (frame) return frame;
    }
    throw new Error("host response timed out");
  }
  try {
    expect((await request("delegation_upsert", { id: "a", conversationId: "other" })).type).toBe("error");
    expect((await request("delegation_upsert", { id: "b", conversationId: f.conversationId, repoPath: "elsewhere", wp: "X", slice: "s" })).type).toBe("error");
    expect((await request("orch_release", { wp: "OTHER", force: true, reason: "discarded from CHO" })).type).toBe("error");
    expect(dispatched).toHaveLength(0);
    wrongRun = true;
    expect((await request("delegation_adopt", { id: "a" })).type).toBe("error");
    wrongRun = false;
    const adopted = await request("delegation_adopt", { id: "a" });
    expect(adopted.result.association.stage).toBe("running");
    expect((await request("orch_cleanup", { associationId: "a", wp: "OTHER" })).type).toBe("result");
    expect(dispatched.at(-1).args.wp).toBe("WP");
    expect((await request("delegation_upsert", { id: "a", stage: "uncertain" })).type).toBe("result");
    const abandoned = await request("delegation_abandon", { id: "a" });
    expect(abandoned.result.association).toMatchObject({ stage: "discarded", disposition: "discarded" });
    expect((await request("orch_run", { associationId: "launch" })).type).toBe("error");
    const list = await request("delegation_list", {});
    expect(list.result.associations.find((a) => a.id === "launch").stage).toBe("uncertain");
    const count = dispatched.length;
    expect((await request("orch_run", { associationId: "launch" })).type).toBe("error");
    expect(dispatched).toHaveLength(count);
  } finally { input.end(); await done; }
});
