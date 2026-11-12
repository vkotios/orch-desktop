# Installed NSIS smoke (CI installed-smoke)

Runs the exact NSIS installer candidate silently into an owned directory on a
Windows CI runner, launches the installed `cho-desktop.exe --native-host-smoke`
with a sanitized child environment, verifies the real `CHO_HOST_SMOKE` receipt
and owned host shutdown, then silently uninstalls only the owned install.

Evidence is labeled **CI installed-smoke**. It is NOT a clean-machine, WebView2
UI, real-provider, upgrade/migration, MSI, or signed-release qualification. The
Windows runner has developer tooling; hiding `PATH` entries does not make it
clean. Native smoke covers bundled host boot/ping/shutdown only, never a
provider conversation.

## Invocation (Windows CI runner only)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-smoke.ps1 `
  -Installer <path-to-nsis-setup.exe> `
  -OutputDir <fresh-evidence-dir>
```

Requirements enforced by the script:

- Mandatory explicit `-Installer` and `-OutputDir`. Existing output targets are
  rejected; the output directory is created fresh.
- Fail-closed CI guard: requires `GITHUB_ACTIONS=true`, `RUNNER_OS=Windows`,
  and `RUNNER_TEMP` set. On any other host the script refuses and executes
  nothing (no installer is ever run on a developer machine).
- Installs silently (`/S /D=<owned-dir>`, uppercase `/S` per Tauri NSIS docs;
  default install mode is per-user, no admin) into a fresh GUID subdirectory of
  `RUNNER_TEMP`, with resolved-path containment verified before any recursive
  cleanup.
- Records installer SHA256 plus installed `cho-desktop.exe`,
  `runtime/node.exe`, and `runtime/app/apps/desktop/server/host.mjs` hashes.
- Launches from an unrelated empty working directory with a child environment
  that hides Node/Rust from `PATH` and poisons `NODE_OPTIONS`/`NODE_PATH`
  (production native host sanitizes these). Parent/global environment is not
  modified (values are restored in `finally`).
- Parses the real `CHO_HOST_SMOKE` receipt: requires exactly one receipt line,
  app exit 0, and `receipt.ok`. Requires the owned host gone without PID-only
  kills. Finite deadlines everywhere; the owned `Start-Process` handle/path/
  birth is identified before any timeout termination.
- Silently uninstalls (`uninstall.exe /S _?=<owned-dir>`, the uninstaller
  written by `WriteUninstaller "$INSTDIR\uninstall.exe"`) only the owned
  install and verifies the app is absent. `_?=` runs the uninstaller in
  place instead of its default self-copy to temp, so the process wait is
  authoritative completion (the generated `installer.nsi` uses this same
  mechanism). No removal of user app data and no registry edits; this runs
  on a disposable CI runner.
- Returns nonzero on failure. Guard refusal (non-CI host) writes no
  outputs: it exits before the output directory is created. Otherwise the
  script writes structured JSON into the output directory; app
  stdout/stderr logs exist only after launch, so prelaunch failures may
  lack app logs. Uncertain resources/evidence are kept rather than
  claimed PASS.
- Requires the WebView2 runtime on the Windows runner (Tauri WebView
  dependency); the real CI run qualifies it.

## Workflow invocation (wired in the Windows candidate workflow)

```yaml
- name: Installed NSIS smoke
  if: runner.os == 'Windows'
  run: >
    powershell -NoProfile -ExecutionPolicy Bypass
    -File apps/desktop/scripts/installed-smoke.ps1
    -Installer <nsis-artifact-path>
    -OutputDir ${{ runner.temp }}/cho-installed-smoke-${{ github.run_id }}-${{ github.run_attempt }}
```

## Release health diagnostic

`--native-host-smoke` is an explicit diagnostic available in release builds
(`smoke_requested()` in `apps/desktop/src-tauri/src/lib.rs` matches the
exact flag with no `cfg!(debug_assertions)` gate). It starts the bundled
host (handshake + ping), prints the `CHO_HOST_SMOKE` receipt, and exits
through the normal owned lifecycle. It accepts no arbitrary command/path,
invokes no provider, and exposes no HTTP endpoint. All other debug-only
preview/behavior guards are unchanged.

## Known limits

- Actual installer execution happens in CI after packaging-workflow
  integration; this slice covers implementation plus syntax/guard checks only.
