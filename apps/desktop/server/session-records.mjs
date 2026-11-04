// CHO-03 S2a project/chat records and durable drafts.
//
// Thin record layer over the S1 session store (`session-store.mjs`). It owns
// projects, conversations, per-conversation drafts, draft-conflict rows, and
// the `draft_save` operation receipts that make draft saves idempotent. This
// slice has no native refs/turns/fences/clarifications/bodies/events APIs and
// no host/UI/IPC/provider wiring.
//
// Surface: createSessionRecords({ store, now = Date.now }) -> frozen record
// API. Importing this module opens no files and starts no providers; the
// caller owns store.close(). Every data operation runs inside exactly one
// synchronous store.transaction with bound parameters; ownership checks and
// the corresponding reads/mutations happen inside that same transaction.
//
// NUL note: persisted text (project name, title, model, effort, draft,
// query) containing U+0000 is rejected with ERR_INVALID_RECORD before any
// write. SQLite itself can hold NUL bytes, but the native node:sqlite string
// binding on older runtimes silently truncates text at the first NUL on
// read, so accepting NUL would lose data on those runtimes. Lone surrogates
// (which SQLite cannot preserve as text) are rejected the same way instead
// of being replaced.
import { createHash } from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const MAX_NAME = 256;
const MAX_TITLE = 512;
const MAX_MODEL = 256;
const MAX_EFFORT = 64;
const MAX_PATH = 32768;
const MAX_DRAFT = 65536;
const MAX_QUERY = 512;

const DRAFT_SAVE_V1 = "draft-save-v1";
const DRAFT_RESOLVE_V1 = "draft-resolve-v1";

function recordError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const invalid = (detail) =>
  recordError("ERR_INVALID_RECORD", `session record input is invalid (${detail})`);
const notFound = () =>
  recordError("ERR_NOT_FOUND", "session record not found");
const recordConflict = () =>
  recordError("ERR_RECORD_CONFLICT", "session record already exists");
const idempotencyConflict = () =>
  recordError(
    "ERR_IDEMPOTENCY_CONFLICT",
    "save id already used with a different payload or owner"
  );
const versionLimit = () =>
  recordError("ERR_VERSION_LIMIT", "draft version limit reached");

function requireArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("arguments");
  }
  return value;
}

// True when the string holds an unpaired surrogate half. Such strings are
// rejected rather than normalized or silently repaired.
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateUuid(value, detail) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw invalid(detail);
  }
}

function validateParentId(value) {
  if (value !== null) validateUuid(value, "parent conversation id");
}

function validateText(value, min, max, detail) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw invalid(detail);
  }
}

// Null or a nonempty well-formed string within max UTF-16 units.
function validateNullOrText(value, max, detail) {
  if (value === null) return;
  validateText(value, 1, max, detail);
}

function validateController(value) {
  if (value !== "codex" && value !== "claude") {
    throw invalid("controller");
  }
}

function validateRole(value) {
  if (value !== "implement" && value !== "review") {
    throw invalid("role");
  }
}

function validatePathCanonical(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PATH ||
    value.includes("\0") ||
    hasLoneSurrogate(value) ||
    !(
      value[0] === "/" ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.startsWith("\\\\")
    )
  ) {
    throw invalid("project path");
  }
}

function validateBoolean(value, detail) {
  if (typeof value !== "boolean") throw invalid(detail);
}

function validateLimit(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    throw invalid("limit");
  }
}

function validateOffset(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SAFE
  ) {
    throw invalid("offset");
  }
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expected version");
  }
}

function validateQuery(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_QUERY ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw invalid("query");
  }
}

function validateAction(value) {
  if (value !== "kept" && value !== "dropped") {
    throw invalid("action");
  }
}

function validateStoredText(value, max, detail) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw recordError("ERR_STORAGE", `session records ${detail} unreadable`);
  }
}

function validateStoredTimestamp(value, detail) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw recordError("ERR_STORAGE", `session records ${detail} unreadable`);
  }
}

function validateStoredVersion(value, detail) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw recordError("ERR_STORAGE", `session records ${detail} unreadable`);
  }
}

function validateResolveReceipt(parsed, resolutionId, conversationId, conflictId, action) {
  const storageErr = () =>
    recordError("ERR_STORAGE", "session records resolve receipt unreadable");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw storageErr();
  }
  if (Object.keys(parsed).length !== 8) throw storageErr();
  if (parsed.resolutionId !== resolutionId) throw storageErr();
  if (parsed.conversationId !== conversationId) throw storageErr();
  if (parsed.conflictId !== conflictId) throw storageErr();
  if (parsed.action !== action) throw storageErr();
  if (parsed.v !== 1) throw storageErr();
  if (parsed.status !== "resolved" && parsed.status !== "stale") throw storageErr();
  if (parsed.status === "resolved") {
    if (parsed.resolution !== action) throw storageErr();
  } else {
    if (parsed.resolution !== "open") throw storageErr();
  }
  if (!Number.isSafeInteger(parsed.version) || parsed.version < 0) throw storageErr();
  if (parsed.status === "resolved" && action === "kept" && parsed.version < 1) throw storageErr();
}

function resolveClock(now) {
  const stamp = now();
  if (!Number.isSafeInteger(stamp) || stamp < 0) {
    throw invalid("clock");
  }
  return stamp;
}

// Static SQL only: every dynamic value travels as a bound parameter,
// including LIMIT/OFFSET (SQLite admits bound limit/offset) and the literal
// substring probe (instr, never LIKE wildcards).
const SQL_PROJECT_EXISTS = "SELECT id FROM projects WHERE id = ?";
const SQL_PROJECT_BY_ID =
  "SELECT id, name, path_canonical, created_at_ms, archived FROM projects WHERE id = ?";
const SQL_PROJECT_BY_PATH =
  "SELECT id FROM projects WHERE path_canonical = ?";
const SQL_INSERT_PROJECT =
  "INSERT INTO projects(id, name, path_canonical, created_at_ms, archived) VALUES (?, ?, ?, ?, 0)";
const SQL_LIST_PROJECTS =
  "SELECT id, name, path_canonical, created_at_ms, archived FROM projects ORDER BY created_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_LIST_PROJECTS_OPEN =
  "SELECT id, name, path_canonical, created_at_ms, archived FROM projects WHERE archived = 0 ORDER BY created_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_SET_PROJECT_ARCHIVED =
  "UPDATE projects SET archived = ? WHERE id = ?";

const SQL_CONVERSATION_BY_KEY =
  "SELECT id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived FROM conversations WHERE id = ? AND project_id = ?";
const SQL_CONVERSATION_BY_ID =
  "SELECT id, project_id FROM conversations WHERE id = ?";
const SQL_INSERT_CONVERSATION =
  "INSERT INTO conversations(id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0)";
const SQL_LIST_CONVERSATIONS =
  "SELECT id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived FROM conversations WHERE project_id = ? ORDER BY updated_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_LIST_CONVERSATIONS_OPEN =
  "SELECT id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived FROM conversations WHERE project_id = ? AND archived = 0 ORDER BY updated_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_LIST_CONVERSATIONS_QUERY =
  "SELECT id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived FROM conversations WHERE project_id = ? AND instr(title, ?) > 0 ORDER BY updated_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_LIST_CONVERSATIONS_QUERY_OPEN =
  "SELECT id, project_id, title, controller, model_requested, model_reported, served_verified, requested_claude_session_uuid, effort, role, parent_conversation_id, created_at_ms, updated_at_ms, archived FROM conversations WHERE project_id = ? AND archived = 0 AND instr(title, ?) > 0 ORDER BY updated_at_ms DESC, id ASC LIMIT ? OFFSET ?";
const SQL_RENAME_CONVERSATION =
  "UPDATE conversations SET title = ?, updated_at_ms = ? WHERE id = ? AND project_id = ?";
const SQL_SET_CONVERSATION_ARCHIVED =
  "UPDATE conversations SET archived = ?, updated_at_ms = ? WHERE id = ? AND project_id = ?";
const SQL_TOUCH_CONVERSATION =
  "UPDATE conversations SET updated_at_ms = ? WHERE id = ?";

const SQL_GET_DRAFT =
  "SELECT conversation_id, text, version, updated_at_ms FROM drafts WHERE conversation_id = ?";
const SQL_INSERT_DRAFT =
  "INSERT INTO drafts(conversation_id, text, version, updated_at_ms) VALUES (?, ?, ?, ?)";
const SQL_UPDATE_DRAFT_CAS =
  "UPDATE drafts SET text = ?, version = ?, updated_at_ms = ? WHERE conversation_id = ? AND version = ?";
const SQL_INSERT_CONFLICT =
  "INSERT INTO draft_conflicts(conversation_id, client_save_id, base_version, text, resolution, created_at_ms) VALUES (?, ?, ?, ?, 'open', ?)";
const SQL_LIST_CONFLICTS =
  "SELECT client_save_id, base_version, resolution, created_at_ms FROM draft_conflicts WHERE conversation_id = ? ORDER BY created_at_ms ASC, client_save_id ASC LIMIT ? OFFSET ?";
const SQL_LIST_CONFLICTS_OPEN =
  "SELECT client_save_id, base_version, resolution, created_at_ms FROM draft_conflicts WHERE conversation_id = ? AND resolution = 'open' ORDER BY created_at_ms ASC, client_save_id ASC LIMIT ? OFFSET ?";
const SQL_GET_CONFLICT =
  "SELECT client_save_id, base_version, resolution, created_at_ms, text FROM draft_conflicts WHERE conversation_id = ? AND client_save_id = ?";
const SQL_UPDATE_CONFLICT_RESOLUTION =
  "UPDATE draft_conflicts SET resolution = ? WHERE conversation_id = ? AND client_save_id = ? AND resolution = 'open'";
const SQL_GET_OPERATION =
  "SELECT conversation_id, kind, payload_hash, result_json FROM operations WHERE id = ?";
const SQL_INSERT_OPERATION =
  "INSERT INTO operations(id, conversation_id, turn_id, kind, owner_generation, host_generation, state, history_json, payload_hash, result_json, created_at_ms, settled_at_ms) VALUES (?, ?, NULL, 'draft_save', 0, NULL, 'completed', '[]', ?, ?, ?, ?)";

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    pathCanonical: row.path_canonical,
    createdAtMs: row.created_at_ms,
    archived: row.archived === 1,
  };
}

function mapConversation(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    controller: row.controller,
    modelRequested: row.model_requested ?? null,
    modelReported: row.model_reported ?? null,
    servedVerified: row.served_verified ?? null,
    requestedClaudeSessionUuid:
      row.requested_claude_session_uuid ?? null,
    effort: row.effort ?? null,
    role: row.role ?? null,
    parentConversationId: row.parent_conversation_id ?? null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    archived: row.archived === 1,
  };
}

function draftPayloadHash(projectId, conversationId, expectedVersion, text) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        DRAFT_SAVE_V1,
        projectId,
        conversationId,
        expectedVersion,
        text,
      ]),
      "utf8"
    )
    .digest("hex");
}

function draftResolvePayloadHash(
  projectId,
  conversationId,
  conflictId,
  resolutionId,
  expectedVersion,
  action,
  canonicalText
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        DRAFT_RESOLVE_V1,
        projectId,
        conversationId,
        conflictId,
        resolutionId,
        expectedVersion,
        action,
        canonicalText,
      ]),
      "utf8"
    )
    .digest("hex");
}

export function createSessionRecords(options) {
  const settings = requireArgs(options);
  const { store, now = Date.now } = settings;
  if (store === null || typeof store !== "object") {
    throw invalid("store");
  }
  if (typeof store.transaction !== "function") throw invalid("store");
  if (typeof now !== "function") throw invalid("clock");

  function createProject(args) {
    const { id, name, pathCanonical } = requireArgs(args);
    validateUuid(id, "project id");
    validateText(name, 1, MAX_NAME, "project name");
    validatePathCanonical(pathCanonical);
    const createdAtMs = resolveClock(now);
    return store.transaction((tx) => {
      if (tx.get(SQL_PROJECT_EXISTS, [id])) {
        throw recordConflict();
      }
      if (tx.get(SQL_PROJECT_BY_PATH, [pathCanonical])) {
        throw recordConflict();
      }
      // Constraint failures below propagate (never swallowed into a receipt).
      tx.run(SQL_INSERT_PROJECT, [id, name, pathCanonical, createdAtMs]);
      return {
        id,
        name,
        pathCanonical,
        createdAtMs,
        archived: false,
      };
    });
  }

  function getProject(args) {
    const { projectId } = requireArgs(args);
    validateUuid(projectId, "project id");
    return store.transaction((tx) => {
      const row = tx.get(SQL_PROJECT_BY_ID, [projectId]);
      return row ? mapProject({ ...row }) : null;
    });
  }

  function listProjects(args = {}) {
    const { limit = 100, offset = 0, includeArchived = false } =
      requireArgs(args);
    validateLimit(limit);
    validateOffset(offset);
    validateBoolean(includeArchived, "includeArchived");
    return store.transaction((tx) => {
      const rows = tx.all(
        includeArchived ? SQL_LIST_PROJECTS : SQL_LIST_PROJECTS_OPEN,
        [limit, offset]
      );
      return rows.map((row) => mapProject({ ...row }));
    });
  }

  function setProjectArchived(args) {
    const { projectId, archived } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateBoolean(archived, "archived");
    return store.transaction((tx) => {
      const row = tx.get(SQL_PROJECT_BY_ID, [projectId]);
      if (!row) throw notFound();
      tx.run(SQL_SET_PROJECT_ARCHIVED, [archived ? 1 : 0, projectId]);
      const updated = tx.get(SQL_PROJECT_BY_ID, [projectId]);
      return mapProject({ ...updated });
    });
  }

  function createConversation(args) {
    const {
      id,
      projectId,
      controller,
      title = "",
      modelRequested = null,
      effort = null,
      role = "implement",
      parentConversationId = null,
    } = requireArgs(args);
    validateUuid(id, "conversation id");
    validateUuid(projectId, "project id");
    validateController(controller);
    validateText(title, 0, MAX_TITLE, "title");
    validateNullOrText(modelRequested, MAX_MODEL, "modelRequested");
    validateNullOrText(effort, MAX_EFFORT, "effort");
    validateRole(role);
    validateParentId(parentConversationId);
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      if (!tx.get(SQL_PROJECT_EXISTS, [projectId])) throw notFound();
      if (tx.get(SQL_CONVERSATION_BY_ID, [id])) throw recordConflict();
      if (parentConversationId !== null) {
        const parent = tx.get(SQL_CONVERSATION_BY_ID, [
          parentConversationId,
        ]);
        if (!parent || parent.project_id !== projectId) throw notFound();
      }
      tx.run(SQL_INSERT_CONVERSATION, [
        id,
        projectId,
        title,
        controller,
        modelRequested,
        effort,
        role,
        parentConversationId,
        stamp,
        stamp,
      ]);
      return {
        id,
        projectId,
        title,
        controller,
        modelRequested,
        modelReported: null,
        servedVerified: null,
        requestedClaudeSessionUuid: null,
        effort,
        role,
        parentConversationId,
        createdAtMs: stamp,
        updatedAtMs: stamp,
        archived: false,
      };
    });
  }

  function getConversation(args) {
    const { projectId, conversationId } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    return store.transaction((tx) => {
      const row = tx.get(SQL_CONVERSATION_BY_KEY, [
        conversationId,
        projectId,
      ]);
      return row ? mapConversation({ ...row }) : null;
    });
  }

  function listConversations(args) {
    const {
      projectId,
      limit = 50,
      offset = 0,
      includeArchived = false,
      query = "",
    } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateLimit(limit);
    validateOffset(offset);
    validateBoolean(includeArchived, "includeArchived");
    validateQuery(query);
    return store.transaction((tx) => {
      if (!tx.get(SQL_PROJECT_EXISTS, [projectId])) throw notFound();
      let statement;
      let params;
      if (query === "") {
        statement = includeArchived
          ? SQL_LIST_CONVERSATIONS
          : SQL_LIST_CONVERSATIONS_OPEN;
        params = [projectId, limit, offset];
      } else {
        statement = includeArchived
          ? SQL_LIST_CONVERSATIONS_QUERY
          : SQL_LIST_CONVERSATIONS_QUERY_OPEN;
        params = [projectId, query, limit, offset];
      }
      return tx.all(statement, params).map((row) => mapConversation({ ...row }));
    });
  }

  function renameConversation(args) {
    const { projectId, conversationId, title } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateText(title, 0, MAX_TITLE, "title");
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      const row = tx.get(SQL_CONVERSATION_BY_KEY, [
        conversationId,
        projectId,
      ]);
      if (!row) throw notFound();
      tx.run(SQL_RENAME_CONVERSATION, [
        title,
        stamp,
        conversationId,
        projectId,
      ]);
      const updated = tx.get(SQL_CONVERSATION_BY_KEY, [
        conversationId,
        projectId,
      ]);
      return mapConversation({ ...updated });
    });
  }

  function setConversationArchived(args) {
    const { projectId, conversationId, archived } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateBoolean(archived, "archived");
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      const row = tx.get(SQL_CONVERSATION_BY_KEY, [
        conversationId,
        projectId,
      ]);
      if (!row) throw notFound();
      tx.run(SQL_SET_CONVERSATION_ARCHIVED, [
        archived ? 1 : 0,
        stamp,
        conversationId,
        projectId,
      ]);
      const updated = tx.get(SQL_CONVERSATION_BY_KEY, [
        conversationId,
        projectId,
      ]);
      return mapConversation({ ...updated });
    });
  }

  function getDraft(args) {
    const { projectId, conversationId } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const row = tx.get(SQL_GET_DRAFT, [conversationId]);
      if (!row) return null;
      if (typeof row.text !== "string") {
        throw recordError("ERR_STORAGE", "session store draft unreadable");
      }
      return {
        conversationId,
        text: row.text,
        version: row.version,
        updatedAtMs: row.updated_at_ms,
      };
    });
  }

  function saveDraft(args) {
    const { projectId, conversationId, saveId, expectedVersion, text } =
      requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(saveId, "save id");
    validateExpectedVersion(expectedVersion);
    validateText(text, 0, MAX_DRAFT, "draft text");
    const stamp = resolveClock(now);
    const hash = draftPayloadHash(
      projectId,
      conversationId,
      expectedVersion,
      text
    );
    return store.transaction((tx) => {
      // Ownership first: a missing or foreign conversation rejects before
      // any receipt lookup, so no cross-chat receipt ever leaks.
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const prior = tx.get(SQL_GET_OPERATION, [saveId]);
      if (prior) {
        if (
          prior.conversation_id !== conversationId ||
          prior.kind !== "draft_save" ||
          prior.payload_hash !== hash
        ) {
          throw idempotencyConflict();
        }
        return JSON.parse(prior.result_json);
      }
      const current = tx.get(SQL_GET_DRAFT, [conversationId]);
      const currentVersion = current ? current.version : 0;
      let receipt;
      if (expectedVersion === currentVersion) {
        const next = currentVersion + 1;
        if (!Number.isSafeInteger(next)) throw versionLimit();
        if (current) {
          const updated = tx.run(SQL_UPDATE_DRAFT_CAS, [
            text,
            next,
            stamp,
            conversationId,
            expectedVersion,
          ]);
          if (Number(updated.changes) !== 1) {
            throw new Error("session records draft update lost");
          }
        } else {
          tx.run(SQL_INSERT_DRAFT, [conversationId, text, next, stamp]);
        }
        tx.run(SQL_TOUCH_CONVERSATION, [stamp, conversationId]);
        receipt = {
          saveId,
          conversationId,
          status: "saved",
          version: next,
          conflictId: null,
        };
      } else {
        tx.run(SQL_INSERT_CONFLICT, [
          conversationId,
          saveId,
          expectedVersion,
          text,
          stamp,
        ]);
        receipt = {
          saveId,
          conversationId,
          status: "conflict",
          version: currentVersion,
          conflictId: saveId,
        };
      }
      const serialized = JSON.stringify(receipt);
      tx.run(SQL_INSERT_OPERATION, [
        saveId,
        conversationId,
        hash,
        serialized,
        stamp,
        stamp,
      ]);
      // store.transaction commits before returning, so the receipt is only
      // ever handed out after both the data and the receipt committed.
      return receipt;
    });
  }

  function listDraftConflicts(args = {}) {
    const {
      projectId,
      conversationId,
      limit = 10,
      offset = 0,
      includeResolved = false,
    } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateLimit(limit);
    validateOffset(offset);
    validateBoolean(includeResolved, "includeResolved");
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const rows = tx.all(
        includeResolved ? SQL_LIST_CONFLICTS : SQL_LIST_CONFLICTS_OPEN,
        [conversationId, limit, offset]
      );
      return rows.map((row) => ({
        conversationId,
        saveId: row.client_save_id,
        baseVersion: row.base_version,
        resolution: row.resolution,
        createdAtMs: row.created_at_ms,
      }));
    });
  }

  function getDraftConflict(args) {
    const { projectId, conversationId, saveId } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(saveId, "save id");
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const row = tx.get(SQL_GET_CONFLICT, [conversationId, saveId]);
      if (!row) return null;
      return {
        conversationId,
        saveId: row.client_save_id,
        baseVersion: row.base_version,
        resolution: row.resolution,
        createdAtMs: row.created_at_ms,
        text: row.text,
      };
    });
  }

  function resolveDraftConflict(args) {
    const {
      projectId,
      conversationId,
      conflictId,
      resolutionId,
      expectedVersion,
      action,
      text,
    } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(conflictId, "conflict id");
    validateUuid(resolutionId, "resolution id");
    validateExpectedVersion(expectedVersion);
    validateAction(action);

    let canonicalText;
    if (action === "kept") {
      if (text === undefined || text === null) {
        throw invalid("text required for kept");
      }
      validateText(text, 0, MAX_DRAFT, "draft text");
      canonicalText = text;
    } else {
      if (text !== undefined && text !== null) {
        throw invalid("text must be absent or null for dropped");
      }
      canonicalText = null;
    }

    const stamp = resolveClock(now);
    const hash = draftResolvePayloadHash(
      projectId,
      conversationId,
      conflictId,
      resolutionId,
      expectedVersion,
      action,
      canonicalText
    );

    return store.transaction((tx) => {
      // Ownership: conversation must belong to project.
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }

      // Receipt lookup BEFORE fresh version/conflict checks so exact retries
      // return the original receipt regardless of later edits or resolution.
      const prior = tx.get(SQL_GET_OPERATION, [resolutionId]);
      if (prior) {
        if (
          prior.conversation_id !== conversationId ||
          prior.kind !== "draft_save" ||
          prior.payload_hash !== hash
        ) {
          throw idempotencyConflict();
        }
        if (
          typeof prior.result_json !== "string" ||
          Buffer.byteLength(prior.result_json, "utf8") > 2048
        ) {
          throw recordError(
            "ERR_STORAGE",
            "session records resolve receipt unreadable"
          );
        }
        let parsed;
        try {
          parsed = JSON.parse(prior.result_json);
        } catch {
          throw recordError(
            "ERR_STORAGE",
            "session records resolve receipt unreadable"
          );
        }
        validateResolveReceipt(
          parsed,
          resolutionId,
          conversationId,
          conflictId,
          action
        );
        return parsed;
      }

      // Scoped conflict lookup.
      const conflict = tx.get(SQL_GET_CONFLICT, [conversationId, conflictId]);
      if (!conflict) throw notFound();

      // Validate stored conflict integrity.
      validateStoredText(conflict.text, MAX_DRAFT, "conflict text");
      validateStoredVersion(conflict.base_version, "conflict base_version");
      validateStoredTimestamp(conflict.created_at_ms, "conflict created_at_ms");
      if (
        conflict.resolution !== "open" &&
        conflict.resolution !== "kept" &&
        conflict.resolution !== "dropped"
      ) {
        throw recordError(
          "ERR_STORAGE",
          "session records conflict resolution unreadable"
        );
      }
      if (conflict.resolution !== "open") {
        throw recordError(
          "ERR_DRAFT_CONFLICT_STATE",
          "draft conflict already resolved"
        );
      }

      // Read current draft (absent = version 0).
      const current = tx.get(SQL_GET_DRAFT, [conversationId]);
      let currentVersion = 0;
      if (current) {
        validateStoredText(current.text, MAX_DRAFT, "draft text");
        validateStoredVersion(current.version, "draft version");
        validateStoredTimestamp(current.updated_at_ms, "draft updated_at_ms");
        currentVersion = current.version;
      }

      // Timestamp ordering (fresh only; retries skip this).
      if (stamp < conflict.created_at_ms) {
        throw invalid("clock");
      }
      if (action === "kept" && current && stamp < current.updated_at_ms) {
        throw invalid("clock");
      }

      let receipt;

      if (expectedVersion !== currentVersion) {
        // Stale: persist only the resolution receipt; no draft/conflict mutation.
        receipt = {
          resolutionId,
          conversationId,
          conflictId,
          action,
          status: "stale",
          version: currentVersion,
          resolution: "open",
          v: 1,
        };
      } else if (action === "kept") {
        const next = currentVersion + 1;
        if (!Number.isSafeInteger(next)) throw versionLimit();
        if (current) {
          const updated = tx.run(SQL_UPDATE_DRAFT_CAS, [
            canonicalText,
            next,
            stamp,
            conversationId,
            expectedVersion,
          ]);
          if (Number(updated.changes) !== 1) {
            throw recordError(
              "ERR_STORAGE",
              "session records draft update lost"
            );
          }
        } else {
          tx.run(SQL_INSERT_DRAFT, [conversationId, canonicalText, next, stamp]);
        }
        tx.run(SQL_TOUCH_CONVERSATION, [stamp, conversationId]);
        const marked = tx.run(SQL_UPDATE_CONFLICT_RESOLUTION, [
          "kept",
          conversationId,
          conflictId,
        ]);
        if (Number(marked.changes) !== 1) {
          throw recordError(
            "ERR_STORAGE",
            "session records conflict update lost"
          );
        }
        receipt = {
          resolutionId,
          conversationId,
          conflictId,
          action,
          status: "resolved",
          version: next,
          resolution: "kept",
          v: 1,
        };
      } else {
        // dropped: mark conflict dropped only; draft and conversation untouched.
        const marked = tx.run(SQL_UPDATE_CONFLICT_RESOLUTION, [
          "dropped",
          conversationId,
          conflictId,
        ]);
        if (Number(marked.changes) !== 1) {
          throw recordError(
            "ERR_STORAGE",
            "session records conflict update lost"
          );
        }
        receipt = {
          resolutionId,
          conversationId,
          conflictId,
          action,
          status: "resolved",
          version: currentVersion,
          resolution: "dropped",
          v: 1,
        };
      }

      const serialized = JSON.stringify(receipt);
      if (Buffer.byteLength(serialized, "utf8") > 2048) {
        throw recordError(
          "ERR_STORAGE",
          "session records resolve receipt too large"
        );
      }

      tx.run(SQL_INSERT_OPERATION, [
        resolutionId,
        conversationId,
        hash,
        serialized,
        stamp,
        stamp,
      ]);

      return receipt;
    });
  }

  return Object.freeze({
    createProject,
    getProject,
    listProjects,
    setProjectArchived,
    createConversation,
    getConversation,
    listConversations,
    renameConversation,
    setConversationArchived,
    getDraft,
    saveDraft,
    listDraftConflicts,
    getDraftConflict,
    resolveDraftConflict,
  });
}
