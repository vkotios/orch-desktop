import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormattedMarkdown } from "./FormattedMarkdown";

describe("FormattedMarkdown", () => {
  it("renders a closed fenced code block", () => {
    const html = renderToStaticMarkup(
      <FormattedMarkdown text={"before\n```ts\nconst x = 1\n```\nafter"} />,
    );
    expect(html).toContain("md-code-block");
    expect(html).toContain("const x = 1");
    expect(html).not.toContain("streaming");
  });

  it("renders an unfinished open fence as a streaming code block", () => {
    const html = renderToStaticMarkup(
      <FormattedMarkdown text={"intro\n```js\nfunction hi() {\n  return 1\n"} />,
    );
    expect(html).toContain("md-code-unfinished");
    expect(html).toContain("streaming");
    expect(html).toContain("function hi()");
    expect(html).not.toContain("```js");
  });

  it("renders repository-relative file references as buttons and blocks unsafe links", () => {
    const html = renderToStaticMarkup(
      <FormattedMarkdown
        text={"See `apps/desktop/src/App.tsx` and [docs](javascript:alert(1)) plus [safe](https://example.com)."}
        repoPath="C:/project"
      />,
    );
    expect(html).toContain("md-file-ref");
    expect(html).toContain("apps/desktop/src/App.tsx");
    expect(html).toContain("md-link-blocked");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:alert");
  });
});
