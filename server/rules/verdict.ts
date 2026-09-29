import { CONFIG } from "@shared/config.js";
import type { Rng } from "./sampling.js";
import { sampleNoul } from "./sampling.js";

/** Spec §10.5: sample each juror's vote from their leaning. */
export function castVotes(
  leanings: Record<string, number>,
  rng: Rng,
): { votes: Record<string, "guilty" | "not_guilty">; outcome: "guilty" | "not_guilty" | "hung_jury" } {
  const votes: Record<string, "guilty" | "not_guilty"> = {};
  for (const [id, p] of Object.entries(leanings)) {
    votes[id] = sampleNoul(p, rng) ? "guilty" : "not_guilty";
  }
  const vals = Object.values(votes);
  if (vals.every((v) => v === "not_guilty")) return { votes, outcome: "not_guilty" };
  if (vals.every((v) => v === "guilty")) return { votes, outcome: "guilty" };
  return { votes, outcome: "hung_jury" };
}

/** Spec §8.5 smoothing: new = prev + MOMENTUM * (p - prev). */
export function smoothLeaning(prev: number, p: number): number {
  return prev + CONFIG.JURY_MOMENTUM * (p - prev);
}
