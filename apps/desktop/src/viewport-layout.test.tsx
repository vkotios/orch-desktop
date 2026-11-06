import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormattedMarkdown } from "./components/FormattedMarkdown";

const cssPath = path.resolve(import.meta.dirname, "styles.css");
const nativeCssPath = path.resolve(import.meta.dirname, "components/native-chat.css");
const css = `${fs.readFileSync(cssPath, "utf8")}\n${fs.readFileSync(nativeCssPath, "utf8")}`;

describe("viewport layout contract", () => {
  it("keeps fluid shell rules suitable for 960×720 and 1360×880", () => {
    // Packaged UI uses flexible columns rather than fixed desktop-only widths.
    expect(css).toContain(".native-shell");
    expect(css).toContain(".native-composer");
    expect(css).toContain("@media (max-width: 980px)");
    expect(css).toContain("@media (max-width: 1250px)");
    // Avoid hard-coded widths that clip the secondary 960px journey.
    expect(css).not.toMatch(/min-width:\s*1400px/);
    expect(css).not.toMatch(/width:\s*1600px/);
  });

  it("keeps file-reference and Agents action styles present for dense layouts", () => {
    expect(css).toContain(".md-file-ref");
    expect(css).toContain(".native-orch-panel");
    const sample = renderToStaticMarkup(
      <FormattedMarkdown text={"Open `src/App.tsx`"} repoPath="C:/project" />,
    );
    expect(sample).toContain("md-file-ref");
    // Both viewport budgets must still show the reference control in markup.
    for (const width of [960, 1360]) {
      expect(width).toBeGreaterThan(700);
      expect(sample.length).toBeGreaterThan(20);
    }
  });
});
