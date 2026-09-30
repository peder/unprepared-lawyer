# Review 05: live text generation must be fast (2026-09-29)

Reviewer: Claude. Trigger: Peder's playtest with `LLM_PROVIDER=opencode`. The first witness answer took long enough to hit the 30 s timeout plus retry, then fell back to the stub ("[llm] voice fallback to stub template").

## Decision (Peder)

Keep using **free models from OpenCode Zen** (same account, same routing, same model ids), but **stop using the `opencode` CLI harness** for anything that runs during a trial. Call the Zen HTTP API directly.

Why the CLI is slow: every call boots the `opencode` app and a fresh agent session. It wraps our short prompt in OpenCode's agent system prompt and tool definitions. For long prompts, `defaultOpencodeRunner` also writes the prompt to a temp file and asks the model to *read the file*, which costs an extra tool round trip. Then the free-tier queue and our retry chain (30 s × 2 + regenerate) come on top.

## Zen HTTP API (from opencode.ai/docs/zen)

- Auth: `Authorization: Bearer $OPENCODE_API_KEY` (created at opencode.ai/auth; the account needs billing details on file even for free models).
- **Chat Completions** (OpenAI-compatible), `POST https://opencode.ai/zen/v1/chat/completions`: `big-pickle`, `space-bunny-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`.
- **Responses** (OpenAI Responses API format), `POST https://opencode.ai/zen/v1/responses`: `muse-spark-1.3-contributor-free`.
- Also listed: `jev-1.13-free` at `https://opencode.ai/zen/v1/systemone`, a free Jev route using the same wire format as TypeSafe. Optional; see §5.
- Data terms differ per free model (Muse Spark Contributor prompts may be used for training; Space Bunny / LongCat are zero-retention). Case content is fictional, so this is fine, but record it in the README.

Verify the exact request/response shapes against the docs before coding. Don't guess.

---

## 1. New `ZenLLMClient` (replaces `OpencodeLLMClient` for voice/cross/closing)

`server/llm/ZenLLMClient.ts`, implementing `LLMClient`:

- Plain `fetch` with `AbortController`. No child processes, no temp files, no agent prompt.
- Two transports behind one internal `complete({ system, user, maxTokens, timeoutMs })`: chat-completions and responses, chosen by a model→endpoint map (table above).
- Messages: **system** = the full witness prompt from `server/llm/prompts` (spec §7.1, rendered); **user** = the ruling + question. Request JSON output (`response_format: { type: "json_object" }` where supported; otherwise rely on the prompt plus `extractJson`).
- `max_tokens` ≈ 200 for voice, ≈ 150 for cross questions, ≈ 400 for closing. Temperature ~0.9 for voice (comedy), 0.7 for cross.
- Disable reasoning/"thinking" modes if a model exposes a flag for it. We want first-token speed.
- Env: `LLM_PROVIDER=zen|opencode|stub`, `OPENCODE_API_KEY`, `LLM_VOICE_MODEL` (default to whichever wins §3), `LLM_AUTHOR_MODEL`.
- Keep the `opencode` CLI path **only** for offline authoring (`npm run author`), where minutes don't matter. Better: move authoring to Zen HTTP too, with the long timeout. That also removes the temp-file hack and the Windows command-line length issue.

## 2. Latency budget and overlap

- **Voice budget: 6 s total, including any retry.** On timeout → stub, no retry chain. The guardrail regenerate happens only if at least 2.5 s remain.
- **Start the voice call during the objection window.** For prosecutor questions, the speculative Call A already yields the ruling (stance / truthful / fact / demeanor) before the 4 s window closes. Start `voiceWitness()` immediately. If the objection is sustained, abort it with `AbortController` and discard it. For defense questions, start voice right after Call A.
- **Prosecutor cross:** generate both questions as soon as the player's direct finishes (one call), while the HUD/transition prints.
- **Prosecution closing:** start at the beginning of the final 30 s read (spec §13 already says so). Confirm it's parallel, not sequential.
- `PLAY_DEBUG` line gains `voice <model> <ms> (ttfb <ms>)`, and `play --log` JSONL records it too.

## 3. `npm run llm-bench`

`scripts/llm-bench.ts`: sends one realistic witness-voice request (Officer Clampett, stance `confirms`, a real fact) to each free chat model in the table, 3× each, sequentially. Prints a table: model, median ms, p95 ms, JSON-valid %, guardrail-pass %, and the first answer text. Pick the default `LLM_VOICE_MODEL` from this: **fastest model with ≥ 95% valid JSON and guardrail pass**. Include Muse Spark via Responses for comparison. Likely candidates are the "Flash"/"Lightning" models, but measure.

Commit the bench output as `docs/llm-bench-<date>.md`.

## 4. Tests

- `ZenLLMClient` with an injected `fetch`: chat-completions and responses parsing; timeout → stub within budget; abort on sustained objection makes the result unused; no retry after the budget is spent.
- Engine: a sustained objection on a prosecutor question aborts the in-flight voice call (assert the abort signal fired).

## 5. Optional: Jev via Zen

`jev-1.13-free` on Zen uses the System One wire format. Add `JEV_ENDPOINT` (default TypeSafe) and let `HttpJevClient` accept the Zen URL + `OPENCODE_API_KEY`. Only switch the default after `npm run jev-smoke` passes on both routes and latency is comparable (TypeSafe advertises 70–500 ms; Zen adds a hop).

## Definition of done

1. `LLM_PROVIDER=zen npm run play`: witness lines usually appear by the time the objection window closes, and never take longer than ~6 s before falling back.
2. The `llm-bench` results are committed and the default voice model is chosen from them.
3. No `opencode` subprocess is spawned during a trial.
4. Append "Response to Review 05" here.

---

## Response to Review 05 — 2026-09-30

Implementer: Muse Spark. Two pivots recorded first: (1) per Peder, OpenRouter
replaces Zen — no one holds an `OPENCODE_API_KEY`, `LLM_PROVIDER=direct`, and
the dual-transport design collapsed to one OpenAI-compatible path (the
`ZenLLMClient` draft was deleted, not merged); (2) the bench could not crown a
model because every free shared pool was saturated — see
`docs/llm-bench-2026-09-30.md`. Baseline: **82/82 pass**, `tsc` clean,
`jev-ping` green on the default route.

### 1. `DirectLLMClient` (replaces the CLI for all live-trial calls)
- `server/llm/DirectLLMClient.ts`: plain `fetch` + `AbortController` race (a
  hung transport can't stall the trial — caught by test), OpenRouter base URL
  overridable, account key from `OPENROUTER_API_KEY`.
- System = full §7.1 prompt, user = ruling + question; `response_format:
  json_object` with `extractJson` fallback; caps 200/150/400 tokens,
  temperatures 0.9/0.7/0.7. No reasoning flags exist on this path (flash
  models don't expose any) — speed comes from small models + no harness.
- Budgets as specified: 6 s voice total, guardrail regenerate only with
  ≥2.5 s left, otherwise stub, no retry chain on transport failure. Fallbacks
  log their reason (timeout vs parse vs guardrail).
- `LLM_PROVIDER=stub|opencode|direct` (`server/llm/factory.ts`, extracted to
  break the opencode↔zen import cycle). Authoring keeps the CLI adapter, and
  `DirectLLMClient.author()` is ready when someone points it at a fast model.
- No `opencode` subprocess spawns during a trial on `direct` (only `author`
  and explicit `opencode` provider use it).

### 2. Overlap
- Prosecutor voice starts at `beginProsecutorQuestion` (ruling sampled from
  the speculative Call A) and runs through the 4 s window; sustained ⇒
  `abortVoice()`, result awaited-and-discarded. `QuestionResult.voiceTimings`
  carries `{ms, ttfbMs, model}` into `PLAY_DEBUG` (`voice <model> <ms> (ttfb
  <ms>)`) and the JSONL log.
- Prosecution closing generates during the final read (`pendingClosing`,
  never-rejecting) and is awaited in `submitClosing`; tests that skip the read
  still generate on demand.
- Prosecutor cross was already generated at direct end; unchanged.

### 3. Bench
- `scripts/llm-bench.ts` measures the real path (live% via result timings,
  not absence of throw). This run: 0% live everywhere — instant upstream
  429s on every pool. Committed as `docs/llm-bench-2026-09-30.md` with the
  honest conclusion. Default voice is therefore chosen by design, not timing:
  a **cascade** `laguna-xs → gemma-4-26b → lfm-2.5` — a saturated pool costs
  one fast 429 (~0.4 s), not the trial. Re-run the bench off-peak to crown a
  single default.
- Cheap validation for humans: `npx tsx scripts/llm-bench.ts
  poolside/laguna-xs-2.1:free` (~30 s), or the raw-probe recipe in the bench
  doc. A full bench is 4 models × 3 tries with cooling gaps — minutes, not a
  smoke test.

### 4. Tests
- `tests/direct.test.ts`: 429→next-model with answering-model recorded,
  400 stops the cascade, external abort rethrows, timeout race (hung fetch),
  `isRetryable` classification.
- Engine: sustained objection aborts in-flight voice (signal observed fired,
  no answer entry) — `tests/engine.test.ts`.

### 5. Jev route override
- `HttpJevClient` takes `JEV_ENDPOINT` + key chain
  `TYPESAFE_API_KEY → OPENCODE_API_KEY`. Default route re-verified live
  (`jev-ping` → `jev-1.13.0`). Zen-route comparison needs an
  `OPENCODE_API_KEY` first — not defaulted, as specified.

### DoD
1. Partial: 6 s budget + stub fallback enforced in code and tested; live
   "usually appears" awaits unsaturated pools + a human playtest on `direct`.
2. Bench committed; default = cascade by design until a clean run crowns one.
3. True on `direct`/`stub` paths.
4. This section.
