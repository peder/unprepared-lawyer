# Review 04: first generated-case playtest (Baron von Cheddar) — 2026-09-29

Reviewer: Grok. Scope: live `CASE_SOURCE=generated` play on Muse Spark 1.3 (author) + Jev `jev-1.13.0` + stub LLM. Trigger: Peder's log of *The People v. Baron von Cheddar* (30 facts, 14 docs, 6 witnesses, truth=innocent). Not a re-audit of the engine internals already covered in Reviews 01–03.

## Status of 01–03

Reviews 01–02 looked closed from code. **Review 03 is still open** (offline case library, retry/concurrency, id-set validation, importance-3 repair, truth-variant Jev check). This file does not replace it. Baron is evidence that free-model authoring *can* finish; it is not evidence that live generation at trial start is the right product.

---

## What this playtest proved

- Stage 1–3 completed. Jev doc-check ran (drops on D05 / D09 / D11). Record estimate ~10k tokens, under budget.
- Call P ran: jury priors landed at avg 0.43 with real spread (J10 at 14%), not a flat 0.5. The dairy-weapon opening did not steamroll the box.
- The generated prosecutor voice is already in one register (pun stacking). That is a prompt-taste issue, not an engine bug — but it is the only real prose in the trial while `LLM_PROVIDER` defaults to stub.

---

## What's good (keep)

- Engine already marks the prosecution opening `hiddenFromPlayer: true` (`TrialEngine.setupPriors`). Jury view is supposed to include it (spec §9 / §10.1). Do not "fix" that by stripping it from Call P.
- Spec §9 already names a **PLAYER** view: charge, transcript minus hidden entries, docs only during the 30 s read, witness names/roles. The bug is that nothing implements that view. `play.ts` is the player client today.
- Startup banner still tells the truth (`Jev: LIVE | LLM: stub`). Believe it: witnesses will be canned until voice is live.

---

## P0 — the unprepared fantasy

### P0-1. The player heard the prosecution opening

Spec §3 / §9 PLAYER / §10.1: the player drifted off; they see the judge note and a tilted jury box, not the speech. The engine does this. `scripts/play.ts` `onEvent` prints every `transcript` entry, including `hiddenFromPlayer`. Baron's log is the bug:

```
PROSECUTOR: Ladies and gentlemen of the jury, cameras on…
  JUDGE: [You drifted off during the prosecution's opening statement.]
OPENING (blind, ≤150 words)
```

The prompt says "blind" while the speech is already on screen.

Fix in one place, used by play *and* the future HUD:

- Add `visibleToPlayer(entry)` (skip when `hiddenFromPlayer`). Player-facing print/render uses it. JSONL `--log` may still keep the full event (useful for review).
- Test: `setupPriors` emits a prosecutor opening with `hiddenFromPlayer: true`; a player formatter does not include that text, and still includes the judge drift note. Jury view still contains the opening text (existing RECORD/JURY tests stay as they are).

Do not special-case "opening" in `play.ts`. The next hidden line (if any) will leak the same way.

### P0-2. Baron vanished when the process did

Minutes of authoring, then the case lived only in RAM. There is no `cases/` write, no dump on success, no report of which factIds Jev dropped. A second `npm run play` cannot replay Cheddar; CI cannot; a reviewer cannot check whether the dropped claims were importance-3.

This is Review 03 A-1, but the playtest makes it operational P0 for *this* loop: **if `authorCase()` returns, write `cases/<slug>.json` (and a sidecar report) before `play` starts the trial.** Even a crude dump beats another 4-minute wait. Full library picking (`CASE_SOURCE=library`) can stay on the Review 03 track.

Minimum report fields from this log: title, truth variant, fact/doc/witness counts, token estimate, per-doc dropped factIds, any importance-3 coverage warnings.

---

## P1 — the rest of the same fantasy

### P1-1. The 30 s read is theater

`doRead` prints the full body, then counts down. Scrollback keeps the document forever after "(put it back.)". Spec §9 PLAYER: docs exist for the player only during the read.

Terminal cannot un-print. Closest honest version: print the body, clear the screen (or print enough blank lines) when the timer ends, and never reprint bodies in later HUDs. Listing bins/titles after the fact is fine. A test that the engine does not put doc bodies in any player-facing snapshot is the long-term check (once a player view exists).

### P1-2. Don't playtest comedy on stub voice

Authoring used Muse Spark; live lines did not. Stub answers will make Cheddar feel like Gerald with extra facts. Next play of a generated case: `LLM_PROVIDER=opencode` (fast voice slot), keep Jev live, `PLAY_DEBUG=1`. Otherwise you cannot tell pun-flattening in the opening prompt from emptiness on the stand.

### P1-3. Print the wiring *before* the wait

The LIVE/stub banner currently appears *after* `[case] fresh case ready`. During a multi-minute author, the player has no idea whether Jev is live, whether this will fall back to Gerald, or whether they should abort. Print `[Jev: … | LLM: … | CASE_SOURCE=generated]` first. Optionally print stage logs to stderr as now.

### P1-4. Word limits are copy, not rules

`MAX_WORDS_OPENING` / `MAX_WORDS_CLOSING` are only in the prompt string. Engine `submitOpening` / `submitClosing` accept anything. Truncate or reject in the engine (authoritative, spec §4) and have play display the remaining count. Test: 151st word does not reach Jev.

---

## P2 — HUD and small rules

- **First jury line is a lie.** `reactions()` after Call P prints `0.43 → 0.43 (=)` because `lastLean` is empty so `prev === avg`, then lists jurors who moved ≥5 pts from the hardcoded `0.5` fallback. Print `jury priors 0.43` (and the movers vs 0.5) once. Deltas start at the player's opening.
- **▼ reads as failure.** The bar and the number are P(guilty). `0.43 → 0.40 (▼3)` is the opening working. Peder's playtest: "I thought I fared poorly." Label the side every time (`jury P(guilty) 0.43→0.40, defense ▲`) or invert the player-facing delta to "the room moved your way." Do not make the player hold "down is good" in their head during a 4s objection window.
- **Witness answers are easy to miss inline.** Chip's lines *were* printed (`    CHIP HOGGART: …`) but Peder scrolled past them. The beat is: prosecutor question, `[jev] model=…`, same-line `[o] OBJECT (4s)>`, then an indented answer, then HUD, then the next question. Nothing restates the Q/A as a pair after the window closes. After the objection resolves, reprint a two-line block (`PROSECUTOR: …` / `CHIP: …`) and keep `[jev] model=` off the play surface (debug only). The 4 s TTY window makes this worse; even with a longer window the answer needs its own stanza.
- **Re-picking a `[READ]` doc advances the read phase without decrementing `readsLeft`.** Not a useful exploit (you still only pick once per phase, so you just skip a new document). It is a silent wasted discovery. Reject already-read ids, or count a re-read as the phase's read and do not offer them as the "new paper" choice.
- **`[jev] model=jev-1.13.0` per doc-check** drowned the author log. One line at factory connect, then per-call only under `PLAY_DEBUG` / `AUTHOR_DEBUG`.
- **Opening pun density.** Stage 2d prompt should ask for one comic premise, not a pun per clause. Taste, not a test; tweak when you re-author, not in the engine.

**Out of scope until P0/P1:** wiring `client/` or Electron. The HUD mock will copy the transcript leak unless it uses the same `visibleToPlayer` helper.

---

## Definition of done

1. Generated-case play: after `setupPriors`, the terminal does not contain the prosecution opening text; it does contain the drift note; `--log` JSONL still has the hidden entry; Call P / jury view still see the speech (unit test on the formatter + existing jury-view test).
2. A successful `authorCase()` leaves `cases/<slug>.json` + report on disk before the opening prompt. Dropped factIds are in the report. (Picking from the library can wait for Review 03 A-1.)
3. Next human playtest of Cheddar (or a new case) uses live Jev + live voice + `PLAY_DEBUG=1`. Stub-only runs are for CI.
4. Opening/closing word cap enforced in the engine with a test.

Append "Response to Review 04" here when done.

---

## Response to Review 04 — 2026-09-29

Implementer: Muse Spark. `visibleToPlayer()` in `shared/types.ts` (single helper for play + future HUD, per the review's warning). Tests in `tests/playerView.test.ts`.

### P0
- **P0-1** — `play.ts` `onEvent` returns early on `!visibleToPlayer(t)`: the blind opening never reaches the terminal. `--log` JSONL still records the hidden entry (log path untouched). Test: hidden opening invisible to the formatter, drift note visible, jury-view state still contains the speech (existing RECORD/JURY tests unchanged). No "opening" special-casing — any future hidden line is covered.
- **P0-2** — done twice over: `npm run author` writes case + sidecar report per case, and `generateCase()` (generated path) persists via the same `writeCaseFiles` before play starts. Reports carry title, variant, counts, token estimate, per-doc dropped factIds, importance-3 coverage, truth check. Dropped claims are reviewable per doc.

### P1
- **P1-1** — after the read timer, TTY clears the screen (`console.clear()`; piped runs keep clean logs). Bodies are never reprinted; bin listings show titles only.
- **P1-2** — noted, human action: code default stays stub (determinism for CI/scripted runs); the banner tells the truth every run. Next human playtest should set `LLM_PROVIDER=opencode` + `PLAY_DEBUG=1` per the review.
- **P1-3** — banner moved before generation: `[Jev: LIVE (jev-latest) | LLM: stub | CASE_SOURCE=library]` prints before any wait, so fallback-to-Gerald is never a surprise.
- **P1-4** — engine truncates openings/closings to `MAX_WORDS_*` (`truncateWords`, returns `truncated` flag); the 151st word is absent from both transcript and sent Jev state (test asserts both). Play shows `words/cap` + a TRUNCATED flag.

### P2
- Priors line: first `reactions()` prints `jury priors P(guilty) 0.43` (movers vs 0.5); deltas start at the opening.
- Every jury line labels the side: `jury P(guilty) 0.43→0.40 (defense ▲3)` — down-is-good is stated, never implied.
- Q/A stanza: prosecutor question prints for the objection window; on answer, the pair reprints as a block with the witness's name; `[jev] model=` stays (gated: once per model unless `PLAY_DEBUG`/`AUTHOR_DEBUG`).
- Re-reads now consume the slot in the engine (no silent free advance); `play` reprompts on `[READ]` picks (non-TTY accepts to avoid hangs).
- `HttpJevClient` logs the model once per process, per-call only under debug flags.
- Opening prompt: one comic premise, at most one pun.

### DoD
1. Unit-tested (formatter + jury-view intact); `--log` verified with hidden entry present (185-record trial-002 log shape).
2. Verified: generated and library paths both persist before the opening prompt.
3. Human step, pending — stub remains the code default.
4. Tested: 151st word absent from transcript and Jev state.
