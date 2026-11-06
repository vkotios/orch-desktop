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
});
