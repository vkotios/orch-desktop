import { describe, expect, it } from "vitest";
import {
  deriveGateInspection,
  deriveReviewInspection,
  deriveRunInspection,
} from "../server/delegation-integrate-evidence.mjs";
describe("delegation integrate evidence adapters (real bridge shapes)", () => {
  it("treats a completed status object as terminal", () => {
    // getOrchRunDetail returns status as an object, not a string.
    const detail = {
      ok: true,
      status: { status: "completed", derived_status: "completed", age_s: 12 },
    };
    expect(deriveRunInspection(detail)).toMatchObject({
      ok: true,
      terminal: true,
      status: "completed",
    });
  });

  it("does not treat a stringified status object as terminal", () => {
    // Regression: String({status:'completed'}) === '[object Object]'.
    const bogus = { ok: true, status: { status: "completed" } };
    const asString = String(bogus.status).toLowerCase();
    expect(asString).toBe("[object object]");
    expect(deriveRunInspection(bogus).terminal).toBe(true);
  });

  it("reads gate convergence from decision === converged", () => {
    const gate = {
      ok: true,
      output: { decision: "converged", wp: "cho-05", slice: "delegate" },
      text: "gate converged",
    };
    expect(deriveGateInspection(gate)).toMatchObject({
      ok: true,
      converged: true,
      decision: "converged",
    });
    expect(deriveGateInspection({ ok: true, output: { decision: "open" } }).converged).toBe(false);
  });

  it("requires exact run match with outcome reviewed and clean containment", () => {
    const evidence = {
      ok: true,
      reviews: [
        {
          id: "rev-other",
          wp: "cho-05",
          implementer_run: "other-run",
          containment: "clean",
          outcome: "not-reviewed",
          finished_at: "2026-11-06T10:00:00Z",
        },
        {
          id: "rev-1",
          wp: "cho-05",
          slice: "delegate",
          implementer_run: "required-run",
          containment: "clean",
          outcome: "reviewed",
          finished_at: "2026-11-06T10:00:00Z",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    };
    // Unrelated clean containment must not satisfy another run.
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(
      deriveReviewInspection(evidence, { wp: "cho-05", runId: "required-run", sourceSha: sha }),
    ).toMatchObject({ ok: true, clean: true, reviewId: "rev-1" });
    // Earlier reviewed commit must not authorize a later unreviewed source SHA.
    expect(
      deriveReviewInspection(evidence, {
        wp: "cho-05",
        runId: "required-run",
        sourceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toMatchObject({ ok: true, clean: false });
    expect(
      deriveReviewInspection(evidence, { wp: "cho-05", runId: "required-run" }),
    ).toMatchObject({ ok: true, clean: false });
    expect(
      deriveReviewInspection(
        { ok: true, reviews: [evidence.reviews[0]] },
        { wp: "cho-05", runId: "required-run", sourceSha: sha },
      ),
    ).toMatchObject({ ok: true, clean: false });
    expect(
      deriveReviewInspection(
        { ok: true, reviews: [{ ...evidence.reviews[1], outcome: "not-reviewed" }] },
        { wp: "cho-05", runId: "required-run", sourceSha: sha },
      ),
    ).toMatchObject({ ok: true, clean: false });
    expect(
      deriveReviewInspection({ ok: true, reviews: [] }, { wp: "cho-05", runId: "required-run", sourceSha: sha }),
    ).toMatchObject({ ok: true, clean: false });
    expect(
      deriveReviewInspection(evidence, { wp: "cho-05" }),
    ).toMatchObject({ ok: true, clean: false });
  });

  it("host-shaped review adapter requires Git-resolved sourceSha", () => {
    const evidence = {
      ok: true,
      reviews: [
        {
          id: "rev-1",
          wp: "cho-05",
          slice: "delegate",
          implementer_run: "run-1",
          containment: "clean",
          outcome: "reviewed",
          finished_at: "2026-11-06T10:00:00Z",
          commit: "cccccccccccccccccccccccccccccccccccccccc",
        },
      ],
    };
    expect(
      deriveReviewInspection(evidence, {
        wp: "cho-05",
        runId: "run-1",
        sourceSha: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toMatchObject({ ok: true, clean: true });
    // Association-field absence (null) must not accept the review.
    expect(
      deriveReviewInspection(evidence, { wp: "cho-05", runId: "run-1", sourceSha: null }),
    ).toMatchObject({ ok: true, clean: false });
  });

  it("does not treat a stringified status object as terminal (broken host path)", () => {
    const detail = { ok: true, status: { status: "completed" } };
    const broken = {
      ok: true,
      terminal: String(detail.status) === "completed",
      text: String(detail.status),
    };
    expect(broken.terminal).toBe(false);
    expect(deriveRunInspection(detail).terminal).toBe(true);
  });
});
