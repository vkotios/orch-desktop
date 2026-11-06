// Pure adapters from real bridge/orch return shapes to integrate gates.
// Keep host wiring thin and unit-testable without launching workers/reviewers.

const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'interrupted',
  'blocked',
  'blocked-quota',
  'turn-cap',
  'finished',
  'unknown',
]);

/** Successful orch review outcome — containment alone is not enough. */
const SUCCESSFUL_REVIEW_OUTCOMES = new Set(['reviewed']);

function unwrap(detail) {
  if (!detail || typeof detail !== 'object') return null;
  // execOrchTool shape: { ok, output, text }; getOrchRunDetail is bare.
  if (detail.output && typeof detail.output === 'object' && !Array.isArray(detail.output)) {
    return detail.output;
  }
  return detail;
}

/**
 * getOrchRunDetail returns `{ status: statusObj }` where statusObj.status is the
 * run status string (sometimes annotated). Never stringify the whole object.
 */
export function deriveRunInspection(detail) {
  const body = unwrap(detail) || detail;
  const statusObj =
    body && typeof body.status === 'object' && body.status !== null && !Array.isArray(body.status)
      ? body.status
      : null;
  const raw =
    (statusObj && typeof statusObj.status === 'string' && statusObj.status) ||
    (statusObj && typeof statusObj.derived_status === 'string' && statusObj.derived_status) ||
    (typeof body?.status === 'string' ? body.status : null) ||
    '';
  const normalized = String(raw).replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  const terminal = TERMINAL.has(normalized);
  const ok = detail?.ok !== false && !detail?.error && body != null;
  return {
    ok,
    terminal,
    status: normalized || null,
    text: detail?.text || detail?.error || '',
  };
}

/**
 * orch_gate_status via execOrchTool returns `{ ok, output: { decision, ... } }`.
 * Convergence is `decision === 'converged'`.
 */
export function deriveGateInspection(gateResult) {
  const body = unwrap(gateResult) || gateResult;
  const decision = typeof body?.decision === 'string' ? body.decision : null;
  const converged = decision === 'converged';
  const ok = gateResult?.ok !== false && !gateResult?.error && body != null;
  return {
    ok,
    converged,
    decision,
    text: gateResult?.text || gateResult?.error || body?.reason || '',
  };
}

function reviewMatchesRun(review, runId) {
  return (
    review?.implementer_run === runId ||
    review?.run_id === runId ||
    review?.review_of === runId
  );
}

function reviewCommit(review) {
  if (typeof review?.commit === 'string' && review.commit.length > 0) return review.commit;
  if (typeof review?.ref === 'string' && /^[0-9a-f]{40}$/i.test(review.ref)) return review.ref;
  return null;
}

/**
 * Read-only finished review evidence (not review launch).
 * Requires an exact match on reviewId and/or implementer runId — never falls
 * back to another run's clean-containment review. Containment alone is not
 * success; outcome must be the coordinator's successful `reviewed`.
 */
export function deriveReviewInspection(
  evidence,
  { wp, runId = null, reviewId = null, slice = null, sourceSha = null } = {},
) {
  const list = Array.isArray(evidence?.reviews)
    ? evidence.reviews
    : Array.isArray(evidence)
      ? evidence
      : [];
  const ok = evidence?.ok !== false && !evidence?.error;
  if (!ok) {
    return { ok: false, clean: false, text: evidence?.text || evidence?.error || 'review evidence unavailable' };
  }
  if (!runId && !reviewId) {
    return {
      ok: true,
      clean: false,
      text: 'Integrate requires review evidence bound to a specific run or review id',
    };
  }
  if (typeof sourceSha !== 'string' || sourceSha.length === 0) {
    return {
      ok: true,
      clean: false,
      text: 'Integrate requires the Git-resolved candidate source SHA for review binding',
    };
  }

  const forWp = list.filter((r) => !wp || r?.wp === wp);
  let candidates = forWp;
  if (reviewId) {
    candidates = candidates.filter((r) => r?.id === reviewId || r?.review_id === reviewId);
  }
  if (runId) {
    candidates = candidates.filter((r) => reviewMatchesRun(r, runId));
  }
  if (typeof slice === 'string' && slice.length > 0) {
    candidates = candidates.filter((r) => r?.slice == null || r.slice === slice);
  }
  if (typeof sourceSha === 'string' && sourceSha.length > 0) {
    const want = sourceSha.toLowerCase();
    candidates = candidates.filter((r) => {
      const commit = reviewCommit(r);
      return commit != null && commit.toLowerCase() === want;
    });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      clean: false,
      text: `No exact review evidence for ${runId ? `run ${runId}` : `review ${reviewId}`}${wp ? ` in ${wp}` : ''}`,
    };
  }

  const match = candidates.find((r) => {
    const finished = Boolean(r?.finished_at);
    const successful = SUCCESSFUL_REVIEW_OUTCOMES.has(r?.outcome);
    const contained = r?.containment === 'clean';
    return finished && successful && contained;
  });

  if (!match) {
    const sample = candidates[0];
    return {
      ok: true,
      clean: false,
      reviewId: sample?.id || sample?.review_id || null,
      implementerRun: sample?.implementer_run || sample?.run_id || null,
      containment: sample?.containment || null,
      outcome: sample?.outcome || null,
      text: `Review evidence for ${runId || reviewId} is not a successful clean review (outcome=${sample?.outcome || 'missing'}, containment=${sample?.containment || 'missing'})`,
    };
  }

  return {
    ok: true,
    clean: true,
    reviewId: match.id || match.review_id || null,
    implementerRun: match.implementer_run || match.run_id || null,
    containment: match.containment,
    outcome: match.outcome,
    commit: reviewCommit(match),
    text: `Review ${match.id || match.review_id} outcome reviewed, containment clean`,
  };
}
