// The app's one indicator vocabulary.
//
// Before this module every surface invented its own small badge, and the
// only thing carrying meaning was colour. A 6-8px amber dot meant a
// card's priority on the board, unsaved edits on a file tab and a dirty
// checkout on a terminal tab -- three unrelated facts, one glyph. A red
// one meant urgent priority AND an agent waiting for you, side by side in
// the same card header. And the very same "waiting for input" was drawn
// red on the board and in the tab bar but amber in the sidebar two rows
// below, so neither colour could be trusted to mean anything.
//
// The rule this module encodes:
//
//   SHAPE says WHICH question is being answered. TONE says the answer.
//
// Every indicator therefore carries a glyph, and no two axes share one.
// Colour is left with a single job, consistent across the whole app:
//
//   accent   something is happening right now
//   warning  this wants a human
//   danger   this is broken, or the human called it urgent
//   success  finished, clean
//   neutral  at rest; nothing to say
//
// Consequently there are no bare coloured dots left anywhere: a reader
// who cannot name the axis from the glyph alone has found a bug here,
// not a rendering they have to learn.
//
// Pure and unit-tested: `StatusBadge.svelte` is a template over it, and
// the invariants above are asserted in indicators.test.ts rather than
// left to review.

import type { Component } from "svelte";
import {
  ChevronsRight,
  CircleDashed,
  CircleOff,
  CirclePause,
  CircleQuestionMark,
  CircleSlash2,
  GitBranch,
  History,
  LoaderCircle,
  MessageCircleQuestionMark,
  Minus,
  OctagonAlert,
  Pause,
  Pencil,
  Repeat,
  RotateCw,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Square,
  SquareCheck,
  SquareDot,
  SquareX,
  TriangleAlert,
  Unlink2,
} from "@lucide/svelte";
import type { SessionStatus } from "../notifications";
// The rails already own these three; re-declaring them here would be a
// second definition free to drift from the one the scheduler runs on.
import type { RailState, StepAttention, StepState } from "../orchestration";

/// The five meanings colour is allowed to carry. Matches IconButton's own
/// tone scale one for one, so a badge and a button beside it never
/// disagree about what amber means.
export type IndicatorTone = "neutral" | "accent" | "success" | "warning" | "danger";

/// The questions the app's badges answer. One glyph family each; the
/// test enforces that no glyph is shared between two of them.
export type IndicatorAxis = "agent" | "priority" | "git" | "edits" | "shell" | "step" | "rail" | "run";

/// The human-readable name of each axis. Every tooltip leads with it,
/// which is the whole point: the old badges said "amber" and left the
/// reader to guess whether that was about the card, the file or the repo.
export const AXIS_LABEL: Record<IndicatorAxis, string> = {
  agent: "Agent",
  priority: "Priority",
  git: "Git",
  edits: "Edits",
  shell: "Shell",
  step: "Step",
  rail: "Rail",
  run: "Run",
};

export interface Indicator {
  axis: IndicatorAxis;
  /// The state within the axis, lowercase and stable -- used as a CSS
  /// hook and as the test's identity for an indicator.
  state: string;
  icon: Component<{ size?: number }>;
  tone: IndicatorTone;
  /// "Agent · working". Leads with the axis, always, so one glance at the
  /// bubble settles which question the badge was answering.
  tip: string;
  /// The same words for a screen reader. Badges are decorative-looking
  /// but never decorative, so this is required rather than optional.
  label: string;
  /// Spins the glyph. Only ever true for a state that genuinely means
  /// "in motion right now" -- motion is a claim, not decoration.
  spin?: boolean;
}

function make(
  axis: IndicatorAxis,
  state: string,
  icon: Component<{ size?: number }>,
  tone: IndicatorTone,
  detail: string,
  spin = false
): Indicator {
  const tip = `${AXIS_LABEL[axis]} · ${detail}`;
  return { axis, state, icon, tone, tip, label: tip, spin };
}

// ---- agent -------------------------------------------------------------
// What the agent behind a session is doing. Four states, and the app
// shows them on five surfaces (board card, terminal tab, sidebar tab row,
// sidebar tallies, card detail) which between them used to draw three
// different vocabularies.
//
// `working` spins, because it is the one state that means motion.
// `waiting_for_input` deliberately does NOT: an agent that stopped to ask
// you something is standing still, and animating it alongside a genuinely
// running one is what made the two hard to tell apart. It gets the
// warning tone and a question glyph instead -- the whole "wants a human"
// family (a rail's "needs you", the hub tab's attention pip, the
// sidebar's count) already speaks in amber.

const AGENT: Record<
  | "working"
  | "waiting_for_input"
  | "turn_ended"
  | "failed"
  | "unknown"
  | "interrupted"
  | "idle"
  | "exited",
  Indicator
> = {
  working: make("agent", "working", LoaderCircle, "accent", "working", true),
  waiting_for_input: make(
    "agent",
    "waiting_for_input",
    MessageCircleQuestionMark,
    "warning",
    "waiting for you"
  ),
  // The agent stopped talking without the card reaching the done
  // column. Like `exited` this is not a status the daemon reports -- it
  // is read off a running step (see stepAttentions) -- but it is the
  // same axis and the same question, so it lives here rather than
  // becoming a fourth vocabulary on the rails.
  turn_ended: make("agent", "turn_ended", CirclePause, "warning", "turn ended with the card unmoved"),
  // The daemon's own word for an agent that stopped because something
  // broke -- an API error on its screen, a suspend it never came back
  // from -- rather than because it finished. Danger, because the run is
  // broken, and a glyph of its own because every surface used to read
  // the quiet seconds behind it as idle: a finished-looking badge over a
  // run that had not finished.
  failed: make("agent", "failed", OctagonAlert, "danger", "stopped — something broke"),
  // A status this build cannot read, written by a NEWER daemon. Named
  // rather than folded into idle, which is precisely the default that
  // made a broken agent look like a finished one.
  unknown: make(
    "agent",
    "unknown",
    CircleQuestionMark,
    "neutral",
    "unknown status — written by a newer daemon"
  ),
  // Not a daemon status either: the daemon restarted while this agent
  // was working and the run was NOT resumed, so the session id now holds
  // a bare shell. Warning like `turn_ended` -- neither finished nor
  // failed, but unfinished work waiting on a decision.
  interrupted: make(
    "agent",
    "interrupted",
    CircleOff,
    "warning",
    "interrupted — the daemon restarted and this run was not resumed"
  ),
  idle: make("agent", "idle", CircleDashed, "neutral", "idle — nothing running"),
  exited: make("agent", "exited", CircleSlash2, "neutral", "session exited"),
};

/// The badge for a live agent session. Null / undefined means the
/// session exists but the daemon has not said anything about it yet --
/// or that the row is not an agent's at all -- and reads as idle, the
/// same thing every caller drew before this module existed.
export function agentIndicator(status: SessionStatus | null | undefined): Indicator {
  return AGENT[status ?? "idle"];
}

/// A card can stay bound to a session that is long gone. That is not an
/// agent state the daemon reports, so it is its own entry rather than a
/// fifth SessionStatus.
export function agentExitedIndicator(): Indicator {
  return AGENT.exited;
}

/// A run the daemon's restart cut short. Like `exited` it is read off the
/// card's binding rather than reported as a status -- the status of that
/// session id now describes the bare shell that replaced the agent.
export function agentInterruptedIndicator(): Indicator {
  return AGENT.interrupted;
}

/// The failed badge, carrying the agent's own line about what broke when
/// there is one. The reason goes into the bubble rather than beside the
/// glyph: it is a sentence, and the tab bar has no room for sentences.
export function agentFailedIndicator(reason?: string | null): Indicator {
  if (!reason) return AGENT.failed;
  const tip = `${AXIS_LABEL.agent} · stopped — ${reason}`;
  return { ...AGENT.failed, tip, label: tip };
}

/// The agent states in the order a tally should list them: what is
/// moving, what is stuck on you, what broke, then what is merely there.
export const AGENT_STATES = [
  "working",
  "waiting_for_input",
  "failed",
  "interrupted",
  "idle",
  "exited",
] as const;

export function agentIndicatorByState(state: (typeof AGENT_STATES)[number]): Indicator {
  return AGENT[state];
}

// ---- priority ----------------------------------------------------------
// A rank, so the glyph is a ramp: one bar, two, three, four. That alone
// separates the four levels, which matters because the old dots painted
// medium and high the SAME amber (indistinguishable at any size) and drew
// low in --surface-success, a near-black tint used as a foreground.
//
// Colour is then spent only where it earns attention: the bottom two
// levels stay quiet, high asks, urgent alarms.

export type CardPriority = "none" | "low" | "medium" | "high" | "urgent";

const PRIORITY: Record<Exclude<CardPriority, "none">, Indicator> = {
  low: make("priority", "low", SignalLow, "neutral", "low"),
  medium: make("priority", "medium", SignalMedium, "neutral", "medium"),
  high: make("priority", "high", SignalHigh, "warning", "high"),
  urgent: make("priority", "urgent", Signal, "danger", "urgent"),
};

/// null for "none" and for anything unparseable: no priority set is not a
/// priority level, and drawing a badge for it would be four badges where
/// the human set zero.
export function priorityIndicator(priority: CardPriority | string | null | undefined): Indicator | null {
  if (!priority || priority === "none") return null;
  return PRIORITY[priority as Exclude<CardPriority, "none">] ?? null;
}

export const PRIORITY_LEVELS = ["low", "medium", "high", "urgent"] as const;

// ---- git ---------------------------------------------------------------
// The checkout a session sits in. Same GitBranch glyph the sidebar recap
// and the hub's Git tab already use, so the axis is recognisable before
// the tone is read.
//
// Clean is NEUTRAL, not an amber ring. An outlined warning-coloured dot
// was the app's way of saying "nothing to report", which is exactly
// backwards: a quiet fact should be quiet.

export function gitIndicator(dirty: boolean): Indicator {
  return dirty
    ? make("git", "dirty", GitBranch, "warning", "uncommitted changes")
    : make("git", "clean", GitBranch, "neutral", "clean");
}

/// A linked worktree gavin has finished with: its branch landed, nothing
/// is running in it and nothing is uncommitted (worktreeSweep.ts owns
/// that rule). Success rather than warning, because it is the tone for
/// "finished, clean" and that is precisely the claim -- an amber badge
/// here would read as work in trouble rather than work that is over.
export function worktreeStaleIndicator(): Indicator {
  return make("git", "stale", GitBranch, "success", "merged and idle — safe to sweep");
}

// ---- edits -------------------------------------------------------------
// Unsaved changes in a file tab's editor. Its own glyph rather than the
// editor world's filled dot, because a filled dot is precisely the shape
// this module is retiring -- on a tab bar it sat beside the git dot and
// the status dot and the three were told apart by hue alone.

export function unsavedEditsIndicator(): Indicator {
  return make("edits", "unsaved", Pencil, "accent", "unsaved changes");
}

// ---- shell -------------------------------------------------------------
// About the PTY, not the agent inside it: the daemon restarted and this
// session's shell came back fresh. Success-toned because it is a recovery
// that worked, and separated from the agent axis so it never reads as a
// state the agent is in.

///
/// Same glyph, different claim when the restart cut an agent short: green
/// says "your shell came back", amber says "your agent did not". The
/// glyph stays because both are about the PTY; the tone carries the
/// difference, exactly as git's dirty and clean do.
export function shellRestartedIndicator(interrupted = false): Indicator {
  return interrupted
    ? make(
        "shell",
        "restarted-interrupted",
        RotateCw,
        "warning",
        "the daemon restarted while an agent was working here; it was stopped and not restarted — this is a plain shell in the same folder"
      )
    : make("shell", "restarted", RotateCw, "success", "shell restarted after a daemon restart");
}

/// The shell axis's one alarm: a process from a previous daemon lifetime
/// that is STILL RUNNING in this session's folder, with nothing in front
/// of it. Danger, and a different glyph from the restart note -- this is
/// not a note about what happened, it is a live agent editing the
/// checkout, and the only badge on a tab that does something when
/// pressed.
export function shellOrphanIndicator(): Indicator {
  return make(
    "shell",
    "orphaned",
    TriangleAlert,
    "danger",
    "an agent this session left running is still editing this folder"
  );
}

// ---- step --------------------------------------------------------------
// How far the RAIL has got with one step -- not what the agent inside it
// is doing, which is the agent axis above. The two genuinely differ: a
// step is `running` the whole time its agent sits waiting for you, which
// is exactly why the rails draw both marks side by side.
//
// Squares, because circles are the agent's and bars are priority's; a
// step is a box in a queue. `running` is a filled centre -- the rail is
// HERE -- and it does not spin: the agent badge beside it is the thing
// entitled to claim motion, and two spinners in one chip say nothing.
//
// This axis is why the survey was worth doing. On a chip `running` was
// an accent ring and nothing else, so the one state that matters most on
// a rail was the one carried by colour alone; on a step card the same
// state was the word "running" and no glyph at all. Same fact, two
// renderings, neither of them sayable out loud.

const STEP: Record<StepState, Indicator> = {
  pending: make("step", "pending", Square, "neutral", "not started"),
  running: make("step", "running", SquareDot, "accent", "running now"),
  done: make("step", "done", SquareCheck, "success", "done"),
  stalled: make("step", "stalled", SquareX, "danger", "stalled"),
};

export function stepIndicator(state: StepState): Indicator {
  return STEP[state];
}

export const STEP_STATES = ["pending", "running", "done", "stalled"] as const;

// ---- rail --------------------------------------------------------------
// The rail itself, one level up from its steps. Both surfaces that show
// it already spell the state out in words, so the badge is not carrying
// the meaning alone -- what it buys is that the hub's rail list and the
// rail's own header stop keeping private copies of the same tone table.
// They had one each, and the hub's said so in a comment.
//
// `paused` is a bare Pause, the agent axis's `turn_ended` an enclosed
// one: a paused rail was stopped by the human, an ended turn stopped by
// itself.

const RAIL: Record<RailState, Indicator> = {
  idle: make("rail", "idle", Minus, "neutral", "idle — not started"),
  running: make("rail", "running", ChevronsRight, "accent", "running"),
  paused: make("rail", "paused", Pause, "warning", "paused"),
};

export function railIndicator(state: RailState): Indicator {
  return RAIL[state];
}

export const RAIL_STATES = ["idle", "running", "paused"] as const;

/// A rail going ROUND rather than forward: an `until` step's check
/// failed and the step before it is being re-run (orchestrationLoop.ts).
///
/// Not a RailState -- the rail is `running` the whole time, and saying
/// otherwise beside the Pause button would contradict it, exactly as the
/// attention badge does not replace the state word. What this adds is the
/// direction: forward is the ChevronsRight the state badge already
/// draws, and this says the rail is repeating itself.
export function railRetryIndicator(): Indicator {
  return make("rail", "retrying", Repeat, "accent", "re-running a step until a check passes");
}

// ---- run ---------------------------------------------------------------
// How one PAST run of a card ended (`CardRun.outcome`). Mostly one glyph
// with the tone carrying the answer, which is the vocabulary's own rule:
// shape says which question is being asked.
//
// `unlinked` is the exception and earns a second glyph honestly -- it and
// `replaced` are both neutral, because nothing went wrong in either, and
// two states that render identically are two states the reader cannot
// tell apart. The glyph is the distinction the tone cannot make.
//
// The tones are the honest reading, not a severity ramp: a non-zero exit
// is danger because it is the one outcome that says the agent stopped
// badly, and `abandoned` is warning because what it describes is gavin's
// ignorance rather than the run's failure.
//
// Nothing here spins, `running` included. Motion belongs to the agent
// axis: a row in a history is a record of a run, and the live one has an
// agent badge of its own elsewhere saying what it is doing right now.

const RUN_OUTCOMES = ["running", "exited", "failed", "replaced", "unlinked", "abandoned"] as const;
export type RunOutcomeState = (typeof RUN_OUTCOMES)[number];

const RUN: Record<RunOutcomeState, Indicator> = {
  running: make("run", "running", History, "accent", "still running"),
  exited: make("run", "exited", History, "success", "finished"),
  failed: make("run", "failed", History, "danger", "ended with a non-zero exit code"),
  replaced: make("run", "replaced", History, "neutral", "superseded by a later run"),
  unlinked: make("run", "unlinked", Unlink2, "neutral", "unbound from the card"),
  abandoned: make("run", "abandoned", History, "warning", "end not recorded"),
};

/// The badge for a run, off its `outcome` and its exit code. The exit
/// code is what splits `exited` in two: the daemon records one state for
/// "the session ended", and whether that was a clean finish or a crash is
/// the reader's first question.
export function runIndicator(outcome: string, exitCode: number | null): Indicator {
  if (outcome === "exited" && exitCode !== null && exitCode !== 0) return RUN.failed;
  return RUN[outcome as RunOutcomeState] ?? RUN.abandoned;
}

export const RUN_OUTCOME_STATES = RUN_OUTCOMES;

// ---- attention ---------------------------------------------------------
// What a RUNNING step is waiting on a human for. Not an axis of its own:
// all three answers are facts about the agent, so they are agent badges,
// and `asking` is literally the same badge the board card, the terminal
// tab and the sidebar row already draw for `waiting_for_input`. That
// identity is the point -- one agent stuck on a question looked like
// three different things depending on which surface you found it on.
//
// Which is why `failed` maps to the agent's own failed badge rather than
// sharing the amber pause with `turn-ended`: a rail marks a step failed
// when something BROKE, and "the agent stopped talking" is true of that
// too and useless. Same fact, same badge, everywhere it is drawn.

export function attentionIndicator(attention: StepAttention): Indicator {
  if (attention === "asking") return AGENT.waiting_for_input;
  if (attention === "failed") return AGENT.failed;
  return AGENT.turn_ended;
}

/// Every indicator the app can draw. Exists for the invariant tests --
/// nothing renders from it -- so a new state added above without a glyph
/// of its own fails the suite instead of shipping.
export function allIndicators(): Indicator[] {
  return [
    ...AGENT_STATES.map(agentIndicatorByState),
    AGENT.turn_ended,
    AGENT.unknown,
    ...PRIORITY_LEVELS.map((p) => PRIORITY[p]),
    ...STEP_STATES.map(stepIndicator),
    ...RAIL_STATES.map(railIndicator),
    railRetryIndicator(),
    ...RUN_OUTCOME_STATES.map((state) => RUN[state]),
    gitIndicator(true),
    gitIndicator(false),
    worktreeStaleIndicator(),
    unsavedEditsIndicator(),
    shellRestartedIndicator(),
    shellRestartedIndicator(true),
    shellOrphanIndicator(),
  ];
}
