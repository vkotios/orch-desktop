export type JsonRpcId = string | number;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcEnvelope =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

/**
 * Supported native CLI harnesses in CHO-desktop (Direct Multi-Harness Chat + orch Coordinator).
 */
export type HarnessId =
  | "claude"
  | "codex"
  | "grok"
  | "muse"
  | "copilot"
  | "vibe"
  | "opencode"
  | "agy"
  | "aider";

export type HarnessTransportKind =
  | "acp-stdio"
  | "claude-stream-json"
  | "codex-jsonl"
  | "muse-msp-jsonl"
  | "copilot-jsonl"
  | "vibe-print"
  | "opencode-json"
  | "agy-print"
  | "aider-message";

export interface NormalizedStreamEvent {
  harness: HarnessId;
  sessionId: string;
  kind:
    | "message_delta"
    | "thought_delta"
    | "tool_call"
    | "tool_result"
    | "permission_request"
    | "model_verified"
    | "turn_complete"
    | "error"
    | "status";
  text?: string;
  model?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolStatus?: string;
  raw?: unknown;
}

/**
 * Encode a JSON-RPC message as a single newline-delimited JSON frame (ACP stdio framing).
 * Embedded CR/LF characters are rejected so transport framing can never split a message.
 */
export function encodeNdjsonFrame(message: JsonRpcEnvelope): string {
  const serialized = JSON.stringify(message);
  if (serialized.includes("\n") || serialized.includes("\r")) {
    throw new Error("ACP JSON-RPC frame cannot contain raw newline characters");
  }
  return `${serialized}\n`;
}

/**
 * Stateful NDJSON line buffer that splits chunked stdio streams into parsed JSON objects.
 */
export class NdjsonFrameDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const frames: unknown[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!rawLine) {
        continue;
      }

      frames.push(JSON.parse(rawLine));
    }

    return frames;
  }

  flush(): unknown[] {
    const trailing = this.buffer.trim();
    this.buffer = "";
    if (!trailing) {
      return [];
    }
    return [JSON.parse(trailing)];
  }
}

/**
 * Normalize native CLI JSONL events (Claude stream-json, Codex exec --json, Grok ACP/stream-json,
 * Muse MSP JSONL, Copilot JSONL) into a unified event structure for the CHO-desktop UI.
 */
export function normalizeHarnessEvent(
  harness: HarnessId,
  sessionId: string,
  event: Record<string, unknown>,
): NormalizedStreamEvent[] {
  const out: NormalizedStreamEvent[] = [];

  if (harness === "claude" || harness === "grok") {
    // Handle ACP session/update notifications from `grok agent stdio`
    if (event.method === "session/update" && event.params && typeof event.params === "object") {
      const params = event.params as Record<string, unknown>;
      const update = (params.update as Record<string, unknown>) || {};
      const updateType = String(update.sessionUpdate || "");
      const content = (update.content as Record<string, unknown>) || {};
      if (updateType === "agent_message_chunk" && typeof content.text === "string") {
        out.push({ harness, sessionId, kind: "message_delta", text: content.text, raw: event });
      } else if (updateType === "agent_thought_chunk" && typeof content.text === "string") {
        out.push({ harness, sessionId, kind: "thought_delta", text: content.text, raw: event });
      } else if (updateType === "tool_call" || updateType === "tool_call_update") {
        out.push({
          harness,
          sessionId,
          kind: "tool_call",
          toolCallId: String(update.toolCallId || "tool"),
          toolTitle: String(update.title || update.kind || "Tool"),
          toolStatus: String(update.status || "in_progress"),
          raw: event,
        });
      }
      return out;
    }

    // Handle stream-json events (`claude -p --output-format stream-json`, `grok -p --output-format stream-json`)
    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      const msg = event.message as Record<string, unknown>;
      if (typeof msg.model === "string" && msg.model !== "<synthetic>") {
        out.push({ harness, sessionId, kind: "model_verified", model: msg.model, raw: event });
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === "text" && typeof block.text === "string") {
            out.push({ harness, sessionId, kind: "message_delta", text: block.text, raw: block });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            out.push({ harness, sessionId, kind: "thought_delta", text: block.thinking, raw: block });
          } else if (block.type === "tool_use") {
            out.push({
              harness,
              sessionId,
              kind: "tool_call",
              toolCallId: String(block.id || "tool"),
              toolTitle: String(block.name || "tool"),
              toolStatus: "completed",
              raw: block,
            });
          }
        }
      }
    } else if (event.type === "result") {
      if (event.is_error === true) {
        out.push({
          harness,
          sessionId,
          kind: "error",
          text: String(event.result || "Run failed"),
          raw: event,
        });
      } else {
        out.push({
          harness,
          sessionId,
          kind: "turn_complete",
          text: typeof event.result === "string" ? event.result : undefined,
          raw: event,
        });
      }
    }
    return out;
  }

  if (harness === "codex") {
    if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        out.push({ harness, sessionId, kind: "message_delta", text: item.text, raw: event });
      } else if (item.type === "reasoning" && typeof item.text === "string") {
        out.push({ harness, sessionId, kind: "thought_delta", text: item.text, raw: event });
      } else if (item.type === "command_execution" || item.type === "tool_call") {
        out.push({
          harness,
          sessionId,
          kind: "tool_call",
          toolCallId: String(item.id || "cmd"),
          toolTitle: String(item.command || item.name || "command"),
          toolStatus: String(item.status || "completed"),
          raw: event,
        });
      }
    } else if (event.type === "turn.completed") {
      out.push({ harness, sessionId, kind: "turn_complete", raw: event });
    } else if (event.type === "error" || event.type === "turn.failed") {
      const errObj = (event.error as Record<string, unknown>) || {};
      out.push({
        harness,
        sessionId,
        kind: "error",
        text: String(event.message || errObj.message || "Codex error"),
        raw: event,
      });
    }
    return out;
  }

  if (harness === "muse") {
    const payload = (event.payload as Record<string, unknown>) || {};
    if (event.payload_type === "run.model.configured" && typeof payload.model_id === "string") {
      out.push({ harness, sessionId, kind: "model_verified", model: payload.model_id, raw: event });
    } else if (event.payload_type === "run.terminal.completed" && typeof payload.text === "string") {
      out.push({ harness, sessionId, kind: "message_delta", text: payload.text, raw: event });
      out.push({ harness, sessionId, kind: "turn_complete", text: payload.text, raw: event });
    } else if (event.payload_type === "run.terminal.failed") {
      out.push({
        harness,
        sessionId,
        kind: "error",
        text: String(payload.reason || payload.message || "Muse error"),
        raw: event,
      });
    }
    return out;
  }

  if (harness === "copilot") {
    const data = (event.data as Record<string, unknown>) || {};
    if (event.type === "assistant.usage" && typeof data.model === "string") {
      out.push({ harness, sessionId, kind: "model_verified", model: data.model, raw: event });
    } else if (event.type === "assistant.message" && typeof data.content === "string") {
      out.push({ harness, sessionId, kind: "message_delta", text: data.content, raw: event });
    } else if (event.type === "session.error") {
      out.push({
        harness,
        sessionId,
        kind: "error",
        text: String(data.message || event.message || "Copilot error"),
        raw: event,
      });
    }
    return out;
  }

  return out;
}
