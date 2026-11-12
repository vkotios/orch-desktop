# R1–R10 correction recheck — 25b25a4

Date: 2026-11-06, Europe/London. Reviewer: Codex controller.
Candidate: `25b25a4`, clean source tree at start. Compared with `1495d74` and the
assigned completion instruction. No application-source changes were made.

## Decision

Useful corrections landed, but **R1–R10 are not all resolved**. Keep the completion
task active. Four current functional defects are detailed below. Prior-owner
recovery, full pagination/export, rendered journeys, current artifact rebuild and
qualification remain implementation/acceptance work, not completed repairs.

## Outstanding defects

### B1 — P1: integration hooks do not consume the actual coordinator APIs

`apps/desktop/server/host.mjs:453-486` adds hooks that pass the integration module's
unit tests with mocked `{terminal:true, converged:true, clean:true}` objects, but
the production bridge has different contracts:

- `getOrchRunDetail` (`bridge.mjs:1315`) returns `status` as an object. Host converts
  that object to a string instead of reading `detail.status.status`/the actual
  derived status. A completed run is treated as nonterminal.
- `orch_gate_status` requires both work package and slice (`gate.mjs`, gateStatus).
  The hook supplies only `wp`. The real response uses `output.decision ===
  'converged'`, not the `converged`/`status` fields the hook checks.
- `inspectReview` invokes `orch_review`, which is **review launch**, not a read of
  finished containment evidence (`bridge.mjs`, launchOrchReview). It lacks the
  required launch arguments and does not establish an existing review's result.

**Reproduced through runHost with injected responses in the real bridge shapes:**
a completed status object gives `Refuse integrate while the recorded run is not
terminal`; a converged gate response gives `Integrate requires a converged orch
gate`. No real reviewer or worker was launched. These are adapter-wiring failures,
not evidence that the actual run/gate failed. Source inspection establishes the
review-launch/read confusion; that command was not executed against real state.

Use read-only coordinator evidence, pass the slice, parse the actual return types,
and bind the finished review/gate/verification to the run and exact source SHA.
Add a host→bridge-shape integration test rather than testing only abstract hooks.
R3 remains open; R4's stale-SHA check is a useful separate improvement.

### B2 — P2: replay duplicates live text when more than one live chunk exists

`native-chat-state.ts:338-359` still uses text equality as an identity fallback:
it skips a durable part only when the *entire* current assistant text equals that
one part and no durable parts have been recorded. Real live events still lack the
persisted part ID (`native-chat.mjs`, the Codex/Claude message-delta enqueue paths).

**Reproduced:** live `a`, live `b`, durable part A `a`, durable part B `b`, durable
completion produces **`abab`**, expected **`ab`**. The single-live-part regression
case passes but does not establish general replay correctness. This is also an
ordinary catch-up duplication case, not only a lost-response scenario.

Propagate the same stable part identity/sequence on live and durable delivery and
reconcile each fact once. Preserve ordering and legitimate identical-text parts;
do not expand text-content deduplication. R6 remains open (RUN-02/04).

### B3 — P2: imported snapshot is rejected by the event store before hydration

`native-session-persistence.mjs:801` inserts an arbitrary imported-transcript row
in `snapshots` with `last_seq = 0`, without an event stream. Hydration first calls
`events.pollEvents`, whose integrity rules reject any snapshot when tip is zero
(`session-events.mjs:675-684`); its canonical snapshot schema also differs from this
new JSON shape. The fallback at `native-session-persistence.mjs:925` is never reached.

**Reproduced:** import a two-message transcript successfully, then hydrate it.
Result: **`ERR_STORAGE: session event stored data is unreadable`**. Normal producer
admission also reads the snapshot and will encounter the same invariant violation.

Use supported immutable import/body/projection storage with atomic receipts and
explicit bounds, or design a consistent event-backed import format. Do not globally
disable snapshot integrity checks to accommodate an unrelated payload. R7 remains
open; moving the JSON out of the draft did not establish readable imported history.

### B4 — P2: reconciliation labels even the current host as a prior owner

`reconcileStrandedTurns` compares `meta.hostGeneration` with the stored operation
at `native-session-persistence.mjs:1436`, but `ensureConversation`'s cached meta
object (`:408-420`) never defines `hostGeneration`. That comparison always fails.

**Reproduced in one persistence instance:** queue/dispatch a turn, call reconciliation
without changing host or producer. It returns no settlements and one unresolved
entry claiming prior-host provenance, although the operation belongs to this host.

Separately, `native-chat.mjs:878,905` assigns `state.recoveryNotice` but never returns
or displays it. Returning unresolved rows from the storage facade is therefore not
a complete product-visible recovery path. Preserve the explicit no-adoption rule,
fix current-owner comparison, and finish the separately acknowledged S5 prior-owner
recovery operation/UI. R5 is partial, not resolved.

## R1–R10 disposition

| Finding | Recheck |
| --- | --- |
| R1 packaging | Addressed in source for the missing server import closure: 29 modules, no missing relative server imports in a static scan; new staged-host import test passes. Current durable/delegation staged journeys and installer rebuild/rehash remain open. |
| R2 migration overwrite | Original stale-file restore removed; SQLite VACUUM INTO backup and rollback are meaningful improvements. Full crash/concurrent-writer/migration qualification remains. The new file migration lock has no dead-owner recovery, so crash-left locks need an explicit safe recovery path. |
| R3 integration evidence | Not resolved: B1. Also bind review to actual run/slice/commit, not just work package. |
| R4 preview binding | Original source/target SHA stale-preview case is covered by the passing integration unit test; source SHA is used for merge. Real host wiring, process state, mutation serialization and post-merge receipt recovery still need end-to-end validation. |
| R5 stranded recovery | Partial: B4 and acknowledged unfinished S5. Do not label reporting unresolved rows as completed recovery. |
| R6 replay | Not resolved: B2. |
| R7 import | Not resolved: B3; full paging/export and import UI remain open. |
| R8 committed diff | Source now reads committed branch changes and full patch. Dirty/untracked overlay remains incomplete because the normal merge-base path omits it. Qualify both committed and in-progress worker changes. |
| R9 admission | The specific renderer-supplied worktree/run injection is now rejected/stripped and host records orch success. Prepared-project/conversation/approved-route binding, immutable scope/resource identity and existing-resource reconciliation still require qualification; do not call all ORCH-09 complete. |
| R10 conflict filter | Exact enum comparison corrected in both UI sites. Rendered conflict resolution and close/last-keystroke lifecycle still need consumer tests. |

## Validation and evidence limits

- Root `npm test`: shared **44 passed**; desktop **744 passed, 1 timed out** (745
  total). The failing case was runtime-preparation output replacement at its 5 s
  limit under parallel suite load.
- Reran **only** `src/runtime-preparation.test.ts`, unchanged limits: **11/11 pass**,
  replacement case 317 ms, new real staged-host import case 465 ms. Do not claim an
  all-green full-suite run from this recheck; do not label the timing failure as
  a reproduced packaging functional defect.
- Type checking and web production build pass.
- No new Cargo/installer/live-provider/clean-machine run in this correction recheck.
  The user-reported 12 Rust passes were not rerun here; they are not proof of the
  JavaScript/host consumer behavior above.
- Probes used isolated SQLite/liveness files and an injected host dispatcher; no
  provider was called and no real Git mutation was performed in this recheck.
- Evidence: `.reviews/cursor-review-20261105/25b25a4-tests.log`,
  `25b25a4-probes.json`, `25b25a4-integration-hooks.json`.

## Direction to Cursor

Continue under the existing completion instruction. Fix B1–B4 with tests that
exercise actual producer/store/host/bridge/consumer contracts, then finish the
explicitly listed implementation gaps. Keep rebuilt-artifact and real qualification
evidence tied to their exact candidate. The corrected "locally checked" vocabulary
is appropriate; update the R1–R10 rows to reflect these failed acceptance cases.
