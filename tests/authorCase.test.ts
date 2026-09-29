import { describe, it, expect } from "vitest";
import { authorCase } from "../server/gen/authorCase.js";
import { generateCase } from "../server/gen/generateCase.js";
import { MockJevClient } from "../server/jev/JevClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

// Scripted author: routes on [STAGE ...] markers. No network.
function scripted(responses: Record<string, unknown>, failOn: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      complete: async (prompt: string): Promise<string> => {
        const stage = /\[STAGE ([^\]]+)\]/.exec(prompt)?.[1] ?? "unknown";
        calls.push(stage);
        if (failOn.includes(stage) || failOn.includes(stage.split(" ")[0])) throw new Error(`scripted failure: ${stage}`);
        if (stage.startsWith("witness ")) {
          const id = stage.split(" ")[1];
          return JSON.stringify(detail(id, id === "W6" ? ["F99"] : ["F01"])); // W6: unknown ref → pruned → repaired
        }
        if (stage === "docs") {
          // Honor the requested subset (bins are chunked into parallel calls).
          const section = prompt.split("DOCUMENTS TO WRITE:")[1] ?? prompt;
          const want = [...new Set(section.match(/D\d+(?= ")/g) ?? [])]; // list format `D01 "Title"` (not the JSON example)
          const all = (responses.docs as typeof DOCS).docs;
          return JSON.stringify({ docs: all.filter((d) => want.includes(d.id)) });
        }
        const r = responses[stage] ?? responses[stage.split(" ")[0]];
        if (r === undefined) throw new Error(`no scripted response for ${stage}`);
        return JSON.stringify(r);
      },
    },
  };
}

const facts = Array.from({ length: 12 }, (_, i) => ({
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
const docBins = Array.from({ length: 8 }, (_, i) => ({ id: `D${String(i + 1).padStart(2, "0")}`, bin: "Box 1", title: `Doc ${i + 1}` }));

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
  id, personality: "A very detailed personality sketch here.", speechStyle: "Terse.", relationshipToCase: "Was there.", knows,
  willLieAbout: [], doesNotKnow: "quantum physics", secret: "Ate pie.",
});
const DOCS = { docs: docBins.map((d) => ({ id: d.id, body: "y".repeat(250), factIds: ["F01", "F99"] })) };

describe("authorCase (spec §6, fake transport)", () => {
  function responses() {
    return {
      core: CORE,
      docs: DOCS,
      witness: detail("W1"),
      jurors: { jurors: Array.from({ length: 12 }, (_, i) => ({ id: `J${i + 1}`, label: `L${i + 1}`, persona: "A juror persona." })) },
      opening: { prosecutionOpening: "z".repeat(60), prosecutionDirectPlan: { W1: ["State your name please?", "What did you see there?", "Who took the trophy then?"], W2: ["Where were you standing?", "Did you see anything move?", "Are you certain about that?"] } },
    };
  }

  it("assembles a full CaseFile; unknown fact refs pruned; empty knows repaired", async () => {
    const s = scripted(responses());
    const jev = new MockJevClient({ noul: { check_F01: 0.9 } });
    const c = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", log: () => {} });
    expect(c.caseTitle).toBe("The People v. Test");
    expect(c.documents).toHaveLength(8);
    expect(c.documents[0].factIds).toEqual(["F01"]); // F99 pruned (unknown), F01 kept (mock p=0.9)
    expect(c.witnesses).toHaveLength(6);
    expect(c.witnesses.find((w) => w.id === "W6")!.knows.length).toBeGreaterThan(0); // repaired: every witness knows ≥1
    expect(c.jurors).toHaveLength(12);
    expect(c.prosecutionDirectPlan["W1"]).toHaveLength(3);
    // stage-2 parallelism: docs chunked (8 bins → 2 calls of 4) + 6 witnesses + jurors + opening
    expect(s.calls.filter((x) => x === "docs").length).toBe(2);
    expect(s.calls.filter((x) => x.startsWith("witness")).length).toBe(6);
  });

  it("Jev doc check keeps p>=0.6 claims, drops the rest", async () => {
    const s = scripted({ ...responses(), docs: { docs: docBins.map((d) => ({ id: d.id, body: "y".repeat(250), factIds: ["F01", "F02"] })) } });
    const jev = new MockJevClient({ noul: { check_F01: 0.9, check_F02: 0.1 } });
    const c = await authorCase({ transport: s.transport, jev, truthVariant: "innocent", log: () => {} });
    expect(c.documents[0].factIds).toEqual(["F01"]);
  });

  it("a stage failing twice throws (caller falls back to fixture)", async () => {
    const s = scripted(responses(), ["jurors"]);
    const jev = new MockJevClient();
    await expect(authorCase({ transport: s.transport, jev, log: () => {} })).rejects.toThrow(/jurors/);
    const c = await generateCase({}, { transport: s.transport, jev });
    expect(c.caseTitle).toBe(FIXTURE_CASE.caseTitle);
  });

  it("generateCase default stays fixture (deterministic)", async () => {
    const c = await generateCase();
    expect(c.caseTitle).toBe(FIXTURE_CASE.caseTitle);
  });
});
