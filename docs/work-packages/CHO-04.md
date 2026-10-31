# CHO-04 — Controller capability spike and first transport slice

Updated: 2026-10-31. Status: first native Codex debug conversation implemented and verified, including the rendered window. The second controller remains open. No session storage schema freeze yet.

Authority: [implementation plan](../IMPLEMENTATION_PLAN.md), [product specification](../PRODUCT_SPEC.md). The bundled host foundation is recorded in [CHO-02](CHO-02.md).

## Observed native capabilities

The controller tested the installed Codex app-server protocol in an owned Windows fixture using its saved ChatGPT sign-in. No pre-existing user conversation was resumed or changed. The fixture conversation was archived afterward; every owned server process exited. These are product-protocol checks, separate from coding workers dispatched through orch.

| Capability | Codex CLI 0.156.1 | Claude Code 2.1.282 |
| --- | --- | --- |
| Native transport | Stdio initialize/initialized handshake observed | Input/output stream-json options present; native flow not yet tested |
| Native identity | Actual thread and turn IDs returned | Session-ID/resume options present; flow not yet tested |
| Streamed text | Actual agent-message deltas observed | Documentation/CLI evidence only |
| Continuing turns | Two turns retained a fixture marker | Not yet tested |
| Resume in a new process | Same native thread retained the marker without transcript replay | Not yet tested |
| Tool lifecycle | Owned fixture-file read produced start, successful result and content | Not yet tested |
| Approval allow | Exact reviewed fixture-read command accepted once, without a persistent rule | Not yet tested |
| Approval reject | Declined/cancelled tool observed; proposed fixture write did not occur | Not yet tested |
| Cancellation | Interrupted native turn observed after native start | Not yet tested |
| Continue after cancellation | Original marker retained in the next turn | Not yet tested |
| Clarification | Installed experimental schema exists; live flow not qualified | Not yet tested |
| Model attribution | Requested/native-selected gpt-6-sol; independently served identity unknown | Not qualified by this spike |

The installed Codex model catalogue was queried rather than copied from the prototype. It does not establish access to every hard-coded or documented model. The app must retain the distinction between a requested/selected model and verified served identity.

## Findings that affect the implementation

Codex request acknowledgement is separate from native turn activation and completion. The first interruption probe raced an acknowledged new turn against cleanup of the preceding turn. Waiting for the matching native turn/started event before turn/interrupt passed. A cancelled approval returned an interrupted turn and a declined command item; neither is success. Keep actual identities and terminal outcomes throughout the transport.

The owned read required a native permission decision under the tested untrusted policy. The client accepted only the exact reviewed fixture command once; all other requests were rejected. No persistent approval amendment was written. This qualifies the tested round trips, not a general product authorization policy.

The retained initial probe receipts include their failed assertions and the acknowledgement/activation race. The later checks extend that evidence; they do not rewrite it as an uninterrupted pass. Production event ordering, pending-request reconciliation, stale approval rejection and unknown outcomes still need deterministic peer tests.

Official protocol references: [Codex app-server](https://developers.openai.com/codex/app-server), [Claude programmatic CLI](https://code.claude.com/docs/en/headless), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installed schema/CLI evidence takes precedence when newer documentation differs. Claude's programmatic control and saved-login behavior need their own owned native checks; another harness's results do not qualify it.

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

1. Qualify Claude's continuing-session, streamed-tool, approval, clarification and cancellation behavior in an owned native fixture. Keep saved subscription access and private credentials separate from public receipts.
2. Complete installed-artifact M1 evidence. The built debug view's text/continuation/Stop acceptance passes; keep debug, installed and clean-machine claims separate.
3. Qualify live clarification and deliberately supported permission extensions. The current preview interrupts unsupported requests; do not add automatic replay or persistent grants.
4. Keep CHO-03 native-reference storage contracts provisional until both controller spikes establish their actual requirements. Add durable conversation and recovery behavior through its own reviewed slice.

CHO-04 remains in progress. The native Codex implementation and focused rendered conversation check do not complete the second controller, clarification, durable recovery, broader UI polish or installer/release acceptance.
