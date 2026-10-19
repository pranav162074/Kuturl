import { createHmac } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HALF_BITS = 20;
const HALF_MASK = (1 << HALF_BITS) - 1;
const ROUNDS = 4;

export const CODE_LENGTH = 7; // 62^7 is larger than 2^40, so every value fits in 7 characters
export const MAX_ID = 2n ** 40n - 1n;

const toBase62 = (value) => {
  let n = value;
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(CODE_LENGTH, ALPHABET[0]);
};

const fromBase62 = (text) => {
  let n = 0n;
  for (const char of text) n = n * 62n + BigInt(ALPHABET.indexOf(char));
  return n;
};

// A keyed permutation of the numbers 0 to 2^40 - 1: each id maps to exactly one code and
// each code maps back to exactly one id. Because it is a permutation, two ids can never
// produce the same code, however many links exist.
export const createCodec = (secret) => {
  // The Feistel round function: a keyed pseudo-random 20-bit number from one half
  const mix = (round, half) =>
    createHmac('sha256', secret).update(`${round}:${half}`).digest().readUIntBE(0, 3) & HALF_MASK;

  const encode = (id) => {
    const n = typeof id === 'bigint' ? id : BigInt(id);
    if (n < 0n || n > MAX_ID) throw new RangeError('id is out of range for a short code');

    let left = Number(n >> BigInt(HALF_BITS));
    let right = Number(n & BigInt(HALF_MASK));
    for (let round = 0; round < ROUNDS; round += 1) {
      [left, right] = [right, left ^ mix(round, right)];
    }
    return toBase62((BigInt(left) << BigInt(HALF_BITS)) | BigInt(right));
  };

  const decode = (code) => {
    if (!new RegExp(`^[0-9A-Za-z]{${CODE_LENGTH}}$`).test(code)) {
      throw new RangeError('not a valid short code');
    }
    const n = fromBase62(code);
    if (n > MAX_ID) throw new RangeError('not a valid short code');

    let left = Number(n >> BigInt(HALF_BITS));
    let right = Number(n & BigInt(HALF_MASK));
    for (let round = ROUNDS - 1; round >= 0; round -= 1) {
      [left, right] = [right ^ mix(round, left), left];
    }
    return (BigInt(left) << BigInt(HALF_BITS)) | BigInt(right);
  };

  return { encode, decode };
};