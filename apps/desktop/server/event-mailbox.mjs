// Orch event-mailbox v1 – bounded FIFO for Codex conversation
// MAILBOX_MAX_EVENTS = 256, MAILBOX_MAX_BYTES = 524288,
// MAILBOX_BATCH_BYTES = 131072, MAILBOX_MAX_BATCH = 32

export const MAILBOX_MAX_EVENTS = 256;
export const MAILBOX_MAX_BYTES = 524288;
export const MAILBOX_BATCH_BYTES = 131072;
export const MAILBOX_MAX_BATCH = 32;

/**
 * createEventMailbox() returns { push, drain, size, bytes }
 * Pure synchronous, no dependencies except Buffer.byteLength.
 */
export function createEventMailbox() {
  // Internal queue: array of { event, serializedBytes }
  const queue = [];
  let totalBytes = 0;

  // Helper: serialize event to JSON string, return { json, bytes }
  function serialize(event) {
    const json = JSON.stringify(event);
    if (typeof json !== 'string') throw new Error('serialization failed');
    const bytes = Buffer.byteLength(json, 'utf8');
    return { json, bytes };
  }

  // Validate event is a plain object (not null, not array, not function etc.)
  function isPlainObject(value) {
    if (typeof value !== 'object' || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  // Deep clone via JSON parse/stringify to snapshot the event
  function deepClone(event) {
    const json = JSON.stringify(event);
    if (typeof json !== 'string') throw new Error('event not serializable');
    const cloned = JSON.parse(json);
    if (!isPlainObject(cloned)) throw new Error('event must clone to plain object');
    return cloned;
  }

  // Coalesce check: returns true if two events can be merged per spec
  function canCoalesce(a, b) {
    // Must both be kind:'message_delta' events (discriminator is kind, not type)
    if (a.event.kind !== 'message_delta' || b.event.kind !== 'message_delta') return false;
    // Required fields all nonempty strings and exactly equal
    const requiredFields = ['sessionId','turnId','harness','nativeThreadId','nativeTurnId','nativeItemId'];
    for (const field of requiredFields) {
      const valA = a.event[field];
      const valB = b.event[field];
      if (typeof valA !== 'string' || valA === '' || typeof valB !== 'string' || valB === '' || valA !== valB) return false;
    }
    // Other arbitrary fields (except text) must be equal
    const aKeys = Object.keys(a.event).filter(k => k !== 'text');
    const bKeys = Object.keys(b.event).filter(k => k !== 'text');
    // Check that both have same set of keys (order not normalized)
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b.event, key)) return false;
      // Deep equality? For simplicity, use JSON.stringify comparison for non-text fields
      if (JSON.stringify(a.event[key]) !== JSON.stringify(b.event[key])) return false;
    }
    // Coalesce only when BOTH text fields are strings; never fabricate text
    if (typeof a.event.text !== 'string' || typeof b.event.text !== 'string') return false;
    // Ensure merged text UTF8 <= 32768
    const mergedText = a.event.text + b.event.text;
    const mergedBytes = Buffer.byteLength(mergedText, 'utf8');
    if (mergedBytes > 32768) return false;
    return true;
  }

  // Merge two events into one (preserve text byte-for-byte including whitespace)
  function mergeEvents(a, b) {
    const merged = { ...a.event, text: a.event.text + b.event.text };
    // Re-serialize merged event
    const { json, bytes } = serialize(merged);
    return { event: merged, json, bytes };
  }

  // push: accepts plain JSON object, snapshots it
  function push(event) {
    // Validate plain object
    if (!isPlainObject(event)) throw new Error('push requires plain object');
    // Deep clone to snapshot
    const cloned = deepClone(event);
    // Serialize cloned event
    const { json, bytes } = serialize(cloned);
    // Check single event size <= MAILBOX_BATCH_BYTES
    if (bytes > MAILBOX_BATCH_BYTES) throw new Error('event serialized bytes exceed MAILBOX_BATCH_BYTES');
    // Also ensure that this event as sole head of a batch would fit within MAILBOX_BATCH_BYTES
    // Framing for 1 event: '[' + ']' = 2 bytes, no commas
    const headFramingBytes = 2;
    if (bytes + headFramingBytes > MAILBOX_BATCH_BYTES) throw new Error('event too large to ever be drained as head');
    // Validate the retained/coalesced result, not a duplicate standalone entry:
    // a merge adds no new entry, so it must not be blocked by the standalone
    // count precheck. Compute the merge candidate before any capacity check.
    const entry = { event: cloned, json, bytes };
    let pendingMerge = null;
    if (queue.length > 0) {
      const last = queue[queue.length - 1];
      if (canCoalesce(last, entry)) {
        const merged = mergeEvents(last, entry);
        // A merge must also fit the head batch bound, otherwise the merged
        // head could never drain; fall through to separate enqueue then.
        if (merged.bytes + headFramingBytes <= MAILBOX_BATCH_BYTES) {
          pendingMerge = merged;
        }
      }
    }
    if (pendingMerge !== null) {
      // Merging replaces the last entry: count unchanged, so only the total
      // byte cap applies. Failure leaves the queue untouched (atomic).
      const last = queue[queue.length - 1];
      const bytesDiff = pendingMerge.bytes - last.bytes;
      if (totalBytes + bytesDiff > MAILBOX_MAX_BYTES) throw new Error('coalesced event exceeds max bytes');
      queue[queue.length - 1] = { event: pendingMerge.event, json: pendingMerge.json, bytes: pendingMerge.bytes };
      totalBytes += bytesDiff;
      return; // coalesced, no new entry added
    }
    // No coalesce: check queue capacity before mutation (atomic on overflow)
    if (queue.length >= MAILBOX_MAX_EVENTS) throw new Error('queue full (max events)');
    if (totalBytes + bytes > MAILBOX_MAX_BYTES) throw new Error('queue full (max bytes)');
    // No coalesce: add new entry
    queue.push(entry);
    totalBytes += bytes;
  }

  // drain: returns FIFO prefix array of <=32 events whose JSON array bytes <=128KiB
  function drain() {
    if (queue.length === 0) return [];
    // Determine how many events to drain
    let count = 0;
    let batchBytes = 0;
    // Framing bytes: '[' + ']' = 2 bytes, commas between events: (count-1) bytes
    // We'll compute after we know count.
    // We'll iterate until adding next event would exceed MAILBOX_MAX_BATCH or batchBytes+comma+eventBytes > MAILBOX_BATCH_BYTES
    const maxBatch = MAILBOX_MAX_BATCH;
    const maxBatchBytes = MAILBOX_BATCH_BYTES;
    let eventsToDrain = [];
    for (let i = 0; i < queue.length && i < maxBatch; i++) {
      const entry = queue[i];
      // Estimate framing: for k events, array bytes = 2 + (k-1) + sum eventBytes
      // We'll compute after we decide k.
      // Instead, we can compute total bytes for candidate set including framing.
      const candidateEvents = queue.slice(0, i + 1);
      const candidateCount = candidateEvents.length;
      const candidateEventBytes = candidateEvents.reduce((sum, e) => sum + e.bytes, 0);
      const framingBytes = 2 + (candidateCount > 1 ? candidateCount - 1 : 0); // commas
      const total = candidateEventBytes + framingBytes;
      if (total <= maxBatchBytes) {
        eventsToDrain = candidateEvents;
      } else {
        break;
      }
    }
    if (eventsToDrain.length === 0) return []; // shouldn't happen if first event fits
    // Remove drained events from queue
    const removed = queue.splice(0, eventsToDrain.length);
    const removedBytes = removed.reduce((sum, e) => sum + e.bytes, 0);
    totalBytes -= removedBytes;
    // Return array of event objects (plain, not entries)
    return removed.map(e => e.event);
  }

  // size getter (read-only number)
  function size() {
    return queue.length;
  }

  // bytes getter (read-only number)
  function bytes() {
    return totalBytes;
  }

  return {
    push,
    drain,
    get size() { return size(); },
    get bytes() { return bytes(); }
  };
}
