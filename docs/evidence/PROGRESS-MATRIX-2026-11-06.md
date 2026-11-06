# Progress matrix — Cursor completion continuation

Europe/London. Candidate HEAD continues past Codex controller recheck of
`25b25a4` (`docs/reviews/CURSOR-R1-R10-RECHECK-2026-11-06.md`, B1–B4).

Status vocabulary:

- **Implemented**: code landed in this completion effort
- **Locally checked**: focused automated tests / local checks by the implementer
  (not independent review / reviewer convergence)
- **Unfinished**: accessible product work still missing in-tree
- **Externally blocked**: cannot complete without owner env/account/authority

## Controller review dispositions (R1–R10)

| ID | Status | Notes |
| --- | --- | --- |
| R1 | Implemented + locally checked (partial) | Host module closure + staged-host import probe pass; durable/delegation staged journeys and installer rebuild/rehash remain open |
| R2 | Implemented + locally checked (partial) | VACUUM INTO backup/rollback + exclusive lock; crash-left lock dead-owner recovery and full concurrent-writer qualification remain |
| R3 | Implemented + locally checked (partial) | B1 + D1: exact run/review binding; require `outcome==='reviewed'` and `containment==='clean'`; no WP-wide clean-containment fallback; bridge exports `commit` and filters strictly by runId |
| R4 | Implemented + locally checked (partial) | Preview token binds source/target SHAs; stale apply refuses. End-to-end host mutation serialization / post-merge receipt recovery still need qualification |
| R5 | Implemented + locally checked (partial) | B4 + S5 + D2: prior-owner ack authorizes current fence/`verifyOwnerEvidence` in the writer tx (denied proof refuses); no adoption of prior `hostGeneration` |
| R6 | Implemented + locally checked (partial) | B2 + D4: ordered `appliedParts` rebuild by durable `seq` so missing middle recovers as `abc` not `acb`. RUN-02/04 rendered journeys remain |
| R7 | Implemented + locally checked (partial) | B3 + D3: import body prefixes hydrate; later native turns compose into hydrate/export. Full event paging beyond window still open |
| R8 | Implemented + locally checked (partial) | Committed merge-base…branch patch; dirty/untracked overlay on normal merge-base path incomplete |
| R9 | Implemented + locally checked (partial) | Renderer worktree/run injection stripped; host writes orch success associations. Prepared-project/conversation/approved-route binding qualification remains |
| R10 | Implemented + locally checked (partial) | Exact `resolution === "open"` filter; rendered conflict resolution lifecycle still needs consumer tests |

## Recheck defects B1–B4 / D1–D4

| ID | Status | Fix |
| --- | --- | --- |
| B1 | Implemented + locally checked | Real bridge run/gate/review adapters |
| B2 | Implemented + locally checked | Shared `partId` on live+durable deltas |
| B3 | Implemented + locally checked | Import → `large_bodies` (no tip-0 snapshot) |
| B4 | Implemented + locally checked | `meta.hostGeneration` + `recoveryNotice` |
| D1 | Implemented + locally checked | Exact run + `reviewed` + clean; no unrelated fallback |
| D2 | Implemented + locally checked | Fence + `verifyOwnerEvidence` in prior-owner ack tx |
| D3 | Implemented + locally checked | Compose import prefix with later native turns |
| D4 | Implemented + locally checked | Rebuild assistant text by durable seq order |

## Work packages

| Package | Implemented | Locally checked | Unfinished | Externally blocked |
| --- | --- | --- | --- | --- |
| CHO-03 | Recovery + migrate safety + body-backed import + current-host reconcile + prior-owner ack + partId replay + import/export UI | package + B1–B4 + prior-ack tests | Turn/event paging beyond hydrate window; complete export of very large histories; restore/clone identity rotation | Live reopen with real CLIs |
| CHO-04/05 | Admission harden; real bridge integrate evidence; preview binding; baseline Diff; host-owned association resources | integrate + evidence adapter tests | Live delegated change + independent review round through orch | Reviewer quota; live orch worker |
| CHO-06 | Maintained Markdown/file refs; draft-conflict filter | unit tests | Real rendered viewport/keyboard journeys (CSS string checks are not layout proof) | Owner 125/150% scaling |
| CHO-07 | Runtime closure; CSP/docs/CI; advisory release-scan | staged-host probe | Installer rebuild+rehash after closure; remote CI on final head | Clean-machine; signing; public repo |
| CHO-08 | Evidence matrix maintained against recheck | local suites | — | AC-01/13/15 clean machine; live AC routes |

## Exact external blockers

1. **Live Codex/Claude routes** — owner subscription/quota.
2. **Clean Windows environment** — MSI/NSIS install/upgrade/uninstall.
3. **Independent review** — approved orch reviewer availability (check route before declaring quota unavailable).
4. **Owner authority** — push, tag, signing, public visibility.
