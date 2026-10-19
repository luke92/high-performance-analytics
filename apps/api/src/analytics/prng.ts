/**
 * mulberry32: a 32-bit PRNG using only wrapping uint32 arithmetic, so it ports
 * bit-for-bit to C++ (`uint32_t`). Returns doubles in [0, 1) as `uint32 / 2^32`.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
