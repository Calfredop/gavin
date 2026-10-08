// "Clean stale …": the Decisions and Review tabs' agent action, which
// hands an agent every item still open on the tab and asks it to close
// the ones nothing is waiting on any more.
//
// One action for both tabs because the two lists are one kind of thing
// -- `Decision:` and `Human test:` lines are both human items, parsed by
// one rule (decisions.ts) -- and the only difference is which kind the
// tab lists. A decision whose card has moved on, or a test of work that
// was redone, sits on the tab for ever: nothing but a person (or an
// agent asked to look) can tell that it no longer asks anything.
//
// The agent closes an item by TICKING it and writing a dated line under
// it, never by deleting it: a ticked item is settled by
// `humanItemPending`'s own rule, so it leaves both tabs, and the line is
// the record a reviewer reads of why it went. The line deliberately
// starts with none of the daemon's outcome prefixes (`Answer (`,
// `Result (`), so it records no answer the human never gave and no
// test result nobody ran.
//
// Pure. `cleanStaleActions.ts` owns the launch.

import type { HumanItem } from "$lib/core/gavin";
import { fillTemplate } from "$lib/agents/actionPromptDefaults";

/// Which tab is asking: its items are `Decision:` lines or `Human test:`
/// lines, never both.
export type CleanKind = "decisions" | "tests";

/// One card's open items, as the tab lists them.
export interface CleanEntry {
  cardPath: string;
  title: string;
  items: HumanItem[];
}

const TAB: Record<CleanKind, string> = { decisions: "Decisions", tests: "Review" };
const NOUN: Record<CleanKind, string> = {
  decisions: "`Decision:` items",
  tests: "`Human test:` items",
};
const MARKER: Record<CleanKind, string> = { decisions: "Decision:", tests: "Human test:" };

/// The button's text, and the tab name the run starts with.
export const CLEAN_LABEL: Record<CleanKind, string> = {
  decisions: "Clean stale decisions",
  tests: "Clean stale tests",
};

/// The entries worth sending: cards with at least one item, in the
/// order the tab lists them. A Decisions row whose AGENT is the one
/// waiting carries no items and has nothing on the card to close.
export function cleanEntries(subjects: readonly CleanEntry[]): CleanEntry[] {
  return subjects
    .filter((s) => s.items.length > 0)
    .map((s) => ({ cardPath: s.cardPath, title: s.title, items: s.items }));
}

export function cleanItemCount(entries: readonly CleanEntry[]): number {
  return entries.reduce((n, e) => n + e.items.length, 0);
}

/// Why the button cannot start a run, or null when it can. The version
/// gate first: an older daemon parses no item lines, so an empty list
/// there is not "nothing to clean".
export function cleanBlocker(input: {
  kind: CleanKind;
  entries: readonly CleanEntry[];
  itemsBlockedReason: string | null;
  hasRoot: boolean;
}): string | null {
  if (input.itemsBlockedReason) return input.itemsBlockedReason;
  if (!input.hasRoot) return "This workspace has no root folder — set one on the Settings tab first";
  if (cleanItemCount(input.entries) === 0) {
    return input.kind === "decisions" ? "No card has an open decision" : "No card has a human test owed";
  }
  return null;
}

/// The button's tooltip while it can be pressed.
export function cleanTip(kind: CleanKind, entries: readonly CleanEntry[]): string {
  const items = cleanItemCount(entries);
  const what = kind === "decisions" ? (items === 1 ? "decision" : "decisions") : items === 1 ? "test" : "tests";
  const cards = entries.length === 1 ? "1 card" : `${entries.length} cards`;
  return `Ask an agent to close the ${what} nothing is waiting on any more — ${items} open on ${cards}`;
}

/// The question between the press and the launch, in dialog.ts's
/// ConfirmOptions shape. Not `danger`: nothing is lost -- a closed item
/// stays on its card, ticked, with the reason under it -- but the run
/// does write to every card listed, which is worth one look first.
export function cleanConfirm(
  kind: CleanKind,
  entries: readonly CleanEntry[]
): { title: string; lines: string[]; confirmLabel: string; cancelLabel: string } {
  const items = cleanItemCount(entries);
  const noun = kind === "decisions" ? "decision" : "human test";
  const what = `${items} open ${noun}${items === 1 ? "" : "s"}`;
  const cards = entries.length === 1 ? "1 card" : `${entries.length} cards`;
  return {
    title: kind === "decisions" ? "Clean stale decisions?" : "Clean stale tests?",
    lines: [
      `An agent reads the ${what} on ${cards} and closes the ones nothing is waiting on any more.`,
      "A closed item is ticked on its card with a dated line saying why; the ones that still need you stay open.",
    ],
    confirmLabel: "Start the agent",
    cancelLabel: "Not now",
  };
}

/// The open items, card by card, as the agent reads them. Each item
/// carries its last outcome line when it has one -- a failed test's
/// note is exactly what says whether the fix it asked for has landed.
export function itemsBlock(kind: CleanKind, entries: readonly CleanEntry[]): string {
  const lines = [`Open ${NOUN[kind]}:`];
  for (const entry of entries) {
    lines.push("", `- ${entry.cardPath} ("${entry.title}")`);
    for (const item of entry.items) {
      lines.push(`  - ${MARKER[kind]} ${item.text}`);
      if (item.options.length > 0) lines.push(`    Options: ${item.options.join(" | ")}`);
      if (item.latest) lines.push(`    ${item.latest}`);
    }
  }
  return lines.join("\n");
}

export function composeCleanPrompt(
  kind: CleanKind,
  entries: readonly CleanEntry[],
  template: string,
  nameTabFirst: string
): string {
  return fillTemplate(template, {
    name_tab_first: nameTabFirst,
    tab: TAB[kind],
    item_noun: NOUN[kind],
    items_block: itemsBlock(kind, entries),
  }).trim();
}
