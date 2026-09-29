import { describe, it, expect } from "vitest";
import { askLine, waitObjectionKey, __feedForTest, __resetForTest } from "../scripts/input.js";

// Review 02 P0-1: one stdin owner. Feed chunks, assert lines + window discard.
describe("terminal input owner", () => {
  it("buffers early input and splits it into lines", async () => {
    __resetForTest();
    __feedForTest("hello\nworld\n"); // whole file arrives in one chunk
    await expect(askLine("")).resolves.toBe("hello");
    await expect(askLine("")).resolves.toBe("world");
  });

  it("objection window swallows keystrokes; buffer cleared on close", async () => {
    __resetForTest();
    const win = waitObjectionKey(50, { tty: true });
    __feedForTest("xyz\njunk line\n");
    await expect(win).resolves.toBe(false); // no "o", timeout; junk discarded
    const p = askLine("");
    __feedForTest("next\n");
    await expect(p).resolves.toBe("next"); // not "junk line"
  });

  it("objection window resolves true on 'o'", async () => {
    __resetForTest();
    const win = waitObjectionKey(1000, { tty: true });
    __feedForTest("o");
    await expect(win).resolves.toBe(true);
    const p = askLine("");
    __feedForTest("after\n");
    await expect(p).resolves.toBe("after"); // the 'o' itself was swallowed
  });

  it("non-TTY resolves false immediately", async () => {
    __resetForTest();
    // isTTY is falsy under vitest — exercises the headless path.
    await expect(waitObjectionKey(5000)).resolves.toBe(false);
  });
});
