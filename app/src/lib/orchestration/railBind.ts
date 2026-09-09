// The four settings a rail carries -- WHICH checkout, on WHICH branch,
// WHERE its sessions land and WHAT starts it -- as one vocabulary, so the
// dialog that sets them and the surfaces that offer it agree on what they
// are called.
//
// The first three are bindings and the fourth is a condition, which is
// why the dialog is titled after how a rail runs rather than where. They
// share a home because they are the same question asked four ways -- the
// standing facts about a rail, none of which belongs on a card or a step
// -- and because a human who opens this from one chip should find the
// other three without being told they exist.
//
// It used to be three stacked sections in a dialog called "Bind", opened
// by a button that showed two of those three values and by conflict rows
// that said "Bind worktree…" even when the repair was a branch. Nothing
// on the way in said the dialog could set a page at all. The tabs are the
// fix, and a tab is only useful if every surface can name one: the rail
// header's chips, the conflict box's repair button and the dialog's own
// strip all address a tab by id from here.
import type { Conflict, RailTrigger } from "$lib/orchestration/orchestration";
import { railTriggerLabel } from "$lib/orchestration/orchestration";

export type RailBindTab = "worktree" | "branch" | "page" | "trigger";

export interface RailBindTabMeta {
  id: RailBindTab;
  /// The tab's word, and the noun its panel is about.
  label: string;
}

/// Trigger, then checkout, then branch, then page: what starts the rail
/// and then the order the rest take effect in once something has -- which
/// is the order the rail header reads them in.
export const RAIL_BIND_TABS: RailBindTabMeta[] = [
  { id: "trigger", label: "Trigger" },
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
  /// Whether the rail actually carries this setting. False is not an
  /// error -- every one of the four has a working default, a trigger's
  /// being "only a human starts it" -- so an unset chip is drawn quietly
  /// rather than as a warning.
  bound: boolean;
  /// The whole truth, for a tooltip: what the binding does, or what the
  /// default does and what picking one would change.
  tip: string;
  /// Drawn as a warning rather than quietly. Only the trigger chip sets
  /// it, and only for a condition that can never fire as written (see
  /// `railTriggerVerdict`): the other three degrade to a working default,
  /// but a broken trigger means a rail that waits forever, and nothing
  /// but a human changes that.
  warn?: boolean;
}

/// The rail's own bindings, as little as this module needs. Taken as a
/// shape rather than as a `Rail` so a caller can ask about a binding it
/// is about to write.
export interface RailBindings {
  worktreePath: string | null;
  branch?: string | null;
  pageId: string | null;
  trigger?: RailTrigger | null;
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
  if (tab === "trigger") {
    const trigger = rail.trigger ?? null;
    return {
      tab,
      label: "Trigger",
      value: railTriggerLabel(trigger),
      bound: trigger !== null,
      tip:
        trigger === null
          ? "Only you start this rail — or a Start rail step on another one. Give it a condition to have gavin arm it for you."
          : "Gavin arms this rail by itself when its condition holds. Its own state and its steps are unchanged: a paused rail stays paused, and a rail with nothing unfinished has nothing to start.",
    };
  }
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

/// All four, in tab order.
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
