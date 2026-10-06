// The Decisions tab: everything in one workspace that is waiting on the
// HUMAN before work can move, as one list.
//
// A sibling of `attentionInbox.ts` and deliberately a different
// question. That list asks "which SESSIONS have stopped and are waiting
// for me", and every row in it is a session. This asks "what is waiting
// on me", which has four answers and only one of them is a session:
//
//   card        a card carrying open `Decision:` items (its bound
//               session's state alongside, when it has one)
//   session     a session waiting on you that no card is filed for
//   gate        a rail `review` step -- the rail was told to stop here
//   unreviewed  a rail step whose card nobody has read, so it never
//               launched
//
// The subject is the CARD wherever there is one, which is the whole
// shape of the tab: a card with items whose session is also asking is
// ONE row, not two, because the human's next move is the same move
// either way -- read this card, answer what it asks. Splitting them
// would put the question and the agent that asked it in two different
// places in the list.
//
// `Human test:` items are not here. A test is a check on finished work,
// which is the Review tab's question, so `review/humanTests.ts` lists
// them there -- built on the item rules below, so the two tabs cannot
// disagree about which items are still owed. Neither tab lists an item
// on a card that is Done or archived (`cardFinished`): the work it asks
// about has been closed, and an unticked box left on it is the card's
// record, not something waiting on anybody.
//
// Everything here is pure. `decisionsActions.ts` owns the writes, the
// dialog and the store reads; this module owns what the list IS, what
// order it comes in, the payload each answer sends, and the sentence the
// agent is told afterwards.

import type { AttentionReason, AttentionRow } from "$lib/agents/attentionInbox";
import type { HumanItem, HumanItemKind, HumanItemOutcome, PlanFileInfo } from "$lib/core/gavin";
import { workspaceWaiting } from "$lib/agents/nextWaiting";
import type { Column } from "$lib/board/kanban";
import { isArchivedCard, slugStatus } from "$lib/core/planBoard";
import { matchesFields, queryTokens, type Field } from "$lib/core/search";
import {
  effectiveStatus,
  planIndex,
  type Rail,
  type StepAttention,
} from "$lib/orchestration/orchestration";

/// Which of the four things a row is. A discriminated union rather than
/// a bag with nullable halves: the actions a row offers are completely
/// different per kind (answer an item, jump to a session, skip a gate,
/// read a card), and a nullable shape would let a template offer the
/// wrong one.
export type DecisionSubjectKind = "card" | "session" | "gate" | "unreviewed";

/// One card carrying items that are not settled.
export interface CardSubject {
  kind: "card";
  /// `card:<path>` -- the selection key. Prefixed because a rail gate's
  /// id and a card's path live in the same selection slot, and a bare
  /// path could collide with a step id.
  id: string;
  cardPath: string;
  title: string;
  /// The card's context folder, for the row's second line in a
  /// workspace with more than one.
  contextFolder: string;
  /// The card's EFFECTIVE status -- a nested task's is its parent's --
  /// which is what the status filter reads. Null for a card with none.
  status: string | null;
  /// The decisions still open. A settled one (ticked, answered) is off
  /// this list -- the record of it stays on the card, which is where it
  /// belongs.
  items: HumanItem[];
  /// The bound session's id, or null when nothing has ever run the card.
  /// What a notify message is queued to.
  sessionId: string | null;
  /// Why that session is waiting on a human, or null when it is not (or
  /// when there is none). The card's own items are not this: an item is
  /// a question the agent WROTE DOWN and walked away from, and the
  /// reason is what it is doing now.
  reason: AttentionReason | null;
  /// The waiting session's own row, for the jump and the failure line.
  /// Null when no session here is waiting.
  row: AttentionRow | null;
  waitedMs: number | null;
  watched: boolean;
}

/// One waiting session with no card filed for it.
export interface SessionSubject {
  kind: "session";
  /// `session:<sessionId>`.
  id: string;
  row: AttentionRow;
  waitedMs: number | null;
  watched: boolean;
}

/// One rail `review` step: a hold the rail was told to make.
export interface GateSubject {
  kind: "gate";
  /// `gate:<stepId>`.
  id: string;
  railId: string;
  railName: string;
  stepId: string;
  /// The review tool's own name, or a plain fallback when the library
  /// has not loaded or the tool was deleted under the step.
  label: string;
  /// Always null, and it is a fact rather than an omission: a `review`
  /// step has no session, so nothing ever stamped a moment for it to
  /// have been waiting since. See `orderSubjects`.
  waitedMs: null;
  watched: false;
}

/// One rail step whose card nobody has read, so the rail refused to
/// launch it.
export interface UnreviewedSubject {
  kind: "unreviewed";
  /// `unreviewed:<stepId>`.
  id: string;
  railId: string;
  railName: string;
  stepId: string;
  cardPath: string;
  title: string;
  /// The card's effective status, as `CardSubject.status`.
  status: string | null;
  /// Null for `GateSubject`'s reason, one step further along: this step
  /// never launched at all.
  waitedMs: null;
  watched: false;
}

export type DecisionSubject = CardSubject | SessionSubject | GateSubject | UnreviewedSubject;

/// What the list is worth saying about itself: how many subjects'
/// next move is the human's -- the number the tab's attention pip and
/// the strip's count come from. Taken over the WHOLE list, never the
/// filtered one: a filter changes what the human is looking at, not what
/// is waiting on them.
export interface DecisionsSummary {
  waiting: number;
}

/// A card as this module needs it: the tree's own `PlanFileInfo` plus
/// which context it was found in. Structural so a test builds one
/// without a `GavinTree`.
export interface DecisionCard {
  plan: PlanFileInfo;
  contextFolder: string;
}

export interface DecisionsInput {
  /// The workspace this tab belongs to. Sessions are narrowed to it the
  /// way `nextWaiting.ts` narrows them -- by the workspace whose page
  /// holds the TAB, because that is where the click lands.
  workspaceId: string;
  /// Every card in this workspace's tree, by path.
  cards: ReadonlyMap<string, DecisionCard>;
  /// Card path -> the session bound to it (`board.cardSessions`).
  bindings: ReadonlyMap<string, string>;
  /// The WHOLE fleet's attention inbox, unnarrowed. Narrowing happens
  /// here, once, and not before: a card filed in this workspace whose
  /// tab was dragged into another one still has to show that its agent
  /// is asking, and a pre-narrowed list has already thrown that away.
  inbox: readonly AttentionRow[];
  /// This workspace's rails, for the two marks that name a step.
  rails: readonly Rail[];
  /// `stepAttentions()`' marks by step id. Only `review` and
  /// `unreviewed` are read: every other mark describes a SESSION, and
  /// those reach this list through the inbox instead, under their card.
  marks: ReadonlyMap<string, StepAttention>;
  /// The tool library, for a gate's name. Empty or absent reads as "not
  /// loaded", which is why the fallback is a sentence about a review
  /// rather than a blank.
  tools?: readonly { id: string; name: string }[];
  /// The board's done column's NAME (`doneColumnOf`), or null/absent
  /// while the board has not loaded. A card in it asks nothing here --
  /// see `cardFinished`.
  doneStatus?: string | null;
  /// `featureBlockedReason(compat, "humanItems")` -- null when the
  /// daemon speaks v42.
  ///
  /// Load-bearing, not decorative. `PlanFileInfo.humanItems` is absent
  /// from an older daemon because it never PARSED the lines, and reading
  /// that absence as "this card asks nothing" would have the tab report
  /// an empty workspace with a dozen open decisions in it. So when this
  /// is set no card subject is built at all, and the reason travels out
  /// with the list for the view to say out loud.
  itemsBlockedReason?: string | null;
}

export interface DecisionsList {
  subjects: DecisionSubject[];
  summary: DecisionsSummary;
  /// Carried through from the input so one read of this module answers
  /// both "what is waiting" and "why can the items not be shown".
  itemsBlockedReason: string | null;
}

/// The label a gate wears when the tool library has not loaded or the
/// tool is gone. A sentence about the STEP rather than a blank or the
/// raw id: the row is still actionable (Skip, Mark done), and a human
/// reading an empty name would think the row was broken.
export const GATE_FALLBACK_LABEL = "Manual review";

/// Whether this item is still OWED -- open, or a test that failed and
/// has not been re-armed. What the card rows list.
///
/// The checkbox is checked first and on its own, because it is the one
/// half a human can have changed by hand: an item ticked in the editor
/// is settled whatever its last result line says, and the daemon's
/// `state` describes the result lines.
export function humanItemPending(item: HumanItem): boolean {
  if (item.done) return false;
  return item.state === "open" || item.state === "failed";
}

/// Whether this item is waiting on YOU. Narrower than `humanItemPending`
/// by exactly one case, and that case is the whole reason the two
/// functions exist: a failed test is owed by the AGENT, so it stays on
/// the card's row and out of every count that says how much the human
/// has to do.
export function humanItemWaiting(item: HumanItem): boolean {
  return humanItemPending(item) && item.state === "open";
}

/// The card's items still owed, in file order -- every kind, or only
/// `kind` when one is named: the Decisions tab asks for decisions and
/// the Review tab for tests.
///
/// File order rather than by state: the items on one card are usually a
/// sequence the agent wrote as it went, and re-sorting them by whether
/// they have failed would shuffle a checklist the human is reading
/// against the card itself.
export function pendingItems(plan: PlanFileInfo, kind?: HumanItemKind): HumanItem[] {
  return (plan.humanItems ?? [])
    .filter((item) => humanItemPending(item) && (kind === undefined || item.kind === kind))
    .sort((a, b) => a.lineIndex - b.lineIndex);
}

/// Whether this card's work is closed: archived, or Done -- by its
/// EFFECTIVE status, so a nested task is as finished as the plan it
/// rides inside. Neither the Decisions tab nor the Review tab's human
/// tests list an item on such a card. A box left unticked on it is a
/// record of what nobody answered before the work was closed, and
/// listing it would ask the human about work that has already gone.
///
/// Done is a status that slugs to `done` -- the daemon's own rule for
/// filing a card under `plans/done/`, which needs no board to answer --
/// or one naming the board's done column (`doneStatus`, `doneColumnOf`'s
/// name), for a board whose last column is called something else.
export function cardFinished(
  card: DecisionCard,
  plans: ReadonlyMap<string, DecisionCard>,
  doneStatus: string | null
): boolean {
  if (isArchivedCard(card.plan.path)) return true;
  const status = effectiveStatus(card, plans);
  if (status === null) return false;
  const slug = slugStatus(status);
  return slug === "done" || (doneStatus !== null && slug === slugStatus(doneStatus));
}

/// Whether a subject's next move is the human's.
///
/// Every row this tab builds is, today: a card lists here only with an
/// open decision or a waiting agent, and a waiting session, a gate the
/// rail is parked on and a card nobody has read all are. Kept as the one
/// place that says so, because the item rule underneath it
/// (`humanItemWaiting`) is the one that tells an item the agent owes
/// apart, and a kind of item that could fail would land on it.
export function subjectWaits(subject: DecisionSubject): boolean {
  if (subject.kind !== "card") return true;
  return subject.reason !== null || subject.items.some(humanItemWaiting);
}

/// `card:`, `session:`, `gate:`, `unreviewed:` -- the selection keys.
/// One function so the view and the resolver cannot spell them
/// differently.
export function subjectId(kind: DecisionSubjectKind, key: string): string {
  return `${kind}:${key}`;
}

/// Every subject in this workspace, longest wait first.
export function decisionsList(input: DecisionsInput): DecisionsList {
  const blocked = input.itemsBlockedReason ?? null;
  // The tab's own sessions: the ones whose TAB is here, which is where
  // a click on the row lands (nextWaiting.ts's rule, reused rather than
  // re-derived so the tab and the ⇧⌘A button can never disagree about
  // which workspace a wait belongs to).
  const local = workspaceWaiting(input.inbox, input.workspaceId);
  // The FULL inbox by session id, for a card whose agent's tab lives in
  // another workspace: the card is filed here, so its row is here, and
  // it still has to say that its agent is asking.
  const bySession = new Map(input.inbox.map((row) => [row.sessionId, row]));

  const plans = planIndex(input.cards);
  const doneStatus = input.doneStatus ?? null;
  const statusOf = (card: DecisionCard): string | null => effectiveStatus(card, plans);
  // Only a card whose work is still open can ask anything here; the
  // rest keep their items as a record (see `cardFinished`).
  const decisionsOf = (card: DecisionCard): HumanItem[] =>
    blocked || cardFinished(card, plans, doneStatus) ? [] : pendingItems(card.plan, "decision");

  const cardPaths = new Set<string>();
  for (const [path, card] of input.cards) {
    if (decisionsOf(card).length > 0) cardPaths.add(path);
  }
  // A waiting session whose card is in THIS tree joins that card's row
  // rather than standing beside it. Its card may well carry no items at
  // all -- an agent that simply asked a question in its terminal -- and
  // the row is still the card's, because that is what the human is
  // being asked about.
  for (const row of local) {
    if (row.cardPath && input.cards.has(row.cardPath)) cardPaths.add(row.cardPath);
  }

  const claimed = new Set<string>();
  const subjects: DecisionSubject[] = [];
  for (const path of cardPaths) {
    const card = input.cards.get(path);
    if (!card) continue;
    const sessionId = input.bindings.get(path) ?? null;
    // The BINDING's row first, then any local row naming this card. The
    // two differ when a card has been re-launched: the board's binding
    // is the current agent, and a row still naming the card from an
    // older session is the one to fall back to rather than to prefer.
    const row =
      (sessionId ? bySession.get(sessionId) : undefined) ??
      local.find((r) => r.cardPath === path) ??
      null;
    if (row) claimed.add(row.sessionId);
    subjects.push({
      kind: "card",
      id: subjectId("card", path),
      cardPath: path,
      title: card.plan.title.trim() || card.plan.fileName,
      contextFolder: card.contextFolder,
      status: statusOf(card),
      items: decisionsOf(card),
      sessionId,
      reason: row?.reason ?? null,
      row,
      waitedMs: row?.waitedMs ?? null,
      watched: row?.watched ?? false,
    });
  }

  for (const row of local) {
    if (claimed.has(row.sessionId)) continue;
    subjects.push({
      kind: "session",
      id: subjectId("session", row.sessionId),
      row,
      waitedMs: row.waitedMs,
      watched: row.watched,
    });
  }

  const toolNames = new Map((input.tools ?? []).map((t) => [t.id, t.name]));
  for (const rail of input.rails) {
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        const mark = input.marks.get(step.id);
        if (mark === "review") {
          subjects.push({
            kind: "gate",
            id: subjectId("gate", step.id),
            railId: rail.id,
            railName: rail.name,
            stepId: step.id,
            label: (step.toolId ? toolNames.get(step.toolId) : undefined) ?? GATE_FALLBACK_LABEL,
            waitedMs: null,
            watched: false,
          });
        } else if (mark === "unreviewed") {
          const card = input.cards.get(step.cardPath);
          subjects.push({
            kind: "unreviewed",
            id: subjectId("unreviewed", step.id),
            railId: rail.id,
            railName: rail.name,
            stepId: step.id,
            cardPath: step.cardPath,
            title:
              card?.plan.title.trim() ||
              card?.plan.fileName ||
              (step.cardPath.split("/").at(-1) ?? step.cardPath),
            status: card ? statusOf(card) : null,
            waitedMs: null,
            watched: false,
          });
        }
      }
    }
  }

  return {
    subjects: orderSubjects(subjects),
    summary: decisionsSummary(subjects),
    itemsBlockedReason: blocked,
  };
}

/// Where a kind sits when nothing has a measured wait. Cards lead
/// because they carry the human's actual reading; a gate the rail was
/// TOLD to stop on is the least surprising thing in the list and goes
/// last.
const KIND_RANK: Record<DecisionSubjectKind, number> = {
  card: 0,
  session: 1,
  unreviewed: 2,
  gate: 3,
};

/// Longest wait first, which is the whole ordering the list promises.
///
/// An unmeasured wait sorts LAST rather than as a fresh one, which is
/// `attentionInbox`'s own rule and matters more here: two of the four
/// kinds can never have a wait at all (a `review` gate and an
/// unreviewed step have no session, so nothing ever stamped a moment),
/// and giving "no number" the top would put the two rows this list
/// knows least about above every question an agent actually asked.
///
/// Ties fall back to kind then title, so the list does not shuffle as
/// the fleet ticks.
export function orderSubjects(subjects: readonly DecisionSubject[]): DecisionSubject[] {
  return [...subjects].sort(
    (a, b) =>
      (b.waitedMs ?? -1) - (a.waitedMs ?? -1) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      subjectTitle(a).localeCompare(subjectTitle(b)) ||
      a.id.localeCompare(b.id)
  );
}

/// What a row calls itself. One spelling, so the list, the pane heading
/// and the sort all name a subject the same way.
export function subjectTitle(subject: DecisionSubject): string {
  switch (subject.kind) {
    case "card":
      return subject.title;
    case "session":
      return subject.row.tabName;
    case "gate":
      return subject.label;
    case "unreviewed":
      return subject.title;
  }
}

/// The agent's own sentence about why it stopped, or null.
///
/// What it gave up on for a `blocked` row and what broke for a `failed`
/// one -- the half a human actually acts on, and the whole point of
/// listing a blocked agent here: "stopped without finishing" says
/// nothing anybody can do something about, and the line beneath it does.
///
/// Read off the row rather than off the verdict, so the tab has exactly
/// one source for it. `attentionInbox` has already trimmed it and turned
/// a screen it could not read into null, so a caller can draw this
/// without testing it twice.
export function subjectAgentLine(subject: DecisionSubject): string | null {
  if (subject.kind === "card") return subject.row?.failureReason ?? null;
  if (subject.kind === "session") return subject.row.failureReason;
  return null;
}

/// The row's muted second line: what kind of thing this is and what it
/// is part of. Never the wait, which has a column of its own.
export function subjectDetail(subject: DecisionSubject): string {
  switch (subject.kind) {
    case "card": {
      const decisions = subject.items.length;
      // A card row with no items at all is a card whose AGENT is
      // waiting, and saying "0 decisions" about it would be answering a
      // question nobody asked.
      if (decisions === 0) return "this card's agent";
      return decisions === 1 ? "1 decision" : `${decisions} decisions`;
    }
    case "session":
      return `${subject.row.pageName} · no card`;
    case "gate":
      return `${subject.railName} · review gate`;
    case "unreviewed":
      return `${subject.railName} · nobody has read this card`;
  }
}

/// The count (see DecisionsSummary). Taken over the UNORDERED list on
/// purpose -- it is a property of the set, and computing it after the
/// sort would invite someone to make it depend on the order.
export function decisionsSummary(subjects: readonly DecisionSubject[]): DecisionsSummary {
  let waiting = 0;
  for (const subject of subjects) {
    if (subjectWaits(subject)) waiting += 1;
  }
  return { waiting };
}

/// The list head's count. Null for a list with nothing waiting -- the
/// empty state says that better than a zero.
export function summaryLine(summary: DecisionsSummary): string | null {
  if (summary.waiting === 0) return null;
  return summary.waiting === 1 ? "1 waiting on you" : `${summary.waiting} waiting on you`;
}

/// Whether the hub tab should wear its attention mark: anything at all
/// is waiting on the human.
///
/// The WAITING count and not the list length, so a row whose next move
/// is not the human's cannot put a mark on the tab that answering
/// cannot clear.
export function decisionsWaiting(summary: DecisionsSummary): boolean {
  return summary.waiting > 0;
}

/// The quiet line for an empty list. Its own constant rather than a
/// literal in the template, because it is half of a pair: the OTHER
/// empty state is `itemsBlockedReason`, and "nothing is waiting" and
/// "gavin cannot see what is waiting" are opposite facts that must never
/// be drawn with the same sentence.
export const NOTHING_WAITING = "Nothing in this workspace is waiting on you.";
/// The empty state for a list the search or the status filter emptied.
/// A third sentence and never either of the two above: the workspace may
/// well have things waiting, and saying "nothing" with a filter on is
/// how a human comes to believe it.
export const NOTHING_MATCHES = "Nothing waiting on you matches that.";

/// The selection re-resolved against the list, never merely remembered:
/// the list moves under it as agents answer, as cards are written and as
/// rails advance, and a selection pointing at a row that has gone leaves
/// an empty pane beside a list with plenty in it.
///
/// Falls back to the FIRST row, which is the longest wait -- the row the
/// human would have picked.
export function resolveSelection(
  subjects: readonly DecisionSubject[],
  selected: string | null
): string | null {
  if (subjects.length === 0) return null;
  if (selected && subjects.some((s) => s.id === selected)) return selected;
  return subjects[0].id;
}

// ---- searching and filtering ------------------------------------------
//
// The list can run long -- every open question on every card still in
// play -- so it takes a search and a status filter. Both narrow what is
// SHOWN and nothing else: the count, the tab's attention mark and the
// summary are taken over the whole list, so a filter can never make the
// tab say that nothing is waiting.

/// The status key of a row with no card behind it: a waiting session
/// nobody filed a card for, or a rail review gate. They have no status,
/// and leaving them out of every option would make them unreachable the
/// moment any status was picked. A colon, which `slugStatus` never
/// produces, so no column name can collide with it.
export const NO_CARD_STATUS = ":no-card";
/// ...and of a card with no `status:` line at all.
export const NO_STATUS = ":no-status";

export interface DecisionsFilter {
  query: string;
  /// The status keys to show (`subjectStatusKey`). Empty shows them all.
  statuses: readonly string[];
}

/// One choice in the status filter.
export interface StatusOption {
  key: string;
  label: string;
  /// How many rows of the WHOLE list carry this status, so the picker
  /// says what each choice holds before it is made.
  count: number;
}

/// Which status a row is filed under: the card's effective status,
/// slugged the way the board matches a status to a column, or one of the
/// two keys above.
export function subjectStatusKey(subject: DecisionSubject): string {
  if (subject.kind === "card" || subject.kind === "unreviewed") {
    return subject.status === null ? NO_STATUS : slugStatus(subject.status) || NO_STATUS;
  }
  return NO_CARD_STATUS;
}

/// What the status filter offers: the board's columns in board order,
/// minus the done column -- nothing finished asks anything here, so that
/// option could only ever empty the list -- and after them any status the
/// list actually holds that no column names (a hand-written status the
/// board draws in a column of its own, "No status", "No card"). Those
/// appear only while a row carries them.
export function statusOptions(
  columns: readonly Column[],
  doneStatus: string | null,
  subjects: readonly DecisionSubject[]
): StatusOption[] {
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const key = subjectStatusKey(subject);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const done = doneStatus ? slugStatus(doneStatus) : null;
  const options: StatusOption[] = [];
  const seen = new Set<string>();
  for (const column of [...columns].sort((a, b) => a.position - b.position)) {
    const key = slugStatus(column.name);
    if (!key || key === done || seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: column.name, count: counts.get(key) ?? 0 });
  }
  const extras: StatusOption[] = [];
  for (const subject of subjects) {
    const key = subjectStatusKey(subject);
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      key === NO_CARD_STATUS
        ? "No card"
        : key === NO_STATUS
          ? "No status"
          : (subject.kind === "card" || subject.kind === "unreviewed" ? subject.status : null) ?? key;
    extras.push({ key, label, count: counts.get(key) ?? 0 });
  }
  // The two keys that are not statuses go last, after every real one.
  const rank = (key: string): number => (key === NO_STATUS ? 1 : key === NO_CARD_STATUS ? 2 : 0);
  extras.sort((a, b) => rank(a.key) - rank(b.key));
  return [...options, ...extras];
}

/// The chosen statuses the picker still offers. A key whose column was
/// renamed or deleted is dropped rather than obeyed -- `pruneFacets`'
/// rule: a filter on a value the picker no longer shows would empty the
/// list with nothing on screen to say why.
export function activeStatuses(
  statuses: readonly string[],
  options: readonly StatusOption[]
): string[] {
  const offered = new Set(options.map((o) => o.key));
  return statuses.filter((key) => offered.has(key));
}

/// One status ticked or unticked in the picker.
export function toggleStatus(statuses: readonly string[], key: string): string[] {
  return statuses.includes(key) ? statuses.filter((k) => k !== key) : [...statuses, key];
}

/// The picker's closed label: "All", or the chosen statuses by name.
export function statusFilterLabel(
  statuses: readonly string[],
  options: readonly StatusOption[]
): string {
  const active = new Set(activeStatuses(statuses, options));
  if (active.size === 0) return "All";
  return options
    .filter((o) => active.has(o.key))
    .map((o) => o.label)
    .join(", ");
}

/// Whether the search or the status filter is narrowing the list.
export function decisionsFiltering(
  filter: DecisionsFilter,
  options: readonly StatusOption[]
): boolean {
  return queryTokens(filter.query).length > 0 || activeStatuses(filter.statuses, options).length > 0;
}

/// Everything a search reads on a row: what the row shows, and what the
/// pane beside it would show -- the questions themselves, their options
/// and the last answer line, so a decision is found by what it asks.
export function subjectSearchFields(subject: DecisionSubject): Field[] {
  const shown: Field[] = [subjectTitle(subject), subjectDetail(subject), subjectAgentLine(subject)];
  switch (subject.kind) {
    case "card":
      return [
        ...shown,
        subject.cardPath.split("/").at(-1),
        subject.status,
        subject.row?.tabName,
        ...subject.items.flatMap((item) => [item.text, item.latest, ...item.options]),
      ];
    case "session":
      return [...shown, subject.row.pageName, subject.row.cardTitle];
    case "gate":
      return [...shown, subject.railName];
    case "unreviewed":
      return [...shown, subject.railName, subject.cardPath.split("/").at(-1), subject.status];
  }
}

/// The rows the list shows: the whole list narrowed by the status filter
/// and the search, order kept.
export function filterSubjects(
  subjects: readonly DecisionSubject[],
  filter: DecisionsFilter,
  options: readonly StatusOption[]
): DecisionSubject[] {
  const statuses = new Set(activeStatuses(filter.statuses, options));
  const tokens = queryTokens(filter.query);
  return subjects.filter(
    (subject) =>
      (statuses.size === 0 || statuses.has(subjectStatusKey(subject))) &&
      matchesFields(tokens, subjectSearchFields(subject))
  );
}

// ---- answering --------------------------------------------------------
//
// The payloads, and the refusals that come before them. Here rather
// than in the component for the reason every other pure module in this
// tree exists: what an answer MEANS is worth a test, and mounting the
// tab to reach it needs a daemon, a window and a PTY.

/// Why this answer cannot be sent yet, or null.
///
/// An empty answer is the one refusal worth having: the daemon would
/// take it and write `Answer (date):` with nothing after the colon,
/// which reads on the card as a question that was answered rather than
/// one that was not.
export function answerRefusal(option: string | null, note: string): string | null {
  if (!option && note.trim() === "") return "Pick an option or write an answer first.";
  return null;
}

/// Why a failure cannot be recorded yet, or null.
///
/// A note is REQUIRED to fail, unlike to pass, and the asymmetry is the
/// point: a pass is self-explanatory and a failure is a handover. The
/// item goes back to an agent whose only instruction is this line, so
/// `Result (date): failed —` with nothing after it would be a rejection
/// with no brief, and the agent's best move would be to ask what broke.
export function failRefusal(note: string): string | null {
  if (note.trim() === "") return "Say what went wrong — the agent has only this line to work from.";
  return null;
}

/// What a decision's answer says, from the option the human picked and
/// the note they wrote. Both, when there are both: the option is the
/// choice and the note is the why, and a card that recorded only one of
/// them would lose the half the next agent needs.
export function answerText(option: string | null, note: string): string {
  const trimmed = note.trim();
  if (option && trimmed) return `${option} — ${trimmed}`;
  return option ?? trimmed;
}

/// The `ResolveHumanItem` outcome for a decision.
export function answerOutcome(option: string | null, note: string): HumanItemOutcome {
  return { kind: "answer", text: answerText(option, note) };
}

/// The outcome for a test that passed. A function rather than a
/// constant so every call site in the tab spells an outcome the same
/// way, and so a `$state` proxy can never be handed to the wire.
export function passOutcome(): HumanItemOutcome {
  return { kind: "pass" };
}

/// A plain fail: the result is written, the box stays unticked, and the
/// item goes back to the agent.
export function failOutcome(note: string): HumanItemOutcome {
  return { kind: "fail", note: note.trim() };
}

/// The human overruling that: the same note, and the box ticked.
export function failAndCloseOutcome(note: string): HumanItemOutcome {
  return { kind: "failAndClose", note: note.trim() };
}

/// What "Fail and close" asks before it does anything.
///
/// It is the one action in the tab that ENDS something: a plain fail
/// leaves the test owed and re-armable, and closing it means no agent
/// will ever be asked to fix it. So it is asked for rather than
/// pressed, through the app's own prompt (`askConfirm`) -- there are no
/// native dialogs here, and `@tauri-apps/plugin-dialog`'s `confirm`
/// fails at the permission layer.
export interface FailAndCloseConfirm {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
  danger: true;
}

export function failAndCloseConfirm(item: HumanItem): FailAndCloseConfirm {
  return {
    title: `Close “${item.text}” as failed?`,
    lines: [
      "The failed result is written on the card and the item is ticked, so nothing will ask for it again.",
      "Fail on its own leaves the test owed: the agent can fix the work and re-file the same test, which re-arms this item instead of adding a second one.",
    ],
    confirmLabel: "Fail and close",
    cancelLabel: "Keep it open",
    danger: true,
  };
}

// ---- telling the agent ------------------------------------------------

/// The one message queued to a card's agent after its item is settled.
///
/// One message per answer, and it says WHERE the record is rather than
/// standing in for it: the card carries the `Answer (date):` /
/// `Result (date):` line, and an agent that trusted a paraphrase in its
/// prompt over the file would drift from what the human actually wrote.
///
/// The failure cases name the next move, because they are the two where
/// the agent has one: a plain fail is work to redo and a test to
/// re-file, and a closed one is neither.
export function notifyMessage(
  cardPath: string,
  item: HumanItem,
  outcome: HumanItemOutcome
): string {
  const what = item.kind === "decision" ? "decision" : "human test";
  const head = `I answered the ${what} “${item.text}” on ${cardPath}.`;
  const read = `Read the item's line on the card for exactly what I wrote, then carry on.`;
  switch (outcome.kind) {
    case "answer":
      return `${head} My answer: ${outcome.text}. ${read}`;
    case "pass":
      return `${head} It passed. ${read}`;
    case "fail":
      return (
        `${head} It FAILED: ${outcome.note || "no note"}. It is back with you — fix the work, ` +
        `then file the same test again with gavin_request_human to re-arm it. ${read}`
      );
    case "failAndClose":
      return (
        `${head} It FAILED and I have closed it: ${outcome.note || "no note"}. Do not re-file ` +
        `it; if it matters, it will come back as a new card. ${read}`
      );
  }
}

/// Why no message was queued, said to the human looking at an answer
/// that has landed on the card and nowhere else.
///
/// The parent plan's rule: the app queues one message when the card's
/// session is live and not interrupted, and otherwise nothing is sent
/// and the answer waits on the card for the next agent to read. That is
/// a perfectly good outcome -- but it is one the human has to be told
/// about, because they pressed a button expecting the agent to hear it.
export function notifySkipped(reason: string): string {
  return `Answered on the card. The agent was not told: ${reason}`;
}

/// The two sentences for the two ways there is nobody to tell. Shared
/// with the actions module so the tab says one thing about each.
export const NO_SESSION_REASON = "nothing has run this card, so the answer waits on the card itself.";
export const SESSION_GONE_REASON =
  "this card's agent is no longer running, so the answer waits on the card itself.";
