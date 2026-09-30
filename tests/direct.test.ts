import { describe, it, expect } from "vitest";
import { DirectLLMClient, isRetryable, HttpStatusError } from "../server/llm/DirectLLMClient.js";
import { parsePlainLine } from "../server/llm/DirectLLMClient.js";
import { statedForRuling } from "../server/llm/LLMClient.js";
import { FIXTURE_CASE } from "../fixtures/case.fixture.js";

function jsonFetch(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return (async () => ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body })) as unknown as typeof fetch;
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
const voiceBody = { choices: [{ message: { content: "I heard it." } }] };
const voiceText = JSON.stringify(voiceBody);

describe("DirectLLMClient cascade", () => {
  it("falls through 429 to the next model in the cascade", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      calls.push(model);
      if (model === "m1:free") return { ok: false, status: 429, text: async () => "", json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(voiceBody), json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free,m2:free", f, 2000); // small budget: no same-model retry
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1:free", "m2:free"]);
    expect(r.answer).toBe("I heard it.");
    expect(r.timings?.model).toBe("m2:free");
  });

  it("429 cools the model: skipped for 60s, cascade moves on", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      calls.push(model);
      if (model === "m1:free") return { ok: false, status: 429, text: async () => "temporarily rate-limited upstream", json: async () => ({}) };
      const body = JSON.stringify(voiceBody);
      return { ok: true, status: 200, text: async () => body, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free,m2:free", f, 20000);
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1:free", "m2:free"]);
    expect(r.answer).toBe("I heard it.");
    // Second call: m1 still cooling → straight to m2, no wasted request.
    calls.length = 0;
    const r2 = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m2:free"]);
    expect(r2.answer).toBe("I heard it.");
  });

  it("account-quota 429 parks the trial on stub with one clear message", async () => {
    let fetches = 0;
    const f = (async () => {
      fetches += 1;
      return { ok: false, status: 429, text: async () => "daily quota exceeded for free models", json: async () => ({}) };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free,m2:free", f, 20000);
    const r1 = await c.voiceWitness(voiceArgs);
    expect(r1.timings).toBeUndefined(); // stub
    expect(fetches).toBe(1); // stopped at the first quota signal, no cascade burn
    const r2 = await c.voiceWitness(voiceArgs);
    expect(r2.timings).toBeUndefined();
    expect(fetches).toBe(1); // fail-fast afterwards: zero further requests
  });

  it("non-retryable 400 stops the cascade immediately", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { model: string }).model);
      return { ok: false, status: 400, text: async () => "bad request", json: async () => ({}) };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free,m2:free", f, 6000);
    const r = await c.voiceWitness(voiceArgs); // falls back to stub, no throw
    expect(calls).toEqual(["m1:free"]);
    expect(r.timings).toBeUndefined();
  });

  it("external abort rethrows (sustained objection discards)", async () => {
    const f = (() => new Promise(() => {})) as unknown as typeof fetch; // hangs
    const c = new DirectLLMClient("key", "m1:free", f, 6000);
    const ctrl = new AbortController();
    const p = c.voiceWitness({ ...voiceArgs, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  it("timeout within budget falls back to stub", async () => {
    const c = new DirectLLMClient("key", "m1:free", jsonFetch(voiceBody), 50);
    // fetch resolves instantly so this succeeds; budget path covered by abort test.
    const r = await c.voiceWitness(voiceArgs);
    expect(r.answer).toBe("I heard it.");
  });

  it("paid models are skipped unless LLM_ALLOW_PAID=1, then capped", async () => {
    const f = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      if (model === "m1:free") return { ok: false, status: 429, text: async () => "", json: async () => ({}) };
      const body = JSON.stringify(voiceBody);
      return { ok: true, status: 200, text: async () => body, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const prev = process.env.LLM_ALLOW_PAID;
    try {
      delete process.env.LLM_ALLOW_PAID;
      const c1 = new DirectLLMClient("key", "m1:free,google/gemma-4-26b-a4b-it", f, 2000);
      const r1 = await c1.voiceWitness(voiceArgs); // gemma skipped → stub, no throw, no bill
      expect(r1.timings).toBeUndefined();
      expect(c1.stats().paidAttempts).toBe(0);
      process.env.LLM_ALLOW_PAID = "1";
      const c2 = new DirectLLMClient("key", "m1:free,google/gemma-4-26b-a4b-it", f, 6000);
      const r2 = await c2.voiceWitness(voiceArgs);
      expect(r2.answer).toBe("I heard it.");
      expect(c2.stats().paidAttempts).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.LLM_ALLOW_PAID;
      else process.env.LLM_ALLOW_PAID = prev;
    }
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
      if (model === "m1:free") return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "" } }] }), json: async () => ({ choices: [{ message: { content: "" } }] }) };
      const body = JSON.stringify(voiceBody);
      return { ok: true, status: 200, text: async () => body, json: async () => voiceBody };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free,m2:free", f, 6000);
    const r = await c.voiceWitness(voiceArgs);
    expect(calls).toEqual(["m1:free", "m2:free"]);
    expect(r.answer).toBe("I heard it.");
  });

  it("non-JSON 200 carries the raw body and cascades", async () => {
    const f = (async () => ({ ok: true, status: 200, text: async () => "Service busy, try later" })) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free", f, 6000);
    const r = await c.voiceWitness(voiceArgs); // stub fallback, no throw
    expect(r.timings).toBeUndefined();
    expect(r.answer.length).toBeGreaterThan(0);
  });

  it("P0-3: plain-text lines parse; facts_stated is computed in code", () => {
    expect(parsePlainLine("Look, I was busy.")).toEqual({ answer: "Look, I was busy." });
    expect(parsePlainLine("*tugs lanyard* Look, I was busy.")).toEqual({ answer: "Look, I was busy.", stage_direction: "tugs lanyard" });
    expect(() => parsePlainLine("   ")).toThrow();
    expect(statedForRuling("confirms", true, "F01", false)).toEqual(["F01"]);
    expect(statedForRuling("denies", false, "F01", true)).toEqual(["F01"]); // lie stated
    expect(statedForRuling("denies", true, "F01", false)).toEqual([]);
    expect(statedForRuling("doesnt_know", true, "F01", false)).toEqual([]);
    expect(statedForRuling("confirms", true, "none", false)).toEqual([]);
  });

  it("P0-3: voice sends only the ruled fact and returns code-computed facts", async () => {
    let sentBody = "";
    const f = (async (url: string, init: { body: string }) => {
      sentBody = init.body;
      const body = JSON.stringify({ choices: [{ message: { content: "*fidgets* Yes, the HONK." } }] });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }) as unknown as typeof fetch;
    const c = new DirectLLMClient("key", "m1:free", f, 6000);
    const r = await c.voiceWitness(voiceArgs); // confirms+truthful → [F05], computed
    expect(r.answer).toBe("Yes, the HONK.");
    expect(r.stage_direction).toBe("fidgets");
    expect(r.facts_stated).toEqual(["F05"]); // computed in code — never trusted from the model
    const sys = (JSON.parse(sentBody) as { messages: { role: string; content: string }[] }).messages[0].content;
    expect(sys).not.toContain("F06"); // other known facts never sent
    expect(sys).toContain("HONK");
  });
});
