// Offline case author (Review 03 A-1): generate cases into cases/ ahead of time.
//   npm run author -- --count 5 [--variant guilty] [--dir cases]
// Rejected cases are skipped (never enter the library). Inspect (and delete)
// the JSON before anyone plays it.
import "./env.js";
import { authorCase } from "../server/gen/authorCase.js";
import { slugify, writeCaseFiles } from "../server/gen/library.js";
import { OpencodeLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { createJevClient } from "../server/jev/factory.js";
import type { TruthVariant } from "../server/gen/authorCase.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const count = Math.max(1, Number(arg("--count") ?? 1));
  const variant = arg("--variant") as TruthVariant | undefined;
  if (variant && !["innocent", "guilty", "other_crime"].includes(variant)) {
    console.error("--variant must be innocent|guilty|other_crime");
    process.exit(1);
  }
  const dir = arg("--dir") ?? "cases";
  const { client: jev, banner } = createJevClient();
  console.log(`[author] ${banner}`);
  const author = new OpencodeLLMClient().author();
  let ok = 0;
  for (let i = 0; i < count; i++) {
    console.log(`[author] case ${i + 1}/${count}…`);
    try {
      const { caseFile, report } = await authorCase({ transport: author, jev, truthVariant: variant });
      if (report.quality !== "ok") {
        console.warn(`[author] rejected: ${report.qualityReasons.join("; ")}`);
        continue;
      }
      const slug = slugify(caseFile.caseTitle);
      const { casePath } = writeCaseFiles(dir, slug, caseFile, report);
      ok += 1;
      console.log(`[author] wrote ${casePath} (${caseFile.facts.length} facts, ${caseFile.documents.length} docs)`);
    } catch (e) {
      console.warn(`[author] failed: ${(e as Error).message}`);
    }
  }
  console.log(`[author] done: ${ok}/${count} in library`);
  process.exit(ok > 0 || count === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
