// The Git tab's state: one GitViewState per workspace (spec §4). Pure
// reducers up top (tested directly), store actions below. Refresh is
// watcher/activation/mutation-driven — never a timer (G9).

import { writable, get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import type { ApplyMode, Area, FileDiff, FileEntry, RepoInfo, StatusResult } from "./git";

export interface Selection {
  path: string;
  area: Area;
}

export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
}

export interface GitViewState {
  cwd: string;
  repo: RepoInfo | null;
  status: StatusResult | null;
  selected: Selection | null;
  diff: FileDiff | null;
  lineSelection: Set<string>;
  commit: CommitDraft;
  /// The draft as it was before Amend was ticked, restored on untick.
  preAmend: { summary: string; description: string } | null;
  busy: string | null;
  error: string | null;
  gitMissing: boolean;
  refreshToken: number;
  diffToken: number;
}

export const GIT_NOT_FOUND = "git was not found on PATH";

export const gitStore = writable<Record<string, GitViewState>>({});

export function initialState(cwd: string): GitViewState {
  return {
    cwd,
    repo: null,
    status: null,
    selected: null,
    diff: null,
    lineSelection: new Set(),
    commit: { summary: "", description: "", amend: false },
    preAmend: null,
    busy: null,
    error: null,
    gitMissing: false,
    refreshToken: 0,
    diffToken: 0,
  };
}

// ---- pure ------------------------------------------------------------------

export function findEntry(status: StatusResult | null, sel: Selection | null): FileEntry | null {
  if (!status || !sel) return null;
  return status[sel.area].find((e) => e.path === sel.path) ?? null;
}

/// Spec §1 selection follow rule: stay if still present, else the
/// counterpart list, else nothing.
export function followSelection(status: StatusResult, sel: Selection | null): Selection | null {
  if (!sel) return null;
  if (findEntry(status, sel)) return sel;
  const other: Area = sel.area === "unstaged" ? "staged" : "unstaged";
  if (findEntry(status, { path: sel.path, area: other })) return { path: sel.path, area: other };
  return null;
}

export function applyStatus(state: GitViewState, status: StatusResult): GitViewState {
  const selected = followSelection(status, state.selected);
  const moved = selected?.path !== state.selected?.path || selected?.area !== state.selected?.area;
  return {
    ...state,
    status,
    selected,
    diff: moved ? null : state.diff,
    lineSelection: moved ? new Set() : state.lineSelection,
  };
}

export function splitMessage(message: string): { summary: string; description: string } {
  const idx = message.indexOf("\n\n");
  if (idx < 0) return { summary: message.split("\n")[0] ?? "", description: "" };
  return { summary: message.slice(0, idx), description: message.slice(idx + 2) };
}

export function joinMessage(draft: CommitDraft): string {
  const summary = draft.summary.trim();
  const description = draft.description.trim();
  return description ? `${summary}\n\n${description}` : summary;
}

export function canCommit(state: GitViewState): boolean {
  if (state.busy || !state.repo?.author) return false;
  if (!state.commit.summary.trim()) return false;
  const staged = state.status?.staged.length ?? 0;
  return staged > 0 || state.commit.amend;
}

// ---- store plumbing --------------------------------------------------------

function current(workspaceId: string): GitViewState | null {
  return get(gitStore)[workspaceId] ?? null;
}

function update(workspaceId: string, fn: (s: GitViewState) => GitViewState): void {
  gitStore.update((all) => {
    const s = all[workspaceId];
    return s ? { ...all, [workspaceId]: fn(s) } : all;
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ensureGitView(workspaceId: string, cwd: string): void {
  gitStore.update((all) => {
    const existing = all[workspaceId];
    if (existing && existing.cwd === cwd) return all;
    return { ...all, [workspaceId]: initialState(cwd) };
  });
}

async function loadDiff(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const entry = findEntry(s.status, s.selected);
  if (!s.selected || !entry) {
    update(workspaceId, (st) => ({ ...st, diff: null }));
    return;
  }
  const token = s.diffToken + 1;
  update(workspaceId, (st) => ({ ...st, diffToken: token }));
  const sel = s.selected;
  try {
    const diff = await backend.gitDiff(s.cwd, sel.path, entry.oldPath ?? null, sel.area === "staged", entry.status === "?");
    update(workspaceId, (st) => (st.diffToken === token ? { ...st, diff } : st));
  } catch (e) {
    update(workspaceId, (st) => (st.diffToken === token ? { ...st, diff: null, error: `Diff failed: ${errorText(e)}` } : st));
  }
}

export async function refresh(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const token = s.refreshToken + 1;
  update(workspaceId, (st) => ({ ...st, refreshToken: token }));
  try {
    const repo = await backend.gitRepoInfo(s.cwd);
    const status = repo.notARepo ? { unstaged: [], staged: [] } : await backend.gitStatus(s.cwd);
    let stale = false;
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) {
        stale = true;
        return st;
      }
      return { ...applyStatus(st, status), repo, gitMissing: false };
    });
    if (!stale) await loadDiff(workspaceId);
  } catch (e) {
    const text = errorText(e);
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) return st;
      return text === GIT_NOT_FOUND ? { ...st, gitMissing: true } : { ...st, error: `Refresh failed: ${text}` };
    });
  }
}

export async function select(workspaceId: string, sel: Selection | null): Promise<void> {
  update(workspaceId, (st) => ({ ...st, selected: sel, diff: null, lineSelection: new Set() }));
  await loadDiff(workspaceId);
}

export function setLineSelection(workspaceId: string, ids: Set<string>): void {
  update(workspaceId, (st) => ({ ...st, lineSelection: ids }));
}

export function setCommitDraft(workspaceId: string, patch: Partial<CommitDraft>): void {
  update(workspaceId, (st) => {
    let commit = { ...st.commit, ...patch };
    let preAmend = st.preAmend;
    if (patch.amend === true && !st.commit.amend) {
      preAmend = { summary: st.commit.summary, description: st.commit.description };
      const empty = !st.commit.summary.trim() && !st.commit.description.trim();
      if (empty && st.repo?.headMessage) commit = { ...commit, ...splitMessage(st.repo.headMessage) };
    } else if (patch.amend === false && st.commit.amend) {
      commit = { ...commit, summary: preAmend?.summary ?? "", description: preAmend?.description ?? "" };
      preAmend = null;
    }
    return { ...st, commit, preAmend };
  });
}

export function dismissError(workspaceId: string): void {
  update(workspaceId, (st) => ({ ...st, error: null }));
}

/// Every mutation goes through here: refuse while busy, mark busy, run,
/// refresh, record "<label> failed: <stderr>" on error (spec §4).
export async function run(workspaceId: string, label: string, op: (cwd: string) => Promise<void>): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy) return false;
  update(workspaceId, (st) => ({ ...st, busy: label, error: null }));
  let okResult = true;
  try {
    await op(s.cwd);
  } catch (e) {
    okResult = false;
    update(workspaceId, (st) => ({ ...st, error: `${label} failed: ${errorText(e)}` }));
  }
  // A successful mutation invalidates any line selection (spec §3: the diff
  // is refetched and the selection cleared); a failed one keeps it so the
  // user can retry.
  update(workspaceId, (st) => ({ ...st, busy: null, lineSelection: okResult ? new Set() : st.lineSelection }));
  await refresh(workspaceId);
  return okResult;
}

export function stageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  return run(workspaceId, "Stage", (cwd) => backend.gitStageFiles(cwd, paths));
}

export function unstageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  return run(workspaceId, "Unstage", (cwd) => backend.gitUnstageFiles(cwd, paths));
}

export function stageAll(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Stage all", (cwd) => backend.gitStageAll(cwd));
}

export function unstageAll(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Unstage all", (cwd) => backend.gitUnstageAll(cwd));
}

const APPLY_LABEL: Record<ApplyMode, string> = { stage: "Stage hunk", unstage: "Unstage hunk", discard: "Discard hunk" };

export function applyPatch(workspaceId: string, patch: string, mode: ApplyMode): Promise<boolean> {
  return run(workspaceId, APPLY_LABEL[mode], (cwd) => backend.gitApplyPatch(cwd, patch, mode));
}

export function discardFiles(workspaceId: string, tracked: string[], untracked: string[]): Promise<boolean> {
  return run(workspaceId, "Discard", (cwd) => backend.gitDiscardFiles(cwd, tracked, untracked));
}

export async function commit(workspaceId: string): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || !canCommit(s)) return false;
  const message = joinMessage(s.commit);
  const amend = s.commit.amend;
  const done = await run(workspaceId, "Commit", (cwd) => backend.gitCommit(cwd, message, amend));
  if (done) {
    update(workspaceId, (st) => ({ ...st, commit: { summary: "", description: "", amend: false }, preAmend: null }));
  }
  return done;
}

export function initRepo(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Initialize repository", (cwd) => backend.gitInit(cwd));
}

/// Starts the worktree watcher for this workspace's cwd and subscribes to
/// `git-changed`; returns the teardown to call on unmount.
export async function startWatching(workspaceId: string): Promise<() => void> {
  const s = current(workspaceId);
  if (!s) return () => {};
  const cwd = s.cwd;
  await backend.gitWatch(cwd).catch(() => {});
  const unlisten = await listen<{ cwd: string }>("git-changed", (event) => {
    if (event.payload.cwd === cwd) void refresh(workspaceId);
  });
  return () => {
    unlisten();
    void backend.gitUnwatch(cwd).catch(() => {});
  };
}
