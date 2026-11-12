export interface HistoryWindow {
  maxEventPages: number;
  turnLimit: number;
  hasMore: boolean;
  byteCeiling?: boolean;
  beforeTurnSeq?: number;
  beforeImportedIndex?: number;
}

export function nextHistoryWindow(previous?: HistoryWindow) {
  if (previous?.beforeTurnSeq || previous?.beforeImportedIndex) {
    return { maxEventPages: 10_000, turnLimit: 100,
      ...(previous.beforeTurnSeq ? { beforeTurnSeq: previous.beforeTurnSeq } : {}),
      ...(previous.beforeImportedIndex ? { beforeImportedIndex: previous.beforeImportedIndex } : {}) };
  }
  return {
    maxEventPages: Math.min(10_000, Math.max(512, (previous?.maxEventPages ?? 64) * 2)),
    turnLimit: Math.min(10_000, Math.max(500, (previous?.turnLimit ?? 100) * 2)),
  };
}

export function historyAtCeiling(previous?: HistoryWindow) {
  if (previous?.beforeTurnSeq || previous?.beforeImportedIndex) return false;
  return previous?.byteCeiling === true || (previous?.maxEventPages === 10_000 && previous.turnLimit === 10_000);
}

export function mergeHistoryMessages<T extends { id: string; imported?: boolean; importIndex?: number }>(older: T[], current: T[]) {
  const merged = [...new Map([...older, ...current].map((message) => [message.id, message])).values()];
  return [...merged.filter((m) => m.imported).sort((a, b) => (a.importIndex ?? 0) - (b.importIndex ?? 0)), ...merged.filter((m) => !m.imported)];
}
