import type { NormalizedStreamEvent } from './index';

export interface ClaudeStreamContext {
  sessionId: string;
  userMessageId: string;
  messageId?: string;
  toolUseIds?: ReadonlySet<string>;
}

export interface ClaudeStreamEvent extends NormalizedStreamEvent {
  nativeSessionId: string;
  nativeUserMessageId: string;
  nativeMessageId?: string;
  nativeOutcome?: 'completed' | 'failed' | 'interrupted';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonempty(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function base(uiSessionId: string, ctx: ClaudeStreamContext): Omit<ClaudeStreamEvent, 'kind'> {
  return {
    harness: 'claude',
    sessionId: uiSessionId,
    nativeSessionId: ctx.sessionId,
    nativeUserMessageId: ctx.userMessageId,
  };
}

function checkCorrelation(raw: Record<string, unknown>, ctx: ClaudeStreamContext): boolean {
  if (raw.session_id !== ctx.sessionId) return false;
  if (raw.parent_tool_use_id != null) return false;
  const uuid = raw.user_message_uuid;
  const uuids = raw.user_message_uuids;
  if (uuid !== ctx.userMessageId) return false;
  if (!Array.isArray(uuids) || uuids.length !== 1 || uuids[0] !== ctx.userMessageId) return false;
  return true;
}

export function normalizeClaudeStreamEvent(
  uiSessionId: string,
  ctx: ClaudeStreamContext,
  raw: unknown,
): ClaudeStreamEvent[] {
  if (!nonempty(uiSessionId) || !nonempty(ctx.sessionId) || !nonempty(ctx.userMessageId)) return [];
  if (!isPlainObject(raw)) return [];

  const type = raw.type;

  if (type === 'stream_event') {
    if (!checkCorrelation(raw, ctx)) return [];
    const ev = raw.event;
    if (!isPlainObject(ev) || ev.type !== 'content_block_delta') return [];
    const delta = ev.delta;
    if (!isPlainObject(delta) || delta.type !== 'text_delta') return [];
    if (typeof delta.text !== 'string') return [];
    const out: ClaudeStreamEvent = { ...base(uiSessionId, ctx), kind: 'message_delta', text: delta.text };
    if (nonempty(ctx.messageId)) out.nativeMessageId = ctx.messageId;
    return [out];
  }

  if (type === 'assistant') {
    if (!checkCorrelation(raw, ctx)) return [];
    const msg = raw.message;
    if (!isPlainObject(msg) || !nonempty(msg.id)) return [];
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const results: ClaudeStreamEvent[] = [];
    for (const block of content) {
      if (!isPlainObject(block) || block.type !== 'tool_use') continue;
      if (!nonempty(block.id) || !nonempty(block.name)) continue;
      results.push({
        ...base(uiSessionId, ctx),
        kind: 'tool_call',
        toolCallId: block.id,
        toolTitle: block.name,
        toolStatus: 'inProgress',
        nativeMessageId: msg.id,
      });
    }
    return results;
  }

  if (type === 'user') {
    const uuid = raw.user_message_uuid;
    const uuids = raw.user_message_uuids;
    if (uuid !== undefined || uuids !== undefined) {
      if (uuid !== ctx.userMessageId) return [];
      if (!Array.isArray(uuids) || uuids.length !== 1 || uuids[0] !== ctx.userMessageId) return [];
    }
    if (raw.session_id !== ctx.sessionId) return [];
    if (raw.parent_tool_use_id != null) return [];
    const msg = raw.message;
    if (!isPlainObject(msg)) return [];
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const results: ClaudeStreamEvent[] = [];
    for (const block of content) {
      if (!isPlainObject(block) || block.type !== 'tool_result') continue;
      const tid = block.tool_use_id;
      if (!nonempty(tid)) continue;
      if (!ctx.toolUseIds || !ctx.toolUseIds.has(tid)) continue;
      let status: 'completed' | 'failed' | 'declined' = 'completed';
      if (block.is_error === true) {
        status = 'failed';
        const meta = raw.tool_result_meta;
        if (Array.isArray(meta) && meta.some((entry: unknown) => isPlainObject(entry) && entry.id === tid && entry.non_execution_kind === 'user-rejected')) {
          status = 'declined';
        }
      } else if (block.is_error !== undefined && block.is_error !== false) {
        continue;
      }
      results.push({ ...base(uiSessionId, ctx), kind: 'tool_result', toolCallId: tid, toolStatus: status });
    }
    return results;
  }

  if (type === 'result') {
    if (!checkCorrelation(raw, ctx)) return [];
    if (typeof raw.is_error !== 'boolean') return [];
    const reason = raw.terminal_reason;
    if (reason === 'aborted_streaming' || reason === 'aborted_tools') {
      return [{ ...base(uiSessionId, ctx), kind: 'status', text: 'turn interrupted', nativeOutcome: 'interrupted' }];
    }
    if (reason === 'completed' && raw.subtype === 'success' && raw.is_error === false) {
      return [{ ...base(uiSessionId, ctx), kind: 'turn_complete', nativeOutcome: 'completed' }];
    }
    if (raw.is_error === true) {
      let msg = 'Claude turn failed';
      const errs = raw.errors;
      if (Array.isArray(errs)) {
        const first = errs.find((e: unknown) => nonempty(e));
        if (nonempty(first)) msg = first;
      }
      if (msg === 'Claude turn failed' && nonempty(raw.result)) msg = raw.result;
      if (msg.length > 200) msg = msg.slice(0, 200);
      return [{ ...base(uiSessionId, ctx), kind: 'error', text: msg, nativeOutcome: 'failed' }];
    }
    return [];
  }

  return [];
}
