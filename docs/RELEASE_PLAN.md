# CHO Desktop beta to v0.1 release plan

Updated: 2026-11-12. Product scope and AC-01–15 in
[PRODUCT_SPEC.md](PRODUCT_SPEC.md) remain unchanged. This plan supplements the
[implementation plan](IMPLEMENTATION_PLAN.md), not a declaration that all
acceptance criteria have passed.

## Current baseline

- PR #3 merged at `d0a50cd`. Its source tree is identical to the CI-built PR
  merge candidate `11634aab63a54556c54c92d0db7ad5b898aaa3ea` (tree
  `b6bdc01fd290ee46090b226ae65b50fea906839b`). Later beta documentation does
  not change application code.
- Tested PR head `5bf95fb`: Desktop CI and the selected coordinator matrix pass.
  [Windows candidate run](https://github.com/vkotios/orch-desktop/actions/runs/43290366546)
  built EXE/MSI/NSIS, verified provenance/runtime contents and passed installed
  NSIS startup, bundled-host ping/shutdown, uninstall and owned-path cleanup.
- All three downloaded artifact hashes match the receipt. The installed smoke
  hides global Node and poisons Node environment options. The runner still has
  developer tools; it is not clean-Windows or interactive WebView2 acceptance.
- Local evidence: 843 desktop + 44 shared tests, 80 browser journeys, 15 Rust
  tests, 106 focused coordinator checks, typecheck/build and release scan pass;
  116 staged runtime files match source. Real Codex/Claude owned source-host
  restart probes pass. Source-host restart is narrower than restarting the
  installed desktop application.
- Development routes are Muse Spark 1.3 and Vibe `zai-glm-5-3-flash`; DeepSeek
  is disabled. These are development workers, not a promise about every product
  runtime route. Existing Codex/Claude CLI login is the current product boundary.

## Delivery gates and ownership

| Gate | Deliverable and exit | Ownership |
| --- | --- | --- |
| 1. Public source beta | Merge reviewed source, publish the repository, label beta and retain accurate limitations | Controller; explicitly authorized by owner |
| 2. Downloadable binary beta | Choose beta tag and monotonic Windows package versions; build the exact tagged candidate; publish a GitHub prerelease with installers, checksums, receipts and known issues | Controller prepares; owner directs binary publication |
| 3. Clean Windows qualification | Fresh install, launch, upgrade, migration failure/recovery and uninstall with preserved sessions | Owner supplies clean Windows environment; controller automates owned checks where possible |
| 4. Installed product journeys | Real Codex/Claude permissions/recovery, delegated change/review/integration, and WebView2 usability/scaling | Controller plus owner for login, interactive confirmations and device checks |
| 5. Stabilization and release candidate | Repair blockers, independently review changes, rerun relevant checks and rebuild a source-bound candidate | Controller using approved independent workers/reviewers |
| 6. Stable distribution | Code signing, timestamped final assets, final checksums, release notes and AC-01–15 sign-off; publish stable release | Owner supplies signing access and release approval; controller executes authorized publication |
| 7. Maintenance | Triage beta reports, issue patch candidates, maintain dependency/CLI compatibility evidence and regression coverage | Maintainer/controller |

Publishing this repository as beta completes gate 1. It does not create a
GitHub binary prerelease, sign an installer or close the remaining gates.

## 2. Prepare the first tagged binary beta

1. Reconcile the current app version (0.1.0), beta tag and MSI/NSIS upgrade
   numbering before choosing the first binary beta version. Keep the app
   identifier and installer upgrade identity stable. Verify beta-to-beta and
   beta-to-stable upgrade ordering; do not assume a semver suffix is sufficient
   for Windows installers, or relabel an existing binary as a different version.
2. Freeze the candidate source, record the reviewed commit and approved runtime
   manifest, and run the candidate pipeline. Fix any real failures before upload.
3. Produce EXE, MSI and NSIS installers, candidate receipt and SHA-256 sums.
   Preserve upstream attribution and bundled Node's license. Keep credentials,
   local databases and raw provider transcripts out of source and artifacts.
4. Draft the GitHub prerelease: Windows x64 target, required installed CLIs/login,
   unsigned status if applicable, install/upgrade/data-retention instructions,
   known gaps and a redacted bug-report procedure. Upload only source-bound
   artifacts. Use prerelease status, not a stable-release designation.
5. Record tester receipts against that exact candidate. An unsigned experimental
   beta can be clearly labeled; stable polished Windows distribution needs the
   signing work below. Public source does not depend on obtaining a certificate.

## 3. Clean Windows and data lifecycle (AC-01/02/13)

Use a fresh Windows 11 x64 VM or physical machine and retain a snapshot/backup.
No checkout, developer server, global Node or Rust should be needed to launch.
Install WebView2 only through the documented product prerequisites/installer.

- Test NSIS and MSI separately with an ordinary user account. Record Windows,
  WebView2, installer and CLI versions and the candidate hashes.
- Test missing CLI, expired sign-in, unsupported version and inaccessible model:
  useful guidance, no manufactured readiness or automatic provider/billing fallback.
- Create conversations and drafts, upgrade from the previous supported beta,
  and check native identity, history and preferences. Deliberately fail migration
  on an owned copy; prior data and the backup must remain recoverable.
- Test uninstall and reinstall against the documented data-retention behavior.
  Refuse unsupported downgrades; document recovery. Offline store restoration is
  a maintenance operation, not a promised in-app restore wizard.

## 4. Installed user journeys (AC-03–12)

Use the installed candidate, real supported CLI versions and owned test projects.
Never use an unrelated user session as a cancellation/recovery fixture.

- **Conversation/recovery:** multiple tool-using Codex and Claude turns; close and
  reopen the desktop; continue the same native session with its real context.
  Switch projects/chats during streaming, save and clear drafts, and recover
  missing display events once without replaying execution commands.
- **Permissions:** approve once, deny, answer clarification questions, cancel,
  and restart. Denied work must not run; stale approvals and duplicate turns
  must not reappear. Uncertain ownership must remain explicit.
- **Delegation:** approve scope, prepare claim/worktree, launch one worker,
  verify scope/tests, request an independent-model review, inspect actual review
  and diff evidence, then exercise Accept, Integrate, Finish and Discard.
  Verify exact reviewed-tip/gate checks and stale-preview refusal. Accept must
  not secretly merge; Finish/cleanup must remain distinct from integration.
- **Failures/isolation:** disconnect during preparation/execution, restart with
  a stranded turn, cancel while unrelated CLI sessions run, and inspect/adopt or
  abandon uncertainty without duplicate launch or destructive automatic cleanup.
- **WebView2/usability:** actual native window at supported sizes, keyboard and
  focus, IME, long code/diffs/history, 100%/125%/150% Windows scaling and monitor
  changes. Browser viewport approximations do not qualify OS scaling.
- **Transcripts/security:** import/export, later native continuation, paging
  beyond 500 turns and truthful truncation; refuse malformed IPC, invalid
  workspaces and unauthorized network requests without exposing private details.

## 5–6. Stabilization, signing and stable release

Treat data loss, unauthorized execution, wrong-session ownership, unsafe process
cancellation and broken install/upgrade as release blockers. Repair confirmed
failures, add meaningful regression coverage, independently review the changes,
then rebuild and repeat the affected candidate-bound qualification. Nonblocking
coverage/doc improvements stay tracked in the acceptance ledger.

Keep npm and Cargo assessments distinct. The existing glib lockfile alert is
outside the Windows target dependency tree; track it before any non-Windows
product claim. Coordinator tests on other operating systems do not qualify the
CHO desktop app there. Verify supported CLI versions and roles before advertising
new runtime routes.

Before the stable candidate, align the coordinator push-CI branch filter with
the actual default branch: it currently filters `main`, while the active default
is `codex/cho-v01-foundation`. PR checks already cover the merged delivery;
future default-branch pushes should also select the intended checks. Renaming
branches is not required to publish this source beta.

For the stable candidate:

1. Freeze source, app/package versions and the support matrix. All AC-01–15 must
   have release-configuration receipts or an explicitly approved scope amendment;
   incomplete criteria do not become PASS merely because code/tests exist.
2. Obtain signing access from the owner, sign/timestamp the final Windows
   artifacts and run the installed checks against those signed bytes. Generate
   final checksums after signing; unsigned-candidate hashes are historical.
3. Obtain owner release acceptance, tag the exact source, and publish stable
   installers, checksums, provenance, release notes, requirements, known issues,
   upgrade/recovery guidance and support/security reporting instructions.
4. Retain the prior installer and migration backups/procedures for recovery;
   avoid unsupported database downgrade or silent overwrite during rollback.

## 7. Beta and post-release maintenance

Collect minimal redacted repros (candidate hash, OS/CLI versions, steps, expected
and observed behavior), prioritize blockers, and ship source-bound patch
candidates through the same review and relevant acceptance gates. Keep raw
credentials/session data private and use private vulnerability reporting for
security-sensitive reports. Review dependency and CLI compatibility changes;
expand platforms only after separate installed-product qualification.

No stable date is promised before the remaining machine, signing and user-journey
receipts exist. The next useful action is a versioned binary beta plus clean
Windows and installed-workflow testing, not another general source audit.
