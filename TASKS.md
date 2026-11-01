# Desktop follow-ups

The accepted delivery sequence is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). These items supplement its work packages.

- [ ] **CHO-04 / before CHO-03 schema freeze:** Codex is integrated and rendered-verified. The separate Claude candidate passes six real bundled-runtime conversation/tool/denial/Stop cases, 291 package tests, native build and 12 Rust tests; finish its rendered acceptance and integration, then qualify live clarification. Keep storage contracts provisional. See [capability results](docs/work-packages/CHO-04.md).
- [ ] **CHO-06:** render unfinished Markdown code fences cleanly when a streamed turn is interrupted; the current preview preserves that partial text literally.
- [ ] **CHO-04 / CHO-06:** finish rendered acceptance for native Browse selection/cancellation and the Claude conversation. Folder browsing is implemented in candidate `c47437a`; build/regression checks pass, while Windows launch automation is currently denied.
- [ ] **CHO-07 / CHO-08:** qualify restrictive Tauri CSP, provenance/public examples, native CI, release installer/upgrade and clean-machine acceptance. The inherited `csp: null` setting is unchanged by the native-host work.
- [ ] **CHO-07:** qualify the development test-tool upgrade for the recorded Vitest/mocker/tinypool advisories; production-only audit is currently clear.
- [ ] **Maintenance:** remove the unused `mut` in the Rust wire split-stream test (`host_wire.rs`); it is a compiler warning, not a runtime failure.
- [ ] **Maintenance:** remove redundant parentheses in the native command object check (`src-tauri/src/lib.rs`) and stage an explicit module-type boundary for the shared TypeScript normalizer to suppress Node's typeless-package warning. Both current native build and actual staged runtime checks pass.
- [ ] **Future platform support:** report unsupported platforms before checking Windows runtime resource paths; initial native qualification remains Windows x64.

- [ ] **CHO-07:** promote sanitized native lifecycle smoke and fake-host regression checks into Windows CI; qualify installer path lengths and concurrent preparation behavior before claiming those environments. Current lifecycle probes and receipts are retained privately.

- [ ] **Coordinator maintenance:** reconcile finish handling for a lane-busy admission that never started a worker but lacks spawned keeper identity. The runtime batch has all dispositions and completed reviews; its orch claim remains held until supported liveness reconciliation permits closure. Preserve original receipts.

Current evidence covers real continuing Codex and Claude debug-runtime conversations with tool permissions, cancellation and owned cleanup. The Codex window is rendered-verified; the Claude candidate's window check is pending. Broader UI polish, installed release and clean-machine acceptance remain open.
