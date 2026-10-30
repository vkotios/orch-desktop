# Independent design and implementation-plan review (sonnet-high, attempt 2)

Baseline: commit `fcab168`. Reviewed documents: `docs/PRODUCT_SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`.
Code evidence was read from the authoritative checkout `C:/dev/CHO-desktop` (untracked `apps/`, `packages/`, dirty coordinator integration), not from this committed-only worktree. Paths below are repo-relative to that checkout.
**No source files were changed.** The only file written is this report. This is a review, not a qualification gate.

## 1. Verdict

**Executable after named corrections.** The product definition is sound and unusually honest. The spec already names most current-code defects (SEC-01/02, SESSION, ORCH-03/07). The plan's sequencing (baseline, then CI, then persistent host, then sessions, then delegation) is the right shape. Starting CHO-01 does not need any redesign.

Four things are not yet executable as written:

1. The delegation approval boundary has no enforcement mechanism (F1). This blocks CHO-05 design and shapes CHO-04. It does not block starting.
2. CHO-04 names no session or approval mechanism per controller (F2). The Codex path chosen by default cannot satisfy CLI-06/AC-05.
3. The plan never schedules the native toolchain (Rust/MSVC/WebView2) or the host-bundling decision, yet promises "early packaging" (F3). Nothing in the Tauri shell has ever been compiled on this machine.
4. The first batch spends its budget on workforce ceremony before any user-visible risk is reduced (F5). The inherited CI policy would also pass a desktop-only change with no desktop check (F4), and that is only weakly sequenced in the plan.

None of these require restructuring the milestones. Section 6 gives a corrected first batch and two milestone-order changes.

## 2. Findings

Legend: **Kind** = plan/spec defect (P) or current-code defect (C). **Blocks** = what it blocks: *start* (starting implementation), *CHO-nn* (a later package), or *release*.

### P0 — none

I found nothing that makes starting unsafe or the whole plan unachievable. Nothing is rated P0, deliberately.

### P1 — must be corrected before the dependent work is assigned

**F1. The delegation-approval requirement has no enforcement point** (P, spec/plan; C contributes). Blocks: CHO-05 design and the CHO-04 permission model; not *start*.
- Evidence: `docs/PRODUCT_SPEC.md:89` (journey 4.3, user approves a delegation plan before implementation) and ORCH-02 (`:172`). `apps/desktop/server/bridge.mjs:533-561` (`buildOrchestratorPrompt`) tells the controller to run `node orch.mjs claim / worktree create / run …` itself. The Claude path runs with `bypassPermissions` (`bridge.mjs:580`, `:634`).
- Failure: approval is a sentence in a prompt. A controller with a shell and no permission gate can claim, create a worktree and launch a worker whenever it likes. The UI's own helper, `apps/desktop/src/lib/agent-task.ts:22-48`, also claims as `by: "owner"`, so two independent writers can act on the same WP.
- The plan says only "replace the current short preparation helper" (CHO-05 step 2). It does not say how a controller *proposes* delegation or where the user's approval is recorded.
- Correction: add one decision to CHO-04/05 before either is assigned. The controller gets a host-mediated delegation tool (an MCP tool that records a *pending proposal* for the UI to approve) and no direct `orch` shell access. The repo already has the pieces: `orch/src/mcp.mjs` (hand-rolled stdio MCP, zero runtime dependencies), `orch/src/controller-tool-server.mjs` (fixed `controller_step` tool) and `orch/src/controller-guard.mjs` (hook pattern). Make the host the only claimant.
- Optional shortcut: for v0.1 the host could run claim/worktree/run only on an approval click and strip shell from the controller in chat mode. Both routes work. The decision is the required part.

**F2. CHO-04 does not specify the native session and approval mechanism per controller, and the Codex default cannot meet CLI-06** (P). Blocks: CHO-04 (needs a spike first); not *start*.
- Evidence: plan `:176-186` says "use current official CLI documentation", with no mechanism. Local `--help` (versions below): Claude Code 2.1.282 has `--resume`, `--session-id`, `--fork-session`, `--input-format stream-json` and `--permission-prompt-tool`. Codex 0.156.1 `exec` has `resume <ID>` and `--json` but no interactive approvals (`--approve-for-me`, sandbox modes only). Interactive approvals need the experimental `codex app-server` (JSON-RPC over stdio/ws, with `generate-ts` and `generate-json-schema`). Muse 1.4.14 has `--session-id`, `resume` and `serve` (MSP over stdio).
- Current code defeats resume. Claude is started with `--no-session-persistence` (`bridge.mjs:580`, `:634`), and every turn is a fresh process fed the last 6 messages as pasted text (`bridge.mjs:533-561`, `:721-1077`). Today's "history" is not a native session, so AC-03 cannot pass.
- Correction: CHO-04 starts with a 1-slice spike per candidate controller that produces a capability-matrix row (CLI-02) with evidence for resume, cancel, streamed tool calls and approval. Claude's route is most likely persistent stream-json plus `--permission-prompt-tool` (or per-turn `--resume`). Codex's is `app-server`, which is experimental, so budget for its schema churn. If it is not stable enough, the spec's own CLI-06 fallback applies: restrict Codex to a non-interactive, sandboxed mode and say so. Record that as a decision, not a surprise at M2.
- Not a blocker for CHO-01..03, but CHO-03's "native reference persistence" assumes the answer, so the spike belongs before CHO-03 step 2.

**F3. The native toolchain and host-bundling decision are unplanned, though M1 depends on them** (P). Blocks: M1, so CHO-02 slices 02-c/e; and it should be known before 02-a.
- Evidence: `cargo`/`rustc` are not on this machine (no PATH entry, no `~/.cargo`). `apps/desktop/src-tauri/` has no `icons/`, no `Cargo.lock` and no `gen/`. `tauri.conf.json` has no sidecar/`externalBin`/`resources` section, and `csp` is `null` (`tauri.conf.json:22`), `targets: "all"` (`:27`). `Cargo.toml` declares an unused `tokio`. `capabilities/default.json` is `core:default` only. The shell has never been compiled here, so its build state is unknown.
- `src-tauri/src/lib.rs` runs `Command::new("node")` per call (`:15`) with a cwd-relative `import("./server/bridge.mjs")`. It needs global Node and a source tree. It registers only `discover_harnesses` and `orch_dashboard` (`:46`), but the UI calls many more through `callHost`, so most of the UI fails natively with "command not found".
- The plan says "package early" (M1, 02-e) but P0 has no step for Rust/MSVC/WebView2/NSIS-or-MSI tooling, and does not decide how Node ships: a bundled `node.exe` sidecar, Node SEA, or a packaged executable. This choice changes the host's file layout and the update story, so it should be made before the 02-a protocol is fixed.
- Correction: add a pre-CHO-02 "native build smoke" step: install the toolchain, run `tauri build` on the unmodified shell (expect failures; the list of failures is the output), and record the bundling decision. Do this *before* committing to 02-b extraction work so the host layout is settled.

**F4. CI policy produces a false green for desktop changes, and the workflow plan is too thin about it** (C/P). Blocks: trusting any CHO-01+ merge; handled partly by 01-s1/01-s4.
- Evidence: `.github/workflows/test.yml` runs only inside `orch/` (`npm ci` against `orch/package-lock.json`). `orch/tools/ci-policy.json:39-40` lists `packages/**` and `apps/**` as ignored paths. A change touching only `apps/**` therefore triggers *no* check and reports success. The root workspace is never installed in CI.
- The plan has this (01-s4) but orders it after 01-s2/s3 and outside the first batch (`IMPLEMENTATION_PLAN.md:223-235`). Between 01-s1 and 01-s4 every desktop change can merge unchecked.
- Correction: merge 01-s1 and the minimal selection change into one slice (or sequence 01-s4 immediately after 01-s1), and add to P0.1 that the baseline commit includes the root workspace lockfile. Keep the inherited Grok adapter change as a separate commit (see F8).

**F5. The first batch is mostly ceremony relative to the risk it removes** (P, proportionality). Blocks: nothing hard; costs schedule and review capacity.
- Evidence: plan `:223-235` front-loads P0.2 (private profile, Aider model settings with edit format and weak/editor-model inspection), P0.3 (disposable fixtures per Aider route, Muse implement/review check, OpenCode reviewer qualification), then 01-s2/01-s3 (a doc and example cleanup), all before the first persistent-host work.
- Why it is heavy: the Aider adapter already forbids `--edit-format`, `--weak-model`, `--editor-model` as owned flags (`orch/src/adapters/aider.mjs`), refuses review (`:101-102`), and reports `actual_model: null` (`:209`), so each Aider slice yields little attribution evidence. Slices eligible for a single-file local worker are small, so the local lane (serial) is idle most of the time. Qualifying two Aider routes plus OpenCode reviewers up front buys capacity for work that is not yet defined.
- Correction: qualify only what the first slice needs. Muse alone can run 01-s1 and the CI-selection slice. Qualify the first local route lazily, when the first genuinely mechanical single-file slice exists. This follows the owner principle: smallest sufficient action.

### P2 — correct during the named work package

**F6. Reviewer independence is only as strong as the model ids it can see** (C/P). Blocks: release claim of "independent review" (AC-08/ORCH-05); not *start*.
- Evidence: `orch/src/models.mjs:12-19` (`canonicalId` strips the provider prefix and lowercases). `familyOf` uses the roster family or a leading-letters heuristic (`:49-56`). So `openai/X` and `igm-local/X` canonicalize to the same id and are correctly refused as the same model. But Aider's actual model is always null, and the Claude/Muse adapters record the *requested* selector. The spec's CLI-03 ("requested is not proof of served") is therefore honoured by the data model but not yet by the plan's reviewer-pairing logic: the plan assigns "Muse review" of Aider/dspark work without saying how a Muse route is shown not to be the same underlying family as the Lucebox/Kyojin routes.
- Correction: in P0.2/P0.3, record for each route its roster `family` explicitly (not the heuristic), and mark Aider output "served model unknown". The review UI must display "requested" and "reported" separately (spec ORCH-05 already says this). Accept "unknown" as unknown; do not treat it as evidence of independence.

**F7. The native approval/permission posture is the opposite of the spec** (C). Blocks: CHO-04 exit, release; not *start*.
- Evidence: Claude `bypassPermissions` (`bridge.mjs:580`, `:634`), agy `--dangerously-skip-permissions`, grok `--approval-mode full-auto`, Muse `--approval-mode never --trust-workspace`, Copilot `--allow-all-tools`, vibe `--auto-approve --trust`, opencode with no sandbox (all `bridge.mjs:563-719`). Every harness in `HARNESS_CATALOG` (`bridge.mjs:53-168`) advertises roles chat/controller/worker/reviewer, regardless of evidence.
- Correction: SEC-03/CLI-06 already say this. Add one plan sentence: until a controller has a qualified approval path, the UI exposes it as read-only chat only, and the catalog's role list is derived from qualification receipts, not hard-coded. Antigravity and Grok currently appear as controllers with no evidence; `CLAIMANTS` (`orch/src/claims.mjs:21`) does not even contain agy or grok (or aider), so they cannot claim. The "evaluate Antigravity" item (CHO-04 step 5) needs either a coordinator change or a decision to leave it chat-only.

**F8. Baseline-checkpoint commit scope is under-specified** (P). Blocks: P0.1 exit.
- Evidence: the dirty tree combines desktop additions with an inherited Grok adapter integration (`orch/src/adapters/grok.mjs` + test, `hooks/rules.mjs`, `adapters/index.mjs`, `mcp.mjs`, `setup-health.mjs`, `setup.mjs`, roster/config examples, `.gitignore`, `README.md`). The plan says to review them separately but not what the commit boundaries are.
- Correction: three commits: (a) the desktop workspace (`apps/`, `packages/`, root `package.json` + lockfile), (b) the coordinator Grok integration, (c) CI selection. Verify (a) from a fresh worktree with `npm ci` plus `npm test`. Do not rely on this review worktree, which lacks (a).

**F9. Spec baseline claim does not reproduce** (P). Blocks: nothing; fix the doc.
- Evidence: `docs/PRODUCT_SPEC.md:56` says the local work "passed a frontend build, typecheck, and 12 package/UI tests". I ran the suite: acp-client tests passed, but the desktop test "discovers all 8 harnesses…" in `apps/desktop/src/bridge.test.ts` FAILED on a 5000 ms timeout (1 failed, 6 passed in the desktop package). Cause: a cold `discoverHarnesses()` takes about 3.5 s because it blocks synchronously on `agy models` (`bridge.mjs:267-294`, `spawnSync … timeout 3500`). Warm calls take about 1 ms. Typecheck passed. `npm run test:orch` passed, 61/61.
- Correction: restate the baseline as measured, and treat the cold-discovery stall as a CHO-02 item (a synchronous 3.5 s block on the host event loop would stall streaming in a single-process host; the UI polls the dashboard every 3.5 s).

**F10. Existing acceptance UI contradicts ORCH-07/AC-09 and is not scheduled for removal** (C). Blocks: M3 credibility; trivial to fix early.
- Evidence: the "Record accepted" button (`apps/desktop/src/App.tsx:1551`) sends `disposition: "accepted"` with the note "Accepted via CHO-desktop" (`:736`); `orch_record` defaults to `accepted` in `handleBridgeCommand` (`bridge.mjs:1457-1548`). It writes a ledger entry with no review convergence check.
- Correction: rename or disable it in CHO-01 or 02 (a one-line UI change), not in M3.

### P3 — current-code defects the plan already routes, listed so they are not lost

These are real, confirmed by reading, and covered by existing work packages. They are listed for the corrected batch, not as additional blockers.

- **Prompt truncation drops the user request.** `bridge.mjs:747` slices the prompt to 11,500 chars (Copilot) and `:749` to 29,000 (agy). The user's latest request is at the *end* of the prompt, so the slice removes the request itself while keeping the preamble. (CHO-02/04.)
- **Unauthenticated listener.** `bridge.mjs:1603` binds `0.0.0.0` with `Access-Control-Allow-Origin: *` (`:1556`); `scripts/dev.mjs` also runs Vite with `--host 0.0.0.0`. Any LAN peer can POST `/api/invoke`. Interim mitigation worth doing *now*, before the rewrite: bind `127.0.0.1`. (SEC-01.)
- **Workspace fallback.** `bridge.mjs:568` falls back to `REPO_ROOT` (the CHO source tree) when the workspace is invalid, so a bad path runs an agent in the product's own checkout (SEC-02).
- **Process map keyed by `sessionId` only** (`bridge.mjs:766`); a second turn overwrites the first's entry, so cancel can target the wrong process, and kill is `proc.kill()` on the child only (no tree kill on Windows).
- **No event cursors or persistence.** Events go to SSE clients only (`broadcastEvent`); a closed window loses `turn_complete`, and the child keeps running.
- **`packages/acp-client` is misnamed and unused by the bridge.** It contains NDJSON framing and `normalizeHarnessEvent`, not an ACP client. It never emits `tool_result` or `permission_request` although the types declare them, and does not cover vibe, opencode or agy. The bridge does not import it, so parsing is duplicated. (CHO-04 step 1 covers the dedupe; renaming is optional.)
- **Hard-coded environment.** `App.tsx` defaults to `C:\\dev\\CHO-desktop` and the agy harness; `discoverRepositories` (`bridge.mjs:1095-1152`) scans siblings of `REPO_ROOT`, which cannot work in an installed app. `bridge.test.ts` asserts a repo named `CHO-desktop` exists, so it depends on the checkout's directory name and reads real orch state and the real PATH.
- **Unused trust store writes into another tool's directory.** `isWorkspaceTrusted`/`setWorkspaceTrusted` write `~/.grok/desktop-trusted-workspaces.json`. Grep finds no UI use. Delete rather than harden.
- **UI sessions live in `localStorage`** (`cho-desktop.repo-sessions.v2`); drafts are not persisted (SESSION).
- **`tauri.conf.json` `csp: null`**, `core:default` only capabilities. (SEC-07.)
- **Doc inconsistency.** `orch/THIRD_PARTY.md` says the MCP SDK is test-only at 1.30.1, while `orch/package.json` lists `@modelcontextprotocol/sdk` 1.32.0 under `dependencies`. Matters for the CHO-07 attribution notice, trivial to fix.

## 3. Pass-by-pass notes

**Product design and scope.** Scope is realistic once the controller count is two. "Two real continuing controllers" (M2) is the single most expensive commitment; do not widen it. The spec correctly defers LAN companion and the extra harnesses. Nothing needs cutting. One addition: state which controllers *ship* as chat-only. The catalogue lists eight harnesses; the release matrix should say which are chat-only, which controller-qualified and which unsupported.

**Architecture and feasibility.** The dual transport (browser SSE vs Tauri `invoke`/`listen`) is sound as a compatibility layer, but the Tauri side is currently a one-shot process per call and cannot hold `activeChatProcesses` or an event stream (`lib.rs:15`). That makes 02-c a rewrite of the Rust host, not a wiring change. Plan it as such. A persistent host that is also a Node child is feasible, but see F3.

**Execution plan.** Milestone order is correct. The two changes are in section 5. Slice sizes in CHO-02 ("do not assign all of them in one slice") are right; `bridge.mjs` at 1,606 lines and `App.tsx` at 1,847 lines are too large to hand a worker whole.

**Workforce (Muse, Aider, Claude, OpenCode, local lane).**
- Aider: the adapter's default lane is `cloud` (`aider.mjs:116`), and the coordinator refuses a local-adapter run off the local lane (`orch/src/commands.mjs:113-117`). The plan's "pass the lane explicitly" is correct. Aider cannot be a reviewer and reports no actual model. Scoped runs use `--map-tokens 0` plus `--file`, so it can only touch named files; the plan's "exact-file handoff" fits.
- Muse: the adapter uses `--approval-mode never --trust-workspace --no-session-log`; review adds `--disable-write --disable-shell`. Muse as reviewer for Aider output is plausible but unproven locally (I ran only `--help`).
- Claude reviewer tools are Read/Grep/Glob: a tool restriction, not an OS sandbox.
- Reviewer independence: see F6. A requested selector is not proof of the served model, and the plan's wording already says so. Make the data say so too.
- Local lane is serial (one local worker at a time), so "rotate to dspark after the current local work and reviews" is a throughput limit, not a design choice. Do not count the local lane as parallel capacity.
- The development workforce is distinct from the product controllers; the plan states this correctly (`IMPLEMENTATION_PLAN.md:184`).

**Completion and publication.** The release rule "a green source build does not qualify the installer" is right; keep it. Gaps: (1) AC-15 needs the capability matrix of F2 as its evidence, so F2 is also a publication prerequisite; (2) native installed-app verification can only happen on a machine with the toolchain and a clean Windows profile, so schedule one (F3); (3) the licence situation is clean at the root (MIT), but the coordinator provenance document (01-s3) must record the upstream source commit and local modifications, and `THIRD_PARTY.md` must be reconciled (P3 above); (4) the spec's privacy stance (no telemetry, no credential collection) is not contradicted by the code except for the `~/.grok` write.

**Adversarial scenarios.**
*Multi-turn / restart.* Turn 1 in session S streams. User closes the window mid-turn. The browser store keeps the transcript, but the native CLI session was never persisted (`--no-session-persistence`), the child process keeps running with nothing reading it, and `turn_complete` is lost with no cursor to replay. On reopen, turn 2 spawns a fresh CLI with the last 6 messages pasted as text. For Copilot and agy, the prompt tail is sliced and the request may vanish (`bridge.mjs:747-749`). The user sees a plausible answer with no actual continuity. Expected by the plan (CHO-03). Observable test: AC-03/AC-04. Nothing in the first batch prevents anyone from calling this "working".

*Delegate / review / accept / recover.* `startAgentTask` claims, then `worktree_create` fails (`agent-task.ts:22-40`). The claim persists; the error message tells the user to "inspect it", but there is no stage record and no resume. If the controller meanwhile runs `orch claim` itself (it is told to, `bridge.mjs:533-561`) it may collide with the owner's claim, or a second claim by another claimant is refused with a coordinator error. After a worker finishes, the review can be launched with an Aider output whose actual model is null, so independence rests on requested ids (F6). Finally "Record accepted" writes the ledger with no convergence evidence (F10). After a host restart, run state is reconstructed from coordinator records only; there is no mapping back to the conversation (ORCH-01). Every step is covered by the spec; the missing pieces are F1 (who may act) and stage persistence (CHO-05 step 2).

## 4. Required corrections vs optional vs unresolved

**Required before starting** (all cheap): F4 (CI selection ordering and root lockfile in the baseline), F8 (commit boundaries), F5 (shrink first batch). F9 is a documentation edit.

**Required before the named package**: F3 before 02-a; F2 spike before CHO-03 step 2 and CHO-04; F1 before CHO-04/05 assignment; F6, F7, F10 inside their packages.

**Optional improvements**
- Bind the dev bridge to `127.0.0.1` and drop CORS `*` immediately, ahead of the full SEC-01 work (about two lines, large risk reduction).
- Rename `packages/acp-client` to what it is.
- Delete the unused Grok trust store functions.
- Make `discoverAgyModels` asynchronous and cached; fix the cold-discovery test timeout.
- Derive `HARNESS_CATALOG` roles from qualification receipts.

**Unresolved decisions for the owner**
1. Node-sidecar packaging approach (bundled `node.exe`, SEA, or compiled executable). Affects installer size and update path.
2. Whether Codex ships interactive (via experimental `app-server`) or restricted (non-interactive sandboxed `exec`).
3. Whether Antigravity/Grok are chat-only for v0.1 or get coordinator `CLAIMANTS` support.
4. Whether the controller may ever invoke `orch` directly (my recommendation: no; host-mediated only, F1).
5. Windows signing: the plan defers it ("signing plan"). Unsigned installers trigger SmartScreen; decide whether v0.1 is acceptable unsigned and say so in the README.

## 5. Milestone-order changes

1. Move a **native build smoke** (toolchain, `tauri build` on the existing shell, bundling decision) ahead of CHO-02 and into M0. The plan places packaging at 02-e, after the host has already been extracted. If the packaged layout forces a different structure, 02-b is rework.
2. Move the **per-controller session/approval spike** (F2) from inside CHO-04 to just before CHO-03. CHO-03's native-reference persistence is only designable once the resume mechanism is known. M2 order becomes spike, then CHO-03/04 in parallel.

Everything else (M1 installed conversation, M3 reviewed change, M4 release candidate) can stay.

## 6. Corrected first execution batch

Goal: reproducible baseline, desktop CI that actually runs, a known native-build state, then the host contract. Qualify workers only as each is first needed.

1. **P0.1 (unchanged, three commits per F8):** desktop workspace; coordinator Grok integration; CI selection. Explicit paths, no `git add .`, no push. Exit: a fresh worktree runs `npm ci` and the desktop checks.
2. **Fix the known red test.** One small slice: make `discoverHarnesses` not block the test (cache or async agy model discovery, or an injectable runner), and remove the directory-name assertion in `bridge.test.ts`. The baseline must be green before CI enforces it.
3. **01-s1 + 01-s4 together:** the desktop workflow with root install, typecheck, tests and web build, plus the CI-selection change so desktop paths are no longer ignored. Muse implements; an independent reviewer from a different model family reviews. This is the first and only worker qualification needed.
4. **Native build smoke (new, owner-run or Muse with the owner installing tools):** install Rust/MSVC/WebView2 prerequisites, build the unmodified shell, record failures and the sidecar decision. Output is a short decision note, not code.
5. **Interim safety slice (optional, tiny):** bind the dev bridge to loopback, drop CORS `*`, rename or disable "Record accepted". These are independent of the larger rewrite.
6. **P0.2/P0.3 for the local lane, lazily:** only when the first mechanical single-file slice exists (01-s2 or 01-s3 are plausible). Qualify the one route needed, with Muse as reviewer, then rotate.
7. **02-a** (command/event envelope contract), informed by the build-smoke decision.
8. **Controller session/approval spike** (F2), then CHO-03.

## 7. Checks actually performed

- Read in full: `docs/PRODUCT_SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`, `apps/desktop/server/bridge.mjs`, `apps/desktop/src-tauri/{src/lib.rs, tauri.conf.json, capabilities/default.json, Cargo.toml}`, `apps/desktop/src/lib/{api,agent-task}.ts`, `packages/acp-client/src/index.ts`. Read in large part: `apps/desktop/src/App.tsx`, `apps/desktop/src/bridge.test.ts`.
- Coordinator: `orch/src/adapters/{aider,claude,muse,subscription-cli,index}.mjs`, `orch/src/{claims,review,models,commands}.mjs` (claim/allowlist and lane rules), `orch/src/controller-*.mjs`, `orch/src/repository-controller*.mjs`, `orch/src/mcp.mjs` (structure), `.github/workflows/test.yml`, `orch/tools/ci-policy.json`, `orch/THIRD_PARTY.md`, `git diff` of the dirty coordinator integration.
- Commands run: `npm test` (root workspaces; 1 desktop failure, 6 desktop passes, acp-client passes), typecheck for both workspaces (pass), `npm run test:orch` (61 pass, 0 fail), a timing probe of the bridge (cold discovery 3,538 ms; dashboard 85 ms; repository discovery 23 ms), and CLI `--help` inspection for Claude Code 2.1.282, Codex 0.156.1 and Muse 1.4.14-R7309.1 (native exe only).
- Availability on this machine: claude, codex, aider, opencode, agy, copilot, vibe, git and node 24.11.1 found. Muse is installed (found via `where.exe muse.cmd`) but not on the shell PATH. grok, cargo and rustc are absent.
- Baseline hash manifest `.reviews/sonnet-design-plan-20261030/source-before.json` was used as the pre-review reference.

## 8. What could not be verified

- **Tauri build and the native app.** No Rust toolchain; whether the shell compiles, bundles, or launches is unknown. Everything in F3 about native state is from reading config and source.
- **Any live CLI session behaviour.** I did not run a model turn, resume, approval, cancel or tool call, so the capability claims in F2 come from `--help` text and are unverified against actual behaviour or version drift.
- **Model routes and gateways.** Kyojin Qwen3.8 Flash Next, Lucebox DeepSeek V4 dspark, their endpoints, context limits, Aider edit-format behaviour and quota were not touched.
- **Muse as reviewer.** Its read-only mode flags exist in the adapter; whether it produces a usable blinded review is unproven. OpenCode local reviewer qualification likewise.
- **Installed-app, upgrade, uninstall, clean-machine, signing, SmartScreen behaviour.**
- **Authentication state.** The bridge's `authHint` is file-existence only (`bridge.mjs:203-245`), and I did not test sign-in or model access.
- **Tauri documentation specifics** (sidecar, bundling, icon requirements): drawn from general knowledge and the repo's config, not freshly retrieved. Confirm against current official docs when F3 is executed.
- **Remaining unread areas:** `orch/src/gate.mjs`/`worktrees.mjs` behaviour in detail, `docs/CLI_GUIDE.md`, the opencode/grok adapters, README claims. No finding here depends on them, but they could add detail to F5/F8.

## 9. Key files examined

`docs/PRODUCT_SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`, `apps/desktop/server/bridge.mjs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src/App.tsx`, `apps/desktop/src/lib/{api,agent-task}.ts`, `apps/desktop/src/bridge.test.ts`, `packages/acp-client/src/index.ts`, `orch/src/adapters/{aider,claude,muse}.mjs`, `orch/src/{claims,models,review,commands,mcp}.mjs`, `orch/src/controller-*.mjs`, `.github/workflows/test.yml`, `orch/tools/ci-policy.json`.

*Source files were not changed by this review.*
