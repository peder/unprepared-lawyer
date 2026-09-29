// LLM case authoring pipeline (spec §6, reworked per Review 03).
// Runs offline via `npm run author` into cases/ — never at trial start.
// Transport-agnostic: any { complete(prompt): Promise<string> } works; the
// headless-opencode adapter is OpencodeLLMClient.author().
//
//   Stage 1 (AUTHOR model): core (title/defendant/charge/truth, facts,
//             witness roster, doc bins, judge, prosecutor)
//   Stage 2 (AUTHOR_CONCURRENCY-limited, default 3): docs (2 per call) /
//             witness details (1/witness) / jurors / opening + direct plan
//   Stage 3 (code + Jev): validation (≤2 attempts per stage, retries carry
//             the validation error), Jev doc fact-check, importance-3 repair,
//             truth-variant check, token budget.
//
// Uncoverable importance-3 facts or a failed truth check → quality "rejected".
import { z } from "zod";
import { CONFIG } from "@shared/config.js";
import type { CaseFile, Fact, Witness, WitnessId } from "@shared/types.js";
import type { JevClient } from "../jev/JevClient.js";
import { estimateTokens } from "../jev/JevClient.js";
import { extractJson } from "../llm/OpencodeLLMClient.js";

export interface AuthorTransport {
  complete(prompt: string): Promise<string>;
}

export interface AuthorReport {
  title: string;
  truthVariant: TruthVariant;
  timingsMs: Record<string, number>;
  retries: Record<string, number>;
  droppedClaims: Record<string, string[]>;
  importance3: { id: string; inDoc: boolean; known: boolean; repaired: boolean }[];
  tokenEstimate: number;
  jevModel: string;
  truthCheck?: { guiltyOfCharge: number; guiltyOfSomethingElse: number };
  quality: "ok" | "rejected";
  qualityReasons: string[];
}

export interface AuthorResult {
  caseFile: CaseFile;
  report: AuthorReport;
}

// --- schemas (P0-5: enforce the counts the prompts ask for) ---
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
  facts: z.array(FactSchema).min(20).max(40),
  witnesses: z.array(WitnessCoreSchema).min(6).max(8),
  docBins: z.array(DocBinSchema).min(12).max(16),
  judge: z.object({ name: z.string(), persona: z.string().max(500), strictness: z.number().int().min(1).max(5), basePatience: z.number().int().min(60).max(100) }),
  prosecutor: z.object({ name: z.string(), persona: z.string().max(500), objectionTendency: z.number().int().min(1).max(5) }),
})
  .refine((c) => c.witnesses.filter((w) => w.calledBy === "prosecution").length === 2, { message: "roster must have exactly 2 prosecution witnesses" })
  .refine((c) => { const d = c.witnesses.filter((w) => w.calledBy === "defense").length; return d >= 4 && d <= 6; }, { message: "roster must have 4-6 defense-list witnesses" });
type Core = z.infer<typeof CoreSchema>;

const DocBodySchema = z.object({
  id: z.string(),
  body: z.string().min(200),
  factIds: z.array(z.string()),
});
/** P0-3: the returned id set must equal the requested set — nothing vanishes silently. */
const docChunkSchema = (ids: string[]) =>
  z.object({
    docs: z.array(DocBodySchema).refine(
      (arr) => arr.length === ids.length && arr.every((d) => ids.includes(d.id)),
      { message: `must return exactly documents ${ids.join(", ")}` },
    ),
  });
const WitnessDetailsSchema = z.object({
  personality: z.string().min(10),
  speechStyle: z.string().min(5),
  relationshipToCase: z.string().min(5),
  knows: z.array(z.string()),
  willLieAbout: z.array(z.object({ factId: z.string(), lie: z.string(), reason: z.string() })),
  doesNotKnow: z.string().min(2),
  secret: z.string().optional(),
});
const JurorsSchema = z.object({
  jurors: z.array(z.object({ id: z.string().regex(/^J\d+$/), label: z.string(), persona: z.string().max(500) })).length(12),
});
/** P0-6: plan keys must be exactly the prosecution witness ids — no "?" placeholders. */
const openingSchema = (pids: string[]) =>
  z.object({
    prosecutionOpening: z.string().min(50),
    prosecutionDirectPlan: z.record(z.string(), z.array(z.string().min(5)).length(3)).refine(
      (plan) => pids.length === Object.keys(plan).length && pids.every((id) => id in plan),
      { message: `plan must have exactly keys ${pids.join(", ")}` },
    ),
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

function zodIssues(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  }
  return (e as Error)?.message?.slice(0, 300) ?? String(e);
}

async function completeJson<T>(transport: AuthorTransport, prompt: string, schema: z.ZodType<T>, what: string, retries: Record<string, number>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // P0-2: retries carry the validation failure, not a bare resend.
      const full = attempt === 0 ? prompt : `${prompt}\n\nYour previous output failed validation: ${zodIssues(lastErr)}. Return corrected JSON only.`;
      const raw = await transport.complete(full);
      const parsed = extractJson<unknown>(raw);
      return schema.parse(parsed);
    } catch (e) {
      lastErr = e;
      retries[what] = (retries[what] ?? 0) + 1;
      // eslint-disable-next-line no-console
      console.warn(`[author] ${what} attempt ${attempt + 1} failed:`, zodIssues(e).slice(0, 200));
    }
  }
  throw new Error(`author stage failed twice (${what}): ${zodIssues(lastErr)}`);
}

/** P0-1: bounded parallelism for stage 2 (default 3, env AUTHOR_CONCURRENCY). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function corePrompt(variant: TruthVariant): string {
  return `[STAGE core] You are authoring a case file for a comedy courtroom game (PG-13, absurd but internally consistent; defendants can be people, animals, objects, institutions; no real people).
The defendant must be: ${variant === "innocent" ? "GENUINELY INNOCENT of the charge" : variant === "guilty" ? "GENUINELY GUILTY of the charge" : "GUILTY OF SOMETHING ELSE, but NOT the thing charged"}.
Write the hidden truth (150-300 words) so the case is solvable from the facts below.
Facts: 20-40, each one sentence with favors + importance (1 minor, 2 useful, 3 case-turning). Include 3-5 importance-3 facts.
Witness roster (no prose yet): exactly 2 prosecution witnesses, then 4-6 defense-list witnesses (id, name, one-line role, calledBy).
Doc bins: 12-16 documents (id, storage bin like "Box 7" / "Evidence Bag 23" / "Misc. — DO NOT OPEN", title like "Police Report #4471"). Bodies come later; assign bins/titles now.
Judge (name, persona ≤80 words, strictness 1-5, basePatience 60-100) and prosecutor (name, persona ≤80 words, objectionTendency 1-5).
${JSON_MODE}{ "caseTitle": "The People v. ...", "defendant": "...", "charge": "...", "truth": "...", "facts": [{ "id": "F01", "statement": "...", "favors": "prosecution|defense|neutral", "importance": 1|2|3 }], "witnesses": [{ "id": "W1", "name": "...", "role": "...", "calledBy": "prosecution|defense" }], "docBins": [{ "id": "D01", "bin": "...", "title": "..." }], "judge": {...}, "prosecutor": {...} }`;
}

function docsPrompt(core: Core, bins: { id: string; bin: string; title: string }[]): string {
  const facts = core.facts.map((f) => `[${f.id}] (${f.favors}, imp ${f.importance}) ${f.statement}`).join("\n");
  return `[STAGE docs] Bodies for these evidence documents in "${core.caseTitle}". Charge: ${core.charge}. Hidden truth (NEVER state it outright; bury clues): ${core.truth}
CASE FACTS (a document may only establish facts from this list):
${facts}
DOCUMENTS TO WRITE: ${bins.map((b) => `${b.id} "${b.title}" (${b.bin})`).join(" | ")}
RULES: 150-600 words each. Skimmable-but-cluttered: mostly irrelevant content, key facts buried mid-paragraph, in parentheticals, footnotes, asides. At least two documents must contradict each other on a MINOR detail. At least two must be complete red herrings (factIds: []). Every importance-3 fact must appear in at least one document. Return factIds actually established (only ids from the list). Return ALL ${bins.length} documents with the SAME ids.
${JSON_MODE}{ "docs": [{ "id": "D01", "body": "...", "factIds": ["F01"] }] } (one entry per document above, same ids)`;
}

function witnessPrompt(core: Core, w: { id: string; name: string; role: string; calledBy: string }): string {
  const facts = core.facts.map((f) => `[${f.id}] ${f.statement}`).join("\n");
  return `[STAGE witness ${w.id}] Details for witness ${w.name} (${w.role}, called by ${w.calledBy}) in "${core.caseTitle}". Hidden truth: ${core.truth}
CASE FACTS:
${facts}
RULES: knows = ids of facts they personally saw/know (≥1, only from the list). ${w.calledBy === "prosecution" ? "At least one prosecution witness must lie about something the documents can disprove: put it in willLieAbout." : "At least one defense-list witness overall should know nothing useful but be extremely confident (knows: one minor fact, personality: overconfident)."} doesNotKnow = what they're clueless about. secret = something unrelated they might blurt out (optional). Reply for THIS witness only.
${JSON_MODE}{ "personality": "2-3 sentences", "speechStyle": "...", "relationshipToCase": "...", "knows": ["F.."], "willLieAbout": [{ "factId": "F..", "lie": "...", "reason": "..." }], "doesNotKnow": "...", "secret": "..." }`;
}

function jurorsPrompt(core: Core): string {
  return `[STAGE jurors] 12 juror profiles for "${core.caseTitle}" (ids J1-J12). Labels like "Retired sea captain". Personas ≤80 words each, varied: some never forget stricken material, some trust judges completely, some love animals, some doze off. Funny, PG-13, no real people.
${JSON_MODE}{ "jurors": [{ "id": "J1", "label": "...", "persona": "..." }] } (exactly 12)`;
}

function openingPrompt(core: Core): string {
  const pros = core.witnesses.filter((w) => w.calledBy === "prosecution");
  return `[STAGE opening] The smug, prepared prosecutor (${core.prosecutor.name}: ${core.prosecutor.persona}) opens "${core.caseTitle}" (charge: ${core.charge}; hidden truth: ${core.truth}). One comic premise, at most one pun — confident competence is funnier than wordplay. Write their hidden opening statement (player never sees it; it sets jury priors) plus exactly 3 pre-written direct-examination questions per prosecution witness (${pros.map((w) => `${w.id} ${w.name}`).join(", ")}). Questions: one sentence, ≤25 words, answerable. PG-13.
${JSON_MODE}{ "prosecutionOpening": "...", "prosecutionDirectPlan": { ${pros.map((w) => `"${w.id}": ["...", "...", "..."]`).join(", ")} } }`;
}

function repairDocPrompt(caseTitle: string, truth: string, doc: { id: string; title: string; body: string }, factId: string, factStatement: string): string {
  return `[STAGE repair-doc] In "${caseTitle}" (hidden truth: ${truth}), rewrite the body of document ${doc.id} "${doc.title}" (currently: ${doc.body.slice(0, 2000)}) so that it establishes this fact — buried mid-paragraph, in a parenthetical, footnote, or aside, NEVER stated outright as a conclusion: [${factId}] ${factStatement}. Keep 150-600 words, keep the clutter and voice of the original.
${JSON_MODE}{ "id": "${doc.id}", "body": "...", "factIds": ["${factId}"] } (include any other listed facts the rewrite still establishes)`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export interface AuthorCaseOpts {
  transport: AuthorTransport;
  jev: JevClient;
  truthVariant?: TruthVariant;
  log?: (m: string) => void;
}

export async function authorCase(opts: AuthorCaseOpts): Promise<AuthorResult> {
  const deadlineMs = Number(process.env.AUTHOR_DEADLINE_MS ?? 900000);
  const run = authorCaseInner(opts);
  return await Promise.race([
    run,
    new Promise<AuthorResult>((_, reject) => setTimeout(() => reject(new Error(`author deadline exceeded (${deadlineMs}ms)`)), deadlineMs)),
  ]);
}

async function authorCaseInner(opts: AuthorCaseOpts): Promise<AuthorResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const jevModel = CONFIG.JEV_MODEL;
  const report: AuthorReport = {
    title: "",
    truthVariant: opts.truthVariant ?? pickTruthVariant(),
    timingsMs: {},
    retries: {},
    droppedClaims: {},
    importance3: [],
    tokenEstimate: 0,
    jevModel,
    quality: "ok",
    qualityReasons: [],
  };
  const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      report.timingsMs[key] = Date.now() - t0;
    }
  };
  const reject = (reason: string): never => {
    report.quality = "rejected";
    report.qualityReasons.push(reason);
    throw new Error(`case rejected: ${reason}`);
  };

  log(`[author] stage 1 core (truth=${report.truthVariant})…`);
  const core = await timed("core", () => completeJson(opts.transport, corePrompt(report.truthVariant), CoreSchema, "core", report.retries));
  report.title = core.caseTitle;
  const factIds = new Set(core.facts.map((f) => f.id));
  const concurrency = Math.max(1, Number(process.env.AUTHOR_CONCURRENCY ?? 3));

  log(`[author] stage 2 (docs/witnesses/jurors/opening, concurrency ${concurrency})…`);
  const docGroups = chunk(core.docBins, 2); // P0-3: 2 per call — 4 is where free models truncate
  const pids = core.witnesses.filter((w) => w.calledBy === "prosecution").map((w) => w.id);
  const [docParts, witnessParts, jurorsPart, openingPart] = await timed("stage2", () => Promise.all([
    mapLimit(docGroups, concurrency, (g) => completeJson(opts.transport, docsPrompt(core, g), docChunkSchema(g.map((b) => b.id)), "docs", report.retries)),
    // P0-4: positional — result i belongs to witness i; id overwritten, never trusted.
    mapLimit(core.witnesses, concurrency, (w) => completeJson(opts.transport, witnessPrompt(core, w), WitnessDetailsSchema, `witness ${w.id}`, report.retries)),
    completeJson(opts.transport, jurorsPrompt(core), JurorsSchema, "jurors", report.retries),
    completeJson(opts.transport, openingPrompt(core), openingSchema(pids), "opening", report.retries),
  ]));

  const binById = new Map(core.docBins.map((b) => [b.id, b]));
  const docs = docParts.flatMap((p) => p.docs).map((d) => ({
    id: d.id,
    bin: binById.get(d.id)?.bin ?? "Misc.",
    title: binById.get(d.id)?.title ?? d.id,
    body: d.body,
    factIds: [...new Set(d.factIds.filter((f) => factIds.has(f)))],
  }));
  const witnesses: Witness[] = core.witnesses.map((w, i) => {
    const det = witnessParts[i];
    return {
      id: w.id, // requested id wins (P0-4)
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

  // P1-2: empty knows → Jev picks the most plausible importance-1 fact for the role.
  for (const w of witnesses) {
    if (w.knows.length > 0) continue;
    const candidates = core.facts.filter((f) => f.importance === 1);
    const pool = candidates.length ? candidates : core.facts;
    try {
      const resp = await opts.jev.request({
        model: jevModel,
        state: { witness_role: w.role, witness_personality: w.personality } as unknown as Record<string, unknown>,
        questions: {
          plausible_fact: {
            type: "choice",
            instructions: `Which minor fact would ${w.name} (${w.role}) most plausibly know firsthand?`,
            criteria: Object.fromEntries(pool.map((f) => [f.id, f.statement])),
          },
        },
      });
      const a = resp.answers["plausible_fact"];
      w.knows = [a?.type === "choice" && factIds.has(a.choice) ? a.choice : pool[0].id];
    } catch {
      w.knows = [pool[0].id];
    }
    log(`[author] witness ${w.id} knew nothing → assigned ${w.knows[0]}`);
  }

  const checkDoc = async (d: { id: string; title: string; body: string; factIds: string[] }): Promise<void> => {
    if (d.factIds.length === 0) return;
    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const fid of d.factIds) {
      const st = core.facts.find((f) => f.id === fid)?.statement ?? fid;
      questions[`check_${fid}`] = { type: "noul", instructions: `Document "${d.title}" in state.document_body. Does this document establish the following fact: ${st}` };
    }
    const resp = await opts.jev.request({
      model: jevModel,
      state: { document_title: d.title, document_body: d.body } as unknown as Record<string, unknown>,
      questions,
    });
    const before = d.factIds.length;
    const dropped = d.factIds.filter((fid) => {
      const a = resp.answers[`check_${fid}`];
      return a?.type === "noul" ? a.p < 0.6 : false;
    });
    d.factIds = d.factIds.filter((fid) => !dropped.includes(fid));
    if (dropped.length) {
      report.droppedClaims[d.id] = [...(report.droppedClaims[d.id] ?? []), ...dropped];
      log(`[author] doc ${d.id}: dropped ${dropped.length} unchecked fact(s)`);
    }
    void before;
  };

  log(`[author] stage 3 doc fact-check (${docs.length} docs)…`);
  await timed("doccheck", () => mapLimit(docs, concurrency, (d) => checkDoc(d).catch((e) => {
    log(`[author] doc ${d.id} check failed, keeping claims: ${(e as Error).message}`);
  })));

  // P1-1: importance-3 repair — the coherent spine. Uncoverable → reject.
  for (const f of core.facts.filter((x) => x.importance === 3)) {
    let inDoc = docs.some((d) => d.factIds.includes(f.id));
    let known = witnesses.some((w) => w.knows.includes(f.id));
    let repaired = false;
    if (!inDoc) {
      const target = [...docs].sort((a, b) => a.factIds.length - b.factIds.length)[0];
      if (target) {
        log(`[author] repair: burying ${f.id} in ${target.id}…`);
        try {
          const fixed = await timed("repair-doc", () =>
            completeJson(opts.transport, repairDocPrompt(core.caseTitle, core.truth, target, f.id, f.statement), z.object({ id: z.string(), body: z.string().min(200), factIds: z.array(z.string()) }), "repair-doc", report.retries));
          target.body = fixed.body;
          target.factIds = [...new Set(fixed.factIds.filter((x) => factIds.has(x)))];
          await checkDoc(target);
          inDoc = target.factIds.includes(f.id);
          repaired = inDoc;
        } catch (e) {
          log(`[author] repair of ${f.id} in doc failed: ${(e as Error).message}`);
        }
      }
    }
    if (!known) {
      // Prefer defense-list witnesses so the player can reach the fact.
      const ordered = [...witnesses].sort((a, b) => (a.calledBy === "defense" ? 0 : 1) - (b.calledBy === "defense" ? 0 : 1));
      try {
        const resp = await opts.jev.request({
          model: jevModel,
          state: { fact: f.statement } as unknown as Record<string, unknown>,
          questions: {
            assignee: {
              type: "choice",
              instructions: `Which witness would most plausibly know this fact firsthand? Prefer a defense-list witness so the defense can reach it. Fact: ${f.statement}`,
              criteria: Object.fromEntries(ordered.map((w) => [w.id, `${w.name} — ${w.role} (${w.calledBy})`])),
            },
          },
        });
        const a = resp.answers["assignee"];
        const pick = a?.type === "choice" && witnesses.some((w) => w.id === a.choice) ? a.choice : ordered[0].id;
        const w = witnesses.find((x) => x.id === pick)!;
        if (!w.knows.includes(f.id)) w.knows.push(f.id);
        known = true;
        repaired = true;
        log(`[author] repair: ${f.id} assigned to ${w.id}`);
      } catch (e) {
        log(`[author] repair of ${f.id} assignee failed: ${(e as Error).message}`);
      }
    }
    report.importance3.push({ id: f.id, inDoc, known, repaired });
    if (!inDoc || !known) reject(`importance-3 ${f.id} uncoverable (inDoc=${inDoc} known=${known})`);
  }

  // P1-3: truth-variant sanity check.
  const truthResp = await timed("truthcheck", () => opts.jev.request({
    model: jevModel,
    state: { truth: core.truth, charge: core.charge } as unknown as Record<string, unknown>,
    questions: {
      is_defendant_guilty_of_charge: { type: "noul", instructions: "Given state.truth, is the defendant guilty of the charged offense in state.charge?" },
      is_guilty_of_something_else: { type: "noul", instructions: "Given state.truth, is the defendant guilty of some other wrongdoing (not the charged offense)?" },
    },
  }));
  const g = truthResp.answers["is_defendant_guilty_of_charge"];
  const e = truthResp.answers["is_guilty_of_something_else"];
  const gp = g?.type === "noul" ? g.p : 0.5;
  const ep = e?.type === "noul" ? e.p : 0.5;
  report.truthCheck = { guiltyOfCharge: gp, guiltyOfSomethingElse: ep };
  const v = report.truthVariant;
  const variantOk =
    v === "innocent" ? gp < 0.6 && ep < 0.6 : v === "guilty" ? gp >= 0.5 : gp < 0.6 && ep >= 0.5;
  if (!variantOk) reject(`truth check contradicts variant ${v} (guilty=${gp.toFixed(2)} else=${ep.toFixed(2)})`);

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
    prosecutionDirectPlan: Object.fromEntries(pids.map((id) => [id, openingPart.prosecutionDirectPlan[id]])),
  };

  report.tokenEstimate = estimateTokens(JSON.stringify(caseFile));
  log(`[author] case tokens≈${report.tokenEstimate} (record budget ${CONFIG.RECORD_TOKEN_BUDGET}), quality=${report.quality}`);
  return { caseFile, report };
}

export type { WitnessId };
