# Doc-Read Mockup — speed-reading overlay spec (v0.1)

Source: mockup image shared 2026-09-29. The 30-second document read (spec §3: 5 reads).

## Layout (full-screen overlay over dimmed courtroom)

### TOP BAR
- Left breadcrumb: `{BIN} — {TITLE}` e.g. `BOX 7 — POLICE REPORT #4471`.
- Right: `SPEED READING` seven-seg countdown `MM:SS`, amber on black, red bevel frame.
  Counts down from 00:30; at 00:00 the doc is yanked away (read slot consumed either way).

### CENTER — the document
- Close-up of a hand holding a typed report: paperclip top-left, `FILED` red stamp
  rotated ~15°, coffee-ring stain, typewriter (Courier) body text.
- Body must be skimmable-but-cluttered per spec §6.2: key facts buried mid-paragraph,
  in parentheticals/footnotes/asides; at least two docs contradict on a minor detail;
  at least two docs are red herrings.
- Blue-ballpoint handwritten margin notes (rotated, italic): hunches, arrows,
  e.g. "Check bar receipts?", "Subject left towards the old warehouse district? ↗".
  These are the player's ONLY notes — no notepad (spec §20 default).

### BOTTOM BAR
- `⬇ SCROLL DOWN` (left) — scrolls long docs; docs are 150–600 words, some overflow.
- `DOCUMENTS READ: {n} of 5` (center).
- `📁 PUT IT BACK` (right) — closes early; the 30s slot is still consumed.

## Implementation (client/src/DocReader.tsx)
- Props: doc {bin,title,body}, docsRead display count, onClose.
- 30s interval timer; auto-close at 0. Parent marks doc read on OPEN (engine.readDoc).
- Paper: aged gradient, Courier, stamp div, margin-note map keyed by doc id.
- Timer red-pulses under 00:10.
