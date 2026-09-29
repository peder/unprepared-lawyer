import type { CaseFile, WitnessId, JurorReactionSlug } from "@shared/types.js";
import { REACTION_DESCRIPTIONS } from "@shared/types.js";
import type { JevQuestion } from "../JevClient.js";

export const IMPROPRIETY_LEVELS = ["proper", "borderline", "improper", "flagrant", "outrageous"];
export const CLAIM_STATUSES = {
  supported: "the question asserts a fact supported by the record",
  contradicted: "the question asserts a fact contradicted by the record",
  not_in_record: "the question asserts a fact not in the record",
  no_claim: "the question asserts no factual claim",
};
export const STANCE_CRITERIA: Record<string, string> = {
  confirms: "agrees with what the question suggests",
  partially_confirms: "agrees with part of it, with a complication",
  denies: "disagrees",
  doesnt_know: "doesn't know or didn't see",
  evasive: "dodges the question",
  rambles: "goes off on a tangent, eventually gets near an answer",
  volunteers_more: "answers and adds something the asker didn't ask for",
  contradicts_self: "says something inconsistent with earlier testimony",
  blurts_secret: "says something unrelated and incriminating about themselves (rare)",
};
export const DEMEANOR_CRITERIA: Record<string, string> = {
  calm: "calm",
  nervous: "nervous",
  defensive: "defensive",
  hostile: "hostile",
  delighted: "delighted",
  confused: "confused",
  bored: "bored",
};
export const OBJECTION_GROUNDS: Record<string, string> = {
  leading: "leading question",
  hearsay: "hearsay",
  relevance: "relevance",
  speculation: "speculation",
  argumentative: "argumentative",
  badgering: "badgering",
  assumes_facts: "assumes facts not in evidence",
  compound: "compound question",
};
// P2-4: slug keys in, emoji mapped in code.
export const JUROR_REACTION_CRITERIA: Record<JurorReactionSlug, string> = { ...REACTION_DESCRIPTIONS };

// P1-3: player-supplied text NEVER appears in instructions. It lives in
// state.current_question (+ current_question_asked_by); instructions refer to it.
const Q = "the current question in state.current_question";

export interface CallAQuestions {
  claim_status: JevQuestion;
  claim_fact: JevQuestion;
  impropriety: JevQuestion;
  prosecutor_objects?: JevQuestion;
  objection_grounds: JevQuestion;
  judge_sustains: JevQuestion;
  mistrial_motion: JevQuestion;
  mistrial_granted: JevQuestion;
  witness_stance: JevQuestion;
  witness_truthful: JevQuestion;
  witness_fact: JevQuestion;
  witness_demeanor: JevQuestion;
}

/** Call A: question adjudication (RECORD view). Spec §8.1. */
export function buildCallA(opts: {
  caseFile: CaseFile;
  witnessId: WitnessId;
  examinationType: string;
  includeProsecutorObjection: boolean;
}): Record<string, JevQuestion> {
  const cf = opts.caseFile;
  const witness = cf.witnesses.find((w) => w.id === opts.witnessId)!;
  const factKeys: Record<string, string> = {};
  for (const f of cf.facts) factKeys[f.id] = f.statement;
  const witnessFactKeys: Record<string, string> = { none: "the witness draws on no particular fact" };
  for (const fid of witness.knows) {
    const f = cf.facts.find((x) => x.id === fid);
    if (f) witnessFactKeys[fid] = f.statement;
  }
  const qs: Record<string, JevQuestion> = {
    claim_status: { type: "choice", instructions: `Does ${Q} assert or presuppose a fact?`, criteria: CLAIM_STATUSES },
    claim_fact: {
      type: "choice",
      instructions: `Which fact does ${Q} most relate to?`,
      criteria: { ...factKeys, none: "no fact in particular" },
    },
    impropriety: {
      type: "score",
      instructions: `Rate how improper ${Q} is, given examination type ${opts.examinationType} (leading questions are fine on cross-examination).`,
      criteria: IMPROPRIETY_LEVELS,
    },
    objection_grounds: { type: "choice", instructions: `If ${Q} were objected to, what would be the most likely grounds?`, criteria: OBJECTION_GROUNDS },
    judge_sustains: {
      type: "noul",
      instructions: `If counsel objects to ${Q} on the most likely grounds, does ${cf.judge.name} (${cf.judge.persona}, strictness ${cf.judge.strictness}/5) sustain the objection?`,
    },
    mistrial_motion: { type: "noul", instructions: "Given the defense counsel's conduct so far in this trial, does the prosecutor move for a mistrial?" },
    mistrial_granted: { type: "noul", instructions: `If a mistrial is requested, does ${cf.judge.name} grant it?` },
    witness_stance: {
      type: "choice",
      instructions: `How does ${witness.name} (${witness.personality}) respond to ${Q}? The examination type is ${opts.examinationType}.`,
      criteria: STANCE_CRITERIA,
    },
    witness_truthful: { type: "noul", instructions: `Does ${witness.name} answer ${Q} truthfully, given what they are known to lie about?` },
    witness_fact: {
      type: "choice",
      instructions: `Which fact does ${witness.name} draw on when answering ${Q}? Choose only from facts this witness knows.`,
      criteria: witnessFactKeys,
    },
    witness_demeanor: { type: "choice", instructions: `What is ${witness.name}'s demeanor while answering ${Q}?`, criteria: DEMEANOR_CRITERIA },
  };
  if (opts.includeProsecutorObjection) {
    qs.prosecutor_objects = {
      type: "noul",
      instructions: `Does ${cf.prosecutor.name} (${cf.prosecutor.persona}, objection tendency ${cf.prosecutor.objectionTendency}/5) object to ${Q}?`,
    };
  }
  if (opts.includeProsecutorObjection) {
    const ordered: Record<string, JevQuestion> = {};
    for (const k of ["claim_status", "claim_fact", "impropriety", "prosecutor_objects", "objection_grounds", "judge_sustains", "mistrial_motion", "mistrial_granted", "witness_stance", "witness_truthful", "witness_fact", "witness_demeanor"]) {
      ordered[k] = qs[k];
    }
    return ordered;
  }
  return qs;
}

/** Call O: player objection ruling (RECORD view). Spec §8.4. */
export function buildCallO(opts: { judgeName: string; judgePersona: string; grounds: string }): Record<string, JevQuestion> {
  return {
    grounds_apply: { type: "noul", instructions: `Does the evidentiary ground "${opts.grounds}" actually apply to ${Q}?` },
    judge_sustains: {
      type: "noul",
      instructions: `Does ${opts.judgeName} (${opts.judgePersona}) sustain an objection on ${opts.grounds} to ${Q}?`,
    },
  };
}

/** Call B: jury update (JURY view). Spec §8.5 — 24 questions. P1-4: every
 *  reaction question carries its juror's label + persona, like the leanings. */
export function buildCallB(opts: { jurorIds: string[]; personas: Record<string, string> }): Record<string, JevQuestion> {
  const qs: Record<string, JevQuestion> = {};
  for (const id of opts.jurorIds) {
    qs[id] = {
      type: "noul",
      instructions: `${opts.personas[id] ?? id}. Having heard everything in court so far, including the latest exchange, does this juror currently believe the defendant is guilty?`,
    };
  }
  for (const id of opts.jurorIds) {
    qs[`${id}_react`] = {
      type: "choice",
      instructions: `${opts.personas[id] ?? id}. How does this juror visibly react to the latest exchange?`,
      criteria: JUROR_REACTION_CRITERIA,
    };
  }
  return qs;
}

/** Call P: jury priors. Same shape as B. */
export function buildCallP(opts: { jurorIds: string[]; personas: Record<string, string> }): Record<string, JevQuestion> {
  return buildCallB(opts);
}

/** A-open / A-close: claim check only. Spec §10.2. */
export function buildCallAOpen(factKeys: Record<string, string>): Record<string, JevQuestion> {
  return {
    claim_status: { type: "choice", instructions: `Does the defense statement in ${Q} assert a fact?`, criteria: CLAIM_STATUSES },
    claim_fact: { type: "choice", instructions: "Which fact does it most relate to?", criteria: { ...factKeys, none: "none" } },
    impropriety: { type: "score", instructions: "Rate how improper the defense statement is.", criteria: IMPROPRIETY_LEVELS },
  };
}

/** P2-3: deliberation questions reference other jurors' leanings + round number. */
export function buildCallD(opts: {
  jurorIds: string[];
  personas: Record<string, string>;
  leanings: Record<string, number>;
  round: number;
}): Record<string, JevQuestion> {
  const room = opts.jurorIds.map((id) => `${id} ${Math.round((opts.leanings[id] ?? 0.5) * 100)}%`).join(", ");
  const qs: Record<string, JevQuestion> = {};
  for (const id of opts.jurorIds) {
    qs[id] = {
      type: "noul",
      instructions: `${opts.personas[id] ?? id}. This is deliberation round ${opts.round}. The room currently stands (percent chance each juror votes guilty): ${room}. After hearing where the others stand, does this juror believe the defendant is guilty?`,
    };
  }
  for (const id of opts.jurorIds) {
    qs[`${id}_react`] = {
      type: "choice",
      instructions: `${opts.personas[id] ?? id}. Deliberation round ${opts.round}; the room stands: ${room}. How does this juror visibly react?`,
      criteria: JUROR_REACTION_CRITERIA,
    };
  }
  return qs;
}
