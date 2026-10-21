/**
 * Spark packs splat centres as IEEE half floats (two per 32-bit word). One table lookup
 * per coordinate is far cheaper than decoding bits in a hot loop over tens of millions.
 */
let table: Float32Array | null = null;

export function halfTable(): Float32Array {
  if (table) return table;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    t[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return (table = t);
}

/** The three centre halves of splat `i` out of Spark's packed words (word1 lo/hi, word2 lo). */
export function centreHalves(packed: Uint32Array, n: number): Uint16Array {
  const out = new Uint16Array(n * 3);
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 4, d += 3) {
    const w1 = packed[s + 1];
    out[d] = w1 & 0xffff; out[d + 1] = w1 >>> 16; out[d + 2] = packed[s + 2] & 0xffff;
  }
  return out;
}
