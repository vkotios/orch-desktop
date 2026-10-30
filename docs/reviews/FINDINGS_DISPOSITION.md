# Design review: validated disposition

Date: 2026-10-30

The owner authorized warranted corrections and the first implementation batch. The controller checked the report against the source and the existing coordinator contract. The original Sonnet report is preserved; it is advice, not an implementation gate.

| Finding | Disposition | Warranted action |
| --- | --- | --- |
| F1 — delegation approval | Confirmed design gap; proposed implementation is not automatically accepted. | Added ORCH-09: the host owns claims/admission; native tool/approval/isolation support must enforce the delegation boundary. A prompt alone is insufficient. Resolve the concrete transport boundary in CHO-04/05. |
| F2 — controller mechanisms | Confirmed planning dependency; help text is not live capability proof. | Move bounded per-controller transport spikes ahead of native-reference schema freeze. Do not claim that a particular CLI transport is qualified until it is exercised. |
| F3 — native prerequisites/packaging | Confirmed readiness gap. No cargo/rustc command or default per-user rustc executable was found during controller inspection. | Add an early native build/readiness check and use bundled Node plus packaged JavaScript as the initial runtime layout. Do not claim that the web build proves the native shell works. |
| F4 — CI coverage | Confirmed absence of desktop checks; refuted the literal claim that no checks run at all. | Establish an independent desktop workflow with actual root dependency installation/checks and correct triggers. Preserve inherited coordinator checks; do not rewrite their selection policy unnecessarily. |
| F5 — qualification overhead | Accepted proportionality correction, with a reviewer caveat. | Qualify only the pair needed for the next useful task. The controller reviews every diff and runs independent checks; do not front-load qualification of every model/harness. |
| F6 — model identity | Partly refuted. Claude/Muse extract native reported identity; Aider reports actual identity as unknown. | Preserve requested/reported values and gateway evidence separately. Do not replace unknown with a configured selector. Keep reviewer-independence checks; no attribution rewrite is warranted solely by this finding. |
| F7 — current permission posture | Confirmed prototype limitation. Additional CLI claimant identities are not necessarily needed if the host owns claims. | Implement capability-aware native permission/delegation admission under CHO-04/05. Do not advertise unqualified roles; do not add claimant strings merely to match UI harness names. |
| F8 — source checkpoint | Confirmed prerequisite, but the proposed three-commit order would break a fresh desktop checkout. | Created dependency-complete prototype checkpoint `d477cf6`, including the Grok adapter imported by the desktop. This is a reproducible starting point, not release qualification. |
| F9 — baseline tests | Current variability confirmed; the earlier dated successful test result is not refuted. | Sonnet observed a cold-discovery timeout; the controller's next run passed all 12 tests. Replace real-machine/provider-dependent unit testing and blocking discovery with a bounded worker fix. Preserve both observations. |
| F10 — acceptance UI | Confirmed unfinished product semantics; the ledger's ability to record dispositions is not itself a gate defect. | Keep recording, verification, review convergence, integration, and cleanup distinct. Address the UI/host acceptance capability in CHO-05 rather than calling a ledger row proof of convergence. |

## Other observations

- Unauthenticated all-interface development listeners and wildcard CORS warrant a focused local-host safety slice before publication. Loopback defaults alone do not constitute full production authentication.
- Prompt truncation, workspace fallback, process/event recovery, duplicated normalization, hard-coded project discovery, misleading role lists, and the unused Grok trust store remain real work under the already named host/controller/session packages. They are not permission to expand the first slice into a broad rewrite.
- The `orch/THIRD_PARTY.md` dependency metadata discrepancy is a documentation follow-up under CHO-07; it does not establish that runtime code actually imports the SDK.
- The old audit attempt's `blocked-auth` terminal-status bookkeeping issue is retained as a coordinator follow-up. Do not alter persisted evidence to force closure.

## First implementation batch

The first foundation batch is: dependency-complete source checkpoint; deterministic/nonblocking discovery and tests; useful bounded Aider edits on the requested local routes; desktop CI with real coverage; and the local-host safety boundary. Native prerequisite/runtime smoke and controller transport spikes are early follow-ons. Muse/Aider implement; the controller inspects source, runs checks, adjudicates findings, and integrates accepted changes locally. No push or publication is included.
