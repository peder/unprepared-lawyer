// DirectLLMClient — live-trial LLM over an OpenAI-compatible HTTP API
// (OpenRouter by default). No child processes, no temp files, no agent harness:
// plain fetch with AbortController.
// Budgets (review 05 §2): voice 6 s total incl. any retry; guardrail regenerate
// only with ≥2.5 s left; otherwise stub. No retry chain on transport failure.
import {
  StubLLMClient,
  statedForRuling,
  type LLMClient,
  type WitnessRuling,
  type WitnessVoiceResult,
  type VoiceTimings,
} from "./LLMClient.js";
import { extractJson } from "./OpencodeLLMClient.js";
import type { Witness } from "@shared/types.js";

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const DEFAULT_VOICE_MODEL =
  process.env.LLM_VOICE_MODEL ??
  "poolside/laguna-xs-2.1:free,stealth/space-bunny-alpha,google/gemma-4-26b-a4b-it:free,liquid/lfm-2.5-2.6b:free";
// Paid-model guardrail: billable models are attempted only with LLM_ALLOW_PAID=1.
// Free = :free suffix or known-free ids (some free models carry no suffix).
// LLM_MAX_PAID_CALLS caps paid attempts per client instance (one trial).
export function allowPaid(): boolean {
  return process.env.LLM_ALLOW_PAID === "1";
}
export const MAX_PAID_CALLS = Number(process.env.LLM_MAX_PAID_CALLS ?? 60);
const KNOWN_FREE_IDS = new Set(["stealth/space-bunny-alpha", "big-pickle", "openrouter/free"]);

export function isFreeModel(id: string): boolean {
  return id.endsWith(":free") || KNOWN_FREE_IDS.has(id);
}

export interface LlmStats {
  requests: number;
  paidAttempts: number;
  paidSkippedOverCap: number;
}
export const DEFAULT_AUTHOR_MODEL = process.env.LLM_AUTHOR_MODEL ?? "opencode/muse-spark-1.3-contributor-free";

export const VOICE_BUDGET_MS = Number(process.env.VOICE_BUDGET_MS ?? 6000);

export type DirectFetch = typeof fetch;

interface ChatMessage {
  content?: string;
  reasoning?: unknown;
  reasoning_details?: unknown;
}

interface ChatResponse {
  choices?: { finish_reason?: string; message?: ChatMessage }[];
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface ResponseDiagnostics {
  finishReason?: string;
  reasoningTokens?: number;
  hasReasoningField: boolean;
}

/** P0-1: pull reasoning diagnostics out of a chat response (proves the empty-content theory). */
export function diagnosticsOf(json: ChatResponse): ResponseDiagnostics {
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  return {
    finishReason: choice?.finish_reason,
    reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens,
    hasReasoningField: msg.reasoning != null || msg.reasoning_details != null,
  };
}

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
  /** Plain-text mode (voice): no response_format — fewer failure modes. */
  plainText?: boolean;
}

interface CompleteResult {
  text: string;
  ttfbMs: number;
  ms: number;
  model: string;
  finishReason?: string;
  reasoningTokens?: number;
}

export interface CascadeAttempt {
  model: string;
  error: string;
  ms: number;
}

// Review 06 P0-2: per-model circuit breaker + account-quota detection.
const BREAKER_COOLDOWN_MS = 60000;

/** Provider congestion (skip the model a while) vs account quota (stop everything). */
export function classify429(body: string): "provider" | "account" {
  if (/upstream|temporarily rate-limited/i.test(body)) return "provider";
  if (/daily|quota|account/i.test(body)) return "account";
  return "provider"; // conservative: congestion, not quota
}

export class DirectLLMClient implements LLMClient {
  private stub = new StubLLMClient();
  /** Voice cascade: comma-separated LLM_VOICE_MODEL tries each in order on retryable failures. */
  readonly voiceModels: string[];
  private paidUsed = 0;
  private requestCount = 0;
  private paidSkipped = 0;
  /** Circuit breaker: model → cool-until timestamp. */
  private cooling = new Map<string, number>();
  /** Account quota exhausted: skip all requests, straight to stub with one message. */
  private quotaExhausted: string | null = null;
  private quotaWarned = false;
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
    const paid = this.voiceModels.filter((m) => !isFreeModel(m));
    if (paid.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[llm] paid model(s) in cascade: ${paid.join(", ")} — ${allowPaid() ? `allowed (cap ${MAX_PAID_CALLS}/trial)` : "SKIPPED (set LLM_ALLOW_PAID=1 to allow)"}`,
      );
    }
  }

  /** Per-trial usage counters (Review 06 P0-2: print at verdict). */
  stats(): LlmStats {
    return { requests: this.requestCount, paidAttempts: this.paidUsed, paidSkippedOverCap: this.paidSkipped };
  }

  /** Raw completion shared by voice/cross/closing; also backs authorCase().
   *  Cascades across voiceModels on retryable failures. A 429 cools that model
   *  for 60 s (breaker, no immediate retry); an account-quota 429 parks the
   *  whole trial on stub. All inside the caller's total budget. */
  async complete(opts: CompleteOpts & { model?: string }): Promise<CompleteResult> {
    if (this.quotaExhausted) throw new Error(`OpenRouter free quota exhausted — voice falls back to stub (${this.quotaExhausted})`);
    const models = opts.model ? [opts.model] : this.voiceModels;
    const t0 = Date.now();
    const attempts: CascadeAttempt[] = [];
    const fail = (e: unknown): Error => {
      const err = e instanceof Error ? e : new Error(String(e));
      (err as unknown as { attempts?: CascadeAttempt[] }).attempts = attempts;
      return err;
    };
    for (const model of models) {
      const paid = !isFreeModel(model);
      if (paid && !allowPaid()) continue; // warned in constructor; never billed by accident
      if (paid && this.paidUsed >= MAX_PAID_CALLS) {
        this.paidSkipped += 1;
        continue;
      }
      const coolUntil = this.cooling.get(model) ?? 0;
      if (coolUntil > Date.now()) continue; // breaker: skipping cooling model
      const remaining = (opts.timeoutMs ?? this.voiceBudgetMs) - (Date.now() - t0);
      if (remaining <= 0) throw fail(new Error("direct llm: budget exhausted"));
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const a0 = Date.now();
      try {
        this.requestCount += 1;
        if (paid) this.paidUsed += 1;
        const r = await this.attempt({ ...opts, model, timeoutMs: remaining });
        return { ...r, ms: Date.now() - t0 };
      } catch (e) {
        if (/aborted|abort/i.test((e as Error)?.message ?? "") || (e as Error)?.name === "AbortError") throw e;
        attempts.push({ model: shortModel(model), error: shortReason(e), ms: Date.now() - a0 });
        if (process.env.PLAY_DEBUG === "1") {
          // eslint-disable-next-line no-console
          console.log(`  [llm] ${shortModel(model)} failed (${shortReason(e)}): ${((e as Error)?.message ?? "").slice(0, 400)}`);
        }
        if (e instanceof HttpStatusError && e.status === 429) {
          const kind = classify429((e as Error).message);
          if (kind === "account") {
            this.quotaExhausted = shortReason(e);
            throw fail(new Error(`OpenRouter free quota exhausted — voice falls back to stub (${shortReason(e)})`));
          }
          this.cooling.set(model, Date.now() + BREAKER_COOLDOWN_MS);
        }
        if (!isRetryable(e)) throw fail(e);
        // else: next model in the cascade
      }
    }
    throw fail(new Error("direct llm: no models left in cascade"));
  }

  /** Per-model reasoning mode memory: none → minimal → plain (omit). */
  private reasoningMode = new Map<string, "none" | "minimal" | "plain">();

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
      const mode = this.reasoningMode.get(model) ?? "none";
      const maxSent = mode === "minimal" ? Math.max(600, opts.maxTokens) : opts.maxTokens;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      max_tokens: maxSent,
      temperature: opts.temperature,
    };
    if (!opts.plainText) body["response_format"] = { type: "json_object" };
      if (mode !== "plain") body["reasoning"] = mode === "none" ? { effort: "none", exclude: true } : { effort: "minimal", exclude: true };
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
          body: JSON.stringify(body),
        }),
        gate,
      ])) as Response;
      if (!res.ok) {
        let preview = "";
        try {
          preview = (await res.text()).slice(0, 300);
        } catch { /* ignore */ }
        // P0-1: mandatory-reasoning models reject effort:none — escalate once, same model.
        if (res.status === 400 && /reasoning/i.test(preview) && (this.reasoningMode.get(model) ?? "none") === "none") {
          this.reasoningMode.set(model, "minimal");
          clearTimeout(timer);
          return this.attempt({ ...opts, timeoutMs: Math.max(1, opts.timeoutMs - (Date.now() - t0)) });
        }
        if (res.status === 400 && /reasoning/i.test(preview)) this.reasoningMode.set(model, "plain");
        throw new HttpStatusError(res.status, `direct llm HTTP ${res.status} from ${model} (body: ${preview})`);
      }
      const rawText = await res.text();
      let json: ChatResponse;
      try {
        json = JSON.parse(rawText) as ChatResponse;
      } catch {
        throw new TransientLLMError(`direct llm: non-JSON 200 from ${model} (body: ${rawText.slice(0, 300)})`);
      }
      const diag = diagnosticsOf(json);
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) {
        throw new TransientLLMError(
          `direct llm: empty content from ${model} (finish=${diag.finishReason} reasoning_tokens=${diag.reasoningTokens ?? "?"} max_was=${maxSent} has_reasoning_field=${diag.hasReasoningField})`,
        );
      }
      return { text: content, ttfbMs: Date.now() - t0, ms: Date.now() - t0, model, finishReason: diag.finishReason, reasoningTokens: diag.reasoningTokens };
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
    // Review 06 P0-3: the prompt carries ONLY the ruled fact (or its lie) —
    // never the full known-facts list, other lies, or unrelated secrets.
    // facts_stated is computed in code; the model returns one plain spoken line.
    const lie = witness.willLieAbout.find((l) => l.factId === ruling.factId);
    const factBlock =
      ruling.factId === "none" || ruling.stance === "doesnt_know"
        ? "Reveal NO facts. Dodge, ramble, or say you don't recall — stay consistent with TESTIMONY unless stance is contradicts_self."
        : !ruling.truthful && lie
          ? `Draw on this lie as if it were true: "${lie.lie}"`
          : `State this fact in your own spoken words: "${ruling.factStatement}"`;
    const system = [
      `You are voicing ${witness.name} (${witness.role}) on the stand in a comedy courtroom game.`,
      `Personality: ${witness.personality}`,
      `Speech style: ${witness.speechStyle}`,
      `Doesn't know about: ${witness.doesNotKnow}`,
      ...(ruling.stance === "blurts_secret" && witness.secret ? [`SECRET ( blurt something like this, unrelated to the case): ${witness.secret}`] : []),
      ``,
      `TESTIMONY SO FAR (this witness):`,
      args.testimonySoFar || "(none yet)",
      ``,
      `CURRENT QUESTION from ${args.askerRole} (${args.examinationType}): "${args.questionText}"`,
      `RULING — stance: ${ruling.stance}; demeanor: ${ruling.demeanor}.`,
      factBlock,
      `If the question contains a false premise, accept or reject it only as the stance dictates.`,
      `Answer in 1-2 short sentences, spoken lines only. Plain text — no JSON, no narration, no fact IDs.`,
      `Optional: start with *a few words of stage direction* in asterisks.`,
      `PG-13. Funny through character, never breaking the fourth wall.`,
    ].join("\n");
    const remaining = () => this.voiceBudgetMs - (Date.now() - t0);
    try {
      const first = await this.complete({ system, user: "Speak the line.", maxTokens: 120, temperature: 0.9, timeoutMs: Math.max(1, remaining()), signal: args.signal, plainText: true });
      const timings: VoiceTimings = { ms: first.ms, ttfbMs: first.ttfbMs, model: first.model, finishReason: first.finishReason, reasoningTokens: first.reasoningTokens };
      const { answer, stage_direction } = parsePlainLine(first.text);
      return {
        answer,
        stage_direction,
        facts_stated: statedForRuling(ruling.stance, ruling.truthful, ruling.factId, Boolean(lie)),
        timings,
      };
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

/** P0-3: plain-text voice output — optional leading *stage direction*, rest is the line. */
export function parsePlainLine(text: string): { answer: string; stage_direction?: string } {
  const t = text.trim();
  if (!t) throw new Error("direct llm: empty voice line");
  const m = /^\*([^*]{1,80})\*\s*([\s\S]*)$/.exec(t);
  if (m) return { stage_direction: m[1].trim(), answer: m[2].trim() || t };
  return { answer: t };
}
