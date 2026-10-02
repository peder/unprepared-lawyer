# Review 07: reasoning-off voice, minimal prompt, cascade (2026-09-30)

Reviewer: Claude. Scope: `1abf8d3`, `64d1305`. Baseline: `npm run check` green on Linux (90 tests, build OK, sim reaches FINAL).

## Verdict on Review 06

Closed. The reasoning diagnosis was confirmed live (`reasoning_tokens=0`, no length cutoffs, Laguna 635 ms median). The breaker, quota gate, request counting, stub pools, and paid-model guard are all implemented and tested. Good work, especially the bench write-up, which clearly separates stub-fallback latency from model latency.

Now that lines come back, the problem shifts from *getting* lines to *what they say*.

---

## P0-1. The prompt and the fact accounting disagree

`factBlock` suppresses facts only for `factId === "none"` or `stance === "doesnt_know"`. Otherwise it tells the model: *"State this fact in your own spoken words."* But `statedForRuling()` records the fact as stated only for `confirms` / `partially_confirms` / `volunteers_more` (and `denies` + lie). So for `evasive`, `rambles`, `contradicts_self`, `blurts_secret`, and `denies` + truthful, the model is told to say the fact while the code records that nothing was said. `revealedFacts` and later claim checks drift from what the jury actually heard. That's the same class of bug the guardrail was meant to remove.

Fix: **one source of truth.** Derive the prompt instruction from the same decision:

```ts
const stated = statedForRuling(stance, truthful, factId, hasLie);
factBlock = stated.length === 0
  ? stanceNoFactInstruction(stance)   // e.g. evasive: "dodge without revealing anything"; denies: "reject the question's premise without adding new facts"
  : truthful ? `…state this fact…` : `…state this lie as if true…`;
```

Add a table test: for every (stance × truthful × hasFact × hasLie) combination, the prompt contains the fact text **iff** `statedForRuling` returns it.

## P0-2. Lines are restating the fact, not testifying

Both "first live answer" rows in the bench are close to verbatim copies of the fact statement, in the third person, from the witness herself:

> Petunia Wicks: "A witness heard a loud HONK at 3:13pm, consistent with surprise, not triumph."

That's correct, but it isn't a character talking. Causes and fixes:
- Facts are written as neutral third-person statements, and the prompt says "state this fact". Change it to: *"Work this into your answer, told from your own point of view (first person if you witnessed it), in your speech style. Do not repeat it word for word."*
- The model sees stance as a bare slug (`partially_confirms`). Include the one-line description from `STANCE_CRITERIA` and the demeanor, so it knows how to say it.
- Add **two short few-shot examples** in the system prompt (a generic invented witness, not from any case): one `confirms`, one `evasive`. Small fast models imitate examples far better than they follow adjectives.
- Keep `relationshipToCase` in the prompt. It's short and gives the model a reason to care.

**Bench additions:** a `verbatim%` metric (share of answers with >60% token overlap with the fact statement), 5 samples across **different stances** instead of 3 of `confirms`, and print all samples so Peder can judge the comedy by eye. Re-run and commit.

## P1-1. Don't hardcode which models are free

`KNOWN_FREE_IDS` whitelists `stealth/space-bunny-alpha` (and others) as free, so they bypass the paid guard. Stealth and preview models often get priced, or disappear, after launch. The first sign would be a bill.
Fix: at startup, fetch OpenRouter's models list once (`GET /api/v1/models`), treat a model as free only if its prompt **and** completion prices are `"0"`, cache the result for the session, and fall back to the `:free`-suffix rule if the fetch fails. Remove the hardcoded set.

## P1-2. Check the data terms for the stealth model

The commit message calls Space Bunny "zero-retention". That's from **OpenCode Zen's** docs for Zen's route. On **OpenRouter**, stealth models commonly log prompts and completions for the provider. Check the OpenRouter model page. If it logs, fix the README / commit claims (fictional case content makes this low-stakes, but the claim should be accurate).

## P2. Small stuff

- The secret line has a stray space: `SECRET ( blurt …`.
- `prosecutorCross` still asks for JSON. With reasoning off, that's fine, but consider plain text ("one question per line"). It removes the only remaining JSON parse on the live path.
- `play` prints `[llm] N requests` at the verdict. Also print the per-model split (`laguna 31, bunny 4, stub 2`) so we can see how often the cascade actually falls through during a real trial.

---

## Definition of done

1. Table test proves prompt and `statedForRuling` agree for every stance/truth/lie combination.
2. Bench re-run with mixed stances, `verbatim%` reported, all samples printed. Verbatim rate clearly lower than today.
3. Free/paid detection comes from live pricing, not a hardcoded list.
4. Append "Response to Review 07".
