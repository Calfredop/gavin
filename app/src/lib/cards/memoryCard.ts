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
//
// A memory card is ONE fact: the first body line is the fact, an
// optional second line starting `Why:` is the reason, and nothing else
// belongs in the body. Optional `topics:` frontmatter (comma-separated,
// or a `[a, b]` list) tags it for search; topics are not board labels,
// and `labels: memory` stays the one marker. Adopt refuses an empty
// body, a Why with no fact, a second fact or a second Why, and a fact
// or Why too long to be one sentence-sized unit.
//
// The section's grammar, which `parseLearned` here and the daemon's
// `memory_index::parse_learned` both read -- the daemon rebuilds its
// search index from this text alone, so it must say everything:
//
//   ### Learned
//
//   - <fact>[ (topics: <topic>, <topic>)]
//     Why: <reason>
//
// - A memory opens on a line starting `- ` or `* ` at column 0.
// - A trailing ` (topics: …)` on that line is its topics: split on
//   commas, trimmed, lower-cased, empties and repeats dropped. Any other
//   parenthesis is part of the fact.
// - Indented lines continue it. One starting `Why:` opens the reason;
//   any other is joined with a space onto the fact, or onto the reason
//   once one is open (a hand-wrapped line, or an older multi-line Why).
// - Anything else -- blank lines, prose at column 0 -- belongs to no
//   memory and ends the one before it.
//
// `test-fixtures/learned-memories/cases.json` holds both readers to
// this: a case added there is asserted in TS and in Rust.

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

/// One memory, as a card states it and as `### Learned` holds it.
export interface Memory {
  fact: string;
  topics: string[];
  why: string | null;
}

/// Why a card cannot be adopted, named so tests (and the shared
/// fixture) can say which refusal without matching prose.
export type MemoryRefusal = "empty" | "no-fact" | "multi-fact" | "too-long";

/// Sentence-sized, generously: the fact is what a search returns and
/// what an agent reads in one glance, and the Why is one reason.
export const MAX_FACT_CHARS = 300;
export const MAX_WHY_CHARS = 500;

const WHY_RE = /^why:\s*/i;
const TOPICS_SUFFIX_RE = /\s*\(topics:([^()]*)\)\s*$/i;

/// A `topics:` value as a list: commas, an optional `[ ]` around them,
/// lower-cased so "PTY" and "pty" are one topic. The characters the
/// Learned suffix uses as syntax cannot survive into a topic.
export function normalizeTopics(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const t = part
      .replace(/[()"']/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/// The card's `topics:` frontmatter value, raw. Read here rather than
/// off `CardView`: topics mean nothing to the board, and Adopt reads
/// the file fresh anyway.
export function cardTopicsField(fileContent: string): string | null {
  const lines = fileContent.split("\n");
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length && lines[i] !== "---"; i += 1) {
    const m = /^topics:\s*(.*)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

const REFUSALS: Record<MemoryRefusal, (n?: number) => string> = {
  empty: () => "This card has no body, so there is no memory to adopt.",
  "no-fact": () =>
    "This card has a Why: line but no fact above it. The first line of the body is the memory.",
  "multi-fact": () =>
    "A memory is one fact line plus an optional Why: line, and this card holds more. Split the rest into cards of their own.",
  "too-long": (n) =>
    `This memory is ${n} characters, which is more than one fact (a fact is at most ${MAX_FACT_CHARS}, a Why: at most ${MAX_WHY_CHARS}). Shorten it or split it.`,
};

/// The card as one memory, or the reason it is not one.
export function parseMemoryCard(
  fileContent: string
): Memory | { refuse: MemoryRefusal; error: string } {
  const refuse = (kind: MemoryRefusal, n?: number) => ({ refuse: kind, error: REFUSALS[kind](n) });
  const lines = stripFrontmatter(fileContent)
    .split("\n")
    .map((l) => l.trim())
    // A body already written as a bullet ("- fact") must not adopt as
    // "- - fact": the list marker is `memoryBullet`'s to add.
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return refuse("empty");
  if (WHY_RE.test(lines[0])) return refuse("no-fact");
  if (lines.length > 2 || (lines.length === 2 && !WHY_RE.test(lines[1]))) return refuse("multi-fact");
  // The suffix is Learned's syntax; a fact that already ends in one
  // would read back with topics the card never declared.
  const fact = lines[0].replace(TOPICS_SUFFIX_RE, "");
  const why = lines.length === 2 ? lines[1].replace(WHY_RE, "").trim() : null;
  if (fact.length > MAX_FACT_CHARS) return refuse("too-long", fact.length);
  if (why !== null && why.length > MAX_WHY_CHARS) return refuse("too-long", why.length);
  return { fact, topics: normalizeTopics(cardTopicsField(fileContent)), why: why || null };
}

/// A memory as the markdown bullet `### Learned` holds: the fact and
/// its topics on the bullet line, the Why indented under it so the
/// whole memory stays one list item.
export function memoryBullet(memory: Memory): string {
  const topics = memory.topics.length > 0 ? ` (topics: ${memory.topics.join(", ")})` : "";
  const head = `- ${memory.fact}${topics}`;
  return memory.why ? `${head}\n  Why: ${memory.why}` : head;
}

/// Every memory in a run of Learned text, by the grammar in this file's
/// header. Lenient where the card is strict: the section is the human's
/// to hand-edit, and a memory adopted before the one-fact rule must
/// still read back.
export function parseLearned(section: string): Memory[] {
  const out: Memory[] = [];
  let cur: Memory | null = null;
  const flush = () => {
    if (cur && cur.fact) out.push(cur);
    cur = null;
  };
  for (const raw of section.split("\n")) {
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      const line = bullet[1].trim();
      const m = TOPICS_SUFFIX_RE.exec(line);
      cur = {
        fact: m ? line.slice(0, m.index).trim() : line,
        topics: normalizeTopics(m ? m[1] : null),
        why: null,
      };
    } else if (cur && /^\s+\S/.test(raw)) {
      const line = raw.trim();
      if (WHY_RE.test(line) && cur.why === null) {
        cur.why = line.replace(WHY_RE, "").trim();
      } else if (cur.why !== null) {
        cur.why = `${cur.why} ${line}`.trim();
      } else {
        cur.fact = `${cur.fact} ${line}`;
      }
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/// The memories a whole instructions file holds: its marker block's
/// `### Learned` section to the end of the block, the span
/// agent_setup.rs carries across a re-merge. Empty for a file with no
/// block or no section.
export function learnedMemories(instructions: string): Memory[] {
  const start = instructions.indexOf(MARKER_START);
  const end = instructions.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return [];
  const inner = instructions.slice(start + MARKER_START.length, end).split("\n");
  const at = inner.findIndex((l) => l.trimEnd() === LEARNED_HEADING);
  return at === -1 ? [] : parseLearned(inner.slice(at + 1).join("\n"));
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
  // Matched by fact, not by line: the same fact adopted again with
  // other topics or another Why is still the same memory.
  const fact = parseLearned(bullet)[0]?.fact;
  if (inner.split("\n").includes(bullet.split("\n")[0])) return { content: instructions };
  if (fact !== undefined && learnedMemories(instructions).some((m) => m.fact === fact)) {
    return { content: instructions };
  }
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
    const memory = parseMemoryCard(cardFile.content);
    if ("refuse" in memory) return { error: memory.error };
    const bullet = memoryBullet(memory);
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
