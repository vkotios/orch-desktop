# Cursor completion evidence — 2026-11-06 (candidate update 2026-11-08)

Europe/London. Final accessible candidate HEAD:
`9911924ae99dc95e5fa482210ad6e814fb468c57` on `codex/cho-v01-foundation`
(above audited base `76076fb3cd6c82f3ca7d74220d226e34955521c4`).

## Checks run (this candidate)

| Check | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | pass | acp-client + desktop |
| `npm test` | pass | 44 shared + **770** desktop = **814** |
| `npm run build` (via tauri beforeBuild) | pass | web production build |
| `node apps/desktop/scripts/prepare-runtime.mjs` | pass | staged Node `v24.22.2` → `apps/desktop/src-tauri/.runtime` (includes `delegation-admit.mjs`) |
| staged-host import probe | pass | `runtime-preparation.test.ts` outside-checkout host closure |
| `cargo test --offline --locked` (src-tauri) | see follow-up row | run with this evidence pass |
| `npm run native:build` | pass | MSI + NSIS bundles produced |
| Live Codex/Claude qualification | blocked | needs owner account/quota |
| Clean-machine installer AC-01/13/15 | blocked | artifacts exist; clean Windows install/upgrade not run |
| Independent orch review round | blocked | reviewer capacity / live worker |
| Push / tag / sign / publish | blocked | needs explicit owner authority |

### Source / runtime / artifact hashes (Europe/London 2026-11-08)

| Item | SHA-256 / identity |
| --- | --- |
| Git HEAD | `9911924ae99dc95e5fa482210ad6e814fb468c57` |
| `apps/desktop/src-tauri/.runtime/runtime-manifest.json` | `EB673CEDACDD211B12CCE93A39F4B0256A4E3EAE3E32A66662E7F950A8477EE4` |
| Staged Node | `v24.22.2` win-x64 (`node.exe` sha256 `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`) |
| `apps/desktop/src-tauri/target/release/cho-desktop.exe` | `C71B46B59CD68EF5BCC27F74A5B88FA341875EE940A4BF03AE38331CACE4706F` |
| `.../bundle/msi/CHO Desktop_0.1.0_x64_en-US.msi` | `FB0F4667483367CB4BB2DEDC681794BB2CA27FF4CE70765FDBFB1D6C2F44E439` |
| `.../bundle/nsis/CHO Desktop_0.1.0_x64-setup.exe` | `7F451331478DD1D6F2CCF266CF9D7A09BCF6952F4E0AAE6889DBB3D411F09868` |

Note: building MSI then NSIS patches the same exe with bundle-type metadata, so the
exe hash after the combined bundle step is the NSIS-patched binary.

## Accessible work closed after E1/E2 (`5537a77` → `9911924`)

- Turn/event hydrate paging past `listTurns` 100-cap; full-history export caps
- Migration crash-lock dead-PID reclaim + live-PID refuse
- Dirty/untracked Diff overlay (`dirtyCount`)
- Host `admitOrchRunArgs`: conversation + approved-route cli/model + prepared project path
- Integrate receipt-fail after merge + per-association serialize lock
- Draft conflict host journey + restart draft retention without live approval replay
- Landmark/flex/overflow layout contract + composer Enter keyboard helper
- Staged runtime includes `delegation-admit.mjs`; installer rebuild+rehash

## AC-01–AC-15 matrix (accessible local work only)

| AC | Status | Evidence / blocker |
| --- | --- | --- |
| AC-01 | blocked | Needs clean Windows install of packaged artifact (`9911924` hashes above) |
| AC-02 | partial | Distinct error paths exist in host/UI; live CLI/sign-in matrix not re-run |
| AC-03 | partial | Resume wiring + hydrate present; live reopen with real CLI not qualified here |
| AC-04 | partial | Draft conflict/restart host journey tested; rendered WebView journey not captured |
| AC-05 | partial | Durable journals + restart refuses ghost approval respond; live deny/cancel/stale still owner-blocked |
| AC-06 | partial | Conversation/route/project admission locally checked; end-to-end live orch launch not re-qualified |
| AC-07 | partial | Uncertain adopt/abandon UI + unit tests; live interrupt/reconcile journey open |
| AC-08 | blocked | Independent review unavailable; Diff drawer + dirty overlay implemented locally |
| AC-09 | partial | Accept/Finish/Discard/Integrate separated; receipt/serialize tested; live journey not re-qualified |
| AC-10 | partial | orch process identity reused; owned cancel path exists |
| AC-11 | partial | Host allowlist + strengthened admission; bridge security tests pass |
| AC-12 | partial | Landmark/flex/keyboard contracts ([VIEWPORT-LAYOUT-2026-11-06](VIEWPORT-LAYOUT-2026-11-06.md)); owner scaling/WebView2 still blocked |
| AC-13 | partial | Backup→migrate→verify + crash-lock reclaim tested; clean-machine upgrade fixture still blocked |
| AC-14 | partial | Local suites green on `9911924`; remote CI on final head not claimed here |
| AC-15 | blocked | Support matrix vs clean receipts not complete |

## Remaining owner actions (precise)

1. **Authorize push** of `codex/cho-v01-foundation` (or chosen integration branch) if remote should move.
2. **Run clean-machine** MSI/NSIS install → launch without checkout/Node → upgrade → uninstall (AC-01/13/15).
3. **Live controller matrix**: signed-in Codex/Claude missing-CLI, expired auth, reopen, approval deny/cancel/stale (AC-02/03/05/15).
4. **Independent review capacity**: launch approved orch reviewer route for a real delegated change (AC-08).
5. **Owner display**: 125%/150% scaling + WebView2 keyboard focus capture (AC-12).
6. **Signing / tag / publish** only with separate explicit authority (not performed).
7. **Remote CI** green on the published final head (AC-14).

## Toolchain

- Rust/Cargo present for release build (`Finished release` in native:build log)
- MSVC Build Tools 2022 present
- Node: workspace current; staged runtime `v24.22.2`
- Edge WebView runtime present under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`
