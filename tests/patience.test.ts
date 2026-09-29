import { describe, it, expect } from "vitest";
import { applyPatience, shouldWarn, inMistrialZone } from "../server/rules/patience.js";
import { CONFIG } from "../shared/config.js";

describe("judge patience (spec §11)", () => {
  const base = 70;
  it("sustained objection against player −8", () => {
    expect(applyPatience(base, base, { kind: "sustainedAgainstPlayer" })).toBe(base - 8);
  });
  it("impropriety tiers", () => {
    expect(applyPatience(base, base, { kind: "impropriety", impropriety: "improper" })).toBe(base - 5);
    expect(applyPatience(base, base, { kind: "impropriety", impropriety: "flagrant" })).toBe(base - 12);
    expect(applyPatience(base, base, { kind: "impropriety", impropriety: "outrageous" })).toBe(base - 20);
    expect(applyPatience(base, base, { kind: "impropriety", impropriety: "proper" })).toBe(base);
  });
  it("contradicted claim −4; overruled excess objection −3; clean +2 capped at base", () => {
    expect(applyPatience(base, base, { kind: "contradictedClaim" })).toBe(base - 4);
    expect(applyPatience(base, base, { kind: "overruledExcessObjection" })).toBe(base - 3);
    expect(applyPatience(base - 1, base, { kind: "cleanExchange" })).toBe(base);
    expect(applyPatience(base, base, { kind: "cleanExchange" })).toBe(base);
  });
  it("floors at 0", () => {
    expect(applyPatience(5, base, { kind: "impropriety", impropriety: "outrageous" })).toBe(0);
  });
  it("warning + mistrial thresholds", () => {
    expect(shouldWarn(CONFIG.WARNING_THRESHOLD)).toBe(true);
    expect(shouldWarn(CONFIG.WARNING_THRESHOLD + 1)).toBe(false);
    expect(inMistrialZone(CONFIG.MISTRIAL_ZONE)).toBe(true);
    expect(inMistrialZone(CONFIG.MISTRIAL_ZONE + 1)).toBe(false);
  });
});
