# Cursor instruction: finish CHO Desktop v0.1

Date: 2026-11-05. Prepared for the owner to give to Cursor together with
[the Sonnet review and controller addendum](reviews/CURSOR-DELIVERY-REVIEW-2026-11-05.md).
When the owner supplies this instruction to Cursor, the execution authorization
below applies to that completion task. Preparing this file does not launch work.

## Mission and authority

Finish the existing implementation plan autonomously, starting with the recovery
and delegation defects, then complete the remaining product journeys and release
preparation. Deliver working behavior and measured evidence, not just a green
unit suite or updated completion checkboxes. Do not replace the product or rewrite
working foundations to match another application.

You are the authorized implementer and controller for this task. You may inspect
the full repository, edit source/tests/docs, use file/shell/network tools, install
repository dependencies with the lockfile, run the existing pinned runtime
preparation/build scripts, make focused local commits, and prepare local build
artifacts. Your own Cursor edits do not need an `orch` worker wrapper. This
task-specific instruction supersedes the plan's older Codex-only controller and
Muse/Aider-only implementation assignments for your own work. Any child CLI/model
you launch must still go through `orch`, with the actual approved route, recorded
scope, ownership and required independent review. Do not silently substitute a
provider/model, create a new billing route, or treat the one-off Sonnet audit as
standing permission for more paid Sonnet runs.

Proceed through implementation, fixes, checks and documentation without asking
for routine confirmations. Use reasonable choices consistent with the contracts.
Only stop dependent work for genuinely missing authority, credentials, a required
owner decision or an inaccessible external environment; continue independent work.
Do not change global tool/account settings, install system toolchains, delete
valuable data/worktrees/evidence, or take over another controller's live claim.
Do not push, change repository visibility, tag/publish a release, sign with new
credentials, or send correspondence without separate explicit owner authority.

## Read and establish the baseline

1. Read `CURRENT_HANDOFF.md`, `docs/IMPLEMENTATION_PLAN.md` including its current
   execution amendment, `docs/PRODUCT_SPEC.md`, `TASKS.md`, `docs/RELEASE_v01.md`,
   the Sonnet report INCLUDING section 10 (controller verification, Unicode
   defect and supplemental reuse), and relevant CHO-03/04 contracts/work packages.
2. Inspect HEAD, branch, working tree, worktrees, held claims and active runs.
   Preserve unrelated edits, this report and the owner's work. Do not assume the
   original machine paths or private `.reviews` receipts exist on another clone.
3. The audited source is `76076fb3cd6c82f3ca7d74220d226e34955521c4`; original delivery
   is `07dbb15..93c0332`, corrections `93c0332..76076fb`. Check for later changes
   before applying a finding. On that source: 763 package tests, typecheck and web
   build passed; Sonnet also ran 61 focused coordinator tests. Native verification
   stopped at missing staged `.runtime`; product/installer acceptance did not pass.
4. Treat the report as evidence to adjudicate against current code, not a list to
   obey mechanically. Preserve refutations and uncertainty. In particular orch
   already guards active/dirty/unmerged resources during cleanup (F-09); do not
   duplicate its coordinator. F-13's storage-error degradation suggestion is a
   design question, not permission to silently lose durable progress (section 10).

## Execute in this order

Use bounded changes with a concrete acceptance check for each. Keep a compact
progress table of finding/requirement, implementation, tests, review, remaining
qualification and evidence. Adjust grouping when actual dependencies justify it;
do not stop after the first group.

### A. Make recovery truthful and lossless (CHO-03)

- F-12: at close, record `unknown` unless the matching native terminal outcome
  actually proves interruption/completion. A Stop request/ACK is not that proof.
- F-03/F-08: always close owned native clients even if storage settlement fails;
  preserve/surface that failure. Settle or explicitly reconcile dispatched but
  unobserved turns through the existing allowed `unknown` transition, with valid
  ownership. Never redispatch execution to recover UI state.
- F-05: verify process identity AND creation time, liveness, token/generation and
  proof freshness; treat access failure as uncertain, not dead. Reuse existing
  process-identity code where suitable. Make liveness records recoverable and
  concurrency-safe without an unlocked second source of truth.
- F-02: implement actual cursor replay/deduplication. A lost poll response must
  recover text/tools/terminal state once. Live-first ordering alone is insufficient;
  do not advance acknowledged UI progress past data the consumer discarded.
- C-01 (report section 10): decode body bytes once or stream UTF-8 across byte
  chunks. Preserve non-ASCII text at the 16 KiB boundary in hydrate AND catch-up.
- F-06/F-07: preserve latest drafts across switching, send failure and close;
  expose existing draft conflicts/resolution; keep serial save state across loads.
  Make older conversations reachable, implement bounded history pagination, show
  errors/truncation/recovery choices, and never silently replace native context.
- F-13: stable identities for accepted tool facts/retries, correct harness-native
  identifiers and tested producer→store→hydrate/poll mapping. Preserve legitimate
  distinct facts. Decide and document storage-failure behavior consistently with
  RUN-04; do not just swallow failures. Finish required process-level probes.
- Complete the rest of CHO-03, including pending permission/recovery consumers,
  transcript import, rename/archive/search/export and migration behavior. Safely
  invalidate stale native decisions after restart; durable history is not authority
  to replay a permission, clarification answer, Stop or user turn.

Minimum regression scenarios: lost poll response; duplicate/mixed live+durable
events; close with settlement failure; unobserved dispatch on restart; verified
death vs uncertain/PID-reused owner; concurrent liveness writes; UTF-8 split;
draft conflict/switch/send-failure/close; more than one hydrate page; tool retries;
real native resume wiring in deterministic fake-peer tests.

### B. Make delegation recoverable and host-admitted (CHO-04/05)

- F-01: host owns admission. Typed mutation requests must bind conversation,
  scope, approved route and owned resource identity. Derive execution paths and
  claimant authority at the host; renderer flags must not self-authorize models,
  force release or bypass scope. Preserve existing orch checks. Gate any native
  controller delegation capability whose tool/approval boundary cannot enforce it.
- F-04: persist intent before side effects, reconcile resources/results afterward
  and on recovery. Reuse orch claims/worktree/run records; uncertain work must be
  inspectable/adoptable under valid authority, never silently relaunched. Verify
  recorded resources, prevent duplicate execution, isolate conversations/projects,
  and handle failures before/after each preparation/launch stage.
- F-09: display actual run, scope, verification, review/gate and retention evidence;
  explain cleanup/finish effects and preview them with existing orch APIs. Keep
  provider finish, acceptance, Git integration, discard and cleanup separate.
  Implement the remaining explicit integration journey with repository/branch/
  process rechecks; do not rename cleanup to integration or enable a fake button.
- Complete independent review rounds and the end-to-end delegated change journey,
  including denied scope, failed preparation, interrupted execution and retained
  work. Do not claim CHO-05 done from JSON association persistence alone.

### C. Complete product interaction (CHO-06)

Finish onboarding, native project selection, safe maintained Markdown/file
references, changed-file/diff inspection, recovery notices and conversation
operations. Reuse existing surfaces and components. Preserve graphite design;
avoid a cosmetic redesign. Verify keyboard/focus/accessibility, scroll behavior,
long histories, 1360×880 and 960×720, and Windows 100/125/150% scaling. Keep the
composer usable while streaming and activity/diffs are visible. Capture actual
rendered/native journey evidence, not screenshots of fabricated success states.

### D. Complete native/release preparation (CHO-01/02/04/07)

Use existing installed Rust/MSVC/SDK/WebView2 tools; resolve their paths before
declaring them absent. Prepare the pinned runtime with the existing verified
script before a native build; `.runtime` is generated and not in a fresh clone.
Use root `npm run native:build` for the normal prepare+Tauri path. Do not bypass
checksums, package user credentials or require global Node on the target machine.

Complete native CI and deterministic host/adapter checks, production CSP/narrow
capabilities, public configuration/provenance/license notices, support matrix,
privacy/data retention/security/contribution docs, and reproducible artifacts,
checksums and release notes. Use the audit's pinned reuse references as leads;
inspect any material you copy and preserve applicable licenses/notices.

Qualify the final configuration of Codex and Claude using bounded owned fixtures
and existing authorized account/model routes. Include multi-turn context, reopen
in a new process, tools, approval deny/cancel/stale decisions, clarification, Stop
and continuation. Reuse matching evidence only if source/runtime/version/route
still match. If authority or quota for a live check is missing, record the exact
blocked check; do not switch routes or infer success from a mocked test.

### E. Run the complete acceptance matrix (CHO-08)

Maintain a result/evidence row for EVERY AC-01–AC-15 from the spec, tied to candidate
commit/tree, artifact hash, environment and CLI versions/routes. Test installation,
launch without checkout/global Node/Vite, upgrade with real-shaped fixture data,
migration failure, uninstall/data retention, and the complete reviewed-change
journey on the documented clean Windows environment. Do all accessible local and
CI preparation autonomously. If the clean environment, sign-in, signing or owner
action is unavailable, leave those rows blocked with exact instructions; the
release is NOT qualified. Do not lower the criteria to make the matrix green.

## Reuse priorities

Use the report's I-1–I-6 first: existing process identity, Stop/turn/outcome,
draft/conflict/body/event APIs, and orch run/worktree/scope/review/gate/cleanup
operations. Wrap these in CHO consumers instead of building another coordinator
or persistence engine. For the diff UI, consider the pinned Vibe Kanban component
interface in report section 10; adapt it to CHO's owned resources and read-only
display. Grok's JSONL store, permissive trust/framing and provider-specific auth
are not replacements for CHO's established contracts. Do not broaden v0.1 merely
because an upstream product offers extra features.

## Checks, evidence and completion

Run focused regression checks as each defect changes, then root `npm test`,
`npm run typecheck`, `npm run build`, relevant coordinator checks, native checks
and journeys appropriate to the candidate. Use fake CLIs for automated suites;
keep all fixture databases/liveness files/home paths isolated. Explain sandbox
errors and retry a justified blocked check with normal permissions; do not label
environment failure as a product failure or silently skip required checks.

Preserve required independent-review gates for sensitive changes. Use existing
approved reviewers through orch; if unavailable, keep the affected gate pending
and continue other work. Never manufacture review/model identity, accept stale CI,
or count self-review as independent. Check actual CI on the final head if claiming
CI success. No new reviewer provider/paid-route substitution is authorized here.

Update TASKS, implementation status, work-package notes, handoff and release
checklist as behavior/evidence changes. Mark a package done only when its exit
evidence exists. Historical accepted checkpoints remain history, not proof of the
current integrated candidate. Keep external blockers separate from unfinished
implementation; do not declare the entire plan complete because local tests pass.

Final delivery: code/artifacts, concise changes summary, report-finding disposition
(including C-01), AC-01–15 matrix, exact check/review/CI results, artifact/evidence
paths, known limitations and only the owner actions genuinely still required.
Continue until the implementation and all accessible qualification work are done;
do not finish with a plan, a single corrected finding or an invitation to continue.
