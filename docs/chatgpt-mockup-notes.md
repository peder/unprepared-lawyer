# ChatGPT Mockup — layout spec locked for client/ (v0.1)

Source: mockup image shared 2026-09-29. Pixel-art, 1970s courtroom, VGA browns/mustard.

## Layout (16:9, three columns + bottom strip)

### LEFT — "THE JURY" (3 cols × 4 rows = 12 cells)
Each cell: pixel portrait bust, `JUROR N` label, guilt-% readout + emoji, red/green
horizontal leaning bar (red = guilty-leaning, green = defense-leaning).
Example values: J1 78% 😡, J2 22% 🙂, J7 12% 😴 (dozing!), J10 83% 😡.

### CENTER — courtroom scene
- Back wall: walnut paneling, US flag left, seal/eagle emblem center, judge's bench raised.
- Judge: older, black robes, reading glasses, hand on chin, bored.
- Bench front panel: `JUDGE PATIENCE` segmented bar (amber segments ~1/3 full),
  sub-stats row: `STRICTNESS: 6/10  WARNINGS: 1/3  CONTEMPT: 0/10`.
- Mid: rumpled defense lawyer (brown suit, red tie, coffee cup, sweat) at podium left;
  witness (blue suit, mustache) in stand right under warm spotlight cone.
- Foreground: defense table with ashtray, carafe, papers; silhouette of defendant's head.
- Fluorescent drop-ceiling panels, wilting plant right, blinds + cigarette haze.

### RIGHT — evidence column (top→bottom)
- `EVIDENCE`: stacked cardboard boxes with red tape + handwritten labels:
  `Box 7 (Files & Receipts)`, `EVIDENCE BAG 23 (Physical Evidence)`, `MISC — DO NOT OPEN`.
  (Clicking a box = the 30s doc read.)
- `CASE NOTES`: bulleted detective-style notebook (witness claims, alibis, pending items).
- `TIME REMAINING: 00:30` — amber seven-seg timer (read/question clock).

### BOTTOM CENTER — talk box + status strip
- `WITNESS:` Metal Gear-style box: portrait bust left, bitmap dialogue text, ▼ blinker.
- Status strip: `QUESTIONS LEFT: 2 of 3` | `OBJECTIONS: 3` | `DOCUMENTS READ: 2 of 5`.

## Implementation notes
- Jury cell: portrait (canvas pixel art later; emoji glyph placeholder now), label,
  `%` + reaction emoji, dual-color lean bar.
- Patience bar: N segments, amber; turns red when low; sub-stats as specified.
- Evidence boxes: CSS-drawn cardboard (tan #c9a06a, dark outline, red tape strips).
- All caps bitmap labels, 1px bevels, scanline overlay over whole screen.
