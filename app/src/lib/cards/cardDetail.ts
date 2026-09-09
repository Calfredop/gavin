// What the card detail panel asks of the human first, and what it folds
// away.
//
// ## Why this exists
//
// The panel used to be one long scroll in a fixed order: identity, every
// editable field, the attachments, the checklist, the nested tasks, the
// card's own text -- and only then the agent session. On a task whose
// prompt runs to a paragraph or two that put "Jump to session" below the
// bottom of the panel. So the one card the panel has something URGENT to
// say about, the one whose agent is waiting for a human, was exactly the
// card whose one useful control had to be hunted for.
//
// The rule the rework encodes: the distance to the action must not
// depend on how much the human wrote in the card. The panel therefore
// pins a session bar above its scroller, and this module decides what
// that bar says and which buttons it carries.
//
// It is deliberately NOT `cardMenu.ts`, which answers the neighbouring
// question for a right-click. A menu offers the list of everything
// possible; a bar leads with what this situation is ABOUT, and carries
// the rest of the reach-the-agent actions beside it in a fixed order.
// Bookkeeping (Unlink), evidence (Changes, Run history) and settings
// stay in the scroller: they are things to know, not things the run is
// waiting on.

import type { SessionStatus } from "$lib/core/notifications";
import type { IndicatorTone } from "$lib/ui/indicators";

/// Where a card's bound session stands. `cardSessionState`
/// (columnRunAction.ts) is the one place that vocabulary is derived; the
/// bar takes its answer rather than growing a second derivation.
export type CardSessionPhase = "live" | "interrupted" | "failed" | "exited";

/// Everything the bar needs to know, and nothing about the card's text.
export type CardSituation =
  /// A note, or any card with no agent story at all: no bar is drawn.
  | { kind: "none" }
  /// N agents on one card, and a decision owed. The candidates are rows
  /// of their own under the bar, so the bar states the situation and
  /// carries no button.
  | { kind: "best-of-n"; summary: string }
  /// A "Develop into a plan…" run is rewriting this card.
  | { kind: "developing" }
  | {
      kind: "bound";
      phase: CardSessionPhase;
      /// The daemon's status for the session id. Consulted only while
      /// the phase is `live`: an interrupted id holds the bare shell
      /// that replaced the agent, and its status describes the shell.
      status: SessionStatus | null;
      /// The daemon found the agent's process still running.
      orphan: boolean;
    }
  | {
      kind: "unbound";
      cardKind: "task" | "plan";
      /// A thin To Do card can be interviewed before it is executed.
      canDevelop: boolean;
      /// The workspace's agent takes no prompt, so nothing that composes
      /// a command line can run. Re-launch is never blocked by it: that
      /// replays a stored command rather than building one.
      runBlocked: boolean;
    };

export type CardActionId =
  | "end-orphan"
  | "resume"
  | "jump"
  | "relaunch"
  | "run"
  | "develop"
  | "best-of-n"
  | "develop-jump";

export interface CardBarAction {
  id: CardActionId;
  label: string;
  /// A disabled action is still DRAWN: "Jump" greyed beside "Re-launch"
  /// is how an exited session says which of the two is possible. The bar
  /// never silently drops one of a pair.
  enabled: boolean;
  /// Ends something rather than reaching it, and is toned accordingly.
  danger?: boolean;
}

export interface CardSessionBar {
  /// What the situation IS, in a few words. Never a reason or an
  /// instruction -- those are paragraphs, and they live under the bar.
  headline: string;
  tone: IndicatorTone;
  /// True when the run has stopped and a PERSON is what it waits on.
  /// This is the case the pinning exists for, and the bar tints for it.
  wantsHuman: boolean;
  /// Most important first. Empty only where the decision is per-row
  /// (best-of-N), never because there is nothing to do.
  actions: CardBarAction[];
}

/// The daemon's four statuses in the bar's own words. `idle` is
/// deliberately not "finished": an idle agent is one that has been quiet
/// for two seconds, which is a claim about the terminal and not about
/// the work (see agent status is quietness).
const LIVE_HEADLINE: Record<SessionStatus, string> = {
  working: "Working",
  waiting_for_input: "Waiting for you",
  idle: "Idle at its prompt",
  failed: "Stopped — something broke",
  unknown: "Status unknown — a newer daemon wrote it",
};

const LIVE_TONE: Record<SessionStatus, IndicatorTone> = {
  working: "accent",
  waiting_for_input: "warning",
  idle: "neutral",
  failed: "danger",
  unknown: "neutral",
};

/// Statuses that mean the run has stopped and is waiting on a human.
const LIVE_WANTS_HUMAN: Record<SessionStatus, boolean> = {
  working: false,
  waiting_for_input: true,
  idle: false,
  failed: true,
  unknown: false,
};

export function runLabel(cardKind: "task" | "plan"): string {
  return `▶ Run ${cardKind === "plan" ? "this plan" : "this task"} with the agent`;
}

/// The bar for a situation, or null where the card has no agent story
/// (a note). One function, so "what does this card want from me" has a
/// single answer that the panel, its tests and the smoke pass all read.
export function cardSessionBar(situation: CardSituation): CardSessionBar | null {
  switch (situation.kind) {
    case "none":
      return null;

    case "developing":
      return {
        headline: "Being developed — an agent is rewriting this card",
        tone: "accent",
        wantsHuman: false,
        actions: [{ id: "develop-jump", label: "Jump to the develop session", enabled: true }],
      };

    case "best-of-n":
      return {
        // The decision is the situation, so it is said in the headline
        // rather than pushed onto a button that would only scroll.
        headline: `${situation.summary} — keep one`,
        tone: "warning",
        wantsHuman: true,
        actions: [],
      };

    case "bound":
      return boundBar(situation);

    case "unbound": {
      const enabled = !situation.runBlocked;
      const actions: CardBarAction[] = [
        { id: "run", label: runLabel(situation.cardKind), enabled },
      ];
      if (situation.canDevelop) {
        actions.push({ id: "develop", label: "Develop into a plan…", enabled });
      }
      actions.push({ id: "best-of-n", label: "Run it on several agents…", enabled });
      return {
        headline: "No agent on this card",
        tone: "neutral",
        wantsHuman: false,
        actions,
      };
    }
  }
}

function boundBar(situation: Extract<CardSituation, { kind: "bound" }>): CardSessionBar {
  const { phase, orphan } = situation;
  const live = phase === "live";
  const status = situation.status ?? "idle";

  const headline = live
    ? LIVE_HEADLINE[status]
    : phase === "interrupted"
      ? "Interrupted — the daemon restarted mid-run"
      : phase === "failed"
        ? "Stopped — something broke"
        : "The session is gone";

  const tone: IndicatorTone = live
    ? LIVE_TONE[status]
    : phase === "interrupted"
      ? "warning"
      : phase === "failed"
        ? "danger"
        : "neutral";

  const wantsHuman = live ? LIVE_WANTS_HUMAN[status] : phase !== "exited";

  const actions: CardBarAction[] = [];
  // First, and ahead of Resume: an agent that never stopped is the
  // second-agent-in-one-checkout outcome, and Resume is the button right
  // beside this one. An orphan also outranks the phase for tone -- a
  // process nobody is watching is the more urgent of the two facts.
  if (orphan) {
    actions.push({ id: "end-orphan", label: "End the running process", enabled: true, danger: true });
  }
  if (phase === "interrupted" || phase === "failed") {
    actions.push({ id: "resume", label: "Resume this card", enabled: true });
  }
  actions.push({ id: "jump", label: "Jump to session", enabled: live });
  actions.push({ id: "relaunch", label: "Re-launch", enabled: !live });

  return {
    headline: orphan ? `${headline} · its process is still running` : headline,
    tone: orphan ? "danger" : tone,
    wantsHuman: wantsHuman || orphan,
    actions,
  };
}

// ---- folded sections ---------------------------------------------------
//
// Three blocks the panel keeps but does not lead with. Folding them is
// what buys the card's own text a screenful: a card's labels, its
// attachments and its rail are things you come to the panel to CHANGE,
// which is rarer than coming to read it or to reach its agent.
//
// A folded section still says what it holds -- `sectionSummary` below --
// because a fold that hides whether anything is in there just moves the
// hunt one click along.

export type CardSectionId = "session" | "settings" | "rail";

export const CARD_SECTION_IDS: readonly CardSectionId[] = ["session", "settings", "rail"];

export type CardSectionsOpen = Record<CardSectionId, boolean>;

/// Session details open, the two settings blocks folded. The run's own
/// evidence (where it ran, what it changed, what it has done before) is
/// the half of the panel a human reads; labels and rails are the half
/// they occasionally edit.
export const DEFAULT_SECTIONS_OPEN: CardSectionsOpen = {
  session: true,
  settings: false,
  rail: false,
};

/// A per-human view preference, not workspace data -- what is folded on
/// this screen is not a fact about the project -- so it goes where the
/// sidebar's expansion and the smoke ticks already live: localStorage.
/// No daemon request, so no protocol bump and no compat gate.
///
/// App-wide rather than per card: the answer is about how this human
/// reads a card, and per-card entries would grow a record for the life
/// of the install with no id that can ever be pruned (a card's path is
/// rewritten by every archive and every Done).
export const CARD_SECTION_KEY = "gavin.cardDetailSections";

/// Storage is injected (defaulting to the browser's) so this module stays
/// testable under vitest's node environment, where localStorage does not
/// exist at all -- and so an SSR pass simply remembers nothing.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// Unknown, absent and corrupt all read as the defaults: a panel that
/// threw on a stale key would be worse than one that forgets.
export function loadSectionsOpen(storage: MaybeStorage = defaultStorage()): CardSectionsOpen {
  const open = { ...DEFAULT_SECTIONS_OPEN };
  try {
    const raw = storage?.getItem(CARD_SECTION_KEY);
    if (!raw) return open;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return open;
    for (const id of CARD_SECTION_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === "boolean") open[id] = value;
    }
    return open;
  } catch {
    return open;
  }
}

export function saveSectionsOpen(
  open: CardSectionsOpen,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(CARD_SECTION_KEY, JSON.stringify(open));
  } catch {
    // Best-effort: a full or blocked storage must never break the panel.
  }
}

/// What the settings fold holds, for its own header. Counts rather than
/// names: the header is one line beside a chevron, and a card with four
/// labels would push its own chevron off the row.
export function settingsSummary(input: {
  labels: number;
  attachments: number;
  brokenAttachments: number;
  autoCommit: boolean;
  autoCommitApplies: boolean;
}): string {
  const parts: string[] = [];
  parts.push(input.labels === 0 ? "no labels" : `${input.labels} label${input.labels === 1 ? "" : "s"}`);
  if (input.brokenAttachments > 0) {
    // The one fact in here that BLOCKS a run, so it is said even folded.
    parts.push(`⚠ ${input.brokenAttachments} missing attachment${input.brokenAttachments === 1 ? "" : "s"}`);
  } else {
    parts.push(
      input.attachments === 0
        ? "no attachments"
        : `${input.attachments} attachment${input.attachments === 1 ? "" : "s"}`
    );
  }
  if (input.autoCommitApplies) parts.push(input.autoCommit ? "auto commit on" : "auto commit off");
  return parts.join(" · ");
}

/// What the rail fold holds. Says where the card's step SITS, because
/// that is the fact a folded rail section would otherwise hide, and the
/// only reason to open it is to move it.
export function railSummary(input: {
  railCount: number;
  railName: string | null;
  stageNumber: number | null;
  stageCount: number | null;
  stepState: string | null;
}): string {
  if (input.railCount === 0) return "no rails yet";
  if (input.railName === null) return "not on a rail";
  const where =
    input.stageNumber !== null && input.stageCount !== null
      ? `${input.railName} · stage ${input.stageNumber} of ${input.stageCount}`
      : input.railName;
  return input.stepState ? `${where} · ${input.stepState}` : where;
}
