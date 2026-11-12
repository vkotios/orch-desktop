# Remaining implementation and candidate acceptance

Owner instruction: 2026-11-12. Baseline: merged PR #2, `cd86a0f`.
Controller branch: `codex/cho-v01-acceptance-completion`.

Use Muse CLI `muse-spark-1.3` and Vibe CLI
`zai-glm-5-3-flash` through orch. The portable roster is
[`orch/roster.cho-completion.json`](../../orch/roster.cho-completion.json);
both private project rosters have been updated. Older routes remain inactive.
Independent review uses the other model; the controller validates findings.
The owner revoked DeepSeek after its nonprogress loops and a host restart.
Preserve its partial changes for GLM to validate and finish. Do not launch
DeepSeek again. Inspect semantic progress as well as process liveness; repeated
empty reads are not useful work.

## Completion order

| Work | Implementation/check | Acceptance limit |
| --- | --- | --- |
| Windows candidate pipeline | Muse: exact-source EXE/MSI/NSIS build, runtime/source closure and checksums, retained private CI artifacts | Building does not prove install/upgrade/uninstall |
| Rendered journeys | GLM: actual app rendered in Chromium with deterministic IPC fixtures, keyboard/focus, overflow and viewport checks; fix exposed defects | Browser fixtures do not qualify installed WebView2, real CLI or OS DPI |
| Native conversations/recovery | Reuse the real host, durable store and native clients for owned temporary-project resume, approval/clarification, cancellation and restart checks | No unrelated sessions, saved user project or automatic provider fallback |
| Delegated change journey | Prepared conversation-bound scope/worktree, implementation, independent review, diff, integrate/finish/discard and uncertain recovery | A development worker audit is not an installed-product journey |
| Installer qualification | Build final candidate; install/launch/upgrade/uninstall and migration failure on clean Windows; record exact hashes and versions | A developer host with PATH hidden is not a clean machine |
| Final acceptance | Reconcile status/support docs, AC-01–15, source review, final checks and known limits | No green rows without candidate-bound receipts |

The product specification and its acceptance criteria remain unchanged. Repair
concrete defects rather than adding features solely to make a test convenient.
Keep deterministic fixture evidence, real runtime evidence, installed acceptance
and public distribution separate. Do not invent PASS for missing infrastructure,
credentials, a clean Windows environment, signing or publication. Signing and
public release are separate owner actions.

The initial two slices have disjoint scope and isolated implementation worktrees.
Controller checks the whole diff and required tests, records findings, obtains
independent model review and integrates only converged changes. Preserve earlier
review reports and artifact receipts as historical evidence.
