// CHO-desktop persistent native host: v1 NDJSON frames in, exactly one
// result/error frame per request out, diagnostics on `error`. Sender rule for
// this connection only: requestIds are r<N> with N a strictly increasing u64;
// only the high-water mark is kept. Undecodable input ends the host
// fail-closed instead of fabricating a correlation.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION, MAX_FRAME_BYTES, encodeFrame, decodeFrame } from './protocol.mjs';

// Fixed native-chat slice. These never reach the browser bridge dispatcher;
// they are handled by the lazily created native-chat service below.
const NATIVE_COMMANDS = new Set([
  'native_chat_validate_project',
  'native_chat_prepare_project',
  'direct_chat_send',
  'native_chat_poll',
  'native_chat_respond',
  'native_chat_answer',
  'direct_chat_cancel',
  'native_chat_close',
]);
const ALLOWED_COMMANDS = new Set(['ping', 'shutdown', 'discover_harnesses', 'orch_dashboard', ...NATIVE_COMMANDS]);
// Bound for closing the lazily created native-chat service on shutdown, EOF,
// output faults and owner-fatal paths. Keeps the serial shutdown exchange
// inside the Rust per-phase deadline; a close that exceeds it is reported
// explicitly and the Rust job owner remains the termination fallback.
const NATIVE_CLOSE_TIMEOUT_MS = 1000;
const SENDER_ID_RE = /^r(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const EMPTY = Buffer.alloc(0);

function parseSenderId(requestId) {
  const match = typeof requestId === 'string' ? SENDER_ID_RE.exec(requestId) : null;
  if (!match) return null;
  let num;
  try { num = BigInt(match[1]); } catch { return null; }
  return num <= U64_MAX ? num : null;
}

export async function runHost(options = {}) {
  const { input = process.stdin, output = process.stdout, error = process.stderr,
    generation = crypto.randomUUID(), dispatch, serviceFactory, openClient, onFatal } = options ?? {};
  const dispatchFn = dispatch
    ?? ((command, args) => import('./bridge.mjs').then((mod) => mod.handleBridgeCommand(command, args)));

  return new Promise((resolve) => {
    let done = false;
    let eof = false;
    let highWater = 0n;
    let carry = Buffer.alloc(0); // bytes of the frame in progress, never a full frame
    let pending = Buffer.alloc(0); // held chunk; unconsumed bytes start at `cursor`
    let cursor = 0;
    let pumping = false;
    const drainWaiters = new Set();
    const has = (stream, name) => typeof stream?.[name] === 'function';

    const diagnose = (message) => { try { error.write(`host: ${message}\n`); } catch { /* stderr gone; still terminate */ } };
    // Lazily created native-chat service singleton. Nothing starts at ready,
    // discovery or ping: the module is imported and the service is created
    // only when the first native command arrives. `serviceFactory` injects
    // fake services for lifecycle tests; production lazily imports
    // ./native-chat.mjs, which the host never synthesizes when absent.
    let nativeService = null;
    let nativeServicePromise = null;
    let nativeClosePromise = null;
    function closeNative(reason) {
      if (!nativeClosePromise) {
        nativeClosePromise = (async () => {
          if (!nativeServicePromise && !nativeService) return;
          let service = nativeService;
          if (!service) {
            try { service = await nativeServicePromise; }
            catch { return; } // never became available; nothing to close
          }
          if (!service || typeof service.close !== 'function') return;
          let timer;
          const gate = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${NATIVE_CLOSE_TIMEOUT_MS}ms`)), NATIVE_CLOSE_TIMEOUT_MS);
          });
          try { await Promise.race([service.close(), gate]); }
          catch (err) { diagnose(`native chat service close failed (${reason}): ${err?.message ?? err}`); }
          finally { clearTimeout(timer); }
        })();
      }
      return nativeClosePromise;
    }
    async function getNativeService() {
      if (nativeService) return nativeService;
      if (!nativeServicePromise) {
        const factory = serviceFactory ?? (async (ctx) => {
          const mod = await import('./native-chat.mjs');
          return mod.createNativeChatService(ctx);
        });
        nativeServicePromise = Promise.resolve()
          .then(() => factory({ generation, onFatal: ownerFatal, openClient }))
          .then(
            (service) => { nativeService = service; return service; },
            (err) => { nativeServicePromise = null; throw err; },
          );
      }
      return nativeServicePromise;
    }
    // Owner-fatal path: the service lost its producer or reached unknown
    // state, so this host can no longer serve anything. Notify the injected
    // owner callback when present — the real entry point exits nonzero and
    // closes stdout there so Rust sees EOF and its poisoned Job terminates
    // the whole tree — then settle the host (which closes the service).
    async function ownerFatal(reason) {
      if (done) return;
      diagnose(`native chat fatal: ${reason ?? 'unknown failure'}`);
      if (typeof onFatal === 'function') {
        try { await onFatal(reason); }
        catch (err) { diagnose(`fatal callback failed: ${err?.message ?? err}`); }
      }
      finish();
    }
    const detach = () => {
      for (const cancel of [...drainWaiters]) { drainWaiters.delete(cancel); try { cancel(); } catch { /* settling */ } }
      if (has(input, 'removeListener')) {
        input.removeListener('data', onData);
        input.removeListener('end', onEof);
        input.removeListener('close', onEof);
        input.removeListener('error', onInputError);
      }
      if (has(output, 'removeListener')) {
        output.removeListener('error', onOutputError);
        output.removeListener('close', onOutputClose);
      }
      if (has(input, 'pause')) { try { input.pause(); } catch { /* best effort */ } }
    };
    // Every settle path funnels through here, so normal shutdown, EOF and
    // output faults also close an active native service (bounded). A cleanup
    // failure is diagnosed explicitly; the Rust job owner stays the fallback.
    const finish = () => {
      if (done) return;
      done = true;
      detach();
      void closeNative('stop').then(() => resolve(), () => resolve());
    };
    const fail = (message) => { if (!done) diagnose(message); finish(); };
    const onOutputError = (err) => fail(`output error: ${err?.message ?? err}`);
    const onOutputClose = () => fail('output closed');
    if (has(output, 'on')) { output.on('error', onOutputError); output.on('close', onOutputClose); }

    function writeFrame(frame) {
      return new Promise((settled) => {
        if (done) { settled(false); return; }
        let ok;
        try { ok = output.write(frame); } catch (err) { diagnose(`output write threw: ${err?.message ?? err}`); settled(false); return; }
        if (ok !== false) { settled(true); return; }
        const cleanup = () => {
          drainWaiters.delete(cancel);
          output.removeListener('drain', onDrain);
          output.removeListener('error', onErr);
          output.removeListener('close', onClose);
        };
        const cancel = () => { cleanup(); settled(false); };
        const onDrain = () => { cleanup(); settled(true); };
        const onErr = () => { cleanup(); settled(false); };
        const onClose = () => { cleanup(); settled(false); };
        drainWaiters.add(cancel);
        output.once('drain', onDrain);
        output.once('error', onErr);
        output.once('close', onClose);
      });
    }

    async function sendResult(requestId, result) {
      if (done) return;
      let frame;
      try { frame = encodeFrame({ v: 1, type: 'result', requestId, generation, result }); }
      catch (err) { await sendError(requestId, 'COMMAND_FAILED', `unencodable result: ${err?.message ?? err}`); return; }
      if (!(await writeFrame(frame))) finish();
    }

    async function sendError(requestId, code, message) {
      if (done) return;
      let frame;
      try { frame = encodeFrame({ v: 1, type: 'error', requestId, generation, error: { code, message } }); }
      catch { fail(`cannot encode error envelope for ${requestId}`); return; }
      if (!(await writeFrame(frame))) finish();
    }

    async function runCommand(env) {
      if (env.command === 'ping') { await sendResult(env.requestId, { ok: true, pid: process.pid }); return; }
      if (env.command === 'shutdown') { await closeNative('shutdown'); await sendResult(env.requestId, { ok: true }); finish(); return; }
      if (NATIVE_COMMANDS.has(env.command)) {
        // Native slice: invalid UI requests are ordinary COMMAND_FAILED, not
        // owner-fatal. Only the service's own onFatal (lost producer/unknown
        // state) settles the host. The browser bridge never sees these.
        let data;
        try {
          const service = await getNativeService();
          if (!service || typeof service.handle !== 'function') throw new Error('native chat service is unavailable');
          data = await service.handle(env.command, env.args);
        }
        catch (err) { await sendError(env.requestId, 'COMMAND_FAILED', err?.message ?? String(err)); return; }
        await sendResult(env.requestId, data);
        return;
      }
      let data;
      try { data = await dispatchFn(env.command, env.args); }
      catch (err) { await sendError(env.requestId, 'COMMAND_FAILED', err?.message ?? String(err)); return; }
      await sendResult(env.requestId, data);
    }

    // Handles exactly one complete frame (including its LF) from parse to
    // response. Awaiting this serially is what bounds queued work: one active
    // dispatch/response at a time, no per-line promise backlog.
    async function handleLine(line) {
      let text;
      try { text = utf8.decode(line); } catch { fail('malformed frame (INVALID_UTF8): input is not valid UTF-8'); return; }
      let env;
      try { env = decodeFrame(text); }
      catch (err) { fail(`malformed frame (${err?.code ?? 'INVALID'}): ${err?.message ?? err}`); return; }
      if (env === null || typeof env !== 'object' || env.type !== 'request') { fail('expected a v1 request frame'); return; }
      if (env.generation !== generation) {
        await sendError(env.requestId, 'STALE_GENERATION', `stale generation ${env.generation}`); return;
      }
      const num = parseSenderId(env.requestId);
      if (num === null) {
        await sendError(env.requestId, 'INVALID_ENVELOPE', 'sender requestId must match r<N> with N a u64 (this connection only)'); return;
      }
      if (num <= highWater) {
        await sendError(env.requestId, 'DUPLICATE_REQUEST_ID', `requestId ${env.requestId} is a duplicate or out of order`); return;
      }
      highWater = num;
      if (!ALLOWED_COMMANDS.has(env.command)) {
        await sendError(env.requestId, 'COMMAND_NOT_ALLOWED', `command not allowed in this slice: ${env.command}`); return;
      }
      await runCommand(env);
    }

    // Returns the next complete frame including its LF, or null when only a
    // partial frame remains (then held in `carry`, bounded by MAX_FRAME_BYTES).
    // Oversize input fails the host and returns null.
    function takeLine() {
      const nl = pending.indexOf(0x0a, cursor);
      if (nl === -1) {
        if (carry.length + pending.length - cursor > MAX_FRAME_BYTES) {
          fail(`input exceeds ${MAX_FRAME_BYTES} bytes without a complete frame`);
          return null;
        }
        if (pending.length > cursor) {
          carry = carry.length === 0 && cursor === 0
            ? pending
            : Buffer.concat([carry, pending.subarray(cursor)]);
        }
        pending = EMPTY;
        cursor = 0;
        return null;
      }
      if (carry.length + nl + 1 - cursor > MAX_FRAME_BYTES) {
        fail(`malformed frame (MESSAGE_TOO_LARGE): frame exceeds ${MAX_FRAME_BYTES} bytes`);
        return null;
      }
      const line = carry.length === 0
        ? pending.subarray(cursor, nl + 1)
        : Buffer.concat([carry, pending.subarray(cursor, nl + 1)]);
      carry = EMPTY;
      cursor = nl + 1;
      return line;
    }

    // Consumes held input one frame at a time, so a large coalesced chunk of
    // individually valid frames never queues closures or envelopes
    // proportional to its size. Input is paused while any request or
    // backpressured response is active and resumed only after the held input
    // is consumed.
    async function pump() {
      if (pumping || done) return;
      pumping = true;
      let paused = false;
      try {
        while (!done) {
          const line = takeLine();
          if (line === null) break;
          if (!paused) {
            paused = true;
            if (has(input, 'pause')) { try { input.pause(); } catch { /* best effort */ } }
          }
          try { await handleLine(line); }
          catch (err) { diagnose(`request handler threw: ${err?.message ?? err}`); }
        }
      } finally {
        pumping = false;
        if (!done) {
          if (eof) {
            if (carry.length > 0 || cursor < pending.length) fail('unterminated frame at end of input');
            else finish();
          } else if (paused && has(input, 'resume')) {
            try { input.resume(); } catch { /* best effort */ }
          }
        }
      }
    }

    function onData(chunk) {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (cursor < pending.length) {
        // A chunk landed while one is still being consumed (a paused stream
        // holds delivery back); merge so the active pump sees every byte.
        pending = Buffer.concat([pending.subarray(cursor), buf]);
      } else {
        pending = buf; // hold the chunk itself and consume it through `cursor`
      }
      cursor = 0;
      if (pumping) return; // the active pump consumes the appended bytes next
      pump().catch((err) => fail(`input pump failed: ${err?.message ?? err}`));
    }

    function onEof() {
      if (eof || done) return;
      eof = true;
      if (pumping) return; // the active pump settles once it drains
      if (carry.length > 0 || cursor < pending.length) fail('unterminated frame at end of input');
      else finish();
    }

    function onInputError(err) { fail(`input error: ${err?.message ?? err}`); }

    async function start() {
      let ready;
      try {
        ready = encodeFrame({ v: 1, type: 'event', requestId: null, generation,
          event: 'ready', payload: { pid: process.pid, protocolVersion: PROTOCOL_VERSION } });
      } catch (err) { fail(`cannot encode ready event: ${err?.message ?? err}`); return; }
      if (!(await writeFrame(ready))) { finish(); return; }
      if (has(input, 'on')) {
        input.on('data', onData);
        input.on('end', onEof);
        input.on('close', onEof);
        input.on('error', onInputError);
      } else fail('input stream is not readable');
    }

    start().catch((err) => fail(`startup failed: ${err?.message ?? err}`));
  });
}

const invokedAsEntryPoint = (() => {
  try {
    return typeof process.argv?.[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch { return false; }
})();

if (invokedAsEntryPoint) {
  runHost({
    // Real owner-fatal: exit nonzero and close stdout so the Rust owner sees
    // EOF, poisons the connection and terminates the owned job tree.
    // process.exit stays on this executable-entry path only; unit tests
    // inject their own callback through runHost options.
    onFatal: (reason) => {
      try { process.stderr.write(`host: fatal ${reason ?? 'unknown failure'}\n`); } catch { /* best effort */ }
      try { process.stdout.destroy(); } catch { /* best effort */ }
      process.exit(1);
    },
  }).then(() => {
    try { process.stdin.destroy(); } catch { /* best effort */ }
  }).catch((err) => {
    try { process.stderr.write(`host: fatal ${err?.message ?? err}\n`); } catch { /* best effort */ }
    process.exitCode = 1;
    try { process.stdin.destroy(); } catch { /* best effort */ }
  });
}
