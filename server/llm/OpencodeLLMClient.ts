// OpencodeLLMClient — LLM hooks via headless `opencode run` with free models (spec §4).
// The LLM never decides outcomes; it only voices rulings Jev already made.
// Provider selection: LLM_PROVIDER=opencode|stub (default stub — deterministic, no network).
// Model slots: LLM_VOICE_MODEL (fast, live lines), LLM_AUTHOR_MODEL (strong, case gen).
// Falls back to StubLLMClient templates on timeout/parse failure (spec §15).

import { spawn } from "child_process";
import {
  StubLLMClient,
  validateWitnessVoice,
  type LLMClient,
  type WitnessRuling,
} from "./LLMClient.js";
import { renderWitnessPrompt } from "./prompts/prompts.js";
import type { Witness } from "@shared/types.js";

export const DEFAULT_VOICE_MODEL = process.env.LLM_VOICE_MODEL ?? "opencode/muse-spark-1.3-contributor-free";
export const DEFAULT_AUTHOR_MODEL = process.env.LLM_AUTHOR_MODEL ?? "opencode/muse-spark-1.3-contributor-free";
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);
// Case authoring emits large JSON (dozens of facts + witnesses); free models need minutes.
export const AUTHOR_TIMEOUT_MS = Number(process.env.AUTHOR_TIMEOUT_MS ?? 240000);

export type OpencodeRunner = (args: { model: string; prompt: string; timeoutMs: number }) => Promise<string>;

/** Default runner: `opencode run -m <model> --format json <prompt>`, returns concatenated text parts. */
export async function defaultOpencodeRunner({ model, prompt, timeoutMs }: { model: string; prompt: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: args pass straight to the process, so quotes in prompts can't break out.
    const child = spawn("opencode", ["run", "-m", model, "--format", "json", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    let err = "";
    const kill = setTimeout(() => {
      child.kill();
      reject(new Error(`opencode timed out after ${timeoutMs}ms (model=${model})`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(kill);
      reject(new Error(`opencode spawn failed: ${(e as Error).message}. Is opencode on PATH?`));
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`opencode exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      try {
        resolve(extractText(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Parse `--format json` NDJSON: concatenate text parts; surface provider errors. */
export function extractText(ndjson: string): string {
  const texts: string[] = [];
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: { type?: string; part?: { type?: string; text?: string }; error?: { data?: { message?: string } }; text?: string };
    try {
      ev = JSON.parse(t) as typeof ev;
    } catch {
      continue; // banner lines etc.
    }
    if (ev.type === "error") {
      throw new Error(`opencode provider error: ${ev.error?.data?.message ?? "unknown"}`);
    }
    if (ev.part?.type === "text" && typeof ev.part.text === "string") texts.push(ev.part.text);
    else if (ev.type === "text" && typeof ev.text === "string") texts.push(ev.text);
  }
  const joined = texts.join("").trim();
  if (!joined) throw new Error("opencode returned no text");
  return joined;
}

/** Pull the first {...} JSON object out of free-form model output. */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

interface VoiceJson {
  answer: string;
  stage_direction?: string;
  facts_stated: string[];
}

export class OpencodeLLMClient implements LLMClient {
  private stub = new StubLLMClient();
  constructor(
    private voiceModel: string = DEFAULT_VOICE_MODEL,
    private runner: OpencodeRunner = defaultOpencodeRunner,
    private timeoutMs: number = LLM_TIMEOUT_MS,
  ) {}

  /** Raw completion for non-voice uses (case authoring). Still retries once. */
  async complete(prompt: string, model?: string): Promise<string> {
    return this.generate(prompt, model ?? DEFAULT_AUTHOR_MODEL);
  }

  /** AuthorTransport adapter: `client.author()` plugs straight into authorCase(). */
  author(model: string = DEFAULT_AUTHOR_MODEL, timeoutMs: number = AUTHOR_TIMEOUT_MS): { complete: (prompt: string) => Promise<string> } {
    return {
      complete: async (prompt: string): Promise<string> => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await this.runner({ model, prompt, timeoutMs });
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr;
      },
    };
  }

  private async generate(prompt: string, model: string): Promise<string> {
    // One retry per spec §15, then caller falls back to stub.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.runner({ model, prompt, timeoutMs: this.timeoutMs });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
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
  }): Promise<{ answer: string; stage_direction?: string; facts_stated: string[] }> {
    const { witness, ruling } = args;
    // P2-1: full §7.1 prompt, single source of truth in prompts/prompts.ts.
    const prompt = renderWitnessPrompt({
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
    try {
      const raw = await this.generate(prompt, this.voiceModel);
      const parsed = extractJson<VoiceJson>(raw);
      if (typeof parsed.answer !== "string" || !Array.isArray(parsed.facts_stated)) throw new Error("bad voice JSON shape");
      const result = { answer: parsed.answer, stage_direction: parsed.stage_direction, facts_stated: parsed.facts_stated.filter((f) => typeof f === "string") };
      // P2-2: allowed-set = {chosen fact} ∪ facts THIS witness already stated.
      if (!validateWitnessVoice(result, ruling.factId, args.priorFactsForWitness)) {
        // Regenerate once per spec, then fall back to stub template.
        const raw2 = await this.generate(prompt + "\n\nYour facts_stated included a fact you must not state. Fix it.", this.voiceModel);
        const parsed2 = extractJson<VoiceJson>(raw2);
        const result2 = { answer: String(parsed2.answer), stage_direction: parsed2.stage_direction, facts_stated: (parsed2.facts_stated ?? []).filter((f) => typeof f === "string") };
        if (!validateWitnessVoice(result2, ruling.factId, args.priorFactsForWitness)) return this.stub.voiceWitness(args);
        return result2;
      }
      return result;
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[llm] voice fallback to stub template");
      return this.stub.voiceWitness(args);
    }
  }

  async prosecutorCross(args: { prosecutorName: string; persona: string; witness: Witness; transcript: string; n: number }): Promise<string[]> {
    const prompt = `You are ${args.prosecutorName}, the prosecutor in a comedy courtroom game. Persona: ${args.persona}. You want a guilty verdict; you are competent, prepared, slightly smug. Transcript so far: ${args.transcript || "(none)"}. Write ${args.n} cross-examination questions for ${args.witness.name} (${args.witness.role}) aimed at undermining the defense. Each: one sentence, ≤25 words, answerable by the witness. PG-13. OUTPUT JSON ONLY, exactly: {"questions": ["...", "..."]}`;
    try {
      const raw = await this.generate(prompt, this.voiceModel);
      const parsed = extractJson<{ questions: string[] }>(raw);
      if (!Array.isArray(parsed.questions) || !parsed.questions.every((q) => typeof q === "string")) throw new Error("bad cross JSON");
      return parsed.questions.slice(0, args.n);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[llm] cross fallback to stub template");
      return this.stub.prosecutorCross(args);
    }
  }

  async prosecutionClosing(args: { prosecutorName: string; persona: string; transcript: string }): Promise<string> {
    const prompt = `You are ${args.prosecutorName}. Persona: ${args.persona}. Write a 120–180 word closing argument referencing ONLY things said in court (transcript: ${args.transcript}). No new evidence. PG-13, funny through smug competence. OUTPUT JSON ONLY, exactly: {"closing": "..."}`;
    try {
      const raw = await this.generate(prompt, this.voiceModel);
      return String(extractJson<{ closing: string }>(raw).closing);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[llm] closing fallback to stub template");
      return this.stub.prosecutionClosing(args);
    }
  }
}

/** Factory: stub by default (deterministic tests); opencode when LLM_PROVIDER=opencode. */
export function createLLMClient(runner?: OpencodeRunner): LLMClient {
  if ((process.env.LLM_PROVIDER ?? "stub").toLowerCase() === "opencode") {
    // eslint-disable-next-line no-console
    console.log(`[llm] provider=opencode voice=${DEFAULT_VOICE_MODEL} author=${DEFAULT_AUTHOR_MODEL}`);
    return new OpencodeLLMClient(DEFAULT_VOICE_MODEL, runner ?? defaultOpencodeRunner, LLM_TIMEOUT_MS);
  }
  return new StubLLMClient();
}
