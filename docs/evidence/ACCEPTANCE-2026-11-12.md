# Completion candidate acceptance ledger

Source checkpoint `be49418`; 2026-11-12. Requirements are unchanged.
Evidence levels are deliberately separate; no whole-release PASS is asserted.

| AC | Current state | Evidence / remaining action |
| --- | --- | --- |
| AC-01 | Open | Clean Windows install; CI installed smoke is narrower. |
| AC-02 | Source checked | No-fallback/readiness contracts; fresh installed CLI/auth/version acceptance remains. |
| AC-03 | Partial live | Codex and Claude two-turn native identity/history/draft continuation across source host restart pass; installed tool-using journey remains. |
| AC-04 | Partial | Browser switching/empty draft and native draft restart pass; installed streaming switch/restart remains. |
| AC-05 | Open live | Durable permissions tested; actual release reject/cancel/restart journey remains. |
| AC-06 | Source checked | Conversation-bound preparation and run admission tested; live release delegation remains. |
| AC-07 | Source checked | Recovery stages and uncertainty tested; live disconnect journey remains. |
| AC-08 | Source checked | Exact review/run/Git-tip and gate checks; live independent review journey remains. |
| AC-09 | Source checked | Explicit accept/integrate/discard/finish semantics and failure tests; installed journey remains. |
| AC-10 | Source checked | Owned process identity/cancellation checks; live unrelated-session journey remains. |
| AC-11 | Source checked | Strict IPC, admission and network refusal regressions; release scan passes. |
| AC-12 | Partial rendered | 80 Chromium fixture checks; real WebView2/IME/OS scaling remain. |
| AC-13 | Open installed | Migration backup/lock/failure protections tested; clean upgrade/recovery/uninstall remains. |
| AC-14 | Awaiting hosted candidate | Pipeline builds exact checkout, verifies runtime/artifacts, runs installed smoke and retains diagnostics. Hosted result and hashes must be recorded. |
| AC-15 | Partial | Current support claims reconciled; final release qualification receipts remain. |

Nonblocking independent-review follow-ups: add a conflict-producing browser
fixture/journey, align fixture IDs with UUID validation, improve best-effort
send-clear conflict feedback, add a Codex hydrate field-presence assertion and
a no-tools clarification probe case, and retain child-environment diagnostics
on the installed smoke refusal path. None was a confirmed blocking regression.
The generic scrolling sidebar fix passed the measured viewport suite; native
footer/keyboard usability still belongs to AC-12.

The generated-manifest and wire reviews used immutable exact commits but their
original global-ref containment alarms were retained: unrelated Codex host refs
and an old branch deletion changed the source repository's ref inventory. These
are not described as clean-contained reviews. The final UI, probe, CI wiring and
installer-correction independent reviews completed with clean containment.
Action tags questioned from stale model knowledge were verified directly in the
official action repositories; no downgrade was needed.

Private traces, fixture paths and raw provider transcripts remain private.

Existing Cargo lockfile alert: `glib <0.20.0` (GitHub Dependabot #2).
The Windows x64 target has no `glib` dependency (`cargo tree --locked --target
x86_64-pc-windows-msvc -i glib` prints no dependency). Keep this as a non-Windows
dependency follow-up; the zero-vulnerability statement above refers to npm.
