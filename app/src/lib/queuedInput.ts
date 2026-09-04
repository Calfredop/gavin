// The follow-up queue: messages the human writes for an agent that is
// mid-turn, held by the daemon and handed over when the session next
// goes idle.
//
// Everything here is pure. The daemon owns the queue itself -- a SQLite
// table, so a follow-up survives the app closing, the same reason every
// PTY lives there -- and this module owns the two things the daemon has
// no opinion about: what order a human gesture is asking for, and what
// to say about a queue that is sitting still.
//
// The second half is what earns the module a file. `QueueInput` is
// accepted by a daemon that will then decline to DELIVER: an interrupted
// session's tab holds a bare shell in the agent's old cwd, and pasting
// the human's English there would run a line of prose as a command
// (server.rs `queue_delivery_refusal`). Nothing on the wire says so --
// the request succeeds and the entry sits in the list looking accepted
// -- so the only place that can explain the silence is the app, and the
// only honest thing to do about the permanent case is to refuse the
// compose box before it takes a message that can never arrive.

import type { SessionStatus } from "./notifications";

/// One pending follow-up, exactly as `protocol::QueuedInput` crosses the
/// wire.
///
/// `createdAtUs` is MICROseconds on the daemon's clock, and it decorates
/// a row ("queued 4m ago") rather than ordering one: the array's order
/// IS the delivery order, on the wire and in every write back, so
/// nothing here may sort by it.
export interface QueuedInput {
  id: string;
  sessionId: string;
  text: string;
  createdAtUs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/// Groups the flat `ListQueuedInputs` reply by session id.
///
/// Order-preserving, and deliberately not sorted: the daemon returns the
/// rows ordered by (session, position), so each group already IS its
/// delivery order. Re-deriving that order here from `createdAtUs` would
/// throw away every reorder the human has made -- the two disagree the
/// moment anything is dragged, and the timestamp is the one that is
/// wrong.
export function indexQueued(all: QueuedInput[]): Record<string, QueuedInput[]> {
  const byId: Record<string, QueuedInput[]> = {};
  for (const entry of all) (byId[entry.sessionId] ??= []).push(entry);
  return byId;
}

/// The id list `SetQueuedInputs` should be given to move `id` by `delta`
/// places, or null when the gesture asks for nothing.
///
/// Null rather than the unchanged list, on purpose: `SetQueuedInputs`
/// answers with the queue AND pushes `QueuedInputsChanged` to everyone
/// attached, so a no-op write repaints the strip under the human's
/// cursor to say nothing happened. An unknown id is null for a sharper
/// reason -- it means the entry left the queue between the render and
/// the click (a delivery fired), and writing a list built from a stale
/// render would resurrect the order that existed before it.
export function moveQueued(
  queue: QueuedInput[],
  id: string,
  delta: number
): string[] | null {
  const from = queue.findIndex((q) => q.id === id);
  if (from === -1) return null;
  const to = from + delta;
  if (to < 0 || to >= queue.length) return null;
  const ids = queue.map((q) => q.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return ids;
}

/// The id list that remains after cancelling one entry, or null when
/// that entry is not in the queue any more -- same reasoning as
/// `moveQueued`, and the same race: cancelling something the daemon has
/// already delivered must not re-write a list that no longer describes
/// anything.
export function withoutQueued(queue: QueuedInput[], id: string): string[] | null {
  if (!queue.some((q) => q.id === id)) return null;
  return queue.filter((q) => q.id !== id).map((q) => q.id);
}

/// What the app knows about the session a follow-up would be queued for.
///
/// Structural rather than a store read, like every other pure module
/// here: the refusals below are the part worth testing, and a test
/// should not have to build a LayoutState to reach them.
export interface QueueTarget {
  /// From `sessionStatusById`. `undefined` means the app has not heard
  /// anything about this session yet, which is not the same as idle.
  status: SessionStatus | undefined;
  /// Membership in `interruptedSessionIds`: the run was killed with a
  /// previous daemon and what is in the tab now is a bare shell.
  interrupted: boolean;
  /// `featureBlockedReason(compat, "queuedFollowUps")` -- null when the
  /// daemon speaks v29.
  blockedReason: string | null;
}

/// The one sentence for an interrupted session, shared by the compose
/// refusal and the delivery hold because they are the same fact told to
/// two different questions.
///
/// It is permanent, which is why the compose box refuses on it rather
/// than accepting and holding: `interrupted` is set once and never
/// cleared (registry.rs `mark_interrupted` -- the run really is gone, so
/// nothing later makes it un-gone), and relaunching the agent mints a
/// NEW session id whose queue is a different list. A follow-up queued
/// here would wait for an idle that this session id can never reach.
export const INTERRUPTED_REASON =
  "This tab's agent was stopped and a plain shell took its place, so a follow-up here would never be delivered. Relaunch the agent and queue it on the new session.";

/// Why this session cannot be queued for at all, whatever has been
/// typed -- or null.
///
/// Split out from `composeRefusal` because three callers need exactly
/// this and not its empty-text clause: the button that OPENS the
/// composer (withholding the box you would write in is not a way to say
/// "write something in it"), "send now", which is about an entry that
/// already exists, and "Send to workspace agent", which brings a prompt
/// of its own.
///
/// Ordered by which answer is most useful when both are true. The
/// version gate comes first because it is the one the human can act on
/// without losing anything.
export function queueBlockedReason(target: QueueTarget): string | null {
  if (target.blockedReason) return target.blockedReason;
  if (target.interrupted) return INTERRUPTED_REASON;
  return null;
}

/// Why the compose box must not accept THIS follow-up, or null.
///
/// The empty-text clause is last because it is the only one that stops
/// being true as the human types. Everything above it is a reason no
/// follow-up can be taken at all -- and on an older daemon the request
/// never reaches the wire, so a box that took the text and reported
/// nothing is exactly the failure the compat entry exists to prevent: it
/// would last until the human came back to an agent that never got the
/// message.
export function composeRefusal(target: QueueTarget, text: string): string | null {
  return queueBlockedReason(target) ?? (text.trim() === "" ? "Write the follow-up first." : null);
}

/// Why the queue is not moving, said to a human looking at entries that
/// are still there -- or null when the head is on its way.
///
/// Distinct from `composeRefusal` because a queue can be perfectly
/// legitimate and still stuck: the daemon hands over on `idle` and on
/// nothing else, and every other status is a different reason for the
/// same stillness. Saying which one is the whole job of the strip's
/// status line; without it a waiting queue and a broken one look
/// identical.
export function deliveryHold(target: QueueTarget, queued: number): string | null {
  if (queued === 0) return null;
  if (target.interrupted) return INTERRUPTED_REASON;
  switch (target.status) {
    case "working":
      // The ordinary case, and the whole point of the feature.
      return "Waiting for the agent to finish its turn.";
    case "waiting_for_input":
      // Deliberately never delivered here: this agent has a question on
      // screen, and handing it an unrelated follow-up would file the
      // answer to a different question at its prompt.
      return "The agent is asking you something — answer it, and the queue moves when its next turn ends.";
    case "failed":
      return "The agent stopped because something broke. Nothing is delivered into a failed session; send it now, or cancel it and resume the agent first.";
    case "idle":
      // Idle with a queue still standing is a real state and a brief
      // one: the daemon hands over one item per idle, so the rest of the
      // list is genuinely waiting for the turn this delivery starts.
      return queued === 1
        ? "Delivering now."
        : "Delivering the first one now; the rest follow one turn at a time.";
    default:
      return "Waiting for the agent.";
  }
}

/// Whether the strip belongs on screen at all.
///
/// A permanent bar under every terminal in the app would cost every one
/// of them a row of height to say nothing, so the strip appears exactly
/// when queueing is the thing to be doing: the session is mid-turn (so
/// typing would land in the middle of it), something is already queued
/// (so the human can see, reorder and cancel it), or they have opened
/// the composer themselves.
///
/// The `interrupted` clause is not an exception to that rule but a
/// consequence of it: a queue stranded by a daemon restart has to stay
/// visible, because cancelling it is the only way it ever goes away.
export function stripVisible(
  target: QueueTarget,
  queued: number,
  composerOpen: boolean
): boolean {
  if (composerOpen || queued > 0) return true;
  if (target.interrupted) return false;
  return target.status === "working" || target.status === "waiting_for_input";
}

/// "3 follow-ups queued". Null at zero -- a count of nothing is not a
/// label, it is noise where the strip's own status line should be.
export function queueCountLabel(queued: number): string | null {
  if (queued <= 0) return null;
  return queued === 1 ? "1 follow-up queued" : `${queued} follow-ups queued`;
}

/// A queued message on one line: its first non-blank line, whitespace
/// collapsed, cut at `max` with an ellipsis.
///
/// The first line rather than the first `max` characters, because what
/// the human wrote is usually a sentence followed by detail, and a
/// preview that runs the sentence into the detail reads as neither.
export function previewLine(text: string, max = 80): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/// How long a follow-up has been waiting: "just now", "4m", "3h", "2d".
///
/// Coarse for the same reason as the hub's `relativeTime`, and NOT
/// `attentionInbox`'s `waitLabel` despite the identical shape: that one
/// hedges every duration with "≥" because the app may only have met the
/// wait, whereas the daemon stamped this row at the moment it was
/// written. There is nothing to hedge, and borrowing a label that says
/// "at least" about a number gavin actually measured would be a smaller
/// claim than the truth.
///
/// A stamp in the future reads as "just now": only a clock that moved
/// backwards produces one, and inventing "in 3 hours" for it would be
/// worse than rounding it away.
export function queuedAgeLabel(createdAtUs: number, nowMs: number): string {
  const delta = nowMs - createdAtUs / 1000;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

/// A row's full text and its age, for the title attribute -- the preview
/// is cut, and this is where the rest of the message is.
export function entryTip(entry: QueuedInput, nowMs: number): string {
  return `${entry.text}\n\nQueued ${queuedAgeLabel(entry.createdAtUs, nowMs)} ago`;
}

/// Whether "Send to workspace agent" should QUEUE this card rather than
/// bracket-paste it straight into the terminal.
///
/// Busy means mid-turn or mid-question. Pasting into either is what the
/// feature exists to stop: a card prompt typed into a working agent
/// arrives in the middle of its reasoning, and one typed into an agent
/// with a question on screen answers that question with a card.
///
/// Everything else keeps today's paste, and that is the deliberate half.
/// An idle agent takes the card immediately either way, so pasting is
/// one fewer round trip for the same outcome. A `failed` one has no turn
/// coming that would drain a queue, so queueing there would swap a
/// visible non-answer for an invisible one. And `undefined` -- the app
/// has heard nothing about this session -- must behave exactly as it did
/// before this feature existed, because a status gavin never learned is
/// not evidence of anything.
export function shouldQueueForMainAgent(status: SessionStatus | undefined): boolean {
  return status === "working" || status === "waiting_for_input";
}
