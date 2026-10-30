# Controller notes on the Sonnet design/plan review

Date: 2026-10-30  
Review: [Sonnet's original report](SONNET-DESIGN-PLAN-REVIEW.md)  
Run: `20261030-101131-a57928`; observed model: `claude-sonnet-5-5`; requested effort: high.

The original report is preserved without edits. These are initial checks on its recommendations, not a revised specification, an implementation gate, or a claim that every finding has been adjudicated.

## Useful corrections to carry into plan revision

- Specify an enforceable host/controller boundary for delegation approval. A prompt instructing a shell-capable controller to use `orch` does not establish that boundary. The precise mechanism still needs a design decision; stripping all controller shell capability is one proposal, not an automatically accepted requirement.
- Investigate each proposed controller's native resume, streaming, cancellation, and approval mechanism before freezing native-session storage contracts. The review inspected help output; actual behaviour still needs bounded qualification.
- Establish native toolchain/build readiness and the runtime-bundling approach early, before investing heavily in host extraction. The review did not build or launch Tauri.
- Ensure the first desktop CI change actually checks the desktop. Stage worker qualification only when needed, while retaining the independent review required for the first real slice.

## Findings that need correction or qualification before incorporation

1. **F6 overstates the attribution defect.** The Claude adapter's `postExit` extracts the main assistant message's model, with a single-model usage fallback; Muse's `postExit` binds a runtime model event to session/run evidence. They do not merely substitute the requested selector as the actual model. See [Claude adapter](../../orch/src/adapters/claude.mjs) and [Muse adapter](../../orch/src/adapters/muse.mjs). Aider's unknown attribution and the need to establish reviewer independence remain valid concerns.
2. **F8's proposed commit order is not sufficient as written.** The current desktop bridge imports the new Grok adapter. A desktop-only checkpoint made before its required coordinator dependency would fail in a fresh worktree. Establish a dependency-complete baseline: include the prerequisite first or group the necessary changes explicitly. Do not apply the report's three-commit sequence mechanically.
3. **F4 identifies a real desktop coverage gap, but the mechanism matters.** The inherited workflow does run coordinator commit checks; it does not check the desktop. An independent desktop workflow with appropriate triggers can close the gap without necessarily changing the inherited integration-selection policy. Validate the resulting checks instead of requiring an unnecessary coordinator-policy rewrite.
4. **F5's smaller first batch still needs an independent review route.** A Muse implementation cannot review itself. Qualify the first implementer/reviewer pair just in time; do not interpret "Muse alone" as permission to omit independent review. Qualifying every local implementation/review candidate in advance is unnecessary.
5. **F9 does not disprove a dated historical pass.** The specification says the last local checks passed, not that they always will. The review observed a new cold-discovery timeout. Preserve both observations and address the nondeterministic, environment-dependent test rather than rewriting the history as a false claim.
6. **F7's claimant suggestion depends on the ownership decision in F1.** If the host owns coordinator claims, exposing an Antigravity/Grok conversation need not require new claimant identities for those CLIs. Do not add claimant types merely because the UI has another harness.

## Verification and limits

- The retry completed with exit code 0, and the coordinator recorded actual model `claude-sonnet-5-5` from native evidence.
- `orch scope` passed: the isolated worktree contains only the requested new review report.
- A before/after hash check matched all 241 original tracked/non-ignored source files before copying this report into `docs/reviews/`.
- The review's checks reported a native-discovery test timeout, passing workspace typecheck, and 61 passing coordinator-subset tests. This is not installed-app qualification or a substitute for the complete coordinator suite.
- No implementation, specification, or plan changes were made as part of collecting this audit. The added review documents are uncommitted.
- The earlier authentication-blocked attempt remains subject to the separately documented coordinator terminal-status bookkeeping defect; its evidence/worktree are retained rather than force-cleaned.
