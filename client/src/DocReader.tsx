import React, { useEffect, useRef, useState } from "react";
import type { CaseDocument } from "@shared/types.js";

export const READ_SECONDS = 30;

// Blue-pen margin scribbles keyed by doc — the player's only notes (spec §20: no notepad).
const MARGIN_NOTES: Record<string, string[]> = {
  D01: ["forklift @ 3:12??", "goose looked 'guilty'?? sure", "warm = sat, not stole?"],
  D02: ["cameras OUT 3:00–3:20!", "sad HONK 3:13 = innocent?", "corn dog?? irrelevant"],
  D03: ["seeds → POND, not nest!!", "ducks acting shifty…", "vending machine ate $1"],
  D04: ["nothing here??", "why is this even in the box"],
};

function fmt(s: number) {
  return `00:${String(Math.max(0, s)).padStart(2, "0")}`;
}

export default function DocReader({
  doc,
  docsRead,
  onClose,
}: {
  doc: CaseDocument;
  docsRead: number;
  onClose: () => void;
}) {
  const [left, setLeft] = useState(READ_SECONDS);
  const paperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) onClose();
  }, [left, onClose]);

  const notes = MARGIN_NOTES[doc.id] ?? [];

  return (
    <div className="doc-overlay">
      <div className="doc-topbar bevel">
        <span>
          {doc.bin} ——— {doc.title.toUpperCase()}
        </span>
        <span className={`speed-timer${left <= 10 ? " urgent" : ""}`}>
          SPEED READING <b>{fmt(left)}</b>
        </span>
      </div>

      <div className="paper-wrap">
        <div className="paper" ref={paperRef}>
          <div className="clip">📎</div>
          <div className="stamp">FILED</div>
          <div className="paper-head">
            <div>{doc.bin.toUpperCase()} — EVIDENCE DOCUMENT {doc.id}</div>
            <h2>{doc.title}</h2>
          </div>
          {doc.body.split("\n").map((p, i) => (
            <React.Fragment key={i}>
              <p>{p}</p>
              {notes[i] && <div className="margin-note">↗ {notes[i]}</div>}
            </React.Fragment>
          ))}
          {notes.length > doc.body.split("\n").length && (
            <div className="margin-note">↗ {notes[notes.length - 1]}</div>
          )}
          <div className="coffee-ring" />
        </div>
      </div>

      <div className="doc-bottombar bevel">
        <button
          className="btn"
          onClick={() => paperRef.current?.scrollBy({ top: 220, behavior: "smooth" })}
        >
          ⬇ SCROLL DOWN
        </button>
        <span className="doc-count">DOCUMENTS READ: {docsRead} of 5</span>
        <button className="btn" onClick={onClose}>
          📁 PUT IT BACK
        </button>
      </div>
    </div>
  );
}
