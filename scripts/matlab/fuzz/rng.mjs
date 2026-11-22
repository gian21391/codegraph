/**
 * A small seeded random source for the MATLAB fuzzer: the same seed always
 * draws the same sequence, so every failure reproduces from its seed alone.
 */

/** A 32-bit hash of a string or number list (FNV-1a), for deriving sub-seeds. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed || 1;
  }

  /** A float in [0, 1) (mulberry32). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** An integer in [lo, hi]. */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }

  /** One key of `weights` ({ key: weight }), drawn by weight. */
  weighted(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let r = this.next() * entries.reduce((a, [, w]) => a + w, 0);
    for (const [k, w] of entries) if ((r -= w) < 0) return k;
    return entries[entries.length - 1][0];
  }

  /** An independent source for `label`: drawing from it leaves this one where it is. */
  fork(...label) {
    return new Rng(hash32(this.seed, ...label));
  }
}
