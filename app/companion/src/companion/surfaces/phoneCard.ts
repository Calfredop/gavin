// One card, as a phone draws it.
//
// Every word and every rule is the desk's: the card is the board's own
// projection (`mergePlanCards`), its session bar is the card detail's
// (`cardSituation`, `cardSessionBar`), its items are the Decisions tab's
// (`pendingItems`). What this adds is what a phone needs of them -- the
// card found again after its file has moved, the checklist without the
// lines that are answered rather than ticked, and the bar cut to the
// actions a Device can take.
import type { CardSessionBar, CardActionId } from "$lib/cards/cardDetail";
import type { ChecklistItem } from "$lib/cards/planChecklist";
import type { GavinTree, HumanItem, PlanFileInfo } from "$lib/core/gavin";
import type { CardView, DisplayColumn } from "$lib/core/planBoard";
import { resolvePrdPath } from "$lib/core/settings";
import { humanItemWaiting, pendingItems } from "$lib/decisions/decisions";

/// What `mergePlanCards` hands back: every card on the board, and the
/// archived ones beside it.
export interface CardProjection {
  columns: DisplayColumn[];
  autoColumns: { planCards: CardView[] }[];
  archived: CardView[];
}

function* everyCard(projection: CardProjection): Generator<CardView> {
  const walk = function* (cards: CardView[]): Generator<CardView> {
    for (const card of cards) {
      yield card;
      yield* walk(card.nestedChildren);
    }
  };
  for (const column of projection.columns) yield* walk(column.planCards);
  for (const column of projection.autoColumns) yield* walk(column.planCards);
  yield* walk(projection.archived);
}

/// The `plans/` a card is filed under, which its moves stay within.
function plansRootOf(path: string): string | null {
  const at = path.lastIndexOf("/plans/");
  return at === -1 ? null : path.slice(0, at + "/plans".length);
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/// The card at `path`, nested tasks and all -- or, when no card is there
/// any more, the one it became. A card's path is its identity, and the
/// daemon rewrites it on the way into `done/` and `archive/` and back;
/// the file name is what a context holds once, so a card by that name
/// under the same `plans/` is the same card, moved. Null when neither is
/// on the board or in its archive: deleted, or never there.
export function findCard(projection: CardProjection | null, path: string): CardView | null {
  if (!projection) return null;
  const cards = [...everyCard(projection)];
  const exact = cards.find((card) => card.id === path);
  if (exact) return exact;
  const root = plansRootOf(path);
  const name = fileNameOf(path);
  return (root && cards.find((card) => plansRootOf(card.id) === root && card.fileName === name)) || null;
}

/// Every card on the board and in its archive, nested ones included: what
/// the desk's `childCards` and `parentCard` look a card's relations up in.
export function allCards(projection: CardProjection | null): CardView[] {
  return projection ? [...everyCard(projection)] : [];
}

/// The card's file as the tree last read it: where its human items are.
export function planOf(tree: GavinTree | undefined, path: string): PlanFileInfo | null {
  for (const ctx of tree?.contexts ?? []) {
    const plan = ctx.plans.find((p) => p.path === path);
    if (plan) return plan;
  }
  return null;
}

/// The decisions and tests still owed on a card, in file order: what the
/// card page offers to answer.
export function owedItems(tree: GavinTree | undefined, path: string): HumanItem[] {
  const plan = planOf(tree, path);
  return plan ? pendingItems(plan) : [];
}

/// How many of a card's items wait on the human -- not a failed test,
/// which the agent owes. What the board marks a card with.
export function waitingCount(tree: GavinTree | undefined, path: string): number {
  return (planOf(tree, path)?.humanItems ?? []).filter(humanItemWaiting).length;
}

/// The checklist a thumb ticks: every item but the human ones, which are
/// answered, passed or failed rather than ticked -- a tick would settle a
/// decision with no answer written under it.
export function tickableItems(checklist: ChecklistItem[], tree: GavinTree | undefined, path: string): ChecklistItem[] {
  const human = new Set((planOf(tree, path)?.humanItems ?? []).map((item) => item.lineIndex));
  return checklist.filter((item) => !human.has(item.lineIndex));
}

/// The bar's actions a Device can take. Reaching the agent, resuming it,
/// running the card and running it again are the desk's own launches
/// (state/cards.ts). The rest are the desk's to do: several agents and a
/// develop run are chosen in dialogs of the desk's, and ending a stray
/// process is a decision made watching it.
const DEVICE_ACTIONS: readonly CardActionId[] = ["jump", "resume", "relaunch", "run"];

export function deviceBar(bar: CardSessionBar | null): CardSessionBar | null {
  if (!bar) return null;
  return { ...bar, actions: bar.actions.filter((action) => DEVICE_ACTIONS.includes(action.id)) };
}

/// Where a workspace's PRD is: its root context's `prd`, else the path a
/// workspace that never chose one reads. Null for a workspace with no
/// folder, which has none.
export function prdPathOf(rootPath: string | undefined, tree: GavinTree | undefined): string | null {
  if (!rootPath) return null;
  return `${rootPath}/${resolvePrdPath(tree?.contexts.find((c) => c.kind === "root"))}`;
}
