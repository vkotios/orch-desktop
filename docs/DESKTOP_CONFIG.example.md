# Desktop configuration examples

These are documentation-only. Do not commit personal paths or credentials.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CHO_SESSION_DB` | Absolute path to the durable session SQLite file | `%USERPROFILE%\.cho-desktop\sessions.sqlite3` |
| `CHO_DELEGATION_DB` | Absolute path to delegation association JSON | `%USERPROFILE%\.cho-desktop\delegations.json` |
| `CHO_PRODUCER_LIVENESS` | Absolute path to producer liveness map | beside the session DB (`.liveness.json`) |
| `CHO_BRIDGE_PORT` | Dev browser bridge port | set by desktop scripts |

Notes:
- The packaged host stages Node under `apps/desktop/src-tauri/.runtime` via `prepare-runtime.mjs`.
- CLI credentials stay in Codex/Claude stores; CHO does not collect provider secrets.
- See `docs/PRIVACY_AND_DATA.md` for retention and `docs/SUPPORT_MATRIX.md` for qualified surfaces.
