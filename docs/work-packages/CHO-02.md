# CHO-02 - Next executable package

Prepared: 2026-10-30. Product authority: [PRODUCT_SPEC](../PRODUCT_SPEC.md), ARCH-01-04/07/08, RUN-01-03/07, SEC-01/02/07. Sequence authority: [implementation plan](../IMPLEMENTATION_PLAN.md).

This package follows the first foundation batch. It is a scoped implementation handoff, not evidence that a native host already works. Muse and the two approved local Aider routes remain the implementation pool; Codex reviews actual diffs and runs verification.

## Entry facts and prerequisite

- Current Rust shell registers only `discover_harnesses` and `orch_dashboard`. It starts global `node` for each request using a source-relative import. It cannot own continuing CLI sessions or stream the complete UI protocol.
- `src/lib/api.ts` calls arbitrary Tauri command names and subscribes to `cho:stream`. The browser transport separately POSTs `{command,args}` and uses SSE. Preserve the browser preview while moving both transports onto the same application protocol.
- Development bridge hardening is a limited hostile-web-origin boundary. It does not provide production local-user authentication, persistent IPC, workspace authorization or controller approvals.
- The controller verified existing Visual Studio 2022 C++ tools, Windows SDK and WebView2, then installed official Rustup 1.29.1 with the minimal Rust 1.99.1 MSVC toolchain, preserving PATH. The native source/build fixes are independently reviewed and integrated as `7e3cd37`, including the icon assets, Cargo.lock and generated-schema ignore. The combined branch passes all 53 package tests, typecheck/web build and a locked native debug build. It creates a responding CHO window from an unrelated cwd. Visual capture was not approved before timeout; no rendered-window, installed-artifact or bundled-runtime qualification is claimed.
- Initial packaging direction remains a pinned Node runtime plus packaged JavaScript resources managed by Tauri. Resolve resource paths independently of cwd and source checkout. Validate this direction with an early native smoke before host extraction grows.

## 02-a - Protocol module integrated, no process launch

Implemented as `server/protocol.mjs`, its declarations, and 12 deterministic protocol tests. Integration commit: `a1ffafe`. Version 1 uses request/result/error/event envelopes, canonical compact JSON+LF frames bounded to 1MiB UTF-8 and 64 container levels, with explicit correlation/generation errors. All 53 package tests, typecheck/build passed for the reviewed candidate. No existing transport is switched. The following original scope records the contract; it is not another unstarted assignment.

Worker: Muse, bounded M. Baseline: exact accepted foundation integration commit, clean worktree.

Proposed allowed files (finalize exact paths in the launch packet):

- `apps/desktop/server/protocol.mjs`
- `apps/desktop/server/protocol.d.mts`
- `apps/desktop/src/host-protocol.test.ts`

Read anchors: `server/bridge.mjs` public router and current stream payloads; `src/lib/api.ts`; `src-tauri/src/lib.rs`; relevant spec requirements. No provider calls, native CLI launch, storage migration, frontend rewrite or Rust integration in this slice.

Deliver one versioned application protocol with request/result/error/event envelopes, request correlation, host-generation identity, bounded messages and explicit compatibility handling. Distinguish request acknowledgement, ongoing activity and terminal completion. An unknown version, duplicate/unknown request, malformed frame, interrupted connection or host restart must never imply successful execution or automatically replay a command. Treat event cursors as optional until durable storage exists; do not fabricate native session IDs, verified models, process identities or durable delivery.

Acceptance:

1. Shared production validators/constructors and declarations agree on envelopes and bounds. Keep the module transport-neutral and dependency-free.
2. Deterministic positive and negative fixtures cover version mismatch, missing/invalid correlation and generation, malformed/truncated/oversized messages, terminal/error discrimination and unexpected event types. Tests run without providers, real user state or native executables.
3. Existing callers continue to work because this slice does not switch transports yet. Root typecheck/test/build pass independently.
4. Controller reviews actual changed consumers and protocol semantics; independent review is against the precise committed candidate. Any proposed broader refactor returns to the controller before implementation.

## Next: bundled-runtime smoke before host extraction

Compiler/native-window readiness is established; the packaged Node smoke remains open. Pin the official Node 24 distribution and verify its checksum/license, prepare ignored build resources, then add a bounded native resource resolver/startup smoke. Split resource preparation, Rust resolver and bootstrap/tests into exact-file handoffs. Prove the bundled runtime and JavaScript load from an arbitrary cwd with global Node unavailable; record handshake/failure and process-exit outcomes before growing the persistent-host extraction. The current executable still uses the old per-request global Node route and does not pass this acceptance.

## 02-b1 - One owned host process using fake boundaries

Worker: Muse, bounded M slices. Start after 02-a review and the native packaging readiness check. Finalize one small host entry/lifecycle module and its tests per handoff; do not assign the monolithic bridge and all consumers together.

Extract a transport-neutral dispatcher around the existing command implementation. Own startup/handshake, request correlation, single terminal responses, host generation, shutdown, restart and disconnected/unknown outcomes. Separate protocol stdout from diagnostics. Validate commands and workspace scope at the host boundary before any provider execution. Test with fake host/process boundaries first: no real subscriptions or worker orchestration required to prove the generic lifecycle.

Following slices separately own Rust process lifecycle/resource resolution, command routing/event forwarding, frontend transport adaptation and an early installed-shell smoke. The Rust owner must terminate its host tree on normal exit and surface startup/handshake failure. Do not keep the current per-request global Node launcher as an unreported fallback.

## Next capability spike before session schema freeze

CHO-04 must inspect the actual Claude Code and Codex native continuing-session, streaming-tools, approval/clarification and cancellation behavior in owned fixtures. Record versions and observed limits. Help output alone is not qualification. Do this before freezing native-reference persistence in CHO-03; do not require every optional harness to pass first.

## Native smoke acceptance

A built artifact starts its bundled runtime with an arbitrary cwd and no source checkout/global Node dependency; handshake and one harmless command work; app exit leaves no host process; startup failure is visible. Record the artifact hash and environment. Keep native smoke, browser tests, hosted CI and public release readiness as separate evidence.
