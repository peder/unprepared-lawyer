// Voice-model bench (Review 05 §3): one realistic witness-voice request to each
// candidate free model, 3× sequentially. Table: median/p95 ms, JSON-valid %,
// guardrail-pass %, first answer. Default LLM_VOICE_MODEL comes from this.
//   npx tsx scripts/llm-bench.ts [model ...]   (needs OPENROUTER_API_KEY)
import "./env.js";
import { DirectLLMClient } from "../server/llm/DirectLLMClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

const DEFAULTS = [
  "poolside/laguna-xs-2.1:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-26b-a4b-it:free",
];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Share of fact-statement tokens appearing in the answer (review 07: verbatim%). */
export function tokenOverlap(fact: string, answer: string): number {
  const f = new Set(fact.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (f.size === 0) return 0;
  const a = new Set(answer.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let hit = 0;
  for (const w of f) if (a.has(w)) hit += 1;
  return hit / f.size;
}

const STANCES = ["confirms", "evasive", "denies", "rambles", "volunteers_more"] as const;

async function voiceOnce(client: DirectLLMClient, witness: (typeof FIXTURE_CASE.witnesses)[number], fact: (typeof FIXTURE_CASE.facts)[number], stance: (typeof STANCES)[number]) {
  return client.voiceWitness({
    witness,
    knownFacts: [{ id: "F05", statement: fact.statement }, { id: "F06", statement: "seed trail" }],
    testimonySoFar: "",
    priorFactsForWitness: [],
    questionText: "What did you hear that afternoon?",
    askerRole: "defense",
    examinationType: "direct_defense",
    ruling: { stance, truthful: true, factId: "F05", factStatement: fact.statement, demeanor: "nervous" },
  });
}

async function main() {
  const models = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = models.length ? models : DEFAULTS;
  const witness = FIXTURE_CASE.witnesses[2]; // Petunia Wicks
  const fact = FIXTURE_CASE.facts.find((f) => f.id === "F05")!;
  console.log("model | n | median ms | p95 ms | live% | guardrail% | reasonTok | verbatim% | samples");
  for (const m of list) {
    const client = new DirectLLMClient(process.env.OPENROUTER_API_KEY ?? "", m, fetch, 20000);
    const ms: number[] = [];
    let live = 0;
    let guardOk = 0;
    let verbatim = 0;
    let reasonTok: number | null = null;
    const samples: string[] = [];
    for (let i = 0; i < STANCES.length; i++) {
      if (i > 0) await sleep(8000); // free-tier rate limits
      const stance = STANCES[i];
      const t0 = Date.now();
      // One 429 retry: free models shed load; the game path stays single-attempt.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await voiceOnce(client, witness, fact, stance);
        ms.push(Date.now() - t0);
        if (r.timings) {
          live += 1;
          if (reasonTok === null) reasonTok = r.timings.reasoningTokens ?? 0;
          if (r.facts_stated.includes("F05")) guardOk += 1;
          const overlap = tokenOverlap(fact.statement, r.answer);
          if (overlap > 0.6) verbatim += 1;
          samples.push(`[${stance} ${Math.round(overlap * 100)}%] ${r.answer.slice(0, 140)}`);
          break;
        }
        await sleep(8000);
      }
    }
    ms.sort((a, b) => a - b);
    console.log(`${m} | ${STANCES.length} | ${Math.round(quantile(ms, 0.5))} | ${Math.round(quantile(ms, 0.95))} | ${Math.round((live / STANCES.length) * 100)} | ${Math.round((guardOk / STANCES.length) * 100)} | ${reasonTok ?? "-"} | ${Math.round((verbatim / Math.max(1, live)) * 100)}`);
    for (const s of samples) console.log(`  ${s}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
