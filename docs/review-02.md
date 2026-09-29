# Review 02: `npm run play` playtest (2026-09-29)

Reviewer: Claude. Scope: `scripts/play.ts` at commit `945c094`, plus a transcript from Peder's first interactive playthrough (Gerald the Goose). Fix in order. P0 items break the playtest; don't add features until they're done.

---

## P0-1. The game quits mid-trial (stdin gets paused)

`objectionWindow()` → `cleanup()` calls `inStream.pause()`. Nothing resumes it afterward. The next `askLine()` waits on a promise with no active handle keeping the event loop alive, so Node exits silently with code 0. That's the "app just quit" after the first cross question.

Related bug in the same function: while in raw mode, the persistent `data` listener used by the line reader (added at module top) **also** receives every keystroke. Keys pressed during an objection window (including Enter) land in `lineLeftover` and get consumed by the next `askLine()`. In the playtest, `Q1>` was answered instantly with an empty line → "No further questions."

Fix: stop hand-managing two stdin consumers. Use one input owner:
- One persistent `data` listener and one buffer. Never call `pause()` for the rest of the game.
- Objection window = a "mode" flag on that single listener. While `mode === "objection"`, a keypress of `o` resolves the window, and **everything received during the window is discarded** (clear the buffer when the window closes).
- Toggle raw mode only on a TTY, and always restore cooked mode before any `askLine()`.
- Add `process.stdin.ref()` defensively, and make `main()` end with an explicit `process.exit(0)` after the verdict, so exit is always deliberate.

Test: a scripted TTY-less run must still reach `FINAL:`. Add a unit test for the line reader (feed chunks, then assert lines and that window-time input is discarded).

## P0-2. `play` is hardwired to the mock Jev and the stub LLM, so nothing real is happening

`play.ts` constructs `new MockJevClient(...)` directly, with a hook that sets every juror's leaning from **which side is currently speaking** (`side.current === "prosecution" ? 0.55 + … : 0.38 + …`). That's why the jury moves in a fixed pattern regardless of what the player types, and why every reaction is 😐. `createLLMClient()` defaults to the stub, so witness lines are canned templates ("Yes.", "I... don't recall.").

Fix:
1. Share one factory with `sim.ts`: `createJevClient()` honoring `JEV_CLIENT=http|mock` (default **http** when `TYPESAFE_API_KEY` is set, else mock with a loud banner). Delete the side-based juror hook from `play.ts`. It hides exactly what we're trying to test.
2. Print a startup banner so the player always knows the wiring: `Jev: LIVE (jev-1.13.0) | LLM: stub` or `Jev: MOCK | LLM: opencode/<model>`.
3. Add `PLAY_DEBUG=1`: after each exchange, print one compact line with the sampled Jev decisions and their probabilities, e.g.
   `jev A 212ms: claim=not_in_record(.61) improp=proper(.72) obj? .18→no stance=doesnt_know(.44) truthful .83→yes fact=none | B 188ms: avg .64→.58`
   This answers "are the Jev calls doing anything?" at a glance, and it's the main tuning tool.

## P0-3. Waiving a question still questions the witness

An empty entry or `pass` becomes the question text "No further questions.", which goes through the full pipeline. The witness then *answers it* ("Yes, that's right. Gerald was seen sitting on the pumpkin…"), revealing a prosecution fact for free and moving the jury.

Fix: add `eng.waiveQuestion(witnessId)`. It consumes the slot (or ends the examination: "No further questions" should end the whole examination, not just one question), writes a transcript line from the defense, and makes **no** Jev or LLM calls. Test: waiving calls neither client and adds no witness answer.

---

## P1. Readability of the terminal playtest

- **Prosecutor lines print twice**: once from the `transcript` event and once from `console.log(\`PROSECUTOR: ${h.text}\`)`. Remove the manual log.
- **Label the examination.** Before each witness, print a header: `=== PROSECUTION CALLS MARLA CRUMP (Fair organizer) — DIRECT ===`, then `=== YOUR CROSS ===`. Prefix each question with its number and who is asking: `[Direct 2/3] PROSECUTOR:`.
- **Show the answer as a reply to the question.** Indent witness answers under the question and use the witness's name, not `W1`: `    MARLA CRUMP: I... don't recall.`
- **HUD only once per exchange**, and show only what the player controls in that phase. During the prosecution's direct, show `your objections left`; hide `qLeft` (it's the prosecutor's count and confused the player).
- **Show movement, not just levels.** Jury line: `jury 0.64 → 0.54 (▼10)`, and only list individual jurors who moved ≥ 5 points, with their emoji.
- **Only show the objection prompt when it's actionable.** The 4-second window currently appears after the question with no context for what to object to. Print the question, then `[o] OBJECT (4s)` on the same line, and fold the grounds picker into a single-key menu (`1 leading 2 hearsay …`).
- **Opening statement feedback.** After the opening, print a one-line judge/jury beat from the Jev result (claim status, impropriety, jury delta) so the player learns the system responds to what they type. A motion to dismiss in an opening is a great test case: impropriety should come back high.

## P2. Carry-overs from Review 01 to confirm

I haven't re-verified these line by line yet; I'll do that once the play loop is stable. Add a "Response to Review 02" section listing what changed and which Review 01 items are fully closed.

---

## Definition of done

1. `npm run play` completes a full trial on a Windows terminal without quitting, including pressing `o` in at least one objection window.
2. The startup banner shows LIVE Jev when a key is present, and `PLAY_DEBUG=1` prints per-exchange Jev decisions and latency.
3. A scripted non-TTY run (`npm run play < fixtures/play-script.txt`) reaches `FINAL:` in CI.
4. Waiving a question makes zero model calls.

---

## Response to Review 02 — 2026-09-29

Implementer: Muse Spark. Baseline at finish: 10 test files, **57/57 pass**, `tsc` clean, scripted `play` reaches VERDICT locally and in CI, one full trial also verified against **live** Jev (`jev-1.13.0`, hung jury, patience 70→44, jury spread with 😏🙄😴😂🤔).

### P0
- **P0-1** — new `scripts/input.ts`: one persistent `data` listener, one buffer, modes `line`/`objection`. Never `pause()`s; objection window discards everything received while open (fixes both the silent quit *and* the window-keystroke leak into the next prompt). Raw mode toggled TTY-only, always restored before `askLine`. `main()` ends with explicit `process.exit(0)`; stdin `ref()` guarded (redirected stdin has no `ref`). `tests/input.test.ts` covers chunked input, window discard, `o`-resolves, and the non-TTY path. `play.ts` deleted its local reader + raw-mode copy and uses the owner.
- **P0-2** — new `server/jev/factory.ts` `createJevClient()`, shared by `sim.ts` and `play.ts`: `JEV_CLIENT=http|mock`, defaulting to http when `TYPESAFE_API_KEY` is set, else mock with a loud banner. The side-based juror hook is gone from `play.ts` (kept in `sim.ts` as labeled tuning diagnostics). Startup banner prints e.g. `[Jev: LIVE (jev-latest) | LLM: stub]`. `PLAY_DEBUG=1` prints per exchange `claim/improp/obj/stance/truthful/fact`, latency, and jury delta; engine `QuestionDetails` now carries `claimProbs/stanceProbs/factProbs` to back it.
- **P0-3** — `eng.waiveQuestion(witnessId)`: ends the examination, writes "No further questions.", advances phases, **zero** Jev/LLM calls (test asserts call counts, no answer entry, phase advance). Empty/`pass` input waives in `play.ts`.

### P1
- Prosecutor double-print removed (was already fixed pre-review; kept). Examination headers (`=== PROSECUTION DIRECT: MARLA CRUMP (Fair organizer) ===`), numbered `[Direct 2/3]` / `YOU [cross 1/3]` prompts, witness answers indented under the question with real names (`MARLA CRUMP:`), HUD shows phase-relevant stats only (objections on their examination, questions on yours, reads on reads), jury line shows movement (`0.34 → 0.33 (▼1)`, only ≥5pt movers listed), `[o] OBJECT (4s)` single line + single-key grounds menu (`1`–`8`), opening feedback line (`claim=…, tone=…; jury …→…`) — `submitOpening` now returns the A-open read.

### P2 / Review 01 closure
- Review 01 items P0-1–P2-5 all still pass (51 carried tests green, unchanged semantics; only additions: `submitOpening` return value, `QuestionDetails.probs`, `waiveQuestion`). Live traffic since re-verified the wire parser (float-score tolerance, committed earlier).

### DoD
1. Non-TTY scripted run reaches VERDICT repeatedly (185-record JSONL log verified: 143 events, 21 inputs, 20 results). Live-TTY `o`-press path is code-complete but still unproven by a human hand — flagged for the next playtest.
2. Banner verified in both modes; `PLAY_DEBUG=1` line format confirmed in code, not yet eyeballed live.
3. `fixtures/play-script.txt` (includes a `pass` waive + an invalid witness pick, both self-correcting) + CI step asserting `VERDICT:` and JSONL validity on ubuntu + windows.
4. Unit-tested: `jev.log` length unchanged, LLM spy at zero, no answer entry.
