// Where a drop on the orchestration grid actually goes.
//
// Five drag kinds cross three drop targets, and the fifteen cells are not
// symmetric: a card and a tool place into a stage or start a new one, a
// template does the same but has to be resolved against the library
// first, a whole stage moves or is removed, and a step -- the only kind
// that is already ON the plan -- is the one that can be dropped back off
// it. The routing was a chain of `if (drag.kind === …)` inside the drag
// engine's callback, where nothing could reach it.
//
// So the decision is separated from the doing: this answers WHICH write a
// drop asks for, and the caller runs it. What that buys is the gate --
// the one rule here that is not a mapping.

import type { ActiveOrchDrag, OrchDropTarget } from "$lib/orchestration/orchestrationDrag";
import type { GroupTemplate } from "$lib/orchestration/orchestrationGroups";

/// A drop that has landed: the engine only calls commit with a target.
export type CommittedDrag = ActiveOrchDrag & { target: OrchDropTarget };

export type DropIntent =
  /// The daemon cannot carry this write. Carries the reason verbatim, so
  /// the drawer rows, the header's controls and a drop all say the same
  /// sentence about the same missing version.
  | { kind: "blocked"; reason: string }
  | { kind: "move-stage"; stageId: string; railId: string; index: number }
  /// Removing a stage takes every step it holds off the plan, so it asks
  /// first rather than running straight through.
  | { kind: "confirm-remove-stage"; stageId: string }
  | { kind: "add-card-to-stage"; stageId: string; cardPath: string; index: number }
  | { kind: "add-card-as-stage"; railId: string; cardPath: string; index: number }
  | { kind: "add-tool-to-stage"; stageId: string; toolId: string; index: number }
  | { kind: "add-tool-as-stage"; railId: string; toolId: string; index: number }
  | { kind: "add-template-to-stage"; stageId: string; template: GroupTemplate; index: number }
  | { kind: "add-template-as-stage"; railId: string; template: GroupTemplate; index: number }
  | { kind: "remove-step"; stepId: string }
  | { kind: "move-step-into-stage"; stepId: string; stageId: string; index: number }
  | { kind: "move-step-to-new-stage"; stepId: string; railId: string; index: number };

export interface DropContext {
  /// featureBlockedReason for `groups`, or null when the daemon can
  /// carry a stage `mode`.
  groupsBlocked: string | null;
  /// The library the drawer was rendered from. A template dragged out of
  /// it and deleted mid-drag (another session, the manager tab) resolves
  /// to nothing, and the drop does nothing rather than placing a stale
  /// copy.
  templates: GroupTemplate[];
}

/// Whether a drop would create or grow a GROUP, and so needs a daemon
/// that can carry `mode` (FEATURE_MIN_VERSION.groups). A pre-v15 daemon
/// has neither column and would silently hand the stage back parallel.
///
/// Three cases, and only two of them are forced. `into-stage` turns a
/// single-step stage into a group or grows one, and a template writes
/// `mode` whichever target it lands on -- placing one is how a group gets
/// formed. A whole-stage drag is gated as a matter of SCOPE rather than
/// necessity: neither of its reachable targets writes `mode` (removeStage
/// and moveStageToIndex both run correctly on v14), but the gesture only
/// exists because groups do. Deliberately conservative.
export function wouldGroup(drag: CommittedDrag): boolean {
  return drag.target.kind === "into-stage" || drag.kind === "stage" || drag.kind === "template";
}

/// Null for a drop with nothing to do: a stage dragged onto a target its
/// own kind never reaches, or a template the library no longer holds.
export function dropIntent(drag: CommittedDrag, ctx: DropContext): DropIntent | null {
  // Before any mapping: refusing here, rather than inside each mutator,
  // is what keeps one message for all three ways of asking.
  if (wouldGroup(drag) && ctx.groupsBlocked) return { kind: "blocked", reason: ctx.groupsBlocked };

  const target = drag.target;
  if (drag.kind === "stage") {
    // `into-stage` never occurs for this kind -- computeOrchDropTarget
    // skips the stage loop outright for a "stage" drag, since nested
    // groups are out of scope -- so the remaining two are the whole set.
    if (target.kind === "new-stage")
      return { kind: "move-stage", stageId: drag.id, railId: target.railId, index: target.index };
    if (target.kind === "unplace") return { kind: "confirm-remove-stage", stageId: drag.id };
    return null;
  }

  if (drag.kind === "card") {
    if (target.kind === "into-stage")
      return { kind: "add-card-to-stage", stageId: target.stageId, cardPath: drag.id, index: target.index };
    if (target.kind === "new-stage")
      return { kind: "add-card-as-stage", railId: target.railId, cardPath: drag.id, index: target.index };
    return null;
  }

  if (drag.kind === "tool") {
    if (target.kind === "into-stage")
      return { kind: "add-tool-to-stage", stageId: target.stageId, toolId: drag.id, index: target.index };
    if (target.kind === "new-stage")
      return { kind: "add-tool-as-stage", railId: target.railId, toolId: drag.id, index: target.index };
    return null;
  }

  if (drag.kind === "template") {
    const template = ctx.templates.find((t) => t.id === drag.id);
    if (!template) return null;
    if (target.kind === "into-stage")
      return { kind: "add-template-to-stage", stageId: target.stageId, template, index: target.index };
    if (target.kind === "new-stage")
      return { kind: "add-template-as-stage", railId: target.railId, template, index: target.index };
    return null;
  }

  // A step, the one kind already on the plan -- and so the only one that
  // can be dropped back off it.
  if (target.kind === "unplace") return { kind: "remove-step", stepId: drag.id };
  if (target.kind === "into-stage")
    return { kind: "move-step-into-stage", stepId: drag.id, stageId: target.stageId, index: target.index };
  return { kind: "move-step-to-new-stage", stepId: drag.id, railId: target.railId, index: target.index };
}
