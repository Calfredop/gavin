// Markdown formatting for Edit mode: the bar over the editor and the
// ⌘B-style chords behind it. Pure string transforms over a document and
// a selection, returning CodeMirror-shaped changes plus the selection to
// hold afterwards -- so every rule is unit-tested here, in Node, and the
// editor only dispatches. NO @codemirror imports: codeMirror.ts keeps
// its runtime imports dynamic so this file can be loaded under vitest.
//
// The bar is a markdown bar, not a rich-text one: every button writes
// the markdown a human would have typed, and clicking it again on the
// same text takes that markdown away. What "the same text" means is
// decided per family below (a word for the inline marks, a line for the
// block prefixes), because a caret with no selection is the common
// case and "insert `****`" is what nobody wants.

import type { Chord } from "$lib/shortcuts";

export type FormatAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bullet-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "code-block"
  | "rule"
  | "table";

export interface FormatSelection {
  anchor: number;
  head: number;
}

/// One replacement in OLD document offsets -- CodeMirror's ChangeSpec.
export interface FormatChange {
  from: number;
  to: number;
  insert: string;
}

export interface FormatResult {
  /// Sorted, non-overlapping, in old-document offsets.
  changes: FormatChange[];
  /// In NEW document offsets, as a CodeMirror transaction takes it.
  selection: FormatSelection;
}

export interface FormatButton {
  action: FormatAction;
  label: string;
  /// Also fires it from the keyboard inside the editor: ⌘ on macOS,
  /// Ctrl elsewhere. Only the inline marks get one -- those are the
  /// chords every editor shares; there is no convention for "make this
  /// a heading 2" worth claiming a key for.
  chord?: Chord;
}

/// The bar, left to right, as groups separated by a rule. One table
/// drives the buttons, their tooltips AND the editor keymap, so a chord
/// can never say one thing on hover and do another on the keys.
export const FORMAT_GROUPS: readonly (readonly FormatButton[])[] = [
  [
    { action: "bold", label: "Bold", chord: { key: "b" } },
    { action: "italic", label: "Italic", chord: { key: "i" } },
    { action: "strikethrough", label: "Strikethrough", chord: { key: "x", shift: true } },
    { action: "code", label: "Inline code", chord: { key: "e" } },
    { action: "link", label: "Link", chord: { key: "k" } },
  ],
  [
    { action: "heading-1", label: "Heading 1" },
    { action: "heading-2", label: "Heading 2" },
    { action: "heading-3", label: "Heading 3" },
  ],
  [
    { action: "bullet-list", label: "Bullet list" },
    { action: "numbered-list", label: "Numbered list" },
    { action: "task-list", label: "Task list" },
    { action: "quote", label: "Quote" },
  ],
  [
    { action: "code-block", label: "Code block" },
    { action: "rule", label: "Horizontal rule" },
    { action: "table", label: "Table" },
  ],
];

/// A chord in CodeMirror's key-name form ("Mod-b", "Mod-Shift-x"). Mod
/// is CodeMirror's own ⌘-or-Ctrl, which is exactly what `Chord` means.
export function chordToKeyName(chord: Chord): string {
  return `Mod-${chord.alt ? "Alt-" : ""}${chord.shift ? "Shift-" : ""}${chord.key}`;
}

export function applyFormat(action: FormatAction, doc: string, selection: FormatSelection): FormatResult {
  switch (action) {
    case "bold":
      return toggleInline(doc, selection, "**");
    case "italic":
      // Underscores, not stars: a selection that is already bold reads
      // `**x**`, and single stars around it would be ambiguous to both
      // the toggle-off check and the reader.
      return toggleInline(doc, selection, "_");
    case "strikethrough":
      return toggleInline(doc, selection, "~~");
    case "code":
      return toggleInline(doc, selection, "`");
    case "link":
      return toggleLink(doc, selection);
    case "heading-1":
      return setHeading(doc, selection, 1);
    case "heading-2":
      return setHeading(doc, selection, 2);
    case "heading-3":
      return setHeading(doc, selection, 3);
    case "bullet-list":
      return setList(doc, selection, "bullet");
    case "numbered-list":
      return setList(doc, selection, "numbered");
    case "task-list":
      return setList(doc, selection, "task");
    case "quote":
      return toggleQuote(doc, selection);
    case "code-block":
      return toggleCodeBlock(doc, selection);
    case "rule":
      return insertRule(doc, selection);
    case "table":
      return insertTable(doc, selection);
  }
}

/// The document a result produces. Only tests need the whole string --
/// the editor hands the changes to CodeMirror -- but the assertion "this
/// text came out" is what makes the rules above readable as a suite.
export function applyChanges(doc: string, changes: FormatChange[]): string {
  let out = "";
  let pos = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    out += doc.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + doc.slice(pos);
}

// ---------------------------------------------------------------------
// Selection helpers

interface Range {
  from: number;
  to: number;
  backwards: boolean;
}

function normalize(sel: FormatSelection): Range {
  return {
    from: Math.min(sel.anchor, sel.head),
    to: Math.max(sel.anchor, sel.head),
    backwards: sel.head < sel.anchor,
  };
}

function cursor(pos: number): FormatSelection {
  return { anchor: pos, head: pos };
}

// A range keeps the direction it was dragged in.
function orient(from: number, to: number, backwards: boolean): FormatSelection {
  return backwards ? { anchor: to, head: from } : { anchor: from, head: to };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/// The word the caret sits in or touches, or null on whitespace and
/// punctuation. Letters, digits and underscore in any script.
function wordAround(doc: string, pos: number): { from: number; to: number } | null {
  let from = pos;
  let to = pos;
  while (from > 0 && WORD_CHAR.test(doc[from - 1])) from--;
  while (to < doc.length && WORD_CHAR.test(doc[to])) to++;
  return to > from ? { from, to } : null;
}

function before(doc: string, pos: number, len: number): string {
  return pos >= len ? doc.slice(pos - len, pos) : "";
}

function after(doc: string, pos: number, len: number): string {
  return doc.slice(pos, pos + len);
}

// ---------------------------------------------------------------------
// Inline marks: bold, italic, strikethrough, code

function toggleInline(doc: string, sel: FormatSelection, marker: string): FormatResult {
  let { from, to, backwards } = normalize(sel);
  const m = marker.length;

  if (from < to) {
    // `**word **` is not emphasis in CommonMark, so whitespace at either
    // end of the selection stays outside the markers.
    const text = doc.slice(from, to);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    if (lead + trail < text.length) {
      from += lead;
      to -= trail;
    } else {
      to = from;
    }
  }

  if (from === to) {
    // Sitting in an empty pair the previous click made: take it back.
    if (before(doc, from, m) === marker && after(doc, from, m) === marker) {
      return { changes: [{ from: from - m, to: from + m, insert: "" }], selection: cursor(from - m) };
    }
    const word = wordAround(doc, from);
    if (!word) {
      return { changes: [{ from, to: from, insert: marker + marker }], selection: cursor(from + m) };
    }
    // The caret stays on the same character; only the markers move.
    if (before(doc, word.from, m) === marker && after(doc, word.to, m) === marker) {
      return {
        changes: [
          { from: word.from - m, to: word.from, insert: "" },
          { from: word.to, to: word.to + m, insert: "" },
        ],
        selection: cursor(from - m),
      };
    }
    return {
      changes: [
        { from: word.from, to: word.from, insert: marker },
        { from: word.to, to: word.to, insert: marker },
      ],
      selection: cursor(from + m),
    };
  }

  const text = doc.slice(from, to);
  // The selection includes the markers: `**word**` selected.
  if (text.length >= 2 * m && text.startsWith(marker) && text.endsWith(marker)) {
    return {
      changes: [
        { from, to: from + m, insert: "" },
        { from: to - m, to, insert: "" },
      ],
      selection: orient(from, to - 2 * m, backwards),
    };
  }
  // The markers hug the selection: `**[word]**`.
  if (before(doc, from, m) === marker && after(doc, to, m) === marker) {
    return {
      changes: [
        { from: from - m, to: from, insert: "" },
        { from: to, to: to + m, insert: "" },
      ],
      selection: orient(from - m, to - m, backwards),
    };
  }
  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    selection: orient(from + m, to + m, backwards),
  };
}

// ---------------------------------------------------------------------
// Links

const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
const LINK_TEXT = "text";
const LINK_URL = "url";

/// Wraps the selection (or the word at the caret) as `[text](url)` and
/// selects whichever half still needs typing: the url for prose, the
/// text for a pasted address. A selected link is taken back to its
/// text.
function toggleLink(doc: string, sel: FormatSelection): FormatResult {
  let { from, to, backwards } = normalize(sel);
  if (from === to) {
    const word = wordAround(doc, from);
    if (word) {
      from = word.from;
      to = word.to;
    }
  } else {
    const text = doc.slice(from, to);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    if (lead + trail < text.length) {
      from += lead;
      to -= trail;
    } else {
      to = from;
    }
  }
  const text = doc.slice(from, to);
  const existing = LINK_RE.exec(text);
  if (existing) {
    const label = existing[1];
    return { changes: [{ from, to, insert: label }], selection: orient(from, from + label.length, backwards) };
  }
  if (text.length === 0 || URL_RE.test(text)) {
    const url = text.length === 0 ? LINK_URL : text;
    return {
      changes: [{ from, to, insert: `[${LINK_TEXT}](${url})` }],
      selection: { anchor: from + 1, head: from + 1 + LINK_TEXT.length },
    };
  }
  const urlStart = from + 1 + text.length + 2;
  return {
    changes: [{ from, to, insert: `[${text}](${LINK_URL})` }],
    selection: { anchor: urlStart, head: urlStart + LINK_URL.length },
  };
}

// ---------------------------------------------------------------------
// Line-prefix blocks: headings, lists, quotes

interface Line {
  from: number;
  /// End of the text, before the newline.
  to: number;
  text: string;
}

function lineAt(doc: string, pos: number): Line {
  const from = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
  let to = doc.indexOf("\n", pos);
  if (to < 0) to = doc.length;
  return { from, to, text: doc.slice(from, to) };
}

/// Every line the range touches. A range that ends exactly at a line's
/// start does not include that line -- selecting three lines by
/// dragging to the start of the fourth is how selection works
/// everywhere, and the fourth must not get the prefix.
function linesIn(doc: string, from: number, to: number): Line[] {
  const lines: Line[] = [];
  let line = lineAt(doc, from);
  for (;;) {
    lines.push(line);
    if (line.to >= to) break;
    line = lineAt(doc, line.to + 1);
  }
  if (lines.length > 1 && to === lines[lines.length - 1].from) lines.pop();
  return lines;
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

interface LineEdit {
  line: Line;
  /// How much of the line's start the prefix occupies today.
  oldLen: number;
  /// What replaces it (indentation included).
  insert: string;
}

/// Where a position lands once the changes apply. `assoc` says which way
/// a position exactly at a change's start leans: a caret goes after the
/// prefix so typing continues on the item, a range's start stays before
/// it so the whole line stays selected.
function mapPos(changes: FormatChange[], pos: number, assoc: -1 | 1): number {
  let delta = 0;
  for (const c of changes) {
    if (pos < c.from || (pos === c.from && assoc < 0)) break;
    if (pos <= c.to) return c.from + delta + c.insert.length;
    delta += c.insert.length - (c.to - c.from);
  }
  return pos + delta;
}

function finishLineEdits(sel: FormatSelection, edits: (LineEdit | null)[]): FormatResult {
  const changes: FormatChange[] = [];
  for (const e of edits) {
    if (!e || e.line.text.slice(0, e.oldLen) === e.insert) continue;
    changes.push({ from: e.line.from, to: e.line.from + e.oldLen, insert: e.insert });
  }
  if (sel.anchor === sel.head) return { changes, selection: cursor(mapPos(changes, sel.head, 1)) };
  const { from, to, backwards } = normalize(sel);
  return { changes, selection: orient(mapPos(changes, from, -1), mapPos(changes, to, 1), backwards) };
}

const HEADING_RE = /^([ \t]*)(#{1,6})(?:[ \t]+|$)/;

/// Sets every selected line to that level, or clears the level when
/// every line already has it. Blank lines inside a multi-line range are
/// left alone: an empty `## ` is never what was meant.
function setHeading(doc: string, sel: FormatSelection, level: number): FormatResult {
  const { from, to } = normalize(sel);
  const lines = linesIn(doc, from, to);
  const parsed = lines.map((line) => {
    const m = HEADING_RE.exec(line.text);
    const indent = m ? m[1] : leadingWhitespace(line.text);
    return { line, indent, level: m ? m[2].length : 0, oldLen: m ? m[0].length : indent.length };
  });
  const considered = lines.length > 1 ? parsed.filter((p) => p.line.text.trim() !== "") : parsed;
  const all = considered.length > 0 && considered.every((p) => p.level === level);
  const edits = parsed.map((p) => {
    if (lines.length > 1 && p.line.text.trim() === "") return null;
    return { line: p.line, oldLen: p.oldLen, insert: p.indent + (all ? "" : "#".repeat(level) + " ") };
  });
  return finishLineEdits(sel, edits);
}

const QUOTE_RE = /^([ \t]*)>[ \t]?/;

/// Quotes every selected line, blank ones included -- a bare blank line
/// would split the quote in two -- or unquotes them all when every line
/// already carries the mark.
function toggleQuote(doc: string, sel: FormatSelection): FormatResult {
  const { from, to } = normalize(sel);
  const lines = linesIn(doc, from, to);
  const parsed = lines.map((line) => {
    const m = QUOTE_RE.exec(line.text);
    const indent = m ? m[1] : leadingWhitespace(line.text);
    return { line, indent, quoted: m !== null, oldLen: m ? m[0].length : indent.length };
  });
  const all = parsed.every((p) => p.quoted);
  const edits = parsed.map((p) => {
    if (all) return { line: p.line, oldLen: p.oldLen, insert: p.indent };
    const rest = p.line.text.slice(p.oldLen);
    const mark = rest.length === 0 && lines.length > 1 ? ">" : "> ";
    return { line: p.line, oldLen: p.oldLen, insert: p.indent + mark };
  });
  return finishLineEdits(sel, edits);
}

type ListKind = "bullet" | "numbered" | "task";

// Task before bullet: `- [ ] x` starts like a bullet and is not one.
const TASK_RE = /^([ \t]*)[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)/;
const BULLET_RE = /^([ \t]*)[-*+](?:[ \t]+|$)/;
const NUMBERED_RE = /^([ \t]*)\d+[.)](?:[ \t]+|$)/;

function listPrefix(text: string): { kind: ListKind | null; indent: string; oldLen: number } {
  for (const [kind, re] of [
    ["task", TASK_RE],
    ["bullet", BULLET_RE],
    ["numbered", NUMBERED_RE],
  ] as const) {
    const m = re.exec(text);
    if (m) return { kind, indent: m[1], oldLen: m[0].length };
  }
  const indent = leadingWhitespace(text);
  return { kind: null, indent, oldLen: indent.length };
}

/// Makes every selected line an item of that kind -- converting items of
/// another kind, numbering from 1 -- or strips the marks when every line
/// is already that kind. Blank lines inside a multi-line range stay
/// blank; a lone blank line becomes an empty item to type into.
function setList(doc: string, sel: FormatSelection, kind: ListKind): FormatResult {
  const { from, to } = normalize(sel);
  const lines = linesIn(doc, from, to);
  const parsed = lines.map((line) => ({ line, ...listPrefix(line.text), blank: line.text.trim() === "" }));
  const considered = lines.length > 1 ? parsed.filter((p) => !p.blank) : parsed;
  const all = considered.length > 0 && considered.every((p) => p.kind === kind);
  let n = 0;
  const edits = parsed.map((p) => {
    if (lines.length > 1 && p.blank) return null;
    let insert = p.indent;
    if (!all) insert += kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${++n}. `;
    return { line: p.line, oldLen: p.oldLen, insert };
  });
  return finishLineEdits(sel, edits);
}

// ---------------------------------------------------------------------
// Fenced code

const FENCE_RE = /^[ \t]*(?:```|~~~)/;
const FENCE = "```";

/// Fences the selected lines (the caret's line when nothing is
/// selected), or removes the fences when the first and last selected
/// lines are the fences.
function toggleCodeBlock(doc: string, sel: FormatSelection): FormatResult {
  const { from, to, backwards } = normalize(sel);
  const lines = linesIn(doc, from, to);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (lines.length >= 2 && FENCE_RE.test(first.text) && FENCE_RE.test(last.text)) {
    if (lines.length === 2) {
      return { changes: [{ from: first.from, to: last.to, insert: "" }], selection: cursor(first.from) };
    }
    const innerEnd = last.from - 1 - (first.to + 1 - first.from);
    return {
      changes: [
        { from: first.from, to: first.to + 1, insert: "" },
        { from: last.from - 1, to: last.to, insert: "" },
      ],
      selection: orient(first.from, innerEnd, backwards),
    };
  }
  const open = FENCE + "\n";
  if (first.from === last.to) {
    // One blank line: a single insertion, so the two fences cannot land
    // in either order around the same offset.
    return {
      changes: [{ from: first.from, to: first.from, insert: open + "\n" + FENCE }],
      selection: cursor(first.from + open.length),
    };
  }
  return {
    changes: [
      { from: first.from, to: first.from, insert: open },
      { from: last.to, to: last.to, insert: "\n" + FENCE },
    ],
    selection: orient(first.from + open.length, last.to + open.length, backwards),
  };
}

// ---------------------------------------------------------------------
// Standalone blocks: rule, table

interface BlockInsertion {
  changes: FormatChange[];
  /// New-document offset of the block's first character.
  blockStart: number;
  /// New-document offset of the empty line after the block.
  after: number;
}

/// Puts a block on lines of its own at the caret's line: on a blank line
/// in place, otherwise below the line. A blank line is kept on both
/// sides -- without one above, `---` under a paragraph is a setext
/// heading, and a table under one is more paragraph.
function insertBlock(doc: string, sel: FormatSelection, block: string): BlockInsertion {
  const line = lineAt(doc, sel.head);
  const hasNext = line.to < doc.length;
  const nextIsBlank = hasNext && lineAt(doc, line.to + 1).text.trim() === "";
  let pos: number;
  let lead: string;
  if (line.text.trim() === "") {
    const prevIsBlank = line.from === 0 || lineAt(doc, line.from - 1).text.trim() === "";
    pos = line.from;
    lead = prevIsBlank ? "" : "\n";
  } else {
    pos = line.to;
    lead = "\n\n";
  }
  // The blank line below is either already there (step over its
  // newline) or made here.
  const tail = nextIsBlank ? "" : "\n";
  const insert = lead + block + tail;
  return {
    changes: [{ from: pos, to: pos, insert }],
    blockStart: pos + lead.length,
    after: pos + insert.length + (nextIsBlank ? 1 : 0),
  };
}

function insertRule(doc: string, sel: FormatSelection): FormatResult {
  const { changes, after } = insertBlock(doc, sel, "---");
  return { changes, selection: cursor(after) };
}

const TABLE_HEAD = "Column 1";
const TABLE = `| ${TABLE_HEAD} | Column 2 |\n| --- | --- |\n|  |  |`;

function insertTable(doc: string, sel: FormatSelection): FormatResult {
  const { changes, blockStart } = insertBlock(doc, sel, TABLE);
  const head = blockStart + 2;
  return { changes, selection: { anchor: head, head: head + TABLE_HEAD.length } };
}
