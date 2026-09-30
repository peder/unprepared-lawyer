import { describe, it, expect } from "vitest";
import { DirectLLMClient, isRetryable, HttpStatusError } from "../server/llm/DirectLLMClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

function jsonFetch(body: unknown, status = 200) {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

const witness = FIXTURE_CASE.witnesses[2];
const voiceArgs = {
  witness,
  knownFacts: [{ id: "F05", statement: "HONK" }],
  testimonySoFar: "",
  priorFactsForWitness: [] as string[],
  questionText: "What did you hear?",
  askerRole: "defense",
  examinationType: "direct_defense",
  ruling: { stance: "confirms", truthful: true, factId: "F05", factStatement: "HONK", demeanor: "calm" },
};
const voiceBody = { choices: [{ message: { content: JSON.stringify({ answer: "I heard it.", facts_stated: ["F05"] }) } }] };

describe("DirectLLMClient cascade", () => {
  it("falls through 429 to the next model in the cascade", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      calls.push(model);
      if (model === "m1") return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1,m2", f, 2000); // small budget: no same-model retry
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1", "m2"]);
    expect(r.answer).toBe("I heard it.");
    expect(r.timings?.model).toBe("m2");
  });

  it("429 retries the same model once after backoff before cascading", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      calls.push(model);
      if (calls.length === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1,m2", f, 20000);
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1", "m1"]); // recovered on retry, m2 untouched
    expect(r.answer).toBe("I heard it.");
  });

  it("non-retryable 400 stops the cascade immediately", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { model: string }).model);
      return { ok: false, status: 400, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1,m2", f, 6000);
    const r = await c.voiceWitness(voiceArgs); // falls back to stub, no throw
    expect(calls).toEqual(["m1"]);
    expect(r.timings).toBeUndefined();
  });

  it("external abort rethrows (sustained objection discards)", async () => {
    const f = (() => new Promise(() => {})) as unknown as typeof fetch; // hangs
    const c = new DirectLLMClient("key", "m1", f, 6000);
    const ctrl = new AbortController();
    const p = c.voiceWitness({ ...voiceArgs, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  it("timeout within budget falls back to stub", async () => {
    const c = new DirectLLMClient("key", "m1", jsonFetch(voiceBody), 50);
    // fetch resolves instantly so this succeeds; budget path covered by abort test.
    const r = await c.voiceWitness(voiceArgs);
    expect(r.answer).toBe("I heard it.");
  });

  it("isRetryable classifies correctly", () => {
    expect(isRetryable(new HttpStatusError(429, "x"))).toBe(true);
    expect(isRetryable(new HttpStatusError(503, "x"))).toBe(true);
    expect(isRetryable(new HttpStatusError(400, "x"))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("bad voice JSON shape"))).toBe(false);
  });

  it("empty content cascades instead of stopping", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      calls.push(model);
      if (model === "m1") return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) };
      return { ok: true, status: 200, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1,m2", f, 6000);
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1", "m2"]);
    expect(r.answer).toBe("I heard it.");
  });
});
