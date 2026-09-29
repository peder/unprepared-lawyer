// Short live-Jev smoke: priors + opening + one full prosecutor direct question +
// one defense cross, all against the real TypeSafe API. ~10 calls.
//   npx tsx scripts/jev-smoke.ts   (needs TYPESAFE_API_KEY in env or .env)
import "./env.js";
import { TrialEngine } from "../server/trial/TrialEngine.js";
import { HttpJevClient } from "../server/jev/JevClient.js";
import { createLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { generateCase } from "../server/gen/generateCase.js";

async function main() {
  const caseFile = await generateCase();
  const eng = new TrialEngine(caseFile, new HttpJevClient(), createLLMClient(), { seed: 42 });
  const t0 = Date.now();
  const lap = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  await eng.setupPriors();
  lap(`priors: ${JSON.stringify(eng.state.jurorLeanings)}`);
  await eng.submitOpening("Geese cannot carry pumpkins, ladies and gentlemen.");
  lap(`opening done, patience=${eng.state.judgePatience}`);
  await eng.readDoc("D01");
  lap(`read D01, phase=${eng.status().phase}`);

  for (let i = 0; i < 3; i++) {
    const h = await eng.beginProsecutorQuestion({ witnessId: "W1" });
    if (i === 0) lap(`P-direct: "${h.text}" claim=${h.claimStatus} improp=${h.impropriety}`);
    const r1 = await eng.resolveObjectionWindow(h, null);
    if (i === 2) {
      lap(`answered: "${r1.answer}" stance=${r1.details.stance} fact=${r1.details.factId} jury=${JSON.stringify(eng.state.jurorLeanings)}`);
    }
  }

  const r2 = await eng.askDefenseQuestion({ witnessId: "W1", text: "Isn't it true the forklift knocked the stand?" });
  lap(`cross: stricken=${r2.stricken} stance=${r2.details.stance} truthful=${r2.details.truthful} patience=${eng.state.judgePatience}`);
  lap(`reactions: ${JSON.stringify(eng.state.jurorReactions)}`);
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", (e as Error).message);
  process.exit(1);
});
