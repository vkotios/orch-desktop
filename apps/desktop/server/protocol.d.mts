// Type declarations for ./protocol.mjs. They must agree exactly with the
// runtime validators; do not widen them with catchalls.

export const PROTOCOL_VERSION: 1;
export const MAX_FRAME_BYTES: number;
// JSON nesting-depth bound: object/array levels counting the envelope
// root as depth 1; deeper values reject with INVALID_ENVELOPE.
export const MAX_JSON_DEPTH: number;

export type ProtocolErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_ENVELOPE'
  | 'INVALID_JSON'
  | 'MESSAGE_TOO_LARGE'
  | 'STALE_GENERATION'
  | 'CORRELATION_MISMATCH';

export class ProtocolError extends Error {
  code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface RequestEnvelope {
  v: 1;
  type: 'request';
  requestId: string;
  generation: string;
  command: string;
  args: JsonObject;
}

export interface ResultEnvelope {
  v: 1;
  type: 'result';
  requestId: string;
  generation: string;
  result: JsonValue;
}

export interface ErrorEnvelope {
  v: 1;
  type: 'error';
  requestId: string;
  generation: string;
  error: { code: string; message: string };
}

export interface HostEventEnvelope {
  v: 1;
  type: 'event';
  requestId: string | null;
  generation: string;
  event: 'ready' | 'stream' | 'stopping';
  payload: JsonObject;
}

export type HostEnvelope =
  | RequestEnvelope
  | ResultEnvelope
  | ErrorEnvelope
  | HostEventEnvelope;

export interface EnvelopeExpectations {
  generation?: string;
  requestId?: string;
}

export function validateEnvelope(value: unknown, expected?: EnvelopeExpectations): HostEnvelope;
export function encodeFrame(envelope: HostEnvelope): string;
export function decodeFrame(text: string, expected?: EnvelopeExpectations): HostEnvelope;
