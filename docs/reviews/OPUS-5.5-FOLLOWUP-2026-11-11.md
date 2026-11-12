# Follow-up review: repaired CHO candidate `900a9a1`

Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), medium effort, orch implementer tool profile.
The review was report-only. Date: 2026-11-11.

Candidate: `900a9a15f120b651142fdd66e46c5ce2f0929510`. Scope: `4e09371..900a9a1`, checked
against the eleven findings in [OPUS-5.5-REVIEW-2026-11-11.md](OPUS-5.5-REVIEW-2026-11-11.md)
and the repair claims in [OPUS-ADJUDICATION-2026-11-11.md](OPUS-ADJUDICATION-2026-11-11.md).
Product source was not edited. Reproductions ran from a temporary directory outside the
repository.

## Summary

All eleven original findings are **resolved in source**, and the controller's regressions
pass. However, the repair commit introduces one blocking regression and two smaller ones:

- **FU-01 (P1): the native shell does not compile.** `NATIVE_COMMANDS` now lists 50
  commands but is still declared `[&str; 47]`.
- **FU-02 (P2): multi-page exports drop all decision history.** Approvals and
  clarifications are trimmed before messages, and the assembled export uses the first
  page's trimmed metadata.
- **FU-03 (P3):** the agents panel's evidence preview calls `orch_cleanup` without an
  `associationId`, which the host now refuses.

| ID | Priority | Area | Evidence |
| --- | --- | --- | --- |
| FU-01 | P1 / High | Rust allowlist array length; the native build fails | Executed (`rustc` on the extracted const) |
| FU-02 | P2 / Medium | Export pages drop historical approvals/clarifications | Executed (real persistence + `collectTranscriptExport`) |
| FU-03 | P3 / Low | Panel evidence `orch_cleanup` now always errors | Code reading (same admission branch the controller's host test executes) |
| FU-04 | P3 / Nit | Mojibake in a `native-chat.mjs` comment | Diff |

## Disposition of original findings

| ID | Disposition | Basis |
| --- | --- | --- |
| OPUS-01 | **Resolved** | Hydrate now emits `parts` with `partId`/`seq` (`native-session-persistence.mjs:1032, 1099`). The UI keeps them (`NativeChat.tsx:70`). Codex durable facts now carry `nativeItemId` only (`:1455`). The controller's hydrate→poll→UI test (2,050 parts across the 2,048-event boundary, each event applied twice) passed in my run. It covers the Codex fixture only; the Claude catch-up path was checked by reading. |
| OPUS-02 | **Resolved for messages.** See FU-02 for metadata. | `boundHydratedTranscript` keeps the newest window and never splits a `turnSeq` pair (`:29-61`). It exposes `beforeTurnSeq`/`beforeImportedIndex` for older pages (`:56-60`). Older pages merge without moving the event cursor (`NativeChat.tsx:841-848`). `nextHistoryWindow`/`historyAtCeiling` treat a pending older page as not at the ceiling. Export is paged by `messageOffset`, with an `expectedEventTip` guard, and assembled in `transcript-export.ts`. The 60 × 20 KB test passed: all 60 turns are reachable, 120 messages are exported, and every RPC is under 1 MiB. |
| OPUS-03 | **Resolved** | `listTurnSummariesPaged` selects the newest `turnCap` turns, offset from the count (`:872`). Event replay starts at the window's first event (`:1006`). Export uses `latest: false`. |
| OPUS-04 | **Resolved** | Host `delegation_adopt` requires an open `uncertain` association. It matches the recorded `runId`, the realpath of the worktree dir and the wp against `orch_run_detail`, then sets `running`/`recorded` (`host.mjs:506-526`). Abandon goes through `setDisposition('discarded')`. The real-`runHost` test passed. It stubs `authorizeDelegationAssociation`; I read the real implementation (`native-chat.mjs:2033-2043`). |
| OPUS-05 | **Resolved** | Existing bindings are immutable (`host.mjs:486`). New associations are bound to the realpath of the prepared project and to a durable conversation (`:501`, `native-chat.mjs:2033`). Renderer `force` is refused, and wp/repo/runId/reviewId are derived from the association for all ten coordinator mutations (`:677-698`); relaunch guard at `:659`. `orch_run` refuses relaunch of a recorded, uncertain or launching association. Side effect: authorization calls `ensureConversation`, so it can create an empty durable conversation for any valid UUID. That is acceptable, but the behaviour is not documented. |
| OPUS-06 | **Resolved** | Abort runs only when `MERGE_HEAD == sourceSha` and `HEAD == targetSha`, and the error names the conflicted paths (`delegation-integrate.mjs:218-224`). The conflict test passed: the target SHA/content is restored, status is clean, and `MERGE_HEAD` is gone. |
| OPUS-07 | **Resolved in source** | A host-paged browser offers query, archived inclusion, unarchive and open (`NativeChat.tsx:430-482, 970`). The oldest idle loaded chat is evicted through `native_chat_forget_session`, which refuses active sessions and pending steers. New chat is no longer capped. This has not been rendered in WebView2. Note that eviction picks one victim and does not fall back to another if the host refuses it. |
| OPUS-08 | **Resolved** | The 200k UTF-16 per-message bound was removed, and the 1 MiB UTF-8 body bound remains. The 210,326-character round-trip test passed. |
| OPUS-09 | **Resolved within the stated constraints** | Production reads the orch process table once, asynchronously, when persistence opens (`native-chat.mjs:232`), and caches its own birth. Reclaim on `identity === "mismatch"` happens only for canonical creation points. Legacy locale strings remain uncertain (`native-session-persistence.mjs:358`), and a missing PID yields `gone` (`procs.mjs:329`), which is not used for reclaim. Residual (theoretical, not a finding): the snapshot is taken only once per host. If a PID that was alive at snapshot time is reused later by a second live host that then takes the fence, the result would read as `mismatch`. That requires PID reuse inside the host's lifetime and a second concurrent CHO host. |
| OPUS-10 | **Resolved within the stated constraints** | `resetNativeOwnership` must be an explicit boolean. It releases copied held fences in the clone only, clears `native_refs` and requested Claude UUIDs, and writes a `wx` receipt that is removed if publication fails. Liveness keys are `${instanceId}:${conversationId}`, with a conservative legacy read. The clone test passed, and the source keeps its thread identity. |
| OPUS-11 | **Resolved** | Close collects the settlement error, the `context.done` rejection, `cleanupError` and the `closeClient` failure. A single error is rethrown; several are wrapped in an `AggregateError` (`native-chat.mjs:1784-1790`). |

## New findings

### FU-01 — Native allowlist array length mismatch; the Tauri shell does not compile (P1 / High)

**Where:** `apps/desktop/src-tauri/src/host_runtime.rs:19`. The constant
`NATIVE_COMMANDS: [&str; 47]` now has 50 entries, after `delegation_adopt`,
`delegation_abandon` and `native_chat_forget_session` were added at `:47-48, :58`. The
declared length was not updated, and the diff only changed line endings on that line.

**Reproduction:** I extracted the constant verbatim into a standalone file and ran
`rustc` (stable-x86_64-pc-windows-msvc), which failed with
`error[E0308]: mismatched types … expected because of the type of the constant`.

**Impact:**

- `cargo build`/`tauri build` fail, so the "native rebuild" for this candidate cannot
  succeed.
- Until this is fixed, Adopt, Abandon and chat eviction cannot be reached in the
  packaged app.
- The JS suites cannot detect this.

**Repair:** change the declared length to `[&str; 50]`, or use `&[&str]` so the length is
inferred.

**Validation:** `cargo check` in `apps/desktop/src-tauri`, then confirm that the
allowlist matches the host `NATIVE_COMMANDS ∪ DELEGATION_COMMANDS ∪ orch` set that the
renderer uses.

### FU-02 — Multi-page exports drop all historical approvals and clarifications (P2 / Medium)

**Where:**

- `native-session-persistence.mjs:33`: `boundHydratedTranscript` now trims
  `historicalClarifications` and `historicalApprovals` **before** `messages`. At
  `4e09371` the order was messages first.
- `exportConversation` (`:750`) slices only `messages` by offset. Every page
  therefore carries the full metadata arrays (up to 50 rows each), which are the first
  thing trimmed.
- `collectTranscriptExport` (`transcript-export.ts:17, 24`) keeps page 0's
  `conversation`, including its metadata and its `truncation.metadata`.

**Trigger:** export any chat whose messages exceed one 900 KiB page (for example the
"ordinary 1.2 MB transcript") and that has at least one recorded approval or
clarification.

**Reproduction:** with real persistence (`/tmp/opus-fu/export-meta.mjs`), I built 60 turns
× 20 KB and registered one approval on the last turn:

- Page 0 had 0 approvals, with truncation `{bytes, metadata}`.
- The assembled export had 120 messages and **0 approvals**, with `truncated: true` and
  `truncation.metadata: true`.

With 10 turns (a single page), the export had 1 approval and `truncated: false`. The
controller's 60 × 20 KB test has no approvals, so it passes.

**Impact:**

- Every multi-page export loses the decision history it is meant to carry, even though
  the 50-row metadata easily fits once messages are paged.
- The UI reports "decision history exceeded the export ceiling", so the loss is
  disclosed, but the cause is avoidable and the claim is misleading.
- Hydrate has the same ordering. The renderer does not currently consume
  `historicalApprovals`/`historicalClarifications` (no references in `src/`), so there is
  no visible UI loss there.

**Repair:** when `latest === false` (export), trim `messages` first and return metadata
only when it fits. Simpler alternative: attach metadata only to the final page
(`nextOffset === null`) and have `collectTranscriptExport` take metadata and
`truncation.metadata` from that page. Consider applying messages-first ordering to
hydrate as well.

**Validation:** 60 × 20 KB plus one approval and one clarification. The assembled export
should contain both records with `truncated: false`, and every page should stay under
1 MiB.

### FU-03 — Agents panel evidence preview now always fails (P3 / Low)

**Where:** `OrchAgentsPanel.tsx:86` calls `orch_cleanup` with `{ wp }` only. The host
now requires `associationId` for `orch_cleanup` and nine other mutations, and throws
`orch_cleanup requires associationId` (`host.mjs:677-682`).

**Impact:** on each refresh, every open association's evidence line shows that error
instead of the cleanup preview. This is display-only, because Finish and Discard pass
`associationId`.

**Repair:** pass `associationId: item.id`.

### FU-04 — Comment mojibake (Nit)

At `native-chat.mjs:207`, `→` became `â†’`. The repair also churned line endings in
`host.mjs`, `host_runtime.rs` and `lib.rs`, which hides FU-01 in diffs. Normalize before
PR.

## Checked and not a finding

- **App.tsx `orch_review`/`orch_adopt`/`orch_cancel`/`orch_record` without
  `associationId`.** These run only in `BrowserApp` (`App.tsx:1722`, non-Tauri), whose
  `/api/invoke` calls `handleBridgeCommand` directly without host admission. They do not
  affect the native app.
- **Integrate review binding without `reviewId`.** `deriveReviewInspection` binds by
  `runId`, so making `reviewId` immutable does not block Integrate.
- **Canonical repo path.** The prepared path is already a realpath
  (`native-chat.mjs:816`), so `delegation_list`'s exact `repoPath` match keeps finding
  new associations.
- **Packaging.** The new `../../../orch/src/procs.mjs`/`process-time.mjs` imports follow
  the existing `bridge.mjs` layout.
- **Pre-existing, not introduced here (noted only):**
  - Integrated associations leave the panel (`isOpenDisposition`), so Finish after
    Integrate is not offered.
  - If `orch_run` dispatch throws (as opposed to returning `ok:false`) after the host
    marks `launching`, only Discard can clear the association. Adopt and Abandon require
    `uncertain`.

## Checks run (this follow-up)

| Check | Result |
| --- | --- |
| Focused desktop: `opus-regressions`, `delegation-integrate`, `history-window`, `agent-task`, `native-chat`, `native-session-persistence` (dependencies junction-linked after verifying that the root and `orch` lockfiles are identical) | 6 files, **102/102 passed** |
| `rustc` on the verbatim `NATIVE_COMMANDS` const | **E0308** (FU-01) |
| Export metadata reproduction (`/tmp/opus-fu/export-meta.mjs`, 60 × 20 KB + 1 approval vs 10 turns) | 0 vs 1 approvals (FU-02) |
| Source review of `4e09371..900a9a1`, ignoring CR-only changes | Dispositions above |

**Not run:**

- The full desktop suite, typecheck, and `cargo check`/`tauri build` of the whole crate.
  I did not use the original checkout's target directory; FU-01 is proven by the isolated
  compile.
- Coordinator tests and installer/runtime staging.
- Any live provider session or rendered WebView.

The junctions were removed afterwards. No tracked file was modified other than this
report.

## Recommendation

**Source readiness for PR:** **not yet; one small fix away.** FU-01 breaks the native
build and must be fixed before PR. FU-02 should be fixed in the same pass, because it
contradicts the "exports recover all history" repair claim for any chat with decisions.
FU-03 and FU-04 are one-line fixes. After those, plus a `cargo check` and a re-run of the
focused suites, the eleven original findings are closed in source and the candidate is
reasonable to push as a PR.

**v0.1 acceptance:** **still not accepted.** The external gates are unchanged:

- live Codex/Claude resume, approval, clarification, Stop and delegated-change journeys;
- WebView2 rendering/scaling (including the new chat browser and Blob export);
- clean-machine MSI/NSIS install/upgrade/uninstall;
- signing and remote CI on the final head.

The stated bounds still hold, are disclosed, and are not unlimited-transfer claims:

- 1 MiB UTF-8 import;
- a native turn must fit one 900 KiB export page;
- 10k turn/event-page export ceilings.
