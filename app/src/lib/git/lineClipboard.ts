// Cut and copy the caret's LINE when nothing is selected -- the editor
// gesture every code editor has (⌘X/⌘C on an empty selection takes the
// whole line) brought to the app's plain text fields.
//
// The file editor already had it: CodeMirror's own copy/cut handler
// falls back to a line-wise range when every selection range is empty.
// Everything else in the app -- the compose modal's title and body, the
// commit box, the wizard's PRD step, every dialog field -- is a bare
// <input>/<textarea>, where an empty selection means the keystroke does
// nothing at all. This module closes that gap.
//
// It hangs off the copy/cut EVENTS, not off a keydown chord, and that is
// forced rather than chosen. Tauri gives macOS a default Edit menu, and
// a probe against real WKWebView showed its Copy/Cut items validate as
// ENABLED even with a collapsed caret -- so the menu's key equivalent
// consumes ⌘C/⌘X in NSApplication.sendEvent and the page's keydown never
// fires. The same probe showed the resulting copy:/cut: action DOES
// dispatch a cancellable DOM event with a writable clipboardData. The
// event is also the wider seam: it catches the context menu and the Edit
// menu itself, and needs no per-platform chord table.

/// Just the parts of an <input>/<textarea> this layer touches. A real
/// element satisfies it structurally; tests build one by hand, which is
/// why none of this needs a DOM (the suite runs under node, with no
/// jsdom -- same reason keyboard.ts duck-types its key event).
export interface LineTextField {
  tagName?: string;
  type?: string;
  value: string;
  readOnly?: boolean;
  disabled?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  setSelectionRange(start: number, end: number): void;
  setRangeText(replacement: string, start: number, end: number, mode: string): void;
  dispatchEvent(event: unknown): unknown;
  closest?(selector: string): unknown;
}

/// The parts of a ClipboardEvent this layer reads.
export interface LineClipboardEvent {
  type: string;
  target?: EventTarget | null;
  defaultPrevented?: boolean;
  clipboardData?: { setData(format: string, data: string): void } | null;
  preventDefault(): void;
}

/// The <input> types whose selection API is defined. Reading
/// `selectionStart` on any other one (number, color, checkbox -- this app
/// ships all three) throws InvalidStateError, so the list is a whitelist
/// rather than a blacklist of the ones that break. `password` is left out
/// deliberately: a field the human cannot read is not one to put on the
/// clipboard behind a keystroke that looks like a no-op.
const SELECTABLE_INPUT_TYPES = new Set(["", "text", "search", "url", "tel"]);

export interface LineField {
  /// Lines here end in a break, so the clipboard payload carries one.
  multiline: boolean;
  /// A read-only field still copies; it just never gives up the line.
  editable: boolean;
}

/// Classifies an event target, or null when the line gesture has no
/// business there.
export function lineFieldFor(target: EventTarget | null | undefined): LineField | null {
  const el = target as
    | { tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean; closest?: (s: string) => unknown }
    | null
    | undefined;
  if (!el || typeof el !== "object") return null;
  // xterm focuses a hidden <textarea> and answers the copy event itself
  // with the terminal's own selection. Ours would overwrite that with
  // the helper's (empty) value.
  if (el.closest?.(".xterm")) return null;
  const editable = el.readOnly !== true && el.disabled !== true;
  if (el.tagName === "TEXTAREA") return { multiline: true, editable };
  if (el.tagName === "INPUT" && SELECTABLE_INPUT_TYPES.has((el.type ?? "").toLowerCase())) {
    return { multiline: false, editable };
  }
  // A contenteditable is deliberately absent: the only one in the app is
  // CodeMirror's, which already does this and does it better (it pairs a
  // line-wise copy with a line-wise paste).
  return null;
}

export interface LinePlan {
  /// What goes on the clipboard.
  text: string;
  /// Half-open range to remove, for a cut on an editable field. Null for
  /// a copy, and null when there is nothing to take.
  remove: { from: number; to: number } | null;
}

/// The caret's line as a half-open [from, to) range, the break excluded.
export function lineBoundsAt(value: string, caret: number): { from: number; to: number } {
  const pos = Math.min(Math.max(caret, 0), value.length);
  // The caret-at-0 case cannot go through lastIndexOf: a negative
  // fromIndex is clamped to 0, so a value that STARTS with a break would
  // report that break as the line's end and put `from` past the caret.
  const from = pos === 0 ? 0 : value.lastIndexOf("\n", pos - 1) + 1;
  const next = value.indexOf("\n", pos);
  return { from, to: next < 0 ? value.length : next };
}

/// The transform, pure over (value, caret). `op` is the event's type.
export function planLineClipboard(
  value: string,
  caret: number,
  op: string,
  field: LineField
): LinePlan | null {
  const { from, to } = lineBoundsAt(value, caret);
  // An empty single-line field has no line to take, and clobbering the
  // clipboard with "" is worse than leaving the keystroke inert.
  if (!field.multiline && from === to) return null;
  // A whole line goes to the clipboard WITH its break, so that cutting a
  // line and pasting it back restores it instead of joining two lines.
  // (CodeMirror omits the break and compensates with an internal
  // line-wise paste flag; a plain <textarea> has no such memory.)
  const text = field.multiline ? `${value.slice(from, to)}\n` : value.slice(from, to);
  if (op !== "cut" || !field.editable) return { text, remove: null };
  // Removing the line means removing a break with it, or the cut would
  // leave a blank line behind. The line's own trailing break normally;
  // the PRECEDING one on the last line, which has none of its own.
  if (to < value.length) return { text, remove: { from, to: to + 1 } };
  if (from > 0) return { text, remove: { from: from - 1, to } };
  return { text, remove: { from, to } };
}

/// Deletes [from, to) from a live field. execCommand first: it is the one
/// route that keeps the field's native undo stack intact and fires the
/// single `input` event Svelte's bind:value listens for. Verified against
/// real WKWebView -- a cut line comes back with ⌘Z. The manual path is
/// the fallback for when it is refused (it returns false, or silently
/// does nothing).
function removeRange(el: LineTextField, from: number, to: number): void {
  if (from >= to) return;
  const before = el.value;
  el.setSelectionRange(from, to);
  let deleted = false;
  try {
    deleted = typeof document !== "undefined" && document.execCommand("delete");
  } catch {
    deleted = false;
  }
  if (deleted && el.value !== before) return;
  el.setRangeText("", from, to, "end");
  // setRangeText does not fire `input` on its own, and without one every
  // bind:value in the app keeps the pre-cut string.
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/// Handles one copy/cut event. Returns whether the line gesture claimed
/// it. Exported for tests; the listener below is the only production
/// caller.
export function handleLineClipboard(event: LineClipboardEvent): boolean {
  // Something nearer the target already answered -- CodeMirror on its own
  // content, xterm on the terminal's selection. Never overwrite that.
  if (event.defaultPrevented) return false;
  if (event.type !== "copy" && event.type !== "cut") return false;
  const field = lineFieldFor(event.target);
  if (!field) return false;
  const el = event.target as unknown as LineTextField;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  // A real selection is the browser's to copy, exactly as it always was.
  // The line gesture only ever fills the gap where the selection is
  // empty and the keystroke would otherwise do nothing.
  if (typeof start !== "number" || typeof end !== "number" || start !== end) return false;
  const plan = planLineClipboard(el.value, start, event.type, field);
  if (!plan) return false;
  const data = event.clipboardData;
  // No clipboardData means no way to write the line; leaving the native
  // path alone beats consuming the event and dropping the text.
  if (!data) return false;
  data.setData("text/plain", plan.text);
  event.preventDefault();
  if (plan.remove) removeRange(el, plan.remove.from, plan.remove.to);
  return true;
}

export function installLineClipboard(): () => void {
  // Bubble phase, not capture -- the opposite of installKeyboardShortcuts,
  // and for the opposite reason. Both CodeMirror and xterm answer these
  // events on their own nodes without stopping propagation, so running
  // after them means `defaultPrevented` already says to stand down.
  const listener = (event: Event) => {
    handleLineClipboard(event as unknown as LineClipboardEvent);
  };
  window.addEventListener("copy", listener);
  window.addEventListener("cut", listener);
  return () => {
    window.removeEventListener("copy", listener);
    window.removeEventListener("cut", listener);
  };
}
