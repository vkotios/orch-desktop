# CHO Desktop v0.1 — Implementation Plan

Date: 2026-10-30  
Status: Ready for owner review; implementation has not started under this plan  
Product contract: [PRODUCT_SPEC.md](PRODUCT_SPEC.md), initially committed as `d9cc7ef`  
Planning branch: `codex/cho-v01-plan`

## 1. Delivery approach

Build the native application around the existing graphite interface and coordinator. Establish one installable, recoverable controller conversation first, then add the second controller and the full implementation/review journey. Package early so native integration problems are discovered before the product is otherwise finished.

Codex is the controller: define contracts and handoffs, assign work through `orch`, monitor, inspect diffs, run independent checks, adjudicate reviews, and maintain the record. Implementation and fix rounds go to external workers through `orch`; the controller does not quietly implement failed worker slices itself.

The owner's preferred development pool is Muse CLI plus Aider using Kyojin Qwen3.8 Flash Next and Lucebox DeepSeek V4 dspark. This is the development workforce, separate from the CLIs that CHO will eventually expose to its users.

The current request authorizes the specification commit and preparation of this plan. A completed plan is the boundary before implementation. This document does not create claims, change private model settings, load a model, launch a worker, authorize a push, or publish a release.

## 2. Current facts affecting execution

| Observation | Consequence |
| --- | --- |
| The spec is committed, but the application, workspace manifests, and earlier integration changes are still uncommitted/untracked. | No implementation worktree may be created until its required source baseline is committed. Do not assume workers can see the current working directory's untracked files. |
| `origin` still points to the coordinator repository. | Keep work local. Do not push CHO changes to that remote. Creating the intended CHO remote/public repository is a separate decision/action. |
| The repository's private roster is an older snapshot: it lacks the requested Aider routes and dspark. | Prepare a minimal project execution roster; do not copy or activate the entire machine roster. |
| The live gateway catalogue lists both requested models. The planning-time status showed Kyojin Qwen loaded and idle. | Model availability is discoverable, but readiness must be checked again before each launch. This snapshot is neither a lease nor a coding qualification. |
| The host Aider settings include the dspark selector with `edit_format: diff`; the inspected settings do not contain an explicit Qwen entry. | Verify/add the project-private Qwen model settings and qualification before assigning edits. Neither settings presence nor catalogue presence establishes task capability. |
| The vendored Aider adapter defaults to a cloud lane, although these routes use the local gateway. | Every local Aider run must explicitly select `--lane local`; a roster label alone does not set the runtime lane. |
| The Aider adapter refuses reviewer mode and does not extract a served model identity. | Aider is implementation-only. Record requested model separately from observed identity; never manufacture attribution or treat Aider as a read-only reviewer. |
| Muse has implementation/review adapters; its current roster notes do not establish complete review qualification. | Verify the actual native binary, subscription route, model attribution, and read-only review behaviour before relying on it for acceptance. |

The route/gateway observations above were collected on 2026-10-29; the source state was rechecked on 2026-10-30. They are not permanent environment assumptions. Keep private endpoints, tokens, executable paths, run logs, and machine-specific settings out of the public plan and source tree.

## 3. Workforce and routing

### Preferred workers

| Route | Exact selector | Intended assignments | Limits |
| --- | --- | --- | --- |
| Muse CLI | `muse-spark-1.3` | Primary worker for bounded native/host integration, small multi-file changes, concurrency work, and integration fixes. Primary reviewer for Aider implementations after review qualification. | Cloud lane. XS/S/M slices; an M slice remains approximately 100–300 changed lines across a few named files. Start at the adapter's normal medium effort unless a task justifies another supported setting. |
| Aider + Kyojin Qwen | `openai/qwen3.8-flash-next-kyojin` | XS/S edits with settled interfaces: focused validators, consumers, fixtures, UI extractions, and mechanical changes. | Explicit local lane; one file per local slice, normally at most 100 changed lines. First task must establish actual edit-format compatibility and scope behaviour. |
| Aider + Lucebox dspark | `openai/deepseek-v4-rocmfpx-lucebox-dspark` | Another primary local implementation route for the same eligible XS/S work. Rotate useful tasks with Qwen and retain measured outcomes. | Same local limits. Do not infer greater task capability from the model's name or size. |

Prefer the already loaded eligible local model when it avoids a reload, but do not repeatedly select one model merely because it succeeded. Batch independent suitable slices by model, then rotate with recorded reasons and evidence. Never assign a large refactor to a local worker simply to meet a quota.

Use `orch pick` against the scoped project roster and ledger. The owner's route preference overrides the kit's generic default ordering; record that reason when overriding a proposal. If routing/usage policies are active, carry their required profile/capability information rather than bypassing admission.

### Independent review assignments

| Implementer | Normal independent reviewer | Additional review for security-sensitive changes |
| --- | --- | --- |
| Aider / Qwen | Qualified Muse reviewer | Qualified DeepSeek reviewer through a read-only-capable harness. |
| Aider / dspark | Qualified Muse reviewer | Qualified Qwen reviewer through a read-only-capable harness. |
| Muse | Qualified Qwen or dspark reviewer through a read-only-capable harness | The other local model family, independently and blind. |

OpenCode is the proposed secondary harness for those local reviews because Aider cannot fill that role. Candidate selectors are `igm-local/qwen3.8-flash-next-kyojin` and `igm-local/deepseek-v4-rocmfpx-lucebox-dspark`. They are review candidates, not enabled or qualified by this plan. Qualify their read-only behaviour and model attribution first. This preserves Muse/Aider as the primary implementation pool without pretending Muse can independently review itself.

Independence is about the actual model, not the CLI name. Using the same model through Aider and OpenCode does not create an independent review. Preserve unknown attribution in run records. For local Aider work, retain gateway engine/model/selection evidence bound to the run and inspect any selection changes; this is separate provenance, not permission to overwrite `actual_model` with the requested selector. Critical acceptance must wait if the necessary identity/independence evidence remains unresolved.

Security-sensitive slices include execution IPC, approvals, workspace/path access, process cancellation, session import/migration, destructive Git integration, and release credential handling. They require two independent reviewers from different families under the controller protocol. Reviewer findings go through the controller; reviewers do not directly instruct implementers.

If no qualified independent reviewer is available, leave the slice review-pending. Do not silently switch providers, weaken the requirement, call Aider in reviewer mode, or add a paid cloud route. Any broader fallback or escalation must follow the existing owner/protocol authority.

## 4. Execution controls

### Before any implementation run

1. Confirm the committed baseline and scoped files exist in a clean worker worktree. Preserve the original working tree and unrelated edits.
2. Use the selected coordinator version consistently. Initially use this checkout's `orch/bin/orch.mjs`; do not mix a separately configured MCP server's engine/configuration with its records without verifying the binding.
3. Claim the work package as `codex`; preserve that claimant through review, gate, and finish. A held claim is a refusal, not a reason to force-release it.
4. Inspect the scoped roster and fresh executable/model-route evidence. Refresh configured usage/quota telemetry when required by the controller workflow; unknown observations stay unknown.
5. For local work, inspect gateway status and the machine-wide lane. Never load/unload/switch while another client is busy. Recheck the engine/model/selection immediately before launch and retain the receipt privately.
6. Create one worktree per slice and a handoff outside it. Name exact read/edit files, relevant contracts/anchors, permitted commands, checkable acceptance, and an `ALLOW:` block.
7. Launch only through `orch run` or `orch review`. For local Aider, explicitly pass `--lane local`, the exact `openai/...` selector, and the approved XS/S size. No direct worker CLI launches.

Aider handoffs use exact file paths, not directory/glob allowlists. The adapter turns the repo map off for scoped work and passes allowlisted files explicitly. Supply the necessary contracts and context rather than asking Aider to discover the architecture. Automatic commits, automatic lint/tests, hidden shell suggestions, and autonomous provider selection remain disabled by the adapter. The controller runs the acceptance checks independently.

### While work runs

- Check launch/process/log activity within 90 seconds. Inspect a failed or uncertain launch before deciding what to do; never blindly start another copy.
- Follow normal controller checkpoints: approximately 3–5 minutes for cloud runs and 5–10 minutes for local runs. Activity matters more than token speed; a suspected stall is advisory and never an automatic kill.
- Run only one local worker or local reviewer at a time across projects. One Muse cloud task may overlap one local task when their file scopes and dependency baselines are independent.
- Serialize overlapping files, lockfile changes, shared protocol changes, and integration-branch writes. Do not run two workers against the same worktree.

### After each slice

1. Inspect result and diff, then run `orch scope`. Out-of-scope changes do not proceed to acceptance/review.
2. Run the named acceptance checks in the worker worktree and inspect their actual output. Worker self-reports are not verification.
3. Commit the verified slice and review that exact commit in a blinded detached review worktree. Finish each review and inspect containment evidence.
4. Confirm findings against code, record severity/scope/disposition, and record the gate with the real scope run and verification result.
5. Send required fixes back through a corrected handoff. The controller does not patch the implementation as a shortcut.
6. After convergence, integrate according to the approved plan, record every worker/reviewer disposition, account for follow-ups, preview cleanup, and finish. Preserve dirty, uncertain, unmerged, or incident work; intentional retention needs a reason and revisit condition.

Use the protocol's attempt and review-round limits. A retry needs a recorded material change; repeated failures of the same area require design adjudication rather than an endless model rotation. No push, public repository creation, release publication, or destructive cleanup is implied by convergence.

## 5. Delivery milestones

| Milestone | Observable result | Work packages |
| --- | --- | --- |
| M0 — Reproducible starting point | The source workers need is committed, development routes are prepared/qualified, and the desktop has its own CI entrypoints. | Preflight and CHO-01 |
| M1 — Installed conversation | A packaged app owns its backend and completes a streamed conversation without Vite or global Node. | CHO-02 and early CHO-07 |
| M2 — Continuing work | Native conversations, drafts, events, and approvals survive the defined restart/recovery scenarios; two controllers are qualified. | CHO-03 and CHO-04 |
| M3 — Reviewed change | A conversation delegates into a worktree, displays progress/diffs, completes independent review, and presents explicit acceptance/integration decisions. | CHO-05 and the corresponding CHO-06 surfaces |
| M4 — Public release candidate | Onboarding, interaction polish, installer/upgrade behaviour, documentation, and the release evidence pass clean-machine acceptance. | Remaining CHO-06, CHO-07, and CHO-08 |

The first meaningful demonstration is M1, followed by restart/resume in M2. Do not spend the early implementation budget expanding decorative dashboards.

## 6. Preflight: preserve the baseline and prepare routes

Preflight is a prerequisite to CHO-01 execution, not an excuse for a broad environment rewrite.

### P0.1 — Reviewed source checkpoint

Inventory the current application/workspace additions and the inherited Grok/coordinator changes separately. Verify that the intended desktop checkpoint contains all imports/resources required to build it, while excluding private configuration, logs, generated outputs, and credentials. Review the inherited modifications before including them; do not use `git add .` against the dirty checkout.

Commit the approved desktop baseline with explicit paths. Keep unrelated changes untouched. Establish an integration branch and record the baseline SHA. Preserve upstream coordinator provenance. Do not rewrite history or change the existing remote as a side effect.

Exit: a fresh worktree from the recorded commit contains the intended app, can install dependencies reproducibly, and passes the documented baseline checks. A spec-only commit does not satisfy this exit.

### P0.2 — Project execution profile

Prepare an ignored project-private roster containing the three requested implementation routes plus separately gated local reviewer candidates. Set both Aider routes to the local lane in that roster and still pass the runtime lane explicitly. Verify the native executables and effective gateway endpoint privately. Do not alter global Aider/OpenCode settings or activate unrelated machine routes.

Prepare explicit Aider model settings for both exact selectors, including a tested edit format. Inspect any implicit weak/editor model selection so no unapproved secondary route is called. Verify context/output limits against the selected engine; do not assume the two models share capacity or reasoning controls. Record settings and route evidence without credentials.

Exit: the profile is reproducible and confined to this project; all routes remain honestly labelled with their measured qualification state.

### P0.3 — Bounded workforce qualification

After implementation-plan approval, use owned disposable fixtures through `orch`: one small existing-file edit and new-file creation per requested Aider route, independent verification/scope checks, and a Muse implementation/review check. Qualify proposed OpenCode local reviewers on read-only review and attribution before they can close Muse slices. Reuse matching fresh evidence where available rather than rerunning a ceremonial suite.

Exit: the required implementer/reviewer pairing for the first slice is evidenced. An unavailable secondary candidate blocks only tasks needing that candidate, not unrelated planning or preparation.

## 7. Work-package breakdown

Slice scopes below are planning targets. Before launch, bind them to actual files on the accepted baseline and split anything exceeding the controller protocol's size limits. New architecture directories are introduced only when their contracts require them.

### CHO-01 — Source boundary and desktop CI

Owner outcome: a fresh checkout contains the actual desktop product and checks it independently of the inherited coordinator suite.

| Slice | Target scope | Preferred worker | Acceptance |
| --- | --- | --- | --- |
| 01-s1 | A single desktop CI workflow; existing workspace scripts as read context. | Muse, S/M | Installs root workspace dependencies and checks desktop/package typecheck, tests, and web build. No provider credentials/calls; coordinator tests remain separately visible. |
| 01-s2 | Public configuration/example cleanup, split into one-file edits. | Aider Qwen/dspark, XS/S | No developer-specific paths or credentials in shipped examples; private settings and runtime evidence remain excluded. |
| 01-s3 | One coordinator provenance/update-policy document. | Aider, S | Records the bundled source commit and local modifications; gives a bounded update/verification procedure. |
| 01-s4 | CI coverage/selection integration and any necessary root scripts, split if needed. | Muse, S/M | Desktop changes trigger desktop checks; inherited coordinator coverage is preserved and ignored desktop paths do not create a false green. |

Map to ARCH-05/07 and AC-14/15. Exit M0 only after the source checkpoint and required workforce profile are ready.

### CHO-02 — Persistent native host and local access boundary

Settle the protocol before assigning consumer changes. Preserve the current browser preview while replacing its host implementation behind a compatibility boundary.

| Slice family | Scope and outcome | Preferred worker |
| --- | --- | --- |
| 02-a | Define versioned command/event envelopes, request IDs, correlation, terminal/error semantics, message bounds, and compatibility tests. No subprocess launch yet. | Muse for the contract; Aider for focused settled validators/fixtures. |
| 02-b | Extract the application-owned host lifecycle and private IPC dispatcher from the monolithic bridge in small increments. Add fake-host/process tests. | Muse, bounded M slices. |
| 02-c | Start and own one persistent host from Tauri; resolve packaged resources; handshake and surface failures; wire all supported commands/events through it. | Muse; split Rust lifecycle, routing, and frontend consumers. |
| 02-d | Move the development browser transport onto the same contract; reject unauthorized requests and invalid workspace fallback. Apply production capability/CSP boundaries. | Muse implementation; two independent reviews for access-sensitive slices. |
| 02-e | Build and launch an early installed artifact with the bundled runtime, independent of source cwd, global Node, and Vite. | Muse for packaging integration; Aider for isolated metadata/config consumers. |

Likely anchors are the current `server/bridge.mjs`, `src/lib/api.ts`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, and capability configuration. Do not assign all of them in one slice. The canonical protocol/module locations become fixed in 02-a; later handoffs use those paths exactly.

Map to ARCH-01–04/07, RUN-01–03/07, SEC-01/02/07, AC-01/11. Exit M1 requires an installed-app conversation, not just a successful frontend bundle. Early packaging belongs here, with its final pipeline completed in CHO-07.

### CHO-03 — Durable sessions and recovery

1. Define the versioned project/conversation/native-session/turn/event/operation storage contracts and migration behaviour (Muse).
2. Implement storage ownership, atomic writes, event cursors, and native reference persistence in bounded slices (Muse; settled one-file helpers/fixtures to Aider).
3. Add explicit transcript import from the existing browser store without inventing native session identifiers (Muse, security/data review).
4. Move list/search/rename/archive/export and per-conversation drafts onto the durable store, one consumer at a time (Aider for eligible single-file changes).
5. Implement resume/reconnect reconciliation, unknown/interrupted states, duplicate suppression, and model/harness-change handoffs (Muse).

Map to SESSION-01–06, RUN-04/06, AC-03/04/07/13. Exit: sessions and drafts survive restart; recovery never silently replays an execution. Storage/migration changes receive two independent reviews where data-loss risk applies.

### CHO-04 — Canonical controller adapters and permissions

1. Define capabilities and normalized events once; remove duplicated parsing incrementally (Muse contract, then Aider for one settled parser/fixture at a time).
2. Build the first controller's native session/resume and approval/clarification path using current official CLI documentation and owned fixtures (Muse).
3. Bind permission decisions to exact native requests/process generations and test reject/cancel/restart cases (Muse; two independent reviewers).
4. Integrate the second controller against the same contract and qualify its actual supported modes (Muse integration; Aider for bounded consumers).
5. Record tested versions, sign-in/access evidence, actual attribution, and capability limitations; evaluate Antigravity as a real controller candidate and clearly gate any incomplete routes.

Claude Code and Codex are the product spec's initial controller candidates; do not substitute an easier route merely to satisfy the count. Their qualification concerns the product runtime, not the preferred development workforce.

Map to CLI-01–06, SEC-03–06, AC-02/03/05/10/15. Exit M2 requires two real continuing controller integrations and honest unsupported-feature states.

### CHO-05 — Recoverable delegation and acceptance

1. Define persistent associations between conversation, work package, stage, claim, worktree, run, review, and disposition (Muse).
2. Replace the current short preparation helper with recoverable stage transitions and resource reconciliation; test failure before/after each side effect (Muse).
3. Connect real scope/verification evidence and blinded review rounds; preserve model-identity uncertainty and gate semantics (Muse).
4. Implement explicit acceptance, integration, discard, and retention operations with repository/process rechecks (Muse; two independent reviewers).
5. Wire scoped agent activity consumers and small fixtures after the contracts settle (Aider XS/S).

Map to ORCH-01–08, RUN-05/06, AC-06–10. Exit M3: a recorded implementation/review/diff journey works in the installed app; acceptance alone performs no hidden Git mutation. Prefer wrapping existing coordinator operations over modifying coordinator internals.

### CHO-06 — Product interaction completion

Deliver in parallel only where stable contracts and disjoint files allow it:

- Onboarding, native project selection, and actionable connection states (Muse integration; Aider for small view components).
- Maintained safe Markdown rendering, code copying, file references, and a changed-file/diff view (Muse dependency/integration choices; Aider for settled single-file consumers).
- Conversation components, shortcuts, focus management, scroll behaviour, archive/search/export, and deliberate recovery actions (split between both Aider routes and Muse by size).
- Graphite design consistency, optional light appearance, all loading/error/permission states, and Windows display scaling (Aider focused visual changes, controller visual verification).

Preserve the approved visual direction. No cosmetic rewrite of working areas without an identified usability defect. Map to section 8 of the product spec and AC-04/08/12.

### CHO-07 — Distribution and public repository readiness

Complete the early packaging work with a reproducible Windows release build, lockfiles, icons/metadata, checksums, release notes, upgrade/uninstall checks, and a signing plan. Add the truthful supported-version matrix, privacy/security/contribution documentation, attribution notices, and public-content scan. Separate source publication from a qualified binary release.

Muse handles packaging/release integration; Aider handles bounded single-file metadata/documentation edits after facts are verified. CI uses fake CLIs and no personal credentials. A green source build does not qualify the installer.

Map to AC-01/13–15 and product-spec section 12. Remote creation, pushes, signing credentials, and release publication need their own concrete, reviewable actions; do not perform them as cleanup.

### CHO-08 — Release-candidate acceptance

Run AC-01–15 against the built release candidate on the documented clean Windows environment. Record the artifact hash, test environment, CLI versions/routes, actual outcomes, known limitations, and evidence pointers. Open focused fix slices for defects; do not patch the candidate outside the reviewed workflow.

Publish readiness is the aggregate of the evidence, not a worker's declaration or the appearance of the UI. Release blockers remain open until verified on the corrected artifact.

## 8. First execution batch

Keep the first authorization small and reviewable:

1. P0.1: review and commit the intended desktop baseline without unrelated changes or a push.
2. P0.2: prepare the minimal private execution profile and record exact routes/settings without changing global configuration.
3. P0.3: run only the bounded qualification necessary for the first implementer/reviewer pairs; do not qualify every installed model.
4. CHO-01 / 01-s1: assign Muse the desktop CI workflow; independent qualified local review.
5. CHO-01 / 01-s2 or 01-s3: assign an eligible single-file slice to the already loaded qualified Qwen route; Muse review.
6. Rotate the next eligible local slice to dspark after the current local work and reviews are complete; Muse review.
7. After CHO-01 is accepted, prepare CHO-02 / 02-a and the first persistent-host slice. Demonstrate early packaged execution before expanding the rest of the interface.

At each launch use a fresh exact-file handoff, not this entire plan as an unrestricted prompt. The first batch produces a stable baseline, verified workforce pairing, and CI protection before the architectural migration.

## 9. Evidence and checkpoints

Maintain a compact progress record per slice: baseline/ref, allowed files, chosen route and reason, private run/review IDs, measured scope/check outcomes, adjudicated findings, gate, integration ref, follow-ups, and retained-resource decisions. Public progress notes contain no credentials, private endpoints, or raw provider transcripts.

After each milestone, compare delivered behaviour with the product spec and record deviations. Do not silently expand v0.1 or reduce its acceptance criteria. Keep timestamps/receipt bindings so earlier successful probes are not presented as current qualification after the underlying executable, route, or configuration changes.

## 10. References

- [Product and release specification](PRODUCT_SPEC.md)
- [Controller protocol](../ORCHESTRATOR.md)
- [Shared controller workflow](../skills/orchestrate/workflow.md)
- [Worker handoff template](../templates/handoff.md)
- [Review prompt template](../templates/review-prompt.md)
- [Adapter behaviour and verified quirks](CLI_GUIDE.md)
- [Aider adapter](../orch/src/adapters/aider.mjs)
- [Muse adapter](../orch/src/adapters/muse.mjs)
- [Aider model settings documentation](https://aider.chat/docs/config/adv-model-settings.html)
- [Aider scripting documentation](https://aider.chat/docs/scripting.html)
