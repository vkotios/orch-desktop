# Post-PR CI and development-dependency follow-up

The initial coordinator jobs in PR #2 stopped at the strict release scan, before
running their tests. Desktop CI treated that scan as advisory. The 30 findings
were reviewed: synthetic UUIDs in protocol/negative-test fixtures, a synthetic
clarification answer, source-checkout paths in retained audits and published
audit correlation IDs. No real credential was found in those findings.

`orch/tools/release-scan-expected.json` records each exact file, pattern and
SHA-256 of the matched line, with its review reason. There are no wildcard file
or directory exemptions. Editing a line or moving it to a different file makes it unexpected again;
unknown content remains blocked. An invalid exception policy fails a control.
The LICENSE control and every secret-pattern self-test remain independent of the
manifest. Regression tests check a changed exception, a new secret and malformed
JSON. Both desktop and inherited coordinator CI enforce the scanner.

The push also exposed stale default-branch dependency alerts. An audit of the PR
branch identified two critical and one moderate test-tool dependency entries.
Both workspace Vitest declarations were moved to exact `4.1.12`, using its
[official migration guide](https://github.com/vitest-dev/vitest/blob/v4.1.12/docs/guide/migration.md)
and the existing Node 24 environment. This removes the affected Tinypool chain
and upgrades the mocker. No test API changes were needed.

Local results after the upgrade: 44 shared and 787 desktop tests passed;
typechecks and production web build passed; root npm audit reported zero
vulnerabilities. The three focused scanner tests pass, and the full scan reports
zero unexpected findings with all controls passing. The coordinator dependency
audit was already clean. These changes concern test/CI tooling; the product
source remains the independently reviewed candidate, with native/live release
qualification still separate. Exact scanner exceptions do not grant public
publication authority.

The independent [Opus CI review](OPUS-CI-REVIEW-2026-11-12.md) found no blocking
issues. Its L2 wording correction is applied above: identical line moves within
the same file remain accepted. L1 (unused-entry notices), L3 (local tracked-file
enforcement) and L4 (additional validation test cases) are optional hardening;
the reviewer independently confirmed their current fail-closed behavior.
The existing product review remains distinct from this focused CI review.
