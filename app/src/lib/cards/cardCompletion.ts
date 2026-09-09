// What filing a plan as done does to the tasks nested inside it, and the
// one prompt that says so before it happens.
//
// A nested task has no status of its own -- `effectiveStatus` reads the
// parent's -- so it cannot be finished, or even started, independently,
// and it travels into `plans/done/` when the parent does. That is the
// point of nesting: the child finishes when the plan finishes. What was
// missing is anywhere the claim is STATED. A drag to the done column
// swept every child out of the board with no warning and nothing to say
// they were unfinished, which is how two untouched follow-on tasks
// nearly went into `done/` behind a plan whose own checklist was
// complete.
//
// So this is the deletion cascade's shape (`cardDelete.ts`) for the
// status path: name what travels, and offer the one escape that already
// exists -- giving a child a `status:`, which un-nests it into that
// column while KEEPING the `parent:` link. Nothing here refuses
// anything; the default answer is what the app has always done.

import * as backend from "$lib/backend";
import { askConfirm, askConfirmChecked, type ConfirmOptions } from "$lib/dialog";
import { patchPlanField, patchPlanPath } from "$lib/gavinState";
import { doneColumnOf, firstColumnOf } from "$lib/orchestration/orchestration";
import { slugStatus, type CardView } from "$lib/planBoard";
import type { Column } from "$lib/board/kanban";

/// A nested child as the prompt needs it: enough to name it and to write
/// its status. Deliberately not `CardView` -- the rail header's "Move
/// all to…" holds `CardEntry`s from the orchestration tree, and one
/// shape both sides can build is what keeps a second nesting rule from
/// growing there.
export interface CompletionChild {
  path: string;
  title: string;
}

/// The card being filed, reduced to what the question depends on.
export interface CompletionSubject {
  title: string;
  kind: "note" | "task" | "plan";
  /// Its status BEFORE the write, so a card already in the done column
  /// is not asked about again.
  status: string | null;
  children: CompletionChild[];
}

export interface CompletionCascade {
  parentTitle: string;
  /// The column being written -- named in the prompt, because a board
  /// whose terminal column is "Shipped" must not be asked about "Done".
  targetColumn: string;
  children: CompletionChild[];
  /// Whether the daemon will MOVE these files. `plans/done/` is a slug
  /// rule over there (`is_done_status`), not the board's column order,
  /// so a terminal column named "Shipped" finishes the work without the
  /// files going anywhere -- and the prompt must not promise a folder
  /// move that will not happen.
  filesUnderDone: boolean;
  /// Where "keep them on the board" would put them, or null when there
  /// is nowhere to put them (a board whose only column is the done one).
  breakOutColumn: string | null;
}

/// The question, or null when there is nothing to ask about.
///
/// Null for: a card that is not a plan, a plan carrying no nested
/// children, a board with no columns, a target that is not the board's
/// terminal column, and a card already sitting in that column. Only the
/// TRANSITION into done is a moment where a human learns something.
export function completionCascadeFor(
  card: CompletionSubject,
  targetStatus: string,
  columns: Column[]
): CompletionCascade | null {
  if (card.kind !== "plan" || card.children.length === 0) return null;
  const done = doneColumnOf(columns);
  if (!done) return null;
  const doneSlug = slugStatus(done.name);
  if (slugStatus(targetStatus) !== doneSlug) return null;
  if (card.status !== null && slugStatus(card.status) === doneSlug) return null;
  const first = firstColumnOf(columns);
  return {
    parentTitle: card.title,
    targetColumn: done.name,
    children: card.children,
    filesUnderDone: doneSlug === "done",
    breakOutColumn: first && slugStatus(first.name) !== doneSlug ? first.name : null,
  };
}

/// The same question asked of a board card, which already carries its
/// nested children.
export function subjectFromCard(card: CardView): CompletionSubject {
  return {
    title: card.title,
    kind: card.kind,
    status: card.status,
    children: card.nestedChildren.map((c) => ({ path: c.id, title: c.title })),
  };
}

/// The prompt. The title describes what the confirm button does with the
/// box LEFT ALONE -- the children travel, exactly as they always have.
/// The tick-box is the variation (dialog.ts's `ConfirmCheck`), not a
/// second "are you sure": asking twice is how a human learns to dismiss
/// the second one unread.
///
/// Not `danger`: nothing is destroyed and taking the plan off done
/// brings the whole family back. Marking it danger would put focus on
/// Cancel and make the ordinary answer the awkward one.
export function completionPrompt(cascade: CompletionCascade): ConfirmOptions {
  const n = cascade.children.length;
  const tasks = n === 1 ? "nested task" : "nested tasks";
  return {
    title: `Move “${cascade.parentTitle}” to ${cascade.targetColumn} with its ${n} ${tasks}?`,
    lines: [
      ...cascade.children.map((c) => `“${c.title}”`),
      `A nested task has no status of its own, so it is done when this plan is.`,
      ...(cascade.filesUnderDone
        ? [n === 1 ? "Its file moves into plans/done/ too." : "Their files move into plans/done/ too."]
        : []),
    ],
    confirmLabel: `Move to ${cascade.targetColumn}`,
    check: cascade.breakOutColumn
      ? {
          label: `Keep ${n === 1 ? "it" : "them"} on the board — move ${
            n === 1 ? "it" : "them"
          } to ${cascade.breakOutColumn} instead`,
          default: false,
        }
      : undefined,
  };
}

/// What a call site does next. `error` names the file a break-out write
/// failed on, in the same voice as every other flow here; `proceed` is
/// false only when the human cancelled, which is not an error and has
/// nothing to report.
export interface CompletionDecision {
  proceed: boolean;
  error: string | null;
}

const GO: CompletionDecision = { proceed: true, error: null };

/// Ask before a status write files a plan, and carry out the escape when
/// the human takes it.
///
/// Breaking a child out is one `status:` write -- the same write the
/// card's own "Move to …" makes -- so the child becomes a free-standing
/// card in the first column and keeps its `parent:` link. Sequential and
/// patch-on-success like every other write flow here; a failure stops
/// before the parent is filed, because filing it then would sweep the
/// children that had not been rescued.
export async function guardCompletion(
  workspaceId: string,
  card: CompletionSubject,
  targetStatus: string,
  columns: Column[]
): Promise<CompletionDecision> {
  const cascade = completionCascadeFor(card, targetStatus, columns);
  if (!cascade) return GO;
  const options = completionPrompt(cascade);
  const answer = options.check
    ? await askConfirmChecked({ ...options, check: options.check })
    : { confirmed: await askConfirm(options), checked: false };
  if (!answer.confirmed) return { proceed: false, error: null };
  if (!answer.checked || !cascade.breakOutColumn) return GO;
  return breakOutChildren(workspaceId, cascade.children, cascade.breakOutColumn);
}

/// The escape on its own, for the surfaces that offer it outside the
/// prompt: the detail modal's Tasks list and the `nested-with-parent`
/// conflict repair.
export async function breakOutChildren(
  workspaceId: string,
  children: CompletionChild[],
  columnName: string
): Promise<CompletionDecision> {
  let current = "";
  try {
    for (const child of children) {
      current = child.path;
      const moved = await backend.setPlanFrontmatterField(child.path, "status", columnName);
      patchPlanField(workspaceId, child.path, "status", columnName);
      // A child rescued out of a parent that was already under done/
      // comes back up into plans/, and the path is its identity
      // everywhere -- the open modal, a rail step, a binding.
      if (moved && moved !== child.path) patchPlanPath(workspaceId, child.path, moved);
    }
    return GO;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return {
      proceed: false,
      error: `Couldn't move ${fileName} to ${columnName}: ${e instanceof Error ? e.message : e}`,
    };
  }
}
