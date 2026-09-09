/// The terminal's type size: the size gavin ships at, the ladder both
/// settings panels offer, and the fallback chain that turns a workspace's
/// choice and the app-wide one into the number a terminal renders at.
///
/// Pure and separate from settings.ts because three different callers need
/// pieces of it -- the registry needs the resolution, both panels need the
/// ladder -- and none of them should be able to disagree about the default.

/// What a terminal renders at when nothing has been chosen.
///
/// xterm's own default is 15, which is what gavin ran at until this
/// existed. Beside gavin's 0.85em chrome that reads oversized, and it costs
/// a pane several columns -- enough that a two-pane split stops fitting an
/// 80-column program. 13 is a size the app's other monospace surfaces
/// already sit near; anyone who wants 15 back sets it in Settings.
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

/// The range a stored value has to fall in to be believed. Not a spinner's
/// convenience limit: `fontSize` goes straight into xterm's metrics, and a
/// hand-edited config.json carrying 0 or 2000 would produce a terminal with
/// no usable rows at all rather than a small or large one.
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;

/// The sizes offered as picks. A ladder rather than every integer in the
/// range: the steps that matter are all at the small end, where one pixel
/// is a visible change, and nobody chooses 27 over 26 deliberately. A
/// hand-edited config.json may still say 27 -- `normalizeTerminalFontSize`
/// accepts anything inside the range, and the panels show it.
export const TERMINAL_FONT_SIZES = [9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const;

/// A usable font size, or null for "nothing chosen here" -- which is what
/// both an absent value and an unusable one mean. Null rather than the
/// default so the caller can still fall through to the next level: a
/// workspace with no size of its own must land on the app-wide setting,
/// not jump straight past it to 13.
export function normalizeTerminalFontSize(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_TERMINAL_FONT_SIZE || rounded > MAX_TERMINAL_FONT_SIZE) return null;
  return rounded;
}

/// The size a terminal in this workspace renders at: the workspace's own
/// choice, else the app-wide default, else gavin's. Expressed once so the
/// pane, the global panel's "Default (n)" label and the workspace panel's
/// can never disagree about what "inheriting" currently means.
export function resolveTerminalFontSize(
  workspaceSize: unknown,
  appSize: unknown
): number {
  return (
    normalizeTerminalFontSize(workspaceSize) ??
    normalizeTerminalFontSize(appSize) ??
    DEFAULT_TERMINAL_FONT_SIZE
  );
}

export interface FontSizeOption {
  value: string;
  label: string;
}

/// The rows a size picker renders: inherit, then the ladder, plus the
/// stored value when it is off the ladder. The inherit row is labelled
/// with the size it inherits, following the model picker's rule -- a panel
/// never shows a box whose selected row is secretly doing something.
///
/// `value` is a string because that is what a `<select>` hands back; "" is
/// the inherit row, and every writer reads it as "clear my override".
export function fontSizeOptions(inherited: number, current?: unknown): FontSizeOption[] {
  const chosen = normalizeTerminalFontSize(current);
  const ladder = [...TERMINAL_FONT_SIZES] as number[];
  // A size typed into config.json by hand is a real choice; dropping it
  // from the list would silently re-select something else the moment the
  // panel opened.
  if (chosen !== null && !ladder.includes(chosen)) {
    ladder.push(chosen);
    ladder.sort((a, b) => a - b);
  }
  return [
    { value: "", label: `Default (${inherited})` },
    ...ladder.map((size) => ({ value: String(size), label: `${size}` })),
  ];
}
