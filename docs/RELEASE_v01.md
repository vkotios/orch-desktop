# CHO Desktop v0.1 release checklist

Target: Windows 11 x64 installer + public GitHub source once product journeys qualify.

## Journeys status (local, 2026-11-05)

| Journey | State |
| --- | --- |
| Open app / pick project / discover CLIs | NativeChat + host discovery |
| Real Codex/Claude continuing conversation | Prior debug-preview evidence; current durable resume wiring needs integrated qualification |
| Persist / resume text across reopen | Recovery defects from the 2026-11-05 audit are repaired in code; live reopen qualification remains |
| Delegate via orch (claim/worktree/run) | Intent-before-effect associations + host-admitted `orch_run` dir; end-to-end journey still open |
| Accept / Finish / Integrate / discard | Accept / Finish / Discard / Integrate exist and stay separate; Integrate merges after Accept with dry-run confirm; Finish warns worktree removal |
| Native CLI auth (no credential copy) | Unchanged — uses installed CLIs |

Still not release-qualified: packaged installer smoke on a clean machine, live
Codex/Claude reopen/tool/approval matrix, owner scaling/WebView2 keyboard
evidence, and RapidAI NOTICE attribution. Public repo / tag / signing require
the owner.

Current validation (2026-11-06 Europe/London), completion candidate above `76076fb`:
743 desktop package tests (+ shared), typecheck, web build; see
[progress matrix](evidence/PROGRESS-MATRIX-2026-11-06.md),
[completion evidence](evidence/CURSOR-COMPLETION-2026-11-06.md),
the [audit](reviews/CURSOR-DELIVERY-REVIEW-2026-11-05.md), and
[Cursor completion instruction](CURSOR_COMPLETION_INSTRUCTIONS.md).

## Build commands

```powershell
npm ci
npm run typecheck
npm test
npm run build
# Installer (requires Rust + WebView2 tooling on the build machine):
npm run native:build
```

Session DB default: `%USERPROFILE%\.cho-desktop\sessions.sqlite3` (override with `CHO_SESSION_DB`).

## Release steps (with owner)

1. Resolve the audited blockers, then confirm EVERY AC-01–AC-15 on the actual
   candidate/artifact, including the clean Windows installation/upgrade/uninstall
   environment and existing authorized Codex/Claude accounts/routes. Record failed,
   blocked and unverified rows separately; mocked/source checks do not qualify them.
2. Produce the Tauri Windows installer artifact and attach evidence.
3. Tag `v0.1.0` on `codex/cho-v01-foundation` (or a release branch cut from it).
4. Owner makes [`vkotios/orch-desktop`](https://github.com/vkotios/orch-desktop) public.
5. Publish source + installer notes; do not claim unqualified platforms.
