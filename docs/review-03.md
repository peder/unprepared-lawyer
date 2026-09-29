# Review 03: case authoring pipeline + commits `dbc9423`..`b94d136` (2026-09-29)

Reviewer: Claude. Baseline: `npm run check` green on Linux (61 tests, build OK, sim reaches FINAL).

## Review 02: status

Verified from code: the single stdin owner (`scripts/input.ts`, with tests), the shared `createJevClient()` factory with a LIVE/MOCK banner, the side-based juror hack removed from `play`, `waiveQuestion()` with zero model calls, per-question Jev probabilities exposed for `PLAY_DEBUG`, and a scripted `play` run in CI. The Review 01 P0-1 wire format is also fixed (`instructions` in requests, `noul` parsed to internal `p` via zod). Good work. Consider Review 02 closed unless Peder's next playtest says otherwise.

---

## Case generation: architecture decision first

**A-1. Generate cases offline into a library. Don't generate at trial start.**
With a free model, stage 1 alone can take minutes (`AUTHOR_TIMEOUT_MS` = 240 s), and a failure anywhere silently falls back to Gerald the Goose after the player has already waited. Spec §6 assumed a fast, strong model; with free models the right shape is:

- `npm run author -- --count 5 [--variant guilty]` runs `authorCase()` and writes `cases/<slug>.json`, plus a sidecar `cases/<slug>.report.json` (stage timings, retries, dropped fact claims, importance-3 coverage, token estimate, Jev check results).
- `generateCase()` gains `CASE_SOURCE=library` (the new default once a library exists). It picks a random case from `cases/` that the player hasn't seen, and falls back to the fixture only if the library is empty.
- Keep `CASE_SOURCE=generated` for live generation when a fast model is configured.
- Commit a few good generated cases so CI, Peder, and the reviewer can all read and play the same ones.

This decouples gameplay from model speed, makes every case inspectable before anyone plays it, and lets bad cases be deleted by hand.

---

## P0: correctness in `server/gen/authorCase.ts`

**P0-1. Retries stack to 4× per stage, and stage 2 fans out ~13 processes at once.**
`OpencodeLLMClient.author()` retries twice, and `completeJson()` retries twice around it, so a single stage can make 4 attempts × 240 s ≈ 16 minutes before failing. Stage 2 then launches 3–4 doc calls, 6–8 witness calls, jurors, and the opening **simultaneously**, which is ~13 `opencode` processes against a free, rate-limited model.
Fix: retry only in `completeJson()` (remove the loop from `author()`). Run stage 2 through a small concurrency limiter (default 3, env `AUTHOR_CONCURRENCY`). Add an overall `AUTHOR_DEADLINE_MS` that aborts cleanly.

**P0-2. Retries don't tell the model what went wrong.**
`completeJson()` resends the identical prompt. Append the failure on retry: `Your previous output failed validation: <zod issues, first 5, compact>. Return corrected JSON only.` This is the most effective fix for free models.

**P0-3. Missing or renamed documents disappear silently.**
Each docs call is validated as `{ docs: [...] }` with no check that every requested id came back. If the model returns 3 of 4, the fourth document is gone. Unknown ids get bin `"Misc."` and a title equal to the id.
Fix: validate per chunk that the returned id set equals the requested id set (use a zod refine). Otherwise retry with feedback. Also, **write 1–2 docs per call instead of 4**: four 150–600-word bodies in one JSON string is exactly where free models truncate and produce invalid JSON.

**P0-4. `witnessParts.find(x => x.id === w.id)!` crashes if the model changes the id.**
The witness call is per-witness, so take the result positionally and overwrite `id` with the requested one. Never use `!` on model output.

**P0-5. Witness roster counts aren't enforced.**
The schema allows 6–8 witnesses of any mix. The engine and the 5-read budget assume **exactly 2 prosecution witnesses** and 4–6 on the defense list. Add a refine: `prosecution === 2 && defense in [4,6]`. The same applies to doc count (12–16) and fact count (25–40 requested vs `min(12)` in the schema). Either enforce what the prompt asks for or change the prompt. Don't leave them disagreeing.

**P0-6. `prosecutionDirectPlan` falls back to `["?", "?", "?"]`.**
The prosecutor would literally ask "?" three times. The opening schema should require exactly the prosecution witness ids as keys (derived from `core`, via a refine), so a missing key triggers a retry, not a placeholder.

---

## P1: the "coherent spine"

Design decision (Peder, this session): documents and minor details are *allowed* to be contradictory or hallucinated, like real evidence. But the hidden truth and the importance-3 facts must be consistent and findable, because the player needs a real path to winning and Jev's claim checks need something stable to rule against.

**P1-1. Importance-3 coverage is only a warning. Make it a repair step.**
After the Jev doc check, for each importance-3 fact:
- not established by any document → run one targeted "docs" call that writes (or rewrites) **one** document to bury that fact, then Jev-check it again;
- not known by any witness → add it to the `knows` of the most plausible witness (ask Jev: a `choice` over witness ids with the fact in state), preferring defense-list witnesses so the player can reach it.
If a case still lacks coverage after repair, mark it `quality: "rejected"` in its report and don't add it to the library.

**P1-2. The fallback `w.knows = [core.facts[0].id]` is arbitrary.**
F01 may be a case-turning fact, which would hand it to a random witness. Instead, pick the lowest-importance fact related to the witness's role (a Jev `choice`), or re-ask that witness stage with feedback.

**P1-3. Truth-variant sanity check (cheap, Jev).**
After authoring, ask Jev in one call against `{ truth, charge }`: `is_defendant_guilty_of_charge` (noul) and `is_guilty_of_something_else` (noul). If the answers disagree with the requested variant (e.g. "innocent" but guilty ≥ 0.6), reject or re-author stage 1. Free models drift on this, and a case whose hidden truth contradicts its label breaks the design.

---

## P2: smaller

- Jev doc check hardcodes `model: "jev-latest"`. Use `CONFIG.JEV_MODEL`.
- The doc check can only *drop* false fact claims. Fine for now, but log the dropped claims into the case report. Frequent drops mean the docs prompt needs work.
- `opencode run … <prompt>` passes the prompt as a command-line argument. Windows caps the command line at ~32k characters, and the docs prompt includes the truth plus up to 40 facts. Pass the prompt via stdin or a temp file before prompts grow.
- The token estimate is logged but not acted on. Fine, since `buildRecordView` prunes bodies. Put the number in the case report.
- `generateCase()` doc comment still says "v0.1: return the bundled fixture". Update it.

## What's good

Staging matches the spec. The zod schemas at every boundary are right. The scripted-transport tests that route on `[STAGE …]` markers are a nice, cheap way to test the pipeline without a network. Filtering unknown fact references before assembly is right.

---

## Definition of done

1. `npm run author -- --count 3` produces 3 cases in `cases/` with report sidecars; commit at least 2 that pass quality checks.
2. `CASE_SOURCE=library npm run play` plays a generated case.
3. Tests: a docs chunk missing an id triggers a retry with feedback; a witness id mismatch doesn't crash; a roster with 3 prosecution witnesses is rejected; an uncovered importance-3 fact is repaired or the case is rejected; retries total ≤ 2 per stage.
4. Append "Response to Review 03" to this file.

---

## Response to Review 03 — 2026-09-29

Implementer: Muse Spark. Baseline at finish: 14 files, **76/76 pass**, `tsc` clean, `cases/` holds 2 quality-ok library cases, scripted library play reaches VERDICT.

### A-1. Offline library (the structural fix — agreed)
- `npm run author -- --count N [--variant X] [--dir cases]` authors into `cases/<slug>.json` + `<slug>.report.json` (new `scripts/author.ts`, `server/gen/library.ts`). Rejected cases never enter the library.
- `CASE_SOURCE=library` (new default whenever `cases/` is non-empty, else fixture); `generated` kept for fast-model futures; `fixture` for tests/CI. `generateCase()` also persists live-generated cases before play (Review 04 P0-2), so no authored case can vanish with the process again.
- Unseen rotation via gitignored `cases/.seen.json` (resets when exhausted). Committed: Dotty Marmalade + Brenda Butterworth (reports beside them).
- Live proof: `CASE_SOURCE=library` scripted play ran Dotty to a hung jury. Her docs are exactly the intended 30 s texture — cluttered memos, parenthetical burials, minor contradictions (dent left vs right, 1968 vs 1969), exonerating facts findable under the clock.
- First batch took ~10 min for 2 cases on the free model (a third run was correctly *rejected* by the truth check below). `AUTHOR_CONCURRENCY`/`AUTHOR_DEADLINE_MS` bound the wait; gameplay never waits at all now.

### P0
- **P0-1** — retry loop removed from `author()`; only `completeJson()` retries (≤2 attempts/stage, asserted in tests). Stage 2 runs through `mapLimit` (default 3, `AUTHOR_CONCURRENCY`; order-preserving, bound-tested). `AUTHOR_DEADLINE_MS` (default 15 min) fails cleanly.
- **P0-2** — retries append the first 5 compact zod issues ("Return corrected JSON only"). Test asserts the retry prompt contains the failure.
- **P0-3** — 2 docs per call; per-chunk zod refine requires the exact requested id set (a short chunk retries with feedback, tested). The `"Misc."` silent fallback is gone.
- **P0-4** — witness assembly is positional (result *i* belongs to roster *i*, requested id overwritten); `WitnessDetailsSchema` no longer even accepts an id. A wrong-id model reply can't crash — tested by construction.
- **P0-5** — refines enforce exactly 2 prosecution + 4–6 defense witnesses, 12–16 docs, 20–40 facts. One deliberate deviation disclosed: prompt and schema say 20–40 where the spec draft said 25–40 (free-model pragmatics; the committed cases landed 26–30).
- **P0-6** — opening schema requires exactly the prosecution ids as plan keys (refine built from `core`); missing key retries, never `"?"`. Tested.

### P1. Coherent spine
- **P1-1** — post-check repair: uncovered importance-3 in docs → targeted single-doc rewrite + Jev re-check; uncovered in witnesses → Jev `assignee` choice over defense-first-ordered ids. Still uncovered → `quality: "rejected"`, never enters the library. Tested both directions (repaired-ok, unrepairable-reject).
- **P1-2** — empty `knows` → Jev `choice` over importance-1 facts for the role (was: arbitrary F01). Tested.
- **P1-3** — truth-variant Jev check (guilty-of-charge + guilty-of-something-else vs variant thresholds). Live evidence it works: a third authored case was rejected as mislabeled-innocent (guilty 0.08 / else 0.80 = other_crime wearing innocent's clothes). Tested with a contradicting mock.

### P2
- Doc check uses `CONFIG.JEV_MODEL`; dropped claims land in `report.droppedClaims`; prompts >24k chars go via temp-file attachment (`-f`), temp file cleaned on every exit path; token estimate in the report; `generateCase()` doc comment rewritten.

### DoD
1. `author --count 3` → 2 committed ok cases (3rd correctly rejected). Reports beside them.
2. Library play to VERDICT verified (scripted, live Jev).
3. All five test bullets exist in `tests/authorCase.test.ts` (+ `mapLimit`, + plan-keys).
4. This section.
