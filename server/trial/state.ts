// View builders — the most important correctness boundary (spec §9).
import type { CaseFile, TrialState, WitnessId } from "@shared/types.js";
import { CONFIG } from "@shared/config.js";
import { estimateTokens } from "../jev/JevClient.js";

export interface RecordView {
  case_summary: string;
  charge: string;
  truth: string;
  facts: { id: string; statement: string; favors: string; importance: number }[];
  documents: { id: string; title: string; body?: string }[];
  witness_under_examination?: Record<string, unknown>;
  transcript: { seq: number; speaker: string; kind: string; text: string; stricken?: boolean }[];
  judge_warnings: number;
  examination_type?: string;
  // P1-3: player-supplied text lives ONLY here, never inside instructions.
  current_question?: string;
  current_question_asked_by?: "defense" | "prosecutor";
  [k: string]: unknown;
}

export interface JuryView {
  charge: string;
  transcript: { seq: number; speaker: string; kind: string; text: string; stricken_note?: string }[];
  previous_leanings?: Record<string, number>;
  current_leanings?: Record<string, number>; // P2-3: present ONLY during deliberation
  deliberation_round?: number;
  latest_exchange?: string;
  [k: string]: unknown;
}

/** RECORD: full hidden record. Used by Call A / O. */
export function buildRecordView(
  state: TrialState,
  opts: { witnessId?: WitnessId; examinationType?: string; currentQuestion?: string; currentQuestionAskedBy?: "defense" | "prosecutor" },
): RecordView {
  const cf: CaseFile = state.caseFile;
  const witness = opts.witnessId ? cf.witnesses.find((w) => w.id === opts.witnessId) : undefined;

  // §9.2: full bodies only for docs whose facts are known by current witness or read by player.
  const relevantFacts = new Set(witness ? witness.knows : []);
  const docs = cf.documents.map((d) => {
    const relevant = d.factIds.some((f) => relevantFacts.has(f)) || state.docsRead.includes(d.id);
    return relevant ? { id: d.id, title: d.title, body: d.body } : { id: d.id, title: d.title };
  });

  let view: RecordView = {
    case_summary: `${cf.caseTitle}. Defendant: ${cf.defendant}.`,
    charge: cf.charge,
    truth: cf.truth,
    facts: cf.facts.map((f) => ({ id: f.id, statement: f.statement, favors: f.favors, importance: f.importance })),
    documents: docs,
    transcript: state.transcript.map((t) => ({ seq: t.seq, speaker: t.speaker, kind: t.kind, text: t.text, stricken: t.stricken })),
    judge_warnings: state.judgeWarnings,
    witness_under_examination: witness
      ? {
          id: witness.id,
          name: witness.name,
          role: witness.role,
          personality: witness.personality,
          knows: witness.knows,
          willLieAbout: witness.willLieAbout,
          doesNotKnow: witness.doesNotKnow,
        }
      : undefined,
    examination_type: opts.examinationType,
    current_question: opts.currentQuestion,
    current_question_asked_by: opts.currentQuestionAskedBy,
  };

  // Token budget: drop bodies least-relevant-first if over budget.
  let tokens = estimateTokens(JSON.stringify(view));
  if (tokens > CONFIG.RECORD_TOKEN_BUDGET) {
    const withBody = view.documents.map((d, i) => ({ d, i, len: d.body ? d.body.length : 0 }));
    withBody.sort((a, b) => a.len - b.len);
    for (const { i } of withBody) {
      if (tokens <= CONFIG.RECORD_TOKEN_BUDGET) break;
      const doc = view.documents[i];
      if (doc.body) {
        tokens -= estimateTokens(doc.body);
        delete doc.body;
      }
    }
  }
  return view;
}

/** JURY: courtroom transcript only. MUST NEVER contain truth/facts/unread docs/profiles.
 *  P2-3: current_leanings is included ONLY during deliberation. */
export function buildJuryView(
  state: TrialState,
  opts: { previousLeanings?: Record<string, number>; includeCurrentLeanings?: boolean; deliberationRound?: number; latestExchange?: string } = {},
): JuryView {
  return {
    charge: state.caseFile.charge,
    transcript: state.transcript.map((t) => ({
      seq: t.seq,
      speaker: t.speaker,
      kind: t.kind,
      text: t.text,
      ...(t.stricken ? { stricken_note: "STRICKEN — the jury was instructed to disregard this" } : {}),
    })),
    previous_leanings: opts.previousLeanings ?? state.jurorLeanings,
    ...(opts.includeCurrentLeanings ? { current_leanings: state.jurorLeanings } : {}),
    deliberation_round: opts.deliberationRound,
    latest_exchange: opts.latestExchange,
  };
}
