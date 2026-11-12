import { describe, expect, it } from "vitest";
import { historyAtCeiling, nextHistoryWindow, mergeHistoryMessages } from "./history-window";

describe("history window", () => {
  it("loads an older byte-limited page and keeps imported prefixes before native history", () => {
    const history = { maxEventPages: 64, turnLimit: 100, hasMore: true, byteCeiling: true, beforeTurnSeq: 39 };
    expect(historyAtCeiling(history)).toBe(false);
    expect(nextHistoryWindow(history).beforeTurnSeq).toBe(39);
    const imported = { id: "import", imported: true, importIndex: 0 };
    expect(mergeHistoryMessages([imported, { id: "older" }], [imported, { id: "recent" }]).map((m) => m.id)).toEqual(["import", "older", "recent"]);
  });
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
