// Interactive terminal trial: the real TrialEngine with a human defense counsel.
//   npm run play                 — full timers (30s reads, 4s objection windows)
//   PLAY_FAST=1 npm run play     — short timers (smoke tests / piped stdin)
// Piped stdin / file redirect works: objection windows auto-pass. Input is read
// with a tiny line reader (not readline — readline misbehaves on Windows
// with redirected stdin), so TTY, pipes, and `< file` all behave the same.
import "./env.js";
import { stdin as inStream, stdout as outStream } from "process";
import { createWriteStream, type WriteStream } from "fs";
import { askLine, waitObjectionKey, tryConsumeLine, drainInput } from "./input.js";

// --log=<file>: append a JSONL event log (every engine event, player input,
// and per-question Jev decision) for post-trial review by another agent.
const logArg = process.argv.find((a) => a.startsWith("--log="));
const logPath = logArg ? logArg.slice("--log=".length) : null;
let logStream: WriteStream | null = null;
if (logPath) {
  logStream = createWriteStream(logPath, { flags: "a" });
}
let loggedEvents = 0;
function logRecord(obj: Record<string, unknown>) {
  if (!logStream) return;
  loggedEvents += 1;
  logStream.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
}
function closeLog() {
  return new Promise<void>((resolve) => {
    if (!logStream) {
      resolve();
      return;
    }
    logRecord({ kind: "log_closed", events: loggedEvents });
    logStream.end(() => resolve());
  });
}
// A silent mid-trial quit is the worst outcome: capture crashes into the log too.
process.on("uncaughtException", (e) => {
  logRecord({ kind: "crash", error: String(e?.stack ?? e) });
  console.error("\n!! CRASH:", (e as Error).message);
  void closeLog().finally(() => process.exit(1));
});
process.on("unhandledRejection", (e) => {
  logRecord({ kind: "crash", error: String((e as Error)?.stack ?? e) });
  console.error("\n!! CRASH (async):", (e as Error)?.message ?? e);
  void closeLog().finally(() => process.exit(1));
});
import { TrialEngine } from "../server/trial/TrialEngine.js";
import type { QuestionResult } from "../server/trial/TrialEngine.js";
import { createJevClient } from "../server/jev/factory.js";
import { DirectLLMClient } from "../server/llm/DirectLLMClient.js";
import { visibleToPlayer } from "@shared/types.js";
import { createLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { generateCase } from "../server/gen/generateCase.js";
import { CONFIG } from "../shared/config.js";
import type { WitnessId } from "../shared/types.js";

const FAST = process.env.PLAY_FAST === "1";
const TTY = inStream.isTTY === true;
const READ_SECONDS = FAST ? 3 : CONFIG.READ_SECONDS;
const OBJECTION_MS = FAST ? 100 : CONFIG.OBJECTION_WINDOW_MS;

/** P0-1: all input goes through the single owner in ./input.ts (never pause(),
 *  window keystrokes discarded on close). This wrapper only adds input logging. */
async function ask(prompt: string): Promise<string> {
  const started = Date.now();
  const line = await askLine(prompt);
  logRecord({ kind: "input", prompt: prompt.trim(), value: line, ms: Date.now() - started });
  return line;
}

/** Objection window: TTY gets OBJECTION_MS to press "o", then a grounds picker. */
async function objectionWindow(): Promise<"leading" | "hearsay" | "relevance" | "speculation" | "argumentative" | "badgering" | "assumes_facts" | "compound" | null> {
  if (!TTY) return null;
  outStream.write(`  [o] OBJECT (${OBJECTION_MS / 1000}s)> `);
  const pressed = await waitObjectionKey(OBJECTION_MS);
  outStream.write("\n");
  if (!pressed) return null;
  const g = (await ask("  grounds [1 leading 2 hearsay 3 relevance 4 speculation 5 argumentative 6 badgering 7 assumes_facts 8 compound]> ")).trim();
  const groundsMap: Record<string, "leading" | "hearsay" | "relevance" | "speculation" | "argumentative" | "badgering" | "assumes_facts" | "compound"> = {
    "1": "leading", "2": "hearsay", "3": "relevance", "4": "speculation",
    "5": "argumentative", "6": "badgering", "7": "assumes_facts", "8": "compound",
  };
  return groundsMap[g] ?? "relevance";
}

function bar(p: number, w = 20): string {
  const on = Math.round(p * w);
  return "[" + "#".repeat(on) + "-".repeat(w - on) + "]";
}

async function main() {
  inStream.ref?.();
  // P1-3 (review 04): wiring banner BEFORE any wait — the player knows the
  // setup (and the possible Gerald fallback) before a multi-minute author.
  const { client: jev, banner: jevBanner } = createJevClient();
  const llm = createLLMClient();
  const llmProvider = (process.env.LLM_PROVIDER ?? "stub").toLowerCase();
  const llmBanner = llmProvider === "stub" ? "LLM: stub" : `LLM: ${llmProvider}/${process.env.LLM_VOICE_MODEL ?? "default cascade"}`;
  console.log(`\n[${jevBanner} | ${llmBanner} | CASE_SOURCE=${process.env.CASE_SOURCE ?? "fixture"}]`);
  if (llm instanceof DirectLLMClient) await llm.refreshPricing(); // live free/paid, else suffix rule
  const caseFile = await generateCase();
  const eng = new TrialEngine(caseFile, jev, llm, {
    seed: Date.now() % 2 ** 31,
    onEvent: (e) => {
      logRecord({ kind: "event", event: e });
      if (e.kind === "transcript") {
        const t = e.entry;
        if (!visibleToPlayer(t)) return; // P0-1: blind means blind; the log keeps it
        const tag = t.stricken ? " [STRICKEN]" : "";
        if (t.kind === "answer" && pendingPQ !== null) {
          // Q/A stanza: restate the pair after the window closes (P2).
          console.log(`  PROSECUTOR: ${pendingPQ}\n    ${witnessName(t.speaker)}: ${t.text}${tag}`);
          pendingPQ = null;
        } else if (t.speaker === "prosecutor" && t.kind === "question") {
          pendingPQ = t.text;
          console.log(`  PROSECUTOR: ${t.text}${tag}`);
        } else if (t.kind === "answer") {
          console.log(`    ${witnessName(t.speaker)}: ${t.text}${tag}`);
        } else console.log(`  ${speaker(t.speaker)}: ${t.text}${tag}`);
      }
      if (e.kind === "log") console.log(`  * ${e.text}`);
    },
  });
  let pendingPQ: string | null = null;
  const witnessName = (id: string) => caseFile.witnesses.find((w) => w.id === id)?.name.toUpperCase() ?? id;
  const hud = () => {
    const s = eng.status();
    const avg = avgLean(eng);
    // Phase-relevant stats only: objections on their examination, questions on yours.
    let extra = "";
    if (s.phase === "P_DIRECT" || s.phase === "D_CROSS") extra = ` | your objections: ${s.objectionsLeft}`;
    else if (s.phase === "P_CROSS" || s.phase === "D_DIRECT") extra = ` | your questions: ${s.questionsLeftForThisWitness}/3`;
    else if (s.phase === "P_READ" || s.phase === "D_READ" || s.phase === "FINAL_READ") extra = ` | reads left: ${s.readsLeft}`;
    console.log(`\n-- [${s.phase}] patience ${bar(eng.state.judgePatience / 100)} ${eng.state.judgePatience} | jury P(guilty) ${bar(avg)} ${avg.toFixed(2)}${extra} --`);
  };
  let lastLean: Record<string, number> = {};
  let priorsShown = false;
  const reactions = () => {
    const avg = avgLean(eng);
    const moved = caseFile.jurors.filter((j) => Math.abs((eng.state.jurorLeanings[j.id] ?? 0.5) - (lastLean[j.id] ?? 0.5)) >= 0.05);
    const movedStr = moved.length ? "  " + moved.map((j) => `${j.id}${eng.state.jurorReactions[j.id]}${Math.round(eng.state.jurorLeanings[j.id] * 100)}`).join(" ") : "";
    if (!priorsShown) {
      // First line is priors, not a delta — deltas start at the player's opening.
      priorsShown = true;
      console.log(`   jury priors P(guilty) ${avg.toFixed(2)}${movedStr}`);
    } else {
      const prev = Object.values(lastLean).reduce((a, b) => a + b, 0) / 12;
      const delta = avg - prev;
      // Down-is-good, stated outright: the room moved the defense's way.
      const side = Math.abs(delta) < 0.005 ? "(holding)" : delta < 0 ? `(defense ▲${Math.round(-delta * 100)})` : `(defense ▼${Math.round(delta * 100)})`;
      console.log(`   jury P(guilty) ${prev.toFixed(2)} → ${avg.toFixed(2)} ${side}${movedStr}`);
    }
    lastLean = { ...eng.state.jurorLeanings };
  };

  console.log(`\n===== ${caseFile.caseTitle.toUpperCase()} =====`);
  console.log(`Charge: ${caseFile.charge}\nYou are the defense. You did not prepare. Good luck.\n`);

  await eng.setupPriors();
  hud();
  reactions();

  const opening = await ask(`\nOPENING (blind, ≤${CONFIG.MAX_WORDS_OPENING} words)\n> `);
  const oWords = opening.split(/\s+/).filter(Boolean).length;
  const oAvg = avgLean(eng);
  const oRes = await eng.submitOpening(opening || "...");
  console.log(`  (${oWords}/${CONFIG.MAX_WORDS_OPENING} words${oRes.truncated ? " — TRUNCATED to the cap" : ""}; the room reacts: claim=${oRes.claimStatus}, tone=${oRes.impropriety}; jury ${oAvg.toFixed(2)}→${avgLean(eng).toFixed(2)})`);
  hud();
  reactions();

  // Prosecution witnesses
  for (const w of caseFile.witnesses.filter((x) => x.calledBy === "prosecution")) {
    await doRead(eng, caseFile.documents, w.id, `prosecution witness ${w.name} (${w.role})`);
    console.log(`\n=== PROSECUTION DIRECT: ${w.name} (${w.role}) ===`);
    for (let i = 0; i < CONFIG.PROSECUTION_DIRECT_QS; i++) {
      if (eng.state.outcome) break;
      console.log(`[Direct ${i + 1}/${CONFIG.PROSECUTION_DIRECT_QS}]`);
      const h = await eng.beginProsecutorQuestion({ witnessId: w.id });
      const grounds = await objectionWindow();
      const t0 = Date.now();
      const a0 = avgLean(eng);
      const r = await eng.resolveObjectionWindow(h, grounds);
      logResult("P-direct", r, t0, a0, avgLean(eng));
      if (r.stricken) {
        console.log(`  >> SUSTAINED — the jury will disregard: "${h.text}"`);
        pendingPQ = null;
      }
      hud();
      reactions();
      if (r.mistrial) break;
    }
    if (eng.state.outcome) break;
    console.log(`\n=== YOUR CROSS: ${w.name} (${w.role}) ===`);
    for (let i = 0; i < CONFIG.DEFENSE_QS; i++) {
      if (eng.state.outcome) break;
      const q = (await ask(`YOU [cross ${i + 1}/${CONFIG.DEFENSE_QS}, "pass" waives]> `)).trim();
      if (q === "" || q.toLowerCase() === "pass") {
        eng.waiveQuestion(w.id); // P0-3: ends the examination, zero model calls
        console.log("  (no further questions.)");
        break;
      }
      const t0 = Date.now();
      const a0 = avgLean(eng);
      const r = await eng.askDefenseQuestion({ witnessId: w.id, text: q });
      logResult("cross", r, t0, a0, avgLean(eng));
      hud();
      reactions();
      if (r.mistrial) break;
    }
    if (eng.state.outcome) break;
  }

  // Defense witnesses
  for (let n = 0; n < 2; n++) {
    if (eng.state.outcome) break;
    console.log("\n--- CALL A DEFENSE WITNESS ---");
    for (const w of caseFile.witnesses.filter((x) => x.calledBy === "defense")) {
      const called = eng.state.defenseWitnessesCalled.includes(w.id) ? " (testified)" : "";
      console.log(`  ${w.id}: ${w.name} — ${w.role}${called}`);
    }
    let wid = "" as WitnessId;
    while (true) {
      const pick = (await ask("Call> ")).trim().toUpperCase();
      try {
        eng.selectDefenseWitness(pick);
        wid = pick as WitnessId;
        break;
      } catch {
        console.log("  (not available — pick an uncalled defense witness)");
      }
    }
    const w = caseFile.witnesses.find((x) => x.id === wid)!;
    await doRead(eng, caseFile.documents, wid, `your witness ${w.name}`);
    console.log(`\n=== YOUR DIRECT: ${w.name} (${w.role}) ===`);
    for (let i = 0; i < CONFIG.DEFENSE_QS; i++) {
      if (eng.state.outcome) break;
      const q = (await ask(`YOU [direct ${i + 1}/${CONFIG.DEFENSE_QS}, "pass" waives]> `)).trim();
      if (q === "" || q.toLowerCase() === "pass") {
        eng.waiveQuestion(wid); // P0-3: ends the examination, zero model calls
        console.log("  (no further questions.)");
        break;
      }
      const t0 = Date.now();
      const a0 = avgLean(eng);
      const r = await eng.askDefenseQuestion({ witnessId: wid, text: q });
      logResult("direct", r, t0, a0, avgLean(eng));
      hud();
      reactions();
    }
    if (eng.state.outcome) break;
    console.log(`\n=== PROSECUTOR'S CROSS: ${w.name} (${w.role}) — [o] to object ===`);
    const cross = await llm.prosecutorCross({
      prosecutorName: caseFile.prosecutor.name, persona: caseFile.prosecutor.persona, witness: w, transcript: "", n: 2,
    });
    for (let ci = 0; ci < cross.length; ci++) {
      const q = cross[ci];
      if (eng.state.outcome) break;
      console.log(`[Cross ${ci + 1}/${cross.length}]`);
      const h = await eng.beginProsecutorQuestion({ witnessId: wid, text: q });
      const grounds = await objectionWindow();
      const t0 = Date.now();
      const a0 = avgLean(eng);
      const r = await eng.resolveObjectionWindow(h, grounds);
      logResult("P-cross", r, t0, a0, avgLean(eng));
      if (r.stricken) {
        console.log(`  >> SUSTAINED — the jury will disregard: "${h.text}"`);
        pendingPQ = null;
      }
      hud();
      reactions();
    }
  }

  if (!eng.state.outcome) {
    await doRead(eng, caseFile.documents, null, "final read before closing");
    const closing = await ask(`\nCLOSING (≤${CONFIG.MAX_WORDS_CLOSING} words)\n> `);
    const cWords = closing.split(/\s+/).filter(Boolean).length;
    const cRes = await eng.submitClosing(closing || "...");
    console.log(`  (${cWords}/${CONFIG.MAX_WORDS_CLOSING} words${cRes.truncated ? " — TRUNCATED to the cap" : ""})`);
    hud();
    console.log("\n--- DELIBERATION ---");
    const outcome = await eng.deliberate();
    reactions();
    console.log(`\n===== VERDICT: ${label(outcome)} =====`);
    console.log(outcome === "not_guilty" ? "You magnificent unprepared genius." : outcome === "guilty" ? "Disbarment speedrun." : "Transferred to another lawyer at the firm.");
    if (typeof (llm as { stats?: () => { requests: number; paidAttempts: number; paidSkippedOverCap: number; perModel: Record<string, number> } }).stats === "function") {
      const s = (llm as unknown as { stats: () => { requests: number; paidAttempts: number; paidSkippedOverCap: number; perModel: Record<string, number> } }).stats();
      const split = Object.entries(s.perModel).map(([m, n]) => `${m} ${n}`).join(", ") || "stub only";
      console.log(`[llm] ${s.requests} requests this trial (${s.paidAttempts} paid${s.paidSkippedOverCap ? `, ${s.paidSkippedOverCap} paid skipped over cap` : ""}; per model: ${split})`);
    }
  } else {
    console.log(`\n===== TRIAL ENDED: ${label(eng.state.outcome)} =====`);
  }
  await closeLog();
  if (logPath) console.log(`\n(log: ${loggedEvents} records → ${logPath})`);
  process.exit(0); // exit is always deliberate (P0-1)
}

function speaker(s: string): string {
  if (s === "prosecutor") return "PROSECUTOR";
  if (s === "defense") return "YOU";
  if (s === "judge") return "JUDGE";
  return s;
}

function label(o: string | undefined): string {
  return o === "not_guilty" ? "NOT GUILTY" : o === "guilty" ? "GUILTY" : o === "mistrial" ? "MISTRIAL" : "HUNG JURY";
}

/** Per-question Jev decisions, for post-trial review (spec §18 tuning hook).
 *  PLAY_DEBUG=1 also prints a compact line with latency + jury delta. */
const PLAY_DEBUG = process.env.PLAY_DEBUG === "1";
function avgLean(eng: TrialEngine): number {
  const ls = Object.values(eng.state.jurorLeanings);
  return ls.reduce((a, b) => a + b, 0) / ls.length;
}
function logResult(what: string, r: QuestionResult, t0: number, prevAvg: number, nowAvg: number) {
  logRecord({ kind: "result", what, stricken: r.stricken, ruling: r.ruling, mistrial: r.mistrial, answer: r.answer, details: { ...r.details }, voiceTimings: r.voiceTimings });
  if (PLAY_DEBUG) {
    const d = r.details;
    const voice = r.voiceTimings ? ` voice ${r.voiceTimings.model ?? "?"} ${r.voiceTimings.ms}ms (ttfb ${r.voiceTimings.ttfbMs ?? "?"}ms)` : " voice stub";
    console.log(
      `  [jev ${Date.now() - t0}ms] claim=${d.claimStatus} improp=${d.impropriety} obj=${d.prosecutorObjects ? `${d.objectionGrounds}/${d.sustained ? "sustained" : "overruled"}` : "no"} stance=${d.stance ?? "-"} truthful=${d.truthful ?? "-"} fact=${d.factId ?? "-"} | jury ${prevAvg.toFixed(2)}→${nowAvg.toFixed(2)}${voice}`,
    );
  }
}

async function doRead(eng: TrialEngine, docs: { id: string; bin: string; title: string; body: string }[], _wid: string | null, why: string) {
  console.log(`\n--- EVIDENCE BIN (${why}) — pick one, ${READ_SECONDS}s on the clock ---`);
  for (const d of docs) {
    const read = eng.state.docsRead.includes(d.id) ? " [READ]" : "";
    console.log(`  ${d.id}: ${d.bin} — ${d.title}${read}`);
  }
  let doc = docs[0];
  while (true) {
    const pick = (await ask("Read> ")).trim().toUpperCase();
    const found = docs.find((d) => d.id === pick);
    if (found) {
      if (TTY && eng.state.docsRead.includes(found.id)) {
        console.log("  (already read — pick fresh paper; re-reads still cost the phase's slot)");
        continue;
      }
      doc = found;
      break;
    }
    if (!TTY) break; // piped stdin exhausted — take the first
    console.log("  (pick a doc id)");
  }
  console.log(`\n===== ${doc.bin} — ${doc.title} =====\n${doc.body}\n`);
  // Speed read: Enter puts it back early (TTY only — piped scripts must not desync).
  const deadline = Date.now() + READ_SECONDS * 1000;
  let skipped = false;
  for (;;) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (left <= 0) break;
    outStream.write(`\r  ${left}s... (Enter puts it back)   `);
    await new Promise((r) => setTimeout(r, 250));
    if (TTY && tryConsumeLine() !== null) {
      skipped = true;
      break;
    }
  }
  outStream.write("\r                              \r");
  // TTY only: post-skip key mashes must not leak into prompts. Piped input is
  // preserved byte-for-byte (draining it wipes the script's future lines).
  if (TTY) drainInput();
  await eng.readDoc(doc.id);
  // P1-1 (review 04): the paper exists for the player only during the read.
  // Terminal can't un-print, so clear the scrollback's view of it.
  if (TTY) console.clear();
  console.log(skipped ? "  (put it back early.)" : "  (put it back.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
