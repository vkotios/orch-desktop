// CHO-05 conversation↔orch associations — file-backed recoverable stages.
// Acceptance alone never mutates Git; integrate/discard are explicit.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const STAGES = new Set([
  "claimed",
  "worktree",
  "running",
  "review",
  "recorded",
  "finished",
  "discarded",
]);

const DISPOSITIONS = new Set([
  "none",
  "accepted",
  "integrated",
  "discarded",
]);

function defaultPath() {
  if (typeof process.env.CHO_DELEGATION_DB === "string" && process.env.CHO_DELEGATION_DB.trim()) {
    return path.resolve(process.env.CHO_DELEGATION_DB.trim());
  }
  return path.join(os.homedir(), ".cho-desktop", "delegations.json");
}

function isNonemptyString(value, max = 512) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isNonemptyString(raw.id, 64)) return null;
  if (!isNonemptyString(raw.repoPath, 4096)) return null;
  if (!isNonemptyString(raw.wp, 128)) return null;
  if (!isNonemptyString(raw.slice, 128)) return null;
  if (!STAGES.has(raw.stage)) return null;
  const disposition = DISPOSITIONS.has(raw.disposition) ? raw.disposition : "none";
  return {
    id: raw.id,
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : null,
    repoPath: raw.repoPath,
    wp: raw.wp,
    slice: raw.slice,
    stage: raw.stage,
    disposition,
    worktreePath: typeof raw.worktreePath === "string" ? raw.worktreePath : null,
    runId: typeof raw.runId === "string" ? raw.runId : null,
    reviewId: typeof raw.reviewId === "string" ? raw.reviewId : null,
    cli: typeof raw.cli === "string" ? raw.cli : null,
    model: typeof raw.model === "string" ? raw.model : null,
    note: typeof raw.note === "string" ? raw.note.slice(0, 2048) : null,
    updatedAtMs: Number.isSafeInteger(raw.updatedAtMs) ? raw.updatedAtMs : Date.now(),
    createdAtMs: Number.isSafeInteger(raw.createdAtMs) ? raw.createdAtMs : Date.now(),
  };
}

export function createDelegationAssociations({ filePath = defaultPath(), now = Date.now } = {}) {
  let cache = null;

  function readAll() {
    if (cache) return cache;
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      cache = items.map(normalizeRecord).filter(Boolean);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        cache = [];
      } else {
        throw err;
      }
    }
    return cache;
  }

  function writeAll(items) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ v: 1, items }, null, 2);
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, filePath);
    cache = items;
  }

  function list({ repoPath = null, conversationId = null, includeTerminal = true } = {}) {
    let items = readAll();
    if (typeof repoPath === "string" && repoPath) {
      items = items.filter((item) => item.repoPath === repoPath);
    }
    if (typeof conversationId === "string" && conversationId) {
      items = items.filter((item) => item.conversationId === conversationId);
    }
    if (!includeTerminal) {
      items = items.filter((item) => item.disposition === "none");
    }
    return items.slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  function get(id) {
    if (!isNonemptyString(id, 64)) throw new Error("delegation id required");
    return readAll().find((item) => item.id === id) ?? null;
  }

  function upsert(input) {
    if (!input || typeof input !== "object") throw new Error("delegation upsert requires an object");
    const stamp = typeof now === "function" ? now() : Date.now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) throw new Error("invalid clock");
    const items = readAll().slice();
    const existingIndex = typeof input.id === "string" ? items.findIndex((item) => item.id === input.id) : -1;
    const prior = existingIndex >= 0 ? items[existingIndex] : null;
    const id = prior?.id ?? (typeof input.id === "string" && input.id ? input.id : crypto.randomUUID());
    const next = normalizeRecord({
      ...(prior ?? {}),
      ...input,
      id,
      createdAtMs: prior?.createdAtMs ?? stamp,
      updatedAtMs: stamp,
      disposition: input.disposition ?? prior?.disposition ?? "none",
      stage: input.stage ?? prior?.stage ?? "claimed",
    });
    if (!next) throw new Error("delegation upsert rejected invalid record");
    if (existingIndex >= 0) items[existingIndex] = next;
    else items.push(next);
    writeAll(items);
    return next;
  }

  function setDisposition(id, disposition, note = null) {
    if (!DISPOSITIONS.has(disposition) || disposition === "none") {
      throw new Error("disposition must be accepted, integrated, or discarded");
    }
    const current = get(id);
    if (!current) throw new Error("delegation not found");
    if (current.disposition !== "none" && current.disposition !== disposition) {
      throw new Error(`delegation already ${current.disposition}`);
    }
    return upsert({
      ...current,
      disposition,
      note: typeof note === "string" ? note : current.note,
      stage:
        disposition === "accepted"
          ? "recorded"
          : disposition === "integrated"
            ? "finished"
            : "discarded",
    });
  }

  return Object.freeze({ list, get, upsert, setDisposition, filePath });
}
