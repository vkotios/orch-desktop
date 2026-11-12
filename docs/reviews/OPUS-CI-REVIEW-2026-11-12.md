# Opus post-PR CI delta review (2026-11-12)

Reviewer: Claude Opus 5.5, medium effort, implementer-role report only.
Candidate: `3a618a769626160c42c6836b0b460e3141897d01`. Scope: only `d823260..3a618a7`.
This review covers the release-scan exception manifest, the workflow change and the
Vitest upgrade. It is not another product audit. The product source keeps its earlier
clean review at `d634157`.

## Recommendation

**Clean. No blocking findings.** The exception mechanism fails closed. All 30 entries are
synthetic or deliberate provenance. Exact content hashing does not hide other material,
and the Vitest 4.1.12 pin fits the existing toolchain. Four low-severity hardening items
and one release-qualification reminder follow. None needs to be fixed before merging this
CI delta.

## Scope reviewed

- `orch/tools/release-scan.mjs`: manifest loader, validation, matching and controls.
- `orch/tools/release-scan-expected.json`: all 30 entries, each matched against its current line.
- `orch/test/portable.test.mjs`: the new P6 test.
- `.github/workflows/desktop.yml`: `continue-on-error` removed. Also checked the existing
  coordinator scan steps in `.github/workflows/test.yml`.
- `apps/desktop/package.json`, `packages/acp-client/package.json`, `package-lock.json`: Vitest pin
  and resolved tree.
- `docs/COORDINATOR_UPSTREAM.md`, `docs/reviews/CI-FOLLOWUP-2026-11-12.md`: checked claims for accuracy.

## Scanner fail-closed behaviour

An exception applies only when file path, pattern name and SHA-256 of the full matched
line all match exactly. The line digest is computed after the existing `\r?\n` split, so
CRLF checkouts on Windows runners produce the same hash. The LICENSE positive control
and all 28 pattern self-tests run before the manifest is consulted and do not depend on it.
A manifest entry for LICENSE cannot satisfy the copyright control.

I verified the following in throwaway git repos under the system temp directory, using the
candidate scanner's exported `scan()`:

| Case | Unexpected hit kept | Manifest control |
|---|---|---|
| Exact entry (LF and CRLF) | no (accepted) | pass |
| Manifest absent | yes | pass (compatible) |
| Same line moved to another file | yes | pass |
| Second secret pattern appended to an excepted line | yes, both hits | pass |
| Whole line excepted for UUID only, line also holds a token | yes, token hit | pass |
| Entry names a different pattern | yes | pass |
| Unknown pattern / `__proto__` pattern | yes | **fail** |
| `null` entry, duplicate entry, version 2, BOM-prefixed JSON | yes | **fail** |
| Absolute path, `..` segment, backslash path | yes | **fail** |
| Upper-case hex digest, empty reason | yes | **fail** |

If the manifest is invalid, the loader discards every exception and the control fails
(exit 2). It never falls back to accepting partial content. A single bad entry reopens
all 30 hits. That is noisy but safe.

## Exception classifications (30)

I read every excepted line in place. Values are not reproduced here.

- **15 × uuid**, all in `apps/desktop/src/*.test.*`: hand-made patterns such as repeated
  digit or letter groups, plus one deliberately malformed uppercase negative case. None looks
  like a captured session or thread ID. Classification correct.
- **1 × assigned-secret** in `native-clarification.test.mjs`: an obviously synthetic
  leetspeak placeholder. The test uses it to show that private answers are not leaked.
  It is not a credential. Classification correct.
- **7 × dev-drive-path** in `CURRENT_HANDOFF.md` and two retained review documents: the
  local source-checkout path, described as provenance. It is not a secret. See R1.
- **7 × run-id** in the Opus evidence JSON, Opus adjudication and Sonnet review notes:
  orchestration correlation IDs, each next to its candidate commit. They are not credentials.
  See R1.

Hidden-material check: the scan reports 0 unexpected hits and all controls pass. Every
other pattern is matched separately and keyed by pattern name. So if an excepted line also
contained another secret class, that hit would appear as unexpected. The repro table above
confirms this.

## Dependency and config compatibility

- Both workspaces pin `vitest` exactly at `4.1.12`. The lockfile resolves one `vitest` and
  a matching `@vitest/*` set at 4.1.12. `tinypool`, `vite-node`, `tinyspy`, `strip-literal`,
  `loupe`, `deep-eql`, `check-error`, `pathval` and `cac` are removed.
- Vitest engines `^20 || ^22 || >=24` and peer `vite ^6 || ^7 || ^8` are compatible with the
  resolved `vite` 6.4.5 and with Node 24 in `desktop.yml`.
- Neither workspace has a Vitest config (`apps/desktop/vite.config.ts` has no `test` block).
  Options removed in Vitest 4, such as `poolOptions` and `workspace`, are therefore not in use.
  Coordinator CI uses its own `orch/package-lock.json` and is unaffected.

## Low-severity findings (non-blocking)

**L1. Unused manifest entries are silent.** An entry whose file or line no longer exists
passes without notice, so stale entries can accumulate. The risk is small because a stale
entry can only re-admit that exact line. Suggested fix: emit an `UNUSED` line per entry
with no match, or fail a control on it. Then removed or edited content also forces the
manifest to be cleaned up.

**L2. The key has no line number.** An identical copy of an excepted line in the same file
is also accepted. The content is byte-identical and already reviewed, so this is harmless.
However, the follow-up doc says "Editing/moving a line makes it unexpected again". That is
true across files but not for moves or copies within the same file. Suggest rewording,
not changing the code.

**L3. The manifest is read from disk whether or not git tracks it.** Locally, a git-ignored
or untracked manifest is honoured (verified). Hosted CI checks out tracked content only and
is not affected. For release qualification, confirm that the manifest is a tracked file at
the candidate commit (it is at `3a618a7`). Optionally, check this with `git ls-files`.

**L4. Validation branches lack regression tests.** P6 covers acceptance, a changed line,
a new secret and malformed JSON. It does not cover unknown or `__proto__` patterns, unsafe
paths, duplicates or bad digests. The repros above show that these all behave correctly.
Adding one table-driven case to `portable.test.mjs` would lock that in.

**R1. Release-qualification reminder (not a CI defect).** The `dev-drive-path` and `run-id`
patterns exist to keep a local machine path and orchestration IDs out of a public tree.
The 14 entries accept these for CI only. The existing docs say the manifest grants no
publication authority. Public release qualification should decide separately whether to
keep or redact them. Manifest edits can also accept secret-class patterns, so changes to
`release-scan-expected.json` should get explicit reviewer sign-off.

## Assessment

The delta preserves meaningful scanning. Desktop CI now enforces the scan (previously
advisory). The coordinator jobs in `test.yml` already enforced it. Detection now depends
on exact reviewed content rather than on directory or wildcard skips. All positive controls
are still mandatory, and manifest tampering or corruption fails closed.

## Checks run (local, at the candidate)

- `node orch/tools/release-scan.mjs`: 406 files, 28 patterns, 31 expected (30 manifest + LICENSE),
  0 unexpected, all controls hit, exit 0.
- `node --test --test-name-pattern='P6:' orch/test/portable.test.mjs`: 3 passed, 0 failed.
- Temp-repo repros of the cases in the table above, plus a separate backslash-path repro.
  Cleaned up after running.
- Static reading of the lockfile, workspace manifests and workflows.

## Limits

- I did not run the Vitest suites, typecheck, build or `npm audit` in this review. This worktree
  has no installed dependencies, and the audit needs the live registry. The figures of 44 shared
  and 787 desktop tests and 0 audit findings are the author's local results, not reproduced here.
- These are local checks only. Hosted CI results for this commit on Linux and Windows runners
  are a separate, future record. This review does not claim they pass.
- This is not a source or public-release qualification and not a native or live-provider
  qualification.
