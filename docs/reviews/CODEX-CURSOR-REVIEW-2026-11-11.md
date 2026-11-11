# Cursor delivery review and local repairs

Reviewed base: `a242de6` (source candidate `9302b87`). Date: 2026-11-11,
Europe/London. Scope: Cursor delivery and corrections against the current product
specification, completion instructions, implementation plan, progress matrix and
coordinator upstream. This is a controller review, not independent-model acceptance.

## Findings repaired

| Finding | Repair |
| --- | --- |
| Repeated Load more requests stopped at the same 500-turn/512-page cap. Limit state leaked across selected chats. | Per-session history metadata; progressively expand to the server's explicit 10k ceilings; disable at the ceiling with an explanation. |
| A valid 501-turn export contained 1,002 messages, exceeding the importer's 500-message limit. | Match import's count ceiling to export's 20k messages; retain the separate 1 MiB stored-body bound. Regression exports/imports all 501 turns and compares every text. |
| Large hydrate/export responses could exceed the 1 MiB IPC frame before the UI received truncation information. | Bound transcript responses to 900 KiB, disclose `hasMoreBytes` / `truncation.bytes`, and retain the complete database contents. Boundaries remain explicit; these are not unlimited exports. |
| Importing with eight UI chats appended then sliced away the new selection. | Prioritize the imported session and deduplicate its id before applying the UI-session limit. |
| Completed turns accepted late durable text but discarded late durable tools. | Accept text/tool transcript catch-up for existing messages; preserve terminal state and reject stale/regressive tool status. |
| The matrix still listed restore/clone identity rotation as unimplemented. | Add an explicit offline new-path clone using a consistent SQLite snapshot, schema validation and a new instance UUID. Preserve ownership fences/journals and refuse existing destinations. No automatic host adoption or in-place overwrite. |
| Bundled coordinator omitted pushed upstream fixes. | Integrate the snapshot and branch fixes documented in [coordinator provenance](../COORDINATOR_UPSTREAM.md), retaining desktop changes. Repair the non-placeholder Grok example roster and refresh the vulnerable transitive lock entry. |

## Verification

Local command receipts are in `.reviews/review-20261111-*.log` (ignored, not
fresh-clone evidence). Final outcomes and artifact hashes are recorded below
after checks finish. Initial package baseline: 44 shared and 772 desktop tests.
The first updated full desktop run encountered four five-second timeouts while
process-heavy coordinator fixtures were running. With bounded concurrency the
complete desktop suite passed. The first coordinator batch passed 211/213;
the repaired roster and keeper identity test passed their focused rerun.
Subsequent MCP/adapter/orphan checks use the updated coordinator dependencies.

Final checks:

| Check | Result |
| --- | --- |
| Shared package | 44 passed |
| Desktop | 777 distinct tests checked: final full run passed 776; the remaining packaging expectation omitted the new restore module, was corrected, and all 11 packaging tests passed on rerun |
| Data/history/restore regressions | 16 passed |
| Chat-state/history-window regressions | 37 passed |
| Coordinator | 213-test batch: 211 passed; its two failures passed focused reruns. After dependency refresh, all 41 MCP/adapter/orphan tests passed |
| Workspace and coordinator typechecks | passed |
| Rust host | 12 passed |
| Production web and native builds | passed; EXE, MSI and NSIS rebuilt |
| Runtime source closure | all 113 staged files match current source |
| Coordinator dependency audit | zero reported vulnerabilities after targeted lock refresh |

Artifact hashes and the source snapshot digest are in
[CODEX-REPAIR-2026-11-11.json](../evidence/CODEX-REPAIR-2026-11-11.json).
Source remains uncommitted on base `a242de6`; the digest records the repaired
working tree rather than claiming the binaries were built from that base alone.
These binaries supersede `9302b87` artifacts for the local repairs. The local
manifest is `.reviews/review-20261111-source-manifest.json` (path/SHA-256 entries,
sorted; its digest hashes `path + NUL + uppercase SHA-256 + LF`).
Desktop CI now runs coordinator contract regressions on Windows and Linux even
on the development branch. Hosted results remain unobserved.

## Remaining acceptance work

The v0.1 plan remains open. Live provider resume/approval/delegation/reviewer
journeys, actual WebView2 layout/keyboard/scaling evidence, clean-machine
install/upgrade/uninstall, independent source review and remote final-head CI
remain unqualified. Source/CSS assertions do not replace rendered journeys.
Offline restore is a maintenance API; it does not switch the running app's store
or supply an in-app restore wizard. Histories beyond the documented byte/count
ceilings require a future paged/file-streaming transfer path. None of these limits
is evidence that a full release is accepted. No remote push or release occurs.
