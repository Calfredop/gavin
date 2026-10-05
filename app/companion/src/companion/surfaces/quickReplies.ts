// The quick replies above the compose field: one tap for the answers an
// agent is asking for.
//
// Two questions, two sources (ticket 01, amendment 3). WHETHER the agent
// is asking is not something a screen can say -- a closing "want me to
// also...?" reads exactly like a question -- so that is the daemon's bell
// or, for a question asked in prose, the turn verdict: the one rule
// `verdictAsksQuietly` already is for the inbox, the tab badge and the
// follow-up queue. WHAT the answers are is on the screen: a numbered
// menu's options, an arrow menu's rows, a `(y/n)`. Only a question in
// free text gets canned words.
//
// Pure. The screen is the terminal's own rows, as the phone's xterm holds
// them; the verdict is the desktop's entry for the session.
import { verdictAsksQuietly, type TurnVerdictEntry } from "$lib/agents/turnVerdict";
import type { SessionStatus } from "$lib/core/notifications";
import { composeBytes, keyBytes, type InputModes, type KeyId } from "$companion/surfaces/terminalInput";

/// How a reply reaches the terminal.
export type ReplySend =
  /// Keys pressed: an arrow menu is walked, then Enter.
  | { kind: "keys"; keys: KeyId[] }
  /// A bare key typed, with no Enter: a numbered menu selects on its
  /// digit alone, and an Enter after it would be left for the next prompt.
  | { kind: "key"; text: string }
  /// A line, the way the compose field sends one.
  | { kind: "line"; text: string };

export interface QuickReply {
  /// The key that picks it, shown before the label: a menu's number.
  key: string | null;
  label: string;
  send: ReplySend;
  /// Where the agent's own cursor is, or the prompt's default: what
  /// Enter alone would choose.
  primary: boolean;
  /// A guess at what one might say, not an option the agent offered.
  canned: boolean;
}

export type ReplyShape = "menu" | "arrows" | "yes-no" | "free-text" | "shell";

export interface QuickReplies {
  /// Null while nothing is being asked, and then there are no replies.
  shape: ReplyShape | null;
  replies: QuickReply[];
}

const NOT_ASKING: QuickReplies = { shape: null, replies: [] };

/// Whether the session is waiting on the human: it rang the bell, or it
/// went quiet on a question the verdict read in its prose.
export function isAsking(status: SessionStatus | null | undefined, verdict: TurnVerdictEntry | null | undefined): boolean {
  return status === "waiting_for_input" || verdictAsksQuietly(status, verdict);
}

/// A terminal's rows as lines: a row the terminal wrapped onto the next
/// is joined back to it, so a menu option too long for a phone's width
/// is still one option. Rows arrive untrimmed, because the space at a
/// wrap is part of the text; lines leave trimmed.
export function logicalRows(rows: readonly { text: string; wrapped: boolean }[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.map((line) => line.replace(/\s+$/, ""));
}

/// Rows read from the bottom of the screen. A menu sits at the bottom and
/// its question just above; more than this is history.
const TAIL_ROWS = 16;

/// A box's left and right edges, so a menu drawn inside one reads as a
/// menu.
function unbox(line: string): string {
  return line.replace(/^\s{0,2}[│|┃]\s?/, "").replace(/\s*[│|┃]\s*$/, "");
}

function isBorder(line: string): boolean {
  return /^[\s╭╮╰╯┌┐└┘─━═]*$/.test(line) && /[╭╮╰╯┌┐└┘─━═]/.test(line);
}

/// A TUI's own hints under a menu or a box. Indented like an option, so
/// without this a footer would be read as one.
function isFurniture(line: string): boolean {
  return /(for shortcuts|esc to (interrupt|cancel|exit)|enter to (confirm|select)|ctrl-c again|↑\/↓)/i.test(line);
}

function blankish(line: string): boolean {
  return line.trim() === "" || isBorder(line) || isFurniture(line);
}

const OPTION = /^\s*(?:[❯›▸>]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const MARKED = /^\s*[❯›▸>]/;
const CURSOR = /^(\s*)([❯›▸])\s+(\S.*)$/;
const YES_NO = /(\((?:y\/n|yes\/no)(?:\s*\[[yn]\])?\)|\[(?:y\/n|Y\/n|y\/N)\])\s*\S{0,8}$/i;
const SHELL_PROMPT = /[$%#]\s*$/;

/// The last numbered menu on screen, if it is the last thing on screen:
/// options 1..n in order, a wrapped label folded into its option.
function numberedMenu(rows: string[]): QuickReply[] | null {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i].match(OPTION);
    if (m && Number(m[1]) === 1) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const options: { n: number; text: string; marked: boolean }[] = [];
  let end = start;
  for (let i = start; i < rows.length; i++) {
    const m = rows[i].match(OPTION);
    if (m && Number(m[1]) === options.length + 1) {
      options.push({ n: Number(m[1]), text: m[2].trim(), marked: MARKED.test(rows[i]) });
      end = i;
    } else if (options.length > 0 && !blankish(rows[i]) && /^\s{2,}/.test(rows[i])) {
      options[options.length - 1].text += ` ${rows[i].trim()}`;
      end = i;
    } else {
      break;
    }
  }
  if (options.length < 2 || !rows.slice(end + 1).every(blankish)) return null;
  const selected = options.findIndex((o) => o.marked);
  return options.map((o, index) => ({
    key: String(o.n),
    label: o.text.replace(/\s*\(esc\)$/i, ""),
    send: { kind: "key", text: String(o.n) },
    primary: index === (selected === -1 ? 0 : selected),
    canned: false,
  }));
}

/// A menu walked with the arrows: a cursor glyph and its siblings in the
/// same column. Each reply walks from where the cursor is.
function arrowMenu(rows: string[]): QuickReply[] | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i].match(CURSOR);
    if (!m) continue;
    const column = m[1].length + 2;
    const sibling = (line: string): boolean =>
      line.trim() !== "" &&
      line.slice(0, column) === " ".repeat(column) &&
      line[column] !== " " &&
      !isFurniture(line) &&
      !CURSOR.test(line);
    let first = i;
    let last = i;
    while (first - 1 >= 0 && sibling(rows[first - 1])) first--;
    while (last + 1 < rows.length && sibling(rows[last + 1])) last++;
    if (last - first < 1 || !rows.slice(last + 1).every(blankish)) continue;
    return rows.slice(first, last + 1).map((line, index) => {
      const steps = index - (i - first);
      const arrow: KeyId = steps > 0 ? "down" : "up";
      return {
        key: null,
        label: line.slice(column).trim(),
        send: { kind: "keys", keys: [...Array<KeyId>(Math.abs(steps)).fill(arrow), "enter"] },
        primary: steps === 0,
        canned: false,
      };
    });
  }
  return null;
}

function yesNo(last: string): QuickReply[] | null {
  const m = last.match(YES_NO);
  if (!m) return null;
  const fallback = /\[n\]|y\/N/.test(m[1]) ? "No" : /\[y\]|Y\/n/.test(m[1]) ? "Yes" : null;
  return [
    { key: null, label: "Yes", send: { kind: "line", text: "y" }, primary: fallback === "Yes", canned: false },
    { key: null, label: "No", send: { kind: "line", text: "n" }, primary: fallback === "No", canned: false },
  ];
}

const CANNED: readonly string[] = ["Yes", "No", "Continue"];

/// The replies for this session, now.
export function quickReplies(input: {
  status: SessionStatus | null | undefined;
  verdict: TurnVerdictEntry | null | undefined;
  /// The terminal's rows, top to bottom.
  screen: readonly string[];
}): QuickReplies {
  if (!isAsking(input.status, input.verdict)) return NOT_ASKING;

  const rows = input.screen.map((line) => line.replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const tail = rows.slice(-TAIL_ROWS).map(unbox);

  const menu = numberedMenu(tail);
  if (menu) return { shape: "menu", replies: menu };
  const arrows = arrowMenu(tail);
  if (arrows) return { shape: "arrows", replies: arrows };

  const last = [...tail].reverse().find((line) => !blankish(line))?.trim() ?? "";
  const yn = yesNo(last);
  if (yn) return { shape: "yes-no", replies: yn };
  // A bell at a shell prompt is a failed completion, not a question.
  if (SHELL_PROMPT.test(last)) return { shape: "shell", replies: [] };
  return {
    shape: "free-text",
    replies: CANNED.map((word) => ({
      key: null,
      label: word,
      send: { kind: "line", text: word.toLowerCase() },
      primary: false,
      canned: true,
    })),
  };
}

/// What a reply sends, for the program as it is now.
export function replyBytes(send: ReplySend, modes: InputModes): string {
  switch (send.kind) {
    case "key":
      return send.text;
    case "keys":
      return send.keys.map((key) => keyBytes(key, modes)).join("");
    case "line":
      return composeBytes(send.text, modes);
  }
}
