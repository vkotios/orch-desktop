// CHO application-host wire protocol, version 1.
// Transport-neutral NDJSON envelopes: exactly one compact JSON object plus LF
// per frame, UTF-8, bounded by MAX_FRAME_BYTES including the LF. No process
// launch, persistence, provider logic, or transport switching lives here.
//
// RPC semantics: `result` terminates the RPC request with success, `error`
// terminates it as failure. A returned operation identifier inside a result
// is only an acknowledgement; terminal state of an ongoing provider operation
// still arrives through `stream` events. `ready`/`stream`/`stopping` events
// never resolve an RPC request. Unknown versions/types/events reject
// explicitly and never fall through as success.
//
// LIMITATION (stateless validation): validateEnvelope checks one envelope in
// isolation. It does not track pending request IDs, so unknown/duplicate
// request IDs, replays, and host restarts are receiver-lifecycle work: the
// receiver must keep its own pending-request table and current-generation
// state. Validation alone provides no tracking.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 64;

// JSON nesting-depth convention (a future Rust peer must match it):
// depth counts nested object/array levels. The envelope (root value)
// is depth 1; each nested object/array adds one level; scalar leaves
// occupy their container's level and add none. A bare scalar is depth 0.
// Any object/array deeper than MAX_JSON_DEPTH rejects INVALID_ENVELOPE.
// The envelope itself consumes one level, so a `result`/`args`/`payload`
// value may nest at most MAX_JSON_DEPTH - 1 levels.

const MAX_ID_CHARS = 128;
const MAX_CODE_CHARS = 128;
const ENVELOPE_TYPES = new Set(['request', 'result', 'error', 'event']);
const EVENT_NAMES = new Set(['ready', 'stream', 'stopping']);
const COMMAND_RE = /^[a-z][a-z0-9_]{0,79}$/;

const byteLength = (text) => new TextEncoder().encode(text).length;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ProtocolError(code, message);
};

function assertId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) {
    fail('INVALID_ENVELOPE', `${label} must be a nonempty string of at most ${MAX_ID_CHARS} chars`);
  }
}

function assertPlainObject(value, label) {
  const proto = value === null || typeof value !== 'object' ? null : Object.getPrototypeOf(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (proto !== Object.prototype && proto !== null)) {
    fail('INVALID_ENVELOPE', `${label} must be a plain JSON object`);
  }
}

// Rejects values JSON.stringify would silently drop/coerce (undefined,
// functions, symbols, BigInt, nonfinite numbers), cyclic references,
// non-plain objects, and nesting deeper than MAX_JSON_DEPTH.
// Iterative: deep inputs reject with ProtocolError instead of overflowing
// the call stack. JSON.parse output always passes the type/shape walk
// (depth is still bounded).
function assertJsonValue(root, seen) {
  const isContainer = (child) => child !== null && typeof child === 'object';
  const stack = [{ value: root, depth: isContainer(root) ? 1 : 0, exit: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    const value = frame.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('INVALID_ENVELOPE', 'nonfinite numbers are not valid JSON values');
      continue;
    }
    if (typeof value !== 'object') fail('INVALID_ENVELOPE', `type ${typeof value} is not a valid JSON value`);
    if (frame.exit) {
      seen.delete(value);
      continue;
    }
    if (seen.has(value)) fail('INVALID_ENVELOPE', 'cyclic values are not valid JSON values');
    if (frame.depth > MAX_JSON_DEPTH) fail('INVALID_ENVELOPE', `JSON nesting depth exceeds ${MAX_JSON_DEPTH}`);
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push({ value, depth: frame.depth, exit: true });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: isContainer(value[index]) ? frame.depth + 1 : frame.depth, exit: false });
      }
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) fail('INVALID_ENVELOPE', 'only plain objects are valid JSON values');
      stack.push({ value, depth: frame.depth, exit: true });
      const keys = Object.keys(value);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[keys[index]], depth: isContainer(value[keys[index]]) ? frame.depth + 1 : frame.depth, exit: false });
      }
    }
  }
}

// Validates one envelope and returns it. `expected` correlation is checked
// with equality only: any mismatch rejects, never reassociates.
export function validateEnvelope(value, expected) {
  assertJsonValue(value, new Set());
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ENVELOPE', 'envelope must be a JSON object');
  }
  const env = value;
  if (env.v !== PROTOCOL_VERSION) fail('UNSUPPORTED_VERSION', `unsupported protocol version ${String(env.v)}`);
  if (!ENVELOPE_TYPES.has(env.type)) fail('INVALID_ENVELOPE', `unknown envelope type ${String(env.type)}`);
  assertId(env.generation, 'generation');
  if (env.type === 'event') {
    if (env.requestId !== null) assertId(env.requestId, 'requestId');
  } else {
    assertId(env.requestId, 'requestId');
  }
  if (env.type === 'request') {
    if (typeof env.command !== 'string' || !COMMAND_RE.test(env.command)) {
      fail('INVALID_ENVELOPE', 'command must match [a-z][a-z0-9_]{0,79}');
    }
    assertPlainObject(env.args, 'args');
  } else if (env.type === 'result') {
    if (!('result' in env)) fail('INVALID_ENVELOPE', 'result envelope must carry a result field');
  } else if (env.type === 'error') {
    assertPlainObject(env.error, 'error');
    if (typeof env.error.code !== 'string' || env.error.code.length === 0 || env.error.code.length > MAX_CODE_CHARS) {
      fail('INVALID_ENVELOPE', `error.code must be a nonempty string of at most ${MAX_CODE_CHARS} chars`);
    }
    if (typeof env.error.message !== 'string') fail('INVALID_ENVELOPE', 'error.message must be a string');
  } else {
    if (!EVENT_NAMES.has(env.event)) fail('INVALID_ENVELOPE', `unknown event name ${String(env.event)}`);
    assertPlainObject(env.payload, 'payload');
  }
  if (expected !== undefined && expected !== null) {
    if (expected.generation !== undefined && expected.generation !== env.generation) {
      fail('STALE_GENERATION', `stale generation ${env.generation}`);
    }
    if (expected.requestId !== undefined && env.requestId !== expected.requestId) {
      fail('CORRELATION_MISMATCH', 'requestId does not match the expected correlation');
    }
  }
  // Canonical frame bound: the compact JSON encoding plus its required LF,
  // in UTF-8 bytes. Direct validation enforces exactly the same bound as
  // encoding; decoding may omit the final LF but the canonical bound still
  // applies (decodeFrame additionally bounds the raw input bytes).
  if (byteLength(`${JSON.stringify(env)}\n`) > MAX_FRAME_BYTES) {
    fail('MESSAGE_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return env;
}

// Encodes one envelope as a single LF-terminated frame.
export function encodeFrame(envelope) {
  const frame = `${JSON.stringify(validateEnvelope(envelope))}\n`;
  if (byteLength(frame) > MAX_FRAME_BYTES) fail('MESSAGE_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  return frame;
}

// Decodes exactly one complete frame (optional final LF). Rejects
// malformed/truncated JSON, multiple frames, oversize input, and bad
// envelopes; `expected` correlation is forwarded to validateEnvelope.
export function decodeFrame(text, expected) {
  if (typeof text !== 'string') fail('INVALID_ENVELOPE', 'frame must be a string');
  if (byteLength(text) > MAX_FRAME_BYTES) fail('MESSAGE_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let body = text;
  if (body.endsWith('\n')) body = body.slice(0, -1);
  if (body.endsWith('\r')) body = body.slice(0, -1);
  if (body.includes('\n') || body.includes('\r')) fail('INVALID_ENVELOPE', 'frame must contain exactly one JSON envelope');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    // Only native-parser stack exhaustion maps to a depth rejection;
    // every other parse failure is INVALID_JSON, and nothing else caught.
    if (err instanceof RangeError) fail('INVALID_ENVELOPE', `JSON nesting depth exceeds ${MAX_JSON_DEPTH}`);
    fail('INVALID_JSON', 'frame is not valid JSON');
  }
  return validateEnvelope(parsed, expected);
}
