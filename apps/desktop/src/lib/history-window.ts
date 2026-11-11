export interface HistoryWindow {
  maxEventPages: number;
  turnLimit: number;
  hasMore: boolean;
  byteCeiling?: boolean;
}

export function nextHistoryWindow(previous?: HistoryWindow) {
  return {
    maxEventPages: Math.min(10_000, Math.max(512, (previous?.maxEventPages ?? 64) * 2)),
    turnLimit: Math.min(10_000, Math.max(500, (previous?.turnLimit ?? 100) * 2)),
  };
}

export function historyAtCeiling(previous?: HistoryWindow) {
  return previous?.byteCeiling === true || (previous?.maxEventPages === 10_000 && previous.turnLimit === 10_000);
}
