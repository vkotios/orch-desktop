# Native acceptance probe

Owned, opt-in live probe for one native conversation that survives a host
restart: validate/trust/prepare a project, run a benign no-tools marker
turn, save a draft, stop/close the host, reopen with the same database and a
fresh generation, then list/hydrate the conversation and draft and continue
the native session without re-supplying the marker.

Requires Node 24 (the probe imports the product TypeScript reducer using native type stripping).

## Invocation

Default (no flags) refuses provider execution and starts nothing:

```sh
node apps/desktop/scripts/native-acceptance.mjs
# refused: live provider execution requires explicit --allow-live ... (exit 2)
```

Explicit live run only (controller reviews, then runs where authorized and
available):

```sh
node apps/desktop/scripts/native-acceptance.mjs --allow-live \
  --controller codex --model <exact-catalogue-id> \
  --output <fresh-private-receipt-path> [--deadline-ms 120000]
```

The implementer does not run the live probe: no live Codex/Claude execution
happens in this worktree without controller review and authorization.

## Exact supported behavior

- Real product host only: the probe drives `apps/desktop/server/host.mjs`
  over piped v1 NDJSON frames (same contract as
  `apps/desktop/src/opus-regressions.test.mjs` OPUS-04/05). Only the host
  starts native clients; a coding worker CLI is never launched directly.
- Isolated fixture: a fresh temporary Git project, SQLite database, and
  liveness state under `os.tmpdir()`. Never the user's default app database
  (`~/.cho-desktop/sessions.sqlite3`), saved projects, or unrelated native
  sessions. No arbitrary project path is accepted: the probe owns its fixture.
- Catalogue gate: the requested `--model` must be present in the catalogue
  returned by `native_chat_prepare_project`. Absence fails the receipt as
  `MODEL_ABSENT` with the catalogue recorded. No fallback, ever. Turns send
  role `review` (the no-tools role on both controllers) with an effort taken
  from the catalogue entry's `supportedEfforts` (Codex default `low`); an
  entry with no probe-usable effort fails the same way an absent model does.
- Marker discipline: turn 1 asks for an exact single-line marker echo with no
  tools; turn 2 asks for the marker from the previous reply without
  supplying it again. Any approval event fails honestly (`APPROVAL_BLOCKED`)
  and any observed `tool_call`/`tool_result`/`clarification` event fails honestly as
  `TOOL_USED` (a read tool needs no approval, so tool use is rejected
  independently of approvals); the probe never auto-decides.
- Identity: the native identity (`nativeThreadId`, or Claude
  `nativeSessionUuid`) recorded before restart must equal the identities after
  reopen and after continuation. No `native_chat_acknowledge_stranded`,
  draft-conflict resolution, or ownership/fence clearing is ever sent.
- Hydrated content: after restart the hydrated messages must hold exactly one
  turn (user prompt plus one assistant echo, marker once in each); after
  continuation they must hold both turns (marker once in user text, twice in
  assistant text). Live poll text alone cannot prove this, so a mismatch
  fails the receipt as `HYDRATE_MISMATCH`.
- Pass requires: completed terminal outcomes for both turns with no tool
  use on either turn, marker present
  in turn 1, draft round-trip equal, conversation listed after restart,
  identity preserved twice, exactly one marker occurrence in the
  continuation reply, correct hydrated turn counts/content, and clean owned
  closes (service-level `native_chat_close` plus host shutdown).
- Close gating: an owned close failure or uncertainty (returned
  `closedCleanly: false` or a thrown close) prevents `pass`, is recorded on
  its case, and fails the receipt as `CLOSE_UNCLEAN` (pre-restart closings
  use the same reason). The fixture location (`fixtureRoot`, `databasePath`)
  is recorded and cleanup is skipped so uncertain state is retained, not
  deleted. No forced process kill happens on unproven identity.
- Bounded: every host request and each poll-to-terminal loop is bounded by
  `--deadline-ms` (default 120000, range 5000–600000). Early-fail paths still
  attempt cleanup; their outcomes are appended as `host-close-finally` cases
  on the (already failing) receipt. A failed (`closedCleanly: false`) or
  throwing finally close retains the fixture instead of deleting it
  (`retainFixture: true` with the exact `fixtureRoot`/`databasePath`).
- Receipt: JSON written with mode `0600` to a fresh path (existing files are
  refused, never overwritten). Records tool version, runtime context, probe
  source (owning-tree commit/dirty status plus probe digest, `unknown` when
  unavailable — never invented), case list, catalogue basis, and failure
  reasons — never secrets or raw credentials. Keep receipts in a private
  directory (outside the repo) and do not commit them. The probe does not
  sign, install, publish, or release.

## Limits

- Live paths are untested by the implementer: deterministic tests in
  `apps/desktop/src/native-acceptance.test.mjs` inject a fixture host seam
  and prove orchestration only (refusal, catalogue gate, bounds, fixture
  ownership, two-generation flow, honest failure). One test additionally
  drives the two-generation flow through the REAL host/service with an
  injected deterministic Codex peer (`openClient` passthrough: same NDJSON
  framing, same SQLite durable store, zero provider starts), which also
  exercises the hydrated-content checks against real persistence. Neither
  proves live acceptance.
- Poll replay mirrors the UI: the poll loop passes the returned cursor on
  every `native_chat_poll` and rebuilds reply text through the pure UI
  reducer (`createNativeUiSession`/`beginNativeTurn`/`applyNativeUiEvent`
  from `apps/desktop/src/lib/native-chat-state.ts`), so stable `partId`
  dedupe plus ordered durable `seq` keeps live/durable replays exactly-once
  with delayed-middle-part ordering. A dedicated multi-poll test covers a
  live delta, an empty-live batch replaying the same durable part, a later
  terminal, a repeated part appearing once, and a genuinely new part
  remaining. Entrypoint identity uses `fileURLToPath` (percent-decoding),
  covered by real `--help`/refusal subprocesses from a spaced temp layout.
- A `fail` receipt on a live run means the scenario did not verify — for
  example the model ignored the no-tools instruction, which the receipt
  records (`MARKER_NOT_ECHOED`, `MARKER_NOT_REPLAYED`, or
  `MARKER_REPLAYED_MULTIPLE_TIMES`) instead of passing.
- Process termination is limited to owned processes: the short-lived fixture
  `git init` and host-spawned clients closed via `native_chat_close` plus host
  shutdown. Anything uncertain is recorded, not forced.
- If the probe surface exposes what looks like a production recovery bug
  (for example stale ownership accepted after restart), report the exact file,
  line, and reproducible trigger instead of changing host sources: host
  sources are outside this slice's scope.
