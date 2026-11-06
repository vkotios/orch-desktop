# Changelog

## Unreleased (v0.1 candidate)

### Added
- Durable session recovery repairs (close/`unknown`, stranded turns, UTF-8 body decode, draft CAS).
- Host-admitted orch delegation with association intent stages, adopt/abandon uncertain, read-only Diff drawer.
- Explicit Git Integrate (Accept-gated merge with dry-run preview and branch/dirty/stage rechecks).
- Maintained Markdown (`react-markdown` + GFM) with safe links and repository-relative file references.
- Session store backup→migrate→verify path (schema v1→v2) with restore-on-failure.
- Conversation search/export/import host APIs; approval and clarification durable journals + historical hydrate projection.
- Codex `thread/resume` `excludeTurns` (installed 0.156.1 schema evidence).
- Restrictive Tauri CSP, NOTICE, support/privacy/security/CONTRIBUTING docs, Windows native CI job, advisory release-scan.

### Known limits
- Clean-machine installer AC and live CLI qualification remain owner-blocked.
- Independent review through orch remains pending reviewer availability.
- Owner-display 125/150% scaling screenshots and live WebView2 keyboard capture remain open.
