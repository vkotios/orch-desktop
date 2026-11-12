# orch-desktop handoff

## Completion candidate — 2026-11-12

PR #2 was merged as `cd86a0f`. The follow-on completion branch is
`codex/cho-v01-acceptance-completion`; verified application source is `be49418`.
Muse `muse-spark-1.3` and Vibe `zai-glm-5-3-flash` completed the current slices;
DeepSeek is disabled in the portable roster and must not be relaunched.

The candidate includes draft-switch/empty-clear and short-viewport fixes,
80 rendered Chromium checks, the Claude hydrate/export wire repair, a reusable
opt-in native restart probe, source-bound Windows artifact receipts, and CI
browser plus installed-NSIS smoke checks. Both real Codex and Claude owned
restart probes pass with native identity, history, draft and continuation intact.
They restart the source host, not an installed desktop window.

Local verification: 843 desktop + 44 shared tests, 80 browser checks, 15 Rust
tests, 106 coordinator checks, typecheck, production build, zero npm dependency
vulnerabilities and zero unexpected release-scan hits. All 116 staged runtime
files match source. The desktop suite passed with two workers after the initial
concurrent build/test run caused three five-second timeouts; assertions and
timeouts were not weakened. Final CI and new installer receipts must come from
this candidate's hosted run, not historical binary hashes.

See [completion evidence](docs/evidence/COMPLETION-2026-11-12.json) and
[acceptance ledger](docs/evidence/ACCEPTANCE-2026-11-12.md). Remaining release
acceptance: real tool/approval and delegated-change journeys on the proposed
release, installed WebView2/keyboard/OS scaling, clean-Windows install/upgrade/
uninstall, and signing/publication decisions. The complete v0.1 plan is not yet
accepted. No additional feature scope or specification change is introduced.

## Historical checkpoints

Updated: 2026-11-12. Repository: [vkotios/orch-desktop](https://github.com/vkotios/orch-desktop) (private).
Development/default branch: `codex/cho-v01-foundation`.
The product is still called **CHO Desktop** in source, package names and older documents.

## Start here

Current source: **`3a618a7`**, branch `codex/cho-completion-reviewed`.
[Final Opus 5.5 medium review](docs/reviews/OPUS-5.5-FINAL-2026-11-11.md) recommends
pushing as a PR, with no remaining actionable findings in the final delta.
Local checks: 787 desktop + 44 shared, Rust 12, typecheck, web/native builds;
[rebuilt artifact/source hashes](docs/evidence/OPUS-REVIEW-2026-11-11.json).
The CI/dependency follow-up at `3a618a7` has a separate clean
[Opus review](docs/reviews/OPUS-CI-REVIEW-2026-11-12.md), 831 passing package
tests and zero findings in both dependency audits. Latest installer receipts:
[CI follow-up evidence](docs/evidence/CI-FOLLOWUP-2026-11-12.json).
[PR #2](https://github.com/vkotios/orch-desktop/pull/2) contains this delivery.
The earlier checkpoints below are historical. Live provider, WebView/scaling,
clean-machine and signing/release qualification remain open.

Latest controller repair review: [2026-11-11](docs/reviews/CODEX-CURSOR-REVIEW-2026-11-11.md).
Independent [Opus review and adjudication](docs/reviews/OPUS-ADJUDICATION-2026-11-11.md)
supersede its earlier completion claims. The owner authorized the Opus review,
repairs, push and a PR on 2026-11-11; merge and release publication remain separate.
It supersedes the earlier source candidate for local changes only; see
[coordinator provenance](docs/COORDINATOR_UPSTREAM.md) for incorporated upstream fixes.

Read the [product specification](docs/PRODUCT_SPEC.md),
[implementation status](docs/IMPLEMENTATION_STATUS.md),
[implementation plan](docs/IMPLEMENTATION_PLAN.md),
[task register](TASKS.md), [current work package, CHO-03](docs/work-packages/CHO-03.md),
the [reuse audit](docs/REUSE_AUDIT.md), and the prepared
[S3d tool-lifecycle handoff](docs/work-packages/CHO-03-s3d-tool-lifecycle-handoff.md).
This handoff is the current entry point; older milestone paragraphs describe their
own checkpoints, not completion of the whole product.

The target is a polished Windows desktop coding workspace with a neutral dark
graphite interface, closer to Codex or Claude Code desktop. Native Codex and
Claude debug conversations work; the main unfinished work is durable application
integration, recovery, and release qualification.

## Active continuation checkpoint — 2026-11-08

Audited base remains `76076fb3cd6c82f3ca7d74220d226e34955521c4`. Accessible Cursor
completion candidate: **`9302b87`** (see
[progress matrix](docs/evidence/PROGRESS-MATRIX-2026-11-06.md) and
[evidence](docs/evidence/CURSOR-COMPLETION-2026-11-06.md)). Includes export
paging past the UI 500-turn window with `hasMoreTurns` / `truncation.turns`
disclosure (fixes silent 501→500 omission) and MSI/NSIS rebuild+rehash for this
SHA. Externally blocked: live CLI qualification, clean-machine AC-01/13/15,
independent review, push/tag/sign, owner scaling/WebView2 screenshots, remote CI
on published head.

The verified checkpoint table and workforce paragraphs below describe earlier
work. For the owner-supplied Cursor continuation, the plan's current execution
amendment takes precedence over its historical workforce assignments.

## Verified checkpoint

| Checkpoint | State |
| --- | --- |
| `130db47` | S3c normalized message-delta/body composition implementation. |
| `ccb8a30` | Accepted source candidate, including the independent-review regression fix. |
| `4fafa05` | S3c API, verification, status and consumer-follow-up documentation. |
| Current handoff commit | Documentation/repository handoff only; application source is unchanged. |

The latest accepted checks are **727 package tests**: 44 shared and 683 desktop,
including 31 new message-delta tests. Type checking and the production web build
pass. Real child-process fixtures pass on installed Node 24.11.1 and bundled
Node 24.22.2, covering 13 storage/correlation/reopen/CAS/fault scenarios with
synthetic owner proofs. They do not establish live native process ownership.

GLM 5.3 high through Vibe completed all seven source-review passes on `ccb8a30`;
the final review containment check was clean and the slice gate converged.
There are no unresolved High/Medium findings for this accepted slice. Low
findings and consumer prerequisites are recorded in CHO-03. Local verification
is distinct from GitHub CI, a packaged release, or clean-machine qualification.

The source blob of `apps/desktop/server/session-message-deltas.mjs` has SHA-256:
`E88038D8AAF5B25127658FEACF2EA3BDA21ACD1D8E5B2BCC6795C8668F41A004`.

## Implemented versus still pending

The native debug preview has Codex/Claude conversations, streaming text, tool
status, once-only permissions, clarification answers, interruption and
continuation. Prior native/runtime/rendered evidence is summarized in the
implementation status; it is not evidence of durable application recovery.

CHO-03 storage is implemented and locally verified through:

- S1 SQLite lifecycle/transaction core.
- S2 project/chat/draft records, ownership fences/native bindings, turn dispatch
  journals, immutable bodies, Stop/approval/clarification journals, turn/body
  references and explicit draft-conflict resolution.
- S3a durable events, replay cursors and bounded snapshots.
- S3b atomic terminal journal/outcome event/snapshot composition.
- S3c typed body-backed text deltas and a bounded last-message-turn marker.
- S3d typed tool lifecycle facts with actor dual-write + hydrate/poll projection.

**CHO-03 consumers are implemented in part, not accepted as durable recovery:**
dual-write, hydrate, drafts, close settlement and tool projection exist, but replay,
ownership, failure cleanup/outcomes, Unicode and draft/history gaps remain in the
current audit. Approvals/clarifications remain mailbox-only. CHO-05 associations
and Accept / Finish / Discard exist; Integrate is disabled and recovery/admission
remain incomplete. Release/public/installer qualification is open.

## Next concrete slice

**Product path next:** repair and verify the audited CHO-03 recovery defects and
CHO-04/05 admission/delegation gaps, then finish CHO-06 journeys and CHO-07/08
qualification. Follow the Cursor completion instruction's dependency order.
Do not invent a second coordinator or lift Grok JSONL persistence.
Release path: [RELEASE_v01](docs/RELEASE_v01.md).

Start by reading the current actors/mappers and the
[message-delta](docs/contracts/SESSION_MESSAGE_DELTAS.md),
[outcome](docs/contracts/SESSION_TURN_OUTCOMES.md),
[event](docs/contracts/SESSION_EVENTS.md),
[body](docs/contracts/SESSION_BODIES.md),
[bindings](docs/contracts/SESSION_BINDINGS.md), and
[storage](docs/contracts/SESSION_STORAGE.md) contracts.

Preserve these invariants:

- Native effects stay outside synchronous database transactions. Results from
  `inTransaction` are provisional until the outer commit.
- Preserve `state.lastTurnOutcome`, `state.lastMessageTurn`, other state and
  existing body references; reserve space for metadata. No silent truncation.
- Allocate a stable part ID once per accepted delta. Text is not a deduplication
  key; requested native IDs are not proof of observation.
- No automatic execution replay, adoption of an old owner's operation, or
  inference that an acknowledgement/unknown outcome proves a process stopped.
- Before host/error-UI/recovery consumers, address the recorded corrupt
  observed-journal error classification and relevant negative-test gaps.

## Development and verification

Use Node 24 and the committed workspace lockfile:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Native Windows builds additionally require the documented Rust/MSVC/Windows SDK
and WebView2 environment; see the README and implementation status. Do not
equate a web build with native artifact or clean-machine release acceptance.
The existing Desktop CI workflow runs on pushes for Windows and Ubuntu; remote
CI results must be inspected separately from the local results above.

## Implementation and review workforce

Use `orch` for worker/reviewer launches; follow the tracked
[controller workflow](skills/orchestrate/workflow.md) and
[orchestration rules](ORCHESTRATOR.md). The controller specifies contracts,
inspects diffs, verifies results and adjudicates findings; implementation/fixes
go to workers, not an unrecorded controller fallback.

The preferred implementation pool is Muse CLI plus Aider with Kyojin
`qwen3.8-flash-next-kyojin` or Lucebox `deepseek-v4-rocmfpx-lucebox-dspark`.
The standing independent reviewer is **GLM 5.3 high through Vibe CLI**.
Muse last reported a quota hold until November 9; recheck availability before
assignment rather than treating that observation as permanent.

Only one local engine/model/job may be active at a time. Inspect the configured
gateway and wait for idle before transitions; never force-unload busy work.
Space controller gateway API calls by at least five seconds. Size backend,
client input and reasoning/output budgets separately. Large Qwen test-repair
responses repeatedly exhausted 16K/32K output budgets without edits; small,
settled mechanical assignments worked better. Use UTF-8 Python diagnostics on
Windows (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`).

## Original workstation and excluded evidence

The original checkout is `C:\dev\CHO-desktop`. Its private runtime state,
credentials, worker/review transcripts, databases, binaries, retained worktrees
and local model configuration are **not uploaded**. In that checkout:

- `.reviews/messages-20261105/CURRENT_HANDOFF.md` and `verification.json` contain
  the detailed local execution/evidence index.
- `.reviews/implementation-20261030/orch.config.json` is the private orch profile;
  the Vibe reviewer uses its existing private home/configuration.
- `orch/.state/` contains the ledger, claims and gate receipts. Keep the existing
  CHO-03 claim and retained resources while the work package is unfinished.

One original review incident was retained: Codex internal diff-capture refs
rotated across a new user turn, without product-branch or tracked-file changes.
Its audit record was preserved; the subsequent exact-candidate review was clean.
Do not delete evidence/worktrees to hide an incident or manufacture a clean run.

A fresh clone has the code, contracts and handoff, not those local receipts or
credentials. Configure local tooling from the committed examples and current
host state before dispatching workers. Do not copy credentials into Git.

## Repository boundary

`origin` is the private `orch-desktop` repository. The former coordinator remote
is preserved as `coordinator-upstream`; upstream attribution/history remain.
Only the accepted delivery branch and its reachable history are uploaded, not
all worktree branches, tags or internal checkpoint refs.

The owner authorized this private repository upload and handoff on 2026-11-05.
This supersedes the earlier local-only push hold for this upload. Public
visibility, release publication, new native/provider qualification and unrelated
remote changes are separate work. Do not switch visibility or publish a release
as part of continuing the next implementation slice.
