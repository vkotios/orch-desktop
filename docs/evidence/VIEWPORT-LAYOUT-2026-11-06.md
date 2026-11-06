# Viewport / layout evidence (automated) — 2026-11-06

Europe/London. Candidate includes maintained Markdown and Agents panel actions.

## What this covers

Automated static-layout assertions for the primary CHO desktop surfaces at the
spec sizes **1360×880** and **960×720**. These checks prove that the composer
region, message list, and Agents entry control remain present in the DOM layout
contract used by the packaged UI CSS — they are **not** a substitute for
owner-display scaling evidence at 125%/150%.

## Automated check

- File: `apps/desktop/src/viewport-layout.test.tsx`
- Asserts CSS custom layout contract markers and presence of primary controls
  for both viewport width classes.

## Still externally blocked / unfinished for AC-12

- Rendered native window screenshots at 100/125/150% Windows scaling on the
  owner display.
- Keyboard focus-order capture inside a live WebView2 window.
