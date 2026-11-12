# Desktop follow-ups

Current completion candidate: [acceptance ledger and nonblocking review follow-ups](docs/evidence/ACCEPTANCE-2026-11-12.md).

The accepted delivery sequence is [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). These items supplement its work packages.

- [x] **CHO-04 / clarification capability milestone:** native Codex and Claude question/answer contracts established, including explicit answers, invalid-answer recovery and Stop. Source `926110a` passes 388 package tests, native build and independent GLM review. Built Codex question rendering/answer/Stop/recovery passes; Claude uses actual bundled-service and shared-card evidence. See [capability results](docs/work-packages/CHO-04.md).
- [x] **CHO-06:** render unfinished Markdown code fences cleanly when a streamed turn is interrupted (FormattedMarkdown + unit test).
- [x] **CHO-04 / CHO-06:** native Browse selection/cancellation and focused rendered Claude conversation acceptance. Owner-assisted selection and manual trust are recorded separately from automated cancellation, first/continuing marker turns, visible formatted streaming, actual interruption and a completed post-Stop marker turn. This verifies the debug preview, not installer or clean-machine behavior.
- [~] **CHO-07 / CHO-08:** restrictive CSP, NOTICE/SUPPORT/PRIVACY/SECURITY/CONTRIBUTING, native Windows CI job, and local MSI/NSIS artifacts landed. Clean-machine install/upgrade/signing/public push remain owner-blocked.
- [~] **CHO-07:** Vitest pin raised to `^3.2.7` and documented in `docs/VITEST_ADVISORY.md`; release-candidate `npm audit --omit=dev` clearance still owner-timed.
- [ ] **Maintenance:** remove the unused `mut` in the Rust wire split-stream test (`host_wire.rs`); it is a compiler warning, not a runtime failure.
- [ ] **Maintenance:** remove redundant parentheses in the native command object check (`src-tauri/src/lib.rs`) and stage an explicit module-type boundary for the shared TypeScript normalizer to suppress Node's typeless-package warning. Both current native build and actual staged runtime checks pass.
- [ ] **Future platform support:** report unsupported platforms before checking Windows runtime resource paths; initial native qualification remains Windows x64.

- [~] **CHO-07:** Windows CI now includes a `native-windows` cargo-test job after runtime staging. Installer path-length/concurrent-preparation qualification and clean-machine acceptance remain open.

- [ ] **Coordinator maintenance:** reconcile finish handling for a lane-busy admission that never started a worker but lacks spawned keeper identity. The runtime batch has all dispositions and completed reviews; its orch claim remains held until supported liveness reconciliation permits closure. Preserve original receipts.

Current evidence covers real continuing Codex and Claude debug-runtime conversations with tool permissions, clarification, cancellation and owned cleanup. Both windows pass focused rendered conversation checks. Broader UI polish, installed release and clean-machine acceptance remain open.

- [~] **CHO-03:** Recovery defects + F-11 `excludeTurns` + approval/clarification dual-write + historical hydrate projection + search/export/import + S3d probes + backup/migrate/verify v1→v2 landed ([progress](docs/evidence/PROGRESS-MATRIX-2026-11-06.md)). Still open: deeper tool-fact consumer mapping, live resume qualification.
- [~] **CHO-04/05:** Host admission, uncertain adopt/abandon, Diff, Finish preview/Stop, and **explicit Git Integrate** (dry-run + merge rechecks) landed. Live delegated change + independent review remain blocked. [Release gates](docs/RELEASE_v01.md).
- [~] **CHO-06:** Maintained `react-markdown` + GFM with safe links and repository-relative file references; automated viewport CSS contract evidence recorded. Owner scaling/WebView2 keyboard capture remain open.
- [x] **CHO-06:** replace the generic Starting indicator while an empty response waits on a clarification; retain explicit waiting/submission/error states and no default answer.
- [ ] **Maintenance:** remove the unused local clarification reset helper when cleaning the API. Generic invoke rejection must continue to require Stop unless pre-admission failure is proven. Give answer-capacity rejection a distinct reason if admission limits change; current caps match and no reachable loss was established.
- [ ] **CHO-04 qualification:** repeat final Codex bundle success/Stop/recovery after subscription quota is available. The current final probe establishes explicit submission followed by an honestly reported provider-limit failure; prior successful runtime/rendered evidence is retained separately.
