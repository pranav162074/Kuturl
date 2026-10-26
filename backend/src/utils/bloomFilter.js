const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const murmur3 = (text, seed) => {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    let k = Math.imul(text.charCodeAt(i), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    hash ^= k;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }
  hash ^= text.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

export const sizeFor = (capacity, falsePositiveRate) => {
  const bits = Math.ceil((-capacity * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
  const hashes = Math.max(1, Math.round((bits / capacity) * Math.LN2));
  return { bits, hashes };
};

export const createBloomFilter = ({ capacity, falsePositiveRate }) => {
  if (!(capacity >= 1) || !(falsePositiveRate > 0 && falsePositiveRate < 1)) {
    throw new RangeError('capacity must be at least 1 and falsePositiveRate between 0 and 1');
  }

  const { bits, hashes } = sizeFor(capacity, falsePositiveRate);
  const words = new Uint32Array(Math.ceil(bits / 32));
  let count = 0;

  const positions = (value) => {
    const first = fnv1a(value);
    const step = murmur3(value, 0x9747b28c) | 1;
    const result = new Array(hashes);
    for (let i = 0; i < hashes; i += 1) result[i] = ((first + Math.imul(i, step)) >>> 0) % bits;
    return result;
  };

  const add = (value) => {
    for (const position of positions(value)) words[position >>> 5] |= 1 << (position & 31);
    count += 1;
  };

  const mightContain = (value) => {
    for (const position of positions(value)) {
      if ((words[position >>> 5] & (1 << (position & 31))) === 0) return false;
    }
    return true;
  };

  const estimatedFalsePositiveRate = () => (1 - Math.exp((-hashes * count) / bits)) ** hashes;

  return {
    add,
    mightContain,
    estimatedFalsePositiveRate,
    get count() {
      return count;
    },
    capacity,
    bits,
    hashes,
    bytes: words.byteLength,
  };
};
