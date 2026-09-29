import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { authorCase } from "../server/gen/authorCase.js";
import { generateCase } from "../server/gen/generateCase.js";
import { MockJevClient } from "../server/jev/JevClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

// Scripted author: routes on [STAGE ...] markers. No network.
function scripted(builders: Record<string, (prompt: string, n: number) => unknown>, failOn: string[] = []) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const counts: Record<string, number> = {};
  return {
    calls,
    prompts,
    transport: {
      complete: async (prompt: string): Promise<string> => {
        const stage = /\[STAGE ([^\]]+)\]/.exec(prompt)?.[1] ?? "unknown";
        const key = stage.split(" ")[0];
        calls.push(stage);
        prompts.push(prompt);
        counts[key] = (counts[key] ?? 0) + 1;
        if (failOn.includes(stage) || failOn.includes(key)) throw new Error(`scripted failure: ${stage}`);
        const build = builders[key];
        if (!build) throw new Error(`no scripted response for ${stage}`);
        return JSON.stringify(build(prompt, counts[key]));
      },
    },
  };
}

const facts = Array.from({ length: 20 }, (_, i) => ({
  id: `F${String(i + 1).padStart(2, "0")}`,
  statement: `Fact number ${i + 1} about the missing trophy.`,
  favors: (["prosecution", "defense", "neutral"] as const)[i % 3],
  importance: (i < 3 ? 3 : 1) as 1 | 3,
}));
const witnesses = [
  { id: "W1", name: "Al", role: "Guard", calledBy: "prosecution" },
  { id: "W2", name: "Bo", role: "Janitor", calledBy: "prosecution" },
  { id: "W3", name: "Cy", role: "Baker", calledBy: "defense" },
  { id: "W4", name: "Di", role: "Clown", calledBy: "defense" },
  { id: "W5", name: "Ed", role: "Mime", calledBy: "defense" },
  { id: "W6", name: "Fay", role: "Juggler", calledBy: "defense" },
];
const docBins = Array.from({ length: 12 }, (_, i) => ({ id: `D${String(i + 1).padStart(2, "0")}`, bin: "Box 1", title: `Doc ${i + 1}` }));

const CORE = {
  caseTitle: "The People v. Test",
  defendant: "Testy",
  charge: "Stealing the trophy with great enthusiasm on a Tuesday.",
  truth: "x".repeat(150),
  facts,
  witnesses,
  docBins,
  judge: { name: "J", persona: "Strict.", strictness: 3, basePatience: 70 },
  prosecutor: { name: "P", persona: "Smug.", objectionTendency: 3 },
};
const detail = (id: string, knows: string[] = ["F01"]) => ({
  personality: "A very detailed personality sketch here.", speechStyle: "Terse.", relationshipToCase: "Was there.", knows,
  willLieAbout: [], doesNotKnow: "quantum physics", secret: "Ate pie.",
});
const JURORS = { jurors: Array.from({ length: 12 }, (_, i) => ({ id: `J${i + 1}`, label: `L${i + 1}`, persona: "A juror persona." })) };
const OPENING = {
  prosecutionOpening: "z".repeat(60),
  prosecutionDirectPlan: {
    W1: ["State your name please?", "What did you see there?", "Who took the trophy then?"],
    W2: ["Where were you standing?", "Did you see anything move?", "Are you certain about that?"],
  },
};

function builders(over: Record<string, (prompt: string, n: number) => unknown> = {}) {
  return {
    core: () => CORE,
    docs: (prompt: string) => {
      const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
      const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])];
      return { docs: want.map((id) => ({ id, body: "y".repeat(250), factIds: ["F01"] })) };
    },
    witness: (prompt: string) => {
      const id = /\[STAGE witness (\S+)\]/.exec(prompt)?.[1] ?? "W?";
      return detail(id, id === "W6" ? ["F99"] : ["F01"]); // W6: unknown ref → pruned → Jev repair
    },
    jurors: () => JURORS,
    opening: () => OPENING,
    "repair-doc": (prompt: string) => {
      const id = /document (\S+)/.exec(prompt)?.[1] ?? "D01";
      const fid = /\[((F\d+))\]/.exec(prompt)?.[1] ?? "F01";
      return { id, body: "y".repeat(250), factIds: [fid] };
    },
    ...over,
  };
}

const quiet = { log: () => {} };

/** Mock Jev that approves the scripted fact claims (repairs must survive re-check). */
function approvingJev(extra: Record<string, number> = {}) {
  return new MockJevClient({ noul: { check_F01: 0.9, check_F02: 0.9, check_F03: 0.9, check_F04: 0.9, ...extra } });
}

describe("authorCase (spec §6, fake transport)", () => {
  it("assembles a full CaseFile + report; unknown refs pruned; empty knows repaired", async () => {
    const s = scripted(builders());
    const jev = approvingJev();
    const { caseFile: c, report } = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", ...quiet });
    expect(c.caseTitle).toBe("The People v. Test");
    expect(c.documents).toHaveLength(12);
    expect(c.documents.find((d) => d.id === "D02")!.factIds).toEqual(["F01"]); // untouched by repair
    expect(report.importance3.every((x) => x.inDoc && x.known)).toBe(true); // spine coherent
    expect(c.witnesses).toHaveLength(6);
    expect(c.witnesses.find((w) => w.id === "W6")!.knows.length).toBeGreaterThan(0);
    expect(c.jurors).toHaveLength(12);
    expect(c.prosecutionDirectPlan["W1"]).toHaveLength(3);
    expect(report.quality).toBe("ok");
    expect(report.truthCheck).toBeDefined();
    expect(report.tokenEstimate).toBeGreaterThan(0);
    // 12 bins, 2 per call → 6 docs calls; 6 witnesses; ≤2 attempts per stage
    expect(s.calls.filter((x) => x === "docs").length).toBe(6);
    expect(s.calls.filter((x) => x.startsWith("witness")).length).toBe(6);
    for (const n of Object.values(report.retries)) expect(n).toBeLessThanOrEqual(1);
  });

  it("P0-3: a docs chunk missing an id retries WITH the validation error", async () => {
    let first = true;
    const s = scripted({
      ...builders(),
      docs: (prompt: string) => {
        const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
        const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])];
        if (first) {
          first = false;
          return { docs: want.slice(1).map((id) => ({ id, body: "y".repeat(250), factIds: [] })) }; // drop one
        }
        return { docs: want.map((id) => ({ id, body: "y".repeat(250), factIds: [] })) };
      },
    });
    const jev = approvingJev();
    const { caseFile: c } = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", ...quiet });
    expect(c.documents).toHaveLength(12);
    const retryPrompt = s.prompts.find((p) => p.includes("failed validation"));
    expect(retryPrompt).toContain("must return exactly documents");
  });

  it("P0-6: opening plan missing a prosecution witness is rejected", async () => {
    const s = scripted({
      ...builders(),
      opening: () => ({ ...OPENING, prosecutionDirectPlan: { W1: OPENING.prosecutionDirectPlan.W1 } }),
    });
    const jev = approvingJev();
    await expect(authorCase({ transport: s.transport, jev, ...quiet })).rejects.toThrow();
  });

  it("mapLimit preserves order and respects the bound", async () => {
    const { mapLimit } = await import("../server/gen/authorCase.js");
    let active = 0;
    let maxActive = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("P0-5: a 3-prosecution roster is rejected", async () => {
    const bad = { ...CORE, witnesses: [...witnesses.slice(0, 3).map((w) => ({ ...w, calledBy: "prosecution" as const })), ...witnesses.slice(3)] };
    const s = scripted({ ...builders(), core: () => bad });
    await expect(authorCase({ transport: s.transport, jev: new MockJevClient(), ...quiet })).rejects.toThrow();
  });

  it("P1-1: uncovered importance-3 is repaired (doc rewrite + witness assignee)", async () => {
    const s = scripted({
      ...builders(),
      docs: (prompt: string) => {
        const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
        const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])];
        return { docs: want.map((id) => ({ id, body: "y".repeat(250), factIds: ["F04"] })) }; // F01-F03 nowhere
      },
      witness: () => detail("X", ["F04"]),
    });
    const jev = new MockJevClient({ noul: { check_F04: 0.9, check_F01: 0.9, check_F02: 0.9, check_F03: 0.9 } });
    const { report } = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", ...quiet });
    const f01 = report.importance3.find((x) => x.id === "F01")!;
    expect(f01.inDoc).toBe(true);
    expect(f01.known).toBe(true);
    expect(f01.repaired).toBe(true);
    expect(report.quality).toBe("ok");
  });

  it("P1-1: unrepairable spine rejects the case", async () => {
    const s2 = scripted({
      ...builders(),
      docs: (prompt: string) => {
        const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
        const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])];
        return { docs: want.map((id) => ({ id, body: "y".repeat(250), factIds: ["F04"] })) };
      },
      witness: () => detail("X", ["F04"]),
      "repair-doc": () => ({ nope: true }),
    });
    const jev = new MockJevClient({ noul: { check_F04: 0.9 } });
    await expect(authorCase({ transport: s2.transport, jev, ...quiet })).rejects.toThrow(/uncoverable|rejected/);
  });

  it("P1-3: truth check contradicting the variant rejects", async () => {
    const s = scripted(builders());
    const jev = approvingJev({ is_defendant_guilty_of_charge: 0.9, is_guilty_of_something_else: 0.1 });
    await expect(authorCase({ transport: s.transport, jev, truthVariant: "innocent", ...quiet })).rejects.toThrow(/truth check/);
  });

  it("Jev doc check keeps p>=0.6 claims, drops the rest (importance-1, no repair fight)", async () => {
    const s = scripted({
      ...builders(),
      docs: (prompt: string) => {
        const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
        const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])];
        return { docs: want.map((id) => ({ id, body: "y".repeat(250), factIds: ["F01", "F05"] })) };
      },
    });
    const jev = approvingJev({ check_F05: 0.1 });
    const { caseFile: c, report } = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", ...quiet });
    expect(report.droppedClaims["D01"]).toEqual(["F05"]); // imp-1 drop, no repair fight
    expect(c.documents.some((d) => d.factIds.includes("F01"))).toBe(true); // the kept claim survives
  });

  it("generateCase falls back to fixture when authoring fails; default stays fixture", async () => {
    const prev = process.env.CASE_SOURCE;
    process.env.CASE_SOURCE = "generated";
    try {
      const s = scripted(builders(), ["jurors"]);
      const jev = new MockJevClient();
      const c = await generateCase({}, { transport: s.transport, jev });
      expect(c.caseTitle).toBe(FIXTURE_CASE.caseTitle);
    } finally {
      if (prev === undefined) delete process.env.CASE_SOURCE;
      else process.env.CASE_SOURCE = prev;
    }
    expect((await generateCase({}, { casesDir: mkdtempSync(join(tmpdir(), "ulaw-empty-")) })).caseTitle).toBe(FIXTURE_CASE.caseTitle);
  });
});
