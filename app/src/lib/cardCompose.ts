// Pure half of the two-speed composer (card-model spec §4): title +
// kind + context -> the createPlan argument set, with slugged file
// names and "-2" collision suffixes. The Svelte composer only renders
// and forwards.

import { formatAttachments } from "./attachments";
import { autoCommitAppliesTo, setAutoCommitInBody } from "./autoCommit";
import { parseComplexity } from "./complexity";
import { translateDropIndex } from "./pageBoard";
import { slugFileName } from "./planExplorer";
import { slugStatus, type CardView } from "./planBoard";
import { formatChord, matchesChord, type Chord, type ChordEvent } from "./shortcuts";
import type { MergedBoard } from "./boardSearch";
import type { OrderedPlanCard } from "./planOrder";

export type ComposeKind = "note" | "task" | "plan";

/// The kind chips, in the order the composer offers them, and the one a
/// fresh composer starts on. ⌘N is overwhelmingly used to file work --
/// something an agent will pick up -- so the composer opens ready for
/// that, with the prompt field already there; a note is the exception,
/// a card with nothing to run, so it sits last. Kept here rather than
/// inline in the template so the order and the default cannot drift
/// apart from each other, or from the tests.
export const COMPOSE_KINDS = ["task", "plan", "note"] as const;
export const DEFAULT_COMPOSE_KIND: ComposeKind = COMPOSE_KINDS[0];

export interface ComposeSpec {
  kind: ComposeKind;
  title: string;
  // The prompt for a task, the body for a plan, ignored-when-empty for
  // a note.
  body: string;
  status: string; // the column's name
  // Files to attach, as they will be STORED (relative inside the
  // workspace root, absolute outside it). Carried through the composer
  // so a card can be filed with its references already on it -- picking
  // a file, filing the card, then reopening it to attach the file is
  // three steps for one intention. Optional: every call site that
  // predates the field means "none".
  attachments?: string[];
  // Whether the card is filed carrying the auto-commit block. Folded
  // into the BODY here rather than written afterwards, so the card
  // reaches disk complete in the one CreatePlan the composer already
  // makes: a second write would leave a window in which the card exists
  // without the instruction, and a failure mode in which it never gets
  // it. Optional -- absent means off.
  autoCommit?: boolean;
  // How hard the card's work is, as the frontmatter records it. Written
  // in the same CreatePlan for the same reason the auto-commit block is:
  // a card filed and then rated is a card that could be RUN in between,
  // at the wrong agent. Empty or absent means the card gets no
  // `complexity:` line at all, which is what "unrated" is.
  complexity?: string;
}

export type ComposeArgs =
  | {
      fileName: string;
      title: string;
      status: string;
      body: string | undefined;
      kind: ComposeKind;
      // The `attachments:` frontmatter LINE, or undefined for a card
      // that gets no such line at all -- CreatePlan takes the line
      // rather than a list, so the daemon writes what it was handed
      // instead of re-deriving a format its own parser has to match.
      attachments: string | undefined;
      // The level name, or undefined for a card that gets no
      // `complexity:` line. Parsed rather than passed through: the
      // daemon REFUSES a level it cannot read, and a composer that sent
      // one would fail the whole file creation over a field the human
      // may not even have touched.
      complexity: string | undefined;
    }
  | { error: string };

export function buildCreatePlanArgs(spec: ComposeSpec, existingFileNames: string[]): ComposeArgs {
  const title = spec.title.trim();
  if (!title) return { error: "Card title is empty" };
  const base = slugFileName(title);
  if (!base) return { error: "Title has no usable characters for a file name" };
  const taken = new Set(existingFileNames);
  let fileName = base;
  let n = 2;
  while (taken.has(fileName)) {
    fileName = base.replace(/\.md$/, `-${n}.md`);
    n += 1;
  }
  // `autoCommitAppliesTo` is asked again here rather than trusted from
  // the checkbox: the composer hides that control on the note chip, but
  // switching chips does not clear the flag underneath, and a note is a
  // card nothing will ever execute. Same posture as railToApply.
  const body = setAutoCommitInBody(
    spec.body.trim(),
    spec.autoCommit === true && autoCommitAppliesTo(spec.kind)
  );
  const attachments = formatAttachments(spec.attachments ?? []);
  const complexity = parseComplexity(spec.complexity);
  return {
    fileName,
    title,
    status: spec.status,
    body: body === "" ? undefined : body,
    kind: spec.kind,
    attachments: attachments === "" ? undefined : attachments,
    complexity: complexity ?? undefined,
  };
}

/// The status a card is filed with when no picker offered one -- the
/// Plans tab's "new file in this context", which creates a card from a
/// tree that shows no columns at all. It is the daemon's own default in
/// `create_plan_file`, spelled out here and PASSED rather than left to
/// be defaulted, so the file on disk and the column the app then places
/// the card at the end of cannot name two different things. A permanent
/// column, so there is always one to land in (guard test).
export const NEW_CARD_STATUS = "To Do";

/// Which column a freshly opened composer starts in. The column that
/// asked wins while it is still on the board -- a rename or a delete
/// between the click and the render must not leave the picker showing a
/// status no column carries -- and the leftmost column is the fallback,
/// which is what ⌘N gets when nothing asked for a particular one.
/// Null only when the board has no real columns at all: there is then no
/// status to give the card.
export function defaultComposeStatus(columnNames: string[], preferred: string | null): string | null {
  if (preferred !== null && columnNames.includes(preferred)) return preferred;
  return columnNames[0] ?? null;
}

/// Where a card the app has just filed belongs: the END of the column it
/// was filed into.
///
/// A card is born with no `order:` at all, and the board's sort key --
/// (order ?? +infinity, contextFolder, fileName) -- puts unordered cards
/// in an alphabetical tail behind the ordered ones. So a card the human
/// had just typed appeared wherever its FILE NAME happened to fall,
/// which is nowhere near the bottom of the column they were looking at.
/// The fix is the one the drag path already has: give the new card the
/// order writes a drop at the foot of that column would produce
/// (computeOrderWrites), materializing the block on the first one.
///
/// `scoped` is the PAGE lens, when the board carries one. It is passed
/// for the same reason the drop path passes it (pageBoard.ts): the order
/// writes land on the whole column, so "after everything I can see" has
/// to be translated into a slot among the cards this board hides too.
///
/// Null when the status resolves to no column on this board. The card is
/// filed either way -- a status with no column has no end to be placed
/// at, and refusing to file the card over that would be a far worse
/// trade.
export interface ComposeSlot {
  /// The target column's plan block in visual order, as the order math
  /// takes it.
  cards: OrderedPlanCard[];
  index: number;
}

/// `path` is the card just created. It is FILTERED OUT of the block it
/// is being placed in, the same way the drop path excludes the dragged
/// card -- which is what lets a caller read the projection either side
/// of the optimistic patch that puts the new card into it. Leaving it in
/// would hand computeOrderWrites a list containing the very card it is
/// asked to splice, and it would write two different orders to it.
export function composeSlot(
  merged: MergedBoard,
  scoped: MergedBoard | null,
  status: string,
  path: string
): ComposeSlot | null {
  const full = columnCards(merged, status, path);
  if (!full) return null;
  const visible = scoped ? (columnCards(scoped, status, path) ?? []) : null;
  const index = visible ? translateDropIndex(visible, full, visible.length) : full.length;
  return { cards: full.map((c) => ({ path: c.id, order: c.order })), index };
}

/// The plan block a card with this status lands in -- a real column
/// first, then an auto column, both matched by slug the way the board's
/// own projection matches them.
function columnCards(board: MergedBoard, status: string, exclude: string): CardView[] | null {
  const slug = slugStatus(status);
  const dc = board.columns.find((c) => slugStatus(c.column.name) === slug);
  const cards = dc?.planCards ?? board.autoColumns.find((a) => slugStatus(a.status) === slug)?.planCards;
  return cards ? cards.filter((c) => c.id !== exclude) : null;
}

/// The rail a newly created card should be sent to. A note never rides a
/// rail (it is not runnable work), and a rail deleted since the picker
/// rendered took its row off screen with it -- writing to it would be a
/// placement nobody asked for.
export function railToApply(
  kind: ComposeKind,
  railId: string | null,
  railIds: string[]
): string | null {
  if (kind === "note" || !railId) return null;
  return railIds.includes(railId) ? railId : null;
}

/// What the composer can set an agent going on the instant the card is
/// filed. Both are the same bargain -- the card and the agent in one
/// gesture instead of file-it-then-find-it -- and they are alternatives
/// rather than a pair, because they want opposite things from the same
/// file: a run EXECUTES the card, a develop REWRITES it. Doing both
/// would have one agent editing the brief the other is working from,
/// which is the collision `developCard` already refuses when it finds a
/// live agent on a card.
export type AgentAction = "run" | "develop";

/// The order the composer offers them in. Run first: it is the action
/// the composer is already shaped around -- ⌘N opens on the task chip
/// with a prompt field, and the card typed into it is meant to be
/// executed -- so the box under the cursor is the one that does what the
/// form just asked for. Develop sits second as the detour it is: it
/// throws the card back to an interview before any work starts.
export const AGENT_ACTIONS = ["run", "develop"] as const;

/// The one line each action puts on screen. Here rather than in the
/// template so the checkbox, its tooltip and the tests read the same
/// words -- and so "develop" cannot end up described as a run.
export const AGENT_ACTION_LABELS: Record<AgentAction, { label: string; hint: string }> = {
  develop: {
    label: "Develop with agent on add",
    hint: "Hand the new card to the gavin-develop skill — it interviews you, then writes the steps, the kind and the complexity. It does not start the work.",
  },
  run: {
    label: "Run now with the agent",
    hint: "Start an agent on the card as filed, in a session of its own.",
  },
};

export interface AgentActionContext {
  kind: ComposeKind;
  /// The rail the card is being filed onto, if any.
  railId: string | null;
  /// Whether the board mounting the composer handed it a handler at all.
  /// A board with no way to run a card must not offer to.
  canRun: boolean;
  canDevelop: boolean;
}

/// Which actions this card can actually be filed with.
///
/// A note takes neither: nothing executes it and there is nothing to
/// develop it into. Run stays task-only, as it was -- a plan's body is
/// never inlined into the prompt, so running one from here would launch
/// an agent at a checklist nobody has written yet -- while develop is
/// exactly what a plan-shaped card wants, so it covers both runnable
/// kinds.
///
/// A rail takes both away, for the reason the Run checkbox already went
/// away under one: the card belongs to the rail from the moment it is
/// filed, and the rail launches it when the human arms it. A second
/// agent started here would either race that one or rewrite the card
/// under it.
///
/// Deliberately NOT `developAvailable` (cardRun.ts), which the card menu
/// and the detail modal share: that gate asks whether an EXISTING card
/// is still unstarted, and answers it with the To Do column. A card that
/// does not exist yet is unstarted whichever column it is being filed
/// into, so borrowing the column rule here would blink the checkbox in
/// and out over a fact about the new card that is always true.
export function availableAgentActions(ctx: AgentActionContext): AgentAction[] {
  if (ctx.kind === "note" || ctx.railId) return [];
  return AGENT_ACTIONS.filter((a) =>
    a === "run" ? ctx.canRun && ctx.kind === "task" : ctx.canDevelop
  );
}

/// A click on one of the boxes. Checkboxes rather than radios because
/// "no action" has to stay reachable -- a radio group cannot be
/// unpicked -- and picking one has to un-pick the other.
export function toggleAgentAction(
  current: AgentAction | null,
  clicked: AgentAction
): AgentAction | null {
  return current === clicked ? null : clicked;
}

/// The action to actually take, re-measured against what is available at
/// the moment the card is filed. Same posture as `railToApply`, and for
/// the same reason: the selection outlives the thing that offered it.
/// Ticking Run on a task and then switching the chip to plan leaves the
/// flag set underneath a control the composer has stopped drawing, and a
/// card must never be launched by a checkbox nobody can see.
export function agentActionToApply(
  selected: AgentAction | null,
  available: AgentAction[]
): AgentAction | null {
  return selected && available.includes(selected) ? selected : null;
}

/// The card the composer has just written, as the board's own projection
/// would see it -- what an agent action is handed, since the real
/// projection does not have it yet (the daemon's scan is a round trip
/// away, and the action has to start on the card the human just filed).
///
/// Built here rather than inline in the template so the two actions
/// cannot be handed two differently-shaped views of one card: every
/// field a launch route reads -- the level that picks the agent, the
/// attachments that reach its prompt, the kind that picks the prompt at
/// all -- comes from the same place as the file that was written.
export function composedCardView(
  args: Extract<ComposeArgs, { fileName: string }>,
  path: string,
  contextFolder: string,
  contextName: string,
  attachments: string[]
): CardView {
  return {
    id: path,
    title: args.title,
    status: args.status,
    priority: null,
    order: null,
    kind: args.kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    attachments: [...attachments],
    complexity: parseComplexity(args.complexity),
    checklistDone: 0,
    checklistTotal: 0,
    contextName,
    contextFolder,
    fileName: args.fileName,
    parseWarning: false,
    nestedChildren: [],
  };
}

/// The composer's commit chord, as data so the keydown handler and the
/// footer hint read it from one place and cannot drift apart. Enter is
/// not a letter, so formatChord renders it "⌘Enter" / "Ctrl+Enter" and
/// matchesChord matches it, with no Enter-specific modifier rules here.
export const COMPOSE_COMMIT_CHORD: Chord = { key: "Enter" };

/// Which field the key landed in -- named for the only thing that varies
/// between them, what a BARE Enter means there. "title" is the fast path
/// (type a title, Enter, card filed); "body" is every field where Enter
/// belongs to the field itself: the plan/prompt textarea, whose whole
/// point is `- [ ] step` lines and multi-paragraph prompts, and the
/// pickers, where Enter closes an open dropdown.
export type ComposeField = "title" | "body";

/// "commit" -- file the card. "newline" -- the field keeps the key.
/// null -- not ours; leave the event entirely alone.
export type ComposeKeyAction = "commit" | "newline";

export function composeKeyAction(
  field: ComposeField,
  e: ChordEvent & { isComposing?: boolean },
  isMac: boolean
): ComposeKeyAction | null {
  if (e.key !== "Enter") return null;
  // An IME candidate is confirmed with Enter. Filing a card on it would
  // eat the keystroke that finishes the word being typed.
  if (e.isComposing) return null;
  if (matchesChord(e, COMPOSE_COMMIT_CHORD, isMac)) return "commit";
  // Some other modifier combination: not the commit chord and not a
  // plain keystroke either, so it is not the composer's to interpret.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) return "newline";
  return field === "title" ? "commit" : "newline";
}

/// The same chord, heard at the WINDOW instead of in a field. Only the
/// fields can each be given a handler, and focus in this modal is just
/// as often somewhere that has none: a kind chip, Attach, Cancel, Add
/// card -- or nowhere at all, since clicking the panel's own padding
/// blurs the textarea and sends the keystroke to the document. The
/// chord is the composer's, not the focused control's, so it is bound
/// at the window too (the layer Modal already listens on for Escape)
/// and this decides whether that listener may act.
///
/// A field that has already filed the card called preventDefault, and
/// the very same event reaches the window a moment later on its way up:
/// acting on it again would file two cards from one keystroke. A bare
/// Enter is never the window's -- on a button it is that button's click,
/// in a textarea it is a newline.
export function composeWindowKeyAction(
  e: ChordEvent & { isComposing?: boolean; defaultPrevented?: boolean },
  isMac: boolean
): "commit" | null {
  if (e.defaultPrevented) return null;
  if (e.key !== "Enter" || e.isComposing) return null;
  return matchesChord(e, COMPOSE_COMMIT_CHORD, isMac) ? "commit" : null;
}

/// The footer hint for the field that currently holds focus. It used to
/// be one fixed string promising "Enter adds" everywhere, which was true
/// of the title and a lie in the body -- the field where Enter has to
/// stay a newline. A hint that names the wrong key is worse than none:
/// it is what sends someone hunting for a bug in the field instead.
export function composeHint(field: ComposeField, isMac: boolean): string {
  if (field === "title") return "Enter adds and stays · ⇧Enter newline · Esc closes";
  return `${formatChord(COMPOSE_COMMIT_CHORD, isMac)} adds and stays · Enter newline · Esc closes`;
}

/// What a gesture that would DISMISS the composer should do with it as it
/// currently stands.
///
/// The fields are the only copy of what is in them: nothing is written
/// until the card is filed, and the composer reopens empty. So a click on
/// the backdrop -- and a board is mostly backdrop -- destroyed a
/// half-written prompt with no way back and nothing said. Anything typed
/// therefore buys a confirm; an untouched composer (⌘N, a look at the
/// board, dismiss again) still closes on the first gesture, because a
/// prompt with nothing to lose is only a second click.
///
/// Every way out is measured the same way -- backdrop, Escape, Cancel --
/// rather than only the one the report named. They end the same modal
/// holding the same text, and a rule that held for two of the three would
/// read as the third being broken.
///
/// A note has no body FIELD, but `body` keeps whatever was typed under
/// task or plan before the chip was switched, and switching back brings
/// it straight back. It is still the human's text, so it still counts.
export interface ComposeDraft {
  title: string;
  body: string;
  attachments: string[];
}

export type ComposeCloseAction = "close" | "confirm";

export function composeCloseAction(draft: ComposeDraft): ComposeCloseAction {
  const typed =
    draft.title.trim() !== "" || draft.body.trim() !== "" || draft.attachments.length > 0;
  return typed ? "confirm" : "close";
}
