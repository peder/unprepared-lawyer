// TrialEngine — authoritative state machine (spec §3, §8.2, §10, §11).
// P1-1: explicit phases; every public method validates the phase and throws
// PhaseError otherwise. The server owns all limits (reads, questions, objections);
// the client only displays status().
import { CONFIG } from "@shared/config.js";
import type {
  CaseFile, TrialState, TranscriptEntry, WitnessId, DocId,
  ExaminationType, ObjectionGrounds, ClaimStatus, ImproprietyLevel,
  Phase, JurorReactionSlug,
} from "@shared/types.js";
import { REACTION_EMOJI } from "@shared/types.js";
import type { JevClient, JevResponse } from "../jev/JevClient.js";
import { CONFIG as _C } from "@shared/config.js";
import type { LLMClient } from "../llm/LLMClient.js";
import { validateWitnessVoice } from "../llm/LLMClient.js";
import {
  buildCallA, buildCallB, buildCallP, buildCallO, buildCallAOpen, buildCallD,
  IMPROPRIETY_LEVELS,
} from "../jev/calls/calls.js";
import { buildRecordView, buildJuryView } from "./state.js";
import { createRng, sampleNoul, sampleChoice, type Rng } from "../rules/sampling.js";
import { applyPatience, inMistrialZone } from "../rules/patience.js";
import { castVotes, smoothLeaning } from "../rules/verdict.js";
import { JUDGE_LINES, deliberationLine } from "../templates.js";

export class PhaseError extends Error {
  constructor(public phase: Phase, action: string) {
    super(`Cannot ${action} in phase ${phase}`);
    this.name = "PhaseError";
  }
}

export interface EngineEvents {
  onEvent?: (e: EngineEvent) => void;
}

export interface StatusSnapshot {
  phase: Phase;
  readsLeft: number;
  questionsLeftForThisWitness: number;
  objectionsLeft: number;
  currentWitnessId?: WitnessId;
}

export type EngineEvent =
  | { kind: "transcript"; entry: TranscriptEntry }
  | { kind: "jury"; leanings: Record<string, number>; reactions: Record<string, string> }
  | { kind: "patience"; patience: number; warnings: number }
  | { kind: "phase"; status: StatusSnapshot }
  | { kind: "outcome"; outcome: NonNullable<TrialState["outcome"]> }
  | { kind: "log"; text: string };

export interface QuestionDetails {
  claimStatus: ClaimStatus;
  impropriety: ImproprietyLevel;
  prosecutorObjects?: boolean;
  objectionGrounds?: string;
  sustained?: boolean;
  stance?: string;
  truthful?: boolean;
  factId?: string;
  demeanor?: string;
}

export interface QuestionResult {
  stricken: boolean;
  ruling?: string;
  answer?: string;
  mistrial?: boolean;
  details: QuestionDetails;
}

/** P1-2: handle for a prosecutor question awaiting the objection window. */
export interface ProsecutorHandle {
  witnessId: WitnessId;
  text: string;
  examinationType: ExaminationType;
  qEntrySeq: number;
  callA: JevResponse;
  claimStatus: ClaimStatus;
  impropriety: ImproprietyLevel;
  penalized: boolean;
}

function noulP(resp: JevResponse, key: string): number {
  const a = resp.answers[key];
  if (a?.type === "noul") return a.p;
  return 0.5;
}
function choiceOf(resp: JevResponse, key: string): { choice: string; probabilities: Record<string, number> } {
  const a = resp.answers[key];
  if (a?.type === "choice") return { choice: a.choice, probabilities: a.probabilities };
  return { choice: "none", probabilities: {} };
}
function scoreOf(resp: JevResponse, key: string): number {
  const a = resp.answers[key];
  if (a?.type === "score") return a.score;
  return 0;
}

const DEFENSE_QS = 3; // CONFIG.DEFENSE_QS
const P_DIRECT_QS = 3; // CONFIG.PROSECUTION_DIRECT_QS
const D_CROSS_QS = 2; // CONFIG.PROSECUTION_CROSS_QS
const N_DEFENSE_WITNESSES = 2;

export class TrialEngine {
  state: TrialState;
  private rng: Rng;
  private seq = 0;

  constructor(
    private caseFile: CaseFile,
    private jev: JevClient,
    private llm: LLMClient,
    private opts: EngineEvents & { seed?: number } = {},
  ) {
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.rng = createRng(seed);
    this.state = {
      seed,
      caseFile,
      transcript: [],
      docsRead: [],
      jurorLeanings: Object.fromEntries(caseFile.jurors.map((j) => [j.id, 0.5])),
      jurorReactions: Object.fromEntries(caseFile.jurors.map((j) => [j.id, "😐"])),
      judgePatience: caseFile.judge.basePatience,
      judgeWarnings: 0,
      playerObjectionsLeft: CONFIG.PLAYER_OBJECTIONS,
      testimony: Object.fromEntries(caseFile.witnesses.map((w) => [w.id, []])),
      revealedFacts: [],
      factsStatedByWitness: Object.fromEntries(caseFile.witnesses.map((w) => [w.id, []])),
      phase: "SETUP",
      readsLeft: 5,
      questionsAskedThisWitness: 0,
      prosecutionWitnessIdx: 0,
      defenseWitnessesCalled: [],
    };
  }

  // ---- status / phases ----
  status(): StatusSnapshot {
    return {
      phase: this.state.phase,
      readsLeft: this.state.readsLeft,
      questionsLeftForThisWitness: this.questionsLeft(),
      objectionsLeft: this.state.playerObjectionsLeft,
      currentWitnessId: this.state.currentWitnessId,
    };
  }

  private questionsLeft(): number {
    const { phase, questionsAskedThisWitness } = this.state;
    if (phase === "P_CROSS" || phase === "D_DIRECT") return Math.max(0, DEFENSE_QS - questionsAskedThisWitness);
    if (phase === "P_DIRECT") return Math.max(0, P_DIRECT_QS - questionsAskedThisWitness);
    if (phase === "D_CROSS") return Math.max(0, D_CROSS_QS - questionsAskedThisWitness);
    return 0;
  }

  private requirePhase(action: string, ...allowed: Phase[]) {
    if (!allowed.includes(this.state.phase)) throw new PhaseError(this.state.phase, action);
  }

  private setPhase(phase: Phase) {
    this.state.phase = phase;
    this.emit({ kind: "phase", status: this.status() });
  }

  private roundForPhase(): 1 | 2 | 3 | 4 {
    const p = this.state.phase;
    if (p === "OPENING" || p === "SETUP") return 1;
    if (p === "P_READ" || p === "P_DIRECT" || p === "P_CROSS") return 2;
    if (p === "D_SELECT" || p === "D_READ" || p === "D_DIRECT" || p === "D_CROSS") return 3;
    return 4;
  }

  private prosecutionWitnesses() {
    return this.caseFile.witnesses.filter((w) => w.calledBy === "prosecution");
  }

  private jurorPersonas(): Record<string, string> {
    return Object.fromEntries(this.caseFile.jurors.map((j) => [j.id, `${j.label}: ${j.persona}`]));
  }

  // ---- transcript / testimony ----
  private emit(e: EngineEvent) {
    this.opts.onEvent?.(e);
  }

  private addTranscript(e: Omit<TranscriptEntry, "seq">): TranscriptEntry {
    const entry: TranscriptEntry = { ...e, seq: ++this.seq };
    this.state.transcript.push(entry);
    this.emit({ kind: "transcript", entry });
    return entry;
  }

  /** P2-5: testimony holds Q/A pairs — questions and answers for this witness. */
  private addTestimony(witnessId: WitnessId, entry: TranscriptEntry) {
    const arr = this.state.testimony[witnessId] ?? [];
    arr.push(entry);
    this.state.testimony[witnessId] = arr;
  }

  private testimonySoFar(witnessId: WitnessId): string {
    return (this.state.testimony[witnessId] ?? [])
      .map((t) => (t.kind === "question" ? `Q (${t.speaker}): ${t.text}` : `A: ${t.text}`))
      .join("\n");
  }

  private setPatience(p: number) {
    this.state.judgePatience = p;
    if (p <= CONFIG.WARNING_THRESHOLD && this.state.judgeWarnings === 0) {
      this.state.judgeWarnings = 1;
      this.addTranscript({ round: this.roundForPhase(), speaker: "judge", kind: "ruling", text: JUDGE_LINES.warning });
    }
    this.emit({ kind: "patience", patience: this.state.judgePatience, warnings: this.state.judgeWarnings });
  }

  /** Apply claim/impropriety penalties; returns true if any penalty applied (P1-5). */
  private applyQuestionPenalties(claimStatus: ClaimStatus, impropriety: ImproprietyLevel): boolean {
    let penalized = false;
    const base = this.caseFile.judge.basePatience;
    let p = this.state.judgePatience;
    if (claimStatus === "contradicted") {
      p = applyPatience(p, base, { kind: "contradictedClaim" });
      penalized = true;
    }
    if (impropriety === "improper" || impropriety === "flagrant" || impropriety === "outrageous") {
      p = applyPatience(p, base, { kind: "impropriety", impropriety });
      penalized = true;
    }
    this.setPatience(p);
    return penalized;
  }

  private applyCleanBonus() {
    this.setPatience(applyPatience(this.state.judgePatience, this.caseFile.judge.basePatience, { kind: "cleanExchange" }));
  }

  // ---- Setup: jury priors (Call P, spec §10.1) ----
  async setupPriors(): Promise<void> {
    this.requirePhase("run setup", "SETUP");
    const jurorIds = this.caseFile.jurors.map((j) => j.id);
    this.addTranscript({ round: 1, speaker: "prosecutor", kind: "opening", text: this.caseFile.prosecutionOpening, hiddenFromPlayer: true });
    const resp = await this.jev.request({
      model: _C.JEV_MODEL,
      state: buildJuryView(this.state) as unknown as Record<string, unknown>,
      questions: buildCallP({ jurorIds, personas: this.jurorPersonas() }),
    });
    for (const id of jurorIds) {
      this.state.jurorLeanings[id] = noulP(resp, id);
    }
    this.addTranscript({ round: 1, speaker: "judge", kind: "note", text: "[You drifted off during the prosecution's opening statement.]" });
    this.emit({ kind: "jury", leanings: { ...this.state.jurorLeanings }, reactions: { ...this.state.jurorReactions } });
    const first = this.prosecutionWitnesses()[0];
    this.state.currentWitnessId = first?.id;
    this.state.prosecutionWitnessIdx = 0;
    this.setPhase("OPENING");
  }

  // ---- Opening (spec §10.2): A-open + B in parallel ----
  async submitOpening(text: string): Promise<void> {
    this.requirePhase("give an opening statement", "OPENING");
    this.addTranscript({ round: 1, speaker: "defense", kind: "opening", text });
    const factKeys = Object.fromEntries(this.caseFile.facts.map((f) => [f.id, f.statement]));
    const recordView = buildRecordView(this.state, { currentQuestion: text, currentQuestionAskedBy: "defense" });
    const juryView = buildJuryView(this.state);
    const [aResp, bResp] = await Promise.all([
      this.jev.request({ model: _C.JEV_MODEL, state: recordView as unknown as Record<string, unknown>, questions: buildCallAOpen(factKeys) }),
      this.jev.request({
        model: _C.JEV_MODEL,
        state: juryView as unknown as Record<string, unknown>,
        questions: buildCallB({ jurorIds: this.caseFile.jurors.map((j) => j.id), personas: this.jurorPersonas() }),
      }),
    ]);
    this.applyClaimPatience(aResp);
    await this.applyJuryResponse(bResp);
    this.state.questionsAskedThisWitness = 0;
    this.setPhase("P_READ");
  }

  private applyClaimPatience(aResp: JevResponse) {
    const { choice } = choiceOf(aResp, "claim_status");
    const score = scoreOf(aResp, "impropriety");
    const level = IMPROPRIETY_LEVELS[score] as ImproprietyLevel;
    // P1-5: bonus only when no penalty applied this exchange.
    const penalized = this.applyQuestionPenalties(choice as ClaimStatus, level);
    if (!penalized) this.applyCleanBonus();
  }

  private async applyJuryResponse(bResp: JevResponse) {
    for (const j of this.caseFile.jurors) {
      const p = noulP(bResp, j.id);
      this.state.jurorLeanings[j.id] = smoothLeaning(this.state.jurorLeanings[j.id], p);
      // P2-4: Jev answers slugs; code maps to emoji for display.
      const r = choiceOf(bResp, `${j.id}_react`);
      this.state.jurorReactions[j.id] = REACTION_EMOJI[r.choice as JurorReactionSlug] ?? "😐";
    }
    this.emit({ kind: "jury", leanings: { ...this.state.jurorLeanings }, reactions: { ...this.state.jurorReactions } });
  }

  // ---- Reads ----
  async readDoc(docId: DocId): Promise<void> {
    this.requirePhase("read a document", "P_READ", "D_READ", "FINAL_READ");
    if (this.state.readsLeft <= 0) throw new PhaseError(this.state.phase, `read ${docId} (no reads left)`);
    if (!this.state.docsRead.includes(docId)) {
      this.state.docsRead.push(docId);
      this.state.readsLeft -= 1;
    }
    if (this.state.phase === "P_READ") {
      this.state.questionsAskedThisWitness = 0;
      this.setPhase("P_DIRECT");
    } else if (this.state.phase === "D_READ") {
      this.state.questionsAskedThisWitness = 0;
      this.setPhase("D_DIRECT");
    } else {
      // FINAL_READ → prosecution closing is generated during the read (spec §10.2),
      // awaited here so submitClosing never double-adds it.
      const closing = await this.llm.prosecutionClosing({
        prosecutorName: this.caseFile.prosecutor.name,
        persona: this.caseFile.prosecutor.persona,
        transcript: this.state.transcript.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
      });
      this.addTranscript({ round: 4, speaker: "prosecutor", kind: "closing", text: closing });
      this.setPhase("CLOSING");
    }
  }

  // ---- Defense witness selection (spec §3: player may call any defense-list witness) ----
  selectDefenseWitness(witnessId: WitnessId): void {
    this.requirePhase("select a defense witness", "D_SELECT");
    const w = this.caseFile.witnesses.find((x) => x.id === witnessId);
    if (!w || w.calledBy !== "defense") throw new PhaseError(this.state.phase, `call ${witnessId} (not on the defense list)`);
    if (this.state.defenseWitnessesCalled.includes(witnessId)) throw new PhaseError(this.state.phase, `call ${witnessId} (already testified)`);
    this.state.defenseWitnessesCalled.push(witnessId);
    this.state.currentWitnessId = witnessId;
    this.setPhase("D_READ");
  }

  // ---- Defense questions (cross on prosecution witnesses, direct on defense) ----
  async askDefenseQuestion(args: { witnessId: WitnessId; text: string }): Promise<QuestionResult> {
    this.requirePhase("ask a defense question", "P_CROSS", "D_DIRECT");
    const { witnessId, text } = args;
    if (witnessId !== this.state.currentWitnessId) throw new PhaseError(this.state.phase, `question ${witnessId} (current witness is ${this.state.currentWitnessId})`);
    if (this.state.questionsAskedThisWitness >= DEFENSE_QS) throw new PhaseError(this.state.phase, "ask a 4th question (slot exhausted)");
    const examinationType: ExaminationType = this.state.phase === "P_CROSS" ? "cross_defense" : "direct_defense";
    const round = this.roundForPhase();
    const witness = this.caseFile.witnesses.find((w) => w.id === witnessId)!;
    this.state.questionsAskedThisWitness += 1; // struck questions consume a slot (spec §3)

    const qEntry = this.addTranscript({ round, speaker: "defense", kind: "question", text });
    this.addTestimony(witnessId, qEntry);
    const details: QuestionDetails = { claimStatus: "no_claim", impropriety: "proper" };

    const recordView = buildRecordView(this.state, { witnessId, examinationType, currentQuestion: text, currentQuestionAskedBy: "defense" });
    const callA = await this.jev.request({
      model: _C.JEV_MODEL,
      state: recordView as unknown as Record<string, unknown>,
      questions: buildCallA({ caseFile: this.caseFile, witnessId, examinationType, includeProsecutorObjection: true }),
    });

    const claimStatus = choiceOf(callA, "claim_status").choice as ClaimStatus;
    const impropriety = IMPROPRIETY_LEVELS[scoreOf(callA, "impropriety")] as ImproprietyLevel;
    details.claimStatus = claimStatus;
    details.impropriety = impropriety;
    const penalized = this.applyQuestionPenalties(claimStatus, impropriety);

    const objects = sampleNoul(noulP(callA, "prosecutor_objects"), this.rng);
    details.prosecutorObjects = objects;
    if (objects) {
      const probs = choiceOf(callA, "objection_grounds").probabilities;
      const grounds = sampleChoice(probs, this.rng) || choiceOf(callA, "objection_grounds").choice;
      const sustains = sampleNoul(noulP(callA, "judge_sustains"), this.rng);
      details.objectionGrounds = grounds;
      details.sustained = sustains;
      this.addTranscript({ round, speaker: "prosecutor", kind: "objection", text: `Objection — ${grounds}.` });
      if (sustains) {
        this.setPatience(applyPatience(this.state.judgePatience, this.caseFile.judge.basePatience, { kind: "sustainedAgainstPlayer" }));
        this.addTranscript({ round, speaker: "judge", kind: "ruling", text: `${JUDGE_LINES.sustained} ${JUDGE_LINES.disregard}` });
        qEntry.stricken = true; // P0-2: mark in place — the jury sees it once, marked.
        this.emit({ kind: "transcript", entry: qEntry });
        await this.runCallB(`Stricken question: ${text}`);
        if (this.checkMistrial(callA)) return { stricken: true, ruling: "sustained", mistrial: true, details };
        this.advanceAfterDefenseQuestion();
        return { stricken: true, ruling: "sustained", details };
      }
      this.addTranscript({ round, speaker: "judge", kind: "ruling", text: JUDGE_LINES.overruled });
    }

    const answer = await this.voiceAnswer({ witnessId, witness, text, examinationType, askedBy: "defense", round, callA, details });
    if (!penalized) this.applyCleanBonus();

    if (inMistrialZone(this.state.judgePatience)) {
      const motion = sampleNoul(noulP(callA, "mistrial_motion"), this.rng);
      if (motion && sampleNoul(noulP(callA, "mistrial_granted"), this.rng)) {
        return this.grantMistrial(round);
      }
    }
    await this.runCallB(`${text} / ${answer}`);
    this.advanceAfterDefenseQuestion();
    return { stricken: false, answer, details };
  }

  private advanceAfterDefenseQuestion() {
    if (this.state.questionsAskedThisWitness < DEFENSE_QS) return;
    if (this.state.phase === "P_CROSS") {
      const next = this.state.prosecutionWitnessIdx + 1;
      const pWits = this.prosecutionWitnesses();
      if (next < pWits.length) {
        this.state.prosecutionWitnessIdx = next;
        this.state.currentWitnessId = pWits[next].id;
        this.state.questionsAskedThisWitness = 0;
        this.setPhase("P_READ");
      } else {
        this.state.currentWitnessId = undefined;
        this.setPhase("D_SELECT");
      }
    } else if (this.state.phase === "D_DIRECT") {
      this.state.questionsAskedThisWitness = 0;
      this.setPhase("D_CROSS");
    }
  }

  // ---- P1-2: prosecutor questions with a real objection window ----
  // beginProsecutorQuestion() fires speculative Call A immediately (spec §8.4).
  // resolveObjectionWindow() finishes it: sustained ⇒ stricken, speculative
  // result discarded, no answer; overruled/absent ⇒ voice from speculative result.
  async beginProsecutorQuestion(args: { witnessId: WitnessId; text?: string }): Promise<ProsecutorHandle> {
    this.requirePhase("begin a prosecutor question", "P_DIRECT", "D_CROSS");
    const { witnessId } = args;
    if (witnessId !== this.state.currentWitnessId) throw new PhaseError(this.state.phase, `question ${witnessId} (current witness is ${this.state.currentWitnessId})`);
    const examinationType: ExaminationType = this.state.phase === "P_DIRECT" ? "direct_prosecution" : "cross_prosecution";
    const round = this.roundForPhase();
    let text: string;
    if (this.state.phase === "P_DIRECT") {
      // Pre-written direct plan (spec §8.4) — no live LLM needed.
      const plan = this.caseFile.prosecutionDirectPlan[witnessId] ?? [];
      const next = plan[this.state.questionsAskedThisWitness];
      if (next === undefined) throw new PhaseError(this.state.phase, "prosecutor question beyond the direct plan");
      text = next;
      if (this.state.questionsAskedThisWitness >= P_DIRECT_QS) throw new PhaseError(this.state.phase, "prosecutor direct exhausted");
    } else {
      if (!args.text) throw new PhaseError(this.state.phase, "prosecutor cross needs question text");
      if (this.state.questionsAskedThisWitness >= D_CROSS_QS) throw new PhaseError(this.state.phase, "prosecutor cross exhausted");
      text = args.text;
    }
    this.state.questionsAskedThisWitness += 1;

    const qEntry = this.addTranscript({ round, speaker: "prosecutor", kind: "question", text });
    this.addTestimony(witnessId, qEntry);
    const recordView = buildRecordView(this.state, { witnessId, examinationType, currentQuestion: text, currentQuestionAskedBy: "prosecutor" });
    const callA = await this.jev.request({
      model: _C.JEV_MODEL,
      state: recordView as unknown as Record<string, unknown>,
      questions: buildCallA({ caseFile: this.caseFile, witnessId, examinationType, includeProsecutorObjection: false }),
    });
    const claimStatus = choiceOf(callA, "claim_status").choice as ClaimStatus;
    const impropriety = IMPROPRIETY_LEVELS[scoreOf(callA, "impropriety")] as ImproprietyLevel;
    const penalized = this.applyQuestionPenalties(claimStatus, impropriety);
    return { witnessId, text, examinationType, qEntrySeq: qEntry.seq, callA, claimStatus, impropriety, penalized };
  }

  async resolveObjectionWindow(handle: ProsecutorHandle, grounds: ObjectionGrounds | null): Promise<QuestionResult> {
    this.requirePhase("resolve the objection window", "P_DIRECT", "D_CROSS");
    if (handle.witnessId !== this.state.currentWitnessId) throw new PhaseError(this.state.phase, "stale objection handle");
    const round = this.roundForPhase();
    const details: QuestionDetails = { claimStatus: handle.claimStatus, impropriety: handle.impropriety };

    if (grounds !== null) {
      if (this.state.playerObjectionsLeft <= 0) throw new PhaseError(this.state.phase, "object (no objections left)");
      this.state.playerObjectionsLeft -= 1;
      this.addTranscript({ round, speaker: "defense", kind: "objection", text: `Objection — ${grounds}.` });
      const resp = await this.jev.request({
        model: _C.JEV_MODEL,
        state: buildRecordView(this.state, { witnessId: handle.witnessId, currentQuestion: handle.text, currentQuestionAskedBy: "prosecutor" }) as unknown as Record<string, unknown>,
        questions: buildCallO({ judgeName: this.caseFile.judge.name, judgePersona: this.caseFile.judge.persona, grounds }),
      });
      const applies = sampleNoul(noulP(resp, "grounds_apply"), this.rng);
      const sustains = applies && sampleNoul(noulP(resp, "judge_sustains"), this.rng);
      details.objectionGrounds = grounds;
      details.sustained = sustains;
      if (sustains) {
        this.addTranscript({ round, speaker: "judge", kind: "ruling", text: `${JUDGE_LINES.sustained} ${JUDGE_LINES.disregard}` });
        const qEntry = this.state.transcript.find((t) => t.seq === handle.qEntrySeq)!;
        qEntry.stricken = true; // P0-2: mark in place; speculative Call A discarded, no answer.
        this.emit({ kind: "transcript", entry: qEntry });
        await this.runCallB(`Stricken prosecutor question: ${handle.text}`);
        if (this.checkMistrial(handle.callA)) return { stricken: true, ruling: "sustained", mistrial: true, details };
        this.advanceAfterProsecutorQuestion();
        return { stricken: true, ruling: "sustained", details };
      }
      this.addTranscript({ round, speaker: "judge", kind: "ruling", text: JUDGE_LINES.overruled });
      this.setPatience(applyPatience(this.state.judgePatience, this.caseFile.judge.basePatience, { kind: "overruledExcessObjection" }));
    }

    const witness = this.caseFile.witnesses.find((w) => w.id === handle.witnessId)!;
    const answer = await this.voiceAnswer({
      witnessId: handle.witnessId, witness, text: handle.text,
      examinationType: handle.examinationType, askedBy: "prosecutor", round, callA: handle.callA, details,
    });
    if (!handle.penalized) this.applyCleanBonus();
    if (this.checkMistrial(handle.callA)) return { stricken: false, answer, mistrial: true, details };
    await this.runCallB(`${handle.text} / ${answer}`);
    this.advanceAfterProsecutorQuestion();
    return { stricken: false, answer, details };
  }

  private advanceAfterProsecutorQuestion() {
    if (this.state.phase === "P_DIRECT" && this.state.questionsAskedThisWitness >= P_DIRECT_QS) {
      this.state.questionsAskedThisWitness = 0;
      this.setPhase("P_CROSS");
    } else if (this.state.phase === "D_CROSS" && this.state.questionsAskedThisWitness >= D_CROSS_QS) {
      this.state.questionsAskedThisWitness = 0;
      if (this.state.defenseWitnessesCalled.length >= N_DEFENSE_WITNESSES) {
        this.state.currentWitnessId = undefined;
        this.setPhase("FINAL_READ");
      } else {
        this.state.currentWitnessId = undefined;
        this.setPhase("D_SELECT");
      }
    }
  }

  // ---- shared voice step: sample ruling → LLM voices → transcript + facts ----
  private async voiceAnswer(args: {
    witnessId: WitnessId;
    witness: { id: WitnessId; name: string; role: string; personality: string; speechStyle: string; relationshipToCase: string; knows: string[]; willLieAbout: { factId: string; lie: string; reason: string }[]; doesNotKnow: string; secret?: string };
    text: string;
    examinationType: ExaminationType;
    askedBy: "defense" | "prosecutor";
    round: 1 | 2 | 3 | 4;
    callA: JevResponse;
    details: QuestionDetails;
  }): Promise<string> {
    const { witnessId, witness, text, examinationType, askedBy, round, callA, details } = args;
    const stanceProbs = choiceOf(callA, "witness_stance").probabilities;
    const stance = sampleChoice(stanceProbs, this.rng);
    const truthful = sampleNoul(noulP(callA, "witness_truthful"), this.rng);
    const factProbs = choiceOf(callA, "witness_fact").probabilities;
    const factId = sampleChoice(factProbs, this.rng);
    const demeanor = sampleChoice(choiceOf(callA, "witness_demeanor").probabilities, this.rng) || "calm";
    const fact = this.caseFile.facts.find((f) => f.id === factId);
    details.stance = stance;
    details.truthful = truthful;
    details.factId = factId;
    details.demeanor = demeanor;

    const priorFacts = this.state.factsStatedByWitness[witnessId] ?? [];
    const voice = await this.llm.voiceWitness({
      witness: witness as Parameters<LLMClient["voiceWitness"]>[0]["witness"],
      knownFacts: witness.knows.map((id) => ({ id, statement: this.caseFile.facts.find((f) => f.id === id)?.statement ?? "" })),
      testimonySoFar: this.testimonySoFar(witnessId),
      priorFactsForWitness: priorFacts,
      questionText: text,
      askerRole: askedBy,
      examinationType,
      ruling: { stance, truthful, factId, factStatement: fact?.statement ?? "", demeanor },
    });
    const ok = validateWitnessVoice(voice, factId, priorFacts);
    const answerText = ok ? voice.answer : "I... don't recall.";
    const factsStated = ok ? voice.facts_stated : [];
    const aEntry = this.addTranscript({ round, speaker: witnessId, kind: "answer", text: answerText });
    this.addTestimony(witnessId, aEntry);
    for (const f of factsStated) {
      if (!this.state.revealedFacts.includes(f)) this.state.revealedFacts.push(f);
      const per = this.state.factsStatedByWitness[witnessId] ?? [];
      if (!per.includes(f)) per.push(f);
      this.state.factsStatedByWitness[witnessId] = per;
    }
    return answerText;
  }

  private checkMistrial(callA: JevResponse): boolean {
    if (!inMistrialZone(this.state.judgePatience)) return false;
    const motion = sampleNoul(noulP(callA, "mistrial_motion"), this.rng);
    if (!motion) return false;
    const granted = sampleNoul(noulP(callA, "mistrial_granted"), this.rng);
    if (granted) {
      this.grantMistrial(this.roundForPhase());
      return true;
    }
    return false;
  }

  private grantMistrial(round: 1 | 2 | 3 | 4): QuestionResult {
    this.state.outcome = "mistrial";
    this.addTranscript({ round, speaker: "judge", kind: "ruling", text: JUDGE_LINES.mistrialGranted });
    this.emit({ kind: "outcome", outcome: "mistrial" });
    this.setPhase("DONE");
    return { stricken: false, mistrial: true, details: { claimStatus: "no_claim", impropriety: "proper" } };
  }

  private async runCallB(latestExchange: string): Promise<void> {
    const bResp = await this.jev.request({
      model: _C.JEV_MODEL,
      state: buildJuryView(this.state, { latestExchange }) as unknown as Record<string, unknown>,
      questions: buildCallB({ jurorIds: this.caseFile.jurors.map((j) => j.id), personas: this.jurorPersonas() }),
    });
    await this.applyJuryResponse(bResp);
  }

  // ---- Closing + deliberation (spec §10.2, §10.4, §10.5) ----
  async submitClosing(text: string): Promise<void> {
    this.requirePhase("give a closing argument", "CLOSING");
    // The prosecution closing was generated during the final read (readDoc).
    // If the trial was constructed without it (tests), add the stub line.
    if (!this.state.transcript.some((t) => t.speaker === "prosecutor" && t.kind === "closing")) {
      const closing = await this.llm.prosecutionClosing({
        prosecutorName: this.caseFile.prosecutor.name,
        persona: this.caseFile.prosecutor.persona,
        transcript: this.state.transcript.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
      });
      this.addTranscript({ round: 4, speaker: "prosecutor", kind: "closing", text: closing });
    }
    this.addTranscript({ round: 4, speaker: "defense", kind: "closing", text });
    const factKeys = Object.fromEntries(this.caseFile.facts.map((f) => [f.id, f.statement]));
    const [aResp, bResp] = await Promise.all([
      this.jev.request({ model: _C.JEV_MODEL, state: buildRecordView(this.state, { currentQuestion: text, currentQuestionAskedBy: "defense" }) as unknown as Record<string, unknown>, questions: buildCallAOpen(factKeys) }),
      this.jev.request({
        model: _C.JEV_MODEL,
        state: buildJuryView(this.state, { latestExchange: text }) as unknown as Record<string, unknown>,
        questions: buildCallB({ jurorIds: this.caseFile.jurors.map((j) => j.id), personas: this.jurorPersonas() }),
      }),
    ]);
    this.applyClaimPatience(aResp);
    await this.applyJuryResponse(bResp);
    this.setPhase("DELIBERATION");
  }

  async deliberate(): Promise<NonNullable<TrialState["outcome"]>> {
    this.requirePhase("deliberate", "DELIBERATION");
    for (let r = 1; r <= CONFIG.DELIBERATION_ROUNDS; r++) {
      const resp = await this.jev.request({
        model: _C.JEV_MODEL,
        state: buildJuryView(this.state, { includeCurrentLeanings: true, deliberationRound: r }) as unknown as Record<string, unknown>,
        questions: buildCallD({ jurorIds: this.caseFile.jurors.map((j) => j.id), personas: this.jurorPersonas(), leanings: this.state.jurorLeanings, round: r }),
      });
      await this.applyJuryResponse(resp);
      const j = this.caseFile.jurors[r % this.caseFile.jurors.length];
      this.emit({ kind: "log", text: deliberationLine(j.label, j.id) });
      if (this.state.outcome) {
        this.setPhase("DONE");
        return this.state.outcome;
      }
    }
    const { outcome } = castVotes(this.state.jurorLeanings, this.rng);
    this.state.outcome = outcome;
    this.emit({ kind: "outcome", outcome });
    this.setPhase("DONE");
    return outcome;
  }
}
