// Case generation pipeline stub (spec §6). Real LLM authoring plugs in here later.
import type { CaseFile } from "@shared/types.js";
import { FIXTURE_CASE } from "../../fixtures/case.fixture.js";

export interface GenerateCaseOpts {
  seed?: number;
  truthVariant?: "innocent" | "guilty" | "other_crime";
}

/** v0.1: return the bundled fixture (spec §15 fallback). Stage prompts live in server/llm/prompts/. */
export async function generateCase(opts: GenerateCaseOpts = {}): Promise<CaseFile> {
  void opts;
  // Deep clone so trials don't share mutable state.
  return JSON.parse(JSON.stringify(FIXTURE_CASE)) as CaseFile;
}
