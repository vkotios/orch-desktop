# Cursor completion evidence — 2026-11-06

Europe/London. Candidate work is uncommitted on `codex/cho-v01-foundation`
above audited base `76076fb3cd6c82f3ca7d74220d226e34955521c4`.

## Checks run

| Check | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | pass | acp-client + desktop |
| `npm test` | pass | 44 shared + 723 desktop = **767** |
| `npm run build` | pass | web production build |
| orch unit/adapters | pass | 61 focused coordinator tests |
| `node apps/desktop/scripts/prepare-runtime.mjs` | pass | staged Node `v24.22.2` → `apps/desktop/src-tauri/.runtime` |
| `cargo test --offline --locked` (src-tauri) | pass | 12 Rust tests |
| `npx tauri build --bundles msi,nsis` | pass | after adding icon paths to `tauri.conf.json` |
| Live Codex/Claude qualification | blocked | needs owner account/quota; not inferred from mocks |
| Clean-machine installer AC-01/13/15 | blocked | artifacts exist; clean Windows install/upgrade not run |

### Native artifacts (Europe/London 2026-11-06)

Final bundled build hashes (post-icon config):

| Artifact | SHA-256 |
| --- | --- |
| `apps/desktop/src-tauri/target/release/cho-desktop.exe` | `11D6E3A86EA0597D648DBBF13C30A34CAAA9B21FCFA7EF80BCC2E5E006E79E41` |
| `.../bundle/msi/CHO Desktop_0.1.0_x64_en-US.msi` | `8FBB741EC86391C618D5CE41E9FBA43D362C9D29C47D724B980AE2167F972974` |
| `.../bundle/nsis/CHO Desktop_0.1.0_x64-setup.exe` | `7F8389AD03BFBCDCF2938542477012817449490DDA846C4A52943431C1D0F024` |

Note: building MSI then NSIS patches the same exe with bundle-type metadata, so the
exe hash after the combined bundle step is the NSIS-patched binary.

## Finding disposition (audit → this candidate)

| ID | Disposition | Implementation / evidence |
| --- | --- | --- |
| F-12 | Fixed | Close settles `unknown` unless a native interrupted outcome already existed; tests in `native-chat.test.mjs` |
| F-03 | Fixed | `resetProject` try/finally always closes native client; settle failure rethrown after close |
| F-08 | Fixed | Pre-observation / fatalize / Claude send-failure settle `unknown`; prepare-time `reconcileStrandedTurns` |
| C-01 | Fixed | `readBodyText` concatenates buffers then decodes once; unicode boundary hydrate test |
| F-05 | Fixed (partial) | Liveness records `createdAt`, exclusive lock, EPERM/uncertain ≠ dead |
| F-02 | Fixed (partial) | Durable recovery when live progress lost; cursor not advanced past withheld durable events; reducer tests |
| F-13 | Fixed (partial) | Stable `factId` per `(toolCallId,phase)`; drop Codex `nativeMessageId` fallback; storage failures still surface (RUN-04) |
| F-06 | Fixed (partial) | Draft meta merge, conflict notice, unmount timer cancel, restore prompt on send failure |
| F-07 | Fixed (partial) | Restore multiple conversations; truncation/unbound notices; hydrate errors surfaced |
| F-04 | Fixed (partial) | Intent-before-effect, conversation filter, uncertain stage, no relaunch without run id |
| F-01 | Fixed (partial) | Host `admitOrchArgs` strips `ownerApprovedModel`/`allow`, derives `orch_run` dir from association |
| F-09 | Fixed (partial) | Finish warns worktree removal; uncertain gates Accept/Finish; dry-run before discard cleanup |
| F-10 | Docs pending update in this pass | Status docs refreshed with honest wording |
| F-11 | Open | `excludeTurns` optional; needs installed Codex schema check |

## AC-01–AC-15 matrix (accessible local work only)

| AC | Status | Evidence / blocker |
| --- | --- | --- |
| AC-01 | blocked | Needs clean Windows install of packaged artifact |
| AC-02 | partial | Distinct error paths exist in host/UI; live CLI/sign-in matrix not re-run |
| AC-03 | partial | Resume wiring + hydrate present; live reopen with real CLI not qualified here |
| AC-04 | partial | Draft/switch fixes landed; rendered journey evidence not captured |
| AC-05 | partial | Prior mailbox approval/cancel evidence; durable approval journal still unwired |
| AC-06 | partial | Association intent + host-admitted run dir; end-to-end orch launch not re-qualified |
| AC-07 | partial | Uncertain stages + no silent relaunch; live interrupt/reconcile journey open |
| AC-08 | blocked | Independent review + diff UI journey incomplete |
| AC-09 | partial | Accept/Finish/Discard wording fixed; Integrate disabled; Git integrate still unavailable |
| AC-10 | partial | orch process identity reused; owned cancel path exists |
| AC-11 | partial | Host allowlist + admission; bridge security tests pass |
| AC-12 | blocked | Needs rendered 1360×880 / 960×720 / scaling keyboard evidence |
| AC-13 | blocked | Needs upgrade/migration fixture on clean environment |
| AC-14 | partial | Local suites green; remote CI on final head not claimed here |
| AC-15 | blocked | Support matrix vs clean receipts not complete |

## Toolchain

- Rust/Cargo: `1.99.1` at `%USERPROFILE%\.cargo\bin` (added to PATH for this session)
- MSVC Build Tools 2022 present (`14.44.35207`)
- Node: workspace `v24.22.1`; staged runtime `v24.22.2`
- Owner marked all three requested env setup external actions done (2026-11-06 Europe/London)
- Edge WebView runtime present under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` (156.x)
- This private-worker run has no linked Cursor cloud Environment record; local machine setup is the source of truth
