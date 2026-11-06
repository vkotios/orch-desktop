# Progress matrix — Cursor completion continuation

Europe/London. Candidate work continues on `codex/cho-v01-foundation` above
`8c3b5d0` (uncommitted until committed in this pass).

Status vocabulary:

- **Implemented**: code landed in this completion effort
- **Independently verified**: focused automated tests / local checks pass
- **Unfinished**: accessible product work still missing in-tree
- **Externally blocked**: cannot complete without owner env/account/authority

## Audit findings

| ID | Status | Notes |
| --- | --- | --- |
| F-12 / F-03 / F-08 / C-01 | Implemented + independently verified | Close/unknown, cleanup order, stranded settle, UTF-8 body decode |
| F-05 / F-02 / F-13 | Implemented + independently verified | Liveness lock/createdAt; durable recovery; stable factId; S3d installed-Node child-process reopen + race probes |
| F-06 / F-07 | Implemented + independently verified (partial) | Draft/history; rename/archive/conflict; search/export UI; import host API |
| F-01 / F-04 / F-09 | Implemented + independently verified (partial) | Host admission; intent/uncertain; adopt/abandon uncertain UI; read-only worktree Diff drawer; Integrate remains honestly disabled |
| F-10 | Implemented | Status/progress docs updated with disposition vocabulary |
| F-11 | Implemented + independently verified | Installed Codex 0.156.1 schema evidence + `excludeTurns: true` on resume + contract test |

## Work packages

| Package | Implemented | Independently verified | Unfinished | Externally blocked |
| --- | --- | --- | --- | --- |
| CHO-03 | Recovery batch; approval + clarification dual-write journals; search/export/import host APIs; S3d probes | Local package tests; S3d child probes; excludeTurns schema test | Full schema migration path; deeper producer→hydrate consumer mapping for tool facts | Live reopen with real CLIs |
| CHO-04/05 | Host admission; associations; panel evidence; adopt/abandon; read-only Diff | agent-task unit tests | Explicit Git integrate; denied-scope live journey; independent review round | Independent reviewer quota; live orch worker launch |
| CHO-06 | Unfinished fence render; clarification waiting copy; rename/archive/search/export; Diff drawer | Markdown + panel unit checks | File references; viewport/a11y evidence capture | Rendered scaling evidence on owner display |
| CHO-07 | CSP; NOTICE; SUPPORT_MATRIX; PRIVACY; SECURITY; CONTRIBUTING; Vitest advisory note; native CI job; MSI/NSIS | Local native build + cargo test earlier in session | DevDependency Vitest upgrade PR (documented, not claimed clear) | Clean-machine install; signing; public repo |
| CHO-08 | Evidence/AC rows maintained | Local suites/artifacts hashed | — | AC-01/13/15 clean machine; live AC-03/05/08 routes |

## Exact external blockers

1. **Live Codex/Claude routes** — owner subscription/quota for multi-turn reopen, tools, deny/cancel/stale, clarification, Stop.
2. **Clean Windows environment** — install MSI/NSIS without checkout/global Node; upgrade/migration/uninstall retention.
3. **Independent review** — GLM/Vibe (or approved reviewer) availability through orch.
4. **Owner authority** — push, tag, signing credentials, public visibility, NOTICE scope confirmation if broader than retained scaffold.
