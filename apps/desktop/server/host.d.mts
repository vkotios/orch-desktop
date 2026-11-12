// Type declarations for ./host.mjs. They must agree exactly with the
// runtime implementation; do not widen them with catchalls.
import type { JsonObject } from './protocol.d.mts';
import type { openCodexClient } from './codex-client.d.mts';

export type HostDispatch = (
  command: string,
  args: JsonObject,
) => Promise<unknown>;

export type HostFatalCallback = (reason: unknown) => void | Promise<void>;

export interface HostNativeService {
  authorizeDelegationAssociation?(association: { conversationId: string; repoPath: string }): Promise<{ conversationId: string; repoPath: string }>;
  handle(command: string, args: JsonObject): Promise<unknown>;
  close(): Promise<void>;
}

export interface HostServiceContext {
  generation: string;
  onFatal: HostFatalCallback;
  openClient?: typeof openCodexClient;
}

export type HostServiceFactory = (context: HostServiceContext) => HostNativeService | Promise<HostNativeService>;

export interface HostRunOptions {
  databasePath?: string;
  delegationFilePath?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  generation?: string;
  dispatch?: HostDispatch;
  serviceFactory?: HostServiceFactory;
  openClient?: typeof openCodexClient;
  onFatal?: HostFatalCallback;
}

// Runs the persistent v1 host until input EOF/error, a malformed frame,
// or a `shutdown` request. Resolves when the host has stopped; stdout
// carries only complete v1 frames, diagnostics go to `error`.
//
// Receiver-specific sender-ID rule (this connection only, not the generic
// protocol): request IDs are r1, r2, ... with a strictly increasing u64
// suffix; the host keeps only a high-water counter.
export function runHost(options?: HostRunOptions): Promise<void>;
