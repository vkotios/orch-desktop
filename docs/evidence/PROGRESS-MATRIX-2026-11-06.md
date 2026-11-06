# Progress matrix — Cursor completion continuation

Europe/London. Candidate on `codex/cho-v01-foundation` continuing past
admission/hydrate follow-up (`160f144`) with integrate/Markdown/migration work.

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
| F-06 / F-07 | Implemented + independently verified (partial) | Draft/history; rename/archive/conflict; search/export/import; hydrate load-more; historical approval/clarification projection |
| F-01 / F-04 / F-09 | Implemented + independently verified (partial) | Host admission; intent/uncertain; adopt/abandon; Diff; Finish preview; Stop worker; **explicit Git Integrate** with dry-run + branch/dirty/stage rechecks |
| F-10 | Implemented | Status/progress docs updated with disposition vocabulary |
| F-11 | Implemented + independently verified | Installed Codex 0.156.1 schema evidence + `excludeTurns: true` on resume + contract test |

## Work packages

| Package | Implemented | Independently verified | Unfinished | Externally blocked |
| --- | --- | --- | --- | --- |
| CHO-03 | Recovery batch; approval + clarification dual-write; historical hydrate projection; search/export/import; S3d probes; **backup→migrate→verify (v1→v2)** | Local package tests; migrate restore-on-failure; S3d probes; excludeTurns | Deeper producer→hydrate tool-fact consumer mapping beyond collapse-by-toolCallId | Live reopen with real CLIs |
| CHO-04/05 | Host admission; adopt/abandon; Stop; Finish preview; Diff; **Integrate merge path**; mocked denied-scope/claim refusal | agent-task + delegation-integrate tests | Denied-scope live orch journey; independent review round | Independent reviewer quota; live orch worker launch |
| CHO-06 | Unfinished fence; clarification waiting; rename/archive/search/export; Diff; draft flush; load-more; **react-markdown + GFM file refs** | Markdown + viewport contract tests | Live WebView2 keyboard/focus capture | Owner-display 125/150% scaling screenshots |
| CHO-07 | CSP; NOTICE; SUPPORT/PRIVACY/SECURITY/CONTRIBUTING; CHANGELOG; desktop config; Vitest pin `^3.2.7`; native CI + advisory release-scan; MSI/NSIS | Local native build + cargo test earlier; typecheck | Remaining unexpected release-scan fixture/doc hits (advisory in CI) | Clean-machine install; signing; public repo |
| CHO-08 | Evidence/AC rows maintained | Local suites/artifacts hashed | — | AC-01/13/15 clean machine; live AC-03/05/08 routes |

## Exact external blockers

1. **Live Codex/Claude routes** — owner subscription/quota for multi-turn reopen, tools, deny/cancel/stale, clarification, Stop.
2. **Clean Windows environment** — install MSI/NSIS without checkout/global Node; upgrade/migration/uninstall retention.
3. **Independent review** — GLM/Vibe (or approved reviewer) availability through orch.
4. **Owner authority** — push, tag, signing credentials, public visibility, NOTICE scope confirmation if broader than retained scaffold.
