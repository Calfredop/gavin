// The Git tab's state: one GitViewState per workspace (spec §4). Pure
// reducers up top (tested directly), store actions below. Refresh is
// watcher/activation/mutation-driven — never a timer (G9).

import { writable, get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import { layoutState, setGitViewPrefs } from "./layoutState";
import type {
  ApplyMode,
  Area,
  CommitDetail,
  CommitInfo,
  FileDiff,
  FileEntry,
  InProgressKind,
  NavSelection,
  RefsSnapshot,
  RepoInfo,
  ResetMode,
  StatusResult,
} from "./git";
import { LOG_PAGE_SIZE } from "./git";

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
  // ---- SP2 ----
  refs: RefsSnapshot | null;
  /// Session override for which remote fetch/push target; null = derived.
  activeRemote: string | null;
  navSelection: NavSelection;
  /// Files of the selected stash (nav selection), read-only.
  stashFiles: FileEntry[] | null;
  /// A running long op (fetch/pull/push) with its latest progress line.
  op: { id: string; label: string; line: string | null } | null;
  // ---- SP4 ----
  log: { commits: CommitInfo[]; hasMore: boolean; all: boolean } | null;
  logLoading: boolean;
  logFilter: string;
  logToken: number;
  selectedCommit: string | null;
  commitDetail: CommitDetail | null;
  detailFile: string | null;
  detailDiff: FileDiff | null;
  detailToken: number;
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
    refs: null,
    activeRemote: null,
    navSelection: "changes",
    stashFiles: null,
    op: null,
    log: null,
    logLoading: false,
    logFilter: "",
    logToken: 0,
    selectedCommit: null,
    commitDetail: null,
    detailFile: null,
    detailDiff: null,
    detailToken: 0,
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
  if (state.busy || state.op || !state.repo?.author) return false;
  if (!state.commit.summary.trim()) return false;
  const staged = state.status?.staged.length ?? 0;
  return staged > 0 || state.commit.amend;
}

export function currentBranch(state: GitViewState) {
  return state.refs?.branches.find((b) => b.current) ?? null;
}

/// Which remote Fetch/Push target: the session override, else the current
/// branch's upstream remote, else `origin`, else the first remote.
export function effectiveRemote(state: GitViewState): string | null {
  const remotes = state.refs?.remotes ?? [];
  if (state.activeRemote && remotes.some((r) => r.name === state.activeRemote)) return state.activeRemote;
  const fromUpstream = currentBranch(state)?.upstream?.split("/")[0];
  if (fromUpstream && remotes.some((r) => r.name === fromUpstream)) return fromUpstream;
  if (remotes.some((r) => r.name === "origin")) return "origin";
  return remotes[0]?.name ?? null;
}

export function pushLabel(state: GitViewState): string {
  return currentBranch(state)?.upstream ? "Push" : "Publish";
}

export function canSync(state: GitViewState): { fetch: boolean; pull: boolean; push: boolean; reason: string | null } {
  if (!state.refs || state.refs.remotes.length === 0) {
    return { fetch: false, pull: false, push: false, reason: "No remotes — add one in the sidebar" };
  }
  if (state.repo?.detached) return { fetch: true, pull: false, push: false, reason: "detached HEAD" };
  if (state.repo?.unborn) return { fetch: true, pull: false, push: false, reason: "no commits yet" };
  return { fetch: true, pull: true, push: true, reason: null };
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
    const refs = repo.notARepo ? null : await backend.gitRefs(s.cwd);
    let stale = false;
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) {
        stale = true;
        return st;
      }
      return { ...applyStatus(st, status), repo, refs, gitMissing: false };
    });
    if (!stale) {
      await loadDiff(workspaceId);
      if (current(workspaceId)?.navSelection === "commits") await loadLog(workspaceId, true);
    }
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

/// Surface a message in the error banner without a failed command behind
/// it (e.g. "worktree gone — back to the root checkout").
export function noteError(workspaceId: string, message: string): void {
  update(workspaceId, (st) => ({ ...st, error: message }));
}

/// Every mutation goes through here: refuse while busy, mark busy, run,
/// refresh, record "<label> failed: <stderr>" on error (spec §4).
export async function run(workspaceId: string, label: string, op: (cwd: string) => Promise<void>): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy || s.op) return false;
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

// ---- SP2: long ops, refs actions, nav selection ----------------------------

export function setActiveRemote(workspaceId: string, remote: string | null): void {
  update(workspaceId, (st) => ({ ...st, activeRemote: remote }));
}

/// Fetch/pull/push: one at a time, never concurrent with a `run()`
/// mutation; progress lines for this op's id land in `op.line` (G13).
export async function startOp(
  workspaceId: string,
  label: string,
  invoke: (cwd: string, opId: string) => Promise<void>
): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy || s.op) return false;
  const id = crypto.randomUUID();
  update(workspaceId, (st) => ({ ...st, op: { id, label, line: null }, error: null }));
  const unlisten = await listen<{ opId: string; line: string }>("git-op-progress", (event) => {
    if (event.payload.opId !== id) return;
    update(workspaceId, (st) => (st.op?.id === id ? { ...st, op: { ...st.op, line: event.payload.line } } : st));
  });
  let okResult = true;
  try {
    await invoke(s.cwd, id);
  } catch (e) {
    okResult = false;
    const text = errorText(e);
    update(workspaceId, (st) => ({ ...st, error: text === "cancelled" ? `${label} cancelled` : `${label} failed: ${text}` }));
  }
  unlisten();
  update(workspaceId, (st) => ({ ...st, op: null }));
  await refresh(workspaceId);
  return okResult;
}

export async function cancelOp(workspaceId: string): Promise<void> {
  const id = current(workspaceId)?.op?.id;
  if (id) await backend.gitCancelOp(id).catch(() => false);
}

function remoteOrOrigin(workspaceId: string): string {
  const s = current(workspaceId);
  return (s && effectiveRemote(s)) ?? "origin";
}

export function fetch(workspaceId: string): Promise<boolean> {
  const remote = remoteOrOrigin(workspaceId);
  return startOp(workspaceId, "Fetch", (cwd, id) => backend.gitFetch(cwd, remote, id));
}

export function pull(workspaceId: string): Promise<boolean> {
  return startOp(workspaceId, "Pull", (cwd, id) => backend.gitPull(cwd, id));
}

export function push(workspaceId: string): Promise<boolean> {
  const remote = remoteOrOrigin(workspaceId);
  const s = current(workspaceId);
  const label = s ? pushLabel(s) : "Push";
  return startOp(workspaceId, label, (cwd, id) => backend.gitPush(cwd, remote, id));
}

export function checkout(workspaceId: string, name: string, trackRemote: string | null): Promise<boolean> {
  return run(workspaceId, `Checkout ${name}`, (cwd) => backend.gitCheckout(cwd, name, trackRemote));
}

export function createBranch(workspaceId: string, name: string, from: string | null, checkoutAfter: boolean): Promise<boolean> {
  return run(workspaceId, "New branch", (cwd) => backend.gitCreateBranch(cwd, name, from, checkoutAfter));
}

export function deleteBranch(workspaceId: string, name: string, force: boolean): Promise<boolean> {
  return run(workspaceId, "Delete branch", (cwd) => backend.gitDeleteBranch(cwd, name, force));
}

export function mergeBranch(workspaceId: string, branch: string): Promise<boolean> {
  return run(workspaceId, `Merge ${branch}`, (cwd) => backend.gitMerge(cwd, branch));
}

export function abortInProgress(workspaceId: string, kind: InProgressKind): Promise<boolean> {
  return run(workspaceId, `Abort ${kind}`, (cwd) => backend.gitAbortInProgress(cwd, kind));
}

export function continueRebase(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Continue rebase", (cwd) => backend.gitContinueRebase(cwd));
}

export function addRemote(workspaceId: string, name: string, url: string): Promise<boolean> {
  return run(workspaceId, "Add remote", (cwd) => backend.gitAddRemote(cwd, name, url));
}

export function removeRemote(workspaceId: string, name: string): Promise<boolean> {
  return run(workspaceId, "Remove remote", (cwd) => backend.gitRemoveRemote(cwd, name));
}

export function stashPush(workspaceId: string, message: string, includeUntracked: boolean): Promise<boolean> {
  return run(workspaceId, "Stash", (cwd) => backend.gitStashPush(cwd, message, includeUntracked));
}

export async function stashPop(workspaceId: string, index: number): Promise<boolean> {
  const done = await run(workspaceId, "Pop stash", (cwd) => backend.gitStashPop(cwd, index));
  if (done) selectChanges(workspaceId);
  return done;
}

export function stashApply(workspaceId: string, index: number): Promise<boolean> {
  return run(workspaceId, "Apply stash", (cwd) => backend.gitStashApply(cwd, index));
}

export async function stashDrop(workspaceId: string, index: number): Promise<boolean> {
  const done = await run(workspaceId, "Drop stash", (cwd) => backend.gitStashDrop(cwd, index));
  if (done) selectChanges(workspaceId);
  return done;
}

/// Sidebar selection: a stash swaps the middle column for its read-only
/// file list; Local Changes restores the normal view.
export async function selectStash(workspaceId: string, index: number): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  update(workspaceId, (st) => ({ ...st, navSelection: { stash: index }, stashFiles: null }));
  try {
    const files = await backend.gitStashFiles(s.cwd, index);
    update(workspaceId, (st) => {
      const sel = st.navSelection;
      return typeof sel === "object" && sel.stash === index ? { ...st, stashFiles: files } : st;
    });
  } catch (e) {
    update(workspaceId, (st) => ({ ...st, error: `Stash contents failed: ${errorText(e)}` }));
  }
}

export function selectChanges(workspaceId: string): void {
  update(workspaceId, (st) => ({ ...st, navSelection: "changes", stashFiles: null }));
}

// ---- SP4: history ----------------------------------------------------------

function graphAllPref(workspaceId: string): boolean {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.gitView?.graphAll ?? true;
}

/// Sidebar → All Commits: swaps the middle/diff columns for the graph and
/// the commit detail, loading the first page.
export async function selectCommits(workspaceId: string): Promise<void> {
  update(workspaceId, (st) => ({ ...st, navSelection: "commits", stashFiles: null }));
  await loadLog(workspaceId, true);
}

/// Page 0 (`reset`) or the next page, appended. A reload keeps the
/// selected commit when it is still present (spec SP4 §3.1).
export async function loadLog(workspaceId: string, reset: boolean): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const all = s.log?.all ?? graphAllPref(workspaceId);
  const skip = reset ? 0 : (s.log?.commits.length ?? 0);
  const token = s.logToken + 1;
  update(workspaceId, (st) => ({ ...st, logToken: token, logLoading: true }));
  try {
    const page = await backend.gitLog(s.cwd, all, skip, LOG_PAGE_SIZE);
    update(workspaceId, (st) => {
      if (st.logToken !== token) return st;
      const commits = reset ? page.commits : [...(st.log?.commits ?? []), ...page.commits];
      const stillThere = st.selectedCommit !== null && commits.some((c) => c.sha === st.selectedCommit);
      return {
        ...st,
        log: { commits, hasMore: page.hasMore, all },
        logLoading: false,
        selectedCommit: stillThere ? st.selectedCommit : null,
        commitDetail: stillThere ? st.commitDetail : null,
        detailFile: stillThere ? st.detailFile : null,
        detailDiff: stillThere ? st.detailDiff : null,
      };
    });
  } catch (e) {
    update(workspaceId, (st) => (st.logToken === token ? { ...st, logLoading: false, error: `History failed: ${errorText(e)}` } : st));
  }
}

export function loadMore(workspaceId: string): Promise<void> {
  return loadLog(workspaceId, false);
}

export async function setGraphAll(workspaceId: string, all: boolean): Promise<void> {
  update(workspaceId, (st) => ({ ...st, log: st.log ? { ...st.log, all } : { commits: [], hasMore: false, all } }));
  await setGitViewPrefs(workspaceId, { graphAll: all });
  await loadLog(workspaceId, true);
}

export function setLogFilter(workspaceId: string, text: string): void {
  update(workspaceId, (st) => ({ ...st, logFilter: text }));
}

async function loadDetailDiff(workspaceId: string, sha: string, file: FileEntry, token: number): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  try {
    const diff = await backend.gitDiff(s.cwd, file.path, file.oldPath ?? null, false, false, sha);
    update(workspaceId, (st) => (st.detailToken === token ? { ...st, detailDiff: diff } : st));
  } catch (e) {
    update(workspaceId, (st) => (st.detailToken === token ? { ...st, error: `Diff failed: ${errorText(e)}` } : st));
  }
}

export async function selectCommit(workspaceId: string, sha: string): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const token = s.detailToken + 1;
  update(workspaceId, (st) => ({ ...st, selectedCommit: sha, commitDetail: null, detailFile: null, detailDiff: null, detailToken: token }));
  try {
    const detail = await backend.gitCommitDetail(s.cwd, sha);
    const first = detail.files[0] ?? null;
    update(workspaceId, (st) => (st.detailToken === token ? { ...st, commitDetail: detail, detailFile: first?.path ?? null } : st));
    if (first) await loadDetailDiff(workspaceId, sha, first, token);
  } catch (e) {
    update(workspaceId, (st) => (st.detailToken === token ? { ...st, error: `Commit failed to load: ${errorText(e)}` } : st));
  }
}

export async function selectDetailFile(workspaceId: string, path: string): Promise<void> {
  const s = current(workspaceId);
  const file = s?.commitDetail?.files.find((f) => f.path === path);
  if (!s || !s.selectedCommit || !file) return;
  const token = s.detailToken + 1;
  update(workspaceId, (st) => ({ ...st, detailFile: path, detailDiff: null, detailToken: token }));
  await loadDetailDiff(workspaceId, s.selectedCommit, file, token);
}

export function checkoutCommit(workspaceId: string, sha: string): Promise<boolean> {
  return run(workspaceId, "Checkout commit", (cwd) => backend.gitCheckoutCommit(cwd, sha));
}

export function cherryPick(workspaceId: string, sha: string): Promise<boolean> {
  return run(workspaceId, "Cherry-pick", (cwd) => backend.gitCherryPick(cwd, sha));
}

export function revertCommit(workspaceId: string, sha: string): Promise<boolean> {
  return run(workspaceId, "Revert", (cwd) => backend.gitRevert(cwd, sha));
}

export function resetTo(workspaceId: string, sha: string, mode: ResetMode): Promise<boolean> {
  return run(workspaceId, `Reset (${mode})`, (cwd) => backend.gitReset(cwd, sha, mode));
}

export function continueInProgress(workspaceId: string, kind: InProgressKind): Promise<boolean> {
  return run(workspaceId, `Continue ${kind}`, (cwd) => backend.gitContinueInProgress(cwd, kind));
}

// ---- SP3: worktrees --------------------------------------------------------

/// The main worktree's path from the refs snapshot; falls back to the
/// view's own cwd until refs have loaded.
export function rootPathOf(state: GitViewState): string {
  return state.refs?.worktrees.find((w) => w.isMain)?.path ?? state.cwd;
}

/// Point the whole tab at another worktree (G6): fresh state for the new
/// cwd, persisted so the tab reopens there. `GitHubView`'s watcher effect
/// keys on the view's cwd and restarts by itself.
export async function switchWorktree(workspaceId: string, path: string): Promise<void> {
  ensureGitView(workspaceId, path);
  await setGitViewPrefs(workspaceId, { worktree: path });
  await refresh(workspaceId);
}

export function forkWorktree(
  workspaceId: string,
  opts: { path: string; branch: string; from: string | null; newBranch: boolean }
): Promise<boolean> {
  return run(workspaceId, "New worktree", (cwd) => backend.gitWorktreeAdd(cwd, opts.path, opts.branch, opts.from, opts.newBranch));
}

export function removeWorktree(workspaceId: string, path: string, force: boolean, deleteBranchName: string | null): Promise<boolean> {
  return run(workspaceId, "Remove worktree", async (cwd) => {
    await backend.gitWorktreeRemove(cwd, path, force);
    if (deleteBranchName) await backend.gitDeleteBranch(cwd, deleteBranchName, false);
  });
}

export function pruneWorktrees(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Prune worktrees", (cwd) => backend.gitWorktreePrune(cwd));
}

/// Merge a fork's branch into the ROOT checkout (G12). "conflict" means the
/// root now has MERGE_HEAD and the banner's Abort is the way out.
export async function mergeBack(workspaceId: string, rootPath: string, branch: string): Promise<"merged" | "conflict" | "failed"> {
  const done = await run(workspaceId, `Merge ${branch}`, () => backend.gitMerge(rootPath, branch));
  if (done) return "merged";
  const info = await backend.gitRepoInfo(rootPath).catch(() => null);
  return info?.inProgress === "merge" ? "conflict" : "failed";
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
