# Vitest advisory qualification (CHO-07)

Date: 2026-11-06 (Europe/London). Workspace pins `vitest@3.2.7`.

## Status

- Production dependency audit for the packaged desktop host remains the release
  gate. Vitest is a development test runner only and is not shipped inside the
  MSI/NSIS artifacts.
- Recorded advisories that touch Vitest/mocker/tinypool are therefore
  **development-tool risk**, not installer runtime risk.
- Upgrade is deferred until a focused evaluation can prove:
  1. lockfile resolution stays within workspace Node 24,
  2. existing Vitest suites (desktop + acp-client) stay green,
  3. no new production dependency is pulled into the Tauri bundle.

## Exact blocker for claiming clearance

Claiming “Vitest advisories cleared” still requires a deliberate upgrade PR with
before/after `npm audit --omit=dev` and full `npm test` evidence. Until then,
treat the advisories as known, scoped to devDependencies, and not a v0.1
installer blocker.
