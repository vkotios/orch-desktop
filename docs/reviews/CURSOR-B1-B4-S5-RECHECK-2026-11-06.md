# B1–B4 / S5 / import continuation recheck

Date: 2026-11-06, Europe/London. Codex controller review.
Candidate: `2e8101c281966d06ba4d95ae86b4e96c0d77f9cd`, including `15f79f5`.
Source tree was clean at start. No source fixes or real provider runs were made.

## Assessment

The original B1–B4 regression cases have meaningful source corrections and passing
tests: real bridge shapes are adapted; live and durable deltas share part IDs;
imports no longer create invalid tip-zero snapshots; current-host reconciliation
and recovery notices are wired. The import UI and explicit prior-owner action
are useful additions. These are progress, not acceptance of all associated flows.

Four further cases still fail. Keep the original completion instruction active;
do not classify these as installer/live-account or independent-review availability
blockers. They are accessible local implementation work.

## D1 — P1: unrelated or unsuccessful review evidence passes integration

`delegation-integrate-evidence.mjs:88-103` falls back to *any* finished, clean
containment review for the work package when the requested run/review has no match.
`bridge.mjs:1352-1356` also keeps the unfiltered list when run matching finds none.
The derived predicate ignores review outcome, reviewed commit and slice; the
bridge exports `ref` but not the actual `commit` recorded by orch review.

**Reproduced:** evidence only for `other-run`, with `outcome: 'not-reviewed'`,
`finished_at` set and `containment: 'clean'`, returns `clean: true` when inspection
requests `required-run`. Containment only proves that the reviewer stayed within
its boundary; it does not prove a successful review of this candidate.

Refuse absent/mismatched exact evidence. Require the implementation run, slice,
reviewed source SHA, successful completed outcome and containment/independence
evidence appropriate to the coordinator contract. Bind those to the integration
source, alongside the converged gate. Do not fall back to another run's review.
Requirement: ORCH-04/05/07, original R3 and B1.

## D2 — P1: prior-owner acknowledgement bypasses current owner verification

`native-session-persistence.mjs:1462-1565` uses cached conversation metadata and
checks only that `evidence` is an object before raw transaction updates to turns
and operations. It does not validate the current producer fence/token/generation
or invoke `verifyOwnerEvidence` inside the mutation. Preserving the old operation's
hostGeneration does not authorize the new writer to settle it.

**Reproduced:** reopen and claim the conversation with valid synthetic owner proof;
then make the supplied verifier reject proof. Calling `acknowledgePriorOwnerTurn`
with a revoked-proof object still returns `acknowledged: true` and updates the old
turn. The probe uses synthetic data and verifier revocation, not real process or
credential manipulation.

Use the existing checked producer-transaction/fence machinery for the current
owner within the same writer transaction. Define the explicit old-operation
recovery semantics separately; do not weaken normal-operation provenance checks.
Add denied/expired proof and changed-fence tests, plus durable recovery projection/
receipt tests. Requirement: SESSION_BINDINGS host proof obligations and S5 recovery.

## D3 — P2: continuing an imported chat hides all subsequent turns on reopen

`native-session-persistence.mjs:839-892` short-circuits hydration whenever an import
receipt exists, always returns only the imported body, and hard-codes eventTip 0.
The composer/send path does not enforce read-only imported conversations.

**Reproduced:** import two messages, then successfully journal a new question,
assistant delta and completed outcome in that same conversation. Hydration still
returns only the two imported messages. The new turn is persisted but invisible
to hydrate/export through this path. This is not native resume qualification.

Either make imported transcripts explicitly read-only in the host and UI with a
deliberate fork/context-handoff action, or compose imported history with subsequent
normal turn/event history. Preserve actual native context distinctions. Test the
real import → send/fork → reopen/export journey. Requirement: SESSION-02/03/06.

## D4 — P2: shared part IDs deduplicate but do not restore text order

The reducer now recognizes matching part IDs, correcting the earlier `abab`
duplication. However it still appends a newly recovered part to the end of the
rendered string rather than placing it in durable sequence order.

**Reproduced:** receive live parts A=`a` and C=`c` with B's response lost, then replay
durable A, B=`b`, C and completion. Actual text is **`acb`**, expected **`abc`**;
the turn is marked completed. Missing-middle-response recovery is a different
case from replaying copies of an already complete live stream.

Carry ordering/sequence alongside stable identity and rebuild/merge the ordered
message parts. Do not infer order from arrival of recovered parts or compare text
as identity. Test lost first/middle/last responses, multiple native message items,
duplicate parts and terminal ordering. Requirement: RUN-02/04, original R6/B2.

## Validation

- `npm test`: **798 passed** — 44 shared + 754 desktop; 37 desktop test files.
- `npm run typecheck`: pass.
- `npm run build`: pass (290 modules).
- Focused synthetic probes for D1–D3:
  `.reviews/cursor-review-20261105/2e8101c-probes.json`.
- D4 reducer probe:
  `.reviews/cursor-review-20261105/2e8101c-order-probe.json`.
- Full-suite log:
  `.reviews/cursor-review-20261105/2e8101c-tests.log`.
- No new Rust, staged-runtime, installer, live-provider, remote CI or clean-machine
  qualification was run here. Existing evidence remains bound to its own candidate.

The explicitly open full pagination/export, rendered viewport/keyboard, installer
rebuild/rehash and external qualification work remains open. Keep R/B/D dispositions
granular: a regression case passing is not proof of the complete product journey.
