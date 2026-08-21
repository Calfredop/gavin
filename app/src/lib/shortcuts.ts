// The app's keyboard chords, as data. Pure: the platform is passed in so
// every rule here is testable without a browser or a Tauri host.
//
// Letters match on `event.key` (layout-friendly, and what this app has
// always done); digits match on `event.code` via digitFromCode, because
// under ⌘⇧ macOS reports "!" for the 1 key and under ⌘⌥ it reports "¡" --
// only the code stays stable.

export interface Chord {
  /// Lower-case KeyboardEvent.key for letters, or the digit character.
  key: string;
  shift?: boolean;
  alt?: boolean;
}

/// Just the parts of a KeyboardEvent a chord is matched against. A real
/// KeyboardEvent satisfies it structurally, so callers pass one straight
/// in while tests build a plain object.
export interface ChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ShortcutId = "new-tab" | "close-tab" | "split-right" | "split-down";

export const SHORTCUTS: Record<ShortcutId, Chord> = {
  "new-tab": { key: "t" },
  "close-tab": { key: "w" },
  "split-right": { key: "d" },
  "split-down": { key: "d", shift: true },
};

export function matchesChord(e: ChordEvent, chord: Chord, isMac: boolean): boolean {
  const cmd = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (!cmd || otherMod) return false;
  if (e.shiftKey !== Boolean(chord.shift)) return false;
  if (e.altKey !== Boolean(chord.alt)) return false;
  return e.key.toLowerCase() === chord.key.toLowerCase();
}

export function formatChord(chord: Chord, isMac: boolean): string {
  const label = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  if (isMac) {
    // Apple's canonical order: Control, Option, Shift, Command, key.
    return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}⌘${label}`;
  }
  const parts = ["Ctrl"];
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(label);
  return parts.join("+");
}

export function formatShortcut(id: ShortcutId, isMac: boolean): string {
  return formatChord(SHORTCUTS[id], isMac);
}

export function formatDigitChord(
  digit: number,
  mode: "cmd" | "cmd-shift" | "cmd-alt",
  isMac: boolean
): string {
  return formatChord({ key: String(digit), shift: mode === "cmd-shift", alt: mode === "cmd-alt" }, isMac);
}

const DIGIT_CODE = /^(?:Digit|Numpad)(\d)$/;

export function digitFromCode(code: string): number | null {
  const match = DIGIT_CODE.exec(code);
  return match ? Number(match[1]) : null;
}

/// Which item a digit selects: 1-8 by position, 9 the last, 0 the first.
/// null when nothing is there.
export function resolveIndex(digit: number, count: number): number | null {
  if (count <= 0) return null;
  if (digit === 0) return 0;
  if (digit === 9) return count - 1;
  if (digit >= 1 && digit <= 8) return digit <= count ? digit - 1 : null;
  return null;
}

/// The single badge an item shows while ⌘ is held: its primary chord.
/// Positions 1-8 show their own digit; 0 and 9 are aliases and stay
/// hidden unless 9 is the ONLY way to reach a last item past position 8.
export function hintDigitFor(index: number, count: number): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  if (index < 8) return index + 1;
  return index === count - 1 ? 9 : null;
}
