import { describe, it, expect } from "vitest";
import { TrialEngine } from "../server/trial/TrialEngine.js";
import { MockJevClient } from "../server/jev/JevClient.js";
import { StubLLMClient } from "../server/llm/LLMClient.js";
import { visibleToPlayer } from "../shared/types.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";
import { CONFIG } from "../shared/config.js";

function engineWith() {
  const jev = new MockJevClient();
  const eng = new TrialEngine(JSON.parse(JSON.stringify(FIXTURE_CASE)), jev, new StubLLMClient(), { seed: 5 });
  return { eng, jev };
}

// Review 04 P0-1: the PLAYER view never shows hidden entries.
describe("player view boundary", () => {
  it("setupPriors hides the prosecution opening from the player but not the jury", async () => {
    const { eng, jev } = engineWith();
    await eng.setupPriors();
    const opening = eng.state.transcript.find((t) => t.speaker === "prosecutor" && t.kind === "opening")!;
    expect(opening.hiddenFromPlayer).toBe(true);
    expect(visibleToPlayer(opening)).toBe(false);
    const note = eng.state.transcript.find((t) => t.kind === "note")!;
    expect(visibleToPlayer(note)).toBe(true);
    // The log keeps everything; the player formatter drops hidden lines.
    const playerLines = eng.state.transcript.filter(visibleToPlayer).map((t) => t.text);
    expect(playerLines.some((t) => t.includes("the goose took the pumpkin"))).toBe(false);
    expect(playerLines.some((t) => t.includes("drifted off"))).toBe(true);
    // Call P still saw the speech (jury view intact).
    const juryStates = jev.log.map((r) => JSON.stringify(r.state));
    expect(juryStates.some((s) => s.includes("the goose took the pumpkin"))).toBe(true);
  });
});

// Review 04 P1-4: word caps enforced in the engine — the 151st word never reaches Jev.
describe("opening/closing word caps", () => {
  it("over-long opening is truncated before transcript and Jev", async () => {
    const { eng, jev } = engineWith();
    await eng.setupPriors();
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const res = await eng.submitOpening(words);
    expect(res.truncated).toBe(true);
    const entry = eng.state.transcript.find((t) => t.speaker === "defense" && t.kind === "opening")!;
    expect(entry.text.split(/\s+/)).toHaveLength(CONFIG.MAX_WORDS_OPENING);
    const aOpen = jev.log.find((r) => "claim_status" in r.questions && !("witness_stance" in r.questions))!;
    const sent = (aOpen.state as Record<string, unknown>)["current_question"] as string;
    expect(sent.split(/\s+/).length).toBeLessThanOrEqual(CONFIG.MAX_WORDS_OPENING);
    expect(sent).not.toContain("word199");
  });

  it("short statements pass through untouched", async () => {
    const { eng } = engineWith();
    await eng.setupPriors();
    const res = await eng.submitOpening("Geese cannot carry pumpkins.");
    expect(res.truncated).toBe(false);
  });
});

// Review 04 P2: re-reads consume the phase's read slot.
describe("re-read accounting", () => {
  it("re-reading the same doc still costs a read", async () => {
    const { eng } = engineWith();
    await eng.setupPriors();
    await eng.submitOpening("Hi.");
    await eng.readDoc("D01");
    expect(eng.status().readsLeft).toBe(4);
    eng.state.phase = "P_READ"; // simulate next witness's read phase
    await eng.readDoc("D01");
    expect(eng.status().readsLeft).toBe(3);
    expect(eng.state.docsRead).toEqual(["D01"]);
  });
});
