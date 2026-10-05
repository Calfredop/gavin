// What each way of typing on a phone sends, byte for byte.
import { describe, expect, it } from "vitest";
import {
  ARROW_KEYS,
  composeBytes,
  keyBytes,
  LEAD_KEYS,
  MORE_KEYS,
  pasteBytes,
  PINNED_KEYS,
  PLAIN_MODES,
  typedThrough,
  withCtrl,
  type KeyId,
} from "$companion/surfaces/terminalInput";

const PASTE_ON = { bracketedPasteMode: true, applicationCursorKeysMode: false };
const APP_CURSOR = { bracketedPasteMode: false, applicationCursorKeysMode: true };

describe("a line from the compose field", () => {
  it("is the text and Enter, to a program that reads lines", () => {
    // A cooked-mode prompt -- `(y/n)` -- has not asked for paste markers,
    // and would read them as text.
    expect(composeBytes("y", PLAIN_MODES)).toBe("y\r");
  });

  it("is the text as a paste and Enter, to a program that asked for pastes", () => {
    // An agent's input box: the markers keep the text text, and the Enter
    // after them is the one that sends.
    expect(composeBytes("use Postgres", PASTE_ON)).toBe("\x1b[200~use Postgres\x1b[201~\r");
  });

  it("is a bare Enter when the field is empty, which is how a default is taken", () => {
    expect(composeBytes("", PLAIN_MODES)).toBe("\r");
    expect(composeBytes("", PASTE_ON)).toBe("\r");
  });

  it("keeps its lines as a terminal paste does: carriage returns, inside the one paste", () => {
    expect(composeBytes("first\nsecond\r\nthird", PASTE_ON)).toBe("\x1b[200~first\rsecond\rthird\x1b[201~\r");
  });

  it("cannot end the paste early with an escape of its own", () => {
    expect(pasteBytes("a\x1b[201~b", PASTE_ON)).toBe("\x1b[200~a␛[201~b\x1b[201~");
    // Nothing to defend where there are no markers.
    expect(pasteBytes("a\x1bb", PLAIN_MODES)).toBe("a\x1bb");
  });
});

describe("a key from the dock", () => {
  it.each<[KeyId, string]>([
    ["esc", "\x1b"],
    ["tab", "\t"],
    ["enter", "\r"],
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["right", "\x1b[C"],
    ["left", "\x1b[D"],
    ["home", "\x1b[H"],
    ["end", "\x1b[F"],
    ["page-up", "\x1b[5~"],
    ["page-down", "\x1b[6~"],
    ["ctrl-c", "\x03"],
    ["ctrl-d", "\x04"],
    ["ctrl-l", "\x0c"],
    ["ctrl-u", "\x15"],
  ])("%s sends what a keyboard at the desk sends", (key, bytes) => {
    expect(keyBytes(key, PLAIN_MODES)).toBe(bytes);
  });

  it.each<[KeyId, string]>([
    ["up", "\x1bOA"],
    ["down", "\x1bOB"],
    ["right", "\x1bOC"],
    ["left", "\x1bOD"],
    ["home", "\x1bOH"],
    ["end", "\x1bOF"],
  ])("%s follows the program into application cursor mode", (key, bytes) => {
    expect(keyBytes(key, APP_CURSOR)).toBe(bytes);
  });

  it("is the same in application cursor mode for every key that is not a cursor key", () => {
    for (const key of ["esc", "tab", "enter", "page-up", "page-down", "ctrl-c"] as KeyId[]) {
      expect(keyBytes(key, APP_CURSOR)).toBe(keyBytes(key, PLAIN_MODES));
    }
  });

  it("covers every key the dock draws", () => {
    const drawn = [...LEAD_KEYS, ...ARROW_KEYS, ...MORE_KEYS, ...PINNED_KEYS];
    for (const key of drawn) expect(keyBytes(key.id, PLAIN_MODES), key.label).not.toBe("");
    // Esc and ^C are pinned beside the replies, for someone composing.
    expect(PINNED_KEYS.map((k) => k.id)).toEqual(["esc", "ctrl-c"]);
  });

  it("repeats when held only for the arrows", () => {
    expect(ARROW_KEYS.every((k) => k.repeats)).toBe(true);
    expect([...LEAD_KEYS, ...MORE_KEYS].some((k) => k.repeats)).toBe(false);
  });
});

describe("Ctrl, latched", () => {
  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["d", "\x04"],
    ["r", "\x12"],
    ["[", "\x1b"],
    ["@", "\x00"],
    [" ", "\x00"],
    ["?", "\x7f"],
    ["_", "\x1f"],
  ])("turns %j into its control code", (ch, code) => {
    expect(withCtrl(ch)).toBe(code);
  });

  it("means nothing to a digit or a word", () => {
    expect(withCtrl("1")).toBeNull();
    expect(withCtrl("ab")).toBeNull();
  });

  it("takes the next character and lets go", () => {
    expect(typedThrough("c", true)).toEqual({ bytes: "\x03", ctrlArmed: false });
    expect(typedThrough("c", false)).toEqual({ bytes: "c", ctrlArmed: false });
  });

  it("lets a character it means nothing to through, and still lets go", () => {
    expect(typedThrough("1", true)).toEqual({ bytes: "1", ctrlArmed: false });
  });

  it("stays armed through the keyboard's own words, which are not the key meant", () => {
    expect(typedThrough("hello ", true)).toEqual({ bytes: "hello ", ctrlArmed: true });
  });
});
