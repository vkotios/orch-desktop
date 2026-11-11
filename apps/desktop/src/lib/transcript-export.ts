type ExportPayload = Record<string, unknown> & {
  conversation: Record<string, unknown> & { eventTip: number; messages: unknown[] };
  pagination?: { offset: number; nextOffset: number | null; totalMessages: number };
  truncation?: { turns?: boolean; events?: boolean; bytes?: boolean; metadata?: boolean };
  truncated?: boolean;
};

/** Assemble bounded RPC pages before creating the local download Blob. */
export async function collectTranscriptExport(fetchPage: (options: { messageOffset: number; expectedEventTip?: number }) => Promise<{ export: unknown }>) {
  let offset = 0, tip: number | undefined, result: ExportPayload | undefined;
  const messages: unknown[] = [];
  for (;;) {
    const page = (await fetchPage({ messageOffset: offset, expectedEventTip: tip })).export as ExportPayload;
    if (!page?.conversation || !Array.isArray(page.conversation.messages)) throw new Error("Invalid transcript export page");
    if (tip !== undefined && tip !== page.conversation.eventTip) throw new Error("Conversation changed during export");
    tip = page.conversation.eventTip;
    result ??= page;
    messages.push(...page.conversation.messages);
    const next = page.pagination?.nextOffset;
    if (next == null) break;
    if (!Number.isSafeInteger(next) || next <= offset || next !== messages.length) throw new Error("Export pagination did not advance");
    offset = next;
  }
  const truncation = { events: Boolean(result!.truncation?.events), turns: Boolean(result!.truncation?.turns), ...(result!.truncation?.metadata ? { metadata: true } : {}) };
  return { ...result!, conversation: { ...result!.conversation, messages, hasMoreBytes: false },
    pagination: undefined, truncation, truncated: truncation.events || truncation.turns || Boolean(truncation.metadata) };
}
