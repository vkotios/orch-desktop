// Type declarations for ./codex-client.mjs. They must agree exactly with the
// runtime client; do not widen them with catchalls.

export interface CodexClientModel {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CodexClientNotification {
  method: string;
  params: unknown;
}

export interface CodexClientServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface OpenCodexClientOptions {
  workspace: string;
  onNotification?: (message: CodexClientNotification) => void;
  onRequest?: (message: CodexClientServerRequest) => void;
  onFatal?: (error: Error) => void;
  spawnImpl?: typeof import("node:child_process").spawn;
  resolveExe?: () => string;
}

export interface CodexClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: string | number, result: unknown): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
  readonly pid: number | undefined;
  readonly workspace: string;
  readonly models: readonly CodexClientModel[];
  readonly connectionId: string;
}

export function openCodexClient(options: OpenCodexClientOptions): Promise<CodexClient>;
