import { describe, it, expect } from "vitest";
import { castVotes, smoothLeaning } from "../server/rules/verdict.js";
import { createRng } from "../server/rules/sampling.js";
import { CONFIG } from "../shared/config.js";

describe("verdict (spec §10.5)", () => {
  it("unanimous not-guilty → win", () => {
    const leanings = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, 0]));
    const { outcome, votes } = castVotes(leanings, createRng(1));
    expect(outcome).toBe("not_guilty");
    expect(Object.values(votes).every((v) => v === "not_guilty")).toBe(true);
  });
  it("unanimous guilty → loss", () => {
    const leanings = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, 1]));
    expect(castVotes(leanings, createRng(1)).outcome).toBe("guilty");
  });
  it("split → hung jury", () => {
    const leanings: Record<string, number> = {};
    for (let i = 1; i <= 12; i++) leanings[`J${i}`] = i <= 6 ? 0 : 1;
    expect(castVotes(leanings, createRng(1)).outcome).toBe("hung_jury");
  });
  it("smoothing drifts, not jumps (MOMENTUM=0.5)", () => {
    expect(smoothLeaning(0.5, 1)).toBeCloseTo(0.5 + CONFIG.JURY_MOMENTUM * 0.5);
    expect(smoothLeaning(0.4, 0.4)).toBeCloseTo(0.4);
  });
  it("seeded RNG makes votes reproducible", () => {
    const leanings = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, 0.5]));
    const a = castVotes(leanings, createRng(99));
    const b = castVotes(leanings, createRng(99));
    expect(a).toEqual(b);
  });
});
