# Independent review: CHO Desktop completion candidate `4e09371`

Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), medium effort, orch implementer tool profile.
The review was report-only. Date: 2026-11-11.

Candidate: `4e093711be6ab758f61ba85e7c2a105be0879965`. Scope covered the Cursor delivery and
corrections in `76076fb..a242de6`, plus the controller repairs and coordinator import in
`a242de6..4e09371`. Product source was not edited. Reproductions ran from a temporary
directory outside the repository against the candidate's modules.

## Summary

The candidate is **not ready for v0.1 acceptance**. The independent test evidence below is
consistent with the controller's claims: 777/777 desktop tests pass, and the coordinator,
admission, integrate and packaging-closure checks hold.

However, I found two P1 history and recovery defects that are locally fixable. In
long chats, they silently hide or corrupt the displayed transcript after reopen:

- **OPUS-01:** durable catch-up overwrites hydrated assistant text.
- **OPUS-02:** the new byte ceiling keeps the oldest messages, makes the newest turns
  unreachable, and then disables "Load more".

Five P2 issues are also locally fixable:

- **OPUS-03:** the default history window is oldest-first.
- **OPUS-04:** Adopt and Abandon do not take effect through the real host, although the
  progress matrix marks them implemented and checked.
- **OPUS-05:** host admission still trusts association fields written by the renderer and
  a forced-release reason string.
- **OPUS-06:** a conflicting Integrate leaves the owner's checkout mid-merge.
- **OPUS-07:** chats older than the eight most recent, and archived chats, cannot be reached.

The external gates are unchanged: live provider journeys, clean-machine
install/upgrade/uninstall, WebView2 rendering/scaling, signing and remote CI.

| ID | Priority | Area | Evidence |
| --- | --- | --- | --- |
| OPUS-01 | P1 / High | History replay: hydrated text replaced by catch-up | Executed |
| OPUS-02 | P1 / High | Byte ceiling drops newest turns; no way to reach them | Executed |
| OPUS-03 | P2 / Medium | Default turn window shows oldest 100 turns | Executed |
| OPUS-04 | P2 / Medium | Adopt has no effect; Abandon leaves the association open | Executed (real `runHost`) |
| OPUS-05 | P2 / Medium | Admission trusts renderer association edits and a forced-release reason | Executed (real `runHost`) |
| OPUS-06 | P2 / Medium | Integrate conflict leaves the owner's repo in a MERGING state | Executed (Git fixture) |
| OPUS-07 | P2 / Medium | Older and archived chats unreachable; New chat blocked at 8 | Code reading |
| OPUS-08 | P3 / Low | Valid untruncated export cannot be re-imported (>200,000 chars) | Executed |
| OPUS-09 | P3 / Low | Process creation time recorded but never checked; reused PID blocks reclaim; 0.5 s synchronous probe | Executed |
| OPUS-10 | P3 / Low | Restored clone with a held fence can never be continued | Executed |
| OPUS-11 | P3 / Low | Close drops the settlement error when client close also fails | Code reading |

## Findings

### OPUS-01 — Durable catch-up overwrites hydrated assistant text (P1 / High)

**Where:** `apps/desktop/src/lib/native-chat-state.ts:373-406`, together with
`apps/desktop/server/native-session-persistence.mjs:1015-1068`. Hydrate builds `text` from
the deltas it reads but emits no `parts`.

**Trigger:**

1. Reopen a conversation whose durable event log exceeds the default hydrate window. The
   window is 64 pages × 32 events (`:1022`), about 2,048 events. Every native token delta
   becomes its own durable event (`native-chat.mjs:547-560`), so this happens after roughly
   5–10 substantial turns.
2. The page boundary almost always falls inside a turn. Hydrate returns that turn with a
   partial `text` and sets the cursor at the boundary.
3. The poll loop then delivers the remaining `message_delta` events for that completed turn
   as durable catch-up.
4. A non-active message has no `parts`, so `parts` starts empty (`:375`). The text is then
   rebuilt from only the new parts (`:406`), and the hydrated prefix is discarded.

**Reproduction:** using the real module (`/tmp/opus-repro/straddle.mts`), a hydrated reply
`"Hello, here is the first half. "` followed by one durable delta (seq 2049) displays as
`"And the second half."`. The same happens after "Load more history", which moves the
cursor.

**Impact:** silent, display-only truncation of earlier assistant replies after reopen. The
database is intact, but every reopen reproduces the corruption, and no notice is shown.
This breaks RUN-02/04 ("missed display events applied once"), SESSION-02/03 and the handoff
invariant "No silent truncation". It sits under the E2/R6 recheck rows, which test catch-up
on live-completed messages only.

**Repair:** have hydrate return each retained part with its `partId` and `seq` (the event
payload already carries both). Alternatively, seed a synthetic base part `{seq: cursor.seq}`
for hydrated text, so that `rebuildAssistantText` appends rather than replaces. Reuse the
existing part/`seq` dedupe.

**Validation:**

- Deterministic hydrate → poll test: more than 2,048 events, with the boundary inside a
  turn. The final text must equal `exportConversation` text for every turn.
- Repeat the test after "Load more".

### OPUS-02 — Byte ceiling keeps the oldest messages and hides the newest (P1 / High)

**Where:**

- `native-session-persistence.mjs:27-45`: `boundHydratedTranscript` binary-searches
  `items.slice(0, mid)`.
- `:765-778`: export does the same.
- `NativeChat.tsx:56` sets `byteCeiling` from `hasMoreBytes`.
- `history-window.ts:16` treats that as the ceiling, which disables "Load more" (`NativeChat.tsx:771`).

**Trigger:** reopen a 60-turn chat with about 20 KB of output per turn (about 1.2 MB in
total).

**Reproduction:** using the candidate's persistence API (`/tmp/opus-repro/bytes.mjs`),
hydrate returned turns `q0..q45` only. The output was `turnsLoaded: 60`, 91 messages,
`hasMoreBytes: true` and `eventCursor.seq = 180` (the tip):

- The newest 14 turns are gone.
- The last kept item is the user prompt `q45` without its assistant reply.
- Because the cursor is at the tip, polling never re-delivers turns 46–59.
- Export produced the same `q45` cut (`truncation.bytes: true`), with no offset parameter.

The UI then shows "History ceiling reached" on the first load. The notice at
`NativeChat.tsx:384` still tells the user to "Use Load more history".

**Impact:** the most recent work in an ordinarily sized coding chat cannot be reached
in-app or through export. If the user continues the chat, new turns appear after a silent
gap, while the provider keeps the full context. The controller review frames this as a
disclosed ceiling, but the dropped end is the wrong one. This breaks SESSION-02/03
("reachable pagination or an explicit recoverable limit") and the spec clarification
against hiding history. The imported-transcript path inherits the problem: import accepts
up to 1 MiB (`:854`), but hydrate shows 900 KiB.

**Repair:**

- Keep the newest window, trimming from the start.
- Never split a user/assistant pair.
- Bind `eventCursor` to the retained window, or keep it at the tip only when the newest
  items are retained.
- Add an offset or "older page" parameter for both hydrate and export, using the existing
  `listTurns` offset.
- Make the notice and button state consistent.

**Validation:** 60 × 20 KB fixture: the newest turn is present after hydrate, older pages
can be reached, export pages concatenate to the full history, and the IPC frame is
< 1 MiB.

### OPUS-03 — Default turn window is oldest-first (P2 / Medium)

**Where:** `session-turns.mjs:321` (`ORDER BY seq ASC LIMIT ? OFFSET ?`), used by
`listTurnSummariesPaged` at `native-session-persistence.mjs:886-906`. The default is
`turnLimit = 100` (`:913`).

**Reproduction:** for 130 turns, the default hydrate returned `q0..q99`, while export
returned through `q129`.

**Impact:** reopening any chat with more than 100 turns hides the newest 30 or more turns
until the user clicks "Load more". Sending a new message appends it directly after `q99`.
"Load more" does reach the remaining turns, but the default window is the wrong end for a
chat UI, and the cursor sits past the hidden turns.

**Repair:** select the newest N turns (`ORDER BY seq DESC` and reverse, or an offset of
`count − N`). Make "Load more" prepend older pages.

**Validation:** with 130 turns, the default hydrate contains `q129`, and "Load more"
reaches `q0`.

### OPUS-04 — Adopt has no effect and Abandon leaves the association open (P2 / Medium)

**Where:**

- `host.mjs:475-491`: for existing associations, the host deletes `runId` and
  `worktreePath`, and deletes `stage` when it is `running` or `launching`. It also deletes
  any `disposition` other than `none`.
- `agent-task.ts:265-290`: Adopt sends `stage: "running", runId`.
- `agent-task.ts:252-259`: Abandon sends `disposition: "discarded"`.

**Trigger:** "Stop worker" (`agent-task.ts:384`) or recovery leaves an association
`uncertain`. The user clicks Adopt and the UI reports "Adopted …" (`OrchAgentsPanel.tsx:189`).

**Reproduction:** the real `runHost` was driven with a fake orch dispatch
(`/tmp/opus-repro/adopt.mjs`):

- After Adopt, the stage is still `uncertain`.
- After Abandon, the stage is `discarded` but the disposition is still `none`.

The unit test (`agent-task.test.ts:155-171`) mocks `callHost` and so never exercises the
host stripping.

**Impact:**

- After "Stop worker", Accept, Finish and Integrate stay disabled, and Adopt can never
  clear the state.
- Abandoned records remain "open" (`disposition: none`). They are matched as `prior` by
  `startAgentTask`, and show Accept/Finish/Discard on a record whose stage is `discarded`.

The progress matrix row "CHO-04/05 … uncertain adopt/abandon — implemented + locally
checked" is **refuted**. This is relevant to ORCH-01/02/03 recovery (adopt under valid
authority, never relaunch).

**Repair:** add a host-owned `delegation_adopt` command. It should check that the recorded
`runId` matches `orch_run_detail` and that the run's directory matches the association's
worktree, then set `stage` on the host side. Abandon should go through `setDisposition`
(or a host `delegation_abandon`) rather than renderer upsert.

**Validation:** a host-level test with `runHost` and fake dispatch: uncertain → adopt →
`running`; abandon → `discarded/discarded`; a mismatched runId is refused.

### OPUS-05 — Host admission still trusts renderer-written association fields and a forced-release reason (P2 / Medium)

**Where:**

- `host.mjs:475-491`: on an existing association, `delegation_upsert` still accepts
  `conversationId`, `cli`, `model`, `wp`, `slice`, `reviewId` and most `stage` values. On a
  new association it also accepts any `repoPath`, which is not bound to the prepared
  project.
- `host.mjs:614-622`: `orch_release` with `force: true` is admitted for any renderer-named
  `wp` if `reason` starts with `"discarded from CHO"`. The `associationId` is ignored.
- `host.mjs:624-637`: claim, finish and cleanup accept any `wp` when no `associationId` is
  supplied.

**Reproduction:** with the real `runHost` (`adopt.mjs`):

- `orch_release {wp:"SOMEONE-ELSES-WP", force:true, reason:"discarded from CHO desktop"}`
  was dispatched to orch as a forced release by `owner`.
- An upsert moved an existing association to `conversationId: other-conv`, `cli: grok`,
  `model: any-model`, `wp: OTHER`.

The `orch_run` admission then treats these renderer-written values as the "approved route".

**Mitigations confirmed:**

- orch's roster still enforces `requires_permission` models (`commands.mjs:86`), because
  `ownerApprovedModel` is stripped.
- In the normal UI Discard path, orch cleanup authority refuses when CHO is not the holder
  (`resources.mjs:145-153`), so the force step is reached only through direct IPC.
- Integrate is bound to the host-owned worktree branch and the Git SHA.

**Impact:** this falls short of ORCH-09 and the spec clarification ("renderer flags must
not self-authorize … force release"; "keep recovered resources with their actual
conversation/repo"). R9 ("requires conversation + approved route") is only nominal,
because the renderer writes the binding.

**Repair:**

- Make `conversationId`, `repoPath`, `wp`, `slice`, `cli`, `model` and `reviewId`
  immutable after creation. They should change only through host transitions.
- Bind `repoPath` to the prepared project root.
- Derive release, claim, finish and cleanup `wp` from an association.
- Drop `force` from Discard. After a successful cleanup the owner holds the claim, so a
  non-forced release succeeds. If force is kept, require an association in Discard state
  and an unreadable claim.

**Validation:** host tests showing that re-binding is refused, forced release without a
discard-state association is refused, and a cross-repository `repoPath` is refused.

### OPUS-06 — Conflicting Integrate leaves the owner's repository mid-merge (P2 / Medium)

**Where:** `delegation-integrate.mjs:207-216` runs `git merge --no-ff` with no abort or
conflict handling. The dry run (`:187`) does not predict conflicts.

**Reproduction:** Git fixture with the actual `integrateAssociationWorktree`
(`/tmp/opus-repro/integrate.mjs`). Both branches edited `a.txt`. The dry run succeeded
("1 commit(s)"). Apply then:

- threw `git merge failed: Command failed: git merge …`, with empty detail;
- left `MERGE_HEAD` in place, status `UU a.txt` and conflict markers in the owner's working
  file.

A retry then reports "repository working tree is dirty; commit or stash before integrate",
which is wrong guidance for a conflicted merge.

**Impact:** an owner-visible Git mutation fails part-way with no explanation or in-app
recovery. This affects the CHO-05 integration journey and data preservation for the
owner's checkout.

**Repair:**

- In the dry run, predict conflicts with `git merge-tree --write-tree <target> <source>`
  (Git ≥ 2.38) and refuse or warn there.
- On apply failure, if `MERGE_HEAD` equals `sourceSha`, run `git merge --abort` and report
  the conflicting paths from stdout.

**Validation:** with a conflict fixture, either the dry run refuses, or apply leaves the
repository at `targetSha` with a clean status and a message listing the paths.

### OPUS-07 — Older and archived chats unreachable; New chat silently blocked at 8 (P2 / Medium)

**Where:**

- `NativeChat.tsx:373-378` hydrates only `matching.slice(0, NATIVE_MAX_SESSIONS)` (8).
- Chat search (`:115-116`) filters only those loaded sessions.
- The New chat button is disabled at 8 (`:625`), with no explanation.
- Archive removes a chat, and no UI path ever uses `includeArchived`.

The host already supports `query` and `includeArchived` (`native-chat.mjs:1801-1812`). The
persistence default limit is 50.

**Trigger:** a project with nine or more chats. The ninth and older chats cannot be
opened. To start a new chat the user must archive one, after which it cannot be reached.

**Impact:** F-07 is only partly resolved: the fix moved from latest-only to the latest
eight. SESSION-02/03 clarification: "do not silently hide earlier chats". This is
locally implementable.

**Repair:** a host-backed conversation list with query and paging, and open-on-demand
(hydrate when selected). Add an "Archived" filter with unarchive (the archive command
already takes a boolean). Close or evict a loaded session instead of capping creation.

**Validation:** a fixture with 12 chats and one archived: all are reachable and searchable
through the host, and New chat works with eight loaded.

### OPUS-08 — Valid untruncated export cannot be re-imported (P3 / Low)

**Where:** `native-session-persistence.mjs:831` rejects any message over 200,000 UTF-16
units, despite the "200KiB" label.

**Reproduction:** one turn with a 210,326-char reply. Export succeeded with
`truncated: false`. `importTranscript` with those messages was refused ("exceeds 200KiB
text bound").

**Impact:** the export → import round trip promised by the R7 repair breaks on legitimate
long outputs.

**Repair:** remove the per-message bound, or align it with the 1 MiB body bound, measured
in bytes.

**Validation:** a regression test that round-trips a 210,000-char message.

### OPUS-09 — Recorded process creation time is never verified; reused PID strands the conversation (P3 / Low)

**Where:**

- `native-session-persistence.mjs:79-104` records `createdAt`, using locale-formatted
  PowerShell output (`"11 November 2026 21:38:39"`).
- `:352-404` never compares it. Any live process with the recorded PID counts as the
  owner.
- `:420` runs the probe through a synchronous `execFileSync('powershell.exe')`. Measured
  at 489–536 ms, it blocks the host event loop on every conversation claim.

**Reproduction:** `/tmp/opus-repro/pidreuse.mjs` set the liveness PID to an unrelated live
process with a mismatched `createdAt`. Host B was refused with "fence is held by another
live host". The stranded acknowledgement also calls `ensureConversation`
(`native-chat.mjs:1891`), so it fails too.

**Impact:** the outcome is fail-closed, which is safe. But F-05's "verify creation time"
is unmet, and the conversation has no recovery other than a new chat, which loses native
context. Reused PIDs are uncommon but realistic on Windows after a crash or reboot.

**Repair:** reuse orch's process-identity helpers (`orch/src/procs.mjs`,
`process-time.mjs`). These give an epoch creation point read asynchronously or cached
once per host. Treat a mismatched identity as gone.

**Validation:** a PID-reuse fixture that reclaims with a mismatched `createdAt`, and still
refuses a matching live owner.

### OPUS-10 — Restored clone with a held fence can never be continued (P3 / Low)

**Where:** `session-store-restore.mjs:20-39` copies fences verbatim. The liveness map
(`native-session-persistence.mjs:343-404`) is global per user and keyed only by
`conversationId`, not by store `instance_uuid`.

**Reproduction:** `/tmp/opus-repro/restorefence.mjs`:

1. Host A holds conversation C.
2. Restore to a clone.
3. Host A releases cleanly and exits.
4. Host B opens the clone: C is refused with "fence is still held and prior owner liveness
   cannot be proven".

Hydrate still reads C, so the conversation is effectively read-only.

**Impact:** restore is not reachable from the app (it is a maintenance API), hence Low.
The documented contract implies restored history remains usable without adoption.

**Repair:** key liveness entries by store instance. During restore, mark copied held
fences as `unknown`/`dead`, recording the identity rotation as evidence. Or offer an
explicit, recorded "release restored fence" step.

**Validation:** clone under a held fence, then continue in the clone after explicit
acknowledgement.

### OPUS-11 — Close drops the settlement error when client close also fails (P3 / Low)

**Where:** `native-chat.mjs:1781-1783`. A `closeClient` failure throws before
`settleError` is rethrown, so the settlement failure is never reported.

**Impact:** RUN-05/06/07 requires that both failures be reported. Client cleanup itself
does run, which was verified.

**Repair:** use `AggregateError` or attach the settlement error as `cause`.

**Validation:** a fake client whose close fails, combined with a failing settlement: the
error carries both.

## Confirmed or refuted from earlier reports and controller claims

- **Packaging closure: confirmed.** The static/dynamic import closure of `host.mjs`
  (computed, 30 modules) equals `SERVER_MODULES`, except `session-store-restore.mjs`,
  which is staged but never imported by the host (harmless). `orch/src/*.mjs` is copied
  in full. The MCP SDK is needed only by separate controller servers, not on the host
  path.
- **Coordinator provenance: confirmed.** Upstream objects `8622b9d`, `c0194c2`, `3111aa1`
  and `457e8fb` are present. The orphan-run (`1477364..3111aa1`) and MCP cache-hint
  (`a528ca7..457e8fb`) patches reverse-apply cleanly against HEAD (`git apply --check -R`),
  so both are fully present. Remaining drift from upstream main is limited to the Grok
  adapter/registration, setup tweaks and CI policy, as documented. No unrelated
  architecture was imported.
- **Integrate SHA binding (R3/R4/E1): confirmed.**
  - Review evidence is filtered by wp, run, review and `commit === Git-resolved sourceSha`,
    and requires the `reviewed` outcome with `clean` containment.
  - Apply recomputes all preview fields from live Git and merges by explicit SHA.
  - The preview "signature" is an unkeyed hash. That is acceptable because it grants no
    authority beyond the live recheck.
  - Residual: a small window between `rev-parse HEAD` and `git merge` (not a finding).
- **orch_run admission (R9): partly confirmed.** `dir`, `wp`, `slice`, `cli` and `model`
  are derived from the association, and renderer `dir`, `force` and `allow` are ignored.
  The association itself is still renderer-writable (OPUS-05).
- **Event-page axis self-heals through polling:** text for turns beyond the hydrate event
  window arrives through durable catch-up. The exception is the turn straddling the
  boundary (OPUS-01).
- **Late durable tool facts (latest repair): confirmed.** The `seq` and terminal-status
  guards behave as tested.
- **Migration: no defect found.** It runs on every open and is a no-op when current. It
  takes a `VACUUM INTO` backup before migrating and never copies a backup over the live
  database.
- **Rust allowlist** includes every new host command. CSP and capabilities are narrow
  (`core:default`).
- **Import ordering (latest repair): confirmed.** The imported session is placed first and
  deduplicated before the 8-session slice. Its dedupe key is now the SHA-256 of the file.

## Checks run (independent)

| Check | Result |
| --- | --- |
| Desktop full suite (`vitest run --maxWorkers=4`, dependencies junction-linked from the original checkout; lockfiles verified identical to the candidate) | **42 files, 777/777 passed** |
| Focused desktop: persistence, restore, migrate, admit, integrate(+evidence), history-window, chat-state, agent-task, runtime-preparation | 94/94 passed |
| Coordinator `run-orphan-inventory` + `mcp` (`node --test`) | 8/8 passed |
| Host import-closure computation vs `SERVER_MODULES` | Match (see above) |
| Upstream patch presence (`git apply --check -R`) | Clean for both imported branches |
| Executed reproductions (outside the repository, `/tmp/opus-repro/*`) | OPUS-01, 02, 03, 04, 05, 06, 08, 09, 10 |

**Not run:**

- Rust tests, typecheck, web/native builds, installer rebuild and runtime staging.
- The full coordinator suite.
- Any live provider session.

I did not independently verify the installer hashes in `CODEX-REPAIR-2026-11-11.json`.
The junctions were removed afterwards, and the original `node_modules` are intact. No
tracked file was modified other than this report.

## Remaining acceptance gates

Locally implementable before acceptance:

- OPUS-01–07, plus the P3 items as capacity allows.
- Correct the progress-matrix row for adopt/abandon.
- Re-run the full desktop suite and a hydrate/export long-history test.

Externally blocked (unchanged, correctly recorded by the controller):

- Live Codex/Claude resume, approval, clarification, Stop and delegation journeys.
- An independent review round through orch for CHO-05.
- WebView2 rendered journeys at 1360×880 / 960×720 and 100/125/150% scaling, including
  Blob-download export and `window.prompt` rename in WebView2.
- Clean-machine MSI/NSIS install/upgrade/uninstall (AC-01/13/15).
- Signing, push/tag and remote CI on the final head.

## Readiness recommendation

**Do not accept as the v0.1 release candidate.** The foundations hold:

- storage, migration, admission derivation of `dir`/route;
- SHA-bound integrate;
- packaging closure;
- coordinator import.

The test suite is green. However, OPUS-01 and OPUS-02 cause silent loss of the displayed
transcript in ordinary long chats. OPUS-04 means recovery controls that are reported as
done do not work through the real host. All of these are bounded, locally fixable repairs
with clear regression tests. After repairs and a focused re-review, the candidate would
move to the externally blocked qualification gates listed above.
