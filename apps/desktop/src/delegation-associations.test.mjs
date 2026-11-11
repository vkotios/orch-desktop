import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDelegationAssociations } from "../server/delegation-associations.mjs";

describe("delegation associations", () => {
  it("persist recoverable stages and dispositions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cho-delegations-"));
    const filePath = path.join(dir, "delegations.json");
    const store = createDelegationAssociations({ filePath, now: () => 1_700_000_000_000 });

    const created = store.upsert({
      repoPath: "C:/proj",
      wp: "cho-05",
      slice: "delegate",
      stage: "claimed",
      conversationId: "11111111-1111-1111-1111-111111111111",
    });
    expect(created.stage).toBe("claimed");
    expect(created.disposition).toBe("none");

    const worktree = store.upsert({
      id: created.id,
      stage: "worktree",
      worktreePath: "C:/proj/.orch/wt",
    });
    expect(worktree.worktreePath).toBe("C:/proj/.orch/wt");

    const running = store.upsert({
      id: created.id,
      stage: "running",
      runId: "run-1",
    });
    expect(running.runId).toBe("run-1");

    const accepted = store.setDisposition(created.id, "accepted", "no git");
    expect(accepted.disposition).toBe("accepted");
    expect(accepted.stage).toBe("recorded");

    const listed = store.list({ repoPath: "C:/proj", includeTerminal: true });
    expect(listed).toHaveLength(1);
    expect(listed[0].disposition).toBe("accepted");

    const integrated = store.setDisposition(created.id, "integrated", "host recorded Git merge");
    expect(integrated.disposition).toBe("integrated");
    const finished = store.setDisposition(created.id, "finished", "orch finish after Git merge");
    expect(finished.disposition).toBe("finished");
    expect(() => store.setDisposition(created.id, "discarded")).toThrow(/cannot move/);

    const reopened = createDelegationAssociations({ filePath });
    expect(reopened.get(created.id)?.runId).toBe("run-1");
  });
});
