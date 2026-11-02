// CHO-03 S2b producer fences and native reference binding.
//
// Thin binding layer over the S1 session store (`session-store.mjs`). It owns
// `producer_fences` transitions and `native_refs` / requested-Claude-UUID
// binding for conversations created through the S2a records API. This slice
// has no host/UI/IPC/provider wiring and performs no process supervision:
// the future S3 host owns actual process identity checks, token-to-host
// mapping, and proof freshness. This module never establishes OS process
// death and never treats PID/time/TTL/manual override as evidence.
//
// Surface: createSessionBindings({ store, verifyOwnerEvidence, now = Date.now })
// -> frozen API of six methods. Importing this module opens no files and
// starts no providers; the caller owns store.close(). Every data operation
// runs inside exactly one synchronous store.transaction with bound values;
// ownership checks, proof evaluation, and mutations happen inside that same
// writer transaction. No raw DB handle or SQL endpoint escapes.
//
// `verifyOwnerEvidence` MUST be an explicitly provided synchronous trusted
// host callback. There is no default verifier. It receives frozen facts
// { action, projectId, conversationId, ownerToken, generation, evidence }
// where action is 'live', 'released', or 'dead', and only a strictly `true`
// return authorizes. It evaluates already-obtained host process
// identity/liveness facts; it must not perform SQL/IPC/provider effects
// inside the DB transaction. A `false`, non-boolean, throwing, or thenable
// result rejects with ERR_OWNER_UNVERIFIED (static generic message, never
// echoing the callback exception or evidence). A rejected async result is
// consumed so no unhandled rejection escapes, but a thenable NEVER
// authorizes. Evidence is passed through to the verifier only: never
// serialized, logged, or stored.
//
// NUL note: persisted native thread ids containing U+0000 or lone surrogates
// are rejected with ERR_INVALID_RECORD before any write, matching the S2a
// input policy.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_THREAD_ID = 512;

function bindingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const invalid = (detail) =>
  bindingError("ERR_INVALID_RECORD", `session binding input is invalid (${detail})`);
const notFound = () =>
  bindingError("ERR_NOT_FOUND", "session binding not found");
const fenceConflict = () =>
  bindingError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const generationLimit = () =>
  bindingError("ERR_GENERATION_LIMIT", "session producer generation limit reached");
const bindingConflict = () =>
  bindingError("ERR_BINDING_CONFLICT", "session native binding conflict");
const ownerUnverified = () =>
  bindingError("ERR_OWNER_UNVERIFIED", "session producer ownership is not verified");
const malformedFence = () =>
  bindingError("ERR_STORAGE", "session binding stored fence is unreadable");

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

// Canonical lowercase UUID only: no trimming, no case conversion.
function validateUuid(value, detail) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw invalid(detail);
  }
}

function validateExpectedGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expected generation");
  }
}

function validateGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("generation");
  }
}

function validateController(value) {
  if (value !== "codex" && value !== "claude") {
    throw invalid("controller");
  }
}

function validateTerminalState(value) {
  if (value !== "released" && value !== "dead") {
    throw invalid("terminal state");
  }
}

// Null or a nonempty well-formed Unicode string within the UTF-16 budget.
// Malformed shape is ERR_INVALID_RECORD; using the wrong id kind for a
// controller is ERR_BINDING_CONFLICT (checked by the caller).
function validateThreadIdOrNull(value) {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_THREAD_ID ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throw invalid("native thread id");
  }
}

function validateSessionUuidOrNull(value) {
  if (value === null) return;
  validateUuid(value, "native session id");
}

function resolveClock(now) {
  const stamp = now();
  if (!Number.isSafeInteger(stamp) || stamp < 0) {
    throw invalid("clock");
  }
  return stamp;
}

// A stored fence with a bad generation/token/state is corruption: fail
// ERR_STORAGE rather than authorizing against it.
function parseFence(row) {
  if (
    !row ||
    typeof row.owner_token !== "string" ||
    !UUID_RE.test(row.owner_token) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    (row.state !== "held" && row.state !== "released" && row.state !== "dead") ||
    !Number.isSafeInteger(row.updated_ms) ||
    row.updated_ms < 0
  ) {
    throw malformedFence();
  }
  return {
    conversationId: row.conversation_id,
    ownerToken: row.owner_token,
    generation: row.generation,
    state: row.state,
    updatedAtMs: row.updated_ms,
  };
}

function mapNativeRef(row) {
  return {
    conversationId: row.conversation_id,
    projectId: row.project_id,
    controller: row.controller,
    nativeThreadId: row.native_thread_id ?? null,
    nativeSessionUuid: row.native_session_uuid ?? null,
    createdAtMs: row.created_at_ms,
  };
}

// Static SQL only: every dynamic value travels as a bound parameter.
const SQL_CONVERSATION_BY_KEY =
  "SELECT id, project_id, controller, requested_claude_session_uuid FROM conversations WHERE id = ? AND project_id = ?";
const SQL_FENCE_BY_CONVERSATION =
  "SELECT conversation_id, owner_token, generation, state, updated_ms FROM producer_fences WHERE conversation_id = ?";
const SQL_INSERT_FENCE =
  "INSERT INTO producer_fences(conversation_id, owner_token, generation, state, updated_ms) VALUES (?, ?, ?, 'held', ?)";
const SQL_RENEW_FENCE =
  "UPDATE producer_fences SET updated_ms = ? WHERE conversation_id = ? AND generation = ? AND owner_token = ? AND state = 'held'";
const SQL_RECLAIM_FENCE =
  "UPDATE producer_fences SET owner_token = ?, generation = ?, state = 'held', updated_ms = ? WHERE conversation_id = ? AND generation = ? AND owner_token = ? AND state IN ('released', 'dead')";
const SQL_SETTLE_FENCE =
  "UPDATE producer_fences SET state = ?, updated_ms = ? WHERE conversation_id = ? AND generation = ? AND owner_token = ? AND state = 'held'";
const SQL_REF_BY_CONVERSATION =
  "SELECT conversation_id, project_id, controller, native_thread_id, native_session_uuid, created_at_ms FROM native_refs WHERE conversation_id = ? AND controller = ?";
const SQL_THREAD_OWNER =
  "SELECT conversation_id FROM native_refs WHERE native_thread_id = ?";
const SQL_SESSION_OWNER =
  "SELECT conversation_id FROM native_refs WHERE native_session_uuid = ?";
const SQL_INSERT_REF =
  "INSERT INTO native_refs(conversation_id, project_id, controller, native_thread_id, native_session_uuid, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)";
const SQL_SET_REQUESTED_UUID =
  "UPDATE conversations SET requested_claude_session_uuid = ?, updated_at_ms = ? WHERE id = ? AND project_id = ? AND requested_claude_session_uuid IS NULL";

export function createSessionBindings(options) {
  const settings = requireArgs(options);
  const { store, verifyOwnerEvidence, now = Date.now } = settings;
  if (store === null || typeof store !== "object") {
    throw invalid("store");
  }
  if (typeof store.transaction !== "function") throw invalid("store");
  // No permissive default verifier: the host callback must be explicitly
  // provided. A boolean from UI is never accepted as auth.
  if (typeof verifyOwnerEvidence !== "function") throw invalid("owner verifier");
  if (typeof now !== "function") throw invalid("clock");

  // Proof evaluation inside the writer transaction. Only a strictly `true`
  // return authorizes; anything else (false, non-boolean, throw, thenable)
  // is ERR_OWNER_UNVERIFIED with a static generic message. A rejected async
  // result is consumed so no unhandled rejection escapes.
  function authorize(action, projectId, conversationId, ownerToken, generation, evidence) {
    const facts = Object.freeze({
      action,
      projectId,
      conversationId,
      ownerToken,
      generation,
      evidence,
    });
    let result;
    try {
      result = verifyOwnerEvidence(facts);
    } catch {
      throw ownerUnverified();
    }
    if (result === true) return;
    let then;
    try {
      then =
        result !== null &&
        (typeof result === "object" || typeof result === "function")
          ? result.then
          : undefined;
    } catch {
      throw ownerUnverified();
    }
    if (typeof then === "function") {
      try {
        result.then(undefined, () => {});
      } catch {
        /* best-effort consumption; a thenable never authorizes */
      }
    }
    throw ownerUnverified();
  }

  // History stays readable after release/death: reads need no live proof.
  function getProducer(args) {
    const { projectId, conversationId } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const row = tx.get(SQL_FENCE_BY_CONVERSATION, [conversationId]);
      if (!row) return null;
      return parseFence(row);
    });
  }

  function claimProducer(args) {
    const { projectId, conversationId, ownerToken, expectedGeneration, evidence } =
      requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(ownerToken, "owner token");
    validateExpectedGeneration(expectedGeneration);
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const current = tx.get(SQL_FENCE_BY_CONVERSATION, [conversationId]);
      if (!current) {
        // First claim INSERTs the absent row at generation 1, never upserts.
        if (expectedGeneration !== 0) throw fenceConflict();
        authorize("live", projectId, conversationId, ownerToken, 1, evidence);
        tx.run(SQL_INSERT_FENCE, [conversationId, ownerToken, 1, stamp]);
        return {
          conversationId,
          ownerToken,
          generation: 1,
          state: "held",
          updatedAtMs: stamp,
        };
      }
      const fence = parseFence(current);
      if (fence.state === "held") {
        // Same owner and exact generation may renew at the SAME generation.
        // A different owner or wrong generation never transfers, no matter
        // what the proof callback would return and no matter how ancient
        // the timestamp: there is no TTL or manual-override takeover.
        if (fence.ownerToken !== ownerToken || fence.generation !== expectedGeneration) {
          throw fenceConflict();
        }
        authorize("live", projectId, conversationId, ownerToken, fence.generation, evidence);
        const renewed = tx.run(SQL_RENEW_FENCE, [
          stamp,
          conversationId,
          fence.generation,
          ownerToken,
        ]);
        if (Number(renewed.changes) !== 1) throw fenceConflict();
        return {
          conversationId,
          ownerToken,
          generation: fence.generation,
          state: "held",
          updatedAtMs: stamp,
        };
      }
      // A released/dead fence returns to held only by CAS on the expected
      // generation with an increment and a NEW token. The same old token
      // can never reclaim a terminal fence.
      if (fence.generation !== expectedGeneration || fence.ownerToken === ownerToken) {
        throw fenceConflict();
      }
      const next = fence.generation + 1;
      if (!Number.isSafeInteger(next)) throw generationLimit();
      authorize("live", projectId, conversationId, ownerToken, next, evidence);
      const reclaimed = tx.run(SQL_RECLAIM_FENCE, [
        ownerToken,
        next,
        stamp,
        conversationId,
        fence.generation,
        fence.ownerToken,
      ]);
      if (Number(reclaimed.changes) !== 1) throw fenceConflict();
      return {
        conversationId,
        ownerToken,
        generation: next,
        state: "held",
        updatedAtMs: stamp,
      };
    });
  }

  function settleProducer(args) {
    const { projectId, conversationId, ownerToken, generation, state, evidence } =
      requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(ownerToken, "owner token");
    validateGeneration(generation);
    validateTerminalState(state);
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      if (!tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId])) {
        throw notFound();
      }
      const current = tx.get(SQL_FENCE_BY_CONVERSATION, [conversationId]);
      if (!current) throw fenceConflict();
      const fence = parseFence(current);
      // Exact token and generation required: never rewrite a newer owner.
      if (fence.ownerToken !== ownerToken || fence.generation !== generation) {
        throw fenceConflict();
      }
      // Exact repeat of the same terminal state returns the record with an
      // unchanged timestamp, after verification.
      if (fence.state === state) {
        authorize(state, projectId, conversationId, ownerToken, generation, evidence);
        return {
          conversationId,
          ownerToken,
          generation: fence.generation,
          state: fence.state,
          updatedAtMs: fence.updatedAtMs,
        };
      }
      // Only a held fence transitions, and never dead -> released.
      if (fence.state !== "held") throw fenceConflict();
      // The host's actual proof determines release/death; storage cannot
      // manufacture it, and there is no PID/manual release authority.
      authorize(state, projectId, conversationId, ownerToken, generation, evidence);
      const settled = tx.run(SQL_SETTLE_FENCE, [
        state,
        stamp,
        conversationId,
        generation,
        ownerToken,
      ]);
      if (Number(settled.changes) !== 1) throw fenceConflict();
      return {
        conversationId,
        ownerToken,
        generation,
        state,
        updatedAtMs: stamp,
      };
    });
  }

  // At most one bound controller per conversation; refs are never inferred
  // from transcripts, turns, or requested ids. Reads need no live proof.
  function getNativeRef(args) {
    const { projectId, conversationId } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    return store.transaction((tx) => {
      const conv = tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId]);
      if (!conv) throw notFound();
      const row = tx.get(SQL_REF_BY_CONVERSATION, [conversationId, conv.controller]);
      if (!row) return null;
      return mapNativeRef(row);
    });
  }

  // Persists the REQUESTED Claude session UUID before a future launch. It
  // creates no native refs, turns, or operations, and launches nothing.
  function setRequestedClaudeSession(args) {
    const { projectId, conversationId, ownerToken, generation, sessionUuid, evidence } =
      requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(ownerToken, "owner token");
    validateGeneration(generation);
    validateUuid(sessionUuid, "native session id");
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      const conv = tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId]);
      if (!conv) throw notFound();
      const current = tx.get(SQL_FENCE_BY_CONVERSATION, [conversationId]);
      if (!current) throw fenceConflict();
      const fence = parseFence(current);
      if (
        fence.state !== "held" ||
        fence.ownerToken !== ownerToken ||
        fence.generation !== generation
      ) {
        throw fenceConflict();
      }
      if (conv.controller !== "claude") throw bindingConflict();
      const requested = conv.requested_claude_session_uuid ?? null;
      if (requested !== null) {
        // Never overwrite: the same UUID returns unchanged (no timestamp
        // touch, even when bound); a different UUID rejects.
        if (requested !== sessionUuid) throw bindingConflict();
        authorize("live", projectId, conversationId, ownerToken, generation, evidence);
        return { conversationId, projectId, requestedClaudeSessionUuid: requested };
      }
      // A bound Claude ref without a matching requested UUID is
      // inconsistent: reject rather than retrospectively invent history.
      if (tx.get(SQL_REF_BY_CONVERSATION, [conversationId, "claude"])) {
        throw bindingConflict();
      }
      authorize("live", projectId, conversationId, ownerToken, generation, evidence);
      const stored = tx.run(SQL_SET_REQUESTED_UUID, [
        sessionUuid,
        stamp,
        conversationId,
        projectId,
      ]);
      if (Number(stored.changes) !== 1) throw bindingConflict();
      return { conversationId, projectId, requestedClaudeSessionUuid: sessionUuid };
    });
  }

  // Consumes an actually observed provider identity passed by the trusted
  // host; storage does not verify provider, wire, execute, or resume. S3
  // commits the returned Codex thread ref before turn/start, or the Claude
  // observed control UUID only after a matching prelaunch request.
  function bindNativeRef(args) {
    const {
      projectId,
      conversationId,
      ownerToken,
      generation,
      controller,
      nativeThreadId = null,
      nativeSessionUuid = null,
      evidence,
    } = requireArgs(args);
    validateUuid(projectId, "project id");
    validateUuid(conversationId, "conversation id");
    validateUuid(ownerToken, "owner token");
    validateGeneration(generation);
    validateController(controller);
    validateThreadIdOrNull(nativeThreadId);
    validateSessionUuidOrNull(nativeSessionUuid);
    const stamp = resolveClock(now);
    return store.transaction((tx) => {
      const conv = tx.get(SQL_CONVERSATION_BY_KEY, [conversationId, projectId]);
      if (!conv) throw notFound();
      if (controller !== conv.controller) throw bindingConflict();
      const current = tx.get(SQL_FENCE_BY_CONVERSATION, [conversationId]);
      if (!current) throw fenceConflict();
      const fence = parseFence(current);
      if (
        fence.state !== "held" ||
        fence.ownerToken !== ownerToken ||
        fence.generation !== generation
      ) {
        throw fenceConflict();
      }
      if (controller === "codex") {
        if (nativeThreadId === null || nativeSessionUuid !== null) {
          throw bindingConflict();
        }
      } else {
        if (nativeThreadId !== null || nativeSessionUuid === null) {
          throw bindingConflict();
        }
        // The observed control UUID binds only when it exactly matches the
        // prelaunch request; an absent or mismatched request rejects.
        if ((conv.requested_claude_session_uuid ?? null) !== nativeSessionUuid) {
          throw bindingConflict();
        }
      }
      const existing = tx.get(SQL_REF_BY_CONVERSATION, [conversationId, controller]);
      if (existing) {
        // An identical ref returns the original record with its original
        // created timestamp; a different ref, controller, or id rejects and
        // is never replaced or unbound.
        const identical =
          controller === "codex"
            ? existing.native_thread_id === nativeThreadId
            : existing.native_session_uuid === nativeSessionUuid;
        if (!identical) throw bindingConflict();
        authorize("live", projectId, conversationId, ownerToken, generation, evidence);
        return mapNativeRef(existing);
      }
      // Globally unique native ids across conversations, enforced by
      // precheck plus the schema unique indexes. The precheck reports the
      // conflict without leaking the other owner.
      const collision =
        controller === "codex"
          ? tx.get(SQL_THREAD_OWNER, [nativeThreadId])
          : tx.get(SQL_SESSION_OWNER, [nativeSessionUuid]);
      if (collision) throw bindingConflict();
      authorize("live", projectId, conversationId, ownerToken, generation, evidence);
      tx.run(SQL_INSERT_REF, [
        conversationId,
        projectId,
        controller,
        nativeThreadId,
        nativeSessionUuid,
        stamp,
      ]);
      // A successful bind inserts native_refs only: modelRequested,
      // modelReported, servedVerified, role, effort, controller, and turn
      // states are untouched. No reported/served identity is fabricated.
      return {
        conversationId,
        projectId,
        controller,
        nativeThreadId,
        nativeSessionUuid,
        createdAtMs: stamp,
      };
    });
  }

  return Object.freeze({
    getProducer,
    claimProducer,
    settleProducer,
    getNativeRef,
    setRequestedClaudeSession,
    bindNativeRef,
  });
}
