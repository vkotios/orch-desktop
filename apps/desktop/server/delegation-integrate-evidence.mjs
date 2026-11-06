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

/**
 * Read-only finished review evidence (not review launch). Prefer matching
 * reviewId / implementer run, then any finished clean review for the WP.
 */
export function deriveReviewInspection(evidence, { wp, runId = null, reviewId = null } = {}) {
  const list = Array.isArray(evidence?.reviews)
    ? evidence.reviews
    : Array.isArray(evidence)
      ? evidence
      : [];
  const ok = evidence?.ok !== false && !evidence?.error;
  if (!ok) {
    return { ok: false, clean: false, text: evidence?.text || evidence?.error || 'review evidence unavailable' };
  }
  const forWp = list.filter((r) => !wp || r?.wp === wp);
  let match = null;
  if (reviewId) {
    match = forWp.find((r) => r?.id === reviewId || r?.review_id === reviewId) || null;
  }
  if (!match && runId) {
    match = forWp.find(
      (r) => r?.implementer_run === runId || r?.run_id === runId || r?.review_of === runId,
    ) || null;
  }
  if (!match) {
    match = forWp.find((r) => r?.finished_at && r?.containment === 'clean') || null;
  }
  if (!match) {
    return {
      ok: true,
      clean: false,
      text: `No finished clean review evidence for work package ${wp || '(unknown)'}`,
    };
  }
  const clean = Boolean(match.finished_at) && match.containment === 'clean';
  return {
    ok: true,
    clean,
    reviewId: match.id || match.review_id || null,
    implementerRun: match.implementer_run || match.run_id || null,
    containment: match.containment || null,
    text: clean
      ? `Review ${match.id || match.review_id} containment clean`
      : `Review ${match.id || match.review_id} containment=${match.containment || 'unknown'}`,
  };
}
