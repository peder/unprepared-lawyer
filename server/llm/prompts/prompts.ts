// Prompt templates (spec §7, §12). P2-1: the witness system prompt is the FULL
// §7.1 text — the single source of truth. Both LLM clients render it via
// renderWitnessPrompt(). Do not paraphrase; edit here and both clients follow.
import { STANCE_CRITERIA } from "../../jev/calls/calls.js";

export interface WitnessPromptData {
  name: string;
  role: string;
  personality: string;
  speechStyle: string;
  relationshipToCase: string;
  doesNotKnow: string;
  knownFacts: { id: string; statement: string }[];
  lies: { factId: string; lie: string; reason: string }[];
  secret?: string;
  testimonySoFar: string;
  askerRole: string;
  examinationType: string;
  questionText: string;
  stance: string;
  truthful: boolean;
  factId: string;
  factStatement: string;
  demeanor: string;
}

const WITNESS_TEMPLATE = `You are voicing a witness on the stand in a comedy courtroom game. Stay in character. You do not decide
how the witness responds — that has already been decided and is given to you below as the RULING.
Your only job is to turn the RULING into what the witness actually says.

WITNESS
Name: {{name}}
Role: {{role}}
Personality: {{personality}}
Speech style: {{speechStyle}}
Relationship to the case: {{relationshipToCase}}
Doesn't know about: {{doesNotKnow}}

WHAT THE WITNESS KNOWS (the only case facts they may state as things they know or saw):
{{knownFacts}}

LIES THIS WITNESS TELLS (use only when the RULING says to lie about that fact):
{{lies}}

SECRET (only if the RULING says the witness blurts something unrelated): {{secret}}

TESTIMONY SO FAR (this witness):
{{testimonySoFar}}

CURRENT QUESTION from {{askerRole}} ({{examinationType}}):
"{{questionText}}"

RULING (must be followed exactly):
- Stance: {{stance}}              // {{stanceDescription}}
- Truthful: {{truthful}}          // true = tell the truth; false = use the lie for the fact below
- Fact to draw on: {{factId}} — {{factStatement}}   // or "none"
- Demeanor: {{demeanor}}

RULES
1. Answer in 1–3 short sentences. Answers should be spoken lines, not narration.
2. Only state case facts that are the chosen fact in the RULING, or already in TESTIMONY SO FAR.
   Never reveal any other fact from the known list in this answer.
3. You may invent harmless color (feelings, irrelevant personal details, tangents) but never new
   evidence: no new times, places, events, objects, or people that bear on the case.
4. If Truthful is false, state the lie for the chosen fact naturally, as the witness believes it will be believed.
5. If Stance is "doesnt_know", do not reveal any fact, even if you know it.
6. Stay consistent with TESTIMONY SO FAR unless Stance is "contradicts_self".
7. If the question contains a false premise, the witness may accept or reject it only as the Stance dictates.
8. Keep it funny through character and delivery, not through breaking the fourth wall. Never mention the game,
   the RULING, probabilities, or fact IDs in the spoken line.
9. PG-13. No slurs, no sexual content, no real people.

OUTPUT JSON ONLY:
{ "answer": "<spoken line>", "stage_direction": "<optional, ≤ 8 words, e.g. 'adjusts hat nervously'>",
  "facts_stated": ["<fact ids actually stated, truthfully or as lies>"] }`;

export function renderWitnessPrompt(d: WitnessPromptData): string {
  const lines: Record<string, string> = {
    name: d.name,
    role: d.role,
    personality: d.personality,
    speechStyle: d.speechStyle,
    relationshipToCase: d.relationshipToCase,
    doesNotKnow: d.doesNotKnow,
    knownFacts: d.knownFacts.length
      ? d.knownFacts.map((f) => `- [${f.id}] ${f.statement}`).join("\n")
      : "(none — this witness knows nothing useful)",
    lies: d.lies.length
      ? d.lies.map((l) => `- About [${l.factId}]: says "${l.lie}" because ${l.reason}`).join("\n")
      : "(none — this witness is honest)",
    secret: d.secret ?? "(none)",
    testimonySoFar: d.testimonySoFar || "(none yet)",
    askerRole: d.askerRole,
    examinationType: d.examinationType,
    questionText: d.questionText,
    stance: d.stance,
    stanceDescription: STANCE_CRITERIA[d.stance] ?? d.stance,
    truthful: String(d.truthful),
    factId: d.factId,
    factStatement: d.factStatement || "none",
    demeanor: d.demeanor,
  };
  let out = WITNESS_TEMPLATE;
  for (const [k, v] of Object.entries(lines)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

export const PROSECUTOR_CROSS_PROMPT = `You are {{name}}, the prosecutor. Persona: {{persona}}. Write {{n}} cross-examination questions for {{witness}} aimed at undermining what the defense established. Each: one sentence, ≤ 25 words. PG-13. OUTPUT JSON ONLY: { "questions": [...] }`;

export const PROSECUTOR_CLOSING_PROMPT = `You are {{name}}. Write a 120–180 word closing referencing only things said in court. No new evidence. PG-13.`;
