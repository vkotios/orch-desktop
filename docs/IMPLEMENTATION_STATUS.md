# CHO Desktop implementation status

Updated: 2026-10-30. Integration branch: `codex/cho-v01-foundation`.

Product contract: [specification](PRODUCT_SPEC.md). Sequence: [plan](IMPLEMENTATION_PLAN.md). Sonnet findings: [validated dispositions](reviews/FINDINGS_DISPOSITION.md). Next executable package: [CHO-02 protocol and host](work-packages/CHO-02.md).

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
- No current frontend/native transport was switched to the protocol yet. Bundled runtime preparation, Tauri resource resolution, owned persistent host and installer/real-conversation qualification remain open.

Combined application verification on `7e3cd37`: all 53 package tests, type checking, web build and locked Windows native debug build pass. Qwen completed seven independent review passes with no in-scope defect; its stale-doc follow-up was already resolved. Native window metadata and exact artifact hash are retained privately; pixel rendering remains unverified.

Gateway retry: the unload succeeded on retry, with no model/native process left before Qwen loaded. Two small API prompts passed with at least 5.5 seconds between requests. That is a limited liveness check, not proof that request cadence caused the earlier timeout. Keep gateway calls controlled by this controller at least five seconds apart.

## Remaining work and holds

- Compiler/native-executable readiness passes on the integrated branch. The bundled-runtime/installed-app smoke remains a prerequisite before host extraction grows; the current Rust router still launches global Node per request. Visual capture is unverified.
- Next: pin and prepare the runtime resources, prove native resource resolution/handshake/exit, then build one persistent host. Continuing Claude/Codex transport/approval/cancellation spikes precede native-reference storage schema freeze.
- Full npm audit identifies 3 vulnerable development-tool packages around Vitest/mocker/tinypool (one moderate, two critical). The production-only audit reports 0. Qualify the major test-tool upgrade before publication; do not force-update the dependency graph blindly.
- Source publication still needs provenance/license and public-example cleanup, release/privacy/security documentation and content checks. The remote still points to the coordinator repository. No push, remote change or publication occurred.
- Unified launcher is intentionally loopback-only. Direct Vite retains the explicit environment override, while LAN product access remains outside v0.1. Verify native dev URL resolution with the Rust/WebView smoke.
- Add a dedicated mid-body disconnect/error fixture with shared transport lifecycle tests. Existing AGY login hints, native transport completeness, direct-chat resume/approval and durable-event semantics remain mapped to CHO-02 through CHO-05.
- Muse file edits succeeded, but its Windows worker shell was unavailable; controller-executed checks are the evidence. Aider native served-model attribution stays unknown; separate gateway receipts corroborate engine/selector/time. Neither a tiny successful task nor catalogue presence qualifies a whole workload.
- IGM is one shared engine/model across all clients. Local jobs and engine changes are serial; the latest completed review/probes leave Kyojin Qwen loaded. dspark was confirmed unloaded before Qwen was started.

The foundation batch is closed. CHO-02 advances through reviewed slices; its full native-host milestone and product release criteria remain open. Private coordinator evidence retains run/review records, launch failures, the controller-caused review-snapshot incident, gateway receipts and worktree retention decisions. The failed earlier Sonnet-auth run remains a separate coordinator bookkeeping follow-up.
