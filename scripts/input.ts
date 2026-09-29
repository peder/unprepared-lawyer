// Single stdin owner for scripts/play.ts (Review 02 P0-1).
// One persistent 'data' listener, one buffer. Never pause()s mid-game.
// Modes: "line" (askLine resolves on newline) or "objection" (key 'o'
// resolves the window; EVERYTHING received during the window is discarded
// when it closes, so window keystrokes never leak into the next prompt).
import { stdin as inStream, stdout as outStream } from "process";

export type InputMode = "line" | "objection";

let buffer = "";
let lineWaiter: ((line: string) => void) | null = null;
let objectionWaiter: ((pressed: boolean) => void) | null = null;
let mode: InputMode = "line";
let stdinEnded = false;

inStream.on("data", (d: Buffer) => {
  const text = d.toString("utf8");
  if (mode === "objection") {
    if (text.toLowerCase().includes("o") && objectionWaiter) {
      const w = objectionWaiter;
      objectionWaiter = null;
      w(true);
    }
    // else: swallowed — discarded on close (never enters `buffer`)
    return;
  }
  buffer += text;
  pump();
});
inStream.on("end", () => {
  stdinEnded = true;
  pump();
});

function pump() {
  if (!lineWaiter || mode !== "line") return;
  const idx = buffer.indexOf("\n");
  if (idx >= 0) {
    const w = lineWaiter;
    lineWaiter = null;
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    w(line);
  } else if (stdinEnded) {
    const w = lineWaiter;
    lineWaiter = null;
    const line = buffer;
    buffer = "";
    w(line);
  }
}

export function askLine(prompt: string): Promise<string> {
  if (inStream.isTTY) {
    try {
      inStream.setRawMode(false);
    } catch { /* noop */ }
  }
  outStream.write(prompt);
  inStream.resume();
  mode = "line";
  return new Promise((resolve) => {
    lineWaiter = resolve;
    pump();
  });
}

/**
 * Objection window: TTY waits up to ms for an "o" keypress (raw mode);
 * non-TTY resolves false immediately. On close, the buffer is cleared so
 * window-time input can never leak into the next askLine.
 */
export function waitObjectionKey(ms: number, opts?: { tty?: boolean }): Promise<boolean> {
  const tty = opts?.tty ?? inStream.isTTY === true;
  mode = "objection";
  if (!tty) {
    closeObjectionMode();
    return Promise.resolve(false);
  }
  try {
    inStream.setRawMode(true);
  } catch { /* noop */ }
  inStream.resume();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      objectionWaiter = null;
      closeObjectionMode();
      resolve(false);
    }, ms);
    objectionWaiter = (pressed: boolean) => {
      clearTimeout(t);
      closeObjectionMode();
      resolve(pressed);
    };
  });
}

function closeObjectionMode() {
  buffer = ""; // discard everything typed during the window (P0-1)
  mode = "line";
  if (inStream.isTTY) {
    try {
      inStream.setRawMode(false);
    } catch { /* noop */ }
  }
  inStream.resume();
  pump();
}

/** Test hook: feed bytes as if typed. */
export function __feedForTest(text: string) {
  inStream.emit("data", Buffer.from(text));
}

/** Test hook: reset module state. */
export function __resetForTest() {
  buffer = "";
  lineWaiter = null;
  objectionWaiter = null;
  mode = "line";
  stdinEnded = false;
}
