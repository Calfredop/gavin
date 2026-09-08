// The Git tab's state: one GitViewState per workspace (spec §4). Pure
// reducers up top (tested directly), store actions below. Refresh is
// watcher/activation/mutation-driven — never a timer (G9).

import { writable, get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import {
  layoutState,
  daemonCompat,
  setGitViewPrefs,
  createSessionForCard,
  resolvedAgentFor,
  sessionExits,
  handleAgentSessionSpawned,
  switchWorkspaceView,
  switchToSessionInPage,
} from "./layoutState";
import { findSessionLocation, hubViewIsOnScreen } from "./workspace";
import type { AgentCommitRecord, Workspace } from "./workspace";
import { folderName } from "./paths";
import { maybeNotifyAgentCommit, type AgentCommitVerdict } from "./notifications";
import { buildHeadlessCommand, COMMIT_PROMPT } from "./cardRun";
import {
  MAX_AUTO_RESUME_ATTEMPTS,
  autoResumePolicy,
  classifyFailure,
  resumeDelayMs,
} from "./autoResume";
import { featureBlockedReason } from "./daemonCompat";
import { holdOrQueue, type CommitIntent } from "./launchQueue";
import type {
  ApplyMode,
  Area,
  CommitDetail,
  CommitInfo,
  ConflictInfo,
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
import { isGavinOwnPath } from "./gitTracking";
import { mayForceRemoval } from "./worktreeSweep";

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
  // ---- conflicts ----
  /// Loaded instead of `diff` when the selected row is a `U` entry.
  conflict: ConflictInfo | null;
  conflictToken: number;
  /// `merge.tool` from git config, null when unset.
  mergeTool: string | null;
  // ---- commit via agent ----
  /// The hidden agent session asked to commit, from the click until it
  /// exits. `sessionId` is null for the gap between the click and the
  /// daemon handing one back -- the only window with nothing to reveal.
  agentCommit: { sessionId: string | null } | null;
  /// Set for AGENT_COMMIT_FLASH_MS after a run that actually emptied the
  /// tree, so the button can say it worked. Nothing else flashes: a
  /// failure, or a run that left changes behind, goes to `error`, which
  /// stays until dismissed.
  agentCommitDone: boolean;
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
    conflict: null,
    conflictToken: 0,
    mergeTool: null,
    agentCommit: null,
    agentCommitDone: false,
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

/// The button always names how many staged files it is about to fold in.
/// Amend used to print bare "Amend", hiding the count in the one mode that
/// also rewrites HEAD's tree -- so in a shared checkout anything another
/// session had staged rode along unannounced.
export function commitButtonLabel(state: GitViewState): string {
  const staged = state.status?.staged.length ?? 0;
  return `${state.commit.amend ? "Amend" : "Commit"} (${staged})`;
}

/// True when amending would rewrite a commit that is already on the remote:
/// an upstream exists and nothing local sits ahead of it. Legal, but it
/// guarantees a diverged branch and a refused push, so the box says so.
export function amendRewritesPushed(state: GitViewState): boolean {
  if (!state.commit.amend) return false;
  const branch = currentBranch(state);
  return !!branch?.upstream && branch.ahead === 0;
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
    update(workspaceId, (st) => ({ ...st, diff: null, conflict: null }));
    return;
  }
  if (entry.status === "U") {
    update(workspaceId, (st) => ({ ...st, diff: null }));
    await loadConflict(workspaceId);
    return;
  }
  update(workspaceId, (st) => (st.conflict ? { ...st, conflict: null } : st));
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
    const mergeTool = repo.notARepo ? null : await backend.gitMergeToolName(s.cwd).catch(() => null);
    let stale = false;
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) {
        stale = true;
        return st;
      }
      return { ...applyStatus(st, status), repo, refs, mergeTool, gitMissing: false };
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

/// Said when the workspace has no git view at all. Such a refusal has
/// nowhere to file itself -- `update()` writes only to a view the store
/// already has -- so this sentence exists to be RETURNED. It was the one
/// failure path that used to say nothing anywhere.
const NO_GIT_VIEW = "Gavin has no git view for this workspace yet";

/// Why a mutation cannot be started, or null when it can. A refusal is
/// not a failure: git was never asked, so there is no stderr to quote.
/// Split out for the same reason `agentCommitBlocker` is -- a surface
/// with no error banner on screen has to be able to SAY why.
export function runBlocker(state: GitViewState | null): string | null {
  if (!state) return NO_GIT_VIEW;
  const holder = state.op?.label ?? state.busy;
  if (holder) return `Another git operation is still running (${holder})`;
  return null;
}

/// What a mutation did. The union is the invariant: a result carries a
/// sentence exactly when it did not succeed, so a caller can neither
/// report a success nor swallow a refusal by accident.
export type RunResult = { ok: true; error: null } | { ok: false; error: string };

/// Every mutation goes through here: refuse while busy, mark busy, run,
/// refresh, record "<label> failed: <stderr>" on error (spec §4).
export async function run(workspaceId: string, label: string, op: (cwd: string) => Promise<void>): Promise<boolean> {
  return (await runWithReason(workspaceId, label, op)).ok;
}

/// The same, for a caller that has to say what went wrong itself. A
/// dialog opened from the orchestration hub or from a card is not
/// looking at the Git tab's error banner, so a bare `false` told it --
/// and its human -- nothing at all: the button simply did nothing.
export async function runWithReason(
  workspaceId: string,
  label: string,
  op: (cwd: string) => Promise<void>
): Promise<RunResult> {
  const s = current(workspaceId);
  const blocked = runBlocker(s);
  // `!s` is folded in for the type checker alone: runBlocker answers a
  // null state with a reason, so `blocked` is set whenever `s` is not.
  if (blocked || !s) {
    const reason = blocked ?? NO_GIT_VIEW;
    // Filed as well as returned, so the banner keeps carrying every
    // refusal for the surfaces that do watch it. A no-op when there is
    // no view -- the case the return value is here for.
    noteError(workspaceId, reason);
    return { ok: false, error: reason };
  }
  update(workspaceId, (st) => ({ ...st, busy: label, error: null }));
  let failure: string | null = null;
  try {
    await op(s.cwd);
  } catch (e) {
    failure = `${label} failed: ${errorText(e)}`;
    update(workspaceId, (st) => ({ ...st, error: failure }));
  }
  // A successful mutation invalidates any line selection (spec §3: the diff
  // is refetched and the selection cleared); a failed one keeps it so the
  // user can retry.
  update(workspaceId, (st) => ({ ...st, busy: null, lineSelection: failure ? st.lineSelection : new Set() }));
  await refresh(workspaceId);
  return failure === null ? { ok: true, error: null } : { ok: false, error: failure };
}

function conflictedPaths(workspaceId: string): Set<string> {
  return new Set((current(workspaceId)?.status?.unstaged ?? []).filter((e) => e.status === "U").map((e) => e.path));
}

/// `U` paths never go through a raw `git add`: they are routed to the
/// marker-checked mark-resolved command (spec conflicts §2.2).
export function stageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  const u = conflictedPaths(workspaceId);
  const conflicted = paths.filter((p) => u.has(p));
  const plain = paths.filter((p) => !u.has(p));
  return run(workspaceId, conflicted.length ? "Mark resolved" : "Stage", async (cwd) => {
    if (plain.length) await backend.gitStageFiles(cwd, plain);
    for (const p of conflicted) await backend.gitMarkResolved(cwd, p);
  });
}

export function unstageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  return run(workspaceId, "Unstage", (cwd) => backend.gitUnstageFiles(cwd, paths));
}

export function stageAll(workspaceId: string): Promise<boolean> {
  const u = conflictedPaths(workspaceId);
  if (u.size > 0) {
    noteError(workspaceId, `Resolve the ${u.size} conflicted file${u.size === 1 ? "" : "s"} first — Stage all would mark them resolved as-is`);
    return Promise.resolve(false);
  }
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

// ---- commit via agent ------------------------------------------------------

/// How long the button says it worked before returning to idle.
export const AGENT_COMMIT_FLASH_MS = 4000;

export type AgentCommitPhase = "idle" | "starting" | "running" | "done";

export function agentCommitPhase(view: GitViewState | null): AgentCommitPhase {
  if (!view) return "idle";
  if (view.agentCommit) return view.agentCommit.sessionId ? "running" : "starting";
  return view.agentCommitDone ? "done" : "idle";
}

/// Why the action is unavailable, or null when it can run. Separate from
/// the phase so the button can SAY why it is disabled rather than just
/// looking broken.
export function agentCommitBlocker(view: GitViewState | null, headlessArgs: string): string | null {
  if (!view) return "No repository";
  if (!headlessArgs.trim()) return "This workspace's agent has no verified headless mode";
  if (view.busy || view.op) return "Another git operation is running";
  const dirty = (view.status?.unstaged.length ?? 0) + (view.status?.staged.length ?? 0);
  if (dirty === 0) return "Nothing to commit";
  return null;
}

/// How much of a hidden run's output is kept for the error message.
/// Long enough for the agent's closing paragraph, short enough to read
/// in a banner.
const AGENT_TAIL_CHARS = 400;

/// The tail of a hidden session's output. It is the ONLY trace such a
/// run leaves -- the session is gone by the time anything went wrong,
/// and nobody was watching it -- so a failure quotes it rather than
/// reporting a bare exit code. Best-effort: output already emitted
/// between the daemon starting the pty and this listener attaching is
/// not captured, which costs nothing on a run that ends in a paragraph.
async function captureTail(sessionId: string): Promise<{ text: () => string; stop: () => void }> {
  let buf = "";
  const unlisten = await listen<[string, string]>("pty-output", (event) => {
    if (event.payload[0] !== sessionId) return;
    buf = (buf + event.payload[1]).slice(-AGENT_TAIL_CHARS);
  });
  return { text: () => buf.replace(/\s+/g, " ").trim(), stop: unlisten };
}

/// Resolves with the session's exit code. `sessionExits` is written by
/// layoutState's global session-exited listener, and a store
/// subscription fires immediately with the current value -- so a run
/// that exits between createSession returning and this call is still
/// witnessed rather than waited on forever.
function awaitExit(sessionId: string): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let unsub: () => void = () => {};
    unsub = sessionExits.subscribe((exits) => {
      const code = exits.get(sessionId);
      if (settled || code === undefined) return;
      settled = true;
      resolve(code);
      // Deferred: when this callback runs synchronously from inside
      // subscribe() itself, `unsub` is still the no-op above.
      void Promise.resolve().then(() => unsub());
    });
  });
}

/// The Git tab's "Commit via agent": one canned prompt (COMMIT_PROMPT),
/// run by a HIDDEN agent session -- no tab, no page, the button is the
/// whole interface. This app stages and commits nothing itself; the
/// agent decides the chunks.
///
/// The run has to be a headless one: an interactive agent sits at its
/// prompt forever, and an invisible session that never returns is a
/// spinner with no end. Its verdict is the exit code AND the working
/// tree afterwards -- see below for why the code alone is not enough.
export async function commitViaAgent(
  workspaceId: string,
  /// How many automatic retries this run already carries. Non-zero only
  /// on the one gavin starts itself after a transient failure (see
  /// retryCommitRun); a human's press always begins at zero, because it
  /// is a new run and a new budget.
  retries = 0,
  /// The drain calling back in with an intent that has already cleared
  /// the launch wall. Asking again there would re-queue it for ever.
  options: { queued?: boolean } = {}
): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy || s.op || s.agentCommit) return false;
  // The launch wall. Hidden or not, this is an agent process tree, and
  // what it competes with for memory is a build somebody else's agent
  // started. Before the `agentCommit` marker is written, so a queued
  // commit leaves the Git tab exactly as it found it rather than
  // spinning on a run that has not started.
  if (!options.queued && holdOrQueue({ kind: "commit", workspaceId, label: "commit", retries })) {
    return false;
  }
  const agent = resolvedAgentFor(workspaceId);
  const command = buildHeadlessCommand(agent.launchCommand, agent.headlessArgs, COMMIT_PROMPT);
  if (!command) {
    noteError(workspaceId, `Commit via agent needs a headless agent — ${agent.profileId} has none`);
    return false;
  }
  update(workspaceId, (st) => ({ ...st, agentCommit: { sessionId: null }, agentCommitDone: false, error: null }));
  let sessionId: string;
  try {
    sessionId = await backend.createSession(s.cwd, command);
  } catch (e) {
    update(workspaceId, (st) => ({ ...st, agentCommit: null, error: `Commit via agent failed: ${errorText(e)}` }));
    return false;
  }
  const tail = await captureTail(sessionId);
  // Cosmetic and best-effort: it only matters once the human reveals the
  // session, where a tab labelled by its cwd is indistinguishable from
  // every other agent running in the same repo.
  await backend.setSessionName(sessionId, "commit").catch(() => {});
  update(workspaceId, (st) => (st.agentCommit?.sessionId === null ? { ...st, agentCommit: { sessionId } } : st));
  // Written down BEFORE the wait, because the window may not survive it.
  await rememberAgentCommit(workspaceId, { sessionId, cwd: s.cwd, retries });

  return watchAgentCommit(workspaceId, sessionId, tail);
}

/// The half of a run that happens after it is launched: wait, then judge.
/// Split out because `adoptAgentCommits` re-enters here for a run this
/// window did not start -- one verdict, reached the same way, whether the
/// click that began it happened five seconds or two restarts ago.
async function watchAgentCommit(
  workspaceId: string,
  sessionId: string,
  tail: { text: () => string; stop: () => void }
): Promise<boolean> {
  // Read BEFORE the record is forgotten below, and before the wait for
  // the same reason `adoptAgentCommits` exists: this window may not be
  // the one that started the run, so the budget it already spent is only
  // knowable from the record.
  const spent =
    get(layoutState).workspaces.find((w) => w.id === workspaceId)?.gitView?.agentCommit
      ?.sessionId === sessionId
      ? (get(layoutState).workspaces.find((w) => w.id === workspaceId)?.gitView?.agentCommit
          ?.retries ?? 0)
      : 0;
  const code = await awaitExit(sessionId);
  tail.stop();
  // A worktree switch replaces this view wholesale (ensureGitView), and
  // the run it started is then no longer this view's business -- it must
  // not write its verdict into the state that replaced it.
  if (current(workspaceId)?.agentCommit?.sessionId !== sessionId) {
    // Forgotten too, not just unwatched: the run carries on committing in
    // a checkout this tab has left, and a record pointing there would
    // only make the next window adopt a run it cannot show.
    await forgetAgentCommit(workspaceId, sessionId);
    return false;
  }
  update(workspaceId, (st) => ({ ...st, agentCommit: null }));
  await forgetAgentCommit(workspaceId, sessionId);
  await refresh(workspaceId);

  // Exit 0 is NOT the verdict on its own: a headless agent that decides
  // it cannot do the job still reports that in prose and exits cleanly.
  // The working tree is the fact, so it is what gets checked -- saying
  // "Committed" over a tree that is still dirty would be a lie the
  // human only catches by looking.
  const after = current(workspaceId);
  const left = (after?.status?.unstaged.length ?? 0) + (after?.status?.staged.length ?? 0);
  const said = tail.text();
  const quoted = said ? ` — ${said}` : "";
  if (code !== 0) {
    noteError(workspaceId, `Commit via agent failed (exit ${code})${quoted}`);
    void announceVerdict(workspaceId, { kind: "failed", exitCode: code });
    // A RETRY, not a resume. A headless run exits on exactly the failures
    // an interactive one survives (measured: `-p` returns 1 and prints
    // the same `API Error:` line), so there is no live session and no
    // conversation to reopen -- and none is wanted: the prompt is "commit
    // pending changes", which `adoptAgentCommits` already tolerates
    // repeating because repeating it is harmless.
    void maybeRetryCommitRun(workspaceId, spent, said);
    return false;
  }
  if (left > 0) {
    noteError(workspaceId, `Commit via agent left ${left} change${left === 1 ? "" : "s"} uncommitted${quoted}`);
    void announceVerdict(workspaceId, { kind: "left-dirty", changes: left });
    return false;
  }
  update(workspaceId, (st) => ({ ...st, agentCommitDone: true }));
  void announceVerdict(workspaceId, { kind: "committed" });
  setTimeout(() => {
    update(workspaceId, (st) => (st.agentCommitDone ? { ...st, agentCommitDone: false } : st));
  }, AGENT_COMMIT_FLASH_MS);
  return true;
}

/// Re-run a commit prompt that failed for a reason worth another try.
///
/// The whole trigger table applies -- an expired token, a usage limit or
/// a crash are as pointless to retry here as anywhere else -- but the
/// evidence is different: a headless run has no session status and no
/// screen, only its captured output, so the agent's own error line is
/// read out of the tail instead. Everything the tail cannot classify is
/// `unknown`, which never retries, and that covers the ordinary case
/// this must not touch: an agent that simply decided it could not commit.
///
/// One retry, on the persisted count -- the same budget as everywhere
/// else -- and only where the human opted in for this workspace.
///
/// No reachability wait and no stagger: a commit run is a single
/// short-lived process the human started deliberately, not a wave of
/// rails coming back at once, and the delay before trying is the whole
/// of the policy's backoff.
async function maybeRetryCommitRun(
  workspaceId: string,
  spent: number,
  said: string
): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (ws?.autoResumeRuns !== true) return;
  if (featureBlockedReason(get(daemonCompat), "autoResume")) return;
  if (spent >= MAX_AUTO_RESUME_ATTEMPTS) return;
  const agent = resolvedAgentFor(workspaceId);
  const policy = autoResumePolicy(classifyFailure(said, agent.failureCauses));
  if (policy.kind !== "resume") return;
  const delay = resumeDelayMs(policy.on);
  setTimeout(() => {
    // Re-checked at the last moment: the human may have started their
    // own run in the meantime, and `commitViaAgent` refuses anyway --
    // but refusing quietly here keeps the notification honest.
    if (current(workspaceId)?.agentCommit) return;
    void commitViaAgent(workspaceId, spent + 1).then((ok) => {
      if (!ok) return;
      void import("./autoResumeNotify").then(({ sendAutoResumeNotice }) =>
        sendAutoResumeNotice(`Commit via agent broke and was retried automatically — ${said}`)
      );
    });
  }, delay);
}

/// Sends the verdict out of the Git tab. Everything else this run
/// produces stays inside `GitViewState` -- a banner that only shows on
/// one tab, and a "Committed" flash that is gone in four seconds -- so a
/// human who started the run and moved on is told nowhere. The
/// notification is the only channel a hidden run has.
///
/// Neither awaited nor allowed to reject: the verdict is already
/// recorded in the view state by the time this runs, so a notification
/// that fails (no permission, no OS support, a plugin that is not there)
/// must not turn a successful commit run into a rejected promise -- and
/// a bare `void` on a rejecting one is an unhandled rejection, not a
/// swallowed error.
///
/// The workspace name is the label rather than the checkout's folder,
/// because a worktree switch abandons the run outright (see the verdict
/// guard above) -- the workspace is what the run is still attached to.
async function announceVerdict(workspaceId: string, verdict: AgentCommitVerdict): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const label = ws?.name || folderName(current(workspaceId)?.cwd ?? workspaceId);
  await maybeNotifyAgentCommit(
    label,
    verdict,
    { needsInput: ws?.notifyNeedsInput ?? true, finished: ws?.notifyFinished ?? true },
    hubViewIsOnScreen(state, workspaceId, "git")
  ).catch(() => {});
}

/// Writes the in-flight run into the workspace's persisted Git prefs, or
/// clears it. The whole recovery story rests on this one line of config:
/// a hidden session is referenced by no page, so nothing else in the app
/// would remember it across a restart.
async function rememberAgentCommit(workspaceId: string, record: AgentCommitRecord): Promise<void> {
  await setGitViewPrefs(workspaceId, { agentCommit: record });
}

/// Drops the record, but only while it still names `sessionId`. An
/// abandoned run resolves long after the worktree switch that abandoned
/// it, by which point the human may well have started a second run in
/// the new checkout -- and an unconditional clear there would erase the
/// record of the run that is still going.
async function forgetAgentCommit(workspaceId: string, sessionId: string): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (ws?.gitView?.agentCommit?.sessionId !== sessionId) return;
  await setGitViewPrefs(workspaceId, { agentCommit: undefined });
}

/// Re-attaches to commit runs that outlived the window that started them.
/// Called once after bootstrap -- NOT on Git-tab mount -- because the
/// sidebar's git chip has to show a run for a workspace whose Git tab
/// nobody has opened yet, and it reads this store.
///
/// A run whose session is gone -- or whose session was INTERRUPTED, and
/// so is a bare shell wearing the run's old id -- is dropped without a
/// verdict: its exit code and its output died with the last window, so
/// "Committed" would be a guess and "failed" would be a lie. The refresh
/// that follows shows whatever commits it did make.
export async function adoptAgentCommits(): Promise<void> {
  await Promise.all(get(layoutState).workspaces.map((ws) => adoptAgentCommit(ws)));
}

async function adoptAgentCommit(ws: Workspace): Promise<void> {
  const record = ws.gitView?.agentCommit;
  if (!record) return;
  // Only into the checkout it was launched against. A worktree switch
  // abandons a run (see the verdict guard above), so a record naming
  // anywhere but the tab's own cwd is one that switch left behind.
  const target = ws.gitView?.worktree ?? ws.rootPath ?? null;
  if (target !== record.cwd) {
    await forgetAgentCommit(ws.id, record.sessionId);
    return;
  }
  // An INTERRUPTED session is dropped exactly like one that is gone: the
  // daemon killed the run and put a bare shell in its place, and a shell
  // never exits, so `watchAgentCommit` would sit on `awaitExit` for the
  // life of the window. No verdict either -- the run's exit code and its
  // output died with the daemon, so "Committed" would be a guess and
  // "failed" a lie. The refresh below shows whatever commits it did make.
  //
  // This replaces, rather than contradicts, the old tolerance for a
  // restart: adopting "a second `claude -p 'Commit ...'`" was fine
  // because repeating THAT prompt is harmless, but recovery no longer
  // respawns anything, so there is no second run to adopt.
  if (get(layoutState).interruptedSessionIds.has(record.sessionId)) {
    await forgetAgentCommit(ws.id, record.sessionId);
    return;
  }
  let alive = false;
  try {
    alive = await backend.adoptSession(record.sessionId);
  } catch {
    alive = false;
  }
  if (!alive) {
    await forgetAgentCommit(ws.id, record.sessionId);
    return;
  }
  ensureGitView(ws.id, record.cwd);
  update(ws.id, (st) => ({ ...st, agentCommit: { sessionId: record.sessionId }, agentCommitDone: false }));
  const tail = await captureTail(record.sessionId);
  // Not awaited: the sweep must not hold bootstrap open for a run that
  // may have hours left in it.
  void watchAgentCommit(ws.id, record.sessionId, tail);
}

/// Pulls the hidden session onto the Agents page and jumps to it. The
/// run carries on either way -- this is for a human who wants to watch
/// it, or to see why it is taking so long. Only new output appears: the
/// session has been attached since it was created, so there is no
/// scrollback replay to catch up on.
export async function revealAgentCommit(workspaceId: string): Promise<void> {
  const sessionId = current(workspaceId)?.agentCommit?.sessionId;
  if (!sessionId) return;
  handleAgentSessionSpawned(workspaceId, sessionId);
  const location = findSessionLocation(get(layoutState), sessionId);
  if (!location) return;
  await switchWorkspaceView(location.workspaceId, "terminal");
  await switchToSessionInPage(location.workspaceId, location.pageId, sessionId);
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

/// Reports its reason for the same read: the rail bind dialog offers
/// "New branch…" from the orchestration hub, where nothing else would
/// carry git's refusal.
export function createBranch(workspaceId: string, name: string, from: string | null, checkoutAfter: boolean): Promise<RunResult> {
  return runWithReason(workspaceId, "New branch", (cwd) => backend.gitCreateBranch(cwd, name, from, checkoutAfter));
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

/// Reports its reason rather than a bare boolean: both of its callers --
/// the fork dialog and a best-of-N launch -- are surfaces the Git tab's
/// error banner is not on.
export function forkWorktree(
  workspaceId: string,
  opts: { path: string; branch: string; from: string | null; newBranch: boolean }
): Promise<RunResult> {
  return runWithReason(workspaceId, "New worktree", (cwd) => backend.gitWorktreeAdd(cwd, opts.path, opts.branch, opts.from, opts.newBranch));
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

/// The half of a sweep verdict that only git can answer: which branches
/// have landed on `base`, and which worktrees still hold uncommitted
/// work. The rails and the sessions are the caller's to supply; the rule
/// that joins the four lives in worktreeSweep.ts.
///
/// Deliberately outside `run()`: it is read-only, and marking the whole
/// tab busy (and clearing its error banner) merely because a menu opened
/// would be a lie about what gavin is doing.
///
/// A checkout whose status will not read counts as DIRTY. Every failure
/// mode here — a folder half-deleted, a permissions problem, a git that
/// exited non-zero — is a reason not to know what is in it, and "we
/// could not look" must never be recorded as "there was nothing there".
///
/// Dirty means THE PROJECT's files. Every checkout of a gavin workspace
/// holds gavin's own board — untracked where the workspace keeps it out
/// of git, a symlink to the root checkout's copy where a fleet of
/// worktrees shares one, a tracked folder that churns on every card move
/// where it does not — and counting that made `classifyWorktrees` keep
/// every worktree on its first and strongest blocker, "uncommitted
/// changes". The Sweep button was a no-op in exactly the workspaces it
/// was built for, and the reason it gave named a file gavin put there
/// itself.
export async function sweepFacts(
  rootPath: string,
  base: string,
  paths: readonly string[]
): Promise<{ merged: Set<string>; dirty: Set<string> }> {
  const merged = await backend
    .gitMergedBranches(rootPath, base)
    .then((names) => new Set(names))
    .catch(() => new Set<string>());
  const dirty = new Set<string>();
  await Promise.all(
    paths.map(async (path) => {
      const clean = await backend
        .gitStatus(path)
        .then((s) => [...s.staged, ...s.unstaged].every((e) => isGavinOwnPath(e.path)))
        .catch(() => false);
      if (!clean) dirty.add(path.replace(/\/+$/, ""));
    })
  );
  return { merged, dirty };
}

/// Remove a batch of worktrees in one busy cycle, forced only past
/// gavin's OWN files: `git worktree remove` refusing is the last line of
/// defence under the staleness rule, and a sweep that passed `--force`
/// outright would delete exactly the work the rule exists to protect.
/// The first refusal stops the batch and lands in the error banner with
/// git's own words.
///
/// The narrow force is what makes the sweep work at all now that
/// `sweepFacts` no longer calls gavin's board dirty. git does not draw
/// that distinction — it refuses on ANY untracked file — so without this
/// every gavin worktree would classify stale and then die at removal on
/// a raw fatal, which is a worse answer than the wrong verdict it
/// replaced. `mayForceRemoval` states the rule; the only thing decided
/// here is WHEN to ask.
///
/// And it is asked HERE, per entry, off a fresh read rather than the
/// facts the confirmation was drawn from. Those were gathered before a
/// dialog the human then spent seconds in, and an agent writes to a
/// checkout in far less: forcing on a minute-old answer is precisely the
/// window git's blanket refusal used to cover. A read that fails forces
/// nothing, so the unforced call goes out and git refuses it.
export function sweepWorktrees(
  workspaceId: string,
  entries: readonly { path: string; branch: string | null }[],
  deleteBranches: boolean
): Promise<boolean> {
  return run(workspaceId, "Sweep worktrees", async (cwd) => {
    for (const entry of entries) {
      const status = await backend.gitStatus(entry.path).catch(() => null);
      await backend.gitWorktreeRemove(cwd, entry.path, mayForceRemoval(status));
      // Never forced either: `branch -d` refuses anything unmerged, and
      // the sweep only ever offers this for branches git already agreed
      // had landed.
      if (deleteBranches && entry.branch) await backend.gitDeleteBranch(cwd, entry.branch, false);
    }
  });
}

/// Remove the worktrees a best-of-N run is throwing away, FORCED --
/// the one place in this file that passes `--force` to either command.
///
/// The sweep above refuses to, and must: it deletes checkouts nobody
/// explicitly chose, so git's own refusal is its last line of defence.
/// Here the opposite is true. A losing candidate's worktree is dirty by
/// definition -- an agent worked in it for twenty minutes -- and its
/// branch holds commits that were never merged anywhere, so an unforced
/// `worktree remove` and an unforced `branch -d` would BOTH refuse, on
/// every candidate, every time. The human has already been shown each
/// folder by name and told the work in it is going.
///
/// Best-effort per entry, unlike the sweep's stop-at-the-first-refusal:
/// the losers have already had their sessions closed by the time this
/// runs, so stopping halfway would leave folders with nothing in the app
/// still pointing at them. The last failure is reported once everything
/// else is gone.
export async function discardWorktrees(
  workspaceId: string,
  entries: readonly { path: string; branch: string | null }[],
  deleteBranches: boolean
): Promise<boolean> {
  // The Git tab may be POINTED at one of these -- reading a candidate's
  // diff is exactly how a human decides which to keep -- and `run` takes
  // its cwd from that view. git refuses to remove the worktree it is
  // being run from, so without this the pick fails on the one folder the
  // human was looking at. Moved back to the root first, which is where
  // the tab has to end up anyway once the folder is gone.
  //
  // Inside this function rather than at its call sites: the sweep learnt
  // the same lesson in its own component, and two copies of a guard is
  // one copy that gets forgotten.
  const view = current(workspaceId);
  const doomed = new Set(entries.map((e) => e.path.replace(/\/+$/, "")));
  if (view && doomed.has(view.cwd.replace(/\/+$/, ""))) {
    await switchWorktree(workspaceId, rootPathOf(view));
  }
  return run(workspaceId, "Discard worktrees", async (cwd) => {
    let failure: unknown = null;
    for (const entry of entries) {
      try {
        await backend.gitWorktreeRemove(cwd, entry.path, true);
        if (deleteBranches && entry.branch) await backend.gitDeleteBranch(cwd, entry.branch, true);
      } catch (e) {
        failure = e;
      }
    }
    if (failure) throw failure;
  });
}

/// Merge a fork's branch into the ROOT checkout (G12). "conflict" means the
/// root now has MERGE_HEAD and the banner's Abort is the way out.
export async function mergeBack(workspaceId: string, rootPath: string, branch: string): Promise<"merged" | "conflict" | "failed"> {
  const done = await run(workspaceId, `Merge ${branch}`, () => backend.gitMerge(rootPath, branch));
  if (done) return "merged";
  const info = await backend.gitRepoInfo(rootPath).catch(() => null);
  return info?.inProgress === "merge" ? "conflict" : "failed";
}

// ---- Conflict resolution ---------------------------------------------------

export async function loadConflict(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  const sel = s?.selected;
  if (!s || !sel) return;
  const token = s.conflictToken + 1;
  update(workspaceId, (st) => ({ ...st, conflictToken: token }));
  try {
    const conflict = await backend.gitConflict(s.cwd, sel.path);
    update(workspaceId, (st) => (st.conflictToken === token ? { ...st, conflict } : st));
  } catch (e) {
    update(workspaceId, (st) => (st.conflictToken === token ? { ...st, conflict: null, error: `Conflict failed to load: ${errorText(e)}` } : st));
  }
}

function selectedConflictPath(workspaceId: string): string | null {
  const s = current(workspaceId);
  const entry = s ? findEntry(s.status, s.selected) : null;
  return entry?.status === "U" ? entry.path : null;
}

/// Writes the Result document back to the file (EOL already applied by the
/// caller) and reloads the conflict view through the normal refresh.
export function saveConflict(workspaceId: string, text: string): Promise<boolean> {
  const path = selectedConflictPath(workspaceId);
  if (!path) return Promise.resolve(false);
  return run(workspaceId, "Save", (cwd) => backend.writeFileForEditor(`${cwd}/${path}`, text));
}

/// Mark the selected conflicted file resolved, then move on to the next
/// conflicted file if there is one.
export async function markResolved(workspaceId: string): Promise<boolean> {
  const path = selectedConflictPath(workspaceId);
  if (!path) return false;
  const done = await run(workspaceId, "Mark resolved", (cwd) => backend.gitMarkResolved(cwd, path));
  if (done) {
    const next = current(workspaceId)?.status?.unstaged.find((e) => e.status === "U");
    if (next) await select(workspaceId, { path: next.path, area: "unstaged" });
  }
  return done;
}

export function resolveWhole(workspaceId: string, side: "ours" | "theirs"): Promise<boolean> {
  const path = selectedConflictPath(workspaceId);
  if (!path) return Promise.resolve(false);
  return run(workspaceId, `Use ${side}`, (cwd) => backend.gitResolveWhole(cwd, path, side));
}

export function resolveDeleted(workspaceId: string, keep: boolean): Promise<boolean> {
  const path = selectedConflictPath(workspaceId);
  if (!path) return Promise.resolve(false);
  return run(workspaceId, keep ? "Keep file" : "Delete file", (cwd) => backend.gitResolveDeleted(cwd, path, keep));
}

export function restoreConflict(workspaceId: string): Promise<boolean> {
  const path = selectedConflictPath(workspaceId);
  if (!path) return Promise.resolve(false);
  return run(workspaceId, "Restore markers", (cwd) => backend.gitRestoreConflict(cwd, path));
}

/// Opens `git mergetool` for the selected file in a terminal pane; the
/// watcher reloads the editor when the tool writes the file.
export async function openMergeTool(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  const path = selectedConflictPath(workspaceId);
  if (!s || !path) return;
  const quoted = `'${path.replace(/'/g, "'\\''")}'`;
  await createSessionForCard(workspaceId, s.cwd, `git mergetool --no-prompt -- ${quoted}`);
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

/// The queue's way back in: run a commit intent that has already cleared
/// the gate.
///
/// The retry count travels with the intent, because it is what bounds
/// gavin's own automatic retries -- a queued retry that came back as a
/// human's press would restore a budget the run had already spent.
export async function launchQueuedCommit(intent: CommitIntent): Promise<void> {
  await commitViaAgent(intent.workspaceId, intent.retries, { queued: true });
}
