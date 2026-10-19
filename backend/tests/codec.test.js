import { describe, it, expect } from 'vitest';
import { createCodec, MAX_ID, CODE_LENGTH } from '../src/utils/codec.js';

const codec = createCodec('unit-test-secret-1234567890');

describe('code generator', () => {
  it('always produces fixed-length base62 codes', () => {
    for (const id of [0n, 1n, 2n, 1000n, 123456789n, MAX_ID]) {
      const code = codec.encode(id);
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it('accepts ids given as strings, as Postgres returns them', () => {
    expect(codec.encode('42')).toBe(codec.encode(42n));
  });

  it('round trips: decoding gives back the original id', () => {
    const step = (MAX_ID + 1n) / 2000n; // spread across the whole range
    const ids = [0n, 1n, MAX_ID];
    for (let i = 0n; i < 2000n; i += 1n) ids.push(i * step);

    for (const id of ids) {
      expect(codec.decode(codec.encode(id))).toBe(id);
    }
  });

  it('never gives two ids the same code', () => {
    const codes = new Set();
    for (let id = 1; id <= 50_000; id += 1) codes.add(codec.encode(id));
    expect(codes.size).toBe(50_000);
  });

  it('does not look sequential', () => {
    let sameFirstChar = 0;
    for (let id = 1; id <= 1000; id += 1) {
      if (codec.encode(id)[0] === codec.encode(id + 1)[0]) sameFirstChar += 1;
    }
    // Neighbouring ids would share a first character most of the time if codes were
    // sequential. For scrambled codes it should happen about 1 time in 62.
    expect(sameFirstChar).toBeLessThan(100);
  });

  it('gives different codes under a different secret', () => {
    const other = createCodec('a-completely-different-secret');
    let differing = 0;
    for (let id = 1; id <= 1000; id += 1) {
      if (codec.encode(id) !== other.encode(id)) differing += 1;
    }
    expect(differing).toBeGreaterThan(990);
  });

  it('rejects ids outside the supported range', () => {
    expect(() => codec.encode(-1n)).toThrow(RangeError);
    expect(() => codec.encode(MAX_ID + 1n)).toThrow(RangeError);
    expect(() => codec.encode('not a number')).toThrow();
  });

  it('rejects codes that are malformed when decoding', () => {
    expect(() => codec.decode('abc')).toThrow(RangeError);
    expect(() => codec.decode('abc-123')).toThrow(RangeError);
    expect(() => codec.decode('ZZZZZZZ')).toThrow(RangeError); // larger than any real code
  });
});