// Type declarations for ./host.mjs. They must agree exactly with the
// runtime implementation; do not widen them with catchalls.
import type { JsonObject } from './protocol.d.mts';

export type HostDispatch = (
  command: string,
  args: JsonObject,
) => Promise<unknown>;

export interface HostRunOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  generation?: string;
  dispatch?: HostDispatch;
}

// Runs the persistent v1 host until input EOF/error, a malformed frame,
// or a `shutdown` request. Resolves when the host has stopped; stdout
// carries only complete v1 frames, diagnostics go to `error`.
//
// Receiver-specific sender-ID rule (this connection only, not the generic
// protocol): request IDs are r1, r2, ... with a strictly increasing u64
// suffix; the host keeps only a high-water counter.
export function runHost(options?: HostRunOptions): Promise<void>;
