# Unprepared Lawyer

A retro courtroom command-center game. You are a defense lawyer who did no
preparation. **Jev decides, the LLM voices, the code keeps score.**

## Quick start

```powershell
npm ci
npm run check   # typecheck + tests + headless sim (all green = build is green)
npm run play    # interactive terminal trial
```

Node 24 (`engines` + `.nvmrc`). Desktop shell lives in `desktop/` (own
`package.json`) — the root install stays light.

## Case sources (`CASE_SOURCE`)

- `fixture` — bundled Goose case. Deterministic; what tests and CI use.
- `library` — random unseen case from `cases/` (default when non-empty).
- `generated` — author one live, save to `cases/`, play it.

`npm run author -- --count 3` pre-generates cases offline into `cases/`.

## Model wiring

| Role | Provider | Key |
|---|---|---|
| Judgments (Jev) | TypeSafe (`JEV_CLIENT=http`, default when key set) or mock | `TYPESAFE_API_KEY` |
| Voice lines | `LLM_PROVIDER=stub` (default) / `opencode` (CLI) / `direct` (OpenRouter HTTP) | `OPENROUTER_API_KEY` for `direct` |

`JEV_CLIENT`: `http` (default when `TYPESAFE_API_KEY` is set) or `mock`.
`JEV_ENDPOINT` overrides the Jev route; `JEV_MODEL` the model id.
`LLM_VOICE_MODEL`: single model or comma-separated cascade
(default `laguna-xs → gemma-4-26b → lfm-2.5`, all `:free`).
`VOICE_BUDGET_MS` (default 6000) bounds every voice line; overflow falls back
to stub templates, never hangs the trial.

Keys live in a local `.env` (gitignored, auto-loaded by scripts). Never commit one.

## Data terms (free models)

Case content is fictional, but know the terms: OpenRouter does not train on
your prompts, but **model providers vary** — many free models log prompts and
completions and may use them for training (see openrouter.ai/openrouter/free
and each provider's policy). Correction: an earlier README/commit called
Space Bunny "zero-retention" — that was Zen's route-specific claim and is
**unverified on OpenRouter**; assume logging until a provider says otherwise.
Muse Spark Contributor content may be used for training. Jev inputs are not
used for training (TypeSafe privacy policy). See
`docs/llm-bench-2026-09-30.md` and opencode.ai/docs/zen#privacy.

## Docs

- `unprepared-lawyer-spec.md` — the build spec
- `docs/review-*.md` — architecture reviews + responses
- `docs/*mockup*.md`, `mockup*.png` — art direction
