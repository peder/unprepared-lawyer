import { CONFIG } from "@shared/config.js";
import type { ImproprietyLevel, ClaimStatus } from "@shared/types.js";

export interface PatienceEvent {
  kind:
    | "sustainedAgainstPlayer"
    | "impropriety"
    | "contradictedClaim"
    | "overruledExcessObjection"
    | "cleanExchange";
  impropriety?: ImproprietyLevel;
  claimStatus?: ClaimStatus;
}

/** Pure patience math (spec §11). Returns { patience, warned }. */
export function applyPatience(
  current: number,
  base: number,
  ev: PatienceEvent,
): number {
  const d = CONFIG.PATIENCE_DELTAS;
  let delta = 0;
  switch (ev.kind) {
    case "sustainedAgainstPlayer":
      delta = d.sustainedAgainstPlayer;
      break;
    case "impropriety":
      if (ev.impropriety === "improper") delta = d.improper;
      else if (ev.impropriety === "flagrant") delta = d.flagrant;
      else if (ev.impropriety === "outrageous") delta = d.outrageous;
      break;
    case "contradictedClaim":
      delta = d.contradictedClaim;
      break;
    case "overruledExcessObjection":
      delta = d.overruledExcessObjection;
      break;
    case "cleanExchange":
      delta = d.cleanExchange;
      break;
  }
  return Math.min(base, Math.max(0, current + delta));
}

export function shouldWarn(patience: number): boolean {
  return patience <= CONFIG.WARNING_THRESHOLD;
}

export function inMistrialZone(patience: number): boolean {
  return patience <= CONFIG.MISTRIAL_ZONE;
}
