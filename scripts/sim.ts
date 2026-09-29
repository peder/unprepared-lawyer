// Headless simulator (spec §18): full trial against the real phase machine.
// Prints per question: phase, questions left, reads left, sampled Jev decisions,
// patience, and juror leanings. Mock jury leanings VARY (dynamicNoul) so the
// jury visibly moves: prosecution evidence pushes guilty, defense pushes back.
import "./env.js";
import { TrialEngine } from "../server/trial/TrialEngine.js";
import { MockJevClient, HttpJevClient, type JevClient, type JevRequest } from "../server/jev/JevClient.js";
import { createLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { generateCase } from "../server/gen/generateCase.js";

const mode = process.argv[2] ?? "scripted";

// Scripted leanings per examination side so the mock jury drifts visibly.
function dynamicNoul(side: { current: "prosecution" | "defense" }) {
  return (req: JevRequest, key: string): number | undefined => {
    if (/^J\d+$/.test(key)) {
      // Prosecution evidence pushes guilty; defense pushes back. Varies per juror.
      const n = Number(key.slice(1));
      const base = side.current === "prosecution" ? 0.55 + (n % 4) * 0.06 : 0.38 + (n % 3) * 0.05;
      return Math.min(0.92, Math.max(0.08, base));
    }
    if (key.endsWith("_react")) return undefined; // default slug distribution
    return undefined;
  };
}

function leanStr(leanings: Record<string, number>): string {
  const avg = Object.values(leanings).reduce((a, b) => a + b, 0) / 12;
  return `avg=${avg.toFixed(2)} [${Object.values(leanings).map((p) => p.toFixed(2)).join(" ")}]`;
}

async function main() {
  const caseFile = await generateCase();
  const side: { current: "prosecution" | "defense" } = { current: "prosecution" };
  // JEV_CLIENT=http uses the real TypeSafe API (needs TYPESAFE_API_KEY); default is the mock.
  const live = (process.env.JEV_CLIENT ?? "mock").toLowerCase() === "http";
  const jev: JevClient = live
    ? new HttpJevClient()
    : new MockJevClient({}, "jev-mock-0.1", dynamicNoul(side));
  const llm = createLLMClient(); // stub by default; LLM_PROVIDER=opencode for live voice
  const eng = new TrialEngine(caseFile, jev, llm, {
    seed: 1234,
    onEvent: (e) => {
      if (e.kind === "transcript") {
        // eslint-disable-next-line no-console
        console.log(`  | [${e.entry.speaker}/${e.entry.kind}] ${e.entry.text.slice(0, 110)}${e.entry.stricken ? " [STRICKEN]" : ""}`);
      }
      if (e.kind === "outcome") console.log(`  OUTCOME: ${e.outcome}`);
    },
  });
  const show = (label: string, extra = "") => {
    const s = eng.status();
    // eslint-disable-next-line no-console
    console.log(
      `[${s.phase} qLeft=${s.questionsLeftForThisWitness} readsLeft=${s.readsLeft} obj=${s.objectionsLeft} patience=${eng.state.judgePatience}] ${label}${extra}`,
    );
  };
  const status = () => eng.status();

  await eng.setupPriors();
  show("priors set", ` jury ${leanStr(eng.state.jurorLeanings)}`);
  await eng.submitOpening("Ladies and gentlemen, my client is a goose, and geese cannot carry pumpkins. Thank you.");
  show("opening given", ` jury ${leanStr(eng.state.jurorLeanings)}`);

  const scriptedCross = ["Were you even looking?", "What did you actually see?", "Isn't it true the forklift did it?"];
  const prosWits = caseFile.witnesses.filter((w) => w.calledBy === "prosecution");
  const defWits = caseFile.witnesses.filter((w) => w.calledBy === "defense");

  let pdi = 0; // distinct docs per read (fixture has 4; re-reads are free)
  for (const w of prosWits) {
    side.current = "prosecution";
    const doc = caseFile.documents[pdi++ % caseFile.documents.length];
    await eng.readDoc(doc.id);
    show(`read ${doc.id} before ${w.id}`);
    for (const pq of caseFile.prosecutionDirectPlan[w.id] ?? []) {
      const h = await eng.beginProsecutorQuestion({ witnessId: w.id });
      const wantObject = mode === "random" && Math.random() < 0.3;
      const r = await eng.resolveObjectionWindow(h, wantObject ? "relevance" : null);
      const d = r.details;
      show(`P-direct "${pq.slice(0, 40)}…" stricken=${r.stricken} sustained=${d.sustained ?? "-"}`, ` jury ${leanStr(eng.state.jurorLeanings)}`);
      if (r.mistrial || eng.state.outcome) break;
    }
    if (eng.state.outcome) break;
    side.current = "defense";
    for (const q of scriptedCross) {
      const r = await eng.askDefenseQuestion({ witnessId: w.id, text: q });
      const d = r.details;
      show(
        `cross "${q.slice(0, 40)}…" stricken=${r.stricken} obj=${d.prosecutorObjects} grounds=${d.objectionGrounds ?? "-"} stance=${d.stance} truthful=${d.truthful} fact=${d.factId} claim=${d.claimStatus} improp=${d.impropriety}`,
        ` jury ${leanStr(eng.state.jurorLeanings)}`,
      );
      if (r.mistrial || eng.state.outcome) break;
    }
    if (eng.state.outcome) break;
  }

  let di = 2;
  for (const w of defWits.slice(0, 2)) {
    if (eng.state.outcome) break;
    side.current = "defense";
    eng.selectDefenseWitness(w.id);
    const doc = caseFile.documents[di++ % caseFile.documents.length];
    await eng.readDoc(doc.id);
    show(`called ${w.id}, read ${doc.id}`);
    for (const q of scriptedCross) {
      const r = await eng.askDefenseQuestion({ witnessId: w.id, text: q });
      const d = r.details;
      show(`direct "${q.slice(0, 40)}…" stance=${d.stance} fact=${d.factId}`, ` jury ${leanStr(eng.state.jurorLeanings)}`);
      if (r.mistrial || eng.state.outcome) break;
    }
    if (eng.state.outcome) break;
    side.current = "prosecution";
    const cross = await llm.prosecutorCross({ prosecutorName: caseFile.prosecutor.name, persona: caseFile.prosecutor.persona, witness: w, transcript: "", n: 2 });
    for (const q of cross) {
      const h = await eng.beginProsecutorQuestion({ witnessId: w.id, text: q });
      const r = await eng.resolveObjectionWindow(h, null);
      show(`P-cross "${q.slice(0, 40)}…" stance=${r.details.stance}`, ` jury ${leanStr(eng.state.jurorLeanings)}`);
      if (r.mistrial || eng.state.outcome) break;
    }
  }

  if (!eng.state.outcome) {
    await eng.readDoc(caseFile.documents[0].id); // final read (re-open is free, still advances)
    show("final read done");
    await eng.submitClosing("The seeds point to the pond. The forklift clipped the stand. My client sat to keep it warm. Acquit.");
    show("closing given", ` jury ${leanStr(eng.state.jurorLeanings)}`);
    const outcome = await eng.deliberate();
    console.log(`FINAL: ${outcome} (phase=${status().phase})`);
    console.log(`docsRead=${eng.state.docsRead.length} transcript=${eng.state.transcript.length} patience=${eng.state.judgePatience}`);
  } else {
    console.log(`ENDED EARLY: ${eng.state.outcome}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
