// LLM case authoring pipeline (spec §6). Runs once per trial behind a loading
// screen; target ~15s with a strong model (free local models are slower — fine).
// Transport-agnostic: any { complete(prompt): Promise<string> } works; the
// headless-opencode adapter is OpencodeLLMClient.author().
//
//   Stage 1 (sequential, AUTHOR model): core (title/defendant/charge/truth,
//             facts, witness roster, doc bins, judge, prosecutor)
//   Stage 2 (parallel): 2a docs (3–4 calls) / 2b witness details (1/witness) /
//             2c jurors / 2d prosecution opening + direct plan
//   Stage 3 (code + Jev): schema validation (retry once), Jev doc fact-check
//             (drop factIds with p < 0.6), token budget check.
//
// Any stage failing twice → caller falls back to the fixture case (spec §15).
import { z } from "zod";
import { CONFIG } from "@shared/config.js";
import type { CaseFile, Fact, Witness } from "@shared/types.js";
import type { JevClient } from "../jev/JevClient.js";
import { estimateTokens } from "../jev/JevClient.js";
import { extractJson } from "../llm/OpencodeLLMClient.js";

export interface AuthorTransport {
  complete(prompt: string): Promise<string>;
}

const FactSchema = z.object({
  id: z.string().regex(/^F\d+$/),
  statement: z.string().min(10).max(300),
  favors: z.enum(["prosecution", "defense", "neutral"]),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
const WitnessCoreSchema = z.object({
  id: z.string().regex(/^W\d+$/),
  name: z.string().min(2),
  role: z.string().min(2),
  calledBy: z.enum(["prosecution", "defense"]),
});
const DocBinSchema = z.object({ id: z.string().regex(/^D\d+$/), bin: z.string().min(2), title: z.string().min(2) });
const CoreSchema = z.object({
  caseTitle: z.string().min(4),
  defendant: z.string().min(2),
  charge: z.string().min(10),
  truth: z.string().min(100).max(2500),
  facts: z.array(FactSchema).min(12),
  witnesses: z.array(WitnessCoreSchema).min(6).max(8),
  docBins: z.array(DocBinSchema).min(8).max(16),
  judge: z.object({ name: z.string(), persona: z.string().max(500), strictness: z.number().int().min(1).max(5), basePatience: z.number().int().min(60).max(100) }),
  prosecutor: z.object({ name: z.string(), persona: z.string().max(500), objectionTendency: z.number().int().min(1).max(5) }),
});
const DocBodySchema = z.object({
  id: z.string(),
  body: z.string().min(200),
  factIds: z.array(z.string()),
});
const WitnessDetailsSchema = z.object({
  id: z.string(),
  personality: z.string().min(10),
  speechStyle: z.string().min(5),
  relationshipToCase: z.string().min(5),
  knows: z.array(z.string()).min(1),
  willLieAbout: z.array(z.object({ factId: z.string(), lie: z.string(), reason: z.string() })),
  doesNotKnow: z.string().min(2),
  secret: z.string().optional(),
});
const JurorsSchema = z.object({
  jurors: z.array(z.object({ id: z.string().regex(/^J\d+$/), label: z.string(), persona: z.string().max(500) })).length(12),
});
const OpeningSchema = z.object({
  prosecutionOpening: z.string().min(50),
  prosecutionDirectPlan: z.record(z.string(), z.array(z.string().min(5)).length(3)),
});

export type TruthVariant = "innocent" | "guilty" | "other_crime";

export function pickTruthVariant(rng: () => number = Math.random): TruthVariant {
  const d = CONFIG.TRUTH_DISTRIBUTION;
  const r = rng();
  if (r < d.innocent) return "innocent";
  if (r < d.innocent + d.guilty) return "guilty";
  return "other_crime";
}

const JSON_MODE = `Return JSON only, matching this TypeScript schema (no markdown fences, no commentary):\n`;

async function completeJson<T>(transport: AuthorTransport, prompt: string, schema: z.ZodType<T>, what: string): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await transport.complete(prompt);
      const parsed = extractJson<unknown>(raw);
      return schema.parse(parsed);
    } catch (e) {
      lastErr = e;
      // eslint-disable-next-line no-console
      console.warn(`[author] ${what} attempt ${attempt + 1} failed:`, (e as Error)?.message?.slice(0, 200));
    }
  }
  throw new Error(`author stage failed twice (${what}): ${(lastErr as Error)?.message}`);
}

function corePrompt(variant: TruthVariant): string {
  return `[STAGE core] You are authoring a case file for a comedy courtroom game (PG-13, absurd but internally consistent; defendants can be people, animals, objects, institutions; no real people).
The defendant must be: ${variant === "innocent" ? "GENUINELY INNOCENT of the charge" : variant === "guilty" ? "GENUINELY GUILTY of the charge" : "GUILTY OF SOMETHING ELSE, but NOT the thing charged"}.
Write the hidden truth (150-300 words) so the case is solvable from the facts below.
Facts: 25-40, each one sentence with favors + importance (1 minor, 2 useful, 3 case-turning). Include 3-5 importance-3 facts.
Witness roster (no prose yet): exactly 2 prosecution witnesses, then 4-6 defense-list witnesses (id, name, one-line role, calledBy).
Doc bins: 12-16 documents (id, storage bin like "Box 7" / "Evidence Bag 23" / "Misc. — DO NOT OPEN", title like "Police Report #4471"). Bodies come later; assign bins/titles now.
Judge (name, persona ≤80 words, strictness 1-5, basePatience 60-100) and prosecutor (name, persona ≤80 words, objectionTendency 1-5).
${JSON_MODE}{ "caseTitle": "The People v. ...", "defendant": "...", "charge": "...", "truth": "...", "facts": [{ "id": "F01", "statement": "...", "favors": "prosecution|defense|neutral", "importance": 1|2|3 }], "witnesses": [{ "id": "W1", "name": "...", "role": "...", "calledBy": "prosecution|defense" }], "docBins": [{ "id": "D01", "bin": "...", "title": "..." }], "judge": {...}, "prosecutor": {...} }`;
}

function docsPrompt(core: z.infer<typeof CoreSchema>, bins: { id: string; bin: string; title: string }[]): string {
  const facts = core.facts.map((f) => `[${f.id}] (${f.favors}, imp ${f.importance}) ${f.statement}`).join("\n");
  return `[STAGE docs] Bodies for these evidence documents in "${core.caseTitle}". Charge: ${core.charge}. Hidden truth (NEVER state it outright; bury clues): ${core.truth}
CASE FACTS (a document may only establish facts from this list):
${facts}
DOCUMENTS TO WRITE: ${bins.map((b) => `${b.id} "${b.title}" (${b.bin})`).join(" | ")}
RULES: 150-600 words each. Skimmable-but-cluttered: mostly irrelevant content, key facts buried mid-paragraph, in parentheticals, footnotes, asides. At least two documents must contradict each other on a MINOR detail. At least two must be complete red herrings (factIds: []). Every importance-3 fact must appear in at least one document. Return factIds actually established (only ids from the list).
${JSON_MODE}{ "docs": [{ "id": "D01", "body": "...", "factIds": ["F01"] }] } (one entry per document above, same ids)`;
}

function witnessPrompt(core: z.infer<typeof CoreSchema>, w: { id: string; name: string; role: string; calledBy: string }): string {
  const facts = core.facts.map((f) => `[${f.id}] ${f.statement}`).join("\n");
  return `[STAGE witness ${w.id}] Details for witness ${w.name} (${w.role}, called by ${w.calledBy}) in "${core.caseTitle}". Hidden truth: ${core.truth}
CASE FACTS:
${facts}
RULES: knows = facts they personally saw/know (≥1). ${w.calledBy === "prosecution" ? "At least one prosecution witness must lie about something the documents can disprove: put it in willLieAbout." : "At least one defense-list witness overall should know nothing useful but be extremely confident (knows: one minor fact, personality: overconfident)."} doesNotKnow = what they're clueless about. secret = something unrelated they might blurt out (optional).
${JSON_MODE}{ "id": "${w.id}", "personality": "2-3 sentences", "speechStyle": "...", "relationshipToCase": "...", "knows": ["F.."], "willLieAbout": [{ "factId": "F..", "lie": "...", "reason": "..." }], "doesNotKnow": "...", "secret": "..." }`;
}

function jurorsPrompt(core: z.infer<typeof CoreSchema>): string {
  return `[STAGE jurors] 12 juror profiles for "${core.caseTitle}" (ids J1-J12). Labels like "Retired sea captain". Personas ≤80 words each, varied: some never forget stricken material, some trust judges completely, some love animals, some doze off. Funny, PG-13, no real people.
${JSON_MODE}{ "jurors": [{ "id": "J1", "label": "...", "persona": "..." }] } (exactly 12)`;
}

function openingPrompt(core: z.infer<typeof CoreSchema>): string {
  const pros = core.witnesses.filter((w) => w.calledBy === "prosecution");
  return `[STAGE opening] The smug, prepared prosecutor (${core.prosecutor.name}: ${core.prosecutor.persona}) opens "${core.caseTitle}" (charge: ${core.charge}; hidden truth: ${core.truth}). Write their hidden opening statement (player never sees it; it sets jury priors) plus exactly 3 pre-written direct-examination questions per prosecution witness (${pros.map((w) => `${w.id} ${w.name}`).join(", ")}). Questions: one sentence, ≤25 words, answerable. PG-13.
${JSON_MODE}{ "prosecutionOpening": "...", "prosecutionDirectPlan": { ${pros.map((w) => `"${w.id}": ["...", "...", "..."]`).join(", ")} } }`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export interface AuthorCaseOpts {
  transport: AuthorTransport;
  jev: JevClient;
  truthVariant?: TruthVariant;
  log?: (m: string) => void;
}

export async function authorCase(opts: AuthorCaseOpts): Promise<CaseFile> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const variant = opts.truthVariant ?? pickTruthVariant();
  log(`[author] stage 1 core (truth=${variant})…`);
  const core = await completeJson(opts.transport, corePrompt(variant), CoreSchema, "core");
  const factIds = new Set(core.facts.map((f) => f.id));

  log(`[author] stage 2 (docs/witnesses/jurors/opening, parallel)…`);
  const docGroups = chunk(core.docBins, 4);
  const [docParts, witnessParts, jurorsPart, openingPart] = await Promise.all([
    Promise.all(docGroups.map((g) => completeJson(opts.transport, docsPrompt(core, g), z.object({ docs: z.array(DocBodySchema) }), "docs"))),
    Promise.all(core.witnesses.map((w) => completeJson(opts.transport, witnessPrompt(core, w), WitnessDetailsSchema, `witness ${w.id}`))),
    completeJson(opts.transport, jurorsPrompt(core), JurorsSchema, "jurors"),
    completeJson(opts.transport, openingPrompt(core), OpeningSchema, "opening"),
  ]);

  // Assemble + defensive repairs (ids, unknown fact refs).
  const docs = docParts.flatMap((p) => p.docs).map((d) => ({
    id: d.id,
    bin: core.docBins.find((b) => b.id === d.id)?.bin ?? "Misc.",
    title: core.docBins.find((b) => b.id === d.id)?.title ?? d.id,
    body: d.body,
    factIds: [...new Set(d.factIds.filter((f) => factIds.has(f)))],
  }));
  const witnesses: Witness[] = core.witnesses.map((w) => {
    const det = witnessParts.find((x) => x.id === w.id)!;
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      calledBy: w.calledBy,
      personality: det.personality,
      speechStyle: det.speechStyle,
      relationshipToCase: det.relationshipToCase,
      knows: [...new Set(det.knows.filter((f) => factIds.has(f)))],
      willLieAbout: det.willLieAbout.filter((l) => factIds.has(l.factId)),
      doesNotKnow: det.doesNotKnow,
      secret: det.secret,
    };
  });
  for (const w of witnesses) {
    if (w.knows.length === 0) w.knows = [core.facts[0].id]; // every witness knows ≥1 (spec §6.2)
  }

  const caseFile: CaseFile = {
    caseTitle: core.caseTitle,
    defendant: core.defendant,
    charge: core.charge,
    truth: core.truth,
    facts: core.facts as Fact[],
    documents: docs,
    witnesses,
    judge: { ...core.judge, strictness: core.judge.strictness as 1 | 2 | 3 | 4 | 5 },
    prosecutor: { ...core.prosecutor, objectionTendency: core.prosecutor.objectionTendency as 1 | 2 | 3 | 4 | 5 },
    jurors: jurorsPart.jurors,
    prosecutionOpening: openingPart.prosecutionOpening,
    prosecutionDirectPlan: Object.fromEntries(
      core.witnesses.filter((w) => w.calledBy === "prosecution").map((w) => [w.id, openingPart.prosecutionDirectPlan[w.id] ?? ["?", "?", "?"]]),
    ),
  };

  // Stage 3a: importance-3 coverage (spec §6.2) — warn, don't fail (validator passed).
  for (const f of caseFile.facts.filter((x) => x.importance === 3)) {
    const inDoc = docs.some((d) => d.factIds.includes(f.id));
    const known = witnesses.some((w) => w.knows.includes(f.id));
    if (!inDoc || !known) log(`[author] WARN importance-3 ${f.id} inDoc=${inDoc} known=${known}`);
  }

  // Stage 3b: Jev document check — one call per doc, noul per claimed fact, drop p<0.6.
  log(`[author] stage 3 doc fact-check (${docs.length} docs)…`);
  await Promise.all(
    docs.map(async (d) => {
      if (d.factIds.length === 0) return;
      const questions: Record<string, { type: "noul"; instructions: string }> = {};
      for (const fid of d.factIds) {
        const st = core.facts.find((f) => f.id === fid)?.statement ?? fid;
        questions[`check_${fid}`] = { type: "noul", instructions: `Document "${d.title}" in state.document_body. Does this document establish the following fact: ${st}` };
      }
      try {
        const resp = await opts.jev.request({
          model: "jev-latest",
          state: { document_title: d.title, document_body: d.body } as unknown as Record<string, unknown>,
          questions,
        });
        const before = d.factIds.length;
        d.factIds = d.factIds.filter((fid) => {
          const a = resp.answers[`check_${fid}`];
          return a?.type === "noul" ? a.p >= 0.6 : true;
        });
        if (d.factIds.length !== before) log(`[author] doc ${d.id}: dropped ${before - d.factIds.length} unchecked fact(s)`);
      } catch (e) {
        log(`[author] doc ${d.id} check failed, keeping claims: ${(e as Error).message}`);
      }
    }),
  );

  // Stage 3c: token budget.
  const tokens = estimateTokens(JSON.stringify(caseFile));
  log(`[author] case tokens≈${tokens} (record budget ${CONFIG.RECORD_TOKEN_BUDGET})`);
  return caseFile;
}
