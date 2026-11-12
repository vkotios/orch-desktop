# Controller adjudication of the Opus review

Audit: [Opus 5.5 medium report](OPUS-5.5-REVIEW-2026-11-11.md), candidate
`4e093711be6ab758f61ba85e7c2a105be0879965`, run `20261111-213241-139d9d`.
Main-agent messages verify `claude-opus-5-5`; launch arguments verify medium
effort and Read/Grep/Glob/Edit/Write/Bash. The report-only run used the implementer
tool profile for the owner's full tool-access request. Scope passed: only the
report was created. This is source review, not a live delegated-change journey.

All eleven findings were confirmed and repaired:

| ID | Repair | Controller regression |
| --- | --- | --- |
| OPUS-01 | Hydrate returns stable parts/seq; UI retains them. Durable Codex facts use nativeItemId instead of Claude's nativeMessageId. | Actual hydrate→poll→UI across 2,048 events, replay applied twice, full text retained. |
| OPUS-02 | Recent byte windows keep complete native user/assistant pairs; older-page cursors remain accessible. Export pages assemble into one download and bind event tip. | 60 × 20 KB replies: every history turn and exported message recovered; each RPC <1 MiB. |
| OPUS-03 | Initial hydrate selects recent turns; event replay starts at that window. | 501-turn fixture checks the recent 100 and 500-turn windows, preserving full chronological export. |
| OPUS-04 | Explicit host Adopt verifies recorded run/worktree/state; Abandon writes the discarded disposition. | Real runHost: wrong id rejected, uncertain→running and discarded/discarded checked. |
| OPUS-05 | Immutable existing identity/route/resource bindings; new associations require a prepared project/conversation. Mutations require association scope; renderer force is refused; host launch intent blocks relaunch. | Real host rejects rebinding, foreign repo and forged forced release before dispatch. |
| OPUS-06 | Abort only this merge: MERGE_HEAD must match source and HEAD must still match target. Errors name conflicts. | Real Git conflict restores target SHA/content, clean status and no MERGE_HEAD. |
| OPUS-07 | Host-backed chat browser supports search, paging, archived inclusion and explicit unarchive/open. Evict idle native metadata without deleting history. Active sessions/answers refuse eviction. | Native facade: 13 chats, archived/search/paging, idle eviction and opening a ninth/new chat. |
| OPUS-08 | Remove the inconsistent 200k UTF-16 per-message limit; retain the explicit whole-import UTF-8 bound. | 210,326-character export/import round trip. |
| OPUS-09 | Reuse orch birth identities; production reads asynchronously at recovery and caches them. Canonical birth mismatch permits reclaim; matching live identity refuses. Ambiguous legacy timestamps stay uncertain. | Synthetic matching and PID-reused birth fixtures. |
| OPUS-10 | Namespace liveness by store UUID. Explicit resetNativeOwnership on clone releases copied fences and clears native refs/requested UUIDs, with receipt. Source state is untouched. | Held-fence clone becomes claimable in a fresh context; source keeps its native identity and liveness record. |
| OPUS-11 | Always close the client; AggregateError preserves settlement/context/client failures. | Settlement-only and simultaneous client-close failure cases. |

The controller independently reproduced OPUS-03 before repair (`q0` vs expected
`q1`). Actual replay testing also exposed the Codex identity-field mismatch above.
Windows line endings and the new typed recovery command's test mock were corrected
after the first focused run; remaining runtime assertions passed.

Local receipts: `.reviews/opus-review-20261111/`. Opus independently passed 777
desktop tests, 94 focused checks and eight coordinator tests on the original
candidate. The first complete repair suite passed 786 desktop tests. Final checks,
artifact receipts and focused re-review follow below when complete.

Limits remain explicit: imports are at most 1 MiB UTF-8; a native turn must fit an
export page; export retains its 10k turn/event-page safety ceilings and reports
those axes. This repair does not claim unlimited transfer. WebView rendering,
live provider/worker journeys, clean-machine installation and release qualification
remain separate. The owner authorized push and a PR, not merge or publication.

## Focused Opus follow-up and controller corrections

[Opus follow-up](OPUS-5.5-FOLLOWUP-2026-11-11.md), candidate `900a9a1`, run
`20261111-233446-58fa2f`, independently passed 102 focused tests and confirmed
all eleven original findings resolved in source. It requested these final fixes:

- FU-01: confirmed independently by the real native build. The Rust command
  allowlist now uses an inferred-length slice. Cargo's 12 tests and MSI/NSIS
  rebuild pass after the correction.
- FU-02: independently reproduced with a 60-turn export plus decision history.
  The assembler now recovers complete approval/clarification metadata from a
  later complete page; it preserves the warning only if none carries full
  metadata. The expanded regression includes both an approval and clarification.
- FU-03: evidence-preview cleanup now supplies its association id.
- FU-04: repaired the comment encoding and normalized touched source line endings.

The follow-up also noted two existing lifecycle gaps, now repaired: a dispatch
exception/unsuccessful result after intent records `uncertain`, refusing silent
relaunch, and integrated associations remain visible until explicit Finish.
Host finish preserves the prior integration note and transitions to finished;
Discard stays disabled after integration. Regression checks cover dispatch
throw/retry refusal and integrated-to-finished persistence.

The exact `900a9a1` desktop suite passed 787/787 and shared package 44/44.
The final small corrections are undergoing a narrow independent delta review
and final checks before the owner's authorized push/PR. Source review is still
separate from installed-app and release qualification.

## Final disposition — source ready for PR

[Final Opus delta review](OPUS-5.5-FINAL-2026-11-11.md), candidate
`d634157068af08f6a4f717903e7159dd4caa78c8`, run `20261111-235102-41838a`:
FU-01–04 resolved; both lifecycle corrections sound; no remaining concrete
 actionable regressions found. The independent recommendation is **ready to push
as a PR**, with v0.1 release acceptance still open. Fresh-worktree scope passed;
only the report was created. Requested/served model was `claude-opus-5-5`, medium.

Final controller checks: **787 desktop + 44 shared = 831 package tests passed**;
12 Rust tests passed; workspace typechecks, production web build and native build
passed. EXE/MSI/NSIS were rebuilt, and all 113 staged application files match
source. [Artifact/source receipt](../evidence/OPUS-REVIEW-2026-11-11.json) records
the source commit, manifest digest and on-disk SHA-256 hashes. The earlier
`9302b87` and controller-repair binaries are historical receipts.

Provenance note: the first two reports used a retained audit worktree that the
controller later fast-forwarded. Their late ledger statistics therefore include
controller changes; they do not describe model-authored source edits. Initial
scope was checked before that movement, and follow-up containment was checked
against its actual candidate `900a9a1`. The final run uses a fresh worktree at
`d634157`, with a clean recorded baseline/scope and exactly one report file.
Reports, original transcripts and retained worktrees remain available locally.
No source implementation is attributed to the report-only Opus runs.
