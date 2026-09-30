# Review 06: live voice falls back to stub on every line (2026-09-29)

Reviewer: Claude. Scope: `server/llm/DirectLLMClient.ts` at `fb795e0`. Trigger: Peder's playtest. Every witness line fell back:

```
[llm] voice fallback to stub template (laguna-xs-2.1 empty content; gemma-4-26b-a4b-it HTTP 429; gemma-4-26b-a4b-it HTTP 429; lfm-2.5-2.6b empty content)
```

The cascade, budget, abort, and attempt logging are well built. The failures come from two request-level problems and one prompt-design problem.

---

## P0-1. "empty content" = the model spent `max_tokens: 200` on hidden reasoning

Laguna XS 2.1 is a reasoning model. Per OpenRouter's reasoning-tokens docs: on most providers `max_tokens` covers **reasoning plus visible output combined**. If reasoning uses the whole budget, the response comes back with `finish_reason: "length"` and **empty `content`**. With a 200-token cap, that's almost guaranteed. LFM likely hits the same thing.

Fix, in `attempt()`:
1. Send `reasoning: { effort: "none" }` for voice, cross, and closing (the docs list `"none"` to disable reasoning; some models have mandatory reasoning and reject it). If a model rejects `"none"`, retry that model once with `reasoning: { effort: "minimal", exclude: true }` and a larger `max_tokens` (≈ 600). Remember per model which form worked for the rest of the session.
2. Log diagnostics on every empty/failed 200: `finish_reason`, `usage.completion_tokens`, `usage.completion_tokens_details.reasoning_tokens`, and whether `message.reasoning` / `reasoning_details` is present. The current 300-char body preview doesn't show this reliably.
3. `llm-bench` should report reasoning tokens per model, so we can see which models think by default.

## P0-2. Gemma 429s: stop spending the budget on a model that's rate-limited

The same-model 429 retry after 1.5 s fails again (the free Gemma endpoint is congested). That spends two requests and ~2 s of the 6 s budget on every line.

1. **Per-model circuit breaker:** after a 429, mark the model "cooling" for 60 s (or the `Retry-After` / reset header if present) and **skip it** in the cascade until then. Remove the immediate same-model retry.
2. **Tell account-level limits apart from provider congestion:** parse the 429 body. If it says the *account's* free-model quota is exhausted (daily or per-minute), every `:free` model will 429. Stop cascading, print one clear message (`OpenRouter free quota exhausted — voice falls back to stub; resets at …`), and go straight to stub for the rest of the trial. Don't burn 4 requests per line.
3. Count requests per trial and print the total in the verdict summary. A trial is ~30–40 LLM calls, and failed cascades multiply that, which matters against free-tier daily caps.

## P0-3. Simplify the voice task so small, fast models can do it (Review 05 follow-up)

`voiceWitness()` still sends the model every known fact and every lie, then trusts the model's own `facts_stated`. Do this instead:

- The voice prompt includes **only** the ruled fact (or, if `truthful` is false, only the lie for that fact), the witness's name/role/personality/speechStyle, this witness's testimony so far, the question, stance, and demeanor. No other known facts, no other lies, the secret only when stance is `blurts_secret`. A model can't leak what it never saw.
- **Code computes `facts_stated`** (`[ruling.factId]` when the stance reveals it, else `[]`). The guardrail becomes structural, and the regenerate path goes away.
- With no `facts_stated` to return, **drop JSON**: ask for one plain spoken line (optionally `*stage direction*` in asterisks, parsed by code). Remove `response_format` for voice. That removes a whole class of failures (JSON mode unsupported, broken JSON, JSON wrapped in prose) and cuts output tokens.
- `max_tokens` ≈ 120 once reasoning is off.

Keep JSON for prosecutor cross (it needs a list) but consider "one question per line" plain text there too.

## P1. Cascade ordering and defaults

- Default `LLM_VOICE_MODEL`: put the model that wins `llm-bench` *after* the P0 fixes first. Re-run the bench once P0-1 is in. Laguna's earlier failures were probably all reasoning-budget failures.
- Consider OpenRouter's `models: [...]` array (server-side fallback routing) instead of client-side cascading, with `provider: { require_parameters: true }` so requests only route to providers that support the parameters we send. Measure before switching.

## P2. Stub lines

When everything fails, the stub should still sound like testimony. `volunteers_more` with no fact currently gives "Yes, and there's more I'm not supposed to say." Replace that with a pool per stance (6–8 lines each), and when a fact is ruled, phrase it as `"<fact statement, lightly reworded>"` rather than "Yes, that's right. <fact>". Use the seeded RNG to pick lines.

---

## Definition of done

1. With `PLAY_DEBUG=1`, a trial with Laguna first in the cascade produces real lines, and the debug line shows `reasoning_tokens=0` (or minimal) and `finish_reason=stop`.
2. A 429 on one model causes it to be skipped for 60 s, without an immediate retry. An account-quota 429 switches the rest of the trial to stub with one clear message.
3. The voice prompt no longer contains non-ruled facts or lies. `facts_stated` comes from code. Voice output is plain text.
4. `docs/llm-bench-<date>.md` is re-run after these fixes, with reasoning-token counts.
5. Append "Response to Review 06".
