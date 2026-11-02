# CHO Desktop implementation status

Updated: 2026-11-02. Integration branch: `codex/cho-v01-foundation`. Native Codex/Claude conversations and the clarification source milestone are accepted locally; source checkpoint `926110a` is verified by controller checks and independent GLM review.

Product contract: [specification](PRODUCT_SPEC.md). Sequence: [plan](IMPLEMENTATION_PLAN.md). Sonnet findings: [validated dispositions](reviews/FINDINGS_DISPOSITION.md). Current package: [CHO-03 durable sessions](work-packages/CHO-03.md). Native Codex and Claude runtime and focused rendered conversation checks pass; broader [CHO-04 qualification](work-packages/CHO-04.md) remains open.

## Durable storage foundation

The accepted v1 storage contract and standalone S1 core are implemented in
`f0b4f72`. File admission rejects incompatible databases before persistent
changes; schema/identity initialization is atomic; scoped synchronous
transactions expire their query helpers and reject async callbacks. The core
verifies WAL, FULL synchronous writes, foreign keys and a 100ms busy policy.

All 408 package tests (including 20 new SQLite tests), type checking and web
build pass. Independent GLM 5.3 high/Vibe and controller review have no remaining
High or Medium findings. Separate bundled-runtime fixtures verify process
restart, abrupt-exit rollback, WAL recovery, schema preservation and pager-FULL
rollback. Initial sandbox permission failures were rerun successfully with
normal Windows permissions. No new native artifact or rendered durability
claim is made: application chats, drafts and events still use memory. Next is
S2 record APIs, followed by host coupling, UI history/drafts and explicit recovery.

## Project/chat records and draft persistence

S2a source `247f43d` adds project/chat metadata APIs and draft CAS saves with
immutable conflicts and idempotent receipts. All 428 package tests, type checking
and web build pass; installed and bundled Node process fixtures establish record
persistence and atomic receipt rollback. Controller and GLM review have no
remaining High or Medium issue after direct validation of findings. See the
[API contract](contracts/SESSION_RECORDS.md) and [CHO-03](work-packages/CHO-03.md).
Application chats still use memory until the host/UI consumers are connected.
Next: native record binding and producer ownership, then durable event coupling.

## First foundation batch integrated

The prototype checkpoint (`d477cf6`) preserved the desktop and its required coordinator/Grok dependencies together. Review-driven spec/plan corrections were committed in `f9a5549`. The five worker slices below are now integrated locally.

| Slice | Implementer | Integrated result | Commit |
| --- | --- | --- | --- |
| discovery | Muse | Removes synchronous live model-catalog launch from passive discovery; configured/static choices retained. Tests use controlled module boundaries instead of native CLIs, real home/auth/state, or checkout-name assumptions. | `35ca384` |
| dev-loopback | Aider / Kyojin Qwen3.8 Flash Next | Unified development launcher uses IPv4 loopback for Vite. | `1117f76` |
| vite-loopback | Aider / Lucebox DeepSeek V4 dspark | Direct Vite defaults to loopback; explicit `TAURI_DEV_HOST` and its HMR configuration are preserved. | `9affb63` |
| desktop-ci | Muse | Independent unconditional push/PR/manual workflow checks root install, typecheck, tests and web build on Windows and Ubuntu using Node 24. | `bfcbe23` |
| host-boundary | Muse | Standalone development bridge binds loopback; checks Host/Origin/fetch metadata before RPC/SSE; rejects non-JSON, malformed and oversized requests. Includes 26 positive/negative tests. | `d8469cc` |

The controller reviewed every actual diff and independently ran verification. Detached distinct-model reviews were also completed. The development boundary had a separately recorded GPT-family controller review before the detached DeepSeek findings were read, providing two reviewer families independent of the Muse implementation. Findings were confirmed/refuted/filed against source, rather than accepted from reviewer labels. The larger boundary/test patch stayed within its three named files.

## Verified on combined application candidate d8469cc

- `npm test`: 41 passed (5 shared-package tests, 36 desktop tests including 26 boundary tests).
- `npm run typecheck` and `npm run build`: passed.
- `npm run test:orch`: 61 passed (focused coordinator unit/Claude/Grok adapter checks).
- Standalone bridge smoke: actual IPv4 loopback listener, hostile-origin 403 before dispatch, valid local JSON reaches the default router, child exits cleanly. No provider call or trust mutation.
- Actual Vite configuration resolution: loopback default and explicit-host/HMR behavior both passed.
- Workflow YAML structure/trigger/matrix/required-step checks passed. Hosted GitHub Actions and Linux execution are not yet verified.

The original 12-test prototype result remains historical evidence. The isolated discovery correction and new boundary suite account for the current 41 package tests; no test timeout was increased.

## CHO-02 protocol and native build readiness

- Protocol integrated in `a1ffafe`: version 1 request/result/error/event frames, explicit generation/correlation checks, 1MiB UTF-8 canonical frame bound and 64-level JSON nesting limit. Twelve deterministic protocol tests cover positive and negative boundaries; the controller independently found and returned the original size/recursion defects before acceptance.
- Native prerequisites: existing Visual Studio 2022 C++ tools, Windows SDK and WebView2 verified. Official Rustup 1.29.1 installed the minimal Rust 1.99.1 MSVC/Cargo 1.99.1 toolchain; PATH was preserved.
- Native source/build artifacts: original graphite icon source with generated RGBA PNG/multisize ICO; Cargo.lock pins 410 packages including 409 checksummed crates.io dependencies; generated Tauri schemas are narrowly ignored. Native build-readiness changes are independently reviewed and integrated in `7e3cd37`.
- On combined commit `7e3cd37`, `tauri build --debug --no-bundle --ci -- --locked` succeeds and produces a Windows executable. It creates a responding CHO window from an unrelated cwd. Computer Use window capture timed out waiting for app approval, so rendering remains unverified.
- Private Node+JavaScript layout precheck succeeds with global Node absent from PATH and an unrelated cwd. The staged installed runtime is v24.11.1; this is a portability precheck, not a qualified redistribution version or packaged-host acceptance.
- At that checkpoint no transport used the new protocol. The bundled-runtime and owned-host work below supersedes that state; installer and real-conversation qualification remain open.

Combined application verification on `7e3cd37`: all 53 package tests, type checking, web build and locked Windows native debug build pass. Qwen completed seven independent review passes with no in-scope defect; its stale-doc follow-up was already resolved. Native window metadata and exact artifact hash are retained privately; pixel rendering remains unverified.

Gateway retry: the unload succeeded on retry, with no model/native process left before Qwen loaded. Two small API prompts passed with at least 5.5 seconds between requests. That is a limited liveness check, not proof that request cadence caused the earlier timeout. Keep gateway calls controlled by this controller at least five seconds apart.

## CHO-02 bundled native host foundation

Integrated source: `cc065f4`. Windows x64 debug artifact verified; this is an early native-host milestone, not the M1 installed conversation.

- The native shell owns one long-lived bundled Node 24.22.2 process, with fixed Tauri resource paths, versioned ready/ping handshake, exact generation/request correlation, bounded pipe frames and a serial native client. The per-request global Node launcher is removed.
- Runtime preparation verifies pinned official Node and license SHA-256 values, stages a narrow public-source list and replaces complete resources with explicit backup-recovery reporting. Generated binaries, private profiles and runtime state stay outside Git.
- Windows Job Object ownership cleans up the host and its descendants. Cancellation during a request poisons the connection without replay; queue admission shares the request deadline. Queued cancellation/expiry is reported as not sent. Cleanup errors are returned without false success.
- This native phase admits health checks, harness discovery and dashboard reads. Controller conversations, native event forwarding and mutating coordinator commands still need the planned adapter, permissions and storage work.

Combined verification: 90 package tests, type checking, web build, 11 locked Rust tests and a locked Windows native debug build pass. Shared fixtures check JavaScript/Rust UTF-16 ID/error-code limits and protocol compatibility. Owned fake-host probes cover cancellation after send and mid-frame, queue deadlines, cancellation before dispatch, normal shutdown, drop and descendant cleanup. A real packaged dashboard read through the Rust client succeeds.

The exact debug artifact starts from an unrelated cwd with global Node absent and injected Node options removed. Normal exit, missing runtime, invalid ready PID, startup timeout and app crash checks all leave the owned host gone. Installer/upgrade, rendered-window and clean-machine release evidence remain open; OS-level termination/wait failures were checked in source, not injected into the kernel.

Independent reviews and controller verification resolved the in-flight cancellation, admission deadline, cleanup reporting, host-queue and cross-language validation findings. Non-blocking maintenance and release-hardening items are tracked in [TASKS.md](../TASKS.md).

## CHO-04 first controller capability slice

Integrated source: `d59a451`. Muse is back in the implementation pool after current subscription access and its native model identity were confirmed. The controller ran all checks; Muse worker shell execution remains unqualified.

The installed Codex CLI 0.156.1 app-server passed owned native fixtures for streamed text, same-thread continuation, resume in a new process without transcript replay, a permitted fixture-file read, rejected writes, interruption and continuation afterward. The fixture conversation was archived and all owned server processes exited. Requested/native-selected model was gpt-6-sol; independently served identity remains unknown. Details and limits are in [CHO-04](work-packages/CHO-04.md).

The shared package now has a separate app-server event mapper with native thread/turn correlation, tool lifecycle including declined results, and distinct completed/failed/interrupted outcomes. It retains the existing exec normalizer. All 108 package tests (23 shared, 85 desktop), type checking and web build pass. Replaying captured native notifications through the candidate preserves 60 text deltas, two declined command results and two interrupted turns. The whole mapper and tests passed independent different-family review after controller-confirmed fixes.

That checkpoint was a pure event adapter and native protocol spike. The following native candidate now uses the mapper through the bundled host.

## First native Codex conversation

Source checkpoint `d6814d3` implements explicit canonical project trust, live model choices from the installed Codex CLI, streamed continuing chats, tool status, once-only offered approvals and cancellation. The native view uses the approved graphite appearance; browser prototype workflows remain available separately. Chats and trust are deliberately in memory. Native session identity is retained without transcript replay, stale callbacks/decisions are rejected, and a missing event consumer stops the producer after a 30-second lease. Queued approval responses remain withdrawable until actually written. Rust process ownership also handles idle host failure without waiting for another UI call.

Controller verification: 224 package tests (23 shared, 201 desktop), type checking, web build, 12 locked Rust tests and locked Windows debug build pass. A copied artifact starts outside the checkout without global Node, with poisoned Node options removed, then exits with the owned host gone. The executable and all 90 packaged files are hashed. The corrected copied artifact's runtime checks pass a reviewed read accepted once, successful tool completion, a cancelled write with no file created, interruption and same-thread continuation retaining the fixture marker. Requested gpt-6-sol/low is recorded separately from unknown independently served identity.

The built native window passes the rendered conversation check after the owner manually trusted the synthetic project: the first two turns completed with the same marker, a longer Markdown response visibly streamed, Stop showed the pending state then an actual interrupted outcome, and a subsequent turn completed with the original marker. Model settings stayed locked after the first send, and project close was disabled during the active turn. UI requested gpt-6-sol at medium effort; served identity remains unknown. A request for 20,000 output lines completed with a provider length-limit explanation; a bounded explanation supplied the actual streaming interruption check. The earlier Windows input access failure is resolved and is not an outstanding product defect.

Independent source reviews from Qwen and DeepSeek and controller verification are complete; the controller refuted incorrect findings against code and direct probes, and fixed a separately reproduced approval race. This work combines Muse implementations with the owner's authorised GPT-6.1 Terra high API subagents after Muse's weekly quota was exhausted; those API tasks are recorded separately from actual orch CLI runs. Both larger local Aider trials produced no edits after using their reasoning output budgets; their results do not qualify larger implementation workloads.

## Remaining work and holds

- The first native Codex debug conversation passes runtime fixtures, independent source reviews and the built window's rendered text, continuation and Stop checks. Installed-artifact acceptance remains open; mutating coordinator commands are not admitted.
- Claude runtime checkpoint `d07df86` passes six actual conversation/tool/denial/Stop cases through its copied bundle outside the checkout. Source `c47437a` adds a native Browse button and passes 291 package tests, type/web/native builds, 12 Rust tests and copied-bundle startup/cleanup; its bundled Node/runtime modules are unchanged. Rendered Browse selection and cancellation pass. After the owner manually trusted Claude's fixture project, first and continuing turns completed with the same marker, formatted text visibly streamed, Stop produced an actual interrupted outcome, and the next turn completed with the original marker. Native-selected Sonnet 5/medium and the owner's Editing access were retained; served identity is not independently verified. The debug milestone is accepted for local integration.
- Native clarification is implemented; see the milestone below for exact runtime/rendered evidence and the final Codex quota limitation. Next: settle CHO-03 native-reference storage, add durable chats/drafts/recovery without replay, and complete M1 distribution evidence.
- Full npm audit identifies 3 vulnerable development-tool packages around Vitest/mocker/tinypool (one moderate, two critical). The production-only audit reports 0. Qualify the major test-tool upgrade before publication; do not force-update the dependency graph blindly.
- Source publication still needs provenance/license and public-example cleanup, release/privacy/security documentation and content checks. The remote still points to the coordinator repository. No push, remote change or publication occurred.
- Unified launcher is intentionally loopback-only. Direct Vite retains the explicit environment override, while LAN product access remains outside v0.1. Verify native dev URL resolution with the Rust/WebView smoke.
- Add a dedicated mid-body disconnect/error fixture with shared transport lifecycle tests. Existing AGY login hints, native transport completeness, direct-chat resume/approval and durable-event semantics remain mapped to CHO-02 through CHO-05.
- Muse file edits succeeded, but its Windows worker shell was unavailable; controller-executed checks are the evidence. Aider native served-model attribution stays unknown; separate gateway receipts corroborate engine/selector/time. Neither a tiny successful task nor catalogue presence qualifies a whole workload.
- IGM is one shared engine/model across all clients. Local jobs and engine changes remain serial. The owner replaced the standing independent reviewer with GLM 5.3 high through Vibe; prior DeepSeek overflow attempts remain inconclusive records. Source packet hashes and review containment are retained privately.

The foundation batch and focused native Codex/Claude debug conversation milestones are complete. Broader controller qualification and product release criteria remain open. Private coordinator evidence retains run/review records, launch failures, the controller-caused review-snapshot incident, gateway receipts and worktree retention decisions. The failed earlier Sonnet-auth run remains a separate coordinator bookkeeping follow-up. All runtime-batch runs have one recorded disposition and all detached reviews are finalized with clean containment. Runtime batch closeout remains blocked by a lane-busy admission missing spawned keeper identity; the claim and original receipts are preserved pending supported reconciliation. This is a coordinator closeout hold, not an unverified native-host source change.

CHO-04 remains in progress and its claim stays held for the continuing controller work. All runs in this slice have recorded dispositions; detached reviews are finalized with clean containment. Original worker worktrees and private native receipts are preserved.

## Native clarification milestone

Source checkpoint: `926110a`, extending the accepted Codex/Claude debug conversations. Native questions now appear as explicit single-choice, multiple-choice or custom-text cards. Nothing is selected or sent automatically. Answers remain separate from tool permissions and bind the current project, process generation, chat, turn and native question. Invalid or proven unsent answers remain editable; an unknown submission requires Stop before retrying.

Codex default async questions use the native expected-turn steer mechanism. Its experimental blocking request uses a typed request-ID response; the application does not force Plan mode. Claude AskUserQuestion correlates the original assistant tool and native control request, treating only an omitted optional multiSelect as equivalent to false for comparison. The original control input is preserved in the answer. Explicit empty option descriptions are supported where allowed by the native schema; missing, mistyped or overlong descriptions still reject.

The serial host returns answer queue admission promptly and reports actual submission separately through polling, keeping Stop responsive under native backpressure. Terminal, withdrawal and Stop retire queued, unwritten replies; a written answer is not presented as reversible. Pending native steers hold new-turn admission until they settle, including late ACKs.

Controller verification: **388 package tests** (44 shared, 344 desktop), type checking, web build and locked Windows debug build pass. The unchanged Rust command/lifecycle sources previously passed 12 locked tests. Independent GLM 5.3/Vibe reviews cover the full numbered source and the final parser correction; all findings are adjudicated. The copied 95-file final bundle passes startup and owned-host cleanup outside the checkout without global Node and with poisoned Node settings. Native Claude fixtures cover explicit/invalid answers, Stop and same-chat recovery, including omitted optional defaults and empty descriptions.

The built Codex window passes actual question rendering with no default answer, explicit custom-answer submission, completed response, Stop at a second question, the native interrupted outcome and successful same-chat marker recovery. The owner handled project trust. This rendered check uses `e54317f`; the final correction changes only codec acceptance of empty descriptions, and the UI/state modules are unchanged. Claude clarification is qualified through its actual bundled service and shared-card checks; this does not claim a separately rendered Claude question in the native window.

The final Codex bundled probe successfully displayed a native async question, rejected an invalid answer, and acknowledged the explicit answer before the subscription reported its usage limit. Its failed terminal outcome and clean owned-client shutdown are retained as failure-path evidence; they are not a successful final response. Earlier successful runtime and rendered checks remain separately bound to their source/artifacts. Naming the unavailable blocking request tool in default-mode prompts is not a valid async fixture; the application does not silently change modes to satisfy it.

This completes the bounded clarification source milestone, not CHO-04 or a product release. Chats, answers and project trust remain in memory. Next: CHO-03 durable chats/drafts/native references and restart recovery without execution replay. Retain submitted question/answer history in that design; complete broader UI polish, delegation/admission boundaries and installed-release qualification through their own packages.
