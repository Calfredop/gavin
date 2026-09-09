// The group-template library, as pure data and pure functions (grouping
// spec G7/G8). No Svelte, no Tauri, no I/O -- groupTemplatesState.ts owns
// every side effect. TS mirrors of crates/protocol's GroupTemplate
// (camelCase on the wire).
//
// A template is a group you can place again: an ordered list of TOOL
// steps and the discipline they run under. There are no built-ins --
// every template is something the human saved off a group they built.

import { stageMode, stepParams, isToolStep } from "$lib/orchestration";
import type { Stage, StageMode, Step } from "$lib/orchestration";

/// Where a template came from. Derived from the wire's `workspaceId`,
/// never stored: null is global, a string is that workspace's own.
export type GroupTemplateScope = "workspace" | "global";

export interface GroupTemplateStep {
  toolId: string;
  toolParams: Record<string, string>;
}

export interface GroupTemplate {
  id: string;
  name: string;
  description: string;
  mode: StageMode;
  steps: GroupTemplateStep[];
  scope: GroupTemplateScope;
}

/// One template as the daemon stores it. `workspaceId` IS the scope.
export interface GroupTemplateRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  mode: StageMode;
  steps: GroupTemplateStep[];
  position: number;
}

/// The library, in the order the drawer shows it: this workspace's own
/// first, then the machine's, each alphabetical -- a stable order, so a
/// template stays where the human last saw it.
export function templateLibrary(records: GroupTemplateRecord[]): GroupTemplate[] {
  const rank = (t: GroupTemplate) => (t.scope === "workspace" ? 0 : 1);
  return records
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      mode: r.mode === "sequence" ? ("sequence" as const) : ("parallel" as const),
      steps: r.steps,
      scope: (r.workspaceId === null ? "global" : "workspace") as GroupTemplateScope,
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function toTemplateRecord(
  t: GroupTemplate,
  workspaceId: string,
  position: number
): GroupTemplateRecord {
  if (t.name.trim() === "") throw new Error("A template needs a name.");
  if (t.steps.length === 0) throw new Error("A template needs at least one tool step.");
  return {
    id: t.id,
    workspaceId: t.scope === "global" ? null : workspaceId,
    name: t.name.trim(),
    description: t.description.trim(),
    mode: t.mode,
    steps: t.steps,
    position,
  };
}

/// A template built from a group the human already arranged. CARD steps
/// are excluded (G7): a card path is absolute and belongs to one
/// workspace, so it can never travel. Pair this with droppedCardCount so
/// the form can say what it left behind -- a template that silently lost
/// half a group is worse than one that refuses to save.
export function templateFromStage(
  stage: Stage,
  name: string,
  description: string,
  scope: GroupTemplateScope
): GroupTemplate {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    mode: stageMode(stage),
    steps: [...stage.steps]
      .sort((a, b) => a.position - b.position)
      .filter(isToolStep)
      .map((s) => ({ toolId: s.toolId as string, toolParams: { ...stepParams(s) } })),
    scope,
  };
}

/// How many of this group's steps a template would have to leave behind.
export function droppedCardCount(stage: Stage): number {
  return stage.steps.filter((s) => !isToolStep(s)).length;
}

/// The steps a placement mints. Ids are FRESH every time: a step id is a
/// run-state key, so reusing one would graft a finished run onto a step
/// that has not started. `mintId` is injected so tests can be
/// deterministic; production passes crypto.randomUUID.
export function stepsFromTemplate(t: GroupTemplate, mintId: () => string): Step[] {
  return t.steps.map((s, i) => ({
    id: mintId(),
    position: i,
    cardPath: "",
    toolId: s.toolId,
    toolParams: { ...s.toolParams },
  }));
}
