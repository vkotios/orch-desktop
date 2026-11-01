# CHO-04 — Controller capability spike and first transport slice

Updated: 2026-11-01. Status: the first native Codex conversation is integrated and rendered-verified. A separate Claude candidate includes native folder browsing and passes runtime checks and packaging; rendered acceptance and main-branch integration remain pending. No session storage schema freeze yet.

Authority: [implementation plan](../IMPLEMENTATION_PLAN.md), [product specification](../PRODUCT_SPEC.md). The bundled host foundation is recorded in [CHO-02](CHO-02.md).

## Observed native capabilities

The controller tested the installed Codex app-server protocol in an owned Windows fixture using its saved ChatGPT sign-in. No pre-existing user conversation was resumed or changed. The fixture conversation was archived afterward; every owned server process exited. These are product-protocol checks, separate from coding workers dispatched through orch.

| Capability | Codex CLI 0.156.1 | Claude Code 2.1.282 |
| --- | --- | --- |
| Native transport | Stdio initialize/initialized handshake observed | Bidirectional stream-json initialize and control requests observed |
| Native identity | Actual thread and turn IDs returned | Owned native session UUID, echoed input UUID and actual assistant/tool IDs; no Codex aliases |
| Streamed text | Actual agent-message deltas observed | Real text deltas mapped through the candidate and copied bundle |
| Continuing turns | Two turns retained a fixture marker | Two turns retained a fixture marker without transcript replay |
| Resume in a new process | Same native thread retained the marker without transcript replay | Owned native session retained the marker under a new process |
| Tool lifecycle | Owned fixture-file read produced start, successful result and content | Fixture Read produced actual tool ID, result and streamed file content |
| Approval allow | Exact reviewed fixture-read command accepted once, without a persistent rule | Exact original Read input allowed once; no persistent permission amendment |
| Approval reject | Declined/cancelled tool observed; proposed fixture write did not occur | Write denied, tool declined and turn interrupted; no file created |
| Cancellation | Interrupted native turn observed after native start | Interrupt control acknowledged, then actual aborted-streaming result observed |
| Continue after cancellation | Original marker retained in the next turn | Original marker retained after both denial and Stop |
| Clarification | Installed experimental schema exists; live flow not qualified | Not yet tested |
| Model attribution | Requested/native-selected gpt-6-sol; independently served identity unknown | Live native catalogue queried; model-reported identity retained separately from independent verification |

The installed Codex model catalogue was queried rather than copied from the prototype. It does not establish access to every hard-coded or documented model. The app must retain the distinction between a requested/selected model and verified served identity.

## Findings that affect the implementation

Codex request acknowledgement is separate from native turn activation and completion. The first interruption probe raced an acknowledged new turn against cleanup of the preceding turn. Waiting for the matching native turn/started event before turn/interrupt passed. A cancelled approval returned an interrupted turn and a declined command item; neither is success. Keep actual identities and terminal outcomes throughout the transport.

The owned read required a native permission decision under the tested untrusted policy. The client accepted only the exact reviewed fixture command once; all other requests were rejected. No persistent approval amendment was written. This qualifies the tested round trips, not a general product authorization policy.

The retained initial probe receipts include their failed assertions and the acknowledgement/activation race. The later checks extend that evidence; they do not rewrite it as an uninterrupted pass. Production event ordering, pending-request reconciliation, stale approval rejection and unknown outcomes still need deterministic peer tests.

Official protocol references: [Codex app-server](https://developers.openai.com/codex/app-server), [Claude programmatic CLI](https://code.claude.com/docs/en/headless), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installed schema/CLI evidence takes precedence when newer documentation differs. The Claude checks below use its own installed native process and saved first-party sign-in.

## First implemented adapter

Integrated source: `d59a451`.

The shared package now exports normalizeCodexAppServerEvent alongside its unchanged legacy exec normalizer. The new mapper uses actual native thread/turn/item identities and rejects mismatched or malformed consumed fields and RPC frames carrying request IDs. It maps streamed text and command/file tool lifecycle, including declined results. It emits turn_complete only for completed native turns; failed and interrupted outcomes remain distinct. Final full-message notifications do not replay already-streamed text. Raw provider objects and fabricated model verification are excluded.

Verification: 108 package tests (23 shared, 85 desktop), root typecheck and web build pass. Captured native notifications replayed through the candidate preserve 60 text deltas, two declined command results and two interrupted turns. Different-model review and controller verification confirmed the compatibility correction against both generated schemas and an actual native declined event.

The mapper is pure and stateless. It validates the fields it consumes, not the complete provider schema. It owns no process, RPC request, event cursor, approval or session storage. The following native conversation slice uses it through an owned service and bounded event mailbox.

## First native Codex conversation

Source checkpoint: `d6814d3`, Windows x64 debug artifact. Explicit project validation and trust precede opening the installed Codex app-server with saved ChatGPT access and its actual model catalogue. The graphite native view supports in-memory chats, streamed text, tool status, offered once-only permission decisions and Stop. It preserves actual thread/turn identity without sending the transcript again. Unsupported clarification requests interrupt the turn with a visible error; Claude and coordinator mutations are not exposed as working native features.

The private native pipe has bounded framing, request queues and event delivery. Turn acknowledgement remains separate from activation and completion. Stale connection callbacks and stale approval decisions cannot grant access. One provider turn runs at a time. A missing polling consumer expires its lease after 30 seconds and stops the owned producer. Rust owns the host and descendants in a Windows Job Object; an idle watchdog also handles host exit without requiring another frontend call.

Controller verification passes 224 package tests (23 shared, 201 desktop), type checking, web build, 12 locked Rust tests and the locked native debug build. The Rust suite includes the actual production runtime watcher with an owned heartbeat descendant, rather than a mirrored cleanup implementation. A controller-reproduced queued-grant race was corrected: once-only approval identity remains tracked until its response settles, allowing terminal, withdrawn-request and cancellation events to retire an unwritten response. Real peer/service regressions cover those races, duplicate decisions and legal native request-ID reuse. The copied debug artifact starts outside the checkout without global Node and with poisoned Node environment variables, then exits with its owned host gone; its executable and all runtime sidecars are hashed.

Actual final staged runtime checks pass an exact fixture-file read accepted once, successful mapped tool result, cancelled write with a declined result and no created file, explicit interruption and same-thread continuation retaining the read marker. The owned thread was archived and client closed. Requested model was gpt-6-sol at low effort; independently served identity remains unknown. These live checks supplement deterministic permission, lifecycle, queue and frontend-state regressions.

The built Windows view also passes actual rendered acceptance after the owner manually trusted the synthetic project. The first turn and a continuation completed with the same marker without repeating it in the second prompt. A bounded long response visibly streamed formatted text and code; Stop showed a pending state followed by the native interrupted outcome. A subsequent turn completed with the original marker, confirming the chat remained usable. UI model was gpt-6-sol, medium effort; access was left at the owner's trusted selection. Permission round trips remain independently verified by the actual packaged runtime fixtures, not by automated clicks on security prompts. This is a debug preview, not an installed release or a clean-machine qualification.

## Next bounded slices

1. Complete rendered Claude conversation/continuation/Stop acceptance for the built candidate before local integration. Windows automation currently reports input access denied; project trust requires the owner's manual action.
2. Complete installed-artifact M1 evidence. The built debug view's text/continuation/Stop acceptance passes; keep debug, installed and clean-machine claims separate.
3. Qualify live clarification and deliberately supported permission extensions. The current preview interrupts unsupported requests; do not add automatic replay or persistent grants.
4. Keep CHO-03 native-reference storage contracts provisional until both controller spikes establish their actual requirements. Add durable conversation and recovery behavior through its own reviewed slice.

CHO-04 remains in progress. The native Codex implementation and focused rendered conversation check do not complete the second controller, clarification, durable recovery, broader UI polish or installer/release acceptance.

## Claude native candidate

Current source candidate: `c47437a`, extending the Claude runtime checkpoint `d07df86` and retained separately from the integrated Codex checkpoint. The project screen selects Codex or Claude before validation and explicit trust. Claude preparation checks saved `claude.ai`/first-party authentication, obtains its live catalogue without starting a turn and closes that metadata process before admitting a project. Conversations open lazily, pin their model, role and supported effort, and keep actual native session and input identities. Codex retains its existing per-turn effort control.

The project screen now also offers Browse, backed by a native folder-selection dialog. Selection fills the exact path; cancellation preserves the existing path and error. Typed paths remain supported. Browsing does not validate or trust a project automatically. The directory chooser uses the official Rust dialog plugin without adding a browser/Node bridge route or JavaScript filesystem permissions. The updated candidate passes the same 291 package tests, type/web/native builds, 12 Rust tests and copied-bundle startup/cleanup check. Its bundled Node/runtime modules are byte-identical to the earlier six-case Claude and two-turn Codex runtime fixtures; only the application executable changed. Actual rendered selection/cancellation still needs desktop access, so it is not recorded as passed.

The Claude actor uses the shared project trust, host ownership and bounded mailbox. A wire write is submission, not native activation or completion. Stream continuations require an observed message anchor; post-tool continuation has a one-use causal allowance from a previously unseen, known active tool result on the same connection. Any supplied input-UUID fields must match exactly. Permission requests bind the actual tool ID, name and original input before appearing in the UI. Cancellation, native withdrawal and terminal events retire queued, unwritten grants. Replayed native permission responses are informational; they cannot settle an unrelated RPC request or grant access again. Persistent grants, user customizations, hooks, external MCP services and delegation are disabled for this path. Review mode limits the exposed tools and is not an OS sandbox.

Controller verification passes 291 package tests, type checking, web/native debug builds and 12 locked Rust tests. Six actual Claude service cases pass both in the checkout and using the copied bundle's Node/runtime outside the checkout: first turn, marker continuation, approved Read with streamed file content, denied Write without a created file, Stop and continuation after Stop. The copied 94-file debug bundle also passes Rust-owned startup/cleanup with global Node absent and poisoned Node environment variables. Captured traffic and counterexamples drove corrections for missing continuation UUID fields, permission-response echoes and overlapping stream starts; fake-peer tests cover those boundaries.

This candidate has not passed a rendered Claude window check or been merged into the integration branch. Native clarification, durable recovery, installed release and clean-machine qualification remain open. Requested/native-reported model identity is not independently verified served identity. Owned native fixture sessions and private receipts remain local; no credentials or user conversations are published.
