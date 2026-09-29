import { describe, it, expect } from "vitest";
import { validateWitnessVoice, StubLLMClient } from "../server/llm/LLMClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

describe("witness guardrail (spec §7, acceptance #4)", () => {
  it("accepts facts_stated within {chosen} ∪ prior", () => {
    expect(validateWitnessVoice({ answer: "x", facts_stated: ["F01"] }, "F01", [])).toBe(true);
    expect(validateWitnessVoice({ answer: "x", facts_stated: ["F02"] }, "F01", ["F02"])).toBe(true);
    expect(validateWitnessVoice({ answer: "x", facts_stated: [] }, "none", [])).toBe(true);
  });
  it("rejects leaked facts", () => {
    expect(validateWitnessVoice({ answer: "x", facts_stated: ["F99"] }, "F01", [])).toBe(false);
    expect(validateWitnessVoice({ answer: "x", facts_stated: ["F01", "F02"] }, "F01", [])).toBe(false);
  });
  it("stub never leaks across many rulings", async () => {
    const stub = new StubLLMClient();
    const w = FIXTURE_CASE.witnesses[0];
    const stances = ["confirms", "denies", "doesnt_know", "evasive", "rambles", "volunteers_more", "contradicts_self", "blurts_secret", "partially_confirms"];
    for (const stance of stances) {
      for (const truthful of [true, false]) {
        const r = await stub.voiceWitness({
          witness: w,
          knownFacts: w.knows.map((id) => ({ id, statement: id })),
          testimonySoFar: "",
          priorFactsForWitness: [],
          questionText: "q?",
          askerRole: "defense",
          examinationType: "cross_defense",
          ruling: { stance, truthful, factId: "F01", factStatement: "s", demeanor: "calm" },
        });
        expect(validateWitnessVoice(r, "F01", [])).toBe(true);
      }
    }
  });
});
