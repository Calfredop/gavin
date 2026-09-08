// Contextual run actions for the board's permanent columns. One "Run
// all" meant the same thing everywhere, which read as a lie in two of
// the three canonical statuses: a To Do card has never started, an In
// Progress card stopped halfway, and a Done card is finished. The
// column's NAME is all the context the button needs -- it picks the
// verb, the prompt the spawned agent gets (cardRun.ts), which cards
// count as targets, and whether the button exists at all.
//
// Custom columns keep the neutral "Run all": their name is the human's
// vocabulary, and gavin has no idea what it means.

import { slugStatus, type CardView } from "./planBoard";
import { sessionLiveness, type WorkspacesData } from "./workspace";
import { count } from "./railConfirm";
import { estimateLines, type LaunchEstimate } from "./launchEstimate";

/// "start" and "run" spawn the ordinary run prompt; "resume" spawns the
/// gavin-resume one.
export type ColumnRunMode = "start" | "resume" | "run";

export interface ColumnRunAction {
  mode: ColumnRunMode;
  /// The verb, as the header menu says it.
  label: string;
  /// aria-label for the header button.
  aria: string;
}

/// A card's binding as the board sees it: a live session, a session whose
/// run was killed with the daemon and replaced by a bare shell, a session
/// that has exited (the binding outlives it), or no binding at all.
export type CardSessionState = "live" | "interrupted" | "failed" | "exited" | "none";

/// The one place a card's binding is turned into that vocabulary, so
/// every surface that asks "is this card busy?" answers identically.
///
/// `interrupted` used to be indistinguishable from `live`: the bare shell
/// the daemon puts back carries the ORIGINAL session id, so the layout
/// tree still holds it and `findSessionLocation` still finds it. Run and
/// Resume both jumped to it, and Develop refused with "this card has a
/// live agent" -- for a tab with nothing running in it at all.
export function cardSessionState(
  state: WorkspacesData & {
    interruptedSessionIds: ReadonlySet<string>;
    failureReasonById?: Record<string, string>;
  },
  binding: { sessionId: string } | null
): CardSessionState {
  if (!binding) return "none";
  switch (sessionLiveness(state, binding.sessionId)) {
    case "live":
      return "live";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "gone":
      return "exited";
  }
}

const TO_DO: ColumnRunAction = {
  mode: "start",
  label: "Start all",
  aria: "Start every card in this column",
};
const IN_PROGRESS: ColumnRunAction = {
  mode: "resume",
  label: "Resume",
  aria: "Resume the stopped cards in this column",
};
const CUSTOM: ColumnRunAction = {
  mode: "run",
  label: "Run all",
  aria: "Run all unbound cards",
};

/// What this column's run button does, or null when it has none. Done
/// gets none: finishing a card is the human's call, and a whole column
/// of finished work is the last thing to re-run by accident. Single
/// cards there still run from the card itself or a multi-select.
export function columnRunAction(columnName: string): ColumnRunAction | null {
  switch (slugStatus(columnName)) {
    case "to-do":
      return TO_DO;
    case "in-progress":
      return IN_PROGRESS;
    case "done":
      return null;
    default:
      return CUSTOM;
  }
}

/// What the button would actually spawn. Notes never run, and a LIVE
/// session is the work itself -- running would only jump to it. Resume
/// parts company there: a card whose agent exited is the whole reason In
/// Progress needs its own verb, so it counts as a target even though its
/// binding is still on file. An INTERRUPTED one is the same case with a
/// sharper claim on the verb -- its agent stopped mid-run, in a checkout
/// that carries whatever it had already written, which is precisely what
/// the resume prompt is for. Start and Run stay unbound-only, the way
/// Run all always behaved.
///
/// A card being DEVELOPED is out of every mode (developingCards.ts). The
/// launch would refuse it anyway, but the count is the point: "Start all
/// (7 unbound)" that starts six is a button that lied about its own
/// scope, and this is the column where a thin To Do card sits while an
/// agent is busy turning it into a real one.
export function columnRunTargets(
  cards: CardView[],
  mode: ColumnRunMode,
  sessionState: (id: string) => CardSessionState,
  developing: (id: string) => boolean
): CardView[] {
  return cards.filter((c) => {
    if (c.kind === "note") return false;
    if (developing(c.id)) return false;
    const state = sessionState(c.id);
    if (state === "live") return false;
    return mode === "resume" || state === "none";
  });
}

function cards(count: number): string {
  return count === 1 ? "card" : "cards";
}

/// The header button's tooltip.
export function columnRunTip(action: ColumnRunAction, count: number): string {
  switch (action.mode) {
    case "start":
      return `Start ${count} unbound ${cards(count)} with the workspace agent`;
    case "resume":
      return (
        `Resume ${count} stopped ${cards(count)} — each agent picks up the work ` +
        `already done instead of starting over`
      );
    case "run":
      return `Run ${count} unbound ${cards(count)} with the workspace agent`;
  }
}

/// The header context menu's entry.
export function columnRunMenuLabel(action: ColumnRunAction, count: number): string {
  return action.mode === "resume"
    ? `${action.label} (${count} stopped)`
    : `${action.label} (${count} unbound)`;
}

function runVerb(mode: ColumnRunMode): string {
  switch (mode) {
    case "start":
      return "Start";
    case "resume":
      return "Resume";
    case "run":
      return "Run";
  }
}

/// What a column's "Run all" (Start all / Resume / Run all) asks before
/// it fires. The button used to launch on the click itself -- one whole
/// column's worth of agent spawns with no second look -- so this names
/// exactly who is about to run, the same discipline railConfirm.ts uses
/// for the Orchestration tab's own Run all.
export interface ColumnRunPrompt {
  title: string;
  lines: string[];
  confirmLabel: string;
}

export function columnRunAllConfirm(
  action: ColumnRunAction,
  columnName: string,
  targets: CardView[],
  /// What this press is projected to cost (launchEstimate.ts). Optional
  /// so a test about the column arithmetic need not build a machine
  /// sample; the column header always passes one.
  estimate?: LaunchEstimate | null
): ColumnRunPrompt {
  const n = targets.length;
  const verb = runVerb(action.mode);
  return {
    title: `${verb} ${count(n, "card")} in "${columnName}"?`,
    lines: [
      `${columnRunTip(action, n)}.`,
      `${verb}s: ${targets.map((c) => c.title).join(", ")}.`,
      // Last: the lines above say who runs, this one says what it takes.
      ...(estimate ? estimateLines(estimate) : []),
    ],
    confirmLabel: `${verb} ${count(n, "card")}`,
  };
}
