# Cursor completion evidence — 2026-11-06 (candidate update 2026-11-08 evening)

Europe/London. Binary + tip candidate:
`9302b87ba39545dd1fc5ca13701ff73d0d09d7f5` on `codex/cho-v01-foundation`
(audited base `76076fb3cd6c82f3ca7d74220d226e34955521c4`). Docs commits after this
SHA may refine evidence only; rebuild when product source moves again.

## Checks run (this candidate)

| Check | Result | Notes |
| --- | --- | --- |
| focused export/hydrate paging tests | pass | includes 501-turn export + `hasMoreTurns` disclosure |
| `npm run build` (via tauri beforeBuild) | pass | web production build |
| `node apps/desktop/scripts/prepare-runtime.mjs` | pass | staged Node `v24.22.2` → `.runtime` |
| `npm run native:build` | pass | MSI + NSIS rebuilt from `9302b87` |
| Full `npm test` / cargo | not re-run on this tip | prior tip green; this delta focused |
| Live Codex/Claude qualification | blocked | owner account/quota |
| Clean-machine installer AC-01/13/15 | blocked | artifacts exist; clean Windows not run |
| Independent orch review round | blocked | reviewer capacity / live worker |
| Push / tag / sign / publish | blocked | needs explicit owner authority |

### Source / runtime / artifact hashes (Europe/London 2026-11-08)

| Item | SHA-256 / identity |
| --- | --- |
| Binary source HEAD | `9302b87ba39545dd1fc5ca13701ff73d0d09d7f5` |
| `apps/desktop/src-tauri/.runtime/runtime-manifest.json` | `EB673CEDACDD211B12CCE93A39F4B0256A4E3EAE3E32A66662E7F950A8477EE4` |
| Staged Node | `v24.22.2` win-x64 (`node.exe` sha256 `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`) |
| `apps/desktop/src-tauri/target/release/cho-desktop.exe` | `D4FDCB64650E95FA546BE07CA8D402927304256E9F89104234133719592D123D` |
| `.../bundle/msi/CHO Desktop_0.1.0_x64_en-US.msi` | `8044085DC0FF3A742D39EEDF932252DBD7D1221BACA79902FDDAF8D9B5BF7BA7` |
| `.../bundle/nsis/CHO Desktop_0.1.0_x64-setup.exe` | `1FF0563425F665E65565AF1806E2FF824F10D5706A97EAF5E36258EF2654F2F8` |

Note: building MSI then NSIS patches the same exe with bundle-type metadata, so the
exe hash after the combined bundle step is the NSIS-patched binary. Prior hashes
for `9911924` are superseded.

## Export / hydrate truncation (controller reproduction)

Reproduced gap on `9959791`: 501 stored turns → export 500 with `truncated: false`
because truncation followed only `hasMoreEvents`. Fix on `9302b87`:

- Hydrate probes one past `turnLimit` → `hasMoreTurns` / `turnsLoaded` / `turnLimit`
- Export pages to ceilings (10k turns / 10k event pages), beyond the UI 500-turn window
- `export.truncated` and `export.truncation.{events,turns}` disclose both axes
- Regression: 501 turns export loads 501, `truncated: false`; UI window of 500 sets `hasMoreTurns: true`

## Accessible work closed after E1/E2 through this tip

- Prior admission/diff/integrate/draft/layout/runtime work through `9959791`
- Turn-cap disclosure + export paging past UI hydrate window (`9302b87`)
- Installer rebuild+rehash for `9302b87`

## AC-01–AC-15 matrix (accessible local work only)

| AC | Status | Evidence / blocker |
| --- | --- | --- |
| AC-01 | blocked | Needs clean Windows install of packaged artifact (`9302b87` hashes above) |
| AC-02 | partial | Distinct error paths exist; live CLI/sign-in matrix not re-run |
| AC-03 | partial | Resume wiring + hydrate present; live reopen not qualified here |
| AC-04 | partial | Draft conflict/restart host journey tested; rendered WebView journey not captured |
| AC-05 | partial | Durable journals + restart refuses ghost approval respond; live deny/cancel/stale owner-blocked |
| AC-06 | partial | Conversation/route/project admission locally checked; live orch launch not re-qualified |
| AC-07 | partial | Uncertain adopt/abandon UI + unit tests; live interrupt/reconcile journey open |
| AC-08 | blocked | Independent review unavailable; Diff drawer + dirty overlay implemented locally |
| AC-09 | partial | Accept/Finish/Discard/Integrate separated; receipt/serialize tested; live journey not re-qualified |
| AC-10 | partial | orch process identity reused; owned cancel path exists |
| AC-11 | partial | Host allowlist + strengthened admission; bridge security tests pass |
| AC-12 | partial | Landmark/flex/keyboard contracts; owner scaling/WebView2 still blocked |
| AC-13 | partial | Backup→migrate→verify + crash-lock reclaim tested; clean-machine upgrade fixture blocked |
| AC-14 | partial | Focused suites on this tip; remote CI on published final head not claimed |
| AC-15 | blocked | Support matrix vs clean receipts not complete |

## Remaining owner actions (precise)

1. **Authorize push** of `codex/cho-v01-foundation` if remote should move.
2. **Run clean-machine** MSI/NSIS install → launch without checkout/Node → upgrade → uninstall (AC-01/13/15) using the `9302b87` hashes above.
3. **Live controller matrix**: signed-in Codex/Claude missing-CLI, expired auth, reopen, approval deny/cancel/stale (AC-02/03/05/15).
4. **Independent review capacity**: approved orch reviewer route for a real delegated change (AC-08).
5. **Owner display**: 125%/150% scaling + WebView2 keyboard focus capture (AC-12).
6. **Signing / tag / publish** only with separate explicit authority (not performed).
7. **Remote CI** green on the published final head (AC-14).

## Toolchain

- Rust/Cargo present for release build (`Finished release` in native:build log)
- MSVC Build Tools 2022 present
- Node: workspace current; staged runtime `v24.22.2`
- Edge WebView runtime present under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`
