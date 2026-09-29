import { describe, it, expect } from "vitest";
import { extractText, extractJson, OpencodeLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

describe("opencode headless parsing", () => {
  it("extractText concatenates text parts and ignores control events", () => {
    const ndjson = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { type: "text", text: '{"answer": "Hi' } }),
      JSON.stringify({ type: "text", part: { type: "text", text: ' there"}' } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    ].join("\n");
    expect(extractText(ndjson)).toBe('{"answer": "Hi there"}');
  });

  it("extractText throws on provider error events", () => {
    const ndjson = JSON.stringify({ type: "error", error: { data: { message: "Endpoint is unavailable." } } });
    expect(() => extractText(ndjson)).toThrow(/Endpoint is unavailable/);
  });

  it("extractText throws on empty output", () => {
    expect(() => extractText('{"type":"step_finish"}')).toThrow(/no text/);
  });

  it("extractJson pulls objects out of chatter", () => {
    expect(extractJson<{ a: number }>('Sure! {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("OpencodeLLMClient (injected runner — no network)", () => {
  const witness = FIXTURE_CASE.witnesses[0];
  const base = {
    witness,
    knownFacts: [{ id: "F01", statement: "s" }],
    testimonySoFar: "",
    priorFactsForWitness: [] as string[],
    questionText: "What did you see?",
    askerRole: "defense",
    examinationType: "cross_defense",
    ruling: { stance: "confirms", truthful: true, factId: "F01", factStatement: "s", demeanor: "calm" },
  };

  it("voices valid JSON from the model", async () => {
    const runner = async () => JSON.stringify({ answer: "Yes, that's right.", facts_stated: ["F01"] });
    const client = new OpencodeLLMClient("test/model", runner, 1000);
    const res = await client.voiceWitness(base);
    expect(res.answer).toBe("Yes, that's right.");
    expect(res.facts_stated).toEqual(["F01"]);
  });

  it("falls back to stub templates when the runner fails", async () => {
    const runner = async () => {
      throw new Error("boom");
    };
    const client = new OpencodeLLMClient("test/model", runner, 1000);
    const res = await client.voiceWitness(base);
    expect(typeof res.answer).toBe("string");
    expect(res.answer.length).toBeGreaterThan(0);
  });

  it("P2-2: restating the witness's OWN earlier fact is allowed", async () => {
    const runner = async () => JSON.stringify({ answer: "As I said.", facts_stated: ["F02"] });
    const client = new OpencodeLLMClient("test/model", runner, 1000);
    const res = await client.voiceWitness({ ...base, priorFactsForWitness: ["F02"], ruling: { ...base.ruling, factId: "none", factStatement: "" } });
    expect(res.facts_stated).toEqual(["F02"]); // no regenerate, no stub fallback
  });

  it("falls back when the model leaks facts (guardrail)", async () => {
    const runner = async () => JSON.stringify({ answer: "Leak!", facts_stated: ["F99"] });
    const client = new OpencodeLLMClient("test/model", runner, 1000);
    const res = await client.voiceWitness(base);
    // stub fallback only ever states the chosen fact
    expect(res.facts_stated.every((f) => f === "F01")).toBe(true);
  });

  it("prosecutorCross falls back to stub on bad JSON", async () => {
    const runner = async () => "not json at all";
    const client = new OpencodeLLMClient("test/model", runner, 1000);
    const qs = await client.prosecutorCross({ prosecutorName: "P", persona: "smug", witness, transcript: "", n: 2 });
    expect(qs).toHaveLength(2);
  });
});
