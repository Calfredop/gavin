// Pure half of the two-speed composer (card-model spec §4): title +
// kind + context -> the createPlan argument set, with slugged file
// names and "-2" collision suffixes. The Svelte composer only renders
// and forwards.

import { formatAttachments } from "./attachments";
import { slugFileName } from "./planExplorer";
import { formatChord, matchesChord, type Chord, type ChordEvent } from "./shortcuts";

export type ComposeKind = "note" | "task" | "plan";

/// The kind chips, in the order the composer offers them, and the one a
/// fresh composer starts on. ⌘N is overwhelmingly used to file work --
/// something an agent will pick up -- so the composer opens ready for
/// that, with the prompt field already there; a note is the exception,
/// a card with nothing to run, so it sits last. Kept here rather than
/// inline in the template so the order and the default cannot drift
/// apart from each other, or from the tests.
export const COMPOSE_KINDS = ["task", "plan", "note"] as const;
export const DEFAULT_COMPOSE_KIND: ComposeKind = COMPOSE_KINDS[0];

export interface ComposeSpec {
  kind: ComposeKind;
  title: string;
  // The prompt for a task, the body for a plan, ignored-when-empty for
  // a note.
  body: string;
  status: string; // the column's name
  // Files to attach, as they will be STORED (relative inside the
  // workspace root, absolute outside it). Carried through the composer
  // so a card can be filed with its references already on it -- picking
  // a file, filing the card, then reopening it to attach the file is
  // three steps for one intention. Optional: every call site that
  // predates the field means "none".
  attachments?: string[];
}

export type ComposeArgs =
  | {
      fileName: string;
      title: string;
      status: string;
      body: string | undefined;
      kind: ComposeKind;
      // The `attachments:` frontmatter LINE, or undefined for a card
      // that gets no such line at all -- CreatePlan takes the line
      // rather than a list, so the daemon writes what it was handed
      // instead of re-deriving a format its own parser has to match.
      attachments: string | undefined;
    }
  | { error: string };

export function buildCreatePlanArgs(spec: ComposeSpec, existingFileNames: string[]): ComposeArgs {
  const title = spec.title.trim();
  if (!title) return { error: "Card title is empty" };
  const base = slugFileName(title);
  if (!base) return { error: "Title has no usable characters for a file name" };
  const taken = new Set(existingFileNames);
  let fileName = base;
  let n = 2;
  while (taken.has(fileName)) {
    fileName = base.replace(/\.md$/, `-${n}.md`);
    n += 1;
  }
  const body = spec.body.trim();
  const attachments = formatAttachments(spec.attachments ?? []);
  return {
    fileName,
    title,
    status: spec.status,
    body: body === "" ? undefined : body,
    kind: spec.kind,
    attachments: attachments === "" ? undefined : attachments,
  };
}

/// Which column a freshly opened composer starts in. The column that
/// asked wins while it is still on the board -- a rename or a delete
/// between the click and the render must not leave the picker showing a
/// status no column carries -- and the leftmost column is the fallback,
/// which is what ⌘N gets when nothing asked for a particular one.
/// Null only when the board has no real columns at all: there is then no
/// status to give the card.
export function defaultComposeStatus(columnNames: string[], preferred: string | null): string | null {
  if (preferred !== null && columnNames.includes(preferred)) return preferred;
  return columnNames[0] ?? null;
}

/// The rail a newly created card should be sent to. A note never rides a
/// rail (it is not runnable work), and a rail deleted since the picker
/// rendered took its row off screen with it -- writing to it would be a
/// placement nobody asked for.
export function railToApply(
  kind: ComposeKind,
  railId: string | null,
  railIds: string[]
): string | null {
  if (kind === "note" || !railId) return null;
  return railIds.includes(railId) ? railId : null;
}

/// The composer's commit chord, as data so the keydown handler and the
/// footer hint read it from one place and cannot drift apart. Enter is
/// not a letter, so formatChord renders it "⌘Enter" / "Ctrl+Enter" and
/// matchesChord matches it, with no Enter-specific modifier rules here.
export const COMPOSE_COMMIT_CHORD: Chord = { key: "Enter" };

/// Which field the key landed in -- named for the only thing that varies
/// between them, what a BARE Enter means there. "title" is the fast path
/// (type a title, Enter, card filed); "body" is every field where Enter
/// belongs to the field itself: the plan/prompt textarea, whose whole
/// point is `- [ ] step` lines and multi-paragraph prompts, and the
/// pickers, where Enter closes an open dropdown.
export type ComposeField = "title" | "body";

/// "commit" -- file the card. "newline" -- the field keeps the key.
/// null -- not ours; leave the event entirely alone.
export type ComposeKeyAction = "commit" | "newline";

export function composeKeyAction(
  field: ComposeField,
  e: ChordEvent & { isComposing?: boolean },
  isMac: boolean
): ComposeKeyAction | null {
  if (e.key !== "Enter") return null;
  // An IME candidate is confirmed with Enter. Filing a card on it would
  // eat the keystroke that finishes the word being typed.
  if (e.isComposing) return null;
  if (matchesChord(e, COMPOSE_COMMIT_CHORD, isMac)) return "commit";
  // Some other modifier combination: not the commit chord and not a
  // plain keystroke either, so it is not the composer's to interpret.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) return "newline";
  return field === "title" ? "commit" : "newline";
}

/// The footer hint for the field that currently holds focus. It used to
/// be one fixed string promising "Enter adds" everywhere, which was true
/// of the title and a lie in the body -- the field where Enter has to
/// stay a newline. A hint that names the wrong key is worse than none:
/// it is what sends someone hunting for a bug in the field instead.
export function composeHint(field: ComposeField, isMac: boolean): string {
  if (field === "title") return "Enter adds and stays · ⇧Enter newline · Esc closes";
  return `${formatChord(COMPOSE_COMMIT_CHORD, isMac)} adds and stays · Enter newline · Esc closes`;
}
