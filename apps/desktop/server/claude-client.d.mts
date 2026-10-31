import type { spawn } from "node:child_process";

export interface ClaudeClientModel {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly resolvedModel?: string;
  readonly supportedEfforts?: readonly string[];
}
export type ClaudePermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };
export interface OpenClaudeClientOptions {
  workspace: string;
  metadataOnly?: boolean;
  model?: string;
  sessionId?: string;
  resume?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  role?: "review" | "implement";
  onEvent?: (event: Record<string, unknown>) => void;
  onRequest?: (message: { id: string | number; request: Record<string, unknown> }) => void;
  onCancel?: (requestId: string) => void;
  onFatal?: (error: Error) => void;
  spawnImpl?: typeof spawn;
  resolveExe?: () => string;
}
export interface ClaudeClient {
  readonly models: readonly ClaudeClientModel[];
  readonly connectionId: string;
  readonly pid: number | undefined;
  readonly requestedSessionId: string | null;
  readonly nativeSessionId: string | null;
  readonly closed: boolean;
  sendUser(message: { uuid: string; prompt: string }): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string | number, decision: ClaudePermissionDecision): Promise<void>;
  retire(requestId: string | number): boolean;
  close(): Promise<void>;
}
export function openClaudeClient(options: OpenClaudeClientOptions): Promise<ClaudeClient>;
