// Case source selection (Reviews 03 A-1, 04 P0-2).
//   CASE_SOURCE=fixture   — bundled Goose case (tests, CI, rehearsals)
//   CASE_SOURCE=library    — random unseen case from cases/ (gameplay default when non-empty)
//   CASE_SOURCE=generated  — author one live, persist it to cases/, then play it
// Unset: library if cases/ is non-empty, else fixture. Fixture is the last
// resort whenever the library is empty or authoring fails (spec §15).
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { CaseFile } from "@shared/types.js";
import { FIXTURE_CASE } from "../../fixtures/case.fixture.js";
import { authorCase } from "./authorCase.js";
import { pickLibraryCase, slugify, writeCaseFiles, listLibrary } from "./library.js";
import { OpencodeLLMClient } from "../llm/OpencodeLLMClient.js";
import { createJevClient } from "../jev/factory.js";

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases");

export interface GenerateCaseOpts {
  seed?: number;
  truthVariant?: "innocent" | "guilty" | "other_crime";
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function resolveSource(dir: string = CASES_DIR): "fixture" | "library" | "generated" {
  const raw = (process.env.CASE_SOURCE ?? "").toLowerCase();
  if (raw === "fixture" || raw === "generated" || raw === "library") return raw;
  return listLibrary(dir).length > 0 ? "library" : "fixture";
}

export async function generateCase(
  opts: GenerateCaseOpts = {},
  deps?: { transport?: { complete: (prompt: string) => Promise<string> }; jev?: import("../jev/JevClient.js").JevClient; casesDir?: string },
): Promise<CaseFile> {
  const dir = deps?.casesDir ?? CASES_DIR;
  const resolved = resolveSource(dir);

  if (resolved === "library") {
    const picked = pickLibraryCase(dir);
    if (picked) {
      // eslint-disable-next-line no-console
      console.log(`[case] library pick: ${picked.caseTitle}`);
      return picked;
    }
  }
  if (resolved === "generated") {
    try {
      // eslint-disable-next-line no-console
      console.log("[case] generating a fresh case via headless opencode…");
      const transport = deps?.transport ?? new OpencodeLLMClient().author();
      const jev = deps?.jev ?? createJevClient().client;
      const { caseFile: fresh, report } = await authorCase({ transport, jev, truthVariant: opts.truthVariant });
      if (report.quality !== "ok") throw new Error(`case rejected: ${report.qualityReasons.join("; ")}`);
      // R04 P0-2: persist before anyone plays — the case must survive the process.
      const slug = slugify(fresh.caseTitle);
      const { casePath } = writeCaseFiles(dir, slug, fresh, report);
      // eslint-disable-next-line no-console
      console.log(`[case] fresh case ready + saved: ${fresh.caseTitle} → ${casePath} (${fresh.facts.length} facts, ${fresh.documents.length} docs, ${fresh.witnesses.length} witnesses)`);
      return fresh;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[case] generation failed, fixture fallback:", (e as Error).message);
      return clone(FIXTURE_CASE);
    }
  }
  return clone(FIXTURE_CASE);
}
