// Case generation entry: fixture by default (deterministic), LLM-authored
// pipeline when CASE_SOURCE=generated (spec §6). Author failures (after the
// pipeline's own retries) fall back to the bundled fixture (spec §15).
import type { CaseFile } from "@shared/types.js";
import { FIXTURE_CASE } from "../../fixtures/case.fixture.js";
import { authorCase } from "./authorCase.js";
import { OpencodeLLMClient } from "../llm/OpencodeLLMClient.js";
import { createJevClient } from "../jev/factory.js";

export interface GenerateCaseOpts {
  seed?: number;
  truthVariant?: "innocent" | "guilty" | "other_crime";
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** v0.1: return the bundled fixture (spec §15 fallback). Stage prompts live in server/llm/prompts/. */
export async function generateCase(
  opts: GenerateCaseOpts = {},
  deps?: { transport?: { complete: (prompt: string) => Promise<string> }; jev?: import("../jev/JevClient.js").JevClient },
): Promise<CaseFile> {
  const source = (process.env.CASE_SOURCE ?? "fixture").toLowerCase();
  if (source !== "generated") return clone(FIXTURE_CASE);
  try {
    // eslint-disable-next-line no-console
    console.log("[case] generating a fresh case via headless opencode…");
    const transport = deps?.transport ?? new OpencodeLLMClient().author();
    const jev = deps?.jev ?? createJevClient().client;
    const fresh = await authorCase({ transport, jev, truthVariant: opts.truthVariant });
    // eslint-disable-next-line no-console
    console.log(`[case] fresh case ready: ${fresh.caseTitle} (${fresh.facts.length} facts, ${fresh.documents.length} docs, ${fresh.witnesses.length} witnesses)`);
    return fresh;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[case] generation failed, fixture fallback:", (e as Error).message);
    return clone(FIXTURE_CASE);
  }
}
