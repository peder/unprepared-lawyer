# UI Mockup Prompt (from art agent) — locked as art direction v0.1

A pixel-art UI mockup for a comedy courtroom video game, styled like an early-1990s
DOS/Amiga sports management simulation: 256-color VGA palette, chunky 2x-scaled pixels,
visible dithering, beveled gray-brown interface panels with hard 1px highlight and shadow
edges, bitmap sans-serif UI type.

SETTING: a 1970s American courtroom rendered in pixel art. Dark walnut wood paneling on
every wall, mustard-yellow and burnt-orange accents, drop-ceiling fluorescent panels, a
haze of cigarette smoke drifting through the room, ashtrays on the tables, a wilting
potted plant in the corner, an American flag on a pole.

LAYOUT (single 16:9 screen, dense HUD framing a central scene):

- CENTER: the witness stand and the defense table, viewed straight-on. A rumpled,
  bleary-eyed defense lawyer in a slightly-too-large brown suit stands at the podium,
  coffee cup in hand, sweating. A witness sits in the box under a small spotlight.
  A speech box at the bottom of the center panel shows the witness's dialogue in bitmap
  text with a small portrait bust beside it.

- TOP CENTER: the judge's bench raised above the scene. An older pixel-art judge in black
  robes with reading glasses. Directly beneath him a HUD readout labeled "JUDGE PATIENCE"
  as a segmented horizontal bar, currently about one third full and colored amber, with
  small labeled sub-stats beside it: STRICTNESS, WARNINGS 1/3, CONTEMPT.

- LEFT AND RIGHT COLUMNS or BOTTOM STRIP: the jury box as 12 individual pixel-art juror
  portraits in a grid, each in its own beveled frame, with a name/caption label, a small
  emotion icon, and a tiny horizontal "leaning" bar showing prosecution-vs-defense sympathy.

Notes for implementation (client/):
- VGA 256-color palette, `image-rendering: pixelated`, 2x chunk scale.
- Beveled panels: 1px highlight (#fff8 / #ffd) top-left, 1px shadow (#000a) bottom-right, gray-brown base (#6b5d4f / #4a4038).
- Bitmap type: monospace / "Perfect DOS VGA 437"-style fallback stack; uppercase labels, letter-spacing.
- HUD-first layout: judge bench top-center w/ JUDGE PATIENCE segmented bar; jury grid 12 cells w/ portrait + emoji + leaning bar; center speech box w/ portrait bust (Metal Gear-style talk bubble).
- Tony La Russa Baseball Manager feel: dense stat readouts, sub-stats (STRICTNESS, WARNINGS, CONTEMPT), everything visible at once like a command center.
