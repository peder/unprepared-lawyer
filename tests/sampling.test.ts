import { describe, it, expect } from "vitest";
import { createRng, sampleNoul, sampleChoice, sampleScore } from "../server/rules/sampling.js";

describe("sampling (spec §4: sample, never argmax)", () => {
  it("noul resolves as rng() < p", () => {
    const rng = () => 0.4;
    expect(sampleNoul(0.5, rng)).toBe(true);
    expect(sampleNoul(0.3, rng)).toBe(false);
  });

  it("choice samples proportionally and deterministically with seed", () => {
    const probs = { a: 0.9, b: 0.1 };
    const rng1 = createRng(42);
    const picks = Array.from({ length: 20 }, () => sampleChoice(probs, rng1));
    expect(picks.filter((p) => p === "a").length).toBeGreaterThan(10);
    // same seed → same sequence
    const rng2 = createRng(42);
    const picks2 = Array.from({ length: 20 }, () => sampleChoice(probs, rng2));
    expect(picks).toEqual(picks2);
  });

  it("different seeds diverge (sanity)", () => {
    const probs = { a: 0.5, b: 0.5 };
    const run = (s: number) => {
      const rng = createRng(s);
      return Array.from({ length: 30 }, () => sampleChoice(probs, rng)).join("");
    };
    expect(run(1)).not.toBe(run(99999));
  });

  it("score samples keys 0..N-1", () => {
    const probs = { "0": 0.1, "1": 0.1, "2": 0.8 };
    const rng = createRng(7);
    const s = sampleScore(probs, rng);
    expect([0, 1, 2]).toContain(s);
  });
});
