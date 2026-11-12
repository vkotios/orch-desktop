# CHO Desktop v0.1 support matrix

Current candidate: `be49418`, 2026-11-12. Historical installer hashes do not
qualify this source. See [acceptance ledger](evidence/ACCEPTANCE-2026-11-12.md).

| Capability | Implementation / measured evidence | Remaining qualification |
| --- | --- | --- |
| Platform | Windows x64 target; private CI EXE/MSI/NSIS pipeline | Clean Windows install and proposed release artifacts |
| Runtime | Bundled Node 24.22.2; 116 staged files match source | Final installed candidate smoke in CI |
| Controllers/auth | Existing Codex/Claude CLI login; both owned native restart probes pass | Installed real tool/approval journeys; no automatic fallback |
| Durable sessions | SQLite history, drafts, replay, imports, migration protections; strict Claude wire DTO fixed | Installed-process recovery and upgrade acceptance |
| Delegation | Conversation-bound claim/worktree/run, persisted recovery stages and ownership checks | Live implement/review/integrate/discard release journey |
| Accept / Integrate / Finish / Discard | Explicit actions; Integrate checks exact reviewed Git tip and converged gate; Finish is cleanup | Proposed release end-to-end journey |
| Approvals / clarifications | Durable journals and host integration; deterministic UI/action checks | Live reject/cancel/restart release journey |
| Diff / changed files | Committed merge-base patch plus dirty/untracked overlay | Installed live delegation acceptance |
| Review evidence | Independent model/commit/clean-containment checks and gate semantics | Live review evidence and gate in release journey |
| Layout / keyboard | 80 Chromium fixture checks over four viewport budgets | Real WebView2, IME and Windows DPI checks |

Signing, public distribution and non-Windows product support are not qualified.
Browser fixtures and a developer-equipped CI runner are not clean-machine proof.
