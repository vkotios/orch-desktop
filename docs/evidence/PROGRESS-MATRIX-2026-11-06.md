# Progress matrix — Cursor completion continuation

Europe/London. Candidate HEAD continues past Codex controller review
`docs/reviews/CURSOR-TASK-REVIEW-2026-11-06.md` (reviewed `1495d74`).

Status vocabulary:

- **Implemented**: code landed in this completion effort
- **Locally checked**: focused automated tests / local checks by the implementer
  (not independent review / reviewer convergence)
- **Unfinished**: accessible product work still missing in-tree
- **Externally blocked**: cannot complete without owner env/account/authority

## Controller review dispositions (R1–R10)

| ID | Status | Notes |
| --- | --- | --- |
| R1 | Implemented + locally checked | `SERVER_MODULES` host closure expanded; staged-host import probe outside Vite |
| R2 | Implemented + locally checked | Exclusive migrate lock; VACUUM INTO backup; no live-DB overwrite on failure; noop skips backup |
| R3/R4 | Implemented + locally checked | Integrate requires gate/review/run-terminal hooks; preview token binds SHAs; stale apply refuses |
| R5 | Implemented + locally checked | `reconcileStrandedTurns` returns `{settled, unresolved}`; no auto-adopt of prior host |
| R6 | Implemented + locally checked | Durable deltas dedupe by partId; append lost parts after live progress |
| R7 | Implemented + locally checked | Import writes snapshot projection (not editable draft); hydrate reads imported messages |
| R8 | Implemented + locally checked | Diff uses merge-base…branch committed changes with full patch |
| R9 | Implemented + locally checked | Upsert strips host-owned resource fields; orch success writes worktree/run on association |
| R10 | Implemented + locally checked | Draft conflict UI filters `resolution === "open"` |

## Work packages

| Package | Implemented | Locally checked | Unfinished | Externally blocked |
| --- | --- | --- | --- | --- |
| CHO-03 | Recovery + migrate safety + import snapshot + stranded unresolved surface + durable part replay | package tests | Explicit S5 prior-owner settle API; turn/event paging beyond window; complete export of full history | Live reopen with real CLIs |
| CHO-04/05 | Admission harden; Integrate gates + preview binding; baseline Diff; host-owned association resources | integrate + agent-task tests | Live delegated change + independent review round through orch | Reviewer quota; live orch worker |
| CHO-06 | Maintained Markdown/file refs; draft-conflict filter | unit tests | Real rendered viewport/keyboard journeys (CSS string checks are not layout proof) | Owner 125/150% scaling |
| CHO-07 | Runtime closure; CSP/docs/CI; advisory release-scan | staged-host probe; cargo 12 | Installer rebuild+rehash after closure; remote CI on final head | Clean-machine; signing; public repo |
| CHO-08 | Evidence matrix maintained against review | local suites | — | AC-01/13/15 clean machine; live AC routes |

## Exact external blockers

1. **Live Codex/Claude routes** — owner subscription/quota.
2. **Clean Windows environment** — MSI/NSIS install/upgrade/uninstall.
3. **Independent review** — approved orch reviewer availability (check route before declaring quota unavailable).
4. **Owner authority** — push, tag, signing, public visibility.
