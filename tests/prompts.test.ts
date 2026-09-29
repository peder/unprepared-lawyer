import { describe, it, expect } from "vitest";
import { renderWitnessPrompt } from "../server/llm/prompts/prompts.js";

// P2-1: the full §7.1 prompt is the single source of truth — no paraphrase, no dropped rules.
describe("witness prompt (spec §7.1)", () => {
  const prompt = renderWitnessPrompt({
    name: "Marla Crump",
    role: "Fair organizer",
    personality: "Efficient.",
    speechStyle: "Clipped.",
    relationshipToCase: "Reported it.",
    doesNotKnow: "forklifts",
    knownFacts: [{ id: "F01", statement: "Pumpkin weighed 41 lbs." }],
    lies: [{ factId: "F03", lie: "The goose flew it away.", reason: "insurance" }],
    secret: "Ate the last corn dog.",
    testimonySoFar: "Q (defense): hi?\nA: hello.",
    askerRole: "defense",
    examinationType: "cross_defense",
    questionText: "What did you see?",
    stance: "evasive",
    truthful: true,
    factId: "F01",
    factStatement: "Pumpkin weighed 41 lbs.",
    demeanor: "nervous",
  });

  it("carries the ruling and witness data through", () => {
    for (const s of ["Marla Crump", "F01", "evasive", "nervous", "What did you see?", "Ate the last corn dog"]) {
      expect(prompt).toContain(s);
    }
  });

  it("contains all 9 rules verbatim (nothing dropped)", () => {
    const rules = [
      "1–3 short sentences",
      "Only state case facts that are the chosen fact",
      "never new",
      "If Truthful is false",
      'If Stance is "doesnt_know"',
      'unless Stance is "contradicts_self"',
      "false premise",
      "breaking the fourth wall",
      "PG-13",
    ];
    for (const r of rules) expect(prompt).toContain(r);
  });

  it("no unrendered template tokens remain", () => {
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
