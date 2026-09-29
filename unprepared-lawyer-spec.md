# Unprepared Lawyer — PRD / Build Spec (v0.1)

*Working title. Written to be handed to a coding agent to produce a first working draft of a single trial.*

## 1. Summary

The player is a defense lawyer who did no preparation (too many late nights) and arrives at trial knowing only the defendant's name and the charge. Over four rounds, opening statements, prosecution witnesses, defense witnesses, and closing arguments, they get five 30-second reads of case documents, three questions per witness, and whatever they can bluff. Twelve jurors, a judge, an opposing prosecutor, and the witnesses all react in real time.

**Core architecture principle: Jev decides, the LLM voices, the code keeps score.**

- A general **LLM** authors the hidden world before the trial (case file, documents, witnesses, profiles) and voices anything that needs prose during the trial (witness answers, prosecutor questions and closing).
- **Jev** (TypeSafe's System One model) makes every judgment call: objections, rulings, claim checks, what stance a witness takes, which fact they draw on, every juror's leaning, and deliberation.
- **Game code** owns all state, timers, the RNG, sampling from Jev's probabilities, judge patience, and the verdict.

The LLM never decides outcomes; it only renders decisions Jev already made. That keeps the game fair, consistent, fast, and tunable.

## 2. Scope

**In scope for this draft:** one complete single-player trial (player = defense, AI = prosecution), case generation, all four rounds, objections both ways, stricken questions, judge patience, mistrial, jury deliberation and verdict, a transcript view, and a headless simulator.

**Out of scope:** career layer, docket, double-booked days, the paralegal opener lines, multiplayer, accounts, persistence. The design leaves hooks for these (§17).

## 3. Trial structure

| Round | What happens | Player inputs | Reads |
|---|---|---|---|
| 0. Setup | Case generated (hidden). Judge reads the charge. | — | — |
| 1. Opening statements | Prosecution opens (player "drifted off"; text hidden, jury priors set by it). Player gives a blind opening. | Opening (≤ 60 s typing, ≤ 150 words) | 0 |
| 2. Prosecution witnesses (×2) | For each: player reads 1 document (30 s) → prosecutor's direct (3 questions, player may object) → player's cross (3 questions). | Doc choice, objections, 3 questions | 2 |
| 3. Defense witnesses (×2) | For each: player reads 1 document (30 s) → player's direct (3 questions, prosecutor may object) → prosecutor's cross (2 questions, player may object). | Doc choice, 3 questions, objections | 2 |
| 4. Closing arguments | Player reads 1 final document (30 s) → prosecution closes → player closes (≤ 90 s, ≤ 250 words) → deliberation → verdict. | Doc choice, closing | 1 |

Totals: 5 reads, 12 player questions, up to `PLAYER_OBJECTIONS` (default 3) objections.

The player may call any witness from the defense list for round 3 (list shows only names and one-line roles). Prosecution witnesses are chosen by the prosecutor (predetermined at generation).

**Struck questions still use up one of the player's three questions.** They also remain in the jury's transcript, marked as stricken (§10.3).

**Trial-ending events:** mistrial granted (§11) → the case is lost and transferred to another lawyer at the firm. Hung jury → the case is also transferred. Unanimous not guilty → win. Unanimous guilty → loss.

## 4. Architecture

Stack (substitutable, keep the boundaries):

- TypeScript throughout. Node.js server owns all state; React + Vite client. WebSocket or SSE for streaming events to the client.
- `LLMClient` interface (provider-agnostic). Two model slots in config: `LLM_AUTHOR_MODEL` (strong model, used once per trial for case generation) and `LLM_VOICE_MODEL` (fast model, used for live lines). Use provider structured-output / JSON mode for all LLM calls.
- `JevClient` interface with `HttpJevClient` and `MockJevClient`.
  - `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, model `jev-latest` (log the versioned `model` returned in each response).
  - Request `{ model, state, questions }`. Types: `noul` (answer `noul` 0..1), `choice` (`criteria` object, 1–255 keys; answer `choice`, `confidence`, `probabilities`), `score` (`criteria` ordered array, 2–10 levels; answer `score`, `confidence`, `probabilities` keyed "0".."N-1", `legend`).
  - Limits: 64k tokens total per request, 32k for state + the longest question. Enforce a local token estimate before sending (oversized requests error and are still billed). Rate limits: 1,200 requests/min, 250k tokens/s.
- Seeded RNG. **All Jev outputs are sampled from their probabilities, never argmax.** Nouls resolve as `rng() < p`.

```
/server
  trial/TrialEngine.ts        # state machine for rounds, timers, event emission
  trial/state.ts              # TrialState + view builders (§9)
  gen/generateCase.ts         # LLM case generation pipeline (§6)
  jev/JevClient.ts
  jev/calls/*.ts              # one builder per Jev call type (§8, §13)
  llm/LLMClient.ts
  llm/prompts/*.ts            # witness, prosecutor, case-gen prompts (§7, §12)
  rules/patience.ts           # judge patience, mistrial gating (§11)
  rules/sampling.ts
  rules/verdict.ts
  templates/*.ts              # judge lines, log lines
/client                       # screens: charge, opening, doc bins, witness stand, jury box, closing, verdict
/shared/types.ts, /shared/config.ts
/scripts/sim.ts               # headless trial with scripted or random player input
/fixtures/                    # recorded cases and Jev responses
```

## 5. Data model (shared/types.ts, abridged)

```ts
type FactId = string;       // "F01".."F40"
type WitnessId = string;    // "W1".."W8"
type JurorId = string;      // "J1".."J12"
type DocId = string;        // "D01".."D16"

interface Fact {
  id: FactId;
  statement: string;               // canonical, one sentence
  favors: "prosecution" | "defense" | "neutral";
  importance: 1 | 2 | 3;           // 3 = case-turning
}

interface CaseDocument {
  id: DocId;
  bin: string;                     // "Box 7", "Evidence Bag 23", "Misc. — DO NOT OPEN"
  title: string;                   // "Police Report #4471", "Receipt (crumpled)"
  body: string;                    // 150–600 words, key facts buried
  factIds: FactId[];               // facts this document establishes
}

interface Witness {
  id: WitnessId;
  name: string;
  role: string;                    // one line shown to player: "Café owner"
  calledBy: "prosecution" | "defense";
  personality: string;             // 2–3 sentences
  speechStyle: string;             // "Short, clipped answers. Says 'look' a lot."
  relationshipToCase: string;
  knows: FactId[];                 // facts they can testify to
  willLieAbout: { factId: FactId; lie: string; reason: string }[];
  doesNotKnow: string;             // what they're clueless about
  secret?: string;                 // something unrelated they might blurt out
}

interface JurorProfile { id: JurorId; label: string; persona: string; } // label: "Retired sea captain"
interface JudgeProfile { name: string; persona: string; strictness: 1|2|3|4|5; basePatience: number; }
interface ProsecutorProfile { name: string; persona: string; objectionTendency: 1|2|3|4|5; }

interface CaseFile {
  caseTitle: string;               // "The People v. Gerald the Goose"
  defendant: string;
  charge: string;
  truth: string;                   // what actually happened (hidden, 150–300 words)
  facts: Fact[];
  documents: CaseDocument[];
  witnesses: Witness[];            // 2 prosecution + 4–6 defense options
  judge: JudgeProfile;
  prosecutor: ProsecutorProfile;
  jurors: JurorProfile[];          // exactly 12
  prosecutionOpening: string;      // hidden from player
  prosecutionDirectPlan: Record<WitnessId, string[]>; // 3 pre-written questions per prosecution witness
}

interface TranscriptEntry {
  seq: number;
  round: 1 | 2 | 3 | 4;
  speaker: "prosecutor" | "defense" | "judge" | WitnessId;
  kind: "opening" | "question" | "answer" | "objection" | "ruling" | "closing" | "note";
  text: string;
  stricken?: boolean;              // jury was instructed to disregard
  hiddenFromPlayer?: boolean;      // prosecution opening
}

interface TrialState {
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
  outcome?: "not_guilty" | "guilty" | "hung_jury" | "mistrial";
}
```

## 6. Case generation (LLM, before the trial)

Runs behind a loading screen (the paralegal "you did it again" line goes here later). Target: under ~15 s.

### 6.1 Pipeline and parallelism

```
Stage 1 (sequential, AUTHOR model):
  core = { caseTitle, defendant, charge, truth, facts[25–40], witnesses[] (without prose details), judge, prosecutor }

Stage 2 (parallel, all depend only on `core`):
  2a. documents — split into 3–4 parallel calls of ~4 documents each (bins/titles assigned in stage 1)
  2b. witness details — one call per witness, in parallel (personality, speechStyle, knows, willLieAbout, doesNotKnow, secret)
  2c. jurors — one call for all 12 profiles
  2d. prosecution opening + prosecutionDirectPlan — one call

Stage 3 (code + Jev, parallel):
  3a. Schema validation (zod). Retry the failing piece once.
  3b. Jev document check: one Jev call per document, all in parallel, asking one noul per claimed factId:
      "Does this document establish the following fact: <statement>?" Drop factIds with p < 0.6.
  3c. Token budget check: record view (§9) must fit the Jev state budget with margin.
```

### 6.2 Case generation requirements (include in the stage 1 prompt)

- Absurd but internally consistent comic premise (defendants can be people, animals, objects, institutions). PG-13.
- The truth must be discoverable: the defendant should be genuinely innocent, genuinely guilty, or guilty of something other than what's charged (roughly equal odds, chosen by code and passed into the prompt).
- 3–5 facts with importance 3. Each must appear in at least one document **and** be known by at least one witness.
- Documents must be skimmable-but-cluttered: most content is irrelevant, key facts are buried mid-paragraph, in parentheticals, footnotes, or asides. At least two documents contradict each other on a minor detail. At least two documents are complete red herrings.
- At least one prosecution witness lies about something the documents can disprove.
- Every defense-list witness knows at least one fact; at least one knows nothing useful but is extremely confident.

## 7. Witness voice (LLM, live)

Witness lines are produced **after** Jev has decided the stance, truthfulness, fact, and demeanor. The LLM's only job is to render that decision in character.

### 7.1 Witness system prompt

```
You are voicing a witness on the stand in a comedy courtroom game. Stay in character. You do not decide
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
{{#each knownFacts}}- [{{id}}] {{statement}}{{/each}}

LIES THIS WITNESS TELLS (use only when the RULING says to lie about that fact):
{{#each willLieAbout}}- About [{{factId}}]: says "{{lie}}" because {{reason}}{{/each}}

SECRET (only if the RULING says the witness blurts something unrelated): {{secret}}

TESTIMONY SO FAR (this witness):
{{testimonySoFar}}

CURRENT QUESTION from {{askerRole}} ({{examinationType}}):
"{{questionText}}"

RULING (must be followed exactly):
- Stance: {{stance}}              // one of the stance options, with its description
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
  "facts_stated": ["<fact ids actually stated, truthfully or as lies>"] }
```

Code validates `facts_stated ⊆ {chosen fact} ∪ facts already in this witness's testimony`. On violation, regenerate once, then fall back to a template (§15).

### 7.2 Why stance comes from Jev, not the LLM

- **Fairness:** a witness can't confirm something they never witnessed, however leading the question, because Jev chooses from the witness's known facts only.
- **Calibration and variety:** sampling Jev's stance probabilities gives the right amount of surprise; an LLM deciding on its own tends to be either too cooperative or too random.
- **Tunability:** stance probabilities can be nudged in code (e.g. hostile witnesses) without prompt edits.

## 8. The question pipeline (the core loop)

Every question to a witness (by either side) runs the same pipeline. Three steps, two of them Jev.

```
            question text
                 │
      ┌──────────▼───────────┐
      │  Jev Call A (RECORD) │  ~70–500 ms
      │  rulings + stance    │
      └──────────┬───────────┘
          sample in order (§8.2)
                 │  question stands?
         no ─────┤───── yes
          │      │
   stricken      ▼
   entry   LLM witness voice (§7)  ~0.7–2 s, fast model
          │      │
          └──────▼───────────┐
      ┌──────────────────────▼┐
      │  Jev Call B (JURY)    │  ~70–500 ms  (runs while the answer typewriters out)
      │  12 leanings + 12     │
      │  reactions            │
      └───────────────────────┘
```

Call A and Call B are **deliberately split**: they use different states (§9). Call A needs the full hidden record; the jury must never see it. Call B also depends on the witness's generated answer text, which doesn't exist until after Call A.

### 8.1 Jev Call A — question adjudication (RECORD view)

One request containing all of the following. All share one state, so they are answered in parallel in one call; conditional ones are phrased "If…" and gated by code.

| Key | Type | Purpose |
|---|---|---|
| `claim_status` | choice | Does the question assert/presuppose a fact? `supported` / `contradicted` / `not_in_record` / `no_claim` |
| `claim_fact` | choice | Which fact the claim most relates to: keys = all FactIds + `none` (≤ 255) |
| `impropriety` | score | `["proper","borderline","improper","flagrant","outrageous"]` — given examination type (leading is fine on cross) |
| `prosecutor_objects` | noul | "Does {{prosecutor persona}} object to this question?" (omit when the prosecutor is asking) |
| `objection_grounds` | choice | leading, hearsay, relevance, speculation, argumentative, badgering, assumes_facts, compound |
| `judge_sustains` | noul | "If the prosecutor objects on the most likely grounds, does {{judge persona}} sustain?" |
| `mistrial_motion` | noul | "Given the defense's conduct so far, does the prosecutor move for a mistrial?" |
| `mistrial_granted` | noul | "If a mistrial is requested, does the judge grant it?" |
| `witness_stance` | choice | see §8.3 |
| `witness_truthful` | noul | "Does the witness answer truthfully, given what they would lie about?" |
| `witness_fact` | choice | keys = this witness's `knows` FactIds + `none` |
| `witness_demeanor` | choice | calm, nervous, defensive, hostile, delighted, confused, bored |

Question instructions embed the relevant persona directly (judge persona inside `judge_sustains`, etc.) rather than in state, to keep the state small (§9.3).

### 8.2 Sampling order (code)

1. Sample `claim_status`, `claim_fact`, `impropriety` → record, adjust judge patience (§11).
2. If the prosecutor is the questioner, skip to the player objection window instead (§8.4).
3. Sample `prosecutor_objects`. If yes: sample `objection_grounds`, then `judge_sustains`.
   - Sustained → add the question to the transcript with `stricken: true`, emit ruling. Question slot consumed. Skip to step 5 (Call B still runs: jurors heard it).
4. Question stands → sample `witness_stance`, `witness_truthful`, `witness_fact`, `witness_demeanor` → LLM voice → transcript.
5. Mistrial gate (§11): only if patience ≤ `MISTRIAL_ZONE`, sample `mistrial_motion` then `mistrial_granted`.
6. Run Call B.

### 8.3 Witness stance options (criteria)

```
confirms              — agrees with what the question suggests
partially_confirms    — agrees with part of it, with a complication
denies                — disagrees
doesnt_know           — doesn't know or didn't see
evasive               — dodges the question
rambles               — goes off on a tangent, eventually gets near an answer
volunteers_more       — answers and adds something the asker didn't ask for
contradicts_self      — says something inconsistent with earlier testimony
blurts_secret         — says something unrelated and incriminating about themselves (rare)
```

### 8.4 Prosecutor questions and player objections

- Prosecutor's **direct** questions on prosecution witnesses are pre-written at generation (`prosecutionDirectPlan`); no live LLM call needed to produce them.
- Prosecutor's **cross** questions on defense witnesses are generated live by the LLM right after the player's direct ends (§12.1). Show a "The prosecutor rises…" beat while generating.
- When a prosecutor question is displayed, the player gets a `OBJECTION_WINDOW_MS` (default 4000) window with an Objection button and a grounds picker.
- **Speculative parallelism:** start Call A for the prosecutor's question (without prosecution-objection keys) **at the same time** the objection window opens. Most of the time the player won't object and the witness ruling is already there when the window closes.
- If the player objects: Jev **Call O** (RECORD view) with `judge_sustains` for the chosen grounds + `grounds_apply` noul. Sustained → prosecutor's question stricken, discard speculative Call A results. Overruled → use them.

### 8.5 Jev Call B — jury update (JURY view)

One request, 24 questions:

- `J1`…`J12` — noul: "{{juror persona}}. Having heard everything in court so far, including the latest exchange, does this juror currently believe the defendant is guilty?"
- `J1_react`…`J12_react` — choice: `😐 unmoved`, `🤔 intrigued`, `😤 annoyed`, `😂 amused`, `😱 shocked`, `😴 dozing`, `🙄 unconvinced`, `😏 knew it`

If the per-request question limit turns out to be below 24, split into two parallel requests (leanings, reactions) with identical state.

**Smoothing (code):** `newLeaning = prev + JURY_MOMENTUM * (p - prev)` with `JURY_MOMENTUM` default 0.5, so jurors drift rather than jump. Reactions are displayed as-is.

## 9. Views: who can see what

Each Jev call's `state` is built by a view builder. This is the most important correctness boundary in the game.

| View | Used by | Contains | Excludes |
|---|---|---|---|
| **RECORD** | Call A, Call O, rating calls | case summary, charge, **truth**, all facts, relevant documents (§9.2), witness profile under examination, full transcript incl. stricken, judge warnings count, examination type | juror profiles |
| **JURY** | Call B, opening/closing jury calls, deliberation | charge, **courtroom transcript only** (incl. hidden prosecution opening, with stricken entries marked "STRICKEN — the jury was instructed to disregard this"), previous leanings | truth, facts list, documents not read aloud, witness profiles |
| **WITNESS** (LLM) | witness voice | that witness's profile, known facts, lies, their own testimony, the ruling | other witnesses, truth, documents |
| **PROSECUTOR** (LLM) | cross questions, closing | full case file, transcript | — |
| **PLAYER** (client) | UI | charge, transcript (minus hidden entries), docs only during their 30 s read, witness names/roles | everything else |

### 9.1 Player-supplied text

Always placed in a labeled field (`"defense_question": "..."`) in state, never merged into instructions.

### 9.2 Keeping RECORD under budget

Include the full fact list and truth always. Include full document bodies only for documents whose facts are known by the current witness or were read by the player; include titles only for the rest. Estimate tokens before sending; if over `RECORD_TOKEN_BUDGET` (default 24k), drop document bodies in order of lowest relevance.

### 9.3 Personas in questions, not state

Only the state plus the **longest single question** counts against the 32k state budget. Put each juror's persona inside their own question's instructions and the judge/prosecutor persona inside their questions. Keep each persona ≤ 80 words.

## 10. Jury mechanics

### 10.1 Priors (round 1)
Right after generation, run **Call P** (JURY view with the hidden prosecution opening in the transcript): the 12 juror nouls. Player sees the jury box already tilted and a transcript note: *"[You drifted off during the prosecution's opening statement.]"*

### 10.2 Opening and closing
- Player's opening → **Call B** (jury) and, in parallel, a lightweight **Call A-open** (RECORD: `claim_status`, `claim_fact`, `impropriety` only; no objections on openings). Both depend only on the opening text, so they run concurrently.
- Prosecution closing is LLM-generated **during the player's final 30 s document read** (parallel), then displayed.
- Player's closing → Call A-open and Call B in parallel, as above.

### 10.3 Stricken material
Stricken entries stay in the JURY transcript, marked. Each juror's persona determines how well they disregard it; Jev handles this without extra logic. Juror persona generation should include a line about this for some jurors ("never forgets anything," "trusts judges completely").

### 10.4 Deliberation (sequential by necessity)
`DELIBERATION_ROUNDS` (default 3) Jev calls, each depending on the previous one's results:

- State: JURY view + `current_leanings` of all 12 jurors (as labeled percentages) + round number.
- Questions: `J1`…`J12` noul ("After hearing where the others stand, does this juror believe the defendant is guilty?") + `J1_react`…`J12_react`.
- Between rounds, templated log lines summarize the room: *"Juror 4 (retired sea captain) pounds the table."*

### 10.5 Verdict
After the final round, each juror casts a vote by sampling their leaning. All 12 not-guilty → **win**. All 12 guilty → **loss**. Otherwise → **hung jury** → case transferred. Show every juror's final probability next to their vote.

## 11. Judge patience, warnings, mistrial

- `judgePatience` starts at `judge.basePatience` (60–100, from strictness).
- Deltas (config): sustained objection against player −8; `impropriety` = improper −5, flagrant −12, outrageous −20; `claim_status = contradicted` −4; per excess objection by player that is overruled −3; strong answers or clean examinations +2 (cap at base).
- At `WARNING_THRESHOLD` (default 40) the judge warns once ("Counsel, approach the bench"), templated.
- **Mistrial zone:** only when patience ≤ `MISTRIAL_ZONE` (default 20) does code sample `mistrial_motion` and `mistrial_granted` from Call A. Granted → trial ends, outcome `mistrial`, case transferred. Outside the zone these answers are recorded for tuning but ignored.
- Judge and ruling lines use templates, not the LLM: "Sustained." / "Overruled." / "The jury will disregard that." / "I'll allow it, but tread carefully, counsel."

## 12. Other LLM prompts

### 12.1 Prosecutor voice (cross questions, closing)
```
You are {{prosecutor.name}}, the prosecutor in a comedy courtroom game. Persona: {{persona}}.
You know the full case file (below) and want a guilty verdict. You are competent, prepared, and slightly smug.
Write {{n}} cross-examination questions for {{witness.name}} based on the transcript, aimed at undermining
what the defense established. Each question: one sentence, ≤ 25 words, answerable by the witness.
Do not reference facts the witness could not know. PG-13.
OUTPUT JSON ONLY: { "questions": ["...", "..."] }
```
Closing variant: 120–180 words, references only things said in court (use JURY view transcript as its source for what can be cited), no new evidence.

### 12.2 Case generation
Stage prompts per §6. All return JSON matching the schemas in §5; include the schema in the prompt and use the provider's structured output mode.

## 13. Call inventory

| # | Call | Engine | When | Parallel with | View |
|---|---|---|---|---|---|
| G1 | Core case | LLM author | trial start | — | — |
| G2a–d | Docs / witnesses / jurors / opening+plan | LLM author | after G1 | each other | — |
| G3 | Doc fact checks (1 per doc) | Jev | after G2a | each other, G2b–d | doc text |
| P | Jury priors | Jev | after gen | — | JURY |
| A-open | Opening claim/impropriety | Jev | after player opening | B | RECORD |
| A | Question adjudication | Jev | each question | O (spec.) | RECORD |
| O | Player objection ruling | Jev | player objects | A (spec.) | RECORD |
| V | Witness voice | LLM voice | after A (if question stands) | — | WITNESS |
| B | Jury update | Jev | after V / after strike | answer typewriter display | JURY |
| X | Prosecutor cross questions | LLM voice | after player's direct | — | PROSECUTOR |
| C | Prosecution closing | LLM voice | start of final read | player's read timer | PROSECUTOR |
| A-close | Closing claim check | Jev | after player closing | B | RECORD |
| D1–D3 | Deliberation | Jev | after closings | — (sequential) | JURY |

**Rule of thumb for combining vs splitting:**
- *Combine* questions into one Jev request when they share the same state and don't depend on each other's sampled outcome (conditional questions are fine — phrase them "If…" and gate in code).
- *Split* when the state differs (RECORD vs JURY information boundary), when a later decision depends on generated text (Call B needs the answer), or when a decision depends on a previous sampled result across the whole group (deliberation rounds).

## 14. Latency budget

Per player question: Call A (≤ 0.5 s) → witness voice (≤ 2 s, fast model, ~60 output tokens) → Call B (≤ 0.5 s, overlapped with the answer's typewriter display). Mask with a brief "the witness considers the question…" animation. Target: the answer starts appearing within 2.5 s of submitting.

## 15. Error handling

- Jev: timeout `JEV_TIMEOUT_MS` (default 3000), one retry, then fallback answers (uniform choice/score, noul 0.5, jury leanings unchanged). Log every fallback.
- LLM voice: timeout 6 s, one retry, then template: stance-based stock lines ("I… don't recall."; "Yes, that's right."; "Absolutely not.").
- Case generation failure: retry the failing stage; after two failures load a bundled fixture case.
- Never block the trial on a single failed call.

## 16. Configuration

```
READ_SECONDS = 30            OPENING_SECONDS = 60        CLOSING_SECONDS = 90
QUESTION_SECONDS = 45        OBJECTION_WINDOW_MS = 4000  PLAYER_OBJECTIONS = 3
PROSECUTION_DIRECT_QS = 3    PROSECUTION_CROSS_QS = 2    DEFENSE_QS = 3
JURY_MOMENTUM = 0.5          DELIBERATION_ROUNDS = 3
WARNING_THRESHOLD = 40       MISTRIAL_ZONE = 20          patience deltas (§11)
RECORD_TOKEN_BUDGET = 24000  JEV_MODEL = "jev-latest"    JEV_TIMEOUT_MS = 3000
LLM_AUTHOR_MODEL, LLM_VOICE_MODEL
TRUTH_DISTRIBUTION = { innocent: 0.34, guilty: 0.33, other_crime: 0.33 }
```

## 17. Hooks for later

- `LawyerRecord` object (wins, losses, mistrials, contempt count) — included in RECORD view as "Counsel's reputation" when the career layer exists; empty for now.
- `TrialEngine` accepts an injected `CaseFile` so a docket can queue cases later.
- Keep judge/juror/prosecutor profiles reusable across trials (recurring judges).

## 18. Testing

- `MockJevClient` + seeded RNG → full trials are deterministic; snapshot-test transcripts.
- Unit tests: sampling order and gating (§8.2), stricken handling, patience math, verdict logic, view builders (assert the JURY view never contains truth, facts, or unread document text).
- Witness guardrail test: feed rulings to the voice prompt and assert `facts_stated` stays within the allowed set across many runs.
- `scripts/sim.ts`: run a full trial against real APIs with player inputs from a script file (or a "random lawyer" mode using the LLM), printing the transcript, all Jev probabilities, and patience over time. This is the primary tuning tool.

## 19. Acceptance criteria

1. A full trial runs end to end: charge → opening → 2 prosecution witnesses → 2 defense witnesses → closings → deliberation → verdict.
2. The player gets exactly 5 timed reads and 12 questions; struck questions consume a slot.
3. Prosecution objections and player objections both work; sustained questions appear stricken but still move jurors.
4. Witness answers never state facts outside the Jev-chosen fact and prior testimony (validated).
5. The jury box updates with 12 leanings and emoji after every exchange.
6. Judge patience drops visibly with misconduct; a warning appears; a mistrial is possible and ends the trial.
7. JURY-view state never includes hidden information (tested).
8. `scripts/sim.ts` runs headlessly.

## 20. Open questions

- Jev's per-request question limit (Call B uses 24 questions). Test early; split if needed.
- Should `witness_stance` be biased by examination type in code (friendlier on direct, more hostile on cross), or left to Jev with the examination type in state? Start with state only.
- Whether to show the player a notepad during reads, or rely purely on memory (default: no notepad).
- Right difficulty for `TRUTH_DISTRIBUTION` — a guilty client is much harder to win for; playtest.
- Whether the prosecution opening should be revealed after the verdict (probably yes — it's funny to see what you missed).
