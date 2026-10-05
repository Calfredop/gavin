import type { Workspace } from "$lib/core/workspace";

// A workspace record holds two things with two different owners
// (docs/adr/0006-workspace-settings-apart-from-layout.md):
//
// - its SETTINGS -- the Workstation data: what it is called, where it
//   lives, the Settings tab's switches, the consent and trust stamps,
//   the runs in flight. Written through `set_workspace_settings`, which a
//   Companion is allowed to call.
// - the desk's LAYOUT -- where things are on THIS screen: pages and their
//   pane trees, which page, view and tab is showing, sidebar pins, divider
//   and splitter positions. Written through `set_workspaces_state`, which a
//   Companion is refused.
//
// The host holds both halves and is the authority on each: a layout save
// takes only layout from its payload (for a workspace it already knows),
// and a settings write takes only settings. So a desk saving a stale copy
// cannot undo a setting the phone just changed, and nothing the phone
// sends can move a tab.
//
// config.json itself is unchanged -- both halves still live in one
// workspace object on disk -- because a release install and a dev build
// share that file, and an older build must go on reading it as its own.
//
// Must list the same keys as `workspace_settings.rs` on the Rust side;
// `workspaceSettingsParity.test.ts` holds the two to it.

/// Where things are on the desk's screen. A Companion never writes these.
export const WORKSPACE_LAYOUT_KEYS = [
  "pages",
  "activePageId",
  "activeView",
  "hubView",
  // The Home tab's agent cell: which session sits there is placement.
  "mainSessionId",
  "homeAgentShare",
  // Splitter widths, diff layout, the selected worktree: the Git tab's
  // view state. (Its in-flight commit record rides along; a Companion that
  // starts a commit will need that record on the settings side.)
  "gitView",
  "lastActiveAt",
  "pinnedAt",
] as const satisfies readonly (keyof Workspace)[];

/// Everything else about a workspace: the Workstation data.
export const WORKSPACE_SETTINGS_KEYS = [
  "name",
  "rootPath",
  "ssh",
  "color",
  "notifyNeedsInput",
  "notifyFinished",
  "confirmTabClose",
  "terminalFontSize",
  "autoCommit",
  "autoResumeRuns",
  "agentPause",
  "agentFallback",
  "armedAgents",
  "declinedAgents",
  "complexityAgents",
  "gitTrackingAsked",
  "trustedConfigHash",
  "mcpForeignServersChoice",
  "reviewedCards",
  "requireReview",
  "requireReviewAsked",
  "headroom",
  "headroomAsked",
  "customResumeArgs",
  "customProfiles",
  "actionPromptOverrides",
  // Runs in flight are not layout: a Generate or a Develop started from
  // the phone has to be able to claim its slot as well.
  "orchestrationAgent",
  "developingCards",
] as const satisfies readonly (keyof Workspace)[];

export type WorkspaceLayoutKey = (typeof WORKSPACE_LAYOUT_KEYS)[number];
export type WorkspaceSettingsKey = (typeof WORKSPACE_SETTINGS_KEYS)[number];

/// Compiles only while `T` is `never`.
type AssertNever<T extends never> = T;
/// A `Workspace` key on neither list fails to compile here: a new field has
/// to be given a side before it can ship, because a key on no list is one
/// the host's layout merge would silently throw away.
export type UnclassifiedWorkspaceKeys = AssertNever<
  Exclude<keyof Workspace, "id" | WorkspaceLayoutKey | WorkspaceSettingsKey>
>;
/// And no key may sit on both.
export type DoublyClassifiedWorkspaceKeys = AssertNever<Extract<WorkspaceLayoutKey, WorkspaceSettingsKey>>;

export type WorkspaceSettings = Pick<Workspace, WorkspaceSettingsKey>;

/// A change to some of one workspace's settings. A key left out is
/// untouched; `null` clears an optional key back to absent -- inherit, or
/// the default -- and is not offered for a required one (`name`).
export type WorkspaceSettingsPatch = {
  [K in WorkspaceSettingsKey]?: undefined extends Workspace[K] ? Workspace[K] | null : Workspace[K];
};

/// One workspace's Workstation data, as `get_workspace_settings` and the
/// `workspace-settings-synced` event carry it: its id plus the settings it
/// has, and nothing of the layout.
export type WorkspaceSettingsRecord = { id: string } & Partial<WorkspaceSettings>;

const SETTINGS = new Set<string>(WORKSPACE_SETTINGS_KEYS);

export function isSettingsKey(key: string): key is WorkspaceSettingsKey {
  return SETTINGS.has(key);
}

/// The patch as it must cross the wire. An `undefined` value becomes
/// `null`: JSON drops an undefined key, so a clear written the way the
/// setters have always written one (`autoCommit: enabled ?? undefined`)
/// would otherwise arrive as an empty patch and change nothing.
export function normalizeSettingsPatch(patch: WorkspaceSettingsPatch): WorkspaceSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) out[key] = value === undefined ? null : value;
  return out as WorkspaceSettingsPatch;
}

/// One workspace with a patch applied: `null`/`undefined` removes the key,
/// anything else sets it. Only settings keys are read from the patch, so
/// this can never move a layout key however the patch was built -- the
/// same refusal the host makes.
function withSettingsPatch(ws: Workspace, patch: WorkspaceSettingsPatch): Workspace {
  const next: Record<string, unknown> = { ...ws };
  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingsKey(key)) continue;
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Workspace;
}

/// The workspaces with `patch` applied to the one named. The same array
/// back when no workspace has that id, so a caller can tell a no-op.
export function patchWorkspaceSettings(
  workspaces: Workspace[],
  workspaceId: string,
  patch: WorkspaceSettingsPatch
): Workspace[] {
  if (!workspaces.some((w) => w.id === workspaceId)) return workspaces;
  return workspaces.map((w) => (w.id === workspaceId ? withSettingsPatch(w, patch) : w));
}

/// The id and the settings a workspace has -- its Workstation data.
export function settingsRecordOf(ws: Workspace): WorkspaceSettingsRecord {
  const record: Record<string, unknown> = { id: ws.id };
  for (const key of WORKSPACE_SETTINGS_KEYS) {
    if (ws[key] !== undefined) record[key] = ws[key];
  }
  return record as WorkspaceSettingsRecord;
}

/// Takes another writer's settings for one workspace and keeps this
/// window's layout of it. The record is the WHOLE of that workspace's
/// settings, so a key it does not carry is removed here too -- that is how
/// a clear made elsewhere reaches this window. Layout keys in the record,
/// which should never be there, are ignored.
export function adoptSettingsRecord(workspaces: Workspace[], record: WorkspaceSettingsRecord): Workspace[] {
  if (!workspaces.some((w) => w.id === record.id)) return workspaces;
  return workspaces.map((w) => {
    if (w.id !== record.id) return w;
    const next: Record<string, unknown> = { ...w };
    for (const key of WORKSPACE_SETTINGS_KEYS) delete next[key];
    for (const [key, value] of Object.entries(record)) {
      if (isSettingsKey(key) && value !== undefined && value !== null) next[key] = value;
    }
    return next as unknown as Workspace;
  });
}
