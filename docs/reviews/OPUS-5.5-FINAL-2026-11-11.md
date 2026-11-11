# Final delta review: CHO candidate `d634157`

Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), medium effort, orch implementer tool profile.
The review was report-only. Date: 2026-11-11.

Candidate: `d634157068af08f6a4f717903e7159dd4caa78c8`. Scope: the small delta
`900a9a1..d634157`, checked against the follow-up requests in
[OPUS-5.5-FOLLOWUP-2026-11-11.md](OPUS-5.5-FOLLOWUP-2026-11-11.md) and the claims in
[OPUS-ADJUDICATION-2026-11-11.md](OPUS-ADJUDICATION-2026-11-11.md). This is not a
third broad audit. Product source was not edited, and the only tracked file written is
this report.

## Summary

All four follow-up items (FU-01..04) are **resolved**. The two lifecycle gaps I noted
earlier are also **repaired soundly**. I found **no remaining concrete actionable
regressions** in the delta. The bounded repairs are sound.

## Follow-up dispositions

| ID | Disposition | Basis |
| --- | --- | --- |
| FU-01 (P1) | **Resolved** | `host_runtime.rs:19` is now `const NATIVE_COMMANDS: &[&str] = &[…]`, and the lookup at `:331` (`.contains`) works unchanged on a slice. I extracted the const verbatim and compiled it with `rustc` 2021: it builds and reports 50 entries. The controller's `final-cargo.log` shows 12/12 passed, and its release build finished (`Finished release … 1m 02s`) and produced the MSI. |
| FU-02 (P2) | **Resolved** | `transcript-export.ts:19-25` takes `historicalApprovals`/`historicalClarifications` from any page whose `truncation.metadata` is unset. It sets `metadata`/`historyMetadataTruncated` only if no page was complete (`:33-34`). A synthetic repro of the assembler shows that a trimmed page 0 followed by a complete page 1 recovers the metadata with `truncated: false`. When every page is trimmed, the result keeps `metadata: true` and `truncated: true`. The expanded real-persistence test (60 × 20 KB, with one approval and one clarification on the last turn) passes. The controller's `metadata-before.log` shows that this test fails against the old assembler, so it is not vacuous. |
| FU-03 (P3) | **Resolved** | `OrchAgentsPanel.tsx:87` passes `associationId: item.id`. The bridge maps `orch_cleanup` without `apply` to `--dry-run` (`bridge.mjs:1549-1553`), so the refresh preview stays non-mutating. The host test now also proves that the association's `wp` overrides the renderer's (`opus-regressions.test.mjs`, `wp: "OTHER"` → `WP`). |
| FU-04 (Nit) | **Resolved** | The `native-chat.mjs:207` comment is plain ASCII. `native-chat.mjs`, `host.mjs`, `host_runtime.rs` and `lib.rs` contain no CR bytes, so the delta diff is content-only. |

## Lifecycle corrections

**1. Post-intent dispatch failure → `uncertain`, with no relaunch.**

- `orch_run` admission marks `launching` and refuses any association that has a `runId`,
  or is `uncertain` or `launching` (`host.mjs:676`). `admitted` is now hoisted out of the
  `try` block.
- If `orch_run`/`orch_worktree_create` dispatch throws, the catch block persists
  `uncertain` (`:654`). It appends a store failure to the error message instead of
  hiding it.
- An `ok:false` result, or a success that lacks a run id or worktree path, also persists
  `uncertain` (`:641-646`).
- An admission failure leaves `admitted` undefined. A refused retry therefore does not
  rewrite state.
- From `uncertain`, Abandon is available. Adopt still requires a recorded run id.
  Retrying `orch_worktree_create` remains possible, because it has no stage guard and a
  later success moves the stage back to `worktree`. This matches the renderer's own
  `uncertain` marking in `agent-task.ts:176-186`, and is now also durable when the
  invoke throws.

The test injects a throw on `orch_run`. It confirms that the association lists as
`uncertain`, and that a second `orch_run` is refused without reaching dispatch
(`dispatched` length unchanged). **Sound.**

**2. Integrated associations stay visible until an explicit Finish.**

- `isOpenDisposition` now includes `integrated` (`OrchAgentsPanel.tsx:25`).
- Discard is disabled for integrated rows (`:488`). The store also refuses
  `integrated→discarded`, because `DISPOSITION_TRANSITIONS.integrated` contains only
  `finished` (`delegation-associations.mjs:37`).
- Integrate stays disabled (it needs `accepted`), and Accept is hidden (it needs `none`).
- Finish calls `orch_finish`. The host then runs `setDisposition(…, 'finished')` with the
  prior integration note followed by the finish note (`host.mjs:605`).
- `finishDelegation`'s follow-up `delegation_set_disposition: finished` takes the
  same-disposition no-op path. The renderer still cannot assert `finished` or
  `integrated` without the host receipt.
- The store test covers `accepted → integrated → finished` and the refusal of a later
  discard. **Sound.**

Cosmetic only, not actionable for this PR: when the prior note is null, the finish note
starts with a leading `\n`. Notes are sliced to 2,048 characters, keeping the head, so an
unusually long integration note would cut off the appended finish sentence. The
disposition itself is unaffected.

## Remaining actionable regressions

None found in `900a9a1..d634157`.

## Checks actually run (this review)

| Check | Result |
| --- | --- |
| Lockfiles: root and `orch` `package-lock.json` byte-identical to the original checkout (`apps/desktop` has none) | Identical; junctions created for `node_modules`, `apps/desktop/node_modules` and `orch/node_modules` |
| `vitest run` `delegation-integrate`, `agent-task`, `opus-regressions`, `delegation-associations` (two invocations; the `agent-task` pattern matched no file) | 3 files 13/13 and 2 files 7/7 passed, including all six `opus-regressions` |
| `rustc` on the verbatim `NATIVE_COMMANDS` const | Compiles, 50 entries |
| Synthetic `collectTranscriptExport` repro (Node 24 strip-types, temp dir) | Recovery case: `truncated:false`, approvals present. All-trimmed case: `metadata:true`, `truncated:true` |
| Source reading of the full delta and the code it touches (admission, store transitions, panel buttons, bridge cleanup, agent-task flow) | Dispositions above |

The junctions and the temporary directory were removed afterwards; the original
`node_modules` directories are intact. No writes were made to the original checkout.

**Controller receipts read (not re-run), `.reviews/opus-review-20261111/`, at about
23:53:**

- `final-desktop.log`: 43 files, 787/787 passed.
- `final-shared.log`: 44/44 passed.
- `final-cargo.log`: 12/12 passed.
- `final-typecheck.log`: both workspaces' `tsc --noEmit`, with no errors logged.
- `metadata-before.log` / `metadata-after.log`: fail, then 6/6 passed.
- `final-native-build.log`: the release build finished. The MSI was written at
  23:53:19 and the NSIS `…x64-setup.exe` (25.00 MiB) at 23:54:19. I read only the log
  tail and the file timestamps; the process exit code was not captured here.

**Not run:** the full desktop suite, typecheck and native build (all controller-owned),
coordinator tests, any live provider session, and any rendered WebView.

## Recommendation

**PR:** **ready to push as a PR.** FU-01..04
and both lifecycle corrections are closed in source and covered by regressions. The
owner authorized push and PR, not merge or release.

**v0.1 release acceptance:** **still not accepted.** The external gates are unchanged:

- live Codex/Claude resume, approval, clarification, Stop and delegated-change journeys;
- WebView2 rendering/scaling, including the chat browser, the integrated-row panel state
  and Blob export;
- clean-machine MSI/NSIS install/upgrade/uninstall;
- signing and remote CI on the final head.

The stated bounds remain disclosed and are not unlimited-transfer claims: 1 MiB import,
a turn must fit an export page, and the export's 10k turn/event-page ceilings.
