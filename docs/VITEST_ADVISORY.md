# Vitest advisory qualification (CHO-07)

Date: 2026-11-06 (Europe/London). Workspace pins `vitest@^3.2.7` (resolved 3.2.7).

## Status

- Production dependency audit for the packaged desktop host remains the release
  gate. Vitest is a development test runner only and is not shipped inside the
  MSI/NSIS artifacts.
- Recorded advisories that touch Vitest/mocker/tinypool are therefore
  **development-tool risk**, not installer runtime risk.
- Pin raised to `^3.2.7` to match the lockfile resolution used by desktop suites.

## Clearance note

DevDependency pin now matches the resolved runner. Claiming full advisory
clearance still wants `npm audit --omit=dev` evidence on the release candidate
and green `npm test`. Until that release-candidate audit is filed, treat any
remaining Vitest advisories as known, scoped to devDependencies, and not a
v0.1 installer blocker.
