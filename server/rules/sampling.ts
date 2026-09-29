// Seeded RNG (mulberry32). All Jev outputs are SAMPLED, never argmax (spec §4).
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample a noul: true with probability p. */
export function sampleNoul(p: number, rng: Rng): boolean {
  return rng() < p;
}

/** Sample a key from a probability map. Keys with 0 weight are never picked. */
export function sampleChoice(probabilities: Record<string, number>, rng: Rng): string {
  const entries = Object.entries(probabilities);
  const total = entries.reduce((s, [, v]) => s + Math.max(0, v), 0);
  if (total <= 0) return entries[0]?.[0] ?? "";
  let r = rng() * total;
  for (const [k, v] of entries) {
    r -= Math.max(0, v);
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/** Scores are choices keyed "0".."N-1". */
export function sampleScore(probabilities: Record<string, number>, rng: Rng): number {
  return Number(sampleChoice(probabilities, rng));
}

export function uniformProbs(keys: string[]): Record<string, number> {
  const p = 1 / Math.max(1, keys.length);
  return Object.fromEntries(keys.map((k) => [k, p]));
}
