import { describe, expect, it } from "vitest";
import { historyAtCeiling, nextHistoryWindow } from "./history-window";

describe("history window", () => {
  it("continues beyond 500 turns and eventually reaches a disclosed ceiling", () => {
    let window = { ...nextHistoryWindow(), hasMore: true };
    expect(window.turnLimit).toBe(500);
    window = { ...nextHistoryWindow(window), hasMore: true };
    expect(window.turnLimit).toBe(1000);
    for (let i = 0; i < 10; i++) window = { ...nextHistoryWindow(window), hasMore: true };
    expect(historyAtCeiling(window)).toBe(true);
    expect(nextHistoryWindow(window)).toEqual({ maxEventPages: 10_000, turnLimit: 10_000 });
    expect(nextHistoryWindow().turnLimit).toBe(500);
  });
});
