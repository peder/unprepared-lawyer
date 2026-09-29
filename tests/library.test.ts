import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slugify, writeCaseFiles, listLibrary, pickLibraryCase } from "../server/gen/library.js";
import { resolveSource, generateCase } from "../server/gen/generateCase.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ulaw-lib-"));
}

describe("case library (Review 03 A-1)", () => {
  it("slugify is filesystem-safe", () => {
    expect(slugify("The People v. Gerald the Goose!")).toBe("the-people-v-gerald-the-goose");
    expect(slugify("???")).toBe("untitled-case");
  });

  it("write + list + pick round-trips; unseen rotation then reset", () => {
    const dir = tmp();
    const a = { ...FIXTURE_CASE, caseTitle: "Case A" };
    const b = { ...FIXTURE_CASE, caseTitle: "Case B" };
    writeCaseFiles(dir, "a", a, { quality: "ok" } as never);
    writeCaseFiles(dir, "b", b, { quality: "ok" } as never);
    expect(listLibrary(dir)).toHaveLength(2);
    // Sidecars exist but are never picked as cases.
    expect(listLibrary(dir).every((f) => !f.endsWith(".report.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(dir, "a.report.json"), "utf8"));
    expect(report.quality).toBe("ok");
    const rng = (() => {
      let i = 0;
      return () => [0, 0.99][i++ % 2];
    })();
    const first = pickLibraryCase(dir, rng)!;
    const second = pickLibraryCase(dir, rng)!;
    expect(first.caseTitle).not.toBe(second.caseTitle); // unseen preferred
    const third = pickLibraryCase(dir, rng)!;
    expect(["Case A", "Case B"]).toContain(third.caseTitle); // exhausted → reset
  });

  it("empty dir picks null", () => {
    expect(pickLibraryCase(tmp())).toBeNull();
  });

  it("resolveSource: explicit wins; default is library-if-nonempty else fixture", () => {
    const dir = tmp();
    const prev = process.env.CASE_SOURCE;
    try {
      delete process.env.CASE_SOURCE;
      expect(resolveSource(dir)).toBe("fixture");
      writeCaseFiles(dir, "x", FIXTURE_CASE, {} as never);
      expect(resolveSource(dir)).toBe("library");
      process.env.CASE_SOURCE = "fixture";
      expect(resolveSource(dir)).toBe("fixture");
    } finally {
      if (prev === undefined) delete process.env.CASE_SOURCE;
      else process.env.CASE_SOURCE = prev;
    }
  });

  it("generateCase library pick returns the stored case", async () => {
    const dir = tmp();
    const stored = { ...FIXTURE_CASE, caseTitle: "Stored Case" };
    writeCaseFiles(dir, "stored", stored, {} as never);
    const prev = process.env.CASE_SOURCE;
    process.env.CASE_SOURCE = "library";
    try {
      const c = await generateCase({}, { casesDir: dir });
      expect(c.caseTitle).toBe("Stored Case");
    } finally {
      if (prev === undefined) delete process.env.CASE_SOURCE;
      else process.env.CASE_SOURCE = prev;
    }
  });
});
