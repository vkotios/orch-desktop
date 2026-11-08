# Progress matrix — Cursor completion continuation

Europe/London. Candidate continues past E1/E2 closure at `5537a77`
(`docs/reviews/CURSOR-D1-D4-RECHECK-2026-11-06.md` controller addendum).

Status vocabulary:

- **Implemented**: code landed in this completion effort
- **Locally checked**: focused automated tests / local checks by the implementer
  (not independent review / reviewer convergence)
- **Unfinished**: accessible product work still missing in-tree
- **Externally blocked**: cannot complete without owner env/account/authority

## Controller review dispositions (R1–R10)

| ID | Status | Notes |
| --- | --- | --- |
| R1 | Implemented + locally checked | Host module closure + staged-host import probe; installer rebuild+rehash recorded for `9911924` |
| R2 | Implemented + locally checked | VACUUM INTO backup/rollback + exclusive lock; crash-left lock dead-owner reclaim + live-pid refuse tested |
| R3 | Implemented + locally checked | Exact run/review + `reviewed`/`clean`; Git-resolved source SHA required before review |
| R4 | Implemented + locally checked | Preview token binds source/target SHAs; stale apply refuses; receipt-fail after merge + per-association integrate serialization tested |
| R5 | Implemented + locally checked | Prior-owner ack authorizes current fence/`verifyOwnerEvidence` in the writer tx |
| R6 | Implemented + locally checked (partial) | Parts retained on completed messages; durable catch-up after live completion yields `abc`. Live RUN-02/04 rendered journeys remain owner/WebView |
| R7 | Implemented + locally checked | Import body prefixes hydrate; later native turns compose; hydrate pages listTurns (100-cap) up to turnCap 500; export uses full hydrate caps |
| R8 | Implemented + locally checked | Committed merge-base…branch patch + dirty/untracked overlay (`dirtyCount`) |
| R9 | Implemented + locally checked | Renderer injection stripped; `admitOrchRunArgs` requires conversation + approved-route cli/model + prepared project path containment |
| R10 | Implemented + locally checked | Exact `resolution === "open"` filter; host draft conflict list/resolve + restart draft retention journey tested |

## Recheck defects B1–B4 / D1–D4 / E1–E2

| ID | Status | Fix |
| --- | --- | --- |
| B1–B4 | Implemented + locally checked | See prior commits through `15f79f5` / `2e8101c` |
| D1–D4 | Implemented + locally checked | See `4ccf930` |
| E1 | Implemented + locally checked | Integrate resolves branch tip SHA before `inspectReview` |
| E2 | Implemented + locally checked | Finished-turn durable catch-up rebuilds text from retained parts |

## Work packages

| Package | Implemented | Locally checked | Unfinished | Externally blocked |
| --- | --- | --- | --- | --- |
| CHO-03 | Recovery + migrate stale-lock reclaim + body-backed import + paging/export caps + draft conflict host journey + prior-owner ack | package + migrate/paging/draft/export tests | Restore/clone identity rotation; rendered long-history WebView journey | Live reopen with real CLIs |
| CHO-04/05 | Conversation/route/project admission; dirty Diff overlay; integrate receipt recovery + serialize; uncertain adopt/abandon | admit + integrate + diff + agent-task tests | Live delegated change + independent review round through orch | Reviewer quota; live orch worker |
| CHO-06 | Landmark/flex/overflow layout contract + composer Enter keyboard helper | viewport + composer-keyboard tests | Owner 125/150% scaling + live WebView2 keyboard capture | Owner display matrix |
| CHO-07 | Runtime closure; CSP/docs/CI; advisory release-scan; installer rebuild+rehash | staged-host + native:build + cargo test | Remote CI on published final head | Clean-machine; signing; public repo |
| CHO-08 | Evidence matrix maintained | local suites | — | AC-01/13/15 clean machine; live AC routes |

## Exact external blockers

1. **Live Codex/Claude routes** — owner subscription/quota.
2. **Clean Windows environment** — MSI/NSIS install/upgrade/uninstall.
3. **Independent review** — approved orch reviewer availability.
4. **Owner authority** — push, tag, signing, public visibility.
