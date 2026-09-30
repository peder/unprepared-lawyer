// Jev interface (spec §4, §8, §13). Swappable: HttpJevClient vs MockJevClient.
//
// WIRE FORMAT (TypeSafe System One — review-01 P0-1):
//   request:  { model, state, questions: { key: { type, instructions, criteria? } } }
//   response: { model, usage?, request_id?, answers: {
//                 key: { type: "noul", noul: 0..1 }
//                    | { type: "choice", choice, confidence, probabilities }
//                    | { type: "score", score, confidence, probabilities, legend: { "0": "...", ... } } } }
// The engine uses a NORMALIZED form (JevAnswer). parseJevResponse() maps wire →
// normalized and is the single choke point both clients go through.

import { z } from "zod";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

/** Normalized internal answer (engine-facing). */
export type JevAnswer =
  | { type: "noul"; p: number; model: string }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number>; model: string }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: string[]; model: string };

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  model: string;
}

export interface JevClient {
  request(req: JevRequest): Promise<JevResponse>;
}

// ---- local token estimate (spec §4: enforce before send; chars/4 with margin) ----
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function requestTokens(req: JevRequest): { total: number; stateTokens: number; longestQ: number } {
  const stateTokens = estimateTokens(JSON.stringify(req.state));
  const qTokens = Object.values(req.questions).map((q) =>
    estimateTokens(q.instructions + JSON.stringify("criteria" in q ? q.criteria : "")),
  );
  const longestQ = qTokens.length ? Math.max(...qTokens) : 0;
  return { total: stateTokens + qTokens.reduce((a, b) => a + b, 0), stateTokens, longestQ };
}

// ---- wire parsing (P0-1): zod-validated, per-answer fallback, never throws ----
const WireNoul = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).passthrough();
const WireChoice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
}).passthrough();
const WireScore = z.object({
  type: z.literal("score"),
  score: z.number(), // live Jev sometimes sends floats — rounded + clamped below
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
  legend: z.record(z.string(), z.string()),
}).passthrough();
const WireResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
}).passthrough();

function legendToArray(legend: Record<string, string>): string[] {
  return Object.keys(legend)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => legend[k]);
}

/** Fallback for a single malformed/missing answer (spec §15). */
export function fallbackAnswer(key: string, q: JevQuestion, model: string): JevAnswer {
  if (q.type === "noul") return { type: "noul", p: 0.5, model };
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const p = 1 / Math.max(1, keys.length);
    return {
      type: "choice",
      choice: keys[0] ?? "none",
      confidence: p,
      probabilities: Object.fromEntries(keys.map((k) => [k, p])),
      model,
    };
  }
  const p = 1 / Math.max(1, q.criteria.length);
  return {
    type: "score",
    score: 0,
    confidence: p,
    probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), p])),
    legend: q.criteria,
    model,
  };
}

/**
 * Map the real wire format to normalized answers. Unknown/malformed answers
 * become per-answer fallbacks (logged), never a throw — the trial continues.
 */
export function parseJevResponse(raw: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const parsed = WireResponse.safeParse(raw);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.warn("[jev] malformed response envelope, full fallback:", parsed.error.issues[0]?.message);
    const model = "jev-fallback";
    return {
      model,
      answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, fallbackAnswer(k, q, model)])),
    };
  }
  const model = parsed.data.model;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const wire = parsed.data.answers[key];
    try {
      if (q.type === "noul") {
        const w = WireNoul.parse(wire);
        answers[key] = { type: "noul", p: w.noul, model };
      } else if (q.type === "choice") {
        const w = WireChoice.parse(wire);
        if (!(w.choice in q.criteria)) throw new Error(`choice "${w.choice}" not in criteria`);
        answers[key] = { type: "choice", choice: w.choice, confidence: w.confidence, probabilities: w.probabilities, model };
      } else {
        const w = WireScore.parse(wire);
        const legend = legendToArray(w.legend);
        if (legend.length !== q.criteria.length) throw new Error(`legend length ${legend.length} != criteria ${q.criteria.length}`);
        const score = Math.min(legend.length - 1, Math.max(0, Math.round(w.score)));
        answers[key] = { type: "score", score, confidence: w.confidence, probabilities: w.probabilities, legend, model };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[jev] bad answer for "${key}", per-answer fallback:`, (e as Error).message);
      answers[key] = fallbackAnswer(key, q, model);
    }
  }
  return { answers, model };
}

/** Spec §15 full fallback (all questions) — used on transport failure. */
export function fallbackResponse(req: JevRequest, model: string): JevResponse {
  return {
    model,
    answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, fallbackAnswer(k, q, model)])),
  };
}

// ---- HttpJevClient (real) ----
// Review 04 P2: one connect line per model, then per-call only under
// PLAY_DEBUG / AUTHOR_DEBUG — the model tag drowned the author log.
const loggedJevModels = new Set<string>();
function jevLog(model: string) {
  if (!loggedJevModels.has(model) || process.env.PLAY_DEBUG === "1" || process.env.AUTHOR_DEBUG === "1") {
    loggedJevModels.add(model);
    // eslint-disable-next-line no-console
    console.log(`[jev] model=${model}`);
  }
}

export class HttpJevClient implements JevClient {
  constructor(
    // Review 05 §5: JEV_ENDPOINT overrides the route (e.g. Zen systemone);
    // key falls back from TypeSafe to the OpenCode account key.
    private apiKey: string = process.env.TYPESAFE_API_KEY ?? process.env.OPENCODE_API_KEY ?? "",
    private model: string = process.env.JEV_MODEL ?? "jev-latest",
    private endpoint: string = process.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone",
    private timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 3000),
  ) {}

  async request(req: JevRequest): Promise<JevResponse> {
    const { total, stateTokens, longestQ } = requestTokens(req);
    if (total > 64_000 || stateTokens + longestQ > 32_000) {
      throw new Error(
        `Jev request over budget (total=${total}, state+longest=${stateTokens + longestQ}). Still billable per spec — refusing locally.`,
      );
    }
    const body = JSON.stringify({ model: req.model || this.model, state: req.state, questions: req.questions });
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let res: Response;
        try {
          res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
        // P0-1: 4xx is a client bug — retrying won't help. Retry only timeout/5xx/429.
        if (res.status === 429 || res.status >= 500) throw new Error(`Jev HTTP ${res.status} (retryable)`);
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[jev] HTTP ${res.status} (non-retryable), full fallback`);
          return fallbackResponse(req, this.model);
        }
        const json = (await res.json()) as unknown;
        const parsed = parseJevResponse(json, req.questions);
        jevLog(parsed.model);
        return parsed;
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && /non-retryable/.test(e.message)) break;
        // else fall through to retry once
      }
    }
    // eslint-disable-next-line no-console
    console.warn("[jev] fallback after retry:", (lastErr as Error)?.message ?? lastErr);
    return fallbackResponse(req, this.model);
  }
}

// ---- MockJevClient (deterministic stub; emits WIRE format through the same parser) ----
export interface MockOverrides {
  noul?: Record<string, number>;
  choice?: Record<string, { choice: string; probabilities?: Record<string, number> }>;
  score?: Record<string, { score: number; probabilities?: Record<string, number> }>;
}

export class MockJevClient implements JevClient {
  log: JevRequest[] = [];
  constructor(
    private overrides: MockOverrides = {},
    private modelVersion = "jev-mock-0.1",
    /** Optional per-call dynamic noul probability; return undefined to use overrides/defaults. */
    private dynamicNoul?: (req: JevRequest, key: string) => number | undefined,
  ) {}

  setOverrides(o: MockOverrides) {
    this.overrides = o;
  }

  async request(req: JevRequest): Promise<JevResponse> {
    this.log.push(req);
    await new Promise((r) => setTimeout(r, 1));
    // Build the REAL wire format, then parse it — tests exercise the production path.
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      if (q.type === "noul") {
        const p = this.dynamicNoul?.(req, key) ?? this.overrides.noul?.[key] ?? defaultNoul(key);
        answers[key] = { type: "noul", noul: p };
      } else if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const ov = this.overrides.choice?.[key];
        const choice = ov?.choice ?? defaultChoiceKey(key, keys);
        const probs = ov?.probabilities ?? uniform(keys, choice);
        answers[key] = { type: "choice", choice, confidence: probs[choice] ?? 0, probabilities: probs };
      } else {
        const ov = this.overrides.score?.[key];
        const score = ov?.score ?? 0;
        const probs =
          ov?.probabilities ??
          Object.fromEntries(q.criteria.map((_, i) => [String(i), i === score ? 0.7 : 0.3 / Math.max(1, q.criteria.length - 1)]));
        answers[key] = {
          type: "score",
          score,
          confidence: probs[String(score)] ?? 0,
          probabilities: probs,
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        };
      }
    }
    return parseJevResponse({ model: this.modelVersion, usage: { mock: true }, answers }, req.questions);
  }
}

function defaultNoul(key: string): number {
  if (key === "judge_sustains") return 0.35;
  if (key === "prosecutor_objects") return 0.3;
  if (key === "witness_truthful") return 0.8;
  if (key === "mistrial_motion" || key === "mistrial_granted") return 0.15;
  if (key === "grounds_apply") return 0.4;
  if (/^J\d+$/.test(key)) return 0.45; // jurors start near middle
  return 0.5;
}

function defaultChoiceKey(key: string, keys: string[]): string {
  if (key === "claim_status") return keys.includes("no_claim") ? "no_claim" : keys[0];
  if (key === "claim_fact") return keys.includes("none") ? "none" : keys[0];
  if (key === "witness_stance") return keys.includes("confirms") ? "confirms" : keys[0];
  if (key === "witness_fact") return keys.includes("none") ? "none" : keys[0];
  if (key === "witness_demeanor") return keys.includes("calm") ? "calm" : keys[0];
  if (key === "objection_grounds") return keys.includes("relevance") ? "relevance" : keys[0];
  if (key.endsWith("_react")) return keys[0];
  return keys[0] ?? "none";
}

function uniform(keys: string[], pick: string): Record<string, number> {
  // peaked on `pick` so sampling is deterministic-ish but still probabilistic
  const p: Record<string, number> = {};
  for (const k of keys) p[k] = k === pick ? 0.6 : 0.4 / Math.max(1, keys.length - 1);
  if (keys.length <= 1) p[pick] = 1;
  return p;
}
