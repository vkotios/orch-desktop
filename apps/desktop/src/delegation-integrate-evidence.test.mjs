import { describe, expect, it } from "vitest";
import {
  deriveGateInspection,
  deriveReviewInspection,
  deriveRunInspection,
} from "../server/delegation-integrate-evidence.mjs";
import { integrateAssociationWorktree } from "../server/delegation-integrate.mjs";

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

  it("matches finished clean review evidence by run/wp", () => {
    const evidence = {
      ok: true,
      reviews: [
        {
          id: "rev-1",
          wp: "cho-05",
          implementer_run: "run-1",
          containment: "clean",
          finished_at: "2026-11-06T10:00:00Z",
        },
      ],
    };
    expect(
      deriveReviewInspection(evidence, { wp: "cho-05", runId: "run-1" }),
    ).toMatchObject({ ok: true, clean: true, reviewId: "rev-1" });
    expect(
      deriveReviewInspection({ ok: true, reviews: [] }, { wp: "cho-05" }),
    ).toMatchObject({ ok: true, clean: false });
  });

  it("host-shaped hooks accept real bridge payloads end-to-end", async () => {
    const association = {
      id: "assoc-bridge",
      disposition: "accepted",
      stage: "recorded",
      repoPath: "/x",
      worktreePath: "/x/wt",
      wp: "cho-05",
      slice: "delegate",
      runId: "run-1",
      reviewId: "rev-1",
    };
    const calls = [];
    const hooks = {
      inspectRun: async (runId) => {
        calls.push(["run", runId]);
        return deriveRunInspection({
          ok: true,
          status: { status: "completed", derived_status: "completed" },
        });
      },
      inspectGate: async (assoc) => {
        calls.push(["gate", assoc.wp, assoc.slice]);
        return deriveGateInspection({
          ok: true,
          output: { decision: "converged", wp: assoc.wp, slice: assoc.slice },
        });
      },
      inspectReview: async (assoc) => {
        calls.push(["review", assoc.wp, assoc.runId]);
        return deriveReviewInspection(
          {
            ok: true,
            reviews: [
              {
                id: "rev-1",
                wp: assoc.wp,
                implementer_run: assoc.runId,
                containment: "clean",
                finished_at: "2026-11-06T10:00:00Z",
              },
            ],
          },
          { wp: assoc.wp, runId: assoc.runId, reviewId: assoc.reviewId },
        );
      },
    };
    // Fail before git so we only exercise adapter wiring.
    await expect(
      integrateAssociationWorktree(
        { get: () => association, setDisposition: () => association },
        { id: "assoc-bridge", dryRun: true },
        hooks,
      ),
    ).rejects.toThrow(/worktree path does not exist|does not exist/);
    expect(calls).toEqual([
      ["run", "run-1"],
      ["gate", "cho-05", "delegate"],
      ["review", "cho-05", "run-1"],
    ]);
  });

  it("refuses integrate when completed status is mis-read as nonterminal", async () => {
    // Reproduce B1: treating status object as nonterminal via String().
    const association = {
      id: "assoc-bad",
      disposition: "accepted",
      stage: "recorded",
      repoPath: "/x",
      worktreePath: "/x/wt",
      wp: "cho-05",
      slice: "delegate",
      runId: "run-1",
    };
    await expect(
      integrateAssociationWorktree(
        { get: () => association, setDisposition: () => association },
        { id: "assoc-bad", dryRun: true },
        {
          inspectRun: async () => {
            const detail = { ok: true, status: { status: "completed" } };
            // Broken host: stringify the object.
            const status = String(detail.status);
            return { ok: true, terminal: status === "completed", text: status };
          },
          inspectGate: async () => ({ ok: true, converged: true }),
          inspectReview: async () => ({ ok: true, clean: true }),
        },
      ),
    ).rejects.toThrow(/recorded run is not terminal/);
  });
});
