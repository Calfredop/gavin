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
  Clock,
  CircleDashed,
  CircleOff,
  CirclePause,
  CircleQuestionMark,
  CircleSlash2,
  DraftingCompass,
  Eye,
  FileWarning,
  GitBranch,
  Hand,
  History,
  Hourglass,
  LoaderCircle,
  Lock,
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
  SquareSlash,
  SquareX,
  TriangleAlert,
  Unlink2,
} from "@lucide/svelte";
import type { SessionStatus } from "$lib/core/notifications";
// The rails already own these three; re-declaring them here would be a
// second definition free to drift from the one the scheduler runs on.
import type { RailState, StepAttention, StepState } from "$lib/orchestration/orchestration";
// Same reason: usageProjection.ts owns the three bands and the rule that
// produces them, so this file names them rather than defining a second set.
import type { ProjectionBand } from "$lib/agents/usageProjection";
// ...and launchGate owns the hold vocabulary itself, plus the two words
// each reason is allowed to be called. A badge that spelled them here
// would be free to say "Queued" where the queue row says "Paused".
import { holdLabel, type HoldReason } from "$lib/agents/launchGate";

/// The five meanings colour is allowed to carry. Matches IconButton's own
/// tone scale one for one, so a badge and a button beside it never
/// disagree about what amber means.
export type IndicatorTone = "neutral" | "accent" | "success" | "warning" | "danger";

/// The questions the app's badges answer. One glyph family each; the
/// test enforces that no glyph is shared between two of them.
export type IndicatorAxis =
  | "agent"
  | "priority"
  | "git"
  | "edits"
  | "shell"
  | "step"
  | "rail"
  | "run"
  | "usage";

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
  usage: "Usage",
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
  | "developing"
  | "turn_ended"
  | "stale"
  | "blocked"
  | "decoy_edit"
  | "failed"
  | "unknown"
  | "interrupted"
  | "idle"
  | "exited"
  | "queued"
  | "held"
  | "paused",
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
  // The same shape as turn_ended, because it IS turn_ended -- aged past
  // STALE_AFTER_MS with the card still where it was. Only the tone
  // moves, which is exactly the claim: same question, and the answer has
  // stopped being "give it a moment".
  stale: make("agent", "stale", CirclePause, "danger", "turn ended long ago, card still unmoved"),
  // The agent ended its own turn without doing the work, and SAID so --
  // the TypeSafe turn verdict's `blocked` reading. Warning rather than
  // danger, and a hand rather than a pause: nothing broke and nothing is
  // aging, a person simply has to read what it said and decide. The two
  // above it are gavin inferring from silence; this one is the agent
  // speaking, which is why it is not drawn as either of them.
  blocked: make("agent", "blocked", Hand, "warning", "stopped without finishing, and said why"),
  // The agent wrote the rail worktree's own copy of the card rather than
  // the card (see worktreeCards.ts). Danger, because nothing the run
  // does from here can reach the board, and a glyph of its own because
  // the fix is about a FILE and no other agent state is.
  decoy_edit: make("agent", "decoy_edit", FileWarning, "danger", "edited the worktree's copy of the card"),
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
  // An agent is rewriting the CARD rather than doing the work on it
  // ("Develop into a plan…"). Its own state because it answers a
  // different question from every other one here: those say how the run
  // on this card is going, and this one says the card itself is not
  // finished being written -- which is why every launch is refused while
  // it is drawn. Accent, because something is happening right now; no
  // spin, because the agent spends most of the run waiting on the human's
  // answers rather than moving.
  developing: make(
    "agent",
    "developing",
    DraftingCompass,
    "accent",
    "developing this card — an agent is rewriting it"
  ),
  idle: make("agent", "idle", CircleDashed, "neutral", "idle — nothing running"),
  exited: make("agent", "exited", CircleSlash2, "neutral", "session exited"),
  // Asked for, not started: the launch wall is holding it and the queue
  // will start it by itself (launchGate.ts). Not a daemon status -- there
  // is no session yet, which is the whole state -- but it is the same
  // question every other badge here answers ("what is the agent on this
  // card doing"), and answering it in a vocabulary of its own is how the
  // board ends up with a card that looks idle while a launch is pending.
  //
  // A clock, because the answer is "later"; neutral, because nothing is
  // wrong. The pressure variant below shares the glyph and takes the
  // warning tone, which is exactly the rule this module encodes: same
  // shape means same question, tone carries the answer.
  queued: make("agent", "queued", Clock, "neutral", "queued — waiting for a slot"),
  held: make("agent", "held", Clock, "warning", "held — memory pressure"),
  // The third hold, and the only one nobody chose to be in by accident:
  // the workspace's own pause cycle, or its agent's usage limit. A Pause
  // rather than the Clock the other two share, because this one is not a
  // queue -- nothing frees up, the schedule simply comes round -- and
  // neutral for the same reason `queued` is: a pause working as
  // instructed is not a fault.
  paused: make("agent", "paused", Pause, "neutral", "paused — agents are paused"),
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

/// A card whose "Develop into a plan…" run is still going. Read off the
/// workspace's develop records rather than reported as a status: the run
/// binds no session to the card on purpose (developing is not starting),
/// so nothing about the card itself says it.
export function agentDevelopingIndicator(): Indicator {
  return AGENT.developing;
}

/// The agent states in the order a tally should list them: what is
/// moving, what is stuck on you, what broke, then what is merely there.
export const AGENT_STATES = [
  "working",
  "waiting_for_input",
  "failed",
  "interrupted",
  "queued",
  "idle",
  "exited",
] as const;

export function agentIndicatorByState(state: (typeof AGENT_STATES)[number]): Indicator {
  return AGENT[state];
}

/// The badge for a launch something is holding.
///
/// One vocabulary for all three halves of the hold, so the board card,
/// the detail modal, the rail header and the step chip cannot describe
/// it three ways: "Queued · waiting for a slot" when a slot is what it
/// wants, "Held · memory pressure" when the machine is, "Paused" when
/// the workspace's own cycle or its agent's usage limit is.
///
/// `why` is the gate's own sentence and goes in the BUBBLE, not beside
/// the glyph -- it names counts and gigabytes, and no badge has room for
/// that. Hang it on a non-disabled element: `tooltip.ts` binds
/// mouseenter, which a disabled control never fires.
export function agentQueuedIndicator(reason: HoldReason, why?: string | null): Indicator {
  const base = reason === "ceiling" ? AGENT.queued : reason === "pause" ? AGENT.paused : AGENT.held;
  if (!why) return base;
  return { ...base, tip: `${AXIS_LABEL.agent} · ${why}`, label: `${AXIS_LABEL.agent} · ${why}` };
}

/// What the badge says beside the glyph. Two words at most, because it
/// sits next to a card title. `holdLabel`'s answer, so the badge and the
/// queue row cannot drift.
export function queuedBadgeText(reason: HoldReason): string {
  return holdLabel(reason);
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
  // A struck-through square, and NEUTRAL rather than success: a skipped
  // step is behind the rail exactly as a done one is, but nothing about
  // it went right. Success tone would read as work delivered, and danger
  // as a failure -- neither is what "the human said move on" means.
  skipped: make("step", "skipped", SquareSlash, "neutral", "skipped — the rail was sent past it"),
  stalled: make("step", "stalled", SquareX, "danger", "stalled"),
};

export function stepIndicator(state: StepState): Indicator {
  return STEP[state];
}

export const STEP_STATES = ["pending", "running", "done", "skipped", "stalled"] as const;

/// A step the rail was TOLD to stop at until a human has looked -- the
/// `review` kind (orchestrationTools.ts). Drawn beside the state badge,
/// never instead of it: the step really is `running`, and the rail
/// really has not moved, which is two facts and therefore two badges.
///
/// On the STEP axis and not the agent one, which is where every other
/// attention mark lives, because there is no agent: gavin launches
/// nothing for a review step, and "Agent · waiting for your review"
/// would name a session that does not exist. An eye rather than a
/// square, because the square family is the state badge sitting next to
/// it and two squares in one chip are one shape saying two things.
///
/// Warning, like the rest of the "wants a human" family. Nothing is
/// broken -- the rail is doing exactly what it was asked -- but it will
/// not move again until somebody comes.
export function reviewWaitIndicator(): Indicator {
  return make("step", "review", Eye, "warning", "waiting for you to review it");
}

/// A step whose CARD nobody has read yet (`cardReview.ts`, AG-01). The
/// step stalled rather than launching, so like the review gate above it
/// names no agent -- but unlike it, nothing asked for this stop: a card
/// arrived with the repository and gavin will not hand its body to an
/// agent on nobody's authority.
///
/// A lock rather than an eye, and on the step axis for the same reason:
/// the review gate is a hold somebody chose, this is a hold gavin
/// imposed, and one glyph for both would read as "you asked for this".
/// Warning, not danger -- nothing is broken, and reading a card is a
/// minute's work.
export function unreviewedCardIndicator(): Indicator {
  return make("step", "unreviewed", Lock, "warning", "waiting for you to review the card");
}

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

// ---- usage -------------------------------------------------------------
// Whether an agent's subscription limits will HOLD -- not how full they
// are, which the panel's bars already say. The question is a race
// between two clocks (usageProjection.ts): the burn measured against the
// window, and the window's own reset. Hence an hourglass, and hence one
// glyph for all three answers with the tone carrying the verdict, the
// same shape the git axis uses.
//
// The tones are the traffic light this was asked for, read as the app's
// five meanings rather than as a severity ramp: `clear` is success
// because the window comes out the other side intact, `tight` is the
// wants-a-human amber (throttle, and it is a human who decides what to
// stop), `over` is danger because work started now will hit a wall.
//
// There is deliberately no badge for "gavin is still measuring". A
// fourth, quieter hourglass on the sidebar row for the first five
// minutes of every session would be a mark that means "ignore me", and
// the surfaces simply draw nothing until there is something to say.
// A live probe in flight spins that agent's Check again icon instead.

const USAGE: Record<ProjectionBand, Indicator> = {
  clear: make("usage", "clear", Hourglass, "success", "projected to last past its reset"),
  tight: make("usage", "tight", Hourglass, "warning", "projected to run out close to its reset"),
  over: make("usage", "over", Hourglass, "danger", "projected to run out before its reset"),
};

/// The semaphore for a projected limit. Null in, null out: a band the
/// projection could not reach draws nothing at all.
///
/// `detail` replaces the generic sentence with the specific one the
/// projection produced, keeping the axis prefix -- the same trick
/// `agentFailedIndicator` uses so a surface can be precise without
/// inventing a second vocabulary.
export function usageProjectionIndicator(
  band: ProjectionBand | null,
  detail?: string | null
): Indicator | null {
  if (!band) return null;
  const base = USAGE[band];
  if (!detail) return base;
  const tip = `${AXIS_LABEL.usage} · ${detail}`;
  return { ...base, tip, label: tip };
}

export const PROJECTION_BANDS = ["clear", "tight", "over"] as const;

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

/// `blocked` is not a `StepAttention` and never will be: a rail turns
/// that verdict into a stall instead. It is here because a SESSION can
/// carry it (attentionInbox's `AttentionReason`), and a surface that
/// lists such a session needs a badge for it like any other row.
export function attentionIndicator(attention: StepAttention | "blocked"): Indicator {
  if (attention === "asking") return AGENT.waiting_for_input;
  if (attention === "failed") return AGENT.failed;
  if (attention === "stale") return AGENT.stale;
  if (attention === "blocked") return AGENT.blocked;
  if (attention === "decoy-edit") return AGENT.decoy_edit;
  // The one attention mark that is not about an agent, because a
  // `review` step has none. See reviewWaitIndicator.
  if (attention === "review") return reviewWaitIndicator();
  // Nor is this one, and for a stronger reason: the step never launched,
  // so there is not even a session that has gone quiet.
  if (attention === "unreviewed") return unreviewedCardIndicator();
  return AGENT.turn_ended;
}

/// The badge on a terminal TAB, or null for no badge at all.
///
/// A tab is not a board card: idle draws nothing rather than a
/// neutral-toned something, because a strip of tabs is mostly idle and a
/// badge on every one of them says nothing. So only the two live states
/// draw -- and `failed` before either, which is the whole reason this is
/// a function and not `agentIndicator`. A failed agent's daemon status is
/// `failed`, but the two quiet seconds behind it used to read as idle,
/// and idle on a tab is no badge: a tab whose agent had BROKEN looked
/// exactly like one whose agent was done.
///
/// `status` is the acknowledged view (layoutState's attentionStatusById),
/// so a wait the human marked as read draws nothing -- which is what the
/// mark is for.
export function tabAgentIndicator(
  status: SessionStatus | null | undefined,
  failureReason?: string | null
): Indicator | null {
  if (status === "failed") return agentFailedIndicator(failureReason);
  if (status !== "working" && status !== "waiting_for_input") return null;
  return agentIndicator(status);
}

/// Every indicator the app can draw. Exists for the invariant tests --
/// nothing renders from it -- so a new state added above without a glyph
/// of its own fails the suite instead of shipping.
export function allIndicators(): Indicator[] {
  return [
    ...AGENT_STATES.map(agentIndicatorByState),
    AGENT.turn_ended,
    AGENT.held,
    AGENT.stale,
    AGENT.decoy_edit,
    AGENT.developing,
    AGENT.unknown,
    ...PRIORITY_LEVELS.map((p) => PRIORITY[p]),
    ...STEP_STATES.map(stepIndicator),
    reviewWaitIndicator(),
    unreviewedCardIndicator(),
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
    ...PROJECTION_BANDS.map((band) => USAGE[band]),
  ];
}
