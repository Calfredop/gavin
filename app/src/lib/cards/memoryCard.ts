// Proposed memories, and the single action that adopts one.
//
// The convention is a card, not a mechanism: an agent that learns a
// durable fact about the repo files an ordinary `kind: note` card
// labelled `memory` whose body IS the fact. Nothing here proposes one --
// the app never reads a transcript -- and nothing is adopted without the
// human pressing the button on that card.
//
// Adopting appends the fact to the workspace's agent instructions file
// (CLAUDE.md, AGENTS.md, whatever the profile resolved), INSIDE the
// `<!-- gavin:start -->` block that "Set up / update" owns, under a
// `### Learned` heading. Inside, because a fact parked outside the block
// sits away from the guidance it qualifies; under a heading of its own
// because that heading is what agent_setup.rs's merge looks for when it
// rewrites the block (`learned_section` there). The two spellings of
// `### Learned` must stay identical, or the next setup run drops
// everything ever adopted.

import * as backend from "$lib/core/backend";
import { slugStatus, type CardView } from "$lib/core/planBoard";
import { stripFrontmatter } from "$lib/cards/planChecklist";

/// The label that turns a note into a proposed memory. Slug-matched, the
/// same way a card's status meets a column name, so "Memory" counts.
export const MEMORY_LABEL = "memory";

/// Kept in sync with agent_setup.rs by hand -- see this file's header.
export const LEARNED_HEADING = "### Learned";

const MARKER_START = "<!-- gavin:start -->";
const MARKER_END = "<!-- gavin:end -->";

/// Note + `memory`. Kind first: a task labelled `memory` is work about
/// memories, not a fact to adopt, and adopting its prompt into the
/// instructions file would be nonsense.
export function isMemoryCard(card: Pick<CardView, "kind" | "labels">): boolean {
  return card.kind === "note" && card.labels.some((l) => slugStatus(l) === MEMORY_LABEL);
}

/// The card body as one markdown bullet: the fact on the bullet line,
/// every further line (the optional "Why") indented under it so the
/// whole memory stays one list item however many lines it took.
///
/// Null when there is nothing to adopt -- a memory card whose body is
/// empty is a title and no fact.
export function memoryBullet(fileContent: string): string | null {
  const lines = stripFrontmatter(fileContent)
    .split("\n")
    .map((l) => l.trim())
    // A body already written as bullets ("- fact") must not adopt as
    // "- - fact": the list marker is this function's to add.
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return [`- ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)].join("\n");
}

export type LearnedEdit = { content: string } | { error: string };

/// Appends `bullet` under `### Learned` inside the marker block,
/// creating the heading the first time. Returns the file unchanged when
/// the bullet is already there, so a card adopted, taken off Done and
/// adopted again does not double up.
///
/// A file with no marker block is refused rather than appended to: the
/// block is what a setup run rewrites, and a `### Learned` section
/// outside one would be a second, invisible place for memories to live.
export function appendLearned(instructions: string, bullet: string): LearnedEdit {
  const start = instructions.indexOf(MARKER_START);
  const end = instructions.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    return {
      error: `This file has no ${MARKER_START} block, so there is nowhere to file a memory. Run “Set up / update” on the Settings tab first.`,
    };
  }
  const head = instructions.slice(0, start + MARKER_START.length);
  const inner = instructions.slice(start + MARKER_START.length, end);
  const tail = instructions.slice(end);
  if (inner.split("\n").includes(bullet.split("\n")[0])) return { content: instructions };
  const body = inner.replace(/\s+$/, "");
  const hasHeading = inner.split("\n").some((l) => l.trim() === LEARNED_HEADING);
  const next = hasHeading
    ? `${body}\n${bullet}\n`
    : `${body}\n\n${LEARNED_HEADING}\n\n${bullet}\n`;
  return { content: `${head}${next}${tail}` };
}

/// What `adoptMemory` did: the path the card ended up on (setting a card
/// Done files it under `plans/done/`, so it usually moved), or the one
/// thing that went wrong.
export type AdoptResult = { movedTo: string } | { error: string };

/// Adopt in file order: the instructions file first, the card's status
/// second. A failed status write leaves a fact adopted and a card still
/// on the board, which the human can finish by hand; the other order
/// would file the card away having adopted nothing.
///
/// `doneStatus` is the board's done column NAME rather than a literal:
/// the column vocabulary is the human's, and "Shipped" is as valid a
/// last column as "Done".
export async function adoptMemory(
  card: Pick<CardView, "id">,
  instructionsPath: string,
  doneStatus: string
): Promise<AdoptResult> {
  const fileName = instructionsPath.split("/").at(-1) ?? instructionsPath;
  try {
    // Re-read rather than trusting the modal's watched snapshot: that
    // copy is up to a watch debounce old, and this is a whole-file
    // write on the other side.
    const cardFile = await backend.readFileForViewer(card.id);
    if (!cardFile.exists) return { error: "The card's file is gone." };
    const bullet = memoryBullet(cardFile.content);
    if (bullet === null) {
      return { error: "This card has no body, so there is no memory to adopt." };
    }
    const existing = await backend.readFileForViewer(instructionsPath);
    if (!existing.exists) {
      return {
        error: `${fileName} doesn't exist yet. Run “Set up / update” on the Settings tab first.`,
      };
    }
    // The viewer caps what it reads, and this write replaces the whole
    // file: appending to a prefix would delete everything past the cap
    // (fileEditing.ts's canEdit refuses the same thing for the editor).
    if (existing.truncated) {
      return { error: `${fileName} is too large for gavin to rewrite safely.` };
    }
    const edit = appendLearned(existing.content, bullet);
    if ("error" in edit) return edit;
    if (edit.content !== existing.content) {
      await backend.writeFileForEditor(instructionsPath, edit.content);
    }
    const movedTo = await backend.setPlanFrontmatterField(card.id, "status", doneStatus);
    return { movedTo };
  } catch (e) {
    return { error: `Couldn't adopt into ${fileName}: ${e instanceof Error ? e.message : e}` };
  }
}

/// Why "Adopt" is unavailable on a memory card, or null when it can run.
///
/// Both halves named rather than assumed. The instructions file hangs
/// off the root, so a rootless workspace has nothing to adopt INTO; and
/// the last column is the human's to call whatever they like, so a board
/// with no columns has nowhere to file the card once the fact is
/// written. A sentence rather than a dark button, since a disabled
/// control cannot explain itself.
export function adoptBlockedReason(hasRoot: boolean, hasDoneColumn: boolean): string | null {
  if (!hasRoot) return "This workspace has no root folder, so it has no instructions file to adopt into.";
  if (!hasDoneColumn) return "This board has no columns, so there is no done column to file the card into.";
  return null;
}
