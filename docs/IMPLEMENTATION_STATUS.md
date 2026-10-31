# CHO Desktop implementation status

Updated: 2026-10-31. Integration branch: `codex/cho-v01-foundation`; native conversation candidate remains isolated pending final acceptance.

Product contract: [specification](PRODUCT_SPEC.md). Sequence: [plan](IMPLEMENTATION_PLAN.md). Sonnet findings: [validated dispositions](reviews/FINDINGS_DISPOSITION.md). Current package: [CHO-02 protocol and host](work-packages/CHO-02.md). Current spike: [CHO-04 controller capabilities](work-packages/CHO-04.md); Codex fixture checks pass, Claude remains open.

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

## First native Codex conversation candidate

Source checkpoint `d6814d3` implements explicit canonical project trust, live model choices from the installed Codex CLI, streamed continuing chats, tool status, once-only offered approvals and cancellation. The native view uses the approved graphite appearance; browser prototype workflows remain available separately. Chats and trust are deliberately in memory. Native session identity is retained without transcript replay, stale callbacks/decisions are rejected, and a missing event consumer stops the producer after a 30-second lease. Queued approval responses remain withdrawable until actually written. Rust process ownership also handles idle host failure without waiting for another UI call.

Controller verification: 224 package tests (23 shared, 201 desktop), type checking, web build, 12 locked Rust tests and locked Windows debug build pass. A copied artifact starts outside the checkout without global Node, with poisoned Node options removed, then exits with the owned host gone. The executable and all 90 packaged files are hashed. The corrected copied artifact's runtime checks pass a reviewed read accepted once, successful tool completion, a cancelled write with no file created, interruption and same-thread continuation retaining the fixture marker. Requested gpt-6-sol/low is recorded separately from unknown independently served identity.

The built onboarding and project trust prompt are visually inspected. The full rendered conversation flow is still pending the manual trust step. Independent final review and this UI evidence remain acceptance gates for main-branch integration. This work combines Muse implementations with the owner's authorised GPT-6.1 Terra high API subagents after Muse's weekly quota was exhausted; those API tasks are recorded separately from actual orch CLI runs. Both larger local Aider trials produced no edits after using their reasoning output budgets; their results do not qualify larger implementation workloads.

## Remaining work and holds

- The bundled-host and native Codex runtime fixtures pass. Complete the rendered conversation check and independent final review on the isolated candidate before integration. Installed-artifact acceptance remains open; mutating coordinator commands are not admitted.
- Next: qualify Claude's native session/tool/approval/cancellation behavior and live clarification. Keep CHO-03 native-reference storage provisional and complete M1 distribution evidence.
- Full npm audit identifies 3 vulnerable development-tool packages around Vitest/mocker/tinypool (one moderate, two critical). The production-only audit reports 0. Qualify the major test-tool upgrade before publication; do not force-update the dependency graph blindly.
- Source publication still needs provenance/license and public-example cleanup, release/privacy/security documentation and content checks. The remote still points to the coordinator repository. No push, remote change or publication occurred.
- Unified launcher is intentionally loopback-only. Direct Vite retains the explicit environment override, while LAN product access remains outside v0.1. Verify native dev URL resolution with the Rust/WebView smoke.
- Add a dedicated mid-body disconnect/error fixture with shared transport lifecycle tests. Existing AGY login hints, native transport completeness, direct-chat resume/approval and durable-event semantics remain mapped to CHO-02 through CHO-05.
- Muse file edits succeeded, but its Windows worker shell was unavailable; controller-executed checks are the evidence. Aider native served-model attribution stays unknown; separate gateway receipts corroborate engine/selector/time. Neither a tiny successful task nor catalogue presence qualifies a whole workload.
- IGM is one shared engine/model across all clients. Local jobs and engine changes are serial; the final runtime reviews use Lucebox DeepSeek after Qwen was confirmed unloaded. Context and output budgets are explicit; declared gateway capacity is distinguished from measured per-slot capacity.

The foundation batch is closed. CHO-02 advances through reviewed slices; the bundled read-only host foundation is complete, while full native conversations and product release criteria remain open. Private coordinator evidence retains run/review records, launch failures, the controller-caused review-snapshot incident, gateway receipts and worktree retention decisions. The failed earlier Sonnet-auth run remains a separate coordinator bookkeeping follow-up. All runtime-batch runs have one recorded disposition and all detached reviews are finalized with clean containment. Runtime batch closeout remains blocked by a lane-busy admission missing spawned keeper identity; the claim and original receipts are preserved pending supported reconciliation. This is a coordinator closeout hold, not an unverified native-host source change.

CHO-04 remains in progress and its claim stays held for the continuing controller work. All runs in this slice have recorded dispositions; detached reviews are finalized with clean containment. Original worker worktrees and private native receipts are preserved.
