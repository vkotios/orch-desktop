# Desktop follow-ups

The accepted delivery sequence is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). These items supplement its work packages.

- [ ] **CHO-04 / before CHO-03 schema freeze:** Codex native conversation, bounded pipe and product permissions are implemented; runtime fixtures and rendered text/continuation/Stop checks pass. Qualify Claude and live clarification. Keep storage contracts provisional. See [capability results](docs/work-packages/CHO-04.md).
- [ ] **CHO-06:** render unfinished Markdown code fences cleanly when a streamed turn is interrupted; the current preview preserves that partial text literally.
- [ ] **CHO-07 / CHO-08:** qualify restrictive Tauri CSP, provenance/public examples, native CI, release installer/upgrade and clean-machine acceptance. The inherited `csp: null` setting is unchanged by the native-host work.
- [ ] **CHO-07:** qualify the development test-tool upgrade for the recorded Vitest/mocker/tinypool advisories; production-only audit is currently clear.
- [ ] **Maintenance:** remove the unused `mut` in the Rust wire split-stream test (`host_wire.rs`); it is a compiler warning, not a runtime failure.
- [ ] **Maintenance:** remove redundant parentheses in the native command object check (`src-tauri/src/lib.rs`) and stage an explicit module-type boundary for the shared TypeScript normalizer to suppress Node's typeless-package warning. Both current native build and actual staged runtime checks pass.
- [ ] **Future platform support:** report unsupported platforms before checking Windows runtime resource paths; initial native qualification remains Windows x64.

- [ ] **CHO-07:** promote sanitized native lifecycle smoke and fake-host regression checks into Windows CI; qualify installer path lengths and concurrent preparation behavior before claiming those environments. Current lifecycle probes and receipts are retained privately.

- [ ] **Coordinator maintenance:** reconcile finish handling for a lane-busy admission that never started a worker but lacks spawned keeper identity. The runtime batch has all dispositions and completed reviews; its orch claim remains held until supported liveness reconciliation permits closure. Preserve original receipts.

Current native evidence covers debug artifacts, owned process cleanup, real continuing Codex conversations with tool permissions and cancellation, and the built window's rendered text/continuation/Stop flow. Broader UI polish, installed release and clean-machine acceptance remain open.
