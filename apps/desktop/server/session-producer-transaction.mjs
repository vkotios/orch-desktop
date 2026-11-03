// CHO-03 S2c producer transaction authorization helper.
//
// Small INTERNAL helper for the S2c turn writers (`session-turns.mjs`).
// It authorizes one live-owner mutation inside the SAME S1 scoped
// transaction that performs the mutation: project/conversation binding,
// current `producer_fences` row held by the exact owner token/generation,
// and the injected trusted synchronous `verifyOwnerEvidence` callback.
//
// Facts passed to the verifier are frozen:
// { action: 'live', projectId, conversationId, ownerToken,
//   generation: ownerGeneration, hostGeneration, evidence }.
// `hostGeneration` is provenance (a UUID supplied by the host), distinct
// from the `ownerGeneration` fence counter. This module never binds it to
// process identity itself; the future host verifier MUST bind it to the
// token/process identity. Only a strictly `true` return authorizes.
// False, non-boolean, throwing, or thenable results reject with
// ERR_OWNER_UNVERIFIED (static message, never echoing evidence or the
// callback exception). A rejected async result is consumed so no unhandled
// rejection escapes, but a thenable NEVER authorizes.
//
// The callback evaluates already-obtained facts only: no SQL, IPC, or
// provider side effects inside the DB transaction. Evidence is passed
// through opaquely: never serialized, logged, or stored. There is no
// permissive default verifier. This is not an IPC/SQL endpoint, and it
// never reads a fence in one transaction to authorize a write in another.
// It does not refactor the existing S2b scope.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function txError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const invalid = (detail) =>
  txError(
    "ERR_INVALID_RECORD",
    `session producer transaction input is invalid (${detail})`
  );
const notFound = () =>
  txError("ERR_NOT_FOUND", "session producer transaction target not found");
const fenceConflict = () =>
  txError("ERR_FENCE_CONFLICT", "session producer fence conflict");
const ownerUnverified = () =>
  txError(
    "ERR_OWNER_UNVERIFIED",
    "session producer ownership is not verified"
  );
const malformedFence = () =>
  txError("ERR_STORAGE", "session producer stored fence is unreadable");

function requireScope(scope) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw invalid("scope");
  }
  return scope;
}

function validateUuid(value, detail) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw invalid(detail);
  }
}

function validateGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("owner generation");
  }
}

// A stored fence with a bad token/generation/state/timestamp is corruption:
// fail ERR_STORAGE rather than authorizing against it.
function parseFence(row) {
  if (
    !row ||
    typeof row !== "object" ||
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
    ownerToken: row.owner_token,
    generation: row.generation,
    state: row.state,
    updatedAtMs: row.updated_ms,
  };
}

// Static SQL only: every dynamic value travels as a bound parameter.
const SQL_CONVERSATION_BY_KEY =
  "SELECT id, project_id FROM conversations WHERE id = ? AND project_id = ?";
const SQL_FENCE_BY_CONVERSATION =
  "SELECT conversation_id, owner_token, generation, state, updated_ms FROM producer_fences WHERE conversation_id = ?";

export function createProducerAuthorizer(options) {
  const settings = options ?? null;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw invalid("factory arguments");
  }
  const { verifyOwnerEvidence } = settings;
  // No permissive default verifier: the host callback must be explicitly
  // provided. A boolean from UI is never accepted as auth.
  if (typeof verifyOwnerEvidence !== "function") {
    throw invalid("owner verifier");
  }

  // Authorize one mutation inside the caller's scoped transaction `tx`.
  // Reads the conversation binding and the current fence through `tx`,
  // evaluates proof, and returns the held fence on success. Throws
  // ERR_NOT_FOUND / ERR_FENCE_CONFLICT / ERR_OWNER_UNVERIFIED /
  // ERR_STORAGE; S1 transaction misuse errors propagate untouched.
  function authorizeLiveWrite(tx, scope) {
    if (tx === null || typeof tx !== "object" || typeof tx.get !== "function") {
      throw invalid("transaction");
    }
    const s = requireScope(scope);
    validateUuid(s.projectId, "project id");
    validateUuid(s.conversationId, "conversation id");
    validateUuid(s.ownerToken, "owner token");
    validateGeneration(s.ownerGeneration);
    validateUuid(s.hostGeneration, "host generation");
    if (!tx.get(SQL_CONVERSATION_BY_KEY, [s.conversationId, s.projectId])) {
      throw notFound();
    }
    const fenceRow = tx.get(SQL_FENCE_BY_CONVERSATION, [s.conversationId]);
    if (!fenceRow) throw fenceConflict();
    const fence = parseFence(fenceRow);
    if (
      fence.state !== "held" ||
      fence.ownerToken !== s.ownerToken ||
      fence.generation !== s.ownerGeneration
    ) {
      throw fenceConflict();
    }
    const facts = Object.freeze({
      action: "live",
      projectId: s.projectId,
      conversationId: s.conversationId,
      ownerToken: s.ownerToken,
      generation: s.ownerGeneration,
      hostGeneration: s.hostGeneration,
      evidence: s.evidence,
    });
    let result;
    try {
      result = verifyOwnerEvidence(facts);
    } catch {
      throw ownerUnverified();
    }
    if (result === true) {
      return {
        projectId: s.projectId,
        conversationId: s.conversationId,
        ownerToken: s.ownerToken,
        generation: s.ownerGeneration,
        hostGeneration: s.hostGeneration,
      };
    }
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

  return Object.freeze({ authorizeLiveWrite });
}
