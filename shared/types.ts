// Shared canonical types — abridged from spec §5.
// JEV DECIDES, LLM VOICES, CODE KEEPS SCORE. Keep this file dependency-free.

export type FactId = string;
export type WitnessId = string;
export type JurorId = string;
export type DocId = string;

export interface Fact {
  id: FactId;
  statement: string;
  favors: "prosecution" | "defense" | "neutral";
  importance: 1 | 2 | 3;
}

export interface CaseDocument {
  id: DocId;
  bin: string;
  title: string;
  body: string;
  factIds: FactId[];
}

export interface Witness {
  id: WitnessId;
  name: string;
  role: string;
  calledBy: "prosecution" | "defense";
  personality: string;
  speechStyle: string;
  relationshipToCase: string;
  knows: FactId[];
  willLieAbout: { factId: FactId; lie: string; reason: string }[];
  doesNotKnow: string;
  secret?: string;
}

export interface JurorProfile {
  id: JurorId;
  label: string;
  persona: string;
}

export interface JudgeProfile {
  name: string;
  persona: string;
  strictness: 1 | 2 | 3 | 4 | 5;
  basePatience: number;
}

export interface ProsecutorProfile {
  name: string;
  persona: string;
  objectionTendency: 1 | 2 | 3 | 4 | 5;
}

export interface CaseFile {
  caseTitle: string;
  defendant: string;
  charge: string;
  truth: string;
  facts: Fact[];
  documents: CaseDocument[];
  witnesses: Witness[];
  judge: JudgeProfile;
  prosecutor: ProsecutorProfile;
  jurors: JurorProfile[];
  prosecutionOpening: string;
  prosecutionDirectPlan: Record<WitnessId, string[]>;
}

export interface TranscriptEntry {
  seq: number;
  round: 1 | 2 | 3 | 4;
  speaker: "prosecutor" | "defense" | "judge" | WitnessId;
  kind: "opening" | "question" | "answer" | "objection" | "ruling" | "closing" | "note";
  text: string;
  stricken?: boolean;              // jury was instructed to disregard
  hiddenFromPlayer?: boolean;      // prosecution opening
}

// Review 04 P0-1: the PLAYER view boundary (spec §9). Player-facing
// print/render uses this; logs and Jev views keep the full entry.
export function visibleToPlayer(entry: TranscriptEntry): boolean {
  return entry.hiddenFromPlayer !== true;
}

export interface TrialState {
  seed: number;
  caseFile: CaseFile;
  transcript: TranscriptEntry[];
  docsRead: DocId[];
  jurorLeanings: Record<JurorId, number>;             // P(guilty), 0..1
  jurorReactions: Record<JurorId, string>;            // latest emoji
  judgePatience: number;                              // 0..100
  judgeWarnings: number;
  playerObjectionsLeft: number;
  testimony: Record<WitnessId, TranscriptEntry[]>;
  revealedFacts: FactId[];                            // facts surfaced in open court
  factsStatedByWitness: Record<WitnessId, FactId[]>;  // P2-2: per-witness guardrail set
  // P1-1: authoritative phase machine (server owns limits; client only displays)
  phase: Phase;
  readsLeft: number;
  questionsAskedThisWitness: number;
  currentWitnessId?: WitnessId;
  prosecutionWitnessIdx: number;
  defenseWitnessesCalled: WitnessId[];
  outcome?: "not_guilty" | "guilty" | "hung_jury" | "mistrial";
}

// P1-1: trial phase machine (spec §3).
export type Phase =
  | "SETUP"
  | "OPENING"
  | "P_READ" | "P_DIRECT" | "P_CROSS"
  | "D_SELECT" | "D_READ" | "D_DIRECT" | "D_CROSS"
  | "FINAL_READ" | "CLOSING"
  | "DELIBERATION" | "DONE";

export type ExaminationType = "direct_prosecution" | "cross_defense" | "direct_defense" | "cross_prosecution";

export type JurorReaction =
  | "😐"
  | "🤔"
  | "😤"
  | "😂"
  | "😱"
  | "😴"
  | "🙄"
  | "😏";

export const JUROR_REACTIONS: JurorReaction[] = ["😐", "🤔", "😤", "😂", "😱", "😴", "🙄", "😏"];

// P2-4: Jev speaks slugs; code maps slugs → emoji for display.
export type JurorReactionSlug =
  | "unmoved"
  | "intrigued"
  | "annoyed"
  | "amused"
  | "shocked"
  | "dozing"
  | "unconvinced"
  | "knew_it";

export const REACTION_EMOJI: Record<JurorReactionSlug, JurorReaction> = {
  unmoved: "😐",
  intrigued: "🤔",
  annoyed: "😤",
  amused: "😂",
  shocked: "😱",
  dozing: "😴",
  unconvinced: "🙄",
  knew_it: "😏",
};

export const REACTION_DESCRIPTIONS: Record<JurorReactionSlug, string> = {
  unmoved: "unmoved",
  intrigued: "intrigued",
  annoyed: "annoyed",
  amused: "amused",
  shocked: "shocked",
  dozing: "dozing",
  unconvinced: "unconvinced",
  knew_it: "knew it all along",
};

export type WitnessStance =
  | "confirms"
  | "partially_confirms"
  | "denies"
  | "doesnt_know"
  | "evasive"
  | "rambles"
  | "volunteers_more"
  | "contradicts_self"
  | "blurts_secret";

export const WITNESS_STANCES: WitnessStance[] = [
  "confirms",
  "partially_confirms",
  "denies",
  "doesnt_know",
  "evasive",
  "rambles",
  "volunteers_more",
  "contradicts_self",
  "blurts_secret",
];

export type WitnessDemeanor =
  | "calm"
  | "nervous"
  | "defensive"
  | "hostile"
  | "delighted"
  | "confused"
  | "bored";

export type ClaimStatus = "supported" | "contradicted" | "not_in_record" | "no_claim";

export type ImproprietyLevel = "proper" | "borderline" | "improper" | "flagrant" | "outrageous";

export type ObjectionGrounds =
  | "leading"
  | "hearsay"
  | "relevance"
  | "speculation"
  | "argumentative"
  | "badgering"
  | "assumes_facts"
  | "compound";
