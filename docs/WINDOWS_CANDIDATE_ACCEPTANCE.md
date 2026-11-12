# Windows Candidate Acceptance (owner-executed)

Status: **NOT qualified.** No install/upgrade/uninstall or clean-machine run
has been recorded for any candidate built by
[`windows-candidate.yml`](../.github/workflows/windows-candidate.yml).
Every result field below is blank until an owner executes the procedure on a
real machine and fills it in. Do not mark any row PASS without observed
evidence.

## Evidence levels

| Level | Meaning | Produced by |
| --- | --- | --- |
| built-local | Commit built; artifact hashes recorded; staged runtime bytes match checked-out source | CI workflow + [`candidate-receipt.json`](../apps/desktop/scripts/release-receipt.mjs) |
| installed | App installed, launched, and exercised on a real Windows machine | This procedure (owner) |
| clean-machine | Installed level on a clean Windows account/machine with only documented prerequisites | This procedure (owner), Procedure A/B/C clean-machine variant |

A `built-local` receipt never implies `installed` or `clean-machine`. The
receipt verifier refuses receipts that claim a stronger level.

## Prerequisites for the acceptance machine

- Windows 11 x64, clean local account (no developer Node/Rust toolchains).
  Do NOT install developer Node or a source checkout on the clean machine to
  satisfy acceptance: installer verification here uses native PowerShell
  only. Source/runtime receipt verification happens on the CI/build host
  (the workflow's "Verify candidate receipt" step), not on this machine.
- Documented prerequisites only: Git and the CLIs under test, with native
  sign-in already completed outside CHO.
- The candidate under test: `windows-candidate-<sha>` workflow artifact
  (`candidate-dist/`), containing the installer(s), `candidate-receipt.json`,
  and `SHASUMS256.txt`.

Record first:

- Candidate commit SHA: _______________
- CI "Verify candidate receipt" output for that SHA (paste; this is the
  source/runtime verification — it runs on the build host, never here): _______________
- Machine description (VM/physical, Windows build, account type): _______________
- Date / operator: _______________

## Procedure A — install and first launch (AC-01)

1. Verify the installer hash against `SHASUMS256.txt` with native
   PowerShell only (example: `Get-FileHash -Algorithm SHA256 <installer>`).
   No Node install and no source checkout are needed or allowed for this step.
2. Install. Note any SmartScreen / unsigned-build warning verbatim; the
   candidate is unsigned unless stated otherwise in the run.
3. Launch CHO from the Start menu (no terminal, no source checkout, no global
   Node, no dev server).
4. Observe: backend readiness indicator, CLI discovery list, guidance for any
   missing CLI / expired sign-in / unsupported version.
5. Open a repository via the native folder picker, select a controller, start a
   conversation, send one message.

Evidence fields (fill per run; leave blank if not observed):

- Installer file + SHA256 match (yes/no, actual hash): _______________
- Install warnings shown (verbatim): _______________
- App launched without terminal/checkout/global Node (yes/no): _______________
- Bundled host healthy (yes/no, how observed): _______________
- CLI discovery result per installed CLI: _______________
- Conversation round-trip result: _______________
- Verdict: _______________ (PASS / FAIL / NOT RUN — no other value)

## Procedure B — upgrade with existing sessions (AC-13 happy path)

1. With candidate N installed, create at least one conversation with a draft
   and one persisted turn.
2. Locate the application data directory (Tauri app-local data dir for
   identifier `dev.cho.desktop`, subdirectory `host-state`; confirm the exact
   path on the machine, do not guess a user profile path) and take a file copy
   backup: record the backup location.
3. Install candidate N+1 over N (manual upgrade path).
4. Launch and confirm: previous conversations, drafts, and turns are present
   and unchanged; no schema-downgrade error; app is usable.

Evidence fields:

- From/to commits: _______________
- Backup location + byte count: _______________
- Sessions present after upgrade (count + spot-check): _______________
- Verdict: _______________ (PASS / FAIL / NOT RUN)

## Procedure C — migration failure preserves recoverable data (AC-13 failure path)

Run this procedure ONLY on a fresh disposable acceptance profile/data copy
(for example a dedicated acceptance test account). Never run migration-failure
simulation against personal sessions or a personal data directory.

1. Close the app. Copy the acceptance data directory to a backup location
   (record it). This backup is the recovery source; never operate without it,
   and keep it untouched for the whole procedure.
2. Simulate an unmigratable store on the disposable copy only: restore a
   single store file from an older incompatible backup, or truncate a copy —
   record exactly which file was altered and how.
3. Launch the candidate. The required behavior: the app must NOT silently
   discard or overwrite the previous data; it must surface a recovery message
   explaining what failed and where the prior data lives.
4. Restore the step-1 backup over the disposable copy, relaunch, and confirm
   prior sessions return. Personal sessions are never involved at any step.

Evidence fields:

- Disposable acceptance profile used (never personal): _______________
- Backup location (untouched): _______________
- Altered file + alteration method: _______________
- App behavior on failed migration (verbatim message / screenshot path): _______________
- Prior data preserved (yes/no, how confirmed): _______________
- Restore + relaunch result: _______________
- Verdict: _______________ (PASS / FAIL / NOT RUN)

## Procedure D — uninstall

1. Uninstall via Windows Settings. Record whether application data is retained
   or removed, and the exact wording shown.
2. If data is retained, record its location. Data removal, if offered, must be
   an explicit separate action — confirm it is / is not.

Evidence fields:

- Uninstall result: _______________
- Data retained at (path) / removed (how confirmed): _______________
- Verdict: _______________ (PASS / FAIL / NOT RUN)

## Qualification statement

AC-01 and AC-13 are met only when Procedures A–C each have a recorded PASS
with filled evidence fields on the documented clean environment, for the same
candidate commit. Until then, the release is not qualified and the support
matrix must not claim otherwise (AC-15).
