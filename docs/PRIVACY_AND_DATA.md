# Privacy and data retention (v0.1)

## What CHO stores locally

| Data | Default location | Retention |
| --- | --- | --- |
| Session database (conversations, drafts, events, bodies) | `%USERPROFILE%\.cho-desktop\sessions.sqlite3` (override `CHO_SESSION_DB`) | Until the user deletes the file or uninstalls without removing profile data |
| Producer liveness map | Alongside the session DB or `%USERPROFILE%\.cho-desktop\producer-liveness.json` | Cleared on producer release; may linger after crash until reclaim |
| Delegation associations | `%USERPROFILE%\.cho-desktop\delegations.json` (override `CHO_DELEGATION_DB`) | Until discarded/finished records are removed by the user/tooling |
| Orch coordinator state | Repository `.orch` / orch state roots | Managed by orch claims, runs, and cleanup |

## What CHO does not package

- Provider API keys or subscription cookies
- Global Node installations required on the target machine for the packaged app
- Automatic cloud upload of transcripts

Native Codex/Claude conversations use the installed CLIs' own authentication.

## Uninstall

Removing the Windows installer does not automatically delete `%USERPROFILE%\.cho-desktop`.
Users who want a full wipe must remove that directory explicitly. Upgrade/migration
failure must preserve recoverable prior data (AC-13); clean-machine verification of
that behaviour remains an owner-environment gate.
