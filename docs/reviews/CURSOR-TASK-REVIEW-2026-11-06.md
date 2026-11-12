# Review of Cursor's completion work against its assigned task

Date: 2026-11-06, Europe/London. Reviewer: Codex controller.
Reviewed source: `1495d743c3e5f2aaa80664c83b12add54e2794f7`.
Range: `76076fb..1495d74`, including the original recovery batch and the later
permissions, integration, Markdown, pagination, migration and release changes.
Task: `docs/CURSOR_COMPLETION_INSTRUCTIONS.md`, the amended implementation plan,
product spec and the earlier Sonnet report with controller addendum.

## Verdict

Substantial implementation has landed, and the current source checks pass. The
task is **partially fulfilled**, not complete. Several advertised repairs still
fail deterministic recovery scenarios; the new Git/migration paths have correctness
and authorization gaps; and the packaging allowlist does not include the current
host's dependencies. Continue implementation before declaring M2/M3 or the release
candidate ready. Rebuilding an installer is insufficient until its runtime closure
is corrected and exercised independently of the checkout.

This is a source/task review with focused executable probes, not an installed-app,
live-provider or clean-machine qualification. It does not authorize fixes, pushes
or publication. Application source was not modified during review.

## Prioritized findings

### R1 — P1: native packaging omits required host modules

`apps/desktop/scripts/prepare-runtime.mjs:19,219` still copies only eleven server
modules. It excludes `delegation-integrate.mjs`, `delegation-associations.mjs`,
`native-session-persistence.mjs`, `session-store-migrate.mjs` and the session-store
dependency graph. Current `host.mjs:14` statically imports the integration module;
the association and persistence imports are also outside the allowlist.

**Confirmed:** importing a fresh copied current host with the included protocol
module fails with `ERR_MODULE_NOT_FOUND` for `delegation-integrate.mjs`. The existing
`.runtime/app` has an older host and lacks the persistence/integration/migration
modules. Re-running the unchanged staging script still omits them. The twelve Rust
tests do not check this JavaScript import closure.

Correct the narrowly scoped resource/dependency closure, test loading the *staged*
host and exercising durable/delegation commands without source-tree fallback, then
rebuild and rehash artifacts. Requirements: CHO-02/07, ARCH-01–04, AC-01/14/15.

### R2 — P1: migration failure can erase another writer's committed data

`session-store-migrate.mjs:30-35,89,116,152` copies database/WAL/SHM files before
acquiring a migration transaction, then restores those older files after failure.
There is no exclusive application/migration ownership covering backup through
restore. WAL snapshots are copied as separate files, not a consistent SQLite backup.
The facade invokes this on every reopen, including current-version databases
(`native-session-persistence.mjs:205-208`).

**Confirmed with controlled interleaving:** use the migration test's failing v1
schema fixture; commit a project row from a second SQLite connection immediately
after backup, before migration starts. Migration fails and restores its backup;
the committed project row disappears. This is a deterministic failure/interleaving
probe, not an observed incident involving user data.

Establish exclusive migration ownership, use a SQLite-consistent backup, validate
the actual schema/integrity, and never overwrite a live database after releasing
its ownership. Preserve concurrent committed data and the original on refusal.
Requirements: safe upgrade/migration, CHO-03/07, AC-13.

### R3 — P1: Integrate bypasses verification/review and process-state gates

`delegation-integrate.mjs:53-58,121-127` accepts a local `accepted` disposition and a
non-running *association stage*, then merges directly. It never checks the actual
run's process state, scoped verification, independent review or converged gate.
`delegation-associations.mjs` turns acceptance into stage `recorded`; an association
stage is therefore not independent evidence that its worker stopped. Existing orch
finish guards are irrelevant because integration never calls them.

**Confirmed:** the integration probe merged a synthetic worker branch with no
coordinator review/gate receipts at all. `delegation_set_disposition` also accepts
local acceptance without proving those receipts. This does not demonstrate killing
or deleting active work; existing orch cleanup safeguards remain intact.

Before Git mutation, recheck recorded resource ownership, terminal/owned-process
state, verification, review containment/convergence and the reviewed commit.
Acceptance alone must not become an execution authorization. Requirements:
ORCH-02/04/05/07/09, CHO-05, AC-08/09.

### R4 — P1: integration confirmation is not bound to the previewed commits/target

`delegation-integrate.mjs:86-127` previews branch names/counts, but apply accepts
only the association ID and re-resolves mutable branch names/current HEAD. The UI
passes no expected source SHA, target SHA or target branch from its confirmation
(`OrchAgentsPanel.tsx`, `onIntegrate`; `agent-task.ts:408`).

**Confirmed:** preview a branch containing one commit, add a second commit after
preview, then apply. Both commits are merged, including a file absent from the
confirmed preview. Switching the target checkout between preview and apply can
similarly change the destination. A clean worktree check does not bind either ref.

Return and validate an exact preview token/source SHA/target branch and SHA; refuse
changed resources and require a refreshed preview. Serialize the rechecks with the
mutation. Also make Git success followed by association-write failure recoverable,
without reinterpreting a second mutable-branch merge as the same operation.
Requirements: explicit controlled integration, ORCH-07, CHO-05, AC-09.

### R5 — P2: reopen reconciliation cannot settle the previous host's dispatch

`native-session-persistence.mjs:1350-1402` claims a new producer and calls normal
`settleTurn` for an old operation, then swallows every error. The turn API explicitly
requires the operation's original owner/host provenance (`session-turns.mjs:712-723`).
The new producer generation/host cannot pass that check.

**Confirmed:** queue/dispatch a turn, release the old producer and reopen with a new
host generation. `reconcileStrandedTurns` returns `[]`; the operation remains
`dispatching`, outcome NULL. An explicit settlement attempt gives
`ERR_FENCE_CONFLICT`. This fails even with permissive synthetic owner verification,
so it is not a live-process permissions limitation.

Implement a deliberate recovery transition/projection consistent with verified
old-owner state. Do not disable provenance checks or adopt/replay old execution.
Surface unresolved recovery instead of silently suppressing it. Requirements:
CHO-03 A/F-08, SESSION-03, RUN-04/07.

### R6 — P2: durable replay still loses text after any live progress

`native-chat-state.ts:281-287` rejects all durable text whenever
`session.liveTurnProgress` is true, and that flag lasts for the turn. A successful
early live poll therefore prevents recovery of a later lost response. Durable
completion can still finish the turn and make the missing text unreachable to the
reducer. `cmdPoll` withholding/cursor handling does not repair this consumer rule.

**Confirmed:** apply live `first`; replay durable `first`, durable `second`, then
durable completed. Actual text is `first`, expected `firstsecond`; outcome is
completed. Use identities/sequences to deduplicate individual facts, not a whole-turn
live/durable preference. Add a mixed successful/lost-poll journey test. Requirements:
F-02, RUN-02/04, AC-03/04.

### R7 — P2: import is stored as an editable draft, not conversation history

`native-session-persistence.mjs:722-789` creates a conversation but writes its
serialized transcript into `drafts.text`; it creates no readable imported-message
projection. `hydrateConversation` reads turn journals and ignores that draft.
Editing/sending a draft can then overwrite the only imported transcript copy.
It also silently clips messages/text, and conversation creation is outside the
receipt transaction, so import is neither lossless nor fully atomic.

**Confirmed:** import a two-message transcript. Hydration returns `messages: []`,
while the entire imported history is in the composer draft. The UI does not expose
an import workflow even though the API is listed as landed. Build an immutable,
readable transcript-import path with atomic receipts, explicit bounds and no native
authority. Requirements: SESSION-02/06, CHO-03, completion instruction A.

### R8 — P2: Diff hides normal committed worker changes

`host.mjs:80-103` uses `git status` and an unbased `git diff`; the drawer requests no
individual file (`OrchAgentsPanel.tsx`, `onShowDiff`). These show uncommitted local
changes rather than commits relative to the implementation baseline. The no-focus
path supplies only a stat even when files are dirty, not an inspectable patch.

**Confirmed through runHost RPC:** a clean worktree containing a newly committed
worker change returns `files: []`, `patch: null`. Use the recorded baseline and
reviewed source commit for the file list and per-file patch, with clear repository/
worktree identity and untracked-file handling. Requirements: ORCH-06, CHO-05/06,
AC-08. A preformatted stat drawer is not the complete diff-review journey.

### R9 — P2: writable associations do not establish host-owned admission

`host.mjs:387-393` permits the renderer to upsert repository, worktree, stage, route
and identity fields. `admitOrchArgs` then trusts that same record (`:438-459`) after
only lexical containment. It does not establish that the worktree was created by
the host/coordinator, matches its resource record, or belongs to a prepared project,
conversation and approved route. Stripping privileged fields on a separate request
does not validate their underlying resource authority.

**Confirmed using injected dispatch only:** write a fabricated association, then
call `orch_run` with it. Host dispatch receives its caller-chosen directory and
route with `by: owner`, without project preparation or a coordinator worktree
record. No actual worker/model was launched; downstream coordinator/adapter checks
are distinct and were not bypass-tested. Make resource authority host-owned and
validate it against existing coordinator records and the prepared project.
Requirement: ORCH-09 and completion instruction B/F-01.

### R10 — P2: draft-conflict UI filters out every open conflict

`NativeChat.tsx:469,722` uses `!c.resolution`. The store returns open conflicts with
`resolution: 'open'` (`session-records.mjs:286,290,737`). That nonempty string is
truthy, so both controls discard every actionable conflict and report no open
conflict. Compare the actual enum explicitly and add a consumer interaction test.
Requirements: SESSION-02/05, F-06, completion instruction A. Unmount still cancels
pending save timers without persisting their text; close/last-keystroke durability
also needs a rendered lifecycle test rather than an assumption.

## Remaining task coverage and evidence corrections

| Task area | Assessment at reviewed HEAD |
| --- | --- |
| CHO-03 recovery/permissions/history | More code exists, but R2/R5/R6/R7/R10 prevent acceptance; permission journals need full consumer/failure/stale-decision checks. Body-byte Unicode concatenation repair is present and tested. |
| CHO-04/05 admission/delegation/review/integration | Partial. R3/R4/R8/R9 remain. This review does not qualify a real delegated change or blind independent-review round. |
| CHO-06 | Maintained Markdown/GFM and safe-link handling added. File-reference buttons currently resolve/display a path rather than open its contents. Diff is incomplete (R8); onboarding, actual keyboard/focus/scroll/viewport/scaling journeys remain unqualified. |
| CHO-07 | Useful CSP/docs/notices/CI changes exist. R1 blocks current packaged-runtime readiness. Native CI runs cargo tests, not a staged-host journey or installer build/provenance pipeline; release scan remains advisory. No final-head remote CI success was verified. |
| CHO-08 | An evidence table is not acceptance. Implementation failures above remain accessible local work. Clean-machine/signing/live-account checks require their actual specific dependency, not a blanket owner-blocked label. |

History paging is still window enlargement, not complete pagination:
`hydrateConversation` caps turns at 100 by default, and `hasMoreEvents` describes
events only. More than 100 short turns can fit within the event window while the
UI offers no Load More. Its Load More repeats the same 300-turn/256-page request;
it cannot advance beyond that window. Export calls default hydration and can
silently export only that bounded subset. Mark these unfinished and implement
explicit turn/event paging with a complete export path.

`viewport-layout.test.tsx:13-36` searches CSS strings, renders only a Markdown
fragment and asserts `960 > 700` / `1360 > 700`; it never lays out the application
at either viewport. The viewport evidence document overstates what those tests
prove about composer/message/Agents controls. Use a rendered browser/native layout
fixture; Windows display scaling remains a separate qualification step.

The progress matrix calls implementer-run automated checks "Independently
verified". They are useful local checks, not independent code review or reviewer
convergence. Preserve that distinction. The completion evidence still describes
the candidate as uncommitted and reports 767 tests; current HEAD is committed and
this review ran 787. Bind evidence and artifact hashes to an exact source/runtime
tree. Older artifact hashes do not qualify the later integration/migration changes.

Do not classify `npm audit --omit=dev`, deterministic browser viewport checks,
missing import UI or incomplete review controls as inherently owner-blocked.
Run accessible work, record exact unavailable services/permissions, and preserve
remaining honest blockers. Check the approved review route before declaring its
quota unavailable; no paid route substitution is implied.

## Verification performed

- Current `npm test`: **787 passed** (44 shared + 743 desktop), outside the sandbox
  to avoid the previously established temporary-file permission failures.
- `npm run typecheck`: pass. `npm run build`: pass, 290 transformed modules.
- `npm run test:orch`: **61 passed**.
- `cargo test --offline --locked`: **12 passed**; compiler cache hard-link warnings
  only. This did not execute current staged JavaScript or qualify the installer.
- Synthetic executable probes: import/hydrate, reopened dispatch/provenance,
  mixed live/durable replay, committed-worktree diff RPC, integration without review
  receipts/with a new commit after preview, caller-fabricated admission (injected
  dispatch only), failed-migration concurrent committed write, and missing packaged
  host import. No live coding provider was invoked and no real user repository or
  user session database was used by the probes.
- Probe JSON/script evidence is retained under
  `.reviews/cursor-review-20261105/latest-*`. The migration probe explicitly injected
  a competing committed write at the backup boundary; its result is a reproducible
  interleaving, not an assertion that this happened to the owner's data.

## Next work, in order

1. Correct runtime closure and migration data safety; verify staged host execution.
2. Gate integration on real evidence/process state and bind mutation to previewed
   immutable refs. Exercise refusal cases and recovery after interrupted Git/receipt.
3. Fix old-owner recovery and per-event replay; verify restart and partial-loss paths.
4. Finish lossless imports/exports/pagination and working draft-conflict resolution.
5. Complete committed-change diff inspection and host-owned resource admission.
6. Add meaningful consumer/native/rendered tests, correct the evidence matrix, then
   complete remaining CHO-06/07/08 journeys and artifact qualification.

Keep the existing completion instruction and acceptance criteria. This review
does not require another scope/spec rewrite; it requires implementing and testing
the promised behavior. Preserve the earlier report's refuted cleanup allegations.
