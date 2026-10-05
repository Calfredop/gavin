// What typing on a phone sends into a terminal: a line from the compose
// field, a quick reply, and the keys a soft keyboard does not have.
//
// Everything here answers in BYTES, the ones `write_input` hands the PTY,
// because that is the only place the difference between two ways of
// sending the same word shows. The rules are ticket 01's findings (the
// typing bench, `companion.md`'s comments): a line goes as a paste and
// then Enter, a menu takes a bare key, and an arrow is whatever the
// program on the other end asked arrows to be.

const ESC = "\x1b";
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;

/// What the program in the terminal has asked of its input, as xterm read
/// it off the output (`term.modes`). A snapshot of the session carries
/// both, so a terminal the phone has only just opened already knows.
export interface InputModes {
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
}

export const PLAIN_MODES: InputModes = { bracketedPasteMode: false, applicationCursorKeysMode: false };

/// Text as xterm's own `paste()` hands it over: newlines become carriage
/// returns, and the text is wrapped in the paste markers only while the
/// program has switched bracketed paste on. The condition is the whole
/// point. An agent's input box turns it on and reads the markers; a
/// cooked-mode `(y/n)` prompt does not, and would take them as literal
/// `^[[200~y^[[201~`. An ESC inside the text is defused the way xterm
/// defuses it, so a pasted line cannot end the paste early.
export function pasteBytes(text: string, modes: Pick<InputModes, "bracketedPasteMode">): string {
  const body = text.replace(/\r?\n/g, "\r");
  if (!modes.bracketedPasteMode) return body;
  return `${CSI}200~${body.replace(/\x1b/g, "␛")}${CSI}201~`;
}

/// A line from the compose field: the text as a paste, then Enter. One
/// write, the envelope the desk hands an agent its follow-ups in
/// (`server.rs`'s `bracketed_paste`), except that the markers follow the
/// program's mode instead of always being there. An empty field is a
/// bare Enter, which is how the human accepts a default.
export function composeBytes(text: string, modes: Pick<InputModes, "bracketedPasteMode">): string {
  return (text === "" ? "" : pasteBytes(text, modes)) + "\r";
}

/// The keys of the raw dock, and the named keys a quick reply presses.
export type KeyId =
  | "esc"
  | "tab"
  | "enter"
  | "up"
  | "down"
  | "right"
  | "left"
  | "home"
  | "end"
  | "page-up"
  | "page-down"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-u";

/// The bytes one key sends. The cursor keys and Home/End are the ones
/// that depend on the program: with application cursor keys on (DECCKM,
/// which vim, less and most full-screen programs set) they go as `ESC O`
/// rather than `ESC [`, exactly as a keyboard at the desk would send
/// them through xterm. The snapshot a terminal opens with restores that
/// mode (`screen.rs`'s `input_mode_formatted`), which is why it can be
/// trusted here.
export function keyBytes(key: KeyId, modes: Pick<InputModes, "applicationCursorKeysMode">): string {
  const cursor = modes.applicationCursorKeysMode ? SS3 : CSI;
  switch (key) {
    case "esc":
      return ESC;
    case "tab":
      return "\t";
    case "enter":
      return "\r";
    case "up":
      return `${cursor}A`;
    case "down":
      return `${cursor}B`;
    case "right":
      return `${cursor}C`;
    case "left":
      return `${cursor}D`;
    case "home":
      return `${cursor}H`;
    case "end":
      return `${cursor}F`;
    case "page-up":
      return `${CSI}5~`;
    case "page-down":
      return `${CSI}6~`;
    case "ctrl-c":
      return "\x03";
    case "ctrl-d":
      return "\x04";
    case "ctrl-l":
      return "\x0c";
    case "ctrl-u":
      return "\x15";
  }
}

/// A character typed with Ctrl held, or null for one Ctrl does nothing
/// to. The terminal's own table: `@`, the letters and `[\]^_` fold onto
/// 0x00-0x1f, space is NUL, `?` is DEL.
export function withCtrl(ch: string): string | null {
  if (ch === " ") return "\x00";
  if (ch === "?") return "\x7f";
  if (ch.length !== 1) return null;
  const code = ch.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : null;
}

/// What the soft keyboard typed, through the dock's sticky Ctrl.
///
/// A phone has no Ctrl key, so the dock's is a latch: armed by a tap, it
/// takes the NEXT character and lets go. A character Ctrl means nothing
/// to goes through as typed and still lets go, since the tap was for one
/// key. More than one character at once is the keyboard's own doing --
/// a predicted word, an accepted autocorrection -- and is not the key
/// the human meant, so it goes through and the latch stays armed.
export function typedThrough(data: string, ctrlArmed: boolean): { bytes: string; ctrlArmed: boolean } {
  if (!ctrlArmed) return { bytes: data, ctrlArmed: false };
  if ([...data].length !== 1) return { bytes: data, ctrlArmed: true };
  return { bytes: withCtrl(data) ?? data, ctrlArmed: false };
}

/// One press of the raw dock.
export interface DockKey {
  id: KeyId;
  label: string;
  /// Spoken name, where the label is a glyph.
  name: string;
  /// Held down, it repeats: the arrows, for walking a cursor.
  repeats?: boolean;
}

/// The row that is always there: what a shell or a TUI needs most and a
/// soft keyboard lacks, in two runs with the Ctrl latch between them.
/// Return is not in it -- the keyboard has one.
export const LEAD_KEYS: readonly DockKey[] = [
  { id: "esc", label: "Esc", name: "Escape" },
  { id: "tab", label: "Tab", name: "Tab" },
];

export const ARROW_KEYS: readonly DockKey[] = [
  { id: "left", label: "←", name: "Left arrow", repeats: true },
  { id: "up", label: "↑", name: "Up arrow", repeats: true },
  { id: "down", label: "↓", name: "Down arrow", repeats: true },
  { id: "right", label: "→", name: "Right arrow", repeats: true },
];

/// The row behind More.
export const MORE_KEYS: readonly DockKey[] = [
  { id: "ctrl-c", label: "^C", name: "Control C" },
  { id: "ctrl-d", label: "^D", name: "Control D" },
  { id: "ctrl-l", label: "^L", name: "Control L" },
  { id: "ctrl-u", label: "^U", name: "Control U" },
  { id: "home", label: "Home", name: "Home" },
  { id: "end", label: "End", name: "End" },
  { id: "page-up", label: "PgUp", name: "Page up" },
  { id: "page-down", label: "PgDn", name: "Page down" },
  { id: "enter", label: "↵", name: "Return" },
];

/// Symbols the iOS keyboard keeps two pages deep, typed as characters.
export const MORE_SYMBOLS: readonly string[] = ["|", "~", "/", "-", "_", "."];

/// The two raw keys someone composing still needs, pinned beside the
/// quick replies: out of a menu, and stop what is running.
export const PINNED_KEYS: readonly DockKey[] = [
  { id: "esc", label: "Esc", name: "Escape" },
  { id: "ctrl-c", label: "^C", name: "Control C" },
];
