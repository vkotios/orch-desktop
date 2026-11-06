# Desktop follow-ups

The accepted delivery sequence is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). These items supplement its work packages.

- [x] **CHO-04 / clarification capability milestone:** native Codex and Claude question/answer contracts established, including explicit answers, invalid-answer recovery and Stop. Source `926110a` passes 388 package tests, native build and independent GLM review. Built Codex question rendering/answer/Stop/recovery passes; Claude uses actual bundled-service and shared-card evidence. See [capability results](docs/work-packages/CHO-04.md).
- [ ] **CHO-06:** render unfinished Markdown code fences cleanly when a streamed turn is interrupted; the current preview preserves that partial text literally.
- [x] **CHO-04 / CHO-06:** native Browse selection/cancellation and focused rendered Claude conversation acceptance. Owner-assisted selection and manual trust are recorded separately from automated cancellation, first/continuing marker turns, visible formatted streaming, actual interruption and a completed post-Stop marker turn. This verifies the debug preview, not installer or clean-machine behavior.
- [ ] **CHO-07 / CHO-08:** qualify restrictive Tauri CSP, provenance/public examples, native CI, release installer/upgrade and clean-machine acceptance. The inherited `csp: null` setting is unchanged by the native-host work.
- [ ] **CHO-07:** qualify the development test-tool upgrade for the recorded Vitest/mocker/tinypool advisories; production-only audit is currently clear.
- [ ] **Maintenance:** remove the unused `mut` in the Rust wire split-stream test (`host_wire.rs`); it is a compiler warning, not a runtime failure.
- [ ] **Maintenance:** remove redundant parentheses in the native command object check (`src-tauri/src/lib.rs`) and stage an explicit module-type boundary for the shared TypeScript normalizer to suppress Node's typeless-package warning. Both current native build and actual staged runtime checks pass.
- [ ] **Future platform support:** report unsupported platforms before checking Windows runtime resource paths; initial native qualification remains Windows x64.

- [ ] **CHO-07:** promote sanitized native lifecycle smoke and fake-host regression checks into Windows CI; qualify installer path lengths and concurrent preparation behavior before claiming those environments. Current lifecycle probes and receipts are retained privately.

- [ ] **Coordinator maintenance:** reconcile finish handling for a lane-busy admission that never started a worker but lacks spawned keeper identity. The runtime batch has all dispositions and completed reviews; its orch claim remains held until supported liveness reconciliation permits closure. Preserve original receipts.

Current evidence covers real continuing Codex and Claude debug-runtime conversations with tool permissions, clarification, cancellation and owned cleanup. Both windows pass focused rendered conversation checks. Broader UI polish, installed release and clean-machine acceptance remain open.

- [~] **CHO-03:** Audited recovery defects F-12/F-03/F-08/C-01/F-05/F-02/F-13/F-06/F-07 addressed in code with focused tests ([evidence](docs/evidence/CURSOR-COMPLETION-2026-11-06.md)). Still open: approvals/clarifications durability, import/export/migration, full consumer probes, live resume qualification. [Audit + C-01](docs/reviews/CURSOR-DELIVERY-REVIEW-2026-11-05.md).
- [~] **CHO-04/05:** Host `admitOrchArgs`, association intent/uncertain stages, and Finish/Discard UX warnings landed. Still open: full review/diff/integration journey and live delegated change qualification. Integrate remains disabled. [Release gates](docs/RELEASE_v01.md).
- [ ] **CHO-06:** replace the generic Starting indicator while an empty response waits on a clarification; retain explicit waiting/submission/error states and no default answer.
- [ ] **Maintenance:** remove the unused local clarification reset helper when cleaning the API. Generic invoke rejection must continue to require Stop unless pre-admission failure is proven. Give answer-capacity rejection a distinct reason if admission limits change; current caps match and no reachable loss was established.
- [ ] **CHO-04 qualification:** repeat final Codex bundle success/Stop/recovery after subscription quota is available. The current final probe establishes explicit submission followed by an honestly reported provider-limit failure; prior successful runtime/rendered evidence is retained separately.
