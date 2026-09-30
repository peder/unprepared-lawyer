// DirectLLMClient — live-trial LLM over an OpenAI-compatible HTTP API
// (OpenRouter by default). No child processes, no temp files, no agent harness:
// plain fetch with AbortController.
// Budgets (review 05 §2): voice 6 s total incl. any retry; guardrail regenerate
// only with ≥2.5 s left; otherwise stub. No retry chain on transport failure.
import {
  StubLLMClient,
  validateWitnessVoice,
  type LLMClient,
  type WitnessRuling,
  type WitnessVoiceResult,
  type VoiceTimings,
} from "./LLMClient.js";
import { renderWitnessPrompt } from "./prompts/prompts.js";
import { extractJson } from "./OpencodeLLMClient.js";
import type { Witness } from "@shared/types.js";

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const DEFAULT_VOICE_MODEL =
  process.env.LLM_VOICE_MODEL ?? "poolside/laguna-xs-2.1:free,google/gemma-4-26b-a4b-it:free,liquid/lfm-2.5-2.6b:free";
export const DEFAULT_AUTHOR_MODEL = process.env.LLM_AUTHOR_MODEL ?? "opencode/muse-spark-1.3-contributor-free";

export const VOICE_BUDGET_MS = Number(process.env.VOICE_BUDGET_MS ?? 6000);
const REGEN_MIN_REMAINING_MS = 2500;

export type DirectFetch = typeof fetch;

export class HttpStatusError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** Transient upstream flakiness (overloaded free tier): safe to try the next cascade model. */
export class TransientLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientLLMError";
  }
}

/** Retryable across cascade models: rate limits, upstream 5xx, network failures, empty 200s. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof TransientLLMError) return true;
  if (e instanceof HttpStatusError) return e.status === 429 || e.status >= 500;
  if (e instanceof TypeError) return true; // fetch network failure
  return /timeout|econnreset|socket/i.test((e as Error)?.message ?? "");
}

function shortModel(model: string): string {
  const bare = model.includes("/") ? model.split("/").slice(-1)[0] : model;
  return bare.replace(/:free$/, "");
}

function shortReason(e: unknown): string {
  if (e instanceof HttpStatusError) return `HTTP ${e.status}`;
  const m = /empty content|non-JSON 200|timeout|econnreset|socket|fetch failed/i.exec((e as Error)?.message ?? "");
  if (m) return m[0].toLowerCase();
  return ((e as Error)?.message ?? String(e)).slice(0, 100);
}

export function formatAttempts(e: unknown): string {
  const attempts = (e as { attempts?: CascadeAttempt[] })?.attempts ?? [];
  if (attempts.length === 0) return (e as Error)?.message?.slice(0, 160) ?? String(e);
  return attempts.map((a) => `${a.model} ${a.error}`).join("; ");
}

interface CompleteOpts {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface CompleteResult {
  text: string;
  ttfbMs: number;
  ms: number;
  model: string;
}

export interface CascadeAttempt {
  model: string;
  error: string;
  ms: number;
}

// 429 backoff: pools recover in seconds, so one same-model retry is worth it
// when the budget allows. Never exceeds the caller's total budget.
const RETRY_429_MIN_REMAINING_MS = 2500;
const RETRY_429_WAIT_MS = 1500;

export class DirectLLMClient implements LLMClient {
  private stub = new StubLLMClient();
  /** Voice cascade: comma-separated LLM_VOICE_MODEL tries each in order on retryable failures. */
  readonly voiceModels: string[];
  constructor(
    private apiKey: string = process.env.OPENROUTER_API_KEY ?? "",
    voiceModel: string = DEFAULT_VOICE_MODEL,
    private fetchFn: DirectFetch = fetch,
    private voiceBudgetMs: number = VOICE_BUDGET_MS,
    private baseUrl: string = OPENROUTER_BASE_URL,
  ) {
    if (!this.apiKey) throw new Error("DirectLLMClient needs OPENROUTER_API_KEY");
    this.voiceModels = voiceModel.split(",").map((m) => m.trim()).filter(Boolean);
    if (this.voiceModels.length === 0) throw new Error("LLM_VOICE_MODEL is empty");
  }

  /** Raw completion shared by voice/cross/closing; also backs authorCase().
   *  Cascades across voiceModels on retryable failures (429/5xx/network/empty),
   *  with one same-model retry after a short backoff on 429 — all inside the
   *  caller's total budget. */
  async complete(opts: CompleteOpts & { model?: string }): Promise<CompleteResult> {
    const models = opts.model ? [opts.model] : this.voiceModels;
    const t0 = Date.now();
    const attempts: CascadeAttempt[] = [];
    const fail = (e: unknown): Error => {
      const err = e instanceof Error ? e : new Error(String(e));
      (err as unknown as { attempts?: CascadeAttempt[] }).attempts = attempts;
      return err;
    };
    for (const model of models) {
      for (let tried = 0; ; tried++) {
        const remaining = (opts.timeoutMs ?? this.voiceBudgetMs) - (Date.now() - t0);
        if (remaining <= 0) throw fail(new Error("direct llm: budget exhausted"));
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
        const a0 = Date.now();
        try {
          const r = await this.attempt({ ...opts, model, timeoutMs: remaining });
          return { ...r, ms: Date.now() - t0 };
        } catch (e) {
          if (/aborted|abort/i.test((e as Error)?.message ?? "") || (e as Error)?.name === "AbortError") throw e;
          attempts.push({ model: shortModel(model), error: shortReason(e), ms: Date.now() - a0 });
          if (process.env.PLAY_DEBUG === "1") {
            // eslint-disable-next-line no-console
            console.log(`  [llm] ${shortModel(model)} failed (${shortReason(e)}): ${((e as Error)?.message ?? "").slice(0, 400)}`);
          }
          const left = (opts.timeoutMs ?? this.voiceBudgetMs) - (Date.now() - t0);
          if (e instanceof HttpStatusError && e.status === 429 && tried === 0 && left > RETRY_429_MIN_REMAINING_MS) {
            await new Promise((r) => setTimeout(r, Math.min(RETRY_429_WAIT_MS, left - 500)));
            continue; // same model once more — pools recover in seconds
          }
          if (!isRetryable(e)) throw fail(e);
          break; // next model in the cascade
        }
      }
    }
    throw fail(new Error("direct llm: no models left in cascade"));
  }

  private async attempt(opts: CompleteOpts & { model: string }): Promise<CompleteResult> {
    const model = opts.model;
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race the fetch against timeout/abort so a hung transport can't stall the trial.
    const gate = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error("direct llm timeout"));
      }, opts.timeoutMs);
      opts.signal?.addEventListener(
        "abort",
        () => {
          ctrl.abort();
          reject(opts.signal!.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
    const t0 = Date.now();
    try {
      const res = (await Promise.race([
        this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/peder/unprepared-lawyer",
            "X-Title": "Unprepared Lawyer",
          },
          signal: ctrl.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            response_format: { type: "json_object" },
            max_tokens: opts.maxTokens,
            temperature: opts.temperature,
          }),
        }),
        gate,
      ])) as Response;
      if (!res.ok) {
        let preview = "";
        try {
          preview = (await res.text()).slice(0, 300);
        } catch { /* ignore */ }
        throw new HttpStatusError(res.status, `direct llm HTTP ${res.status} from ${model} (body: ${preview})`);
      }
      const rawText = await res.text();
      let json: { choices?: { message?: { content?: string } }[] };
      try {
        json = JSON.parse(rawText) as typeof json;
      } catch {
        throw new TransientLLMError(`direct llm: non-JSON 200 from ${model} (body: ${rawText.slice(0, 300)})`);
      }
      const ttfbMs = Date.now() - t0;
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) throw new TransientLLMError(`direct llm: empty content from ${model} (body: ${rawText.slice(0, 300)})`);
      return { text: content, ttfbMs, ms: Date.now() - t0, model };
    } finally {
      clearTimeout(timer);
    }
  }

  async voiceWitness(args: {
    witness: Witness;
    knownFacts: { id: string; statement: string }[];
    testimonySoFar: string;
    priorFactsForWitness: string[];
    questionText: string;
    askerRole: string;
    examinationType: string;
    ruling: WitnessRuling;
    signal?: AbortSignal;
  }): Promise<WitnessVoiceResult> {
    const t0 = Date.now();
    const { witness, ruling } = args;
    const system = renderWitnessPrompt({
      name: witness.name,
      role: witness.role,
      personality: witness.personality,
      speechStyle: witness.speechStyle,
      relationshipToCase: witness.relationshipToCase,
      doesNotKnow: witness.doesNotKnow,
      knownFacts: args.knownFacts,
      lies: witness.willLieAbout,
      secret: witness.secret,
      testimonySoFar: args.testimonySoFar,
      askerRole: args.askerRole,
      examinationType: args.examinationType,
      questionText: args.questionText,
      stance: ruling.stance,
      truthful: ruling.truthful,
      factId: ruling.factId,
      factStatement: ruling.factStatement,
      demeanor: ruling.demeanor,
    });
    const user = "Voice the ruling now. OUTPUT JSON ONLY.";
    const remaining = () => this.voiceBudgetMs - (Date.now() - t0);
    try {
      const first = await this.complete({ system, user, maxTokens: 200, temperature: 0.9, timeoutMs: Math.max(1, remaining()), signal: args.signal });
      const timings: VoiceTimings = { ms: first.ms, ttfbMs: first.ttfbMs, model: first.model };
      const parsed = parseVoice(first.text);
      const result: WitnessVoiceResult = { ...parsed, timings };
      if (!validateWitnessVoice(result, ruling.factId, args.priorFactsForWitness)) {
        if (remaining() < REGEN_MIN_REMAINING_MS) {
          // eslint-disable-next-line no-console
          console.warn("[llm] voice guardrail trip, budget nearly spent → stub template");
          return this.stub.voiceWitness(args);
        }
        // eslint-disable-next-line no-console
        console.warn("[llm] voice guardrail trip, regenerating once");
        const second = await this.complete({
          system,
          user: `Your facts_stated broke the allowed set. ${user}`,
          maxTokens: 200,
          temperature: 0.9,
          timeoutMs: Math.max(1, remaining()),
          signal: args.signal,
        });
        const parsed2 = parseVoice(second.text);
        const result2: WitnessVoiceResult = { ...parsed2, timings: { ms: first.ms + second.ms, ttfbMs: first.ttfbMs, model: second.model } };
        if (!validateWitnessVoice(result2, ruling.factId, args.priorFactsForWitness)) return this.stub.voiceWitness(args);
        return result2;
      }
      return result;
    } catch (e) {
      if (/aborted|abort/i.test((e as Error)?.message ?? "") || (e as Error)?.name === "AbortError") throw e;
      // eslint-disable-next-line no-console
      console.warn(`[llm] voice fallback to stub template (${formatAttempts(e)})`);
      return this.stub.voiceWitness(args);
    }
  }

  async prosecutorCross(args: { prosecutorName: string; persona: string; witness: Witness; transcript: string; n: number; signal?: AbortSignal }): Promise<string[]> {
    try {
      const raw = await this.complete({
        system: `You are ${args.prosecutorName}, the prosecutor in a comedy courtroom game. Persona: ${args.persona}. Competent, prepared, slightly smug. PG-13. OUTPUT JSON ONLY, exactly: {"questions": ["...", "..."]}`,
        user: `Transcript so far: ${args.transcript || "(none)"}. Write ${args.n} one-sentence (≤25 words) cross-examination questions for ${args.witness.name} (${args.witness.role}) undermining the defense.`,
        maxTokens: 150,
        temperature: 0.7,
        timeoutMs: this.voiceBudgetMs,
        signal: args.signal,
      });
      const parsed = extractJson<{ questions: unknown }>(raw.text);
      if (!Array.isArray(parsed.questions) || !parsed.questions.every((q) => typeof q === "string")) throw new Error("bad cross JSON");
      return (parsed.questions as string[]).slice(0, args.n);
    } catch (e) {
      if (/aborted|abort/i.test((e as Error)?.message ?? "")) throw e;
      // eslint-disable-next-line no-console
      console.warn("[llm] cross fallback to stub template");
      return this.stub.prosecutorCross(args);
    }
  }

  async prosecutionClosing(args: { prosecutorName: string; persona: string; transcript: string; signal?: AbortSignal }): Promise<string> {
    try {
      const raw = await this.complete({
        system: `You are ${args.prosecutorName}. Persona: ${args.persona}. 120–180 word closing, only things said in court, no new evidence. PG-13, smug competence. OUTPUT JSON ONLY, exactly: {"closing": "..."}`,
        user: `Transcript: ${args.transcript}`,
        maxTokens: 400,
        temperature: 0.7,
        timeoutMs: this.voiceBudgetMs * 2,
        signal: args.signal,
      });
      return String(extractJson<{ closing: unknown }>(raw.text).closing);
    } catch (e) {
      if (/aborted|abort/i.test((e as Error)?.message ?? "")) throw e;
      // eslint-disable-next-line no-console
      console.warn("[llm] closing fallback to stub template");
      return this.stub.prosecutionClosing(args);
    }
  }

  /** AuthorTransport adapter for authorCase() (long timeout — offline use). */
  author(model?: string, timeoutMs: number = Number(process.env.AUTHOR_TIMEOUT_MS ?? 240000)): { complete: (prompt: string) => Promise<string> } {
    const m = model ?? process.env.LLM_AUTHOR_MODEL ?? DEFAULT_AUTHOR_MODEL;
    return {
      complete: async (prompt: string) => {
        const r = await this.complete({ system: prompt, user: "Return JSON only.", maxTokens: 8000, temperature: 0.8, timeoutMs, model: m });
        return r.text;
      },
    };
  }
}

function parseVoice(text: string): { answer: string; stage_direction?: string; facts_stated: string[] } {
  const parsed = extractJson<{ answer: unknown; stage_direction?: unknown; facts_stated?: unknown }>(text);
  if (typeof parsed.answer !== "string" || !Array.isArray(parsed.facts_stated)) throw new Error("bad voice JSON shape");
  return {
    answer: parsed.answer,
    stage_direction: typeof parsed.stage_direction === "string" ? parsed.stage_direction : undefined,
    facts_stated: (parsed.facts_stated as unknown[]).filter((f): f is string => typeof f === "string"),
  };
}
