# Cursor delivery review — 07dbb15..76076fb

Date: 2026-11-05. Reviewer: Claude Sonnet 5.5 (high effort), report-only audit run as an orch implementer in an isolated worktree. No source, dependency or settings changes were made. Nothing was committed. No live provider conversation was invoked. This is the revised report: a completion pass over the first draft (same file, same candidate), adding the previously unread tool-fact, CHO-04 and SESSION_* material, correcting requirement mappings, and recalibrating severity and certainty.

Independence statement: the Cursor authoring model is UNKNOWN. This report does not claim or prove model independence, and it is not an implementer receipt.

## 1. Scope and evidence

| Item | Value |
| --- | --- |
| Candidate | `76076fb3cd6c82f3ca7d74220d226e34955521c4` (branch `orch/cho-cursor-audit-20261105/sonnet-high`; the only change in the tree is this report) |
| Cursor delivery | `07dbb15..93c0332` |
| Correction commit | `93c0332..76076fb` (13 files, +550/-156) |
| Combined range | `07dbb15..76076fb` (26 files, +5485/-104) |
| Read in full (first pass) | `native-session-persistence.mjs`, `native-chat.mjs`, `NativeChat.tsx`, `delegation-associations.mjs`, `apps/desktop/src/lib/agent-task.ts`, `OrchAgentsPanel.tsx`, `native-chat-state.ts` (guard region), `orch/src/cleanup.mjs` (`cmdFinish`), `bridge.mjs` (orch router and `launchOrchRun`), `host.mjs` allowlist/delegation routing, Rust diff of `host_runtime.rs` and `lib.rs` |
| Read in full (completion pass) | `apps/desktop/server/session-tool-facts.mjs` (671 lines); `apps/desktop/src/session-tool-facts.test.mjs` (1269 lines, 28 `it` tests); `docs/contracts/SESSION_TOOL_FACTS.md`; `docs/work-packages/CHO-03-s3d-tool-lifecycle-handoff.md`; `docs/work-packages/CHO-04.md`; `claude-chat-actor.mjs` (419 lines, both diffs and the whole file in context); `packages/acp-client/src/claude-stream.ts` and `codex-app-server.ts` (the normalizers the tool facts are grounded in) |
| Read in the relevant sections (completion pass) | Contracts `SESSION_BINDINGS`, `SESSION_TURNS`, `SESSION_TURN_OUTCOMES`, `SESSION_EVENTS`, `SESSION_MESSAGE_DELTAS`, `SESSION_BODIES`, `SESSION_RECORDS`, `SESSION_STOPS`; `session-turns.mjs` `runSettleTurn`; `native-chat.mjs` tool-fact, settle, close and send regions; orch admission: `commands.mjs` `cmdRun`/`runWorkflowFields`, `cleanup.mjs`, `resources.mjs` (`cleanupAuthority`, `dependentRunBlock`, `inspectRemoval`), `claims.mjs` (`requireClaim`, `cmdRelease`), `models.mjs` `assertModelPermitted` |
| Read in full (docs) | PRODUCT_SPEC requirement rows, IMPLEMENTATION_PLAN, IMPLEMENTATION_STATUS, CURRENT_HANDOFF, TASKS, RELEASE_v01, CHO-03, FINDINGS_DISPOSITION, REUSE_AUDIT |
| Not read in full | The implementations of `session-records.mjs`, `session-bindings.mjs`, `session-events.mjs`, `session-bodies.mjs`, `session-stops.mjs` and the other `session-*` stores (contracts and exported surfaces only, plus the code paths the host calls); the orch adapters and each adapter's worker permission mode |
| Not executed | Any live Codex/Claude conversation, any packaged runtime, any Tauri build (see §5) |

Completed coverage with no defect found: the S3d storage module (`session-tool-facts.mjs`) matches its contract on every path I traced (see "Tool-fact storage" below). This is recorded as coverage, not only as a finding.

Evidence labels: **[read]** = established by reading source at the cited line; **[ran]** = established by running a command (including grep over the tree); **[inferred]** = follows from read code but was not reproduced. Most defects below are **[read]**. I did not write executable reproductions, so they are code-reading findings, not demonstrated failures.

Dependency resolution: the worktree has no `node_modules`. It sits under `C:\dev\CHO-desktop\`, so Node and TypeScript resolve packages from the parent checkout by directory walk-up. Tools were run by absolute path from the original checkout. No app file was altered. `USERPROFILE`/`HOME` were pointed at a temp directory so tests could not touch real user data.

### Tool-fact storage and consumer: completed coverage

- **Storage module [read].** `createSessionToolFacts` returns a frozen `{appendToolFact, inTransaction}`. The flow is: live-write authorization; turn lookup and operationId match; owner/host generation match (`ERR_FENCE_CONFLICT`); an existing event key puts the call in replay mode, otherwise the turn must be non-terminal with `dispatchState === "observed"`; optional body put under `factId`; a 15-field payload; `appendEvent` under key `tool_fact:<factId>`; a `lastToolTurn` watermark that only advances to a higher turn sequence and is validated against the real turn (8 keys). Phase/status coupling, replay idempotency and the "do not grow snapshot `bodyRefs`" rule match `SESSION_TOOL_FACTS.md`. I found no module-level defect.
- **Storage tests [read].** 28 tests on a real temporary SQLite store with synthetic `() => true` owner proofs and Codex/Claude-shaped fixtures. They cover payload/Unicode/empty summaries, phase-status mismatch, terminal and unobserved rejection, idempotency, watermark preservation, `bodyRefs` not growing past 64, stale-sequence rollback, dangling body (`ERR_STORAGE`), trigger faults (ABORT/IGNORE), proof denial, outer-transaction rollback, malformed watermark and reopen. Gap against the handoff's own acceptance list: the handoff asked for installed-Node and bundled-Node child-process probes (reopen plus a concurrent winner); the test file contains none, and its "competing sequence winner" is a sequential stale-sequence test. See F-13.
- **Consumer integration [read].** `persistMappedToolFact` (`native-chat.mjs:342-367`), `deliverMapped` (`:368-408`), `handleClaudeDurableEvent` (`:701-777`), `appendToolFact` (`native-session-persistence.mjs:637-670`), hydrate tool-fact collapse by `toolCallId` (`:386-404`) and `pollUiCatchup` `tool_fact` → `tool_call` expansion (`:781-805`). Defects are in F-13. The Claude actor rewrites a normalizer `tool_result` into a `tool_call` event carrying the name looked up from its own tool map (`claude-chat-actor.mjs:245`); the normalizer only emits results for ids in `toolUseIds`, so a missing name is not reachable on the path I traced.
- **`claude-chat-actor.mjs` in context [read].** First diff: optional `requestedNativeSessionId`/`requestedNativeUserMessageId` validated with `idOk`, and a mismatch check against an existing session. Second diff: `session.resume` passed as `resume: session.resume === true` to `openClient`. Both are consistent with `SESSION_BINDINGS` (requested id versus bound native ref). One gap: the not-sent path (`:331`) emits "Claude message was not sent" with no native outcome and the host does not settle the durable turn (F-08).

## 2. Disposition of the eight earlier findings

Status terms: resolved / partially resolved / unresolved / refuted / unverifiable.

| # | Finding | Status | Current evidence | Missing regression coverage |
| --- | --- | --- | --- | --- |
| 1 | P1 durable poll ordering (catch-up prepended, reducer completes turn on durable data, live text dropped) | **Resolved as stated; durable delivery still open (acknowledged, F-02)** | Order is now live first, with durable events for turns that have live events filtered out: `native-chat.mjs:1040-1082`. The reducer ignores durable events for the active turn while busy and ignores durable terminal events when not busy: `native-chat-state.ts:254-271`. The ordering corruption cannot recur. Because the guards then drop every durable event that could matter, `pollUiCatchup` (`native-session-persistence.mjs:725-814`) currently has no effect on UI state. The status documents say native mailbox/poll/UI are still memory-backed, so this is an acknowledged unfinished feature; the wording in CURRENT_HANDOFF/RELEASE_v01 that calls the poll wired is the overclaim (F-02, F-10). | One reducer unit test (`native-chat-state.test.ts`, "ignores all durable events for the active turn while busy…"). No test through `cmdPoll` with a real store; no test that a lost poll response is recovered. The new test asserts that durable data is ignored, so it passes whether or not recovery works. |
| 2 | P1 resume: Codex hydrate lacks `thread/resume`; Claude lacks `--resume` | **Resolved in source; wire behaviour unverifiable here** | Codex: `thread/resume` is sent before `turn/start` when `threadResumed !== true`, `native-chat.mjs:954-971`; hydrate sets `threadResumed:false`, `:1383,:1396`. Claude: `resumeExisting` from `nativeBound`, `:812,:847`; `claude-client.mjs:160` chooses `--resume` vs `--session-id`; `claude-chat-actor.mjs` passes `resume`. Hydrate's `nativeSessionUuid` comes from the *bound* native ref (`native-session-persistence.mjs:456-466`), so a request-only UUID is not resumed (consistent with `SESSION_BINDINGS`). Param names match the Codex app-server schema inspected at the pinned SHA (§6). No live conversation was invoked, so whether installed Codex/Claude versions accept these calls is unverifiable. | `thread/resume`: **no test**. `--resume` is covered only at argv level in `claude-client.test.ts`. No test for hydrate → send → resume ordering, none for resume failure. SESSION-03 requires an explicit recovery choice for an unsupported or failed resume; none exists (F-07). |
| 3 | P1 ownership: `host-reclaim` marked any held fence dead without proof | **Partially resolved** | Reclaim now requires a liveness record matching the fence owner token and generation, a different host generation and a dead PID (`native-session-persistence.mjs:188-246`); the host re-verifies in `verifyPersistenceOwner` (`native-chat.mjs:117-141`). This closes the unconditional-steal bug. But `SESSION_BINDINGS` says the host must verify "complete process identity, liveness, token association and proof freshness" and that there is "no default verifier, PID-only death check, TTL takeover or manual override"; `evidenceProcessDead` (`:142-154`) is a PID-only death check, with EPERM/access errors counted as dead. See F-05. | **No test** for EPERM, PID reuse, concurrent liveness-map writes, or a crashed host with no entry. |
| 4 | P1 close: `state.closed` set before `resetProject` settlement, aborting native cleanup | **Partially resolved; settlement content is now wrong (F-12) and cleanup is still skippable (F-03)** | Order fixed: `close()` sets `shuttingDown`, awaits `resetProject()`, then sets `closed` in `finally` (`native-chat.mjs:1419-1434`); `verifyPersistenceOwner` accepts `closed && shuttingDown` (`:122`). But `resetProject()` calls `settleDurableForShutdown()` synchronously with no try/finally (`:1303-1328`), and `durablePersist` rethrows (`:178-182`), so a settle failure skips `closeClient`. Separately, the settlement records `interrupted` for in-flight turns without a native interrupted outcome (F-12). | **No test** for close with a durable-settle failure, for `shuttingDown`, or for the outcome recorded at close. |
| 5 | P1 delegation recovery (side effects before IDs durably recorded; reconcile before and after each side effect; uncertain outcomes; repo/process ownership; `associationId` resume in UI) | **Partially resolved** | Stages exist and are persisted: `claimed → preparing_worktree → worktree → launching → running` in `apps/desktop/src/lib/agent-task.ts:57-181`; the store is file-backed with atomic rename (`delegation-associations.mjs:96-104`). The UI exposes "Use for resume" and passes `associationId` (`OrchAgentsPanel.tsx:106-147,252-261`). Gaps in F-04: stage is written before the side effect; uncertain `orch_run` results block retry with no reconcile action; the open-association lookup ignores `conversationId`; nothing reconciles against orch. | `agent-task.test.ts` has 4 pre-existing launch-order tests. **Nothing** covers stage persistence, resume by `associationId`, interrupted worktree/launch, or the duplicate-launch path. `delegation-associations.test.mjs` has 1 test. |
| 6 | P2 integration: Integrate called `orch_finish` but claimed integration | **Resolved** | `finishDelegation` is worded as coordinator closure (`agent-task.ts:209-234`), `integrateDelegation` is a deprecated alias (`:236-242`), the Integrate button is permanently disabled with an honest title (`OrchAgentsPanel.tsx:276-283`), and the intro text states Finish does not merge (`:176-178`). `orch_finish` is gated by orch (terminal runs, recorded disposition, converged gate, clean independent review: `orch/src/cleanup.mjs:90-175`) and `execOrchTool` treats a non-zero exit as `ok:false`, so "incomplete" surfaces as an error. Residual UX gaps are in F-09; the stale alias `"integrated"` is still accepted by the store (`delegation-associations.mjs:21-36`); docs still say "Integrate" (F-10). | No test that Finish refuses on `incomplete` or that Integrate is unavailable. |
| 7 | P2 accepted lifecycle: UI hid non-none dispositions; store prohibited accepted→integrated | **Resolved** | Store allows `accepted → finished/discarded` (`delegation-associations.mjs:30-36`); the panel shows open items for `none` and `accepted` (`OrchAgentsPanel.tsx:19-21,166`), Accept only for `none` (`:262`), Finish/Discard for both. Accept records in orch first (`agent-task.ts:184-207`) then locally; a failure between the two leaves orch `accepted` and local `none`, which is safe because retry re-records. | One store test; no UI or transition-matrix test. |
| 8 | P2 draft races (shared `expectedVersion`; conflict ignored; debounce restores text after Send; per-chat switching, close/unmount, send failure, CAS conflict, stale responses, flush/cancel) | **Partially resolved** | Per-chat keyed state with a serial save chain fixes overlapping saves (`NativeChat.tsx:189-249`). Send cancels the timer, awaits the chain, then clears with the latest version (`:251-275,:392-401`), so restore-after-Send is gone on the normal path. Still open (F-06): the conflict receipt is recorded and the loop breaks with no user feedback; `loadDraftFor` overwrites the whole meta entry (`:161-175`); unmount does not flush or cancel timers (`:277-286`); a failed send does not restore the prompt. The store already has `listDraftConflicts`/`getDraftConflict`/`resolveDraftConflict` (`SESSION_RECORDS`, `session-records.mjs:712-765`), and a grep finds no caller in the host, persistence facade or `NativeChat.tsx` [ran]. | **No UI test** (`NativeChat` is not imported by any test). No host-level draft test. Store-level CAS is tested in `session-draft-resolution.test.mjs`, but the client protocol around it is not. |

## 3. Findings, prioritized

Classification key: **R** = regression in the reviewed commits (something that previously worked or was correct, or newly introduced wrong behaviour); **PE** = pre-existing; **EU** = explicitly unfinished (documented as such, so not a regression); **DO** = documentation overclaim; **UB** = unqualified behaviour (not stated in the UI or docs).

Requirement references use exact PRODUCT_SPEC IDs; where no numbered requirement exists I cite the contract or plan section. Mappings used: SESSION-02 = preserves messages, drafts, tool activity, harness/model, title, archive state; SESSION-03 = resume or explicit recovery choice; SESSION-04 = model change / harness change semantics; SESSION-05 = per-project isolation of events, drafts, approvals and tasks; RUN-01 = normalized tool invocation/result events; RUN-02 = duplicate delivery without corruption; RUN-03 = serialized turns; RUN-04 = persist before acknowledging, reconnect by cursor; RUN-05 = cancellation tracks process identity and respects coordinator ownership; RUN-06 = window-close behaviour; RUN-07 = actionable states including `interrupted` and `unknown`.

### P1

**F-12 — Close settlement records `interrupted` without a native interrupted outcome. Class: R. [read]**
- Where: `native-chat.mjs:1266-1301` (`settleDurableForShutdown`) and `:1303-1328` (`resetProject`); `native-session-persistence.mjs:672-709` (`settleTurn`).
- Claude path: `resetProject` sets `context.cancelled = true` *before* it calls `settleDurableForShutdown()`, and that function computes `claudeAlreadyCancelling = context?.cancelled === true`. The flag is therefore true on every close that has a context, so any observed in-flight Claude turn is settled `interrupted`.
- Codex path: `outcome = a.cancelPending || a.interruptSent ? "interrupted" : "unknown"`. Setting `interruptSent` records that an interrupt was *requested*.
- How it passes the store: `settleTurn` builds `nativeFact` from the host's own observed identity (`nativeIdentity`, `claudeInputUuid`, `nativeTurnId: null` for Claude) and supplies it for `interrupted`. That fact proves observation, not an interrupted outcome, so the store cannot tell the difference.
- Contract: `SESSION_STOPS` says an acknowledged stop "is not proof of an interrupted turn, stopped process or completed cleanup"; `SESSION_TURN_OUTCOMES` says interrupt acknowledgements are not proof that a native process stopped, and that a transport failure is not inferred to mean not-executed. Only a matching native outcome (the normalizers' `nativeOutcome: "interrupted"`, e.g. Claude `terminal_reason aborted_*`, Codex `turn.status === "interrupted"`) may mark a turn interrupted. Without one, the contract name is `unknown`.
- Consequence: durable history permanently says a turn was interrupted when the provider may have completed it or be still running. RUN-07 separates `interrupted` from `unknown`; RUN-05 forbids claiming processes stopped without evidence; RUN-06 requires close behaviour to be explicit. Any later logic that treats `interrupted` as safe to retry is exposed to duplicate execution.
- Correction: settle at close as `unknown` unless a native outcome for that turn has already been received and persisted. Keep the rest of the shutdown order. Add tests for each of: Claude in-flight at close, Codex with `interruptSent`, and a native `interrupted` outcome that arrived before close.

**F-04 — Delegation recovery is not reconcile-before/after-side-effect. Class: R. [read]**
- Where: `apps/desktop/src/lib/agent-task.ts:57-181`, `delegation-associations.mjs`.
- Triggers and consequences. Items 2, 3, 4, 5 and 7 are direct from the code; items 1 and 6 depend on orch behaviour I did not exercise.
  1. `orch_run` returns without `id`/`run_id` (conditional: orch normally returns one): stage becomes `running`, `runId:null`; the next Start/Resume falls through to a second `orch_run` for the same wp/slice (`:168-180`, `:102-153`). In the `cmdRun` path I read (`commands.mjs:58-135,405-440`) I found no same-slice duplicate-run guard, but I did not search the rest of orch for one.
  2. `orch_run` times out or the app dies after launch: stage `launching`, no `runId`. The guard at `:77-81` blocks forever; the UI offers no adopt-run or mark-failed action.
  3. Worktree created, app dies before `:140`: stage `preparing_worktree`, no path, blocked at `:82-85`. No lookup of existing orch worktrees.
  4. `claimed` is saved *before* `orch_claim` (`:88-100`); the record says claimed when it may not be.
  5. The open-association lookup ignores `conversationId` (`:66-75`) and then re-parents (`:90`), so conversation B can adopt A's run (SESSION-05 isolation).
  6. No check that a recorded `runId`/`worktreePath` still exists or belongs to this repo; nothing queries run status.
  7. Two windows or a double-click can both pass the list check; the file store has no cross-process lock and caches reads (`delegation-associations.mjs:77-94`). A corrupt file throws on every call; unknown stages are silently dropped on the next write (`normalizeRecord`).
- Requirement: CHO-05 recoverable stage transitions; ORCH-09 (claims and admission owned by the host). I do not cite RUN-04 for this finding: it concerns display replay, not coordinator launches.
- Correction: persist an *intent* record with a client-generated operation id before each call; reconcile after each call and on resume against orch (see I-5); treat unknown outcomes as `uncertain` with explicit actions (adopt, abandon); filter the open lookup by `conversationId`; refuse a second `orch_run` when a run for the same wp/slice is non-terminal.

### P2

**F-01 — The host trusts renderer-supplied arguments for `orch_*` mutations; host-owned admission (ORCH-09) is open. Class: EU + DO (the allowlist newly exposes the surface; R only for that exposure). [read]**
- Scope of the claim: this is a trust-boundary finding. I did **not** demonstrate an XSS or any other way for hostile script to reach the webview; the renderer is treated as the code that ships. The risk is that the host performs no check of its own on what that code sends.
- Where: allowlists added in this range at `apps/desktop/server/host.mjs:36-66` and `src-tauri/src/host_runtime.rs:19-56`; generic `host_invoke` passthrough in `src-tauri/src/lib.rs`; `api.ts:156-171`. The allowlist is by command *name* only. Arguments reach `handleBridgeCommand` unvalidated (`bridge.mjs:1447-1510`).
- What orch admission does and does not stop (checked in orch, not assumed):
  - `orch_run` with a renderer-chosen `dir`: `cmdRun` requires only that `dir` exists (`commands.mjs:78-81`). A managed-worktree wp mismatch is checked only when `wp` or `allow` is passed (`:408-411`), and the claim check (`assertPackageOpen`) is skipped when no `wp` is passed (`:58-67`). So a wp-less run in an arbitrary existing directory is admitted by orch. What that worker can then do depends on the adapter's permission mode, which I did not examine.
  - `ownerApprovedModel` maps to `--owner-approved-model`, which is the whole of the check for models the roster marks `requires_permission` (`models.mjs:76-82`). A renderer can self-approve.
  - Claimant identity (`by`) is validated only against a fixed list that includes `owner` (`claims.mjs:21,32`); it is a string, not an authenticated principal. `requireClaim` compares strings. Every desktop call passes `by:"owner"` (`agent-task.ts`, router default).
  - Not a risk (refuted, see F-09): cleanup and finish of active or dirty work. `cleanupAuthority` requires the current claim holder, `dependentRunBlock` retains anything a non-terminal or process-live run depends on, `inspectRemoval` retains dirty content and unmerged commits, and neither cleanup nor finish accepts `--force`. `orch_release --force` only removes a claim, requires a reason and is recorded (`claims.mjs:136-206`).
- Genuine ORCH-09 gaps that remain: the host does not bind a mutation to a conversation, scope, route or approval; there are no per-command argument schemas; `dir`, `allow`, `ownerApprovedModel` and `by` are renderer-chosen; no native tool/approval/isolation boundary exists for controller-originated delegation (not examined here; the plan lists it as future work, `IMPLEMENTATION_PLAN.md:194`).
- Requirement: ORCH-09. Because the plan lists host-owned admission as future work, the absence is not a regression. What is not disclosed is that the new allowlist makes the unadmitted surface callable, while RELEASE_v01 lists "Delegate via orch" as a working journey (F-10).
- Correction: per-command argument schemas in `host.mjs`; reject `ownerApprovedModel`, `allow` and `force` from the renderer; derive `dir` and `repo` from a host-created association record (`worktreeRecordForDir` can verify that a `dir` is a managed worktree of the claimed wp); make the host the claimant; state in the status docs that ORCH-09 is open.

**F-02 — Durable event delivery is not consumed; a lost poll response is not recovered. Class: EU + DO. [read]**
- Where: `native-chat-state.ts:254-271`; `native-chat.mjs:1040-1082`; docs `CURRENT_HANDOFF.md:65-66`, `RELEASE_v01.md:11`.
- Behaviour: `mailbox.drain()` is destructive and runs first (`cmdPoll`). If the response never reaches the renderer (reload, IPC drop), those live events are gone. The durable copy exists but the reducer discards it. The turn sits busy until the consumer lease expires and `fatalize` fires (`native-chat.mjs:193-199`), instead of reconnecting from a cursor (RUN-04). While durable events keep arriving, the loop polls with zero delay and applies nothing.
- Classification: IMPLEMENTATION_STATUS says the mailbox, host polling and UI still use memory, so the missing consumer is acknowledged unfinished work, not a regression introduced here. The overclaim is the "wired" wording elsewhere, and the cost is the busy-polling and the test that locks in "durable data is ignored".
- Correction: either apply a durable event when its sequence is newer than the last applied sequence for that turn and dedupe live events by id, or make the mailbox ack-based. Add a lost-poll-response test through `cmdPoll` and the reducer. Correct the docs.

**F-08 — Pre-observation failures leave turns non-terminal. Class: R. [read]**
- Contract: `SESSION_TURNS`/`runSettleTurn` allow a factless `failed` only while the operation state is `queued`. After dispatch admission (`dispatching`, `written`), a failure with no native fact must be settled as `unknown`; the contract says not to infer that a transport failure means not-executed. There is no `not_sent` terminal state.
- Where each path strands the turn [read]:
  - `failActiveTurn` (`native-chat.mjs:303-311`) never settles the durable turn, and `durableSettle` returns early unless `a.observed` (`:321`).
  - Codex `fatalize` (`:202-229`) performs no durable settle; afterwards the owner verifier is dead, so the turn cannot be settled later in the same process.
  - The Claude not-sent path (`claude-chat-actor.mjs:331`) emits an error without a native outcome and the host does not settle it.
  - At close, `settleDurableForShutdown` settles only observed turns (Codex `durableSettle`, Claude `state.claudeDurable.observed`), so a turn that was dispatched but not observed when the app closed is left as is.
  - There is no restart reconciliation of `dispatching`/`written` turns [ran: no such call in `native-chat.mjs` or `native-session-persistence.mjs`].
- Consequence: the durable record keeps a turn that is neither completed nor failed (RUN-07 `unknown` is never recorded). Whether a later send is blocked by such a turn depends on `SESSION_TURNS` admission, which I did not verify end to end.
- Correction: settle each of the above as `unknown` (with the owner proof still valid at that point, so settle before `fatalize` kills the verifier); add a start-up reconciliation that settles stranded `dispatching`/`written` turns as `unknown`. Do not introduce `not_sent`.

**F-03 — Close can still skip native client cleanup. Class: R. [read]** `native-chat.mjs:1303-1328` (with `:178-182`, `:1266-1301`). A settlement exception aborts `resetProject` before `closeClient`. Correction: wrap the settle in try/finally inside `resetProject`, always run the client close, then rethrow the settle failure. Test with a store that throws on `settleTurn`. (RUN-06.)

**F-05 — Ownership proof does not meet the `SESSION_BINDINGS` host obligations. Class: R. [read]** `native-session-persistence.mjs:29-37,39-58,188-246`; `native-chat.mjs:117-154`. The contract requires the host to verify complete process identity, liveness, token association and proof freshness, and names "PID-only death check" as something the store does not provide. The host supplies exactly a PID check: (a) EPERM means "alive but not signalable" and is treated as dead; (b) no process start time is recorded, so a recycled PID gives a permanent false-live lock (fails closed, with an error telling the user to start a new chat); (c) the liveness map is an unlocked read-modify-write, so two hosts can lose each other's entries; (d) a missing entry makes a crashed host's fence unrecoverable. Likelihood of a live fence being stolen is low on a single-user machine (it needs EPERM, i.e. another user or elevation), but the consequence is double-writer corruption. Correction in I-1. Contract reference, not a numbered requirement; RUN-03 (serialized turns) is the product behaviour at stake.

**F-06 — Draft handling gaps. Class: R (UB for conflicts). [read]** Requirements: SESSION-02 (drafts survive) and SESSION-05 (per-project draft isolation). See §2 row 8 for lines. Corrections: flush or cancel timers on conversation switch and unmount; merge rather than overwrite meta in `loadDraftFor` (keep `chain`, `inflight` and a pending local edit newer than the server draft); surface a conflict notice using the existing `listDraftConflicts`/`resolveDraftConflict` (I-3); restore the prompt on a send that fails before acknowledgement; do not create a conversation row from a draft save until the user sends (`cmdSaveDraft` calls `ensureConversation`, `native-chat.mjs:1100`, which also takes a producer fence).

**F-07 — Hydrate and navigation lose or hide history. Class: R + EU. [read]** Requirements: SESSION-02 (history preserved), SESSION-03 (no silent short-transcript substitute).
- `hydrateConversation` reads at most 100 turns and 64 pages × 32 events = 2048 events and returns `hasMoreEvents` (`native-session-persistence.mjs:357-418,470`); `NativeChat.tsx` never reads `hasMoreEvents`, so long conversations show a truncated transcript without saying so.
- Prepare hydrates only the latest conversation of the selected controller (`NativeChat.tsx:330-352`); older conversations are unreachable although `listConversations` returns them.
- A hydrate failure is swallowed (`catch {}` at `:345-348`), so the user gets a fresh chat while the old one exists; the next send creates a second durable conversation.
- Hydrated unfinished turns render with `isStreaming:false` and no state, so an interrupted turn shows an empty assistant bubble.
- Claude with an unbound native session starts a new session UUID while the transcript still shows old messages: silent loss of model context, which SESSION-03 forbids without an explicit recovery choice.

**F-13 — Tool-fact consumer is untested, deviates from the contract on identifiers, and its failures are fatal. Class: R (new consumer code). [read unless noted]**
- No consumer tests [ran]: `persistMappedToolFact`, the tool-fact branch of `hydrateConversation` and the `tool_fact` expansion in `pollUiCatchup` are not referenced by any test; the dual-write tests in `native-chat.test.mjs` (~1227-1345) cover deltas and outcomes only. The 28 storage tests exercise the store, not the mapping from normalizer events to arguments.
- `factId` per frame: `persistMappedToolFact` calls `crypto.randomUUID()` for every mapped event. `SESSION_TOOL_FACTS.md:42` says the `factId` is allocated once per accepted `toolCallId`+`phase` by the actor and retained across retries. With a fresh id per call, an exact retry cannot hit the store's idempotent path, and a repeated provider frame for the same `toolCallId`+phase becomes a second `tool_fact` event. The UI hides this because hydrate collapses facts by `toolCallId`, so duplicates show only in event counts and snapshots. Whether Claude or Codex actually re-emit the same frame on this path I did not trace to the persistence call [inferred]; a per-(`toolCallId`, phase) id map in the actor removes the question.
- `nativeMessageId` for Codex: the contract says it is "omitted/ignored for Codex item-only facts" (`SESSION_TOOL_FACTS.md:34`). The host falls back to `item.nativeItemId` for it (`native-chat.mjs:342-367`), and the store has no harness-specific rule [inferred from the module], so Codex item ids are persisted in a Claude message-id field.
- Failure policy: tool facts are auxiliary display data, but `durablePersist` rethrows and `deliverMapped` writes durably before `enqueue`, so a tool-fact storage error fatalizes the whole conversation turn (with the F-08 consequences). Contract RUN-01/RUN-02 do not require this; a tool-fact error should at least not discard the live event or end the turn.
- Evidence gap against the S3d handoff: the handoff's acceptance asked for installed-Node and bundled-Node child-process probes (reopen plus concurrent winner); the test file has none [read], and CHO-03.md still lists "S3d actor wiring"/"S3d tool consumer wiring" as missing in one section while claiming "Actor wiring (2026-11-05)" in another (F-10).
- Requirements: RUN-01 (tool invocation/result events), RUN-02 (duplicate delivery), SESSION-02 (tool activity preserved).
- Correction: allocate and retain `factId` per (`toolCallId`, phase) in the actor; drop the Codex `nativeMessageId` fallback; decide whether tool-fact errors degrade rather than fatalize; add consumer tests (mapping, hydrate collapse, catch-up expansion, failure policy) and, if the handoff criterion still stands, the child-process probes.

### P3

**F-09 — Finish/Discard guards and genuine UX gaps. Class: UB for the gaps. [read]**
- Known coordinator guards (these are not defects; I checked them in orch rather than assuming):
  - `cleanup --apply` requires the current claim holder or recorded closed-package authority (`cleanupAuthority`, `resources.mjs:145-154`) and rechecks it at deletion.
  - `dependentRunBlock` retains any resource that a non-terminal run, or a run whose worker/keeper/monitor process is still live or uncertain by identity, depends on (`resources.mjs:207-247`).
  - `inspectRemoval` retains dirty or ignored content and unmerged commits (`:253-285`).
  - `cleanup` and `finish` reject `--force` and `--delete-branch` (`cleanup.mjs:80,93`); `finish` needs terminal runs, recorded dispositions, a converged gate and a clean independent review (`:105-135`).
  - `execOrchTool` reports a non-zero exit as `ok:false`, and `discardDelegation` throws before `orch_release --force` when cleanup is not `ok`, so a retained resource stops the discard. `release --force` needs a reason, is recorded, and removes only the claim (`claims.mjs:136-206`).
- Therefore the first draft's concern that Discard could remove active work is **refuted** by existing guards.
- Genuine UX gaps that remain:
  1. Finish removes the worktree (`cleanupLocked`), but the button title and panel text only say "does not merge".
  2. The panel never shows run, gate, review or retention state; the user sees why Finish or Discard was refused only through orch's raw error text. The router already supports a preview (`orch_cleanup` without `apply` runs `--dry-run`, `bridge.mjs:1500`), but `agent-task.ts` calls cleanup only with `apply:true`.
  3. When orch retains content (dirty files, unmerged commits), orch's remedy is explicit retained-resource decisions (`finish --retain`); the UI offers no route to them.
- Correction: show run status, gate decision, review outcome and the `inspectRemoval` dry-run result in each association row (I-5); warn that Finish removes the worktree.

**F-10 — Documentation overclaims and stale text. Class: DO.**
- `CURRENT_HANDOFF.md:65-68` and `RELEASE_v01.md:11` say durable poll is wired (F-02).
- `CURRENT_HANDOFF.md:67-68` says "Accept / Integrate / Discard are in NativeChat": they are in `OrchAgentsPanel`, and Integrate is disabled. `RELEASE_v01.md:13` labels the journey "Accept / integrate / discard".
- `IMPLEMENTATION_STATUS.md` (S3d section) ends "The native mailbox, host polling and UI still use memory; actor wiring remains pending", contradicting CURRENT_HANDOFF in the same range.
- `SESSION_TOOL_FACTS.md:4` still says native actors, mailbox, poll RPC and UI "remain unwired"; `CHO-03.md` says both "S3d actor wiring" is missing and that actor wiring was done (2026-11-05). The S3d handoff names `factId` retention as an actor responsibility; the actor does not do it (F-13).
- `RELEASE_v01.md:18` says `rustc`/`cargo` are not on PATH. That was true of the author's shell; on this machine they are at `~\.cargo\bin` (not on the Git Bash PATH). The release claim "Delegate via orch: Agents panel + recoverable associations" is stronger than F-01/F-04 allow.
- No status document says ORCH-09 is open or that the new allowlist makes unadmitted orch mutation callable.

**F-11 — Codex `thread/resume` may return the whole turn history. Class: UB (low).** CHO sends no `excludeTurns`; the schema I inspected has `excludeTurns: bool` for exactly this (§6). The response is ignored by CHO but still crosses the stdio frame. Verify against the installed Codex version's generated schema before changing.

### Not found / refuted

- The first draft's claim that Discard could remove active work, and that cleanup could run outside coordinator guards, is refuted by the guards listed under F-09.
- The first draft's suggestion of a `not_sent` terminal state is withdrawn: the contract name is `unknown` (F-08).
- Stale-response bugs in `loadDraftFor`: guarded by `selectedRef`/`mounted` (`NativeChat.tsx:163-164`). The remaining race is the meta overwrite.
- The poll loop uses `selectedRef` and `cursorRef` per conversation; no cross-project cursor leakage found.
- `orch_finish` is not a Git integration and the code no longer pretends otherwise (§2 row 6). `acceptDelegation` makes no Git calls.
- Tool-fact storage module: no defect found against `SESSION_TOOL_FACTS.md` (§1).

## 4. Coverage against spec, plan and gates

| Area | Spec / plan | State at 76076fb | Honest status |
| --- | --- | --- | --- |
| Session store S1–S3d | SESSION-01..02, CHO-03 | Storage and dual-write implemented; tool-fact storage matches its contract and has 28 store tests | Strong at the storage layer. Consumer layer thinner than the docs imply (F-13); no child-process probes for S3d |
| Native dual-write | CHO-03 consumer path | Codex and Claude journal turns; two focused host tests (deltas, outcomes) | Present; no tests for tool facts, failure paths, pre-observation, settle error or resume |
| Durable event delivery / cursor | RUN-04 | Cursor is produced and advanced, not applied | **Not met; acknowledged unfinished** (F-02) |
| Hydrate / resume | SESSION-02, SESSION-03 | Hydrate and resume wiring exist; truncated and latest-only; no recovery choice | Partial (F-07) |
| Drafts | SESSION-02, SESSION-05 | Debounced CAS saves; conflicts unresolved; conflict APIs unused | Partial (F-06) |
| Pagination | SESSION_EVENTS paging contract (no numbered requirement) | Server pages; UI ignores `hasMore*` on hydrate | Not met on the UI side |
| Ownership fences | `SESSION_BINDINGS` host obligations; RUN-03 | Proof-of-death required; PID-only check, EPERM and PID-reuse gaps | Partial (F-05) |
| Close / stop settlement | RUN-05, RUN-06, RUN-07; `SESSION_STOPS`, `SESSION_TURN_OUTCOMES` | Close settles `interrupted` without native proof; stranded unobserved turns; `session-stops` unwired | **Not met** (F-12, F-08, F-03) |
| Delegation association | CHO-05 | Stages, store, panel, accept/finish/discard | Partial (F-04, F-09) |
| Host-owned admission | ORCH-09 | Not implemented; plan lists it as future; surface newly callable | **Open, acknowledged in the plan, not disclosed for the new surface** (F-01) |
| Gate/review evidence in UI | `orch` review/gate model (no numbered requirement mapped) | Enforced inside orch's `finish`; not displayed | Partial (F-09) |
| Accept ≠ Git | PRODUCT_SPEC accept/integrate separation | Integrate disabled, Finish worded as closure | Met, with the worktree-removal caveat |
| Packaged runtime parity | ARCH, RELEASE_v01 | Rust allowlist matches `host.mjs` by inspection; not built or run here | Unverified (see §5) |
| Approvals / clarifications durability | CHO-03 / SESSION_EVENTS non-goals (no numbered requirement mapped) | Mailbox only, stated in docs | EU, honestly documented. Cancellation ownership (RUN-05) is a separate area, tracked under close/stop above |

Milestones: M0/M1 foundations are credible. **M2 (durable conversations) is not ready**: close records unsupported outcomes, unobserved or failed turns are left non-terminal, the cursor path does not deliver events (acknowledged), and the UI cannot reach older conversations or show truncation. **M3 (delegation) is not ready**: host-owned admission is absent (acknowledged) and recovery has duplicate-launch and dead-end states. I would not call the "local delivery" claims in CURRENT_HANDOFF accurate until F-12, F-04 and the F-02/F-01 wording are addressed. This is a judgment from reading, not a claim that existing tests are wrong. Procedural deviations (unknown authoring model, status-doc wording) are minor next to these code findings and are not weighted.

## 5. Validation

Broad checks were **not rerun** in this completion pass. Established results:

| Check | Source | Result |
| --- | --- | --- |
| `npm test` (outside the sandbox) | Controller run; logs in `C:/dev/CHO-desktop/.reviews/cursor-review-20261105/` | 44 shared + 719 desktop = **763 passed** |
| Typecheck, build | Controller run (same logs) | pass |
| Desktop tests | My first pass: `vitest run --no-cache` | exit 0; 31 files, 719 passed |
| Desktop typecheck / web build / acp-client typecheck and tests | My first pass | exit 0; build 39 modules, JS 221.80 kB; acp-client 3 files, 44 tests |
| Orch tests | My first pass: `node --test orch/test/unit.test.mjs orch/test/adapter-claude.test.mjs orch/test/adapter-grok.test.mjs` | exit 0; 61 tests, 61 pass |
| Rust | `cargo test --offline --locked` in `src-tauri` (`cargo 1.99.1`, `rustc 1.99.1` under `~\.cargo\bin`) | **Did not run tests.** Dependencies compiled offline, then `tauri-build` failed: `resource path '.runtime' doesn't exist`. The only producer is `scripts/prepare-runtime.mjs`, which downloads and stages a Node runtime, so I did not run it (no downloads of executable code, no installs). An environment precondition, **not** a product defect and not a sandbox EPERM. The Rust diff was read, not compiled or tested. |
| This pass | Read-only inspection (file reads, `git`, grep) | No tests, builds or runtimes were started; the tree is unchanged apart from this report |

Passing suites show only that the tests that exist pass. They do not cover resume, reclaim edge cases, close outcomes or close-on-failure, tool-fact consumer paths, cursor recovery, drafts in the UI, or delegation recovery.

## 6. Reuse, sources and licences

REUSE_AUDIT.md was read as historical context; its conclusions (reuse orch; do not adopt Grok's JSONL store; freeze the triple stack; write the NOTICE) still stand and my independent inspection supports them. The largest remaining work is CHO-internal.

### Internal reuse first (CHO-INTERNAL)

The gaps in §3 are mostly answered by code CHO already has. Targets are exact; none requires a new architecture.

| # | Gap | Existing CHO symbol(s) to use | Where to apply |
| --- | --- | --- | --- |
| I-1 | F-05 weak ownership proof (PID-only, EPERM, PID reuse) | `readProcessTable` and `verifyIdentity(pid, recordedCreatedAt, table)` in `orch/src/procs.mjs:164,313`, already used by `dependentRunBlock` (`resources.mjs:207-247`); `bridge.mjs` already imports orch modules, so there is a precedent for desktop code calling them | Replace `evidenceProcessDead` (`native-chat.mjs:142-154`) and the liveness record (`native-session-persistence.mjs:29-58`). Requires recording the process creation time with the liveness entry. Treat a "live or uncertain" verdict as not dead |
| I-2 | F-12 / F-08 / F-03 close, failure and stop settlement | `session-turns` `settleTurn` (factless `unknown` is legal after dispatch); `session-turn-outcomes` `settleTurn`; `session-stops` `requestStop` / `beginStopDispatch` / `recordStopWritten` / `settleStop` (currently unreferenced by the host [ran]) | `settleDurableForShutdown` (`native-chat.mjs:1266-1301`), `failActiveTurn` (`:303-311`), Codex `fatalize` (`:202-229`), the Claude not-sent branch, and `resetProject` (`:1303-1328`) |
| I-3 | F-06 draft conflicts and F-07 history | `session-records` `listDraftConflicts`, `getDraftConflict`, `resolveDraftConflict` (`session-records.mjs:712-765`, exported at `:1007-1011`); `listConversations`; `hydrateConversation`'s `hasMoreEvents` | `cmdSaveDraft` conflict receipt (`NativeChat.tsx:218-224`); a conversation picker over `listConversations`; a "load earlier" control using `hasMoreEvents` |
| I-4 | F-13 factId and bodies | `session-tool-facts` `appendToolFact` replay path (exact retry is idempotent when `factId` is stable); `session-bodies` `getBody`/`readBodyChunk` for summaries | Actor-side (`toolCallId`, phase) → `factId` map used by `persistMappedToolFact` |
| I-5 | F-04 reconcile and F-09 evidence display | Coordinator APIs already behind the bridge: `getOrchDashboard` / `orch_dashboard` (claims, worktrees, runs), `getOrchRunDetail` / `orch_run_detail` (`bridge.mjs:1315`), `orch_gate_status` (`gate.mjs` `computeGate`, `readRounds`), `orch_scope` (`worktrees.mjs` `cmdScope`, `scope.mjs` `evaluateScope`), `orch_cleanup` without `apply` (dry-run → `inspectRemoval`), `worktreeRecordForDir` / `listWorktreeRecords` (`worktrees.mjs:33,47`) | Before and after each stage in `agent-task.ts`; association rows in `OrchAgentsPanel.tsx` |
| I-6 | F-01 admission | `assertClaimant`/`CLAIMANTS`, `requireClaim` (`claims.mjs`), `worktreeRecordForDir` (derive `dir` from a managed worktree), the host-owned association store `delegation-associations.mjs` | Per-command schemas next to the allowlist in `host.mjs:36-66` |

### External sources

All clones are shallow and read-only under `C:\dev\CHO-desktop\.reviews\cursor-review-20261105\upstreams\`. Nothing was installed or executed, and nothing was copied into CHO. Permalinks use the pinned SHA. Where an entry says reference-only or avoid, no code is taken from the repository, so no legal approval step is implied beyond the usual attribution when code is actually adopted. The existing upstream evidence and SHAs below were not re-collected in this pass.

| Repo | Pinned SHA | Licence | Notes |
| --- | --- | --- | --- |
| RapidAI/grok-build-desktop | `77fbf105bf156df227f1612bdd5653ef1b38734d` (2026-07-16) | Apache-2.0 (header "Copyright 2023-2026 SpaceXAI") | Tauri shell plus the whole upstream Grok Build Rust tree (2803 files); `third_party/NOTICE`, `THIRD-PARTY-NOTICES` present |
| openai/codex (sparse: `app-server`, `app-server-protocol`) | `c48785a9b746cbfd01fcae3bef6e4dacb73ca49a` (2026-11-05) | Apache-2.0 | Protocol definitions, not installed-version specific |
| BloopAI/vibe-kanban | `08064e043c2d78ad123b473257ed867e7ce74768` (2026-11-03) | Apache-2.0 | Rust/React multi-agent task board with worktrees |
| stravu/crystal | `1e18e0bc981225f75b5226f82a300fa741970c6f` (2026-02-26) | MIT (`NOTICES` for deps) | Electron multi-session Claude Code manager with worktrees |
| agentclientprotocol/claude-agent-acp | `85aec26ef984a421fe8064ce43f60138a3372384` (2026-11-05) | Apache-2.0 | ACP agent wrapping the Claude SDK |

**RapidAI/grok-build-desktop**
- Inspected: `apps/desktop/src-tauri/src/acp/framing.rs` (34 lines), `acp/client.rs` (493), `trust.rs` (92), `secrets.rs` (26), `tests/multi_session.rs` (55), `App.tsx` (311), `crates/codegen/xai-chat-state/src/persistence.rs` (173).
- Demonstrated code: line framing with no size bound ([framing.rs L1-L16](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/src/acp/framing.rs#L1-L16)); a request with a fixed 120 s timeout and a pending-map ([client.rs L181-L208](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/src/acp/client.rs#L181-L208)); `session/load` and permission replies with an explicit `cancelled` outcome ([client.rs L259-L320](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/src/acp/client.rs#L259-L320)); a persistence trait appending to `chat_history.jsonl` through an unbounded channel with no fences or cursors ([persistence.rs L1-L35](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/crates/codegen/xai-chat-state/src/persistence.rs#L1-L35)); a keyring wrapper ([secrets.rs](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/src/secrets.rs)); trust by path-prefix match in a text file ([trust.rs L14-L40](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/src/trust.rs#L14-L40)).
- README promises vs code: the "multi-session overview" test is tautological (it builds a `HashMap` in the test and greps `App.tsx` for strings, [multi_session.rs L1-L55](https://github.com/RapidAI/grok-build-desktop/blob/77fbf105bf156df227f1612bdd5653ef1b38734d/apps/desktop/src-tauri/tests/multi_session.rs#L1-L55)). The desktop shell is small (App.tsx 311 lines); no diff viewer to borrow. `client.rs` falls back to `XAI_API_KEY="test-key"` when unset. Its trust path does no canonicalisation.
- CHO provenance check [ran]: `main.tsx` differs from RapidAI's only by line endings and a cast; `index.html`, `vite.config.ts`, `tsconfig.json`, `build.rs`, `main.rs`, `capabilities/default.json` each differ; `packages/acp-client/src/index.ts` is 81 lines upstream vs. 302 in CHO. CHO's README names RapidAI as an architectural source. There is no NOTICE file in CHO. This is a retained-scaffold attribution matter specific to files CHO already carries, not something that applies to reference-only reading; its scope is the owner's decision (U-4).
- Verdict: **reference-only** for ACP request/permission semantics (relevant only if CHO adds an ACP harness); **avoid** persistence, trust, framing and keyring code (CHO's `host_wire.rs` and SQLite contracts are stricter, and CHO uses installed-CLI auth).

**openai/codex app-server protocol**
- File: `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`, `ThreadResumeParams` ([L338-L430](https://github.com/openai/codex/blob/c48785a9b746cbfd01fcae3bef6e4dacb73ca49a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L338-L430)). Demonstrated: camelCase fields `threadId`, `model`, `modelProvider`, `cwd`, `approvalPolicy`, `sandbox`, `config`, plus `excludeTurns` and an experimental `initialTurnsPage`; resume by `threadId` loads from disk and rejoins a running thread. This matches CHO's call (`native-chat.mjs:957-965`) and shows the `excludeTurns` option CHO does not use.
- Use: **reference** the schema; **adapt** by generating the schema for the *installed* Codex version and pinning a contract test to it. Limits: this is HEAD at one SHA, not the version users run; parts are experimental.

**BloopAI/vibe-kanban**
- `cleanup_orphan_executions` ([container.rs L272-L325](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/crates/services/src/services/container.rs#L272-L325)) marks every DB row still "running" as failed at startup and records the repo's head commit, without checking process liveness. `ensure_worktree_exists` uses a per-path async lock and an "is properly set up" check before recreation ([worktree_manager.rs L86-L116](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/crates/worktree-manager/src/worktree_manager.rs#L86-L116)).
- Use: **reference-only**. The startup-reconcile idea is what CHO lacks for stranded turns (F-08) and `launching` stages (F-04), but CHO should settle to `unknown`/`uncertain`, not `failed`, using I-1 and I-2. Do not adopt its executor model: it would be a second coordinator. Limits: I read these two functions and the directory listing only.

**stravu/crystal** (MIT)
- `ClaudeCodeManager` refuses to resume without a stored Claude session id and throws instead of starting fresh ([claudeCodeManager.ts L111-L121](https://github.com/stravu/crystal/blob/1e18e0bc981225f75b5226f82a300fa741970c6f/main/src/services/panels/claude/claudeCodeManager.ts#L111-L121)); the IPC layer starts fresh only on the first message ([session.ts L1176-L1196](https://github.com/stravu/crystal/blob/1e18e0bc981225f75b5226f82a300fa741970c6f/main/src/ipc/session.ts#L1176-L1196)). It also falls back to `--dangerously-skip-permissions` when its approval IPC is unavailable ([L98-L104](https://github.com/stravu/crystal/blob/1e18e0bc981225f75b5226f82a300fa741970c6f/main/src/services/panels/claude/claudeCodeManager.ts#L98-L104)).
- Use: **reference-only** for the "resume requires a bound id; otherwise the user sees an error" rule, which is the missing SESSION-03 recovery choice (F-07). **Avoid** the permission fallback.

**agentclientprotocol/claude-agent-acp**
- `acp-agent.ts` documents that `loadSession`/`resumeSession` with changed options must rebuild the query process ([comments at L1210 and L1823](https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L1823)). **Evidence limit:** comments and identifiers via search only; the behaviour was not read. A lead, not a demonstrated pattern.

### Rejected alternatives and scope
- Adopting Grok's JSONL/`chat_history.jsonl` store: no fences, cursors or CAS; conflicts with the SQLite contracts.
- Adopting vibe-kanban's executor/task model or crystal's session manager: each is a second coordinator and a provider-specific transcript format.
- OS keyring (`secrets.rs`): CHO deliberately uses the installed CLIs' own auth.
- Other projects were not examined, so nothing is said here about their code or licences.

### External recommendations (gap → source → target)

| # | Gap / requirement | Source | Verdict | CHO target | Effort / deps | Licence | Risks / limits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U-1 | Verify `thread/resume` shape against the installed Codex; consider `excludeTurns` (F-11, §2 row 2) | openai/codex `thread.rs` L338-L430 @ `c48785a` | Reference + contract test | `native-chat.mjs:957`, new test | S; needs a local Codex binary for schema generation, no provider conversation | Apache-2.0: nothing copied | Schema is HEAD, not the installed version |
| U-2 | Startup reconcile idea for stranded turns and delegation stages (F-04, F-08) | vibe-kanban `container.rs` L272-L325 @ `08064e0` | Reference-only | Use I-1/I-2/I-5, not new code | M; depends on F-08 | Apache-2.0: none if no code is copied | Their policy ("failed") is wrong for CHO |
| U-3 | Explicit resume-or-restart rule for Claude (F-07) | crystal `claudeCodeManager.ts` L111-L121 @ `1e18e0b` | Reference-only | `cmdSendClaude` plus a UI notice for unbound sessions | S-M | MIT: none if no code is copied | One product's behaviour, not a standard |
| U-4 | Attribution for the retained shell scaffold | RapidAI `LICENSE`, `third_party/NOTICE` @ `77fbf10` | Adapt (document) | New root `NOTICE`; `orch/THIRD_PARTY.md` unaffected | S; owner decides scope | Apache-2.0 §4 applies to files CHO actually retains | Scope of retained lines not settled here |
| U-5 | ACP permission-reply semantics, if CHO adds an ACP harness | RapidAI `client.rs` L282-L320 @ `77fbf10` | Reference-only | Future ACP adapter only | n/a now | Apache-2.0 | CHO has no ACP path today; upstream test evidence is weak |

Nothing in these repositories should replace CHO's coordinator, session contracts or host wire.

## 7. Ordered next actions

1. F-12 (with F-03): settle `unknown` at close unless a native outcome was already persisted; try/finally in `resetProject`. Tests for Claude in-flight, Codex `interruptSent`, native outcome received, and a store that throws on settle (I-2).
2. F-04: intent-before-effect with reconcile against orch (I-5), `conversationId` in the lookup, a non-terminal-run duplicate guard, UI actions for `uncertain`/stuck stages. `agent-task` tests per stage interruption and for resume by `associationId`.
3. F-08: settle pre-observation failures and not-sent as `unknown` before `fatalize`, and add start-up reconciliation of `dispatching`/`written` turns (I-2). Do not add `not_sent`.
4. F-01: per-command argument schemas and host-derived `dir`/claimant (I-6); say in the status docs that ORCH-09 is open.
5. F-13: stable `factId` per (`toolCallId`, phase); drop the Codex `nativeMessageId` fallback; settle the failure policy; consumer tests; child-process probes if the S3d criterion stands.
6. F-02: durable events authoritative for state the renderer lacks (sequence-based apply with dedupe), or an ack-based mailbox; lost-poll test; correct CURRENT_HANDOFF and RELEASE_v01.
7. F-05 via I-1; F-07 and F-06 via I-3 plus UI tests (there are none for `NativeChat.tsx`).
8. F-09: show run/gate/review/dry-run state and the worktree-removal warning (I-5); F-10 doc corrections.
9. Run the Rust build and host tests where the owner has run `scripts/prepare-runtime.mjs`, then the packaged-runtime parity check and the clean-machine installer smoke test listed as open in RELEASE_v01.
10. U-4: decide the NOTICE scope. Optional: U-1 contract test.

## 8. Limits and uncertainty

- Findings marked **[read]** were not reproduced with executable tests; some may behave differently at runtime through paths I did not trace. In particular F-04 items 1 and 6 depend on orch behaviour, F-13's duplicate-frame consequence is [inferred], and the effect of a wp-less `orch_run` in a foreign directory depends on the adapter's permission mode, which I did not examine.
- Real Codex/Claude behaviour (`thread/resume`, `--resume`) was not exercised; no live provider conversation was invoked.
- The Rust code, packaged runtime and installer were not built or run (the `.runtime` precondition is kept as a limitation; no runtime was staged, downloaded or executed).
- Store implementations other than `session-tool-facts.mjs` were reviewed at their contracts, exported surfaces and the paths the host calls, not line by line. I make no claim about their internals beyond that and the passing tests.
- External research used shallow clones at one SHA each; commit history, issues and release practice were not reviewed and no web UI was opened. README claims in those repositories are treated as claims. Remote content was treated as untrusted data; nothing was executed.
- The controller should verify containment: this audit created `C:\dev\CHO-desktop\.reviews\cursor-review-20261105\upstreams\` (five shallow clones), and build output and logs under the system temp directory, none inside the worktree. The only repository change is this report.

## 9. Summary

**Eight earlier findings.** 1 poll ordering: resolved (durable delivery still open, acknowledged). 2 resume: resolved in source, wire behaviour unverifiable. 3 ownership: partially resolved (F-05). 4 close: partially resolved; cleanup still skippable (F-03) and the recorded outcome is wrong (F-12). 5 delegation recovery: partially resolved (F-04). 6 integration wording: resolved. 7 accepted lifecycle: resolved. 8 drafts: partially resolved (F-06).

**Outstanding, by priority.**
- P1: F-12 (close records `interrupted` without a native outcome), F-04 (delegation recovery).
- P2: F-01 (host trusts renderer arguments; ORCH-09 open; no XSS demonstrated), F-02 (durable events not consumed; acknowledged), F-08 (stranded turns; settle `unknown`), F-03 (close can skip cleanup), F-05 (PID-only ownership proof), F-06 (drafts), F-07 (hydrate and history), F-13 (tool-fact consumer: no tests, per-frame `factId`, Codex `nativeMessageId`, fatal on failure).
- P3: F-09 (Finish/Discard UX gaps; the cleanup-of-active-work concern is refuted by orch's guards), F-10 (documentation), F-11 (`excludeTurns`).
- Clean coverage: the S3d storage module and its 28 tests match the contract.

**Reuse.** Internal first (I-1..I-6): orch `procs.mjs` `verifyIdentity`/`readProcessTable` for ownership proof; `session-turns`/`session-turn-outcomes` `unknown` settlement and the unwired `session-stops` for close and failure; `session-records` draft-conflict APIs and `listConversations` for drafts and history; orch dashboard, run-detail, gate, scope and cleanup dry-run for reconcile and evidence display; `worktreeRecordForDir` plus the association store for admission. External: reference-only for the Codex schema, vibe-kanban reconcile, and crystal's resume rule; avoid Grok's persistence, trust and keyring code; the Apache-2.0 attribution decision (U-4) concerns only files CHO already retains.

## 10. Controller verification and supplemental findings

Author: Codex controller, 2026-11-05. This section is separate from Sonnet's findings above. Sonnet's unmodified final report is preserved in `.reviews/cursor-review-20261105/sonnet-final-report.md` and in its isolated audit worktree. Both audit runs observed `claude-sonnet-5-5`, with no model mismatch, at requested high effort. Their scope checks passed with only the report changed; this is report acceptance, not product acceptance or a converged implementation gate. Cursor's authoring model remains unknown.

### Reproduced on the exact candidate

Three synthetic probes ran against `76076fb3cd6c82f3ca7d74220d226e34955521c4`, without launching provider conversations or using real application data:

1. **F-02 confirmed:** create a busy Codex UI session with `beginNativeTurn`, then pass a durable `message_delta` and durable `turn_complete` for its active turn through `applyNativeUiEvent`. The assistant text remains empty, `busy` remains true, and no outcome is applied. This demonstrates that the current reducer cannot recover this missing live response from durable events. It does not reproduce an actual dropped IPC transport response. Evidence: `.reviews/cursor-review-20261105/controller-reproductions.json`.
2. **F-03 confirmed:** a fake Claude actor activates a turn, and an injected persistence facade throws from `settleTurn` during service close. Close fails with `durable claude close settle failed: injected storage write failure`; the persistence facade is closed but the actor's `close()` is never called. This establishes the cleanup-order defect independently of any particular SQLite failure. Same evidence file.
3. **C-01 [P2] Unicode corruption while hydrating a body across a byte-chunk boundary:** `apps/desktop/server/native-session-persistence.mjs:316` (`readBodyText`) decodes each 16,384-byte chunk separately with `Buffer.toString('utf8')` and concatenates strings. A multibyte character split between chunks is decoded as replacement characters. Using the real SQLite/delta/outcome/hydrate APIs, persisting `'a'.repeat(16383) + '€ tail'` returned a transcript ending in `a��� tail` instead of `aaa€ tail`; expected character length 16,389 became 16,391. Stored body bytes remain intact. The same helper is used by hydrate and durable poll expansion. This violates the message-delta contract's Unicode preservation requirement and SESSION-02. Fix by collecting byte buffers and decoding once, or using a streaming UTF-8 decoder. Add a focused boundary regression case. Evidence: `.reviews/cursor-review-20261105/controller-unicode-reproduction.json`. The first sandbox attempt was blocked by a temporary-file rename EPERM; the successful reproduction ran outside the sandbox with isolated SQLite and liveness files.

Controller checks on the original checkout also passed: **763 package tests** (44 shared + 719 desktop), `npm run typecheck`, and `npm run build`. Sonnet independently reports the same package checks plus 61 focused coordinator tests. The native audit stopped at the missing staged `.runtime` resource; it does not establish native build, installer, or real resume qualification.

### Adjudication note on F-13

The contract-backed stable `factId` and Codex/Claude identifier distinctions warrant correction and consumer tests. The proposed choice to degrade on tool-fact persistence failure needs explicit design adjudication: RUN-04 requires persistence before acknowledging durable progress. Do not silently suppress storage errors or claim durable delivery merely because live display can continue. A valid policy must preserve the durability claim, expose uncertainty, and guarantee native cleanup; F-03/F-08 already show why the current failure path needs work.

### Additional source-backed UI reuse opportunity

For the still-open ORCH-06 / CHO-06 read-only changed-file and diff surface, consider **adapting Vibe Kanban's diff component boundary**, after the recovery blockers:

- Source pinned at `08064e043c2d78ad123b473257ed867e7ce74768`: [`DiffInput`, `useDiffData`, and `DiffViewCard`](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/packages/ui/src/components/PierreConversationDiff.tsx), [`ChatAggregatedDiffEntries`](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/packages/ui/src/components/ChatAggregatedDiffEntries.tsx), and [`useDiffViewStore`](https://github.com/BloopAI/vibe-kanban/blob/08064e043c2d78ad123b473257ed867e7ce74768/packages/web-core/src/shared/stores/useDiffViewStore.ts).
- Inspected code accepts either old/new file contents or a unified patch, exposes unified/split views and whitespace/wrap preferences, and aggregates edits by file. Its UI package pins `@pierre/diffs` to `1.1.4`; this is observed repository configuration, not a recommendation to install that version unexamined.
- CHO target: an on-demand changes drawer associated with a recorded run/worktree, reached from `OrchAgentsPanel`, with repository/worktree path shown. Use CHO/orch for resource identity and host-validated diff reads. Display remains separate from acceptance, integration, and file mutation.
- Verdict: **adapt the component interface and rendering approach**, not the coordinator or all its styling/state framework. Rough effort M, split into host diff reads and UI integration; depends on truthful association/resource identity. Source is Apache-2.0; preserve applicable license/copyright/notices for copied material. The rendering dependency's own license, CSP/worker behavior, accessibility and large-diff performance need checking at dependency selection. No dependency was installed or executed for this audit.

No application-source changes, commits, merges, or pushes were made by the controller or reviewer. The review report is the only addition to the original tracked-source area.
