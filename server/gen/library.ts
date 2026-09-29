// Case library (Review 03 A-1): pre-generated cases live in cases/*.json with
// sidecar reports. Gameplay never waits on a model; bad cases are deleted by hand.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { CaseFile } from "@shared/types.js";
import type { AuthorReport } from "./authorCase.js";

export const SEEN_FILE = ".seen.json";

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled-case";
}

export function writeCaseFiles(dir: string, slug: string, caseFile: CaseFile, report: AuthorReport): { casePath: string; reportPath: string } {
  mkdirSync(dir, { recursive: true });
  const casePath = join(dir, `${slug}.json`);
  const reportPath = join(dir, `${slug}.report.json`);
  writeFileSync(casePath, JSON.stringify(caseFile, null, 1));
  writeFileSync(reportPath, JSON.stringify(report, null, 1));
  return { casePath, reportPath };
}

export function listLibrary(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".report.json") && f !== SEEN_FILE)
    .map((f) => join(dir, f))
    .sort();
}

function readSeen(dir: string): string[] {
  try {
    return JSON.parse(readFileSync(join(dir, SEEN_FILE), "utf8")) as string[];
  } catch {
    return [];
  }
}

function writeSeen(dir: string, seen: string[]) {
  try {
    writeFileSync(join(dir, SEEN_FILE), JSON.stringify(seen));
  } catch { /* best effort */ }
}

/** Pick a random unseen case; resets the seen-set once everything's been played. */
export function pickLibraryCase(dir: string, rng: () => number = Math.random): CaseFile | null {
  const files = listLibrary(dir);
  if (files.length === 0) return null;
  let seen = readSeen(dir).filter((s) => files.includes(s));
  let fresh = files.filter((f) => !seen.includes(f));
  if (fresh.length === 0) {
    seen = [];
    fresh = files;
  }
  const pick = fresh[Math.floor(rng() * fresh.length)];
  writeSeen(dir, [...seen, pick]);
  return JSON.parse(readFileSync(pick, "utf8")) as CaseFile;
}
