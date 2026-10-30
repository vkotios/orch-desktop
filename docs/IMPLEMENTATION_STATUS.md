# CHO Desktop implementation status

Updated: 2026-10-30

Product contract: [specification](PRODUCT_SPEC.md). Execution sequence: [plan](IMPLEMENTATION_PLAN.md). Review decisions: [validated dispositions](reviews/FINDINGS_DISPOSITION.md).

## Foundation baseline

- Integration branch: `codex/cho-v01-foundation`.
- Prototype checkpoint: `d477cf6` (desktop, workspace lockfile, and required coordinator/Grok dependencies together).
- Controller baseline checks: web build passed; 12 package tests passed; 8 focused Grok adapter tests passed. The independent review had separately observed a cold-discovery timeout, so passing once is not evidence of deterministic CI isolation.
- Native toolchain readiness: `cargo`/`rustc` were not found during the current inspection. Native build/installer qualification is still outstanding.
- No remote change, push, or release publication has occurred.

## First batch

| Slice | Implementer | Scope | State |
| --- | --- | --- | --- |
| discovery | Muse | Nonblocking/bounded model discovery and machine-independent bridge unit tests. | Preparing handoff. |
| dev-loopback | Aider / Kyojin Qwen3.8 Flash Next | Loopback-safe development launcher default, one file. | Preparing handoff. |
| vite-loopback | Aider / Lucebox DeepSeek V4 dspark | Loopback-safe direct Vite default, one file. | Queued behind the local lane. |
| desktop-ci | Muse | Independent root-workspace desktop CI, with actual trigger/coverage verification. | After deterministic tests. |
| host-boundary | Muse | Local bridge access boundary and negative request tests. | Separately scoped after discovery. |

These are implementation assignments, not claims of completed work or general model qualification. The controller reviews every worker's actual diff and check output before integration. Worker/reviewer run IDs, route receipts, detailed logs, and retained-resource decisions remain in private coordinator evidence.
