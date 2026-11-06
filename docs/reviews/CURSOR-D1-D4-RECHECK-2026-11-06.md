# D1–D4 recheck — 4ccf930

Date: 2026-11-06, Europe/London. Codex controller review of `4ccf930`.
The earlier D2 current-owner authorization and D3 imported-history composition
repairs are present. Exact run/review matching and successful review outcome
checks improve D1. Ordered parts improve the earlier D4 durable-completion case.
Two acceptance gaps remain; the original completion task stays open.

## E1 — P1: review evidence still is not bound to the integrated source SHA

`host.mjs:485` supplies `association.sourceSha ?? association.reviewedCommit ?? null`
to `deriveReviewInspection`. Neither field survives the association normalizer
(`delegation-associations.mjs:51-80`), and the actual Git source SHA is resolved
inside `integrateAssociationWorktree` only after the inspection hooks run.
Consequently the otherwise useful optional commit comparison is bypassed in
normal production wiring. A review of an earlier commit from the same run can
authorize later unreviewed commits.

**Reproduced at the actual store→adapter seam:** upsert an association with source
SHA B; its normalized object has no sourceSha/reviewedCommit, so the host supplies
null. Finished successful clean review evidence for the exact run/slice at SHA A
is accepted. The probe does not perform a Git merge or launch a reviewer.

Resolve the actual candidate SHA before checking evidence, pass that immutable SHA
to review inspection, and require the reviewed commit to match. Do not solve this
by trusting a renderer-provided or stale association SHA. Retain the existing
preview/source/target SHA checks. Test through the host/actual stored association,
including an extra commit made after the successful review but before preview.
Requirements: ORCH-04/05/07, R3/D1.

## E2 — P2: live completion prevents recovery of an earlier missing text part

`native-chat-state.ts:180-214` clears the active turn and its applied parts on
completion. Its entry guard (`:284-288`) then ignores every replay event for that
finished turn. Sorting recovered parts cannot help if the consumer refuses them.
The host withholds durable events for any turn with live events in the same batch,
including a live completion, so this is an allowed transport sequence.

**Reproduced:** live A=`a`, lost B, live C=`c`, live completed, then durable A/B/C
with seq 1/2/3. The final text is **`ac`**, expected **`abc`**, and the outcome is
completed. This differs from the corrected test where completion arrives only
after all durable parts.

Keep enough per-turn part/cursor state to reconcile missed display facts after
native completion, or ensure authoritative catch-up is composed before releasing
the UI turn. Do not replay execution or resurrect a finished turn's approvals.
Test completion in the first successful response following a dropped response,
including switching chats and replay pagination. Requirements: RUN-02/04, R6/D4.

## Evidence and limits

- Synthetic results: `.reviews/cursor-review-20261105/4ccf930-probes.json`.
- No provider, real user database or Git mutation was used by the probes.
- No source fixes, installer rebuild, live-provider or clean-machine qualification
  was performed. Only this review file was added to the tracked-source area.
- Focused correction suite: **50/50 passed** across integration-evidence (6),
  native UI state (34), and native persistence (10) tests. This includes denied
  S5 proof and imported-plus-native history cases. No full suite was rerun in
  this narrow recheck; a focused pass does not establish full product acceptance.

Continue under the existing instruction. Do not reopen D2/D3's passing regression
cases without new evidence; close these two remaining acceptance cases and then
finish the already acknowledged implementation/qualification work.
