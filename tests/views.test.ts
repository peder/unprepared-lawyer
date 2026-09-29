import { describe, it, expect } from "vitest";
import { buildRecordView, buildJuryView } from "../server/trial/state.js";
import type { TrialState } from "../shared/types.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

function baseState(): TrialState {
  return {
    seed: 1,
    caseFile: JSON.parse(JSON.stringify(FIXTURE_CASE)),
    transcript: [
      { seq: 1, round: 1, speaker: "prosecutor", kind: "opening", text: "hidden opening", hiddenFromPlayer: true },
      { seq: 2, round: 1, speaker: "defense", kind: "opening", text: "hello jury" },
    ],
    docsRead: ["D01"],
    jurorLeanings: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, 0.5])),
    jurorReactions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, "😐"])),
    judgePatience: 70,
    judgeWarnings: 0,
    playerObjectionsLeft: 3,
    testimony: {},
    revealedFacts: [],
    factsStatedByWitness: {},
    phase: "P_CROSS",
    readsLeft: 3,
    questionsAskedThisWitness: 0,
    prosecutionWitnessIdx: 0,
    defenseWitnessesCalled: [],
  };
}

describe("view builders — information boundary (spec §9, acceptance #7)", () => {
  it("JURY view never contains truth, facts list, profiles, or unread doc text", () => {
    const s = baseState();
    const jury = JSON.stringify(buildJuryView(s));
    expect(jury).not.toContain(FIXTURE_CASE.truth.slice(0, 30));
    expect(jury).not.toContain("forklift clipped the display");
    expect(jury).not.toContain("Marla Crump");
    // unread doc body must not leak; read doc D01 body is also NOT in jury (only transcript)
    expect(jury).not.toContain("may have clipped something orange");
    // stricken marking present when applicable
    s.transcript.push({ seq: 3, round: 2, speaker: "defense", kind: "question", text: "bad q", stricken: true });
    const jury2 = buildJuryView(s);
    expect(JSON.stringify(jury2)).toContain("STRICKEN");
  });

  it("RECORD view contains truth + full transcript incl. stricken, and limits doc bodies", () => {
    const s = baseState();
    const rec = buildRecordView(s, { witnessId: "W1", examinationType: "cross_defense", currentQuestion: "q?", currentQuestionAskedBy: "defense" });
    const raw = JSON.stringify(rec);
    expect(raw).toContain("truth");
    expect(raw).toContain("hidden opening"); // full record, incl. hidden
    // W1 knows F01/F03 → D01 body (relevant) included; D03 (F06, not known by W1, unread) title-only
    const d03 = rec.documents.find((d) => d.id === "D03")!;
    expect(d03.title).toBeTruthy();
    expect(d03.body).toBeUndefined();
  });

  it("player-supplied text stays in a labeled field", () => {
    const s = baseState();
    const rec = buildRecordView(s, { currentQuestion: "DID THE GOOSE DO IT?", currentQuestionAskedBy: "defense" });
    expect(rec.current_question).toBe("DID THE GOOSE DO IT?");
    expect(rec.current_question_asked_by).toBe("defense");
  });

  it("mid-trial JURY view has no current_leanings; deliberation view does (P2-3)", () => {
    const s = baseState();
    expect("current_leanings" in buildJuryView(s)).toBe(false);
    const d = buildJuryView(s, { includeCurrentLeanings: true, deliberationRound: 2 });
    expect(d.current_leanings).toEqual(s.jurorLeanings);
    expect(d.deliberation_round).toBe(2);
  });

  it("reaction criteria are slugs, not emoji (P2-4)", async () => {
    const { buildCallB } = await import("../server/jev/calls/calls.js");
    const qs = buildCallB({ jurorIds: ["J1"], personas: { J1: "Sea captain: never forgets." } });
    const react = qs["J1_react"];
    expect(react.type).toBe("choice");
    if (react.type === "choice") {
      expect(Object.keys(react.criteria)).toContain("unmoved");
      expect(Object.keys(react.criteria).some((k) => k.includes("😐"))).toBe(false);
      // P1-4: persona present in the reaction question, not identical boilerplate
      expect(react.instructions).toContain("never forgets");
    }
  });
});
