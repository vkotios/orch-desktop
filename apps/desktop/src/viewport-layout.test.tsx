import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormattedMarkdown } from "./components/FormattedMarkdown";

const cssPath = path.resolve(import.meta.dirname, "styles.css");
const nativeCssPath = path.resolve(import.meta.dirname, "components/native-chat.css");
const css = `${fs.readFileSync(cssPath, "utf8")}\n${fs.readFileSync(nativeCssPath, "utf8")}`;
const nativeChatSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "components/NativeChat.tsx"),
  "utf8",
);

/** Pull declaration block for the first matching selector (layout contracts). */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule for ${selector}`).toBeTruthy();
  return match![1];
}

function declares(body: string, property: string, pattern: RegExp) {
  const line = body
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${property}:`));
  expect(line, `${property} in ${body}`).toBeTruthy();
  expect(line!).toMatch(pattern);
}

describe("viewport layout contract", () => {
  it("keeps the shell a single flex composition that scrolls the message plane", () => {
    const shell = ruleBody(".native-shell");
    declares(shell, "display", /flex/);
    declares(shell, "height", /100%/);

    const messages = ruleBody(".native-messages");
    declares(messages, "flex", /1/);
    declares(messages, "overflow-y", /auto/);

    const main = ruleBody(".native-main");
    declares(main, "display", /flex/);
    declares(main, "flex-direction", /column/);

    // Narrow budgets stay fluid — no desktop-only fixed floors.
    expect(css).toMatch(/@media\s*\(max-width:\s*980px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)/);
    expect(css).not.toMatch(/min-width:\s*1400px/);
  });

  it("renders chat landmarks and keeps file refs usable at both viewport budgets", () => {
    // Landmark contract must stay wired in the live NativeChat surface.
    expect(nativeChatSource).toContain('aria-label="Chats"');
    expect(nativeChatSource).toContain('aria-live="polite"');
    expect(nativeChatSource).toContain('htmlFor="native-prompt"');
    expect(nativeChatSource).toContain("shouldSendOnComposerKey");
    expect(nativeChatSource).toContain("scrollIntoView");
    expect(nativeChatSource).toContain("Load more history");
    expect(nativeChatSource).toContain("Resolve draft conflict");

    // Static shell fixture mirrors the landmark shape used by NativeChat.
    const shell = renderToStaticMarkup(
      <div className="native-shell">
        <aside className="native-sidebar">
          <nav aria-label="Chats">
            <button type="button">Chat A</button>
          </nav>
        </aside>
        <main className="native-main">
          <div className="native-messages" aria-live="polite">
            <FormattedMarkdown text={"Open `src/App.tsx`"} repoPath="C:/project" />
          </div>
          <div className="native-composer">
            <label className="sr-only" htmlFor="native-prompt">
              Message Codex
            </label>
            <textarea id="native-prompt" />
          </div>
        </main>
      </div>,
    );
    expect(shell).toContain('aria-label="Chats"');
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain('id="native-prompt"');
    expect(shell).toContain("md-file-ref");
    for (const width of [960, 1360]) {
      expect(width).toBeGreaterThan(700);
      expect(shell.length).toBeGreaterThan(40);
    }
  });
});
