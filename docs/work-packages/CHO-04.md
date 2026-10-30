# CHO-04 — Controller capability spike and first transport slice

Updated: 2026-10-30. Status: partial; no session storage schema freeze yet.

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

The mapper is pure and stateless. It validates the fields it consumes, not the complete provider schema. It owns no process, RPC request, event cursor, approval or session storage. The installed application has not switched to this adapter yet. Rust and native-host source remain unchanged from their previous qualification.

## Next bounded slices

1. Qualify Claude's continuing-session, streamed-tool, approval, clarification and cancellation behavior in an owned native fixture. Keep saved subscription access and private credentials separate from public receipts.
2. Implement the Codex pipe peer and its native-thread/turn state transitions using fake streams first: bounded framing and pending requests, native activation, terminal outcomes, cancellation, server requests, stale/duplicate decisions and disconnected unknown outcomes.
3. Bind permission and clarification requests to the owned process generation, native request, thread and turn. Default to no execution on disconnect, restart or stale decisions; no automatic replay or persistent grants.
4. Integrate the first native streamed conversation through the bundled host and desktop transport, then complete installed-artifact M1 evidence. Keep CHO-03 native-reference storage contracts provisional until both controller spikes establish their actual requirements.

CHO-04 remains in progress. Native app integration, the second controller, clarification, durable recovery, UI rendering and installer/release acceptance are not completed by this slice.
