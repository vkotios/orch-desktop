// Bounded native stdio RPC peer for the Codex app-server conversation.
//
// Wire: incremental byte-level NDJSON. Each frame is one compact JSON object
// plus LF, UTF-8, bounded by MAX_FRAME_BYTES including the LF (shared with
// ./protocol.mjs). Chunks are buffered as raw bytes so fragmented multibyte
// characters survive splits; every complete frame is decoded with a fatal
// UTF-8 decoder, so invalid bytes poison the peer instead of becoming
// replacement characters. Complete frames are processed one at a time, so a
// coalesced chunk may hold many individually valid frames whose total exceeds
// 1 MiB. Only the incomplete tail is retained, and it never exceeds the
// frame bound. A bare keep-alive newline (LF or CRLF with no body) is
// deliberately ignored; any other unparseable line is fatal.
//
// Envelopes carry no `jsonrpc` field (Codex omits it). Outgoing requests use
// this peer's own monotonic string ids (`rpc-1`, `rpc-2`, ...), never
// fabricated native session ids. Incoming ids are safe integers or nonempty
// strings of at most 128 chars; numeric 0 is valid and distinct from "0".
//
// Roles: `{ id, method, params }` is a server request, `{ method, params }`
// is a notification, `{ id, result }` / `{ id, error: { code, message } }`
// is a response. `ready`-style notifications never resolve RPC requests.
// `onNotification`/`onRequest` run synchronously with no internal queue: a
// throw from either is fatal. Only `respond` answers a server request, at
// most once per inbound id.
//
// Limits: at most 8 pending outbound requests, 8 pending inbound server
// requests, and 16 queued (not yet handed to the transport) outgoing frames
// across requests, notifications, and responses. Writes go out in FIFO order
// exactly once; when `output.write` returns false the pump waits for `drain`
// before further writes, and async write-callback errors are fatal. There is
// no retry or replay.
//
// Ownership: the supplied streams stay caller-owned; this peer never ends or
// destroys them, it only detaches its listeners. `onFatal` fires at most
// once and the owning service must treat it as terminal: close the native
// process/session. Every EOF (even at a frame boundary) is fatal, because a
// dead transport cannot answer outstanding work. Request failures carry a
// `code`: NOT_SENT (never reached the transport, safe to retry elsewhere),
// OUTCOME_UNKNOWN (may have executed: written, timed out, or torn down),
// REMOTE_ERROR (the native side rejected exactly this call; the peer stays
// healthy), or CLOSED (new work after closure).

import { MAX_FRAME_BYTES, MAX_JSON_DEPTH } from "./protocol.mjs";

export const NATIVE_RPC_MAX_PENDING_OUTBOUND = 8;
export const NATIVE_RPC_MAX_PENDING_INBOUND = 8;
export const NATIVE_RPC_MAX_OUTGOING_FRAMES = 16;

const MAX_ID_CHARS = 128;
const MAX_METHOD_CHARS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const LF_BYTE = 0x0a;

export class NativeRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeRpcError";
    this.code = code;
  }
}

const notSent = (message) => new NativeRpcError("NOT_SENT", message);
const outcomeUnknown = (message) => new NativeRpcError("OUTCOME_UNKNOWN", message);
const remoteError = (code, message) =>
  new NativeRpcError("REMOTE_ERROR", `remote error ${String(code)}: ${message}`);
const closedError = (message) => new NativeRpcError("CLOSED", message);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidId(id) {
  if (typeof id === "number") return Number.isSafeInteger(id);
  return typeof id === "string" && id.length >= 1 && id.length <= MAX_ID_CHARS;
}

function isValidMethod(method) {
  return typeof method === "string" && method.length >= 1 && method.length <= MAX_METHOD_CHARS;
}

const isContainer = (value) => value !== null && typeof value === "object";

// Iterative depth check so hostile frames reject instead of overflowing the
// call stack. The envelope root counts as depth 1; each nested object/array
// level adds one. Cycles fail as well.
function depthWithinBound(root) {
  const startDepth = isContainer(root) ? 1 : 0;
  const stack = [{ value: root, depth: startDepth, exit: false }];
  const active = new Set();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.exit) {
      active.delete(frame.value);
      continue;
    }
    if (!isContainer(frame.value)) continue;
    if (active.has(frame.value)) return false;
    if (frame.depth > MAX_JSON_DEPTH) return false;
    active.add(frame.value);
    stack.push({ value: frame.value, depth: frame.depth, exit: true });
    if (Array.isArray(frame.value)) {
      for (let i = frame.value.length - 1; i >= 0; i -= 1) {
        const child = frame.value[i];
        stack.push({ value: child, depth: isContainer(child) ? frame.depth + 1 : frame.depth, exit: false });
      }
    } else {
      const keys = Object.keys(frame.value);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const child = frame.value[keys[i]];
        stack.push({ value: child, depth: isContainer(child) ? frame.depth + 1 : frame.depth, exit: false });
      }
    }
  }
  return true;
}

// Encodes one outbound envelope. Any failure rejects before dispatch, so the
// caller sees NOT_SENT and the peer stays healthy.
function encodeOutbound(value) {
  let bounded = false;
  try {
    bounded = depthWithinBound(value);
  } catch {
    bounded = false;
  }
  if (!bounded) throw notSent(`outgoing frame exceeds the JSON depth bound of ${MAX_JSON_DEPTH}`);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw notSent("outgoing frame is not encodable as JSON");
  }
  const frame = `${text}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
    throw notSent(`outgoing frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return frame;
}

export function createNativeRpc(options) {
  const input = options?.input;
  const output = options?.output;
  if (!input || typeof input.on !== "function" || typeof input.removeListener !== "function") {
    throw new TypeError("createNativeRpc requires a readable input stream");
  }
  if (!output || typeof output.write !== "function" || typeof output.on !== "function" || typeof output.removeListener !== "function") {
    throw new TypeError("createNativeRpc requires a writable output stream");
  }
  const onNotification = options?.onNotification;
  const onRequest = options?.onRequest;
  const onFatal = options?.onFatal;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const state = {
    closed: false,
    fatalDelivered: false,
    tail: Buffer.alloc(0),
    queue: [],
    pendingOut: new Map(),
    pendingIn: new Map(),
    waitingDrain: false,
    nextId: 1,
  };

  function detach() {
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("error", onStreamError);
    input.removeListener("close", onInputClose);
    output.removeListener("drain", onDrain);
    output.removeListener("error", onStreamError);
    output.removeListener("close", onOutputClose);
  }

  // Settles every pending and queued item: frames never handed to the
  // transport fail NOT_SENT, requests already written fail OUTCOME_UNKNOWN.
  function tearDown(reason) {
    if (state.closed) return;
    state.closed = true;
    detach();
    for (const node of state.queue) {
      if (node.entry !== null) {
        const entry = node.entry;
        if (!entry.written && state.pendingOut.get(entry.id) === entry) {
          state.pendingOut.delete(entry.id);
          clearTimeout(entry.timer);
          entry.reject(notSent(`request ${entry.id} never reached the transport: ${reason}`));
        }
      } else {
        node.reject(notSent(`frame never reached the transport: ${reason}`));
      }
    }
    state.queue.length = 0;
    for (const entry of state.pendingOut.values()) {
      clearTimeout(entry.timer);
      entry.reject(outcomeUnknown(`request ${entry.id} may have reached the transport: ${reason}`));
    }
    state.pendingOut.clear();
    state.pendingIn.clear();
    state.waitingDrain = false;
  }

  function deliverFatal(error) {
    if (state.fatalDelivered) return;
    state.fatalDelivered = true;
    if (typeof onFatal === "function") {
      try {
        onFatal(error);
      } catch {
        // The owner callback must not break teardown.
      }
    }
  }

  function fatal(err) {
    if (state.closed) return;
    const error = err instanceof Error ? err : new Error(String(err));
    tearDown(error.message);
    deliverFatal(error);
  }

  function pump() {
    while (!state.closed && !state.waitingDrain && state.queue.length > 0) {
      const node = state.queue[0];
      let accepted;
      try {
        accepted = output.write(node.bytes, (err) => onWriteSettled(err));
      } catch (err) {
        // Synchronous transport refusal: the frame was never admitted.
        fatal(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      state.queue.shift();
      if (node.entry !== null) node.entry.written = true;
      else node.resolve();
      if (accepted === false) state.waitingDrain = true;
    }
  }

  function onWriteSettled(err) {
    if (state.closed || !err) return;
    fatal(err instanceof Error ? err : new Error(String(err)));
  }

  function onDrain() {
    if (state.closed) return;
    state.waitingDrain = false;
    pump();
  }

  function onStreamError(err) {
    fatal(err instanceof Error ? err : new Error(String(err)));
  }

  function onDeadline(id) {
    const entry = state.pendingOut.get(id);
    if (!entry) return;
    state.pendingOut.delete(id);
    if (!entry.written) {
      // Expired while still queued: drop its frame so it is never written
      // late, fail NOT_SENT, and leave unrelated calls alone.
      const index = state.queue.findIndex((node) => node.entry === entry);
      if (index >= 0) state.queue.splice(index, 1);
      entry.reject(notSent(`request ${id} expired before reaching the transport`));
      return;
    }
    entry.reject(outcomeUnknown(`request ${id} expired after reaching the transport`));
    fatal(new Error(`request ${id} expired after reaching the transport`));
  }

  function request(method, params) {
    if (state.closed) return Promise.reject(closedError("native RPC peer is closed"));
    if (!isValidMethod(method)) return Promise.reject(notSent("request method must be a nonempty string"));
    const id = `rpc-${state.nextId}`;
    state.nextId += 1;
    let bytes;
    try {
      bytes = encodeOutbound(params === undefined ? { id, method } : { id, method, params });
    } catch (err) {
      return Promise.reject(err);
    }
    if (state.pendingOut.size >= NATIVE_RPC_MAX_PENDING_OUTBOUND) {
      return Promise.reject(notSent("too many pending outbound requests"));
    }
    if (state.queue.length >= NATIVE_RPC_MAX_OUTGOING_FRAMES) {
      return Promise.reject(notSent("outgoing frame queue is full"));
    }
    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, timer: undefined, written: false };
      entry.timer = setTimeout(() => onDeadline(id), timeoutMs);
      state.pendingOut.set(id, entry);
      state.queue.push({ bytes, entry });
      pump();
    });
  }

  function notify(method, params) {
    if (state.closed) return Promise.reject(closedError("native RPC peer is closed"));
    if (!isValidMethod(method)) return Promise.reject(notSent("notification method must be a nonempty string"));
    let bytes;
    try {
      bytes = encodeOutbound(params === undefined ? { method } : { method, params });
    } catch (err) {
      return Promise.reject(err);
    }
    if (state.queue.length >= NATIVE_RPC_MAX_OUTGOING_FRAMES) {
      return Promise.reject(notSent("outgoing frame queue is full"));
    }
    return new Promise((resolve, reject) => {
      state.queue.push({ bytes, entry: null, resolve, reject });
      pump();
    });
  }

  function respond(id, result) {
    if (state.closed) return Promise.reject(closedError("native RPC peer is closed"));
    if (!state.pendingIn.has(id)) {
      return Promise.reject(notSent("unknown or already-answered inbound request id"));
    }
    if (result === undefined) return Promise.reject(notSent("respond result must not be undefined"));
    let bytes;
    try {
      bytes = encodeOutbound({ id, result });
    } catch (err) {
      return Promise.reject(err);
    }
    if (state.queue.length >= NATIVE_RPC_MAX_OUTGOING_FRAMES) {
      return Promise.reject(notSent("outgoing frame queue is full"));
    }
    // Reserve the single response for this id up front: a duplicate respond
    // refuses without writing even while the first frame is still queued.
    state.pendingIn.delete(id);
    return new Promise((resolve, reject) => {
      state.queue.push({ bytes, entry: null, resolve, reject });
      pump();
    });
  }

  function close(reason) {
    if (state.closed) return;
    tearDown(reason === undefined ? "closed by owner" : `closed by owner: ${reason}`);
  }

  function decodeEnvelope(body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      if (err instanceof RangeError) throw new Error(`native RPC frame exceeds JSON depth ${MAX_JSON_DEPTH}`);
      throw new Error("native RPC frame is not valid JSON");
    }
    if (!isPlainObject(parsed)) throw new Error("native RPC envelope must be a JSON object");
    if (!depthWithinBound(parsed)) throw new Error(`native RPC frame exceeds JSON depth ${MAX_JSON_DEPTH}`);
    const hasId = Object.hasOwn(parsed, "id");
    const hasMethod = Object.hasOwn(parsed, "method");
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");
    if (hasMethod && !hasId) {
      if (hasResult || hasError) throw new Error("native RPC notification must not carry result/error");
      if (!isValidMethod(parsed.method)) throw new Error("native RPC notification has a malformed method");
      return { kind: "notification", method: parsed.method, params: parsed.params };
    }
    if (hasMethod && hasId) {
      if (hasResult || hasError) throw new Error("native RPC request must not carry result/error");
      if (!isValidId(parsed.id)) throw new Error("native RPC request has a malformed id");
      if (!isValidMethod(parsed.method)) throw new Error("native RPC request has a malformed method");
      return { kind: "request", id: parsed.id, method: parsed.method, params: parsed.params };
    }
    if (!hasMethod && hasId) {
      if (!isValidId(parsed.id)) throw new Error("native RPC response has a malformed id");
      if (hasResult === hasError) throw new Error("native RPC response must carry exactly one of result/error");
      if (hasError) {
        const failure = parsed.error;
        if (
          !isPlainObject(failure) || !("code" in failure) ||
          (typeof failure.code !== "string" && typeof failure.code !== "number") ||
          typeof failure.message !== "string"
        ) {
          throw new Error("native RPC error response has a malformed error");
        }
        return { kind: "response", id: parsed.id, error: { code: failure.code, message: failure.message } };
      }
      return { kind: "response", id: parsed.id, result: parsed.result };
    }
    throw new Error("native RPC frame matches no envelope shape");
  }

  function dispatchFrame(frame) {
    if (frame.kind === "response") {
      const entry = state.pendingOut.get(frame.id);
      // Unknown or duplicate correlation: only a live request may settle,
      // anything else poisons the peer.
      if (!entry) throw new Error("native RPC response matches no pending request");
      state.pendingOut.delete(frame.id);
      clearTimeout(entry.timer);
      if ("error" in frame) entry.reject(remoteError(frame.error.code, frame.error.message));
      else entry.resolve(frame.result);
      return;
    }
    if (frame.kind === "notification") {
      if (typeof onNotification === "function") onNotification({ method: frame.method, params: frame.params });
      return;
    }
    if (state.pendingIn.has(frame.id)) throw new Error("native RPC request reuses a pending inbound id");
    if (state.pendingIn.size >= NATIVE_RPC_MAX_PENDING_INBOUND) {
      throw new Error("too many pending inbound requests");
    }
    state.pendingIn.set(frame.id, true);
    if (typeof onRequest === "function") onRequest({ id: frame.id, method: frame.method, params: frame.params });
  }

  function handleLine(line) {
    if (line.length > MAX_FRAME_BYTES) {
      throw new Error(`native RPC frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      throw new Error("native RPC frame is not valid UTF-8");
    }
    let body = text.slice(0, -1);
    if (body.endsWith("\r")) body = body.slice(0, -1);
    // Deliberate: a bare keep-alive newline carries no envelope and is
    // ignored instead of poisoning the peer.
    if (body.length === 0) return;
    dispatchFrame(decodeEnvelope(body));
  }

  function onData(chunk) {
    if (state.closed) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      state.tail = state.tail.length === 0 ? bytes : Buffer.concat([state.tail, bytes]);
      let newline = state.tail.indexOf(LF_BYTE);
      while (newline >= 0) {
        const line = Buffer.from(state.tail.subarray(0, newline + 1));
        state.tail = state.tail.subarray(newline + 1);
        handleLine(line);
        if (state.closed) return;
        newline = state.tail.indexOf(LF_BYTE);
      }
      // Copy the tail once per chunk so a consumed giant chunk is released
      // while only bounded incomplete bytes are retained.
      state.tail = state.tail.length === 0 ? Buffer.alloc(0) : Buffer.from(state.tail);
      if (state.tail.length > MAX_FRAME_BYTES) {
        throw new Error(`native RPC frame exceeds ${MAX_FRAME_BYTES} bytes`);
      }
    } catch (err) {
      fatal(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function onEnd() {
    if (state.closed) return;
    if (state.tail.length > 0) fatal(new Error("native RPC input ended mid-frame"));
    else fatal(new Error("native RPC input ended"));
  }

  function onInputClose() {
    if (state.closed) return;
    fatal(new Error("native RPC input closed"));
  }

  function onOutputClose() {
    if (state.closed) return;
    fatal(new Error("native RPC output closed"));
  }

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onStreamError);
  input.on("close", onInputClose);
  output.on("drain", onDrain);
  output.on("error", onStreamError);
  output.on("close", onOutputClose);

  return {
    request,
    notify,
    respond,
    close,
    get closed() {
      return state.closed;
    },
  };
}
