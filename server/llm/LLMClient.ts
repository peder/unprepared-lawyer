// LLM interface — provider-agnostic (spec §4). Stubbed for now; swap real provider later.
import type { Witness, CaseFile } from "@shared/types.js";

export interface WitnessRuling {
  stance: string;
  truthful: boolean;
  factId: string; // or "none"
  factStatement: string;
  demeanor: string;
}

export interface VoiceTimings {
  ms: number;
  ttfbMs?: number;
  model?: string;
  finishReason?: string;
  reasoningTokens?: number;
}

/**
 * Review 06 P0-3: facts_stated is COMPUTED in code from the ruling, never
 * trusted from the model. The voice prompt carries only the ruled fact, so a
 * model can't leak what it never saw. Mirrors the stub's semantics.
 */
export function statedForRuling(stance: string, truthful: boolean, factId: string, hasLie: boolean): string[] {
  if (factId === "none") return [];
  if (stance === "confirms" || stance === "partially_confirms" || stance === "volunteers_more") return [factId];
  if (stance === "denies" && !truthful && hasLie) return [factId];
  return [];
}

export interface WitnessVoiceResult {
  answer: string;
  stage_direction?: string;
  facts_stated: string[];
  timings?: VoiceTimings;
}

export interface LLMClient {
  voiceWitness(args: {
    witness: Witness;
    knownFacts: { id: string; statement: string }[];
    testimonySoFar: string;
    /** P2-2: facts already stated by THIS witness — the guardrail allowed-set. */
    priorFactsForWitness: string[];
    questionText: string;
    askerRole: string;
    examinationType: string;
    ruling: WitnessRuling;
    /** Review 05: abort in-flight voice when a prosecutor question is sustained. */
    signal?: AbortSignal;
  }): Promise<WitnessVoiceResult>;
  prosecutorCross(args: { prosecutorName: string; persona: string; witness: Witness; transcript: string; n: number; signal?: AbortSignal }): Promise<string[]>;
  prosecutionClosing(args: { prosecutorName: string; persona: string; transcript: string; signal?: AbortSignal }): Promise<string>;
}

/** Deterministic stub: renders rulings as templated lines (spec §15 fallback style).
 *  Review 06 P2: pools per stance (seeded pick) + facts phrased plainly, so the
 *  fallback still sounds like testimony instead of a metronome. */
export class StubLLMClient implements LLMClient {
  private n = 0;
  constructor(private seed = 0) {}
  private pick<T>(pool: T[]): T {
    // mulberry32 over seed+counter: deterministic per instance, varied across lines.
    let a = (this.seed + this.n++ * 0x9e3779b9) >>> 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return pool[((t ^ (t >>> 14)) >>> 0) % pool.length];
  }
  async voiceWitness(args: LLMClient extends never ? never : {
    witness: Witness;
    knownFacts: { id: string; statement: string }[];
    testimonySoFar: string;
    priorFactsForWitness: string[];
    questionText: string;
    askerRole: string;
    examinationType: string;
    ruling: WitnessRuling;
  }): Promise<WitnessVoiceResult> {
    const { witness, ruling } = args;
    const lie = witness.willLieAbout.find((l) => l.factId === ruling.factId);
    const fact = ruling.truthful ? ruling.factStatement : (lie?.lie ?? "");
    let answer: string;
    const facts_stated = statedForRuling(ruling.stance, ruling.truthful, ruling.factId, Boolean(lie));
    switch (ruling.stance) {
      case "doesnt_know":
        answer = this.pick(["I... don't recall. I wasn't really looking.", "Couldn't say. I had my eyes elsewhere.", "Honestly? No idea. Next question?"]);
        break;
      case "denies":
        answer = fact ? this.pick([`No — that's not how it happened. ${fact}`, `Absolutely not. ${fact}`]) : this.pick(["No. Absolutely not.", "That's wrong, and I was there."]);
        break;
      case "evasive":
        answer = this.pick(["Look, a lot was going on that day, okay?", "Do we have to do this right now? There was a lot happening.", "I'd rather not say. It was chaotic."]);
        break;
      case "rambles":
        answer = this.pick([
          "Oh, that reminds me of my cousin's boat — anyway, yeah, I think so?",
          "Well, see, the thing about that day — my parking was terrible — anyway, probably?",
          "Huh. That takes me back. The weather was something. I'd say yes?",
        ]);
        break;
      case "volunteers_more":
        answer = fact ? this.pick([`Yes, and listen — ${fact}`, `${fact} And nobody asked me that before!`]) : this.pick(["Yes — and there's more nobody's asked about.", "Yes. Also? I saw the whole thing, start to finish."]);
        break;
      case "contradicts_self":
        answer = this.pick(["Okay, forget what I said before — the opposite of that.", "Strike that. I misspoke. It's the other way.", "Hmm, no — actually, reverse everything I just said."]);
        break;
      case "blurts_secret":
        answer = witness.secret ? `Fine! ${witness.secret}` : "Fine! I never returned that library book!";
        break;
      case "partially_confirms":
        answer = fact ? this.pick([`Partly. ${fact} — but it's complicated.`, `Up to a point. ${fact} Then it gets murky.`]) : "Partly, sort of.";
        break;
      default:
        answer = fact ? this.pick([`${fact}`, `Yes — ${fact}`, `That's right. ${fact}`]) : "Yes.";
    }
    // Guardrail: facts_stated ⊆ {chosen fact} ∪ prior — stub only ever states chosen fact.
    return { answer, stage_direction: ruling.demeanor === "nervous" ? "fidgets" : undefined, facts_stated: [...new Set(facts_stated)] };
  }

  async prosecutorCross(_args: { prosecutorName: string; persona: string; witness: Witness; transcript: string; n: number }): Promise<string[]> {
    void _args;
    return ["Isn't it true you barely remember that day at all?", "And you expect this jury to take your word for it?"];
  }

  async prosecutionClosing(_args: { prosecutorName: string; persona: string; transcript: string }): Promise<string> {
    void _args;
    return "Ladies and gentlemen of the jury: the defense is unprepared, the facts are clear, and the goose knows what it did.";
  }
}

export function validateWitnessVoice(
  result: WitnessVoiceResult,
  chosenFact: string,
  priorFacts: string[],
): boolean {
  const allowed = new Set([chosenFact, ...priorFacts]);
  return result.facts_stated.every((f) => allowed.has(f));
}

export type { CaseFile };
