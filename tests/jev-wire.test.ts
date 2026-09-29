import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parseJevResponse, fallbackAnswer, type JevQuestion } from "../server/jev/JevClient.js";
import { IMPROPRIETY_LEVELS, CLAIM_STATUSES } from "../server/jev/calls/calls.js";

const here = dirname(fileURLToPath(import.meta.url));
const wire = JSON.parse(readFileSync(join(here, "..", "fixtures", "jev", "sir-whiskers.json"), "utf8"));

const QUESTIONS: Record<string, JevQuestion> = {
  claim_status: { type: "choice", instructions: "q", criteria: CLAIM_STATUSES },
  judge_sustains: { type: "noul", instructions: "q" },
  J3: { type: "noul", instructions: "q" },
  J3_react: { type: "choice", instructions: "q", criteria: { unmoved: "u", shocked: "s", amused: "a" } },
  impropriety: { type: "score", instructions: "q", criteria: IMPROPRIETY_LEVELS },
};

describe("parseJevResponse — real wire format (P0-1)", () => {
  it("parses the recorded fixture: noul in `noul`, legend object → array", () => {
    const res = parseJevResponse(wire, QUESTIONS);
    expect(res.model).toBe("jev-2026-09-15");
    const sustains = res.answers["judge_sustains"];
    expect(sustains.type).toBe("noul");
    if (sustains.type === "noul") expect(sustains.p).toBe(0.22);
    const imp = res.answers["impropriety"];
    expect(imp.type).toBe("score");
    if (imp.type === "score") {
      expect(imp.score).toBe(1);
      expect(imp.legend).toEqual(["proper", "borderline", "improper", "flagrant", "outrageous"]);
    }
    const claim = res.answers["claim_status"];
    if (claim.type === "choice") expect(claim.choice).toBe("supported");
  });

  it("a malformed answer becomes a per-answer fallback, siblings survive", () => {
    const bad = {
      model: "jev-x",
      answers: {
        ...wire.answers,
        judge_sustains: { type: "noul", noul: 1.5 }, // out of range
        J3: { type: "choice", choice: "x", confidence: 1, probabilities: {} }, // wrong type
      },
    };
    const res = parseJevResponse(bad, QUESTIONS);
    const s = res.answers["judge_sustains"];
    if (s.type === "noul") expect(s.p).toBe(0.5);
    else throw new Error("expected noul fallback");
    const j3 = res.answers["J3"];
    if (j3.type === "noul") expect(j3.p).toBe(0.5);
    else throw new Error("expected noul fallback");
    // healthy sibling untouched
    const imp = res.answers["impropriety"];
    if (imp.type === "score") expect(imp.score).toBe(1);
    else throw new Error("expected score");
  });

  it("missing key and unknown choice fall back (never throws)", () => {
    const res = parseJevResponse({ model: "jev-x", answers: {} }, QUESTIONS);
    for (const [k, q] of Object.entries(QUESTIONS)) {
      expect(res.answers[k]).toEqual(fallbackAnswer(k, q, "jev-x"));
    }
  });

  it("garbage envelope → full fallback, no throw", () => {
    const res = parseJevResponse({ nope: true }, QUESTIONS);
    expect(Object.keys(res.answers)).toEqual(Object.keys(QUESTIONS));
  });
});
