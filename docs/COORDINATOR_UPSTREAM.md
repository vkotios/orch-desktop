# Coordinator snapshot and update process

Updated 2026-11-11. CHO retains coordinator history and applies upstream changes
with three-way file merges, preserving desktop additions rather than replacing
the source tree. The snapshot is source provenance, not desktop qualification.

Imported from `coordinator-upstream` (`vkotios/cli-agentic-coordinator`):

- Main `8622b9df82468c4fbff448634eb9af39b8c97475`: macOS process evidence and
  POSIX handling, Muse sandbox opt-out, dependency updates and corresponding tests.
- Pushed orphan-run fixes `c0194c25ea122b09e0c4e31b856e9e6bd2329140` and
  `3111aa1c0280c5813f7af02e354167ae07e3179a`, from
  `fix/tolerate-orphan-run-folders`. These were not merged into upstream main
  when fetched. Old inert folders remain retained; ambiguous process trails refuse.
- Pushed MCP cache hints `457e8fb33286ad6f21d5b48efb22f0a0f471f5f2`, from
  `fix/mcp-list-caching-hints`. The equivalent protocol changes/tests already
  existed in CHO; comparison retained those changes and CHO's Grok registration.

Desktop-specific adapters, host admission, runtime staging, workflows and docs
remain in place. macOS coordinator source support does not expand the Windows
desktop support matrix. Muse sandbox defaults to enabled; no private configuration
or running controller was changed. The Grok example roster uses a placeholder
model. The transitive `@hono/node-server` lock entry was refreshed after npm audit
identified a fixable advisory in the imported lockfile.

For the next update: fetch the named upstream, record exact source SHAs, compare
against this snapshot, merge only applicable changes with their regression tests,
preserve desktop extensions, install each changed lockfile, and run affected
coordinator plus desktop checks. Restage the packaged runtime and rebuild native
artifacts after runtime-source changes. Never infer a merge, push, native
qualification or independent review from importing source.

Post-PR CI adaptation (2026-11-12): the shared release scanner now supports an
exact file/pattern/line-SHA-256 exception manifest. Thirty reviewed entries cover
synthetic test identifiers and retained audit provenance. Unknown or changed
content still fails, malformed policy fails a control, and secret-detection
positive controls remain mandatory. This is a desktop-specific addition, not an
upstream claim or public-release approval. Desktop CI now enforces the scan too.
