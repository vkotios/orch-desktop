import { describe, expect, it } from "vitest";
import { shouldSendOnComposerKey } from "./lib/composer-keyboard";

describe("composer keyboard", () => {
  it("sends on Enter without Shift and ignores IME composition", () => {
    expect(shouldSendOnComposerKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSendOnComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSendOnComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(
      shouldSendOnComposerKey({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: true },
      }),
    ).toBe(false);
    expect(shouldSendOnComposerKey({ key: "a", shiftKey: false })).toBe(false);
  });
});
