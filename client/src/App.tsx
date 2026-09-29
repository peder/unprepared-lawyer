import React, { useState } from "react";
import "./hud.css";
import DocReader from "./DocReader.js";
import { FIXTURE_CASE } from "../../fixtures/case.fixture.js";
import type { CaseDocument } from "@shared/types.js";

// Layout per docs/chatgpt-mockup-notes.md: jury left, courtroom center,
// evidence right, witness talk box + status strip bottom.
// Evidence reads open the DocReader overlay (docs/doc-read-mockup-notes.md).
const FACES = ["🧑‍✈️", "👩‍🍳", "🧑‍🎓", "👩‍🦱", "🧑‍💼", "👱‍♀️", "😴", "🧑‍⚖️", "👵", "🤠", "👩‍🦰", "🧑‍🔬"];

interface Juror {
  id: string;
  label: string;
  face: string;
  leaning: number;
  reaction: string;
}

const LABELS = [
  "Sea Captain", "Chef", "Student", "Clerk", "Banker", "Teacher",
  "Dozer", "Skeptic", "Widow", "Rancher", "Singer", "Chemist",
];

const initialJurors: Juror[] = LABELS.map((label, i) => ({
  id: `J${i + 1}`,
  label,
  face: FACES[i],
  leaning: [0.78, 0.22, 0.64, 0.18, 0.71, 0.34, 0.12, 0.69, 0.53, 0.83, 0.48, 0.76][i],
  reaction: ["😡", "🙂", "😐", "😲", "😡", "🙂", "😴", "😐", "🙂", "😡", "😐", "😡"][i],
}));

function SegBar({ value, segments = 10 }: { value: number; segments?: number }) {
  const on = Math.round(value * segments);
  return (
    <div className="segbar" aria-label={`judge patience ${Math.round(value * 100)} percent`}>
      {Array.from({ length: segments }, (_, i) => (
        <div key={i} className={`seg${i < on ? " on" : ""}`} />
      ))}
    </div>
  );
}

function JurorCell({ j }: { j: Juror }) {
  const pct = Math.round(j.leaning * 100);
  const guilty = pct >= 50;
  return (
    <div className="juror">
      <div className="face">{j.face}</div>
      <div className="lbl">JUROR {j.id.slice(1)}</div>
      <div className="pct-row">
        <span>{pct}%</span>
        <span className="emo">{j.reaction}</span>
      </div>
      <div className="leanbar" title={`P(guilty) = ${pct}%`}>
        <div className={guilty ? "guilty" : "innocent"} style={{ width: `${guilty ? pct : 100 - pct}%` }} />
      </div>
    </div>
  );
}

export default function App() {
  const [jurors, setJurors] = useState(initialJurors);
  const [patience, setPatience] = useState(0.3);
  const [bubble, setBubble] = useState({
    name: "WITNESS:",
    text: "Well... I mean, I saw him. I'm pretty sure. It was around, like, 8:15 or 8:20. Maybe 8:17? It all happened so fast. And there was, like, a lot of cigarette smoke. I think.",
  });
  const [question, setQuestion] = useState("");
  const [questionsLeft, setQuestionsLeft] = useState(2);
  const [objections, setObjections] = useState(3);
  const [docsRead, setDocsRead] = useState<string[]>(["D01", "D02"]);
  const [openDoc, setOpenDoc] = useState<CaseDocument | null>(null);

  function drift() {
    setJurors((js) => js.map((j) => ({ ...j, leaning: Math.min(1, Math.max(0, j.leaning + (Math.random() - 0.5) * 0.08)) })));
  }

  function openEvidence(doc: CaseDocument) {
    if (docsRead.length >= 5 && !docsRead.includes(doc.id)) {
      setBubble({ name: "CLERK:", text: "That's all five reads, counselor. The bin is closed." });
      return;
    }
    if (!docsRead.includes(doc.id)) setDocsRead((d) => [...d, doc.id]); // slot consumed on open
    setOpenDoc(doc);
  }

  function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || questionsLeft <= 0) return;
    setBubble({ name: "YOU — DEFENSE:", text: question });
    setQuestion("");
    setQuestionsLeft((q) => q - 1);
    window.setTimeout(() => {
      drift();
      setPatience((p) => Math.max(0, p - 0.04));
      setBubble({ name: "WITNESS:", text: "I... don't recall. Ask the forklift guy — he was there. I think." });
    }, 700);
  }

  return (
    <div className="hud">
      <div className="main">
        {/* LEFT: jury */}
        <section className="bevel">
          <div className="panel-title">THE JURY</div>
          <div className="jury-grid">
            {jurors.map((j) => (
              <JurorCell key={j.id} j={j} />
            ))}
          </div>
        </section>

        {/* CENTER: courtroom */}
        <section className="stage bevel">
          <div className="scene">
            <div className="flag">🇺🇸</div>
            <div className="seal">🦅</div>
            <div className="judge"><div className="sprite">🧑‍⚖️</div></div>
            <div className="bench-panel">
              <div className="bench-title">JUDGE PATIENCE</div>
              <SegBar value={patience} />
              <div className="bench-sub">
                <span>STRICTNESS: <b>6/10</b></span>
                <span>WARNINGS: <b>1/3</b></span>
                <span>CONTEMPT: <b>0/10</b></span>
              </div>
            </div>
            <div className="spotlight" />
            <div className="actor lawyer"><div className="sprite">🧑‍💼</div><div className="cap">YOU ☕</div></div>
            <div className="actor witness"><div className="sprite">👨</div><div className="cap">WITNESS</div></div>
            <div className="plant">🪴</div>
          </div>

          <div className="talkbox">
            <div className="bust">👨</div>
            <div className="bubble">
              <div className="name">{bubble.name}</div>
              <div className="lines">{bubble.text}</div>
              <div className="blinker">▼</div>
            </div>
          </div>

          <form className="askrow" onSubmit={ask}>
            <span className="prompt">ASK ▸</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Type cross-examination question…"
              maxLength={200}
            />
            <button className="btn" type="submit">ASK</button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                if (objections > 0) {
                  setObjections((o) => o - 1);
                  setBubble({ name: "YOU — DEFENSE:", text: "Objection, Your Honor!" });
                }
              }}
            >
              OBJECT!
            </button>
          </form>

          <div className="status-strip">
            <div className="stat">⚖ QUESTIONS LEFT:<b> {questionsLeft} of 3</b></div>
            <div className="stat">🔨 OBJECTIONS:<b> {objections}</b></div>
            <div className="stat">📄 DOCUMENTS READ:<b> {docsRead.length} of 5</b></div>
          </div>
        </section>

        {/* RIGHT: evidence */}
        <section className="bevel evidence">
          <div className="panel-title">EVIDENCE</div>
          <div className="boxes">
            {FIXTURE_CASE.documents.map((d) => {
              const read = docsRead.includes(d.id);
              return (
                <button key={d.id} className={`ebox${read ? " read" : ""}`} onClick={() => openEvidence(d)}>
                  <div className="tape" />
                  <div className="ebox-title">{d.bin.toUpperCase()}</div>
                  <div className="ebox-sub">({d.title})</div>
                  {read && <div className="ebox-stamp">READ ✓</div>}
                </button>
              );
            })}
          </div>
          <div className="panel-title">CASE NOTES</div>
          <ul className="notes">
            <li>Witness claims she saw the defendant at 8:17 PM.</li>
            <li>Defendant says he was at the diner (receipts?).</li>
            <li>Phone records pending.</li>
            <li>Note: witness seems nervous.</li>
          </ul>
          <div className="panel-title">⏱ TIME REMAINING:</div>
          <div className="timer">{openDoc ? "READING…" : "00:30"}</div>
        </section>
      </div>

      {openDoc && (
        <DocReader doc={openDoc} docsRead={docsRead.length} onClose={() => setOpenDoc(null)} />
      )}
    </div>
  );
}
