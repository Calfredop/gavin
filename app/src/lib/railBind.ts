// The three bindings a rail carries -- WHICH checkout, on WHICH branch,
// and WHERE its sessions land -- as one vocabulary, so the dialog that
// sets them and the surfaces that offer it agree on what they are called.
//
// It used to be three stacked sections in a dialog called "Bind", opened
// by a button that showed two of the three values and by conflict rows
// that said "Bind worktree…" even when the repair was a branch. Nothing
// on the way in said the dialog could set a page at all. The tabs are the
// fix, and a tab is only useful if every surface can name one: the rail
// header's chips, the conflict box's repair button and the dialog's own
// strip all address a tab by id from here.
import type { Conflict } from "./orchestration";

export type RailBindTab = "worktree" | "branch" | "page";

export interface RailBindTabMeta {
  id: RailBindTab;
  /// The tab's word, and the noun its panel is about.
  label: string;
}

/// Checkout, then branch, then page: the order they take effect in when
/// a step launches, and the order the rail header reads them in.
export const RAIL_BIND_TABS: RailBindTabMeta[] = [
  { id: "worktree", label: "Worktree" },
  { id: "branch", label: "Branch" },
  { id: "page", label: "Page" },
];

/// The last segment of a checkout path. A worktree is a sibling folder
/// named after its branch, so the segment is the part that identifies it;
/// the whole path is long enough to eat a 280px rail column on its own,
/// and it survives in the chip's tooltip.
export function checkoutLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  const last = at === -1 ? trimmed : trimmed.slice(at + 1);
  return last === "" ? path : last;
}

export interface RailBindChip {
  tab: RailBindTab;
  label: string;
  /// What this binding is set to right now, short enough for a chip.
  value: string;
  /// Whether the rail actually carries this binding. False is not an
  /// error -- every one of the three has a working default -- so an
  /// unset chip is drawn quietly rather than as a warning.
  bound: boolean;
  /// The whole truth, for a tooltip: what the binding does, or what the
  /// default does and what picking one would change.
  tip: string;
}

/// The rail's own bindings, as little as this module needs. Taken as a
/// shape rather than as a `Rail` so a caller can ask about a binding it
/// is about to write.
export interface RailBindings {
  worktreePath: string | null;
  branch?: string | null;
  pageId: string | null;
}

/// One binding, said the same way everywhere it is offered.
///
/// `pageName` is resolved by the caller, because only the layout store
/// knows it -- and null covers both "no page bound" and "bound to a page
/// that has since been closed", which behave identically: the next launch
/// makes a new one.
export function railBindChip(
  tab: RailBindTab,
  rail: RailBindings,
  pageName: string | null
): RailBindChip {
  if (tab === "worktree") {
    const path = rail.worktreePath;
    return {
      tab,
      label: "Worktree",
      value: path === null ? "no worktree" : checkoutLabel(path),
      bound: path !== null,
      tip:
        path === null
          ? "This rail's steps run in each card's own folder — pick a worktree to give it a checkout of its own"
          : `This rail's steps run in ${path}`,
    };
  }
  if (tab === "branch") {
    const branch = rail.branch ?? null;
    return {
      tab,
      label: "Branch",
      value: branch ?? "any branch",
      bound: branch !== null,
      tip:
        branch === null
          ? "This rail runs on whatever is checked out — pick a branch to pin it"
          : `Gavin switches this rail's checkout to ${branch} before its first step`,
    };
  }
  return {
    tab,
    label: "Page",
    value: pageName ?? "page at launch",
    bound: pageName !== null,
    tip:
      pageName === null
        ? "This rail's first launch gives it a page of its own, named after it — pick a page to send its sessions somewhere you already have"
        : `This rail's agent sessions land on “${pageName}”`,
  };
}

/// All three, in tab order.
export function railBindChips(rail: RailBindings, pageName: string | null): RailBindChip[] {
  return RAIL_BIND_TABS.map((t) => railBindChip(t.id, rail, pageName));
}

/// The tab a conflict's repair button opens, and what that button says.
///
/// The button used to read "Bind worktree…" for every rail-level conflict
/// including the one whose cause is a missing BRANCH, and then dropped
/// the reader at the top of a dialog that had the branch list two
/// sections down. Naming the binding and landing on it is the same fix
/// said twice.
export function railBindFix(kind: Conflict["kind"]): { tab: RailBindTab; label: string } {
  if (kind === "branch-missing") return { tab: "branch", label: "Pick another branch…" };
  if (kind === "worktree-missing") return { tab: "worktree", label: "Pick another worktree…" };
  // rail-unbound, and any rail-level kind added later: the worktree is
  // the binding a rail is normally missing.
  return { tab: "worktree", label: "Give it a worktree…" };
}

/// Arrow-key movement across the tab strip, per the WAI-ARIA tabs
/// pattern: Left/Right wrap, Home/End jump to the ends, everything else
/// is not ours. Null means "leave the event alone" -- swallowing keys a
/// tablist does not own is how Escape stops closing the modal.
export function railBindTabAfterKey(current: RailBindTab, key: string): RailBindTab | null {
  const ids = RAIL_BIND_TABS.map((t) => t.id);
  const at = ids.indexOf(current);
  if (at === -1) return null;
  if (key === "ArrowRight") return ids[(at + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(at - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}
