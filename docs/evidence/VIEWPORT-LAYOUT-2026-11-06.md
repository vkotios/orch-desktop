# Viewport / layout evidence (automated) — 2026-11-06 (updated 2026-11-08)

Europe/London. Candidate includes maintained Markdown, Agents panel actions,
composer keyboard helper, and landmark/flex scroll contracts.

## What this covers

Automated layout-contract assertions for the primary CHO desktop surfaces at the
spec sizes **1360×880** and **960×720**. Checks now parse CSS declaration
blocks for `.native-shell` / `.native-main` / `.native-messages` (flex column +
`overflow-y: auto` message plane), assert NativeChat landmark wiring
(`aria-label="Chats"`, `aria-live`, composer label/`shouldSendOnComposerKey`,
`scrollIntoView`, Load more / draft conflict actions), and exercise the pure
composer Enter helper. These are **not** a substitute for owner-display
scaling evidence at 125%/150% or live WebView2 focus capture.

## Automated checks

- `apps/desktop/src/viewport-layout.test.tsx` — CSS property contracts + landmarks
- `apps/desktop/src/composer-keyboard.test.ts` — Enter / Shift+Enter / IME

## Still externally blocked / unfinished for AC-12

- Rendered native window screenshots at 100/125/150% Windows scaling on the
  owner display.
- Keyboard focus-order capture inside a live WebView2 window.
