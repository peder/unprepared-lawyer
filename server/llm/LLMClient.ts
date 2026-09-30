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

/** Deterministic stub: renders rulings as templated lines (spec §15 fallback style). */
export class StubLLMClient implements LLMClient {
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
    let answer: string;
    const facts_stated: string[] = [];
    if (ruling.factId !== "none" && (ruling.stance === "confirms" || ruling.stance === "partially_confirms" || ruling.stance === "volunteers_more")) {
      facts_stated.push(ruling.factId);
    }
    switch (ruling.stance) {
      case "doesnt_know":
        answer = "I... don't recall. I wasn't really looking.";
        break;
      case "denies":
        answer = ruling.truthful ? "No — that's not how it happened." : lie ? lie.lie : "No. Absolutely not.";
        if (!ruling.truthful && lie) facts_stated.push(ruling.factId);
        break;
      case "evasive":
        answer = "Look, a lot was going on that day, okay?";
        break;
      case "rambles":
        answer = "Oh, that reminds me of my cousin's boat — anyway, yeah, I think so?";
        break;
      case "volunteers_more":
        answer = ruling.truthful ? `Yes, that's right. ${ruling.factStatement}` : lie ? `Yes. ${lie.lie}` : "Yes, and there's more I'm not supposed to say.";
        break;
      case "contradicts_self":
        answer = "Okay, forget what I said before — the opposite of that.";
        break;
      case "blurts_secret":
        answer = witness.secret ? `Fine! ${witness.secret}` : "Fine! I never returned that library book!";
        break;
      case "partially_confirms":
        answer = ruling.truthful ? `Partly. ${ruling.factStatement} — but it's complicated.` : lie ? `Partly. ${lie.lie}` : "Partly, sort of.";
        break;
      default:
        answer = ruling.truthful
          ? `Yes, that's right. ${ruling.factStatement}`
          : lie
            ? lie.lie
            : "Yes.";
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
