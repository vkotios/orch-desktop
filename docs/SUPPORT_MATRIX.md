# CHO Desktop v0.1 support matrix

Europe/London. Candidate evidence tracked in
[CURSOR-COMPLETION-2026-11-06](evidence/CURSOR-COMPLETION-2026-11-06.md).

| Capability | Supported in v0.1 claim | Evidence state |
| --- | --- | --- |
| Platform | Windows 11 x64 | Local MSI/NSIS artifacts built; clean-machine install **blocked** (owner environment) |
| Packaged runtime | Bundled Node 24.22.2 under `.runtime` | Staged + included in native build |
| Controllers | Codex + Claude installed CLIs | Debug-preview evidence historical; live reopen qualification **blocked** on account/quota |
| Auth | Installed CLI auth only (no credential packaging) | By design |
| Durable sessions | SQLite dual-write + hydrate/poll recovery | Local tests pass; live reopen not qualified |
| Delegation | orch claim/worktree/run via Agents panel | Host-admitted `orch_run`; end-to-end live journey unfinished |
| Accept / Finish / Discard | Explicit; Finish ≠ Git merge | Implemented; Integrate disabled until Git path exists |
| Approvals / clarifications durability | Mailbox live path | Durable journals exist; host dual-write unfinished |
| Diff / changed files | Read-only association worktree preview | Implementation in progress |
| Independent review | orch review/gate | UI evidence surfacing in progress; live independent review **blocked** if reviewer quota unavailable |

Do not advertise unsupported platforms, automatic Git integration, or clean-machine
acceptance until the corresponding AC rows are green.
