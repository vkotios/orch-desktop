# Rendered journeys — CHO desktop UI

Evidence record for `apps/desktop/e2e/native-chat.spec.ts`, the Playwright
suite that boots the real app UI in Chromium through a dedicated Vite dev
server (port 1427) with the Tauri IPC doubles from `e2e/tauri-fixture.ts`.
The journeys do NOT run against the production asset bundle; the production
build is a separate check (see the table below).

## Actual counts (2026-11-12, this worktree)

| Suite | Command | Result |
| --- | --- | --- |
| Rendered journeys, all 4 viewport projects | `npx playwright test` (apps/desktop) | 80 passed / 0 failed (20 tests x 4 projects, 1.1 min) |
| desktop-1360x880 | `--project=desktop-1360x880` | 20 passed |
| narrow-960x720 | `--project=narrow-960x720` | 20 passed |
| effective-125pct (1088x704) | `--project=effective-125pct` | 20 passed |
| effective-150pct (907x587) | `--project=effective-150pct` | 20 passed |
| Source unit tests (Vitest, isolated to `src/`) | `npm test` (workspace desktop) | 43 files, 787 tests passed |
| acp-client package tests | `npm test` (root) | 3 files, 44 tests passed |
| Typecheck | `npm run typecheck` | clean (`tsc --noEmit`) |
| Production build | `npm run build` | succeeded (vite build, 1.4 s) |

The server is started by Playwright itself on the dedicated loopback port
1427 (`npm run dev:vite:e2e`, `--strictPort`) with
`reuseExistingServer: false`, so a run never attaches to a Vite instance
belonging to another worktree. This is a Vite DEV server serving the real
app UI; it is not the production asset bundle — `npm run build` is verified
as its own check in the table above.

## What the journeys prove

- The real `NativeChat` component tree renders through the dedicated Vite dev
  server; assertions use bounding boxes, computed styles, focus and keyboard input.
- The UI drives the documented Tauri command sequence (validate, prepare,
  list/hydrate conversations, poll, send, approvals, clarifications, drafts)
  and records every invoke for inspection.
- Layout budgets hold at all four projects: no horizontal document overflow,
  composer/sidebar/header stay inside the viewport, long code/prose/diff
  content scrolls inside its own plane, and focus rings are visible.

## Evidence limits — what these tests are NOT

- **Browser, not WebView2.** The journeys run in Playwright's Chromium
  (`devices["Desktop Chrome"]`). They do not exercise the WebView2 runtime,
  its window chrome, or its IME/touch behaviours.
- **Not the installed app.** No Tauri shell, no Rust host, no installer, no
  packaged runtime. The `window.__TAURI_INTERNALS__` surface is a browser-side
  double that answers the same command names and payload shapes.
- **Not OS DPI.** The `effective-125pct` / `effective-150pct` projects shrink
  the CSS viewport (1088x704 / 907x587) to approximate the layout budget of a
  1360x880 window at 125% / 150% Windows scaling. They do not test actual
  display scaling, per-monitor DPI awareness, or font metrics of the OS.
- **No live providers.** No Codex/Claude CLI, no network calls, no saved user
  state; every host answer is scripted per scenario.
- **Not a native-window qualification.** Window sizing, native menus, file
  dialogs and OS integration are out of scope for this suite.
