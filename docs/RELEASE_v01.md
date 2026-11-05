# CHO Desktop v0.1 release checklist

Target: Windows 11 x64 installer + public GitHub source once product journeys qualify.

## Journeys status (local, 2026-11-05)

| Journey | State |
| --- | --- |
| Open app / pick project / discover CLIs | NativeChat + host discovery |
| Real Codex/Claude continuing conversation | Native preview; dual-write to SQLite |
| Persist / resume text across reopen | Dual-write + list/hydrate on prepare |
| Delegate via orch (claim/worktree/run) | Host allow-list + Agents panel in NativeChat |
| Native CLI auth (no credential copy) | Unchanged — uses installed CLIs |

Still not release-qualified: packaged installer smoke on a clean machine, durable live poll cursor, Claude native resume (`--resume`), S3d tool chrome, Stop/close coupling, and RapidAI NOTICE attribution.

## Build commands

```powershell
npm ci
npm run typecheck --workspace apps/desktop
npm test --workspace apps/desktop
npm run build --workspace apps/desktop
# Installer (requires Rust + WebView2 tooling on the build machine):
npm run tauri --workspace apps/desktop -- build
```

Session DB default: `%USERPROFILE%\.cho-desktop\sessions.sqlite3` (override with `CHO_SESSION_DB`).

## Release steps (with owner)

1. Confirm journeys on a real Windows box with Codex and Claude signed in.
2. Produce the Tauri Windows installer artifact and attach evidence.
3. Tag `v0.1.0` on `codex/cho-v01-foundation` (or a release branch cut from it).
4. Owner makes [`vkotios/orch-desktop`](https://github.com/vkotios/orch-desktop) public.
5. Publish source + installer notes; do not claim unqualified platforms.
