// Interactive terminal trial: the real TrialEngine with a human defense counsel.
//   npm run play                 — full timers (30s reads, 4s objection windows)
//   PLAY_FAST=1 npm run play     — short timers (smoke tests / piped stdin)
// Piped stdin / file redirect works: objection windows auto-pass. Input is read
// with a tiny line reader (not readline — readline misbehaves on Windows
// with redirected stdin), so TTY, pipes, and `< file` all behave the same.
import "./env.js";
import { stdin as inStream, stdout as outStream } from "process";
import { TrialEngine } from "../server/trial/TrialEngine.js";
import { MockJevClient, type JevRequest } from "../server/jev/JevClient.js";
import { createLLMClient } from "../server/llm/OpencodeLLMClient.js";
import { generateCase } from "../server/gen/generateCase.js";
import { CONFIG } from "../shared/config.js";
import type { WitnessId } from "../shared/types.js";

const FAST = process.env.PLAY_FAST === "1";
const TTY = inStream.isTTY === true;
const READ_SECONDS = FAST ? 3 : CONFIG.READ_SECONDS;
const OBJECTION_MS = FAST ? 100 : CONFIG.OBJECTION_WINDOW_MS;

/** Minimal line reader: works on TTY (cooked-mode editing+echo), pipes, and file redirect.
 *  Holds a persistent buffer — a piped file can arrive in a single chunk. */
let lineLeftover = "";
let lineWaiter: ((line: string) => void) | null = null;
let stdinEnded = false;
inStream.on("data", (d: Buffer) => {
  lineLeftover += d.toString("utf8");
  pumpLine();
});
inStream.on("end", () => {
  stdinEnded = true;
  pumpLine();
});
function pumpLine() {
  if (!lineWaiter) return;
  const idx = lineLeftover.indexOf("\n");
  if (idx >= 0) {
    const w = lineWaiter;
    lineWaiter = null;
    const line = lineLeftover.slice(0, idx).replace(/\r$/, "");
    lineLeftover = lineLeftover.slice(idx + 1);
    w(line);
  } else if (stdinEnded) {
    const w = lineWaiter;
    lineWaiter = null;
    const line = lineLeftover;
    lineLeftover = "";
    w(line);
  }
}
function askLine(prompt: string): Promise<string> {
  outStream.write(prompt);
  return new Promise((resolve) => {
    lineWaiter = resolve;
    pumpLine();
  });
}

function bar(p: number, w = 20): string {
  const on = Math.round(p * w);
  return "[" + "#".repeat(on) + "-".repeat(w - on) + "]";
}

function sideFor(eng: TrialEngine): "prosecution" | "defense" {
  const ph = eng.status().phase;
  return ph === "P_DIRECT" || ph === "P_CROSS" ? "prosecution" : "defense";
}

async function main() {
  const caseFile = await generateCase();
  const side: { current: "prosecution" | "defense" } = { current: "prosecution" };
  const jev = new MockJevClient({}, "jev-mock-0.1", (req: JevRequest, key: string) => {
    if (/^J\d+$/.test(key)) {
      const n = Number(key.slice(1));
      const base = side.current === "prosecution" ? 0.55 + (n % 4) * 0.06 : 0.38 + (n % 3) * 0.05;
      return Math.min(0.92, Math.max(0.08, base));
    }
    return undefined;
  });
  const llm = createLLMClient();
  const eng = new TrialEngine(caseFile, jev, llm, {
    seed: Date.now() % 2 ** 31,
    onEvent: (e) => {
      if (e.kind === "transcript") {
        const t = e.entry;
        const tag = t.stricken ? " [STRICKEN]" : "";
        console.log(`  ${speaker(t.speaker)}: ${t.text}${tag}`);
      }
      if (e.kind === "log") console.log(`  * ${e.text}`);
    },
  });
  const hud = () => {
    const s = eng.status();
    const avg = Object.values(eng.state.jurorLeanings).reduce((a, b) => a + b, 0) / 12;
    console.log(
      `\n-- [${s.phase}] patience ${bar(eng.state.judgePatience / 100)} ${eng.state.judgePatience} | jury guilty ${bar(avg)} ${avg.toFixed(2)} | reads ${s.readsLeft} | obj ${s.objectionsLeft} | qLeft ${s.questionsLeftForThisWitness} --`,
    );
  };
  const reactions = () =>
    console.log("   jury: " + caseFile.jurors.map((j) => `${j.id}${eng.state.jurorReactions[j.id]}${Math.round(eng.state.jurorLeanings[j.id] * 100)}`).join(" "));

  console.log(`\n===== ${caseFile.caseTitle.toUpperCase()} =====`);
  console.log(`Charge: ${caseFile.charge}\nYou are the defense. You did not prepare. Good luck.\n`);

  await eng.setupPriors();
  hud();
  reactions();

  const opening = await askLine(`\nOPENING (blind, ≤${CONFIG.MAX_WORDS_OPENING} words)\n> `);
  await eng.submitOpening(opening || "...");
  hud();
  reactions();

  // Prosecution witnesses
  for (const w of caseFile.witnesses.filter((x) => x.calledBy === "prosecution")) {
    side.current = "prosecution";
    await doRead(eng, caseFile.documents, w.id, `prosecution witness ${w.name} (${w.role})`);
    for (let i = 0; i < CONFIG.PROSECUTION_DIRECT_QS; i++) {
      if (eng.state.outcome) break;
      const h = await eng.beginProsecutorQuestion({ witnessId: w.id });
      console.log(`\n  PROSECUTOR: ${h.text}`);
      const grounds = await objectionWindow();
      const r = await eng.resolveObjectionWindow(h, grounds);
      if (r.stricken) console.log("  >> SUSTAINED — jury will disregard.");
      hud();
      reactions();
      if (r.mistrial) break;
    }
    if (eng.state.outcome) break;
    side.current = "defense";
    console.log(`\n--- YOUR CROSS of ${w.name} (3 questions, "pass" waives one) ---`);
    for (let i = 0; i < CONFIG.DEFENSE_QS; i++) {
      if (eng.state.outcome) break;
      const q = await askLine(`Q${i + 1}> `);
      const r = await eng.askDefenseQuestion({ witnessId: w.id, text: q.trim() || "No further questions." });
      hud();
      reactions();
      if (r.mistrial) break;
    }
    if (eng.state.outcome) break;
  }

  // Defense witnesses
  for (let n = 0; n < 2; n++) {
    if (eng.state.outcome) break;
    side.current = "defense";
    console.log("\n--- CALL A DEFENSE WITNESS ---");
    for (const w of caseFile.witnesses.filter((x) => x.calledBy === "defense")) {
      const called = eng.state.defenseWitnessesCalled.includes(w.id) ? " (testified)" : "";
      console.log(`  ${w.id}: ${w.name} — ${w.role}${called}`);
    }
    let wid = "" as WitnessId;
    while (true) {
      const pick = (await askLine("Call> ")).trim().toUpperCase();
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
    console.log(`\n--- YOUR DIRECT of ${w.name} (3 questions) ---`);
    for (let i = 0; i < CONFIG.DEFENSE_QS; i++) {
      if (eng.state.outcome) break;
      const q = await askLine(`Q${i + 1}> `);
      await eng.askDefenseQuestion({ witnessId: wid, text: q.trim() || "No further questions." });
      hud();
      reactions();
    }
    if (eng.state.outcome) break;
    side.current = "prosecution";
    console.log(`\n--- PROSECUTOR'S CROSS of ${w.name} (objection window is live) ---`);
    const cross = await llm.prosecutorCross({
      prosecutorName: caseFile.prosecutor.name, persona: caseFile.prosecutor.persona, witness: w, transcript: "", n: 2,
    });
    for (const q of cross) {
      if (eng.state.outcome) break;
      const h = await eng.beginProsecutorQuestion({ witnessId: wid, text: q });
      console.log(`\n  PROSECUTOR: ${h.text}`);
      const grounds = await objectionWindow();
      await eng.resolveObjectionWindow(h, grounds);
      hud();
      reactions();
    }
  }

  if (!eng.state.outcome) {
    await doRead(eng, caseFile.documents, null, "final read before closing");
    const closing = await askLine(`\nCLOSING (≤${CONFIG.MAX_WORDS_CLOSING} words)\n> `);
    await eng.submitClosing(closing || "...");
    hud();
    console.log("\n--- DELIBERATION ---");
    const outcome = await eng.deliberate();
    reactions();
    console.log(`\n===== VERDICT: ${label(outcome)} =====`);
    console.log(outcome === "not_guilty" ? "You magnificent unprepared genius." : outcome === "guilty" ? "Disbarment speedrun." : "Transferred to another lawyer at the firm.");
  } else {
    console.log(`\n===== TRIAL ENDED: ${label(eng.state.outcome)} =====`);
  }
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

async function doRead(eng: TrialEngine, docs: { id: string; bin: string; title: string; body: string }[], _wid: string | null, why: string) {
  console.log(`\n--- EVIDENCE BIN (${why}) — pick one, ${READ_SECONDS}s on the clock ---`);
  for (const d of docs) {
    const read = eng.state.docsRead.includes(d.id) ? " [READ]" : "";
    console.log(`  ${d.id}: ${d.bin} — ${d.title}${read}`);
  }
  let doc = docs[0];
  while (true) {
    const pick = (await askLine("Read> ")).trim().toUpperCase();
    const found = docs.find((d) => d.id === pick);
    if (found) {
      doc = found;
      break;
    }
    if (!TTY) break; // piped stdin exhausted — take the first
    console.log("  (pick a doc id)");
  }
  console.log(`\n===== ${doc.bin} — ${doc.title} =====\n${doc.body}\n`);
  // Speed read: the clock runs, no input consumed (keeps readline's buffer clean).
  for (let i = READ_SECONDS; i > 0; i--) {
    outStream.write(`\r  ${i}s...   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  outStream.write("\r                              \r");
  await eng.readDoc(doc.id);
  console.log("  (put it back.)");
}

/** P1-2 objection window: TTY gets OBJECTION_MS to press "o", then a grounds picker. */
async function objectionWindow(): Promise<"leading" | "hearsay" | "relevance" | "speculation" | "argumentative" | "badgering" | "assumes_facts" | "compound" | null> {
  if (!TTY) return null;
  outStream.write(`  OBJECTION? press [o] within ${OBJECTION_MS / 1000}s... `);
  const pressed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve(false);
    }, OBJECTION_MS);
    const onData = (d: Buffer) => {
      if (d.toString().toLowerCase().includes("o")) {
        clearTimeout(t);
        cleanup();
        resolve(true);
      }
    };
    const cleanup = () => {
      if (inStream.isRaw) {
        try {
          inStream.setRawMode(false);
        } catch { /* noop */ }
      }
      inStream.removeListener("data", onData);
      inStream.pause();
    };
    try {
      inStream.setRawMode(true);
    } catch { /* noop */ }
    inStream.resume();
    inStream.on("data", onData);
  });
  outStream.write("\n");
  if (!pressed) return null;
  try {
    inStream.setRawMode(false);
  } catch { /* noop */ }
  const g = (await askLine("  grounds (leading/hearsay/relevance/speculation/argumentative/badgering/assumes_facts/compound)> ")).trim();
  const valid = ["leading", "hearsay", "relevance", "speculation", "argumentative", "badgering", "assumes_facts", "compound"] as const;
  return (valid as readonly string[]).includes(g) ? (g as (typeof valid)[number]) : "relevance";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
