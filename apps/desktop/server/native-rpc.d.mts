// Type declarations for ./native-rpc.mjs. They must agree exactly with the
// runtime peer; do not widen them with catchalls.

import type { Readable, Writable } from "node:stream";

export const NATIVE_RPC_MAX_PENDING_OUTBOUND: 8;
export const NATIVE_RPC_MAX_PENDING_INBOUND: 8;
export const NATIVE_RPC_MAX_OUTGOING_FRAMES: 16;

export type NativeRpcId = string | number;

// NOT_SENT: the frame never reached the transport (safe to retry elsewhere).
// OUTCOME_UNKNOWN: the frame was written, expired, or torn down, so the
// native side may have executed it. REMOTE_ERROR: the native side rejected
// exactly this call; the peer stays healthy. CLOSED: new work after closure.
export type NativeRpcErrorCode = "NOT_SENT" | "OUTCOME_UNKNOWN" | "REMOTE_ERROR" | "CLOSED";

export class NativeRpcError extends Error {
  code: NativeRpcErrorCode;
  constructor(code: NativeRpcErrorCode, message: string);
}

export interface NativeRpcNotification {
  method: string;
  params: unknown;
}

export interface NativeRpcServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface NativeRpcOptions {
  input: Readable;
  output: Writable;
  onNotification?: (message: NativeRpcNotification) => void;
  onRequest?: (message: NativeRpcServerRequest) => void;
  onFatal?: (error: Error) => void;
  timeoutMs?: number;
}

export interface NativeRpcPeer {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: string | number, result: unknown): Promise<void>;
  close(reason?: string): void;
  readonly closed: boolean;
}

export function createNativeRpc(options: NativeRpcOptions): NativeRpcPeer;
