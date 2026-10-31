import { describe, it, expect } from 'vitest';
import {
  createEventMailbox,
  MAILBOX_MAX_EVENTS,
  MAILBOX_MAX_BYTES,
  MAILBOX_BATCH_BYTES,
  MAILBOX_MAX_BATCH,
} from '../server/event-mailbox.mjs';

const IDS = {
  sessionId: 's',
  turnId: 'u',
  harness: 'codex',
  nativeThreadId: 't',
  nativeTurnId: 'v',
  nativeItemId: 'i',
};

function delta(text, overrides = {}) {
  return { kind: 'message_delta', ...IDS, text, ...overrides };
}

function drainAll(mb) {
  const out = [];
  let batch;
  while ((batch = mb.drain()).length > 0) out.push(...batch);
  return out;
}

describe('event-mailbox constants and getters', () => {
  it('exposes fixed limits and readonly number getters', () => {
    expect(MAILBOX_MAX_EVENTS).toBe(256);
    expect(MAILBOX_MAX_BYTES).toBe(524288);
    expect(MAILBOX_BATCH_BYTES).toBe(131072);
    expect(MAILBOX_MAX_BATCH).toBe(32);
    const mb = createEventMailbox();
    expect(mb.size).toBe(0);
    expect(mb.bytes).toBe(0);
    for (const key of ['size', 'bytes']) {
      const d = Object.getOwnPropertyDescriptor(mb, key);
      expect(typeof d.get).toBe('function');
      expect(d.set).toBeUndefined();
    }
  });
});

describe('coalescing of matching text deltas', () => {
  it('merges eligible deltas at count 256 without growing count', () => {
    const mb = createEventMailbox();
    for (let n = 0; n < MAILBOX_MAX_EVENTS - 1; n++) {
      mb.push(delta(`fill-${n}`, { nativeItemId: `fill-${n}` }));
    }
    expect(mb.size).toBe(255);
    mb.push(delta('a')); // 256th entry, eligible head for merge
    expect(mb.size).toBe(256);
    expect(() => mb.push(delta('b'))).not.toThrow(); // must merge, not hit count cap
    expect(mb.size).toBe(256);
    const all = drainAll(mb);
    expect(all).toHaveLength(256);
    expect(all[255].text).toBe('ab');
  });

  it('never fabricates text: undefined + string stays separate', () => {
    const mb = createEventMailbox();
    const noText = { kind: 'message_delta', ...IDS };
    mb.push(noText);
    mb.push(delta('b'));
    expect(mb.size).toBe(2);
    const [first, second] = drainAll(mb);
    expect('text' in first).toBe(false);
    expect(second.text).toBe('b');
  });

  it('keeps valid plain-JSON events without string text separate and intact', () => {
    const mb = createEventMailbox();
    mb.push({ kind: 'message_delta', ...IDS, text: 1 });
    mb.push({ kind: 'message_delta', ...IDS, text: 2 });
    expect(mb.size).toBe(2);
    const [first, second] = drainAll(mb);
    expect(first.text).toBe(1);
    expect(second.text).toBe(2);
  });

  it('merges exactly at the 32768 UTF8-byte text boundary, splits above it', () => {
    const at = createEventMailbox();
    at.push(delta('a'.repeat(16384)));
    at.push(delta('a'.repeat(16384)));
    expect(at.size).toBe(1);
    expect(drainAll(at)[0].text).toBe('a'.repeat(32768));

    const over = createEventMailbox();
    over.push(delta('a'.repeat(16384)));
    over.push(delta('a'.repeat(16385)));
    expect(over.size).toBe(2);
  });

  it('does not merge when the merged entry would exceed the head batch bound', () => {
    const mb = createEventMailbox();
    const meta = 'x'.repeat(102000);
    mb.push({ ...delta('a'.repeat(15000)), metadata: meta });
    mb.push({ ...delta('b'.repeat(15000)), metadata: meta });
    expect(mb.size).toBe(2); // separate valid entries, not one undrainable head
    const first = mb.drain();
    expect(first).toHaveLength(1);
    expect(first[0].text).toBe('a'.repeat(15000));
    const second = mb.drain();
    expect(second).toHaveLength(1);
    expect(second[0].text).toBe('b'.repeat(15000));
    expect(mb.size).toBe(0);
  });
});

describe('coalescing boundaries', () => {
  it('uses kind (not type) as the discriminator', () => {
    const mb = createEventMailbox();
    mb.push({ ...delta('a'), kind: 'other' });
    mb.push({ ...delta('b'), kind: 'other' });
    expect(mb.size).toBe(2); // same IDs but wrong kind: no merge
    const mb2 = createEventMailbox();
    mb2.push({ ...delta('a'), type: 'message_delta' });
    mb2.push({ ...delta('b'), type: 'message_delta' });
    expect(mb2.size).toBe(1); // kind matches, extra equal field is fine
  });

  it.each(Object.keys(IDS))('requires nonempty %s: empty string never coalesces', (field) => {
    const mb = createEventMailbox();
    mb.push(delta('a', { [field]: '' }));
    mb.push(delta('b', { [field]: '' }));
    expect(mb.size).toBe(2);
  });

  it.each(Object.keys(IDS))('requires equal %s: mismatch never coalesces', (field) => {
    const mb = createEventMailbox();
    mb.push(delta('a'));
    mb.push(delta('b', { [field]: `other-${field}` }));
    expect(mb.size).toBe(2);
  });

  it('requires exact equality of other metadata', () => {
    const mb = createEventMailbox();
    mb.push({ ...delta('a'), extra: { n: 1 } });
    mb.push({ ...delta('b'), extra: { n: 2 } });
    expect(mb.size).toBe(2);
    const mb2 = createEventMailbox();
    mb2.push({ ...delta('a'), extra: { n: 1 } });
    mb2.push({ ...delta('b'), extra: { n: 1 } });
    expect(mb2.size).toBe(1);
  });
});

describe('snapshots and input integrity', () => {
  it('deep-snapshots input: later mutation changes neither queue nor bytes', () => {
    const mb = createEventMailbox();
    const ev = { ...delta('hi'), nested: { list: [1, 2] } };
    const before = JSON.parse(JSON.stringify(ev));
    mb.push(ev);
    const expectedBytes = Buffer.byteLength(JSON.stringify(before), 'utf8');
    expect(mb.bytes).toBe(expectedBytes);
    ev.text = 'mutated';
    ev.nested.list.push(3);
    ev.nested.other = true;
    expect(ev).not.toEqual(before); // sanity: the input really changed
    expect(mb.bytes).toBe(expectedBytes); // caller mutation changes neither queue nor bytes
    const [stored] = mb.drain();
    expect(stored).toEqual(before);
    expect(mb.bytes).toBe(0); // drain removed the sole event
  });

  it('never mutates the raw input object', () => {
    const mb = createEventMailbox();
    const ev = delta('x');
    const before = JSON.parse(JSON.stringify(ev));
    mb.push(ev);
    mb.push(delta('y'));
    expect(ev).toEqual(before);
  });
});

describe('UTF8 accounting', () => {
  it('counts multibyte text in UTF8 bytes for the 32768 boundary', () => {
    // 'é' is 2 UTF8 bytes: 16384 of them fill the budget exactly
    const mb = createEventMailbox();
    mb.push(delta('é'.repeat(16384)));
    mb.push(delta(''));
    expect(mb.size).toBe(1);
    const mb2 = createEventMailbox();
    mb2.push(delta('é'.repeat(16384)));
    mb2.push(delta('é'));
    expect(mb2.size).toBe(2);
  });

  it('tracks bytes as serialized UTF8 length', () => {
    const mb = createEventMailbox();
    const ev = { ...delta('héllo世界'), nested: { emoji: '🎉' } };
    mb.push(ev);
    const expected = Buffer.byteLength(JSON.stringify(JSON.parse(JSON.stringify(ev))), 'utf8');
    expect(mb.bytes).toBe(expected);
  });
});

describe('capacity, atomicity and FIFO framing', () => {
  it('rejects the 257th event atomically: queue, order and bytes unchanged', () => {
    const mb = createEventMailbox();
    for (let n = 0; n < MAILBOX_MAX_EVENTS; n++) {
      mb.push(delta(`e-${n}`, { nativeItemId: `id-${n}` }));
    }
    const sizeBefore = mb.size;
    const bytesBefore = mb.bytes;
    expect(() => mb.push(delta('overflow', { nativeItemId: 'overflow' }))).toThrow();
    expect(mb.size).toBe(sizeBefore);
    expect(mb.bytes).toBe(bytesBefore);
    const all = drainAll(mb);
    expect(all).toHaveLength(256);
    expect(all[0].text).toBe('e-0');
    expect(all[255].text).toBe('e-255');
  });

  it('rejects total-bytes overflow atomically', () => {
    const mb = createEventMailbox();
    const big = 'z'.repeat(100000);
    mb.push({ ...delta('a'), metadata: big, nativeItemId: 'b0' });
    mb.push({ ...delta('b'), metadata: big, nativeItemId: 'b1' });
    mb.push({ ...delta('c'), metadata: big, nativeItemId: 'b2' });
    mb.push({ ...delta('d'), metadata: big, nativeItemId: 'b3' });
    mb.push({ ...delta('e'), metadata: big, nativeItemId: 'b4' });
    const sizeBefore = mb.size;
    const bytesBefore = mb.bytes;
    expect(() => mb.push({ ...delta('f'), metadata: big, nativeItemId: 'b5' })).toThrow();
    expect(mb.size).toBe(sizeBefore);
    expect(mb.bytes).toBe(bytesBefore);
    expect(drainAll(mb)).toHaveLength(5);
  });

  it('drains FIFO in batches of <=32 with JSON array <=131072 bytes', () => {
    const mb = createEventMailbox();
    const N = 40;
    for (let n = 0; n < N; n++) {
      mb.push(delta(`msg-${n}`, { nativeItemId: `m-${n}` }));
    }
    const first = mb.drain();
    expect(first).toHaveLength(32);
    expect(first[0].text).toBe('msg-0');
    expect(first[31].text).toBe('msg-31');
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(131072);
    const second = mb.drain();
    expect(second).toHaveLength(8);
    expect(second[0].text).toBe('msg-32');
    expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(131072);
    expect(mb.size).toBe(0);
    expect(mb.bytes).toBe(0);
  });

  it('every accepted head is drainable: no silent drops, no stuck []', () => {
    const mb = createEventMailbox();
    const meta = 'x'.repeat(102000);
    mb.push({ ...delta('a'.repeat(15000)), metadata: meta });
    mb.push({ ...delta('b'.repeat(15000)), metadata: meta });
    let drained = 0;
    let batch;
    while ((batch = mb.drain()).length > 0) {
      drained += batch.length;
      expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(131072);
    }
    expect(drained).toBe(2);
    expect(mb.size).toBe(0);
  });
});

describe('invalid input', () => {
  it.each([['null', null], ['array', []], ['string', 'x'], ['number', 42], ['undefined', undefined]])(
    'rejects %s',
    (_label, value) => {
      expect(() => createEventMailbox().push(value)).toThrow();
    },
  );

  it('rejects cyclic input', () => {
    const cyc = { kind: 'message_delta', ...IDS, text: 'x' };
    cyc.self = cyc;
    expect(() => createEventMailbox().push(cyc)).toThrow();
  });

  it('rejects oversize single events and custom toJSON that leaves plain JSON', () => {
    const mb = createEventMailbox();
    expect(() => mb.push({ ...delta('ok'), padding: 'p'.repeat(131072) })).toThrow();
    expect(mb.size).toBe(0);
    const sneaky = { kind: 'message_delta', toJSON: () => 'not-an-object' };
    expect(() => createEventMailbox().push(sneaky)).toThrow();
  });
});
