import { writable, derived, get, type Writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { askConfirm, showAlert } from "$lib/dialog";
import type { LayoutNode } from "$lib/layout";
import * as layout from "$lib/layout";
import * as backend from "$lib/backend";
import { setTempRoot } from "$lib/orchestrationLoop";
import type { PauseCycle } from "$lib/agentPause";
import * as terminalRegistry from "$lib/terminalRegistry";
import { hotState } from "$lib/hotState";
import * as workspace from "$lib/workspace";
import type {
  Workspace,
  WorkspacesData,
  GitStatus,
  GitViewPrefs,
  DevelopingCardRecord,
  OrchestrationAgentRecord,
  RemovedWorkspace,
} from "$lib/workspace";
import { sessionLabel } from "$lib/paths";
import { buildRunCommand, mintConversationId, noPromptReason } from "$lib/cardRun";
import { workspaceIdForSession } from "$lib/workspace";
import { maybeNotifyStatusChange, parseSessionStatus, type SessionStatus } from "$lib/notifications";
import { initGavinListeners, watchRootedWorkspaces, gavinTrees, worktreeSetups } from "$lib/gavinState";
import { followRenamedContext } from "$lib/planExplorer";
import { retargetPath } from "$lib/fileTree";
import {
  normalizeColor,
  resolveAgentConfig,
  type AgentProfileInfo,
  type McpFormatInfo,
} from "$lib/settings";
import { mergeDiscoveredModels } from "$lib/agentModel";
import { normalizeTerminalFontSize, resolveTerminalFontSize } from "$lib/terminalFont";
import { normalizeAutoCommit, resolveAutoCommit } from "$lib/autoCommit";
import { normalizeGitTracking } from "$lib/gitTracking";
import type { AgentConfig, BoardTab, CardTab, CardTabView, GavinTree } from "$lib/gavin";
import { themeState } from "$lib/ui/themeState.svelte";
import { featureBlockedReason, restartConfirmLines, type DaemonCompat } from "$lib/daemonCompat";
import { confirmDestructive, DAEMON_SUBJECT } from "$lib/confirmGate";
import type { OrphanProcess } from "$lib/orphan";
import type { StatusSince } from "$lib/attentionInbox";
import {
  attentionStatuses,
  clearSessionRead,
  withSessionRead,
  type ReadSessions,
} from "$lib/sessionRead";
import { indexQueued, type QueuedInput } from "$lib/queuedInput";
import { candidateAgentConfig, type Candidate } from "$lib/bestOfN";
import {
  agentConfigWithAttribution,
  EMPTY_AGENT_DEFAULTS,
  type AgentDefaults,
  type ComplexityTable,
} from "$lib/complexity";
import { cardAgentEntry, type CardAgentFields } from "$lib/cardAgent";
import {
  configTrusted,
  executionKeys,
  executionKeysHash,
  hasExecutionKeys,
  trustedAgentConfig,
  type ExecutionKeys,
} from "$lib/workspaceTrust";
import {
  cardContentDigest,
  cardContentReviewed,
  normalizeRequireReview,
  resolveRequireReview,
  type CardContent,
} from "$lib/cardReview";
import type { McpForeignChoice } from "$lib/mcpServerTrust";
import {
  activeWorkspaceForWindow,
  isInAnotherWindow,
  nextActiveAfterHandoff,
  windowAction,
} from "$lib/appWindow";
import {
  currentWindowLabel,
  currentWorkspaceWindows,
  initWorkspaceWindows,
  isMainWindow,
} from "$lib/appWindowState";

export type { SessionStatus };

// A pane tab that shows a file instead of a terminal session. Keyed by
// the same opaque tab-id space session ids live in -- a tab id present in
// fileTabsById is a file tab, one absent from it is a terminal session.
export interface FileTab {
  path: string;
}

export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
  sessionNames: Record<string, string>;
  sessionStatusById: Record<string, SessionStatus>;
  gitStatusById: Record<string, GitStatus | null>;
  restoredSessionIds: Set<string>;
  /// The sessions whose RUN was killed with a previous daemon: the tab
  /// holds a bare shell in the same cwd, not the agent that was working
  /// (see the daemon's `SessionManager::recover`). A superset-in-meaning
  /// of `restoredSessionIds`, not of it -- a plain terminal session is
  /// restored and never interrupted, because it had no run to lose.
  ///
  /// This is the signal every surface that watches a run consults:
  /// membership in a layout tree only says a session id exists, which a
  /// restored bare shell satisfies exactly as well as the agent it
  /// replaced. Never cleared by typing, unlike `restoredSessionIds` --
  /// the run is still gone.
  interruptedSessionIds: Set<string>;
  /// The sessions whose agent OUTLIVED the daemon that hosted it: it is
  /// still running, reparented to init, editing the checkout, with a bare
  /// shell in the tab where it used to be.
  ///
  /// Strictly stronger than `interruptedSessionIds`, and the one place
  /// where "not in this map" is ambiguous: it means "no survivor" only on
  /// a daemon that probes (orphan.ts's `orphanDetectionAvailable`). On an
  /// older one it means nobody looked, which is why the copy softens
  /// rather than asserting a clean stop.
  ///
  /// Keyed by session id and holding the process, because every surface
  /// that shows it has to be able to NAME what it would kill -- a
  /// confirmation that says "end the orphaned process?" is not a
  /// confirmation.
  orphanBySessionId: Record<string, OrphanProcess>;
  /// Why a session is `failed`, in the agent's own words -- the line its
  /// TUI painted ("API Error: 529 Overloaded…"), or the sleep the daemon
  /// watched it through. Keyed by session id, and present only while
  /// that session's status is `failed`: the daemon clears the reason
  /// with the status, and a stale reason on a live session is worse than
  /// none, because it is the text every surface would show.
  ///
  /// A separate map rather than a richer status value: `sessionStatusById`
  /// is read by a dozen surfaces that only ever compare it, and widening
  /// it into an object would make every one of those comparisons wrong.
  failureReasonById: Record<string, string>;
  /// When each session entered the status it now holds, by session id.
  ///
  /// The daemon reports that a status CHANGED, never when the one it is
  /// reporting began, so this is the only clock the app has for "how
  /// long has this agent been waiting on me" -- the question the hub's
  /// attention inbox is ordered by. Stamped here rather than derived
  /// because a duration cannot be recovered after the fact: a status
  /// that landed and was never written down is a wait with no start.
  ///
  /// `watched: false` marks a stamp taken when the app first SAW the
  /// status (a baseline from Attach) rather than when it changed. That
  /// distinction is the whole honesty of the column: after a relaunch
  /// every session is unwatched, and a row that read "3m" for an agent
  /// that has been stuck since yesterday would be worse than one that
  /// admits it is a lower bound.
  ///
  /// Never cleared on exit, like the sibling maps above.
  statusSinceById: Record<string, StatusSince>;
  /// The sessions whose CURRENT wait the human has acknowledged -- the
  /// "Mark as Read" tab action. Membership hides the wait from every
  /// surface that nags about it and from nothing else; see
  /// sessionRead.ts for why the daemon's status is deliberately left
  /// alone. Dropped again by the next status the daemon reports for that
  /// session, and never persisted.
  readSessionIds: ReadSessions;
  fileTabsById: Record<string, FileTab>;
  boardTabsById: Record<string, BoardTab>;
  cardTabsById: Record<string, CardTab>;
  /// Workspaces the sidebar X removed, newest first. Persisted with the
  /// workspaces themselves; see workspace.ts's RemovedWorkspace for why
  /// removing a workspace has to leave a record at all.
  removedWorkspaces: RemovedWorkspace[];
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  workspaces: [],
  activeWorkspaceId: null,
  focusedSessionId: null,
  cwdBySessionId: {},
  sessionNames: {},
  sessionStatusById: {},
  gitStatusById: {},
  restoredSessionIds: new Set(),
  interruptedSessionIds: new Set(),
  orphanBySessionId: {},
  failureReasonById: {},
  statusSinceById: {},
  readSessionIds: new Set(),
  fileTabsById: {},
  boardTabsById: {},
  cardTabsById: {},
  removedWorkspaces: [],
};

/// The bag Vite carries across a re-execution of this module, or
/// `undefined` outside a dev server (the bundled app, and vitest).
///
/// Vite re-executes a module for an edit anywhere in its DEPENDENCY cone,
/// and nearly everything in `app/src` is in this one's -- so under plain
/// module-level `const`s every store below was rebuilt EMPTY on almost
/// every save, while the app around them kept running. For `layoutState`
/// that means the whole window: workspaces, pages, layout trees, and both
/// tab maps, replaced by `initialState` and its `"connecting"` status. The
/// same fix terminalRegistry already carries, for the same reason: what is
/// parked here is state nothing else can rebuild, or that only a startup
/// path an HMR remount SKIPS would refill.
///
/// Not parked, deliberately: `daemonRequestError` (a refusal that predates
/// the reload should not outlive it), the three Rust lookup tables
/// (`bootstrap` re-fetches them unconditionally on every remount), and
/// `unlisteners`/`tabMapsLoaded`, which belong to one execution of this
/// module and must not be adopted by the next.
const hotBag = import.meta.hot?.data;

export const layoutState = hotState("layoutState", () => writable<LayoutState>(initialState), hotBag);

/// The read marks of a state that may predate the field.
///
/// The hot bag above parks the LayoutState OBJECT, so a dev session that
/// was already running when `readSessionIds` landed carries a state
/// without it. A missing sibling MAP degrades to an undefined lookup and
/// nothing more; a missing Set throws the moment anything asks it a
/// question. This one is asked on every status push -- the hottest path
/// in the file -- so it gets the one line that keeps a stale remount from
/// throwing on each of them.
const NO_READ_MARKS: ReadSessions = new Set();
const readMarks = (s: LayoutState): ReadSessions => s.readSessionIds ?? NO_READ_MARKS;

// The compat verdict Rust negotiated with the daemon at connect time.
// null until the first successful probe -- DaemonCompatBanner
// stays silent on null the same way compatMessage does. Refreshed
// wherever this module re-syncs against a (re)connected daemon; see
// refreshDaemonCompat.
// Parked (see hotBag): the only paths that refresh it are the two
// startup ones, and both return early on an HMR remount because the
// status is already "ready" -- so rebuilding it here would silence the
// compat banner and open every featureBlockedReason gate.
export const daemonCompat = hotState<Writable<DaemonCompat | null>>(
  "daemonCompat",
  () => writable(null),
  hotBag
);

/// The last request the daemon refused on the streaming connection, or
/// null once nothing is outstanding.
///
/// Separate from `status: "error"` on purpose. That means the CONNECTION
/// is gone and there is no app left to show; this means one Attach /
/// WriteInput / ResizeSession came back rejected while everything else
/// kept working -- typically for a session id that has just exited.
/// Routing the second through the first is what turned a stray resize
/// into "the app crashed with the Daemon restart error": a whole window
/// replaced over one dead pane. DaemonRequestErrorBanner renders this as
/// a dismissible strip instead, so the failure is still visible and the
/// app is still usable.
export const daemonRequestError = writable<string | null>(null);

/// Every session's pending follow-ups, in delivery order, keyed by
/// session id.
///
/// A push-fed map WITH a read-back, which is the whole reason
/// `Request::ListQueuedInputs` exists at all: `QueuedInputsChanged` is
/// routed to a session's attached writer, so a frontend that reloaded
/// was attached to nothing when every previous push fired. The daemon
/// re-sends each session's queue on Attach, and Attach runs once per app
/// PROCESS -- so without `seedQueuedInputs` below, a `tauri dev` edit
/// would leave the strip claiming an empty queue over a message the
/// daemon is still holding. That is the `gitStatusById` bug exactly, and
/// it is worse here: the human queued the follow-up because they were
/// walking away, and an empty strip would read as "it was delivered".
///
/// A session with nothing pending is ABSENT, never an empty array: the
/// push carries the whole queue every time, so `[]` and "no key" say the
/// same thing and keeping both would only invite a surface to tell them
/// apart.
///
/// Parked on hotBag with the rest: an HMR edit re-executes this module
/// and would otherwise drop every queue back to blank with no push
/// coming to refill it.
export const queuedInputsById = hotState(
  "queuedInputsById",
  () => writable<Record<string, QueuedInput[]>>({}),
  hotBag
);

/// Shared by the "queued-inputs-changed" listener in bootstrap() and
/// this file's own tests. The payload is the WHOLE queue for that
/// session, never a delta, so this replaces rather than merges -- a
/// client that missed a push cannot drift, and one that receives them
/// out of order still converges on the last one.
export function handleQueuedInputsChanged(sessionId: string, queued: QueuedInput[]): void {
  queuedInputsById.update((s) => {
    // Deleted rather than stored empty, so the map's keys mean "has
    // something pending" and no surface has to check both.
    if (queued.length === 0) {
      if (!(sessionId in s)) return s;
      const next = { ...s };
      delete next[sessionId];
      return next;
    }
    return { ...s, [sessionId]: queued };
  });
}

/// The read-back. Runs once at bootstrap, and OVERWRITES rather than
/// filling gaps -- the opposite of seedSessionBaselines' rule, and the
/// difference is worth naming.
///
/// Those maps are fed by pushes that are each a fact about one moment
/// ("the cwd changed to X"), so a push that has landed is newer than any
/// snapshot and must win. This one is a fact about a WHOLE LIST, and the
/// list this reply carries is the one the daemon holds right now. A
/// merge would keep a stale queue for a session that has since drained
/// -- the exact bad answer, since a follow-up shown as pending after it
/// was delivered invites the human to send it a second time.
async function seedQueuedInputs(): Promise<void> {
  // Same wait loadTabMaps satisfies: once those maps have come back, the
  // Rust side has managed the CommandConnection these ride.
  await tabMapsLoaded;
  const all = await backend.listQueuedInputs().catch(() => null);
  // Against a daemon older than v29 this request never reaches the wire,
  // so the catch is the ordinary path there, not an error: the map stays
  // empty and every queueing surface is disabled with the version reason
  // (daemonCompat's `queuedFollowUps`).
  if (!all) return;
  queuedInputsById.set(indexQueued(all));
}

/// Whether the app hub -- the fleet overview above every workspace -- has
/// taken over the main pane.
///
/// Deliberately NOT persisted, and deliberately not a workspace
/// `activeView`: it is app-level, it belongs to no workspace, and a
/// relaunch should land where you left off working rather than on a
/// launcher you happened to have open. It is also not a router: the app
/// is a single page, and this is the flag +page.svelte branches on ahead
/// of the workspace it would otherwise render.
export const appHubOpen = hotState("appHubOpen", () => writable(false), hotBag);

export function openAppHub(): void {
  appHubOpen.set(true);
}

export function closeAppHub(): void {
  appHubOpen.set(false);
}

// Pulls the current compat verdict from the Rust side. Called at every
// point this module already re-syncs against a (re)connected daemon --
// the workspaces-ready event, pollForStartupState's success path, and
// restartDaemonInPlace -- so the banner and featureBlockedReason never
// keep serving a verdict from a connection that no longer exists.
// Best-effort: a failed fetch (including, in tests, backend.daemonCompat
// simply not being mocked) leaves the previous value in place rather than
// blanking the banner over a transient IPC hiccup.
//
// Returns the verdict now in force -- the fresh one, or the retained
// previous one when the probe failed -- so a caller that restarted the
// daemon can compare it against what it saw beforehand. Reading the store
// after the call would work equally well; returning it keeps the "did this
// restart change anything?" question answerable without a store read
// racing the next refresh.
async function refreshDaemonCompat(): Promise<DaemonCompat | null> {
  try {
    const compat = await backend.daemonCompat();
    daemonCompat.set(compat);
    return compat;
  } catch {
    // leave the previous verdict in place
    return get(daemonCompat);
  }
}

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// Shared by every action below that ends in "mutate the active page's
// tree, then persist the whole workspaces array" -- extracted so that
// pattern exists exactly once instead of once per action.
//
// The tombstone list is read off the store rather than taken as a third
// argument. Thirty-odd call sites pass whatever workspaces they just
// computed; making each of them also remember an unrelated list is how a
// carry-through field gets silently wiped by the one site that forgot
// it. The store is where the list lives, so the two callers that CHANGE
// it (closeWorkspace, and the reclaim prompt) write it there first and
// then persist like everyone else.
async function persistWorkspaces(workspaces: Workspace[], activeWorkspaceId: string | null): Promise<void> {
  try {
    await backend.setWorkspacesState(
      workspaces,
      activeWorkspaceId,
      get(layoutState).removedWorkspaces ?? []
    );
  } catch (e) {
    setError(String(e));
  }
}

/// config.json's `activeWorkspaceId` read for THIS window.
///
/// The stored id is one value behind however many windows are open, so it
/// can be right for at most one of them -- and not even reliably for the
/// main window, since the workspace it names may since have moved into a
/// window of its own. Every window therefore takes it as a preference and
/// falls back to the first workspace it actually holds.
function forThisWindow(data: WorkspacesData): WorkspacesData {
  return {
    ...data,
    activeWorkspaceId: activeWorkspaceForWindow(
      data.workspaces,
      currentWorkspaceWindows(),
      currentWindowLabel(),
      data.activeWorkspaceId ?? null
    ),
  };
}

/// Takes on what another window just wrote.
///
/// config.json is one file and every window writes the whole array back,
/// so without this the second window to save would undo the first's work
/// -- a page renamed here, a tab opened there, and whichever saved last
/// wins the entire file. The writer is the authority and this is every
/// other window agreeing with it.
///
/// What is NOT adopted: which workspace this window is showing. That is
/// per window now, and taking the writer's would make one window's click
/// change what another is looking at.
function adoptWorkspaces(data: WorkspacesData): void {
  layoutState.update((s) => {
    if (s.status !== "ready") return s;
    const resolved = workspace.resolveActiveFocus({
      workspaces: data.workspaces,
      activeWorkspaceId: activeWorkspaceForWindow(
        data.workspaces,
        currentWorkspaceWindows(),
        currentWindowLabel(),
        s.activeWorkspaceId
      ),
      removedWorkspaces: data.removedWorkspaces ?? [],
    });
    return {
      ...s,
      workspaces: resolved.state.workspaces,
      activeWorkspaceId: resolved.state.activeWorkspaceId,
      focusedSessionId: resolved.focusedSessionId,
      removedWorkspaces: data.removedWorkspaces ?? [],
    };
  });
  // A root bound (or unbound) in the other window is a watch this one
  // owes the daemon too: gavin trees arrive per window, and a workspace
  // whose root this window never armed would render an empty board.
  watchRootedWorkspaces(data.workspaces);
}

/// Makes a workspace the active one: stamps it as last used, and takes
/// the app hub down. Every path that puts a workspace on screen goes
/// through here rather than calling workspace.switchWorkspace directly
/// -- the stamp is what the hub's recents order is built on, and the
/// hub must not survive underneath the workspace the user just chose,
/// and both are far too easy to forget one call site at a time.
function activateWorkspace(state: WorkspacesData, workspaceId: string): WorkspacesData {
  if (claimedElsewhere(workspaceId)) return state;
  closeAppHub();
  return workspace.switchWorkspace(state, workspaceId, Date.now());
}

/// The one gate that keeps a workspace out of two windows at once, and
/// what it does instead: raise the window it is already in.
///
/// Every path that puts a workspace on screen -- the sidebar, the hub's
/// recents, the ⌘⌥-digits, a card jumping to its session, a rail
/// launching a step -- ends in `activateWorkspace`, so guarding that one
/// function is what makes the rule hold everywhere without thirty call
/// sites each remembering it. Two panes over one PTY would each report
/// their own size to the daemon and resize the program between them for
/// as long as both were open; see appWindow.ts.
///
/// Answering `true` means "not here" -- the caller returns its state
/// unchanged, so nothing on screen moves.
function claimedElsewhere(workspaceId: string): boolean {
  if (!isInAnotherWindow(currentWorkspaceWindows(), workspaceId, currentWindowLabel())) {
    return false;
  }
  void backend.focusWorkspaceWindow(workspaceId).catch(() => {});
  return true;
}

// The directory a blank terminal opened inside a workspace should start
// in: that workspace's bound root. Undefined for a rootless workspace
// (the Scratchpad, or one whose root has never been picked), which is
// how the Rust side is told "no target" and falls back to $HOME. Every
// spawn-a-blank-terminal path -- new page, split, new tab -- goes
// through this, so they all land in the same place instead of dumping
// the user in their home directory.
function freshSessionCwd(workspaceId: string): string | undefined {
  return workspaceRootPath(workspaceId) ?? undefined;
}

/// A workspace's bound root folder, or null when it has none (the
/// Scratchpad, or one never pointed at a repo). Exported because a card
/// attachment's relative path resolves against the ROOT and nothing
/// else: a rail's step runs in a worktree and a board Run runs in the
/// card's context folder, so resolving against a cwd would hand two
/// sessions two different files from one card.
export function workspaceRootPath(workspaceId: string): string | null {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.rootPath || null;
}

// Every terminal/agent session id currently live anywhere in the app --
// every page of every workspace, main agent sessions included -- with
// file and board tabs excluded (they share the tab-id space, but the
// daemon has never heard of them, so they cost a restart nothing). This
// is exactly the set a daemon restart would end -- DaemonCompatBanner
// uses its size for compatMessage's "restarting will end N running
// agents" warning. Recomputed on demand rather than tracked
// incrementally: handleSessionExited already keeps every tree pruned to
// only sessions that are still alive, so there is nothing stale here to
// filter by status.
export function liveSessionIds(state: LayoutState): Set<string> {
  const ids = new Set<string>();
  for (const ws of state.workspaces) {
    if (ws.mainSessionId) ids.add(ws.mainSessionId);
    for (const page of ws.pages) {
      for (const id of layout.allSessionIds(page.layout)) {
        if (!state.fileTabsById[id] && !state.boardTabsById[id] && !state.cardTabsById[id])
          ids.add(id);
      }
    }
  }
  return ids;
}

export function runningSessionCount(state: LayoutState): number {
  return liveSessionIds(state).size;
}

// Shared by every action that creates exactly one fresh session before
// mutating a tree (splitPane, addTab). Returns null -- having already
// called setError -- on failure, so callers just check for null rather
// than duplicating their own try/catch.
async function createFreshSession(workspaceId: string): Promise<string | null> {
  try {
    return await backend.createSession(freshSessionCwd(workspaceId));
  } catch (e) {
    setError(String(e));
    return null;
  }
}

/// The non-session tabs a close ended, handed back to the caller instead
/// of being pruned on the spot.
///
/// `fileTabsById`/`boardTabsById`/`cardTabsById` are the ONLY thing that
/// tells Pane.svelte a tab is a file, a board or a card rather than a
/// terminal. Drop an
/// id from them while it is still in a layout tree and that pane falls
/// straight through to a `<TerminalPane>` for an id the daemon has never
/// heard of: it mounts, calls fit(), and asks the daemon to resize it.
/// The daemon answers "unknown session" on the STREAMING connection,
/// which the Rust relay turns into a `daemon-error` -- and that is a
/// whole-window "Couldn't connect to the daemon" overlay, not a
/// swallowed per-call failure (TerminalPane's own .catch never sees it).
/// So every caller updates the tree first and calls pruneClosedTabs
/// afterwards.
interface ClosedTabs {
  fileTabIds: string[];
  boardTabIds: string[];
  cardTabIds: string[];
}

// Every close path (tab, pane, page, workspace) ends the tabs it owns.
// A file tab is not a session -- killing it would ask the daemon to kill
// an id it has never heard of -- so it gets its watcher torn down instead.
// Returns null (having already called setError) if a real session kill
// failed, so callers can bail exactly as they do today.
async function endTabs(
  tabIds: string[],
  fileTabsById: Record<string, FileTab>,
  boardTabsById: Record<string, BoardTab>,
  cardTabsById: Record<string, CardTab>
): Promise<ClosedTabs | null> {
  const fileTabIds: string[] = [];
  const boardTabIds: string[] = [];
  const cardTabIds: string[] = [];
  for (const id of tabIds) {
    const fileTab = fileTabsById[id];
    if (fileTab) {
      // Best-effort: a watcher that's already gone (or was never
      // started because the file read failed) must not block the close.
      await backend.unwatchFileForViewer(fileTab.path).catch(() => {});
      fileTabIds.push(id);
      continue;
    }
    if (boardTabsById[id]) {
      // A board tab is not a session and holds no watcher of its own --
      // tree watching is workspace-level. Prune and persist only.
      boardTabIds.push(id);
      continue;
    }
    if (cardTabsById[id]) {
      // Same as a board tab: no process, no watcher of its own. The card
      // file's watch belongs to the detail view inside the pane, which
      // tears it down when it unmounts.
      cardTabIds.push(id);
      continue;
    }
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return null;
    }
  }
  return { fileTabIds, boardTabIds, cardTabIds };
}

/// Drops the tabs endTabs ended from the maps that classify them. Call
/// only once the layout tree no longer holds them -- see ClosedTabs.
async function pruneClosedTabs(closed: ClosedTabs): Promise<void> {
  if (closed.fileTabIds.length > 0) await pruneFileTabs(closed.fileTabIds);
  if (closed.boardTabIds.length > 0) await pruneBoardTabs(closed.boardTabIds);
  if (closed.cardTabIds.length > 0) await pruneCardTabs(closed.cardTabIds);
}

// Mirrors pruneBoardTabs exactly, over the third map.
async function pruneCardTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, CardTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).cardTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, cardTabsById: remaining }));
  await backend.setCardTabs(remaining).catch(() => {});
}

// Mirrors pruneFileTabs: best-effort persistence, a failed prune costs a
// stale entry, never a broken close.
async function pruneBoardTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, BoardTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).boardTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, boardTabsById: remaining }));
  await backend.setBoardTabs(remaining).catch(() => {});
}

// Drops closed file tabs from the map and persists the result.
//
// The sibling maps (cwdBySessionId, sessionNames, sessionStatusById) are
// deliberately never pruned, and this one initially followed them -- but
// they are in-memory only, whereas file_tabs is written to config.json.
// Left alone it would accumulate dead ids on disk forever, so the
// convention that justified not pruning does not actually apply here.
async function pruneFileTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, FileTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).fileTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, fileTabsById: remaining }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(remaining)) {
    asPathMap[id] = tab.path;
  }
  // Best-effort, matching how this map is loaded: a failed prune costs a
  // stale entry, never a broken close.
  await backend.setFileTabs(asPathMap).catch(() => {});
}

// Points every open file tab at a path that has just been renamed or
// moved -- the path itself, and anything that was under it when the
// renamed entry was a directory.
//
// Without this the Files tab's own rename would leave a tab titled after
// a file that no longer exists, over an editor reporting it deleted: the
// human performed a rename and the app reported a loss. FileEditor
// follows the prop change in place rather than remounting (see the
// path effect there), so an unsaved buffer survives the move.
//
// Returns how many tabs moved, so the caller can say so.
export async function retargetFileTabs(from: string, to: string): Promise<number> {
  const state = get(layoutState);
  const fileTabsById: Record<string, FileTab> = {};
  let moved = 0;
  for (const [id, tab] of Object.entries(state.fileTabsById)) {
    const next = retargetPath(tab.path, from, to);
    if (next === tab.path) {
      fileTabsById[id] = tab;
      continue;
    }
    moved += 1;
    fileTabsById[id] = { ...tab, path: next };
  }
  if (moved === 0) return 0;
  layoutState.update((s) => ({ ...s, fileTabsById }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(fileTabsById)) {
    asPathMap[id] = tab.path;
  }
  // Best-effort, like pruneFileTabs: a failed persist costs a stale
  // entry in config.json, never a tab left pointing at the old name.
  await backend.setFileTabs(asPathMap).catch(() => {});
  return moved;
}

// The active page's identity plus its current tree, or null if there's no
// active workspace, no active page, or either id is stale. Every
// tree-mutating action below starts by calling this.
function activePageLocation(
  state: WorkspacesData
): { workspaceId: string; pageId: string; tree: LayoutNode } | null {
  const ws = workspace.getActiveWorkspace(state);
  const page = ws && workspace.getActivePage(state);
  if (!ws || !page) return null;
  return { workspaceId: ws.id, pageId: page.id, tree: page.layout };
}

// The page that actually OWNS `sessionId`, for the actions the sidebar can
// aim at a tab on a page that isn't the one on screen. The tab bar only
// ever addresses the active page, so for it this resolves to exactly what
// activePageLocation returns; for the sidebar it is the difference between
// acting and silently doing nothing, since a tree lookup that misses
// returns the tree unchanged and the no-op gets persisted as if it worked.
// Falls back to the active page so a caller holding an id that belongs to
// no page (a just-closed tab) behaves as it did before.
function pageLocationForSession(
  state: WorkspacesData,
  sessionId: string
): { workspaceId: string; pageId: string; tree: LayoutNode } | null {
  const found = workspace.findSessionLocation(state, sessionId);
  if (!found) return activePageLocation(state);
  const page = state.workspaces
    .find((w) => w.id === found.workspaceId)
    ?.pages.find((p) => p.id === found.pageId);
  if (!page) return activePageLocation(state);
  return { workspaceId: found.workspaceId, pageId: found.pageId, tree: page.layout };
}

// Board tabs are pinned to a context by FOLDER PATH, so renaming or
// moving that folder on disk would otherwise strand every tab on it
// behind "this context no longer exists" -- a dead tab for what was only
// a rename. Follows it instead, on the same narrow inference the Plans
// tab uses for a renamed file, and re-persists so the repair survives a
// restart. A move the inference can't call leaves the tab alone, and the
// pane's own missing-context notice stands.
function repairBoardTabs(
  workspaceId: string,
  before: GavinTree | undefined,
  after: GavinTree | undefined
): void {
  const current = get(layoutState).boardTabsById;
  const boardTabsById: Record<string, BoardTab> = {};
  let moved = false;
  for (const [id, tab] of Object.entries(current)) {
    const to =
      tab.workspaceId === workspaceId
        ? followRenamedContext(before, after, tab.contextFolder)
        : null;
    boardTabsById[id] = to === null ? tab : { ...tab, contextFolder: to };
    moved ||= to !== null;
  }
  if (!moved) return;
  layoutState.update((s) => ({ ...s, boardTabsById }));
  // Best-effort, matching how this map is loaded and pruned: a failed
  // write costs the repair on the next restart, never a broken tab now.
  void backend.setBoardTabs(boardTabsById).catch(() => {});
}

const unlisteners: UnlistenFn[] = [];

/// Resolves once `fileTabsById`/`boardTabsById`/`cardTabsById` hold what
/// the Rust side persisted -- see loadTabMaps. Both ready paths await it
/// before letting
/// `status` leave "connecting", so no layout tree is ever rendered
/// against empty maps. Starts resolved so a test (or any caller) that
/// never ran bootstrap is not left hanging.
let tabMapsLoaded: Promise<void> = Promise.resolve();

/// Loads the three frontend-owned maps that say which layout-tree ids are
/// file views, which are boards and which are cards.
///
/// Unlike session names, these are not cosmetic: every id NOT in them is
/// taken to be a daemon session. Empty maps therefore do not degrade to
/// "labels look wrong" -- they turn each restored file/board tab into a
/// <TerminalPane> that asks the daemon to resize an id it has never heard
/// of, and that answer arrives as a whole-window "Couldn't connect to the
/// daemon" (see ClosedTabs for the same failure reached from the close
/// path). So this retries the one failure it can actually hit -- FileTabs
/// and BoardTabs are `manage`d at the very end of session::bootstrap, so
/// an invoke that lands before it finishes rejects with "state not
/// managed", exactly the case pollForStartupState already spins on --
/// rather than swallowing it once and leaving the maps empty for the rest
/// of the run.
async function loadTabMaps(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [fileTabs, boardTabs, cardTabs] = await Promise.all([
      backend.getFileTabs().catch(() => null),
      backend.getBoardTabs().catch(() => null),
      backend.getCardTabs().catch(() => null),
    ]);
    // Card tabs deliberately do NOT gate this, unlike the other two. The
    // frontend is served live by vite under `tauri dev`, so an edit that
    // adds a host command reaches a window whose BINARY predates it, and
    // `get_card_tabs` then rejects with "not found" forever. Requiring it
    // here would spend all 15 attempts and then seed nothing at all --
    // turning every restored file and board tab into a terminal for an id
    // the daemon never had, which is a far worse failure than the one it
    // would be reporting. An older binary has no card tabs to lose, and a
    // genuinely transient miss is what repairUnknownTabs is for.
    if (fileTabs && boardTabs) {
      const fileTabsById: Record<string, FileTab> = {};
      for (const [tabId, path] of Object.entries(fileTabs)) {
        fileTabsById[tabId] = { path };
      }
      // Rust's copy is a SEED, not the truth. Every write to these maps
      // lands in the store first and is mirrored to Rust afterwards, so
      // for the whole flight of a `set_*_tabs` the store is ahead by
      // exactly the tab that was just opened. `bootstrap` is
      // +page.svelte's onMount and runs again whenever that component is
      // recreated -- under `tauri dev`, on any edit that reaches it
      // without reaching this module, which leaves the layout tree
      // standing. Copying Rust's map OVER the store's therefore drops
      // that tab's entry while its id stays in the tree, and an id in a
      // tree and in neither map is a terminal session as far as
      // Pane.svelte is concerned (see ClosedTabs). Merging underneath
      // keeps the seed doing its whole job -- every restored tab Rust
      // knows about and the store does not still arrives -- without it
      // ever being able to un-classify a tab the app itself just opened.
      layoutState.update((s) => ({
        ...s,
        fileTabsById: { ...fileTabsById, ...s.fileTabsById },
        boardTabsById: { ...boardTabs, ...s.boardTabsById },
        cardTabsById: { ...(cardTabs ?? {}), ...s.cardTabsById },
      }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Out of attempts: the daemon bootstrap that manages these states has
  // failed outright, and pollForStartupState's own timeout (or the
  // bootstrap error it surfaces) is what the human sees. Resolving here
  // rather than hanging keeps that path the one that reports it.
}

/// Tab ids this app run has already asked Rust to classify, the ids
/// waiting for the next pass, and the ids a pass is asking about right
/// now. See repairUnknownTabs. Module-level and NOT parked on hotBag
/// (unlike the stores above): a re-executed module rebuilds them by
/// asking again, which costs one round trip and no correctness.
const unknownTabsChecked = new Set<string>();
const pendingUnknownTabs = new Set<string>();
const unknownTabsInFlight = new Set<string>();
let pendingUnknownTabPass: Promise<void> | null = null;

/// The last-resort repair for the one thing Pane.svelte cannot tell
/// apart on its own.
///
/// A tab id in a layout tree and in NONE of the maps is a daemon session
/// -- and that is also exactly what a board, file or card tab looks like the
/// moment its map entry goes missing, because nothing about the id
/// itself says which it is. So a lost entry does not degrade, it
/// inverts: a real xterm and a `pty-output` listener get built for an id
/// the daemon never had, `fit()` asks the daemon to resize it, and the
/// refusal comes back as the daemon-request-error strip. Nothing tidies
/// that terminal up either -- destroyTerminal is only ever reached from
/// a close path, and this tab is not closing.
///
/// Rather than trust one copy of the classification, ask the other:
/// every open mirrors its map into Rust, so Rust answers for any tab the
/// store has lost. An id Rust calls a board or a file tab is put back in
/// the map and its mistaken terminal destroyed; an id Rust has nothing
/// for really is a session and is left alone -- and recorded, so an
/// ordinary terminal is asked about once in the whole run and never
/// again. The ids queue up for one shared pass, so a page of ten
/// terminals costs one pair of round trips rather than ten.
///
/// This does not replace getting the classification right (loadTabMaps
/// merges rather than overwrites for exactly that reason); it is what
/// stops the NEXT way of losing an entry from costing a bogus PTY.
export function repairUnknownTabs(tabIds: string[]): Promise<void> {
  for (const id of tabIds) {
    // In flight counts as asked. Pane.svelte calls this from an $effect
    // over the store, which every cwd and status push re-runs, so
    // without this the same ids would be re-asked several times over
    // while the first pass was still waiting on its round trip.
    if (unknownTabsChecked.has(id) || unknownTabsInFlight.has(id)) continue;
    pendingUnknownTabs.add(id);
  }
  if (pendingUnknownTabs.size === 0) return Promise.resolve();
  pendingUnknownTabPass ??= Promise.resolve().then(runUnknownTabPass);
  return pendingUnknownTabPass;
}

async function runUnknownTabPass(): Promise<void> {
  // Cleared first: an id queued while the round trip below is in flight
  // has to schedule its own pass rather than be silently dropped into
  // this one's already-taken snapshot.
  pendingUnknownTabPass = null;
  const ids = [...pendingUnknownTabs];
  pendingUnknownTabs.clear();
  for (const id of ids) unknownTabsInFlight.add(id);
  // The startup seed answers this question for every restored tab, and
  // both ready paths already wait on it -- asking underneath it would be
  // one guaranteed miss per restored board tab.
  await tabMapsLoaded;
  const [fileTabs, boardTabs, cardTabs] = await Promise.all([
    backend.getFileTabs().catch(() => null),
    backend.getBoardTabs().catch(() => null),
    backend.getCardTabs().catch(() => null),
  ]);
  for (const id of ids) unknownTabsInFlight.delete(id);
  // Nothing was learned, so nothing is recorded: leaving these unchecked
  // is what lets the next render ask again.
  // Same asymmetry as loadTabMaps, for the same reason: a binary without
  // the command must not cost the file and board repair.
  if (!fileTabs || !boardTabs) return;
  for (const id of ids) unknownTabsChecked.add(id);
  const files = ids.filter((id) => fileTabs[id] !== undefined);
  const boards = ids.filter((id) => boardTabs[id] !== undefined);
  const cards = cardTabs ? ids.filter((id) => cardTabs[id] !== undefined) : [];
  if (files.length === 0 && boards.length === 0 && cards.length === 0) return;
  layoutState.update((s) => {
    const fileTabsById = { ...s.fileTabsById };
    const boardTabsById = { ...s.boardTabsById };
    const cardTabsById = { ...s.cardTabsById };
    // ??=, not =: the store is the authority the moment it has an answer
    // of its own, exactly as in loadTabMaps.
    for (const id of files) fileTabsById[id] ??= { path: fileTabs[id] };
    for (const id of boards) boardTabsById[id] ??= boardTabs[id];
    if (cardTabs) for (const id of cards) cardTabsById[id] ??= cardTabs[id];
    return { ...s, fileTabsById, boardTabsById, cardTabsById };
  });
  for (const id of [...files, ...boards, ...cards]) terminalRegistry.destroyTerminal(id);
}

/// Refills what the frontend only ever learns from daemon pushes.
///
/// `cwdBySessionId`, `sessionStatusById`, `restoredSessionIds`,
/// `interruptedSessionIds` and `gitStatusById` are fed by the
/// `cwd-changed` / `session-status-changed` / `session-restored` /
/// `session-interrupted` / `git-status-changed` events, whose baseline
/// the daemon sends in reply to `Attach` -- and `Attach` runs once per
/// app PROCESS (session::attach_and_relay), not once per frontend load.
/// So a reloaded frontend starts blank on all five and cannot refill them
/// until the shell emits another OSC 7: the terminal's tab loses its
/// cwd-derived label, its status dot, and its "open this context's
/// board" button until the next prompt. Under `tauri dev` that is every
/// frontend edit.
///
/// Git is the worst of the five, and the reason this does two round
/// trips instead of one. Three of the others come back on the session's
/// next prompt, and `interrupted` never stops being true;
/// `git-status-changed` is change-only by design (see the
/// daemon's `trigger_recheck`), so once a repo root's poller has cached
/// a status, NOTHING re-sends it until the repo itself changes -- and a
/// checkout that is already dirty stays byte-identical through a day of
/// editing. The chip, the page rows' branch lines and the pane's dot
/// simply stay gone. Its answer comes from the host's own git rather
/// than a new daemon request, so a daemon a build behind still gets it.
///
/// Never overwrites a value already in the store: a push that has landed
/// is newer than this snapshot. `undefined` is the test, not falsiness --
/// a landed `null` means "this session is in no repo", which is an answer
/// and must not be overwritten either. Status is written straight into
/// the map rather than through handleSessionStatusChanged -- re-reading a
/// state the human has already seen is not a transition, and must not
/// fire an OS notification for it.
async function seedSessionBaselines(): Promise<void> {
  // Same wait loadTabMaps satisfies: once those maps have come back, the
  // Rust side has managed CommandConnection too.
  await tabMapsLoaded;
  const baselines = await backend.getSessionBaselines().catch(() => null);
  if (!baselines) return;
  const known = get(layoutState);
  const fresh = baselines.filter((b) => known.cwdBySessionId[b.id] === undefined);
  for (const b of fresh) {
    // Not a plain map write: handleCwdChanged also mirrors the cwd into
    // terminalRegistry, which the xterm link provider reads synchronously.
    handleCwdChanged(b.id, b.cwd);
  }
  layoutState.update((s) => {
    const sessionStatusById = { ...s.sessionStatusById };
    const statusSinceById = { ...s.statusSinceById };
    const restoredSessionIds = new Set(s.restoredSessionIds);
    const interruptedSessionIds = new Set(s.interruptedSessionIds);
    const orphanBySessionId = { ...s.orphanBySessionId };
    const failureReasonById = { ...s.failureReasonById };
    for (const b of baselines) {
      if (sessionStatusById[b.id] === undefined) {
        sessionStatusById[b.id] = parseSessionStatus(b.status);
        // `watched: false`: this status was already in place when the
        // app attached, and the daemon does not say since when. The
        // stamp is when gavin met it, which is a floor on the wait and
        // is labelled as one.
        statusSinceById[b.id] ??= { at: Date.now(), watched: false };
      }
      if (b.restored) restoredSessionIds.add(b.id);
      if (b.interrupted) interruptedSessionIds.add(b.id);
      // Written positively only, like the two above: a baseline that
      // says nothing must never DELETE an orphan a push already landed.
      // The only things that clear one are the daemon confirming it
      // exited (handleOrphanEnded) and the session going away.
      if (b.orphan) orphanBySessionId[b.id] = b.orphan;
      // The reason is a push like the other four, so a reloaded frontend
      // would otherwise come up with a red session and nothing to say
      // for itself. Written straight in, never through
      // handleSessionFailed -- re-reading a failure the human has
      // already seen is not a new failure and must not notify.
      if (b.failureReason && failureReasonById[b.id] === undefined) {
        failureReasonById[b.id] = b.failureReason;
      }
    }
    return {
      ...s,
      sessionStatusById,
      statusSinceById,
      restoredSessionIds,
      interruptedSessionIds,
      orphanBySessionId,
      failureReasonById,
    };
  });
  // Last, and awaited separately: this one shells out to git once per
  // distinct checkout, so it must never hold up the three maps above --
  // those are what the tab labels paint from.
  const gitStatuses = await backend.getGitBaselines(baselines.map((b) => b.cwd)).catch(() => null);
  if (!gitStatuses) return;
  layoutState.update((s) => {
    const gitStatusById = { ...s.gitStatusById };
    baselines.forEach((b, i) => {
      const status = gitStatuses[i];
      if (status !== undefined && gitStatusById[b.id] === undefined) gitStatusById[b.id] = status;
    });
    return { ...s, gitStatusById };
  });
}

/// Clears every tab whose session the daemon does not have.
///
/// Both of the app's liveness checks read the persisted LAYOUT TREE, not
/// the daemon's session list: `liveSessionIds` in the orchestration
/// scheduler, and `findSessionLocation` behind every board check. So a
/// tab id left in a tree by a session that failed to recover -- the
/// daemon marks that record `Exited`, and Attach then sends no status and
/// no exit event for it -- reads as a running agent forever. Its rail step
/// sits `running` with no rule that can correct it, which the daemon's
/// own guard turns into a rail nobody can edit or delete (orchestration
/// spec §2.2). The tab itself renders as a terminal for a session that
/// does not exist.
///
/// Rust reconciles once per app PROCESS (`session::resolve_workspaces`,
/// which replaces a stale id with a fresh session rather than clearing
/// it). This is the same reconciliation on the two occasions that one
/// misses: a frontend that reloads without the host restarting, and a
/// DAEMON restart under a live app -- which is the button the app itself
/// tells people to press.
///
/// `handleSessionExited` rather than `closeSession`: there is no daemon
/// session left to kill, and the exit path is exactly the "this session
/// is gone, take its tab out of wherever it lives" this needs.
export async function reconcileLayoutSessions(): Promise<void> {
  // The tab maps decide which ids in a tree are NOT sessions. Reconciling
  // before they land would clear every file and board tab in the app.
  await tabMapsLoaded;
  // Snapshotted BEFORE the round trip, and the answer is computed against
  // the snapshot: a session created while the read was in flight is in
  // the layout and not in the reply, which is exactly the shape of a
  // stale tab. Judging it against the state the read actually describes
  // is what keeps this from closing a tab the human just opened.
  const before = get(layoutState);
  const baselines = await backend.getSessionBaselines().catch(() => null);
  if (!baselines) return;
  const stale = workspace.staleLayoutTabIds(
    before,
    new Set(baselines.map((b) => b.id)),
    new Set([
      ...Object.keys(before.fileTabsById),
      ...Object.keys(before.boardTabsById),
      ...Object.keys(before.cardTabsById),
    ])
  );
  // handleSessionExited searches the CURRENT trees and is a no-op for an
  // id no longer in one, so a tab closed in the meantime needs no guard.
  for (const id of stale) handleSessionExited(id);
}

export async function bootstrap(): Promise<void> {
  // Ahead of the workspace listeners: the theme should be correct on the
  // first painted frame, and it has no dependency on workspace state.
  await themeState.init();
  // Where a `until` step's check tees its output, from the host rather
  // than assumed: `/tmp` is not a directory on Windows, and the check
  // and the app have to name the same file. Not awaited -- nothing on
  // the first frame reads it, and the first loop step is many seconds
  // away.
  void backend
    .tempDir()
    .then(setTempRoot)
    .catch(() => {});
  // Started before the ready paths that await it, so the maps are already
  // in flight by the time either of them has a payload to apply.
  tabMapsLoaded = loadTabMaps();
  void seedSessionBaselines();
  void seedQueuedInputs();
  // Awaited, and ahead of every ready path: which workspace this window
  // shows depends on which ones it holds, so a payload applied before the
  // map arrived would put the main window's workspace in a workspace
  // window for a frame -- with its terminals, which is exactly the
  // two-windows-one-PTY state the map exists to prevent.
  unlisteners.push(await initWorkspaceWindows());
  unlisteners.push(
    await listen<WorkspacesData>("workspaces-ready", async (event) => {
      // Awaited BEFORE the tree lands in the store: a file or board tab
      // rendered against empty maps is a TerminalPane for a non-session
      // id (see loadTabMaps).
      await tabMapsLoaded;
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(forThisWindow(event.payload));
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
          removedWorkspaces: event.payload.removedWorkspaces ?? [],
        };
      });
      watchRootedWorkspaces(event.payload.workspaces);
      void refreshDaemonCompat();
      void reconcileLayoutSessions();
    })
  );
  // Another window's save of the shared workspaces file. Its own echo is
  // ignored by label: the window that wrote it is already showing what it
  // wrote, and re-adopting would clobber anything it has changed since.
  unlisteners.push(
    await listen<{ origin: string; data: WorkspacesData }>("workspaces-synced", (event) => {
      if (event.payload.origin === currentWindowLabel()) return;
      adoptWorkspaces(event.payload.data);
    })
  );
  unlisteners.push(
    await listen<[string, number]>("session-exited", (event) => {
      // Recorded BEFORE the layout change, so the orchestration tick
      // this triggers already sees the code (tools spec §3.1). The
      // other way round, a tool step would read as "nobody witnessed
      // the outcome" on every single run.
      recordSessionExit(event.payload[0], event.payload[1]);
      handleSessionExited(event.payload[0]);
    })
  );
  unlisteners.push(
    // The connection itself is gone (the relay's read failed, the daemon
    // closed the socket, or bootstrap never got one) -- there is no
    // working app left behind this, so it IS the whole-window overlay.
    await listen<string>("daemon-error", (event) => {
      setError(event.payload);
    })
  );
  unlisteners.push(
    // One request the daemon refused, on a connection that is still up.
    // Deliberately NOT setError: everything else in the app keeps
    // working, so this surfaces as a banner over it (see
    // DaemonRequestErrorBanner) rather than replacing it.
    await listen<string>("daemon-request-error", (event) => {
      daemonRequestError.set(event.payload);
    })
  );
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, string]>("session-status-changed", (event) => {
      handleSessionStatusChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, GitStatus | null]>("git-status-changed", (event) => {
      handleGitStatusChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<string>("session-restored", (event) => {
      handleSessionRestored(event.payload);
    })
  );
  unlisteners.push(
    await listen<string>("session-interrupted", (event) => {
      handleSessionInterrupted(event.payload);
    })
  );
  unlisteners.push(
    await listen<[string, OrphanProcess]>("session-orphaned", (event) => {
      handleSessionOrphaned(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, string]>("session-failed", (event) => {
      handleSessionFailed(event.payload[0], event.payload[1]);
    })
  );
  // Fires for every change to a session's queue, whoever made it: this
  // window adding one, another surface reordering one, and -- the case
  // with no local cause at all -- the daemon delivering the head because
  // the session went idle. The last is why the strip cannot simply trust
  // the reply to its own writes.
  unlisteners.push(
    await listen<[string, QueuedInput[]]>("queued-inputs-changed", (event) => {
      handleQueuedInputsChanged(event.payload[0], event.payload[1]);
    })
  );
  // An agent naming its own tab (gavin_name_session). Straight into
  // setSessionName: an agent rename and a human rename are the same
  // rename, and must persist the same way.
  unlisteners.push(
    await listen<[string, string]>("session-named", (event) => {
      void setSessionName(event.payload[0], event.payload[1]);
    })
  );
  // Registered before any watchGavinRoot can fire (the two ready paths
  // below) -- gavin-tree-changed pushes with no listener would be lost,
  // not buffered.
  unlisteners.push(await initGavinListeners());
  // Rides the tree store rather than the raw event so it sees every
  // update, pushes and on-demand refreshes alike. The first call carries
  // no previous tree, so nothing is ever "repaired" on startup.
  const previousTrees: Record<string, GavinTree> = {};
  unlisteners.push(
    gavinTrees.subscribe((trees) => {
      for (const [workspaceId, tree] of Object.entries(trees)) {
        const previous = previousTrees[workspaceId];
        previousTrees[workspaceId] = tree;
        if (previous !== undefined && previous !== tree) {
          repairBoardTabs(workspaceId, previous, tree);
        }
      }
    })
  );
  // Imported dynamically on purpose: orchestrationState imports THIS
  // module (for resolvedAgentFor and createSessionOnPage), so a static
  // import here would close a cycle. By the time bootstrap runs, this
  // module is fully evaluated and the load is safe.
  const { initOrchestrationListeners } = await import("$lib/orchestrationState");
  unlisteners.push(await initOrchestrationListeners());
  // Same dynamic-import reason as above: agentPauseState reads
  // resolvedAgentFor from this module. Started here rather than from a
  // component, because a pause whose clock only advances while one tab is
  // mounted is the bug that made rails tick only on their own tab.
  const { startPauseClock } = await import("$lib/agentPauseState");
  unlisteners.push(startPauseClock());
  // The memory probe, on the same terms and for a sharper version of the
  // same reason: the launch gate reads its sample at the moment somebody
  // presses Run, with no panel open and possibly in a window showing a
  // different workspace -- and a queue whose poll has stalled is work
  // that silently never starts. Dynamically imported for the cycle
  // reason above (memoryState reads resolvedAgentFor from this module).
  const { startMemoryPoll } = await import("$lib/memoryState");
  unlisteners.push(startMemoryPoll());
  // ...and the queue that drains behind the gate the probe feeds. After
  // the poller, so its first drain reads a sample rather than a null,
  // and module-level for the same reason both of those are.
  const { startLaunchQueue } = await import("$lib/launchQueue");
  unlisteners.push(startLaunchQueue());
  // ...and the one thing the wall may END: an idle agent of a done card,
  // while memory is short. After the queue, because its closes are what
  // make room for that queue's drain, and module-level for the sharpest
  // reason of all -- the day it matters is the day the human is on
  // another workspace and the machine is swapping. Dynamically imported
  // for the cycle reason above (it closes through this module).
  const { startDoneSessionReclaim } = await import("$lib/doneSessionReclaimState");
  unlisteners.push(startDoneSessionReclaim());
  // And the same again for the develop records: a "Develop into a plan…"
  // run that finishes while the human is on another tab still has to give
  // the card back, and this watch's first pass is also what ADOPTS a run
  // that outlived the last window -- the records load with the
  // workspaces. Dynamically imported for the cycle reason above.
  const { startDevelopingCardsWatch } = await import("$lib/developingCardsState");
  unlisteners.push(startDevelopingCardsWatch());
  // And once more for the Tools tab's two watchers. The daemon closes a
  // shell tool's run by itself and pushes nothing, and an agent tool's
  // run is closed by watching its session go quiet -- neither can be
  // owned by the tab, because a tool finishing while the human is
  // looking at its terminal is the ordinary case, not the exception.
  // Dynamically imported for the cycle reason above.
  const { initWorkspaceToolListeners } = await import("$lib/workspaceToolsActions");
  unlisteners.push(initWorkspaceToolListeners());
  // The single quiet update check, started here for the same reason as
  // the others: it belongs to the app rather than to whichever tab is
  // mounted, and an update that only announced itself to somebody
  // already looking at Settings would be announcing itself to the one
  // person who did not need telling. It holds no timer -- one check per
  // bootstrap, and everything else is the button in Settings.
  const { startUpdateWatch } = await import("$lib/updatesState");
  unlisteners.push(startUpdateWatch());
  unlisteners.push(
    await listen<[string, string, string, string]>("agent-session-spawned", (event) => {
      handleAgentSessionSpawned(event.payload[0], event.payload[1]);
    })
  );

  backend.setOnWriteInputHook((sessionId) => clearRestoredMarker(sessionId));

  // Session names are only ever WRITTEN from this side (a human rename,
  // or an agent's gavin_name_session arriving on "session-named" above,
  // which lands in the same setSessionName), so the stored map cannot
  // drift behind our back -- a one-shot fetch at startup is sufficient,
  // unlike cwd. Best-effort: a failure here just means renamed tabs show
  // their fallback label until the next successful rename, not a reason
  // to block startup.
  void backend
    .getSessionNames()
    .then((sessionNames) => {
      layoutState.update((s) => ({ ...s, sessionNames }));
    })
    .catch(() => {});

  // The agent profile table: static Rust data, so one fetch is enough.
  // Best-effort like the rest -- resolveAgentConfig falls back to
  // claude-code's defaults if this never arrives.
  //
  // Published TWICE on purpose. The table lands first because every
  // panel needs a command and a flag immediately, and the catalogue
  // behind it can cost a subprocess; the second set folds the discovered
  // names into the same rows. Waiting for both would put the whole agent
  // config behind a CLI that may not answer for fifteen seconds, which
  // is far worse than a picker that grows.
  //
  // What a panel mounted in between sees, and why it is the harmless
  // order: a stored model the first table does not list reads as a
  // Custom one and draws the text box, then becomes a selected row when
  // the catalogue lands. Wrong-then-right, never right-then-wrong -- and
  // a catalogue that never answers leaves the first set standing, which
  // is exactly the picker gavin had before this existed.
  void backend
    .agentProfiles()
    .then((profiles) => {
      agentProfilesStore.set(profiles);
      return backend
        .agentModelCatalog()
        .then((catalog) => agentProfilesStore.set(mergeDiscoveredModels(profiles, catalog)))
        .catch(() => {});
    })
    .catch(() => {});

  void backend
    .mcpFormats()
    .then((formats) => mcpFormatsStore.set(formats))
    .catch(() => {});

  void backend
    .getAgentModelDefaults()
    .then((models) => agentModelDefaultsStore.set(models))
    .catch(() => {});

  // Normalized on the way in, not just on the way out: config.json is a
  // file a user can edit, and a size xterm cannot render must read as "no
  // setting" rather than reaching a Terminal.
  void backend
    .getTerminalFontSize()
    .then((size) => terminalFontSizeDefault.set(normalizeTerminalFontSize(size)))
    .catch(() => {});

  // Normalized on the way in for the same reason: config.json is a file a
  // user can edit, and anything that is not a boolean has to read as "no
  // setting" so a workspace still falls through to gavin's default.
  void backend
    .getAutoCommit()
    .then((enabled) => autoCommitDefault.set(normalizeAutoCommit(enabled)))
    .catch(() => {});

  // Normalized on the way in for the same reason: config.json is a file a
  // user can edit, and anything that is not a boolean has to read as "no
  // setting" so a workspace still falls through to gavin's default
  // (require review).
  void backend
    .getRequireReview()
    .then((enabled) => requireReviewDefault.set(normalizeRequireReview(enabled)))
    .catch(() => {});

  // Normalized on the way in for the same reason, and it matters more
  // here: this one decides what a fresh `.gitignore` says, and a garbled
  // value must read as "nobody chose" rather than as "do not track".
  void backend
    .getGitTrackingDefault()
    .then((tracked) => gitTrackingDefault.set(normalizeGitTracking(tracked)))
    .catch(() => {});

  // Best-effort like the rest: an empty table reads as "no level names
  // an agent", which is exactly how every card behaved before the
  // complexity field existed, so a failed fetch degrades to the old
  // behaviour rather than to a wrong agent.
  void backend
    .getAgentDefaults()
    .then((defaults) => agentDefaultsStore.set({ ...EMPTY_AGENT_DEFAULTS, ...defaults }))
    .catch(() => {});

  void pollForStartupState();
}

export function teardown(): void {
  unlisteners.forEach((unlisten) => unlisten());
  unlisteners.length = 0;
}

// The connection-error overlay's recovery action: restart the daemon and
// try the whole startup again. Puts the store back into "connecting"
// first -- both ready paths (the workspaces-ready listener and
// pollForStartupState below) ignore payloads unless the status is
// "connecting", so without this the retry would succeed invisibly.
export async function retryConnect(): Promise<void> {
  // Asks first, like the other three routes to a restart. Both branches
  // of the Rust command run `pkill -x gavin-daemon`, and that daemon is
  // shared with every other gavin window -- so even from an error
  // overlay this is somebody else's sessions, and the host now requires
  // the grant a prompt mints (AS-05/R5).
  const token = await confirmDestructive("restart_daemon", [DAEMON_SUBJECT], {
    title: "Restart gavin-daemon?",
    lines: restartConfirmLines(get(daemonCompat)),
    confirmLabel: "Restart daemon",
    danger: true,
  });
  if (token === null) return;
  layoutState.update((s) => ({ ...s, status: "connecting", errorMessage: "" }));
  try {
    await backend.restartDaemon(token);
  } catch (e) {
    setError(String(e));
    return;
  }
  void pollForStartupState();
}

// The Settings button, as opposed to retryConnect's error-overlay one:
// the app here is healthy and stays up, so this neither touches `status`
// nor re-runs startup. The Rust side rewires the live connections in
// place and re-arms the gavin root watches, so all that is left is to
// refresh what a fresh daemon can no longer be asked about mid-flight.
//
// Throws on failure so the caller can render it beside the button --
// silently swallowing it would leave the human with a dead daemon and no
// sign of it.
export async function restartDaemonInPlace(token: string): Promise<DaemonCompat | null> {
  await backend.restartDaemon(token);
  // The workspaces payload is re-derived by the daemon on reconnect
  // (recover() spawns a fresh BARE SHELL per surviving record -- never
  // the command it carried, which for an agent is the whole task), so
  // pull the authoritative copy rather than trusting the pre-restart one.
  const data = await backend.getWorkspacesState();
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  // The daemon just came back, and a record it could not recover is now
  // an id in a tree with no session behind it -- no status, no exit
  // event, nothing that would ever correct it. Rust's own reconciliation
  // runs at bootstrap only, and this path deliberately does not re-run
  // startup.
  await reconcileLayoutSessions();
  // A restart can hand the app a differently-versioned daemon than the
  // one it started with (session::reconnect's own doc comment) -- refresh
  // the stored verdict so the banner/gating never keep serving a stale one.
  //
  // Awaited, not fire-and-forget: the verdict is the only evidence a
  // caller has of what the restart actually achieved, and the honest
  // "restarted, and nothing moved" message depends on having it in hand
  // before the button leaves its Restarting… state.
  return await refreshDaemonCompat();
}

async function pollForStartupState(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (get(layoutState).status !== "connecting") return;
    const [data, bootstrapError] = await Promise.all([
      backend.getWorkspacesState().catch(() => null),
      backend.getBootstrapError().catch(() => null),
    ]);
    if (bootstrapError) {
      setError(bootstrapError);
      return;
    }
    // `data` is `null` only when the invoke itself rejected (WorkspacesState
    // isn't managed yet -- bootstrap still running). An empty
    // `{workspaces: [], activeWorkspaceId: null}` is a real, resolved
    // object -- and therefore truthy -- so checking `data` itself (not a
    // field on it, like `data.workspaces.length`) is what correctly treats
    // "no workspaces yet" as ready rather than as still-connecting. See
    // get_workspaces_state's own doc comment on the Rust side for the same
    // rule stated from that side of the boundary.
    if (data) {
      // Same rule as the workspaces-ready listener: the tab maps must be
      // in the store before a tree that references them renders.
      await tabMapsLoaded;
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(forThisWindow(data));
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
          removedWorkspaces: data.removedWorkspaces ?? [],
        };
      });
      watchRootedWorkspaces(data.workspaces);
      void refreshDaemonCompat();
      void reconcileLayoutSessions();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
}

/// Restores a removed workspace's daemon rows onto an empty workspace by
/// giving it the removed one's id back.
///
/// Order is the whole point. The re-key happens BEFORE anything binds to
/// the id the workspace is being given up: the watch under the new id is
/// torn down first, the store and config.json are written next, and only
/// then is the restored id watched and its rows fetched. Doing it the
/// other way round leaves a watch pushing trees for an id no workspace
/// holds, and fetches a board under the id that is about to disappear.
async function restoreRemovedWorkspace(
  state: LayoutState,
  workspaceId: string,
  tombstone: RemovedWorkspace,
  rootPath: string
): Promise<void> {
  // reclaimable() insists the workspace is empty, so nothing is bound to
  // this id -- except, possibly, a watch from an earlier root pick.
  await backend.unwatchGavinRoot(workspaceId).catch(() => {});
  // The workspace keeps its window across the re-key, but the registry is
  // keyed by id: without this the old id points at a workspace that no
  // longer exists and the new one reads as the main window's.
  if (!isMainWindow()) await backend.claimWorkspaceWindow(tombstone.id).catch(() => {});

  const data = workspace.restoreWorkspaceId(state, workspaceId, tombstone.id, rootPath);
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    removedWorkspaces: data.removedWorkspaces ?? [],
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);

  void backend.watchGavinRoot(tombstone.id, rootPath).catch(() => {});

  // Dynamically imported for the reason the bootstrap listener states:
  // orchestrationState imports THIS module, so a static import would
  // close a cycle. The other two ride along rather than being imported
  // twice over.
  const [{ fetchBoard }, { fetchOrchestration }, { fetchTools }] = await Promise.all([
    import("$lib/kanbanState"),
    import("$lib/orchestrationState"),
    import("$lib/toolsState"),
  ]);
  // These are the rows the tombstone existed to reach: the board with
  // its columns and labels, the rails, and the workspace's own tools.
  await Promise.all([
    fetchBoard(tombstone.id),
    fetchOrchestration(tombstone.id),
    fetchTools(tombstone.id),
  ]);
}

// Binds (or re-binds) a workspace to a root directory: persists the new
// rootPath, tears down the old watch when the root actually changed, and
// starts the new one. Init (scaffolding) happens BEFORE this is called --
// see WorkspaceRootControl -- so the first push already sees the skeleton.
//
// A folder that a removed workspace used to be bound to offers a reclaim
// first: its board, rails and tools are still in the daemon under an id
// nothing else can name, and binding a fresh workspace here is the only
// moment that record can be spent. Both answers consume the tombstone --
// Restore because the bridge has been crossed, Start fresh because the
// user has said no and the prompt must not return on the next pick.
export async function setWorkspaceRoot(workspaceId: string, rootPath: string): Promise<void> {
  const state = get(layoutState);
  const tombstone = workspace.reclaimable(state, workspaceId, rootPath);
  if (tombstone) {
    const restore = await askConfirm({
      title: `Restore the saved workspace "${tombstone.name}"?`,
      lines: [
        "gavin still has its board, rails and tools from before this folder was removed.",
        "Start fresh forgets them for good — this is the only moment that record can be spent.",
      ],
      confirmLabel: "Restore",
      // Neither answer is a cancel: both consume the tombstone, so the
      // dismissing button has to say what dismissing does.
      cancelLabel: "Start fresh",
    });
    if (restore) {
      await restoreRemovedWorkspace(state, workspaceId, tombstone, rootPath);
      return;
    }
    const dropped = workspace.forgetTombstone(state, tombstone.id);
    layoutState.update((s) => ({ ...s, removedWorkspaces: dropped.removedWorkspaces ?? [] }));
  }
  const previous = state.workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, rootPath } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
  if (previous && previous !== rootPath) {
    await backend.unwatchGavinRoot(workspaceId).catch(() => {});
  }
  void backend.watchGavinRoot(workspaceId, rootPath).catch(() => {});
}

/// The Rust profile table, fetched once at bootstrap. Empty until then;
/// resolveAgentConfig degrades to its own claude-code fallbacks in that
/// window, so an early call is safe rather than wrong.
export const agentProfilesStore = writable<AgentProfileInfo[]>([]);

/// The MCP dialects a `custom` profile can be pointed at. Fetched with
/// the profile table and, like it, empty until then.
export const mcpFormatsStore = writable<McpFormatInfo[]>([]);

/// App-wide default model per profile id, from config.json. Empty until
/// bootstrap fetches it; resolveAgentConfig reads a missing entry as "no
/// model", so an early call is safe rather than wrong -- the same
/// posture agentProfilesStore takes above.
export const agentModelDefaultsStore = writable<Record<string, string>>({});

/// The app-wide custom agent and complexity table, from config.json.
/// Empty until bootstrap fetches it, and empty is a safe rather than a
/// wrong answer: no level names an agent, so every card runs the
/// workspace's own -- which is what every card did before this existed.
///
/// Re-fetched on every bootstrap like the model defaults, so it is
/// deliberately not parked across an HMR remount.
export const agentDefaultsStore = writable<AgentDefaults>(EMPTY_AGENT_DEFAULTS);

/// The app-wide terminal font size from config.json, or null when the user
/// has never set one. Null rather than the default so the global panel can
/// tell "chose 13" from "never chose", and so a workspace with no size of
/// its own still falls all the way through to gavin's default.
///
/// Like agentProfilesStore this is a Rust lookup re-fetched on every
/// bootstrap, so it is deliberately not parked across an HMR remount.
export const terminalFontSizeDefault = writable<number | null>(null);

/// The size terminals render at right now: the active workspace's own
/// choice, else the app-wide one, else gavin's default. A derived store
/// rather than a lookup at each pane so that changing either setting moves
/// every open terminal in the same tick -- and so the two settings panels
/// and the panes can never disagree about which one wins.
///
/// Keyed on the ACTIVE workspace because that is the only one with panes on
/// screen: a terminal belonging to a workspace that is not showing keeps
/// its old size in the registry until its pane mounts again, which is
/// exactly when it is asked for a new one.
export const terminalFontSize = derived(
  [layoutState, terminalFontSizeDefault],
  ([$layout, $default]) =>
    resolveTerminalFontSize(
      workspace.getActiveWorkspace($layout)?.terminalFontSize,
      $default
    )
);

/// The app-wide auto-commit default from config.json, or null when the
/// user has never set one. Null rather than false so the global panel can
/// tell "chose off" from "never chose", and so a workspace with no setting
/// of its own still falls all the way through to gavin's default.
///
/// Re-fetched on every bootstrap like terminalFontSizeDefault, so it is
/// deliberately not parked across an HMR remount.
export const autoCommitDefault = writable<boolean | null>(null);

/// Whether a card filed in the ACTIVE workspace starts with the
/// auto-commit block: that workspace's own choice, else the app-wide one,
/// else gavin's default. Derived rather than looked up at the composer so
/// that changing either setting moves the next card in the same tick, and
/// so the two settings panels and the composer can never disagree about
/// which one wins.
/// The app-wide git-tracking default from config.json, or null when the
/// user has never set one -- the same three-state as autoCommitDefault
/// above, and for the same reason.
///
/// There is deliberately no per-workspace companion. A workspace that
/// exists keeps its answer in its own repo's `.gitignore`, which the
/// Settings panel reads through the backend on demand; a store here would
/// be a copy of a file the human can edit behind the app's back.
export const gitTrackingDefault = writable<boolean | null>(null);

/// The app-wide require-review default from config.json, or null when the
/// user has never set one -- the same three-state as `autoCommitDefault`
/// above, and for the same reason: a workspace with no setting of its own
/// falls all the way through to gavin's default (require it).
///
/// Re-fetched on every bootstrap like `autoCommitDefault`, so it is
/// deliberately not parked across an HMR remount.
export const requireReviewDefault = writable<boolean | null>(null);

export const newCardAutoCommit = derived(
  [layoutState, autoCommitDefault],
  ([$layout, $default]) =>
    resolveAutoCommit(workspace.getActiveWorkspace($layout)?.autoCommit, $default)
);
/// Tells the daemon what THIS agent prints when it has stopped because
/// something broke, so a quiet agent that BROKE stops reading as one
/// that finished. Called once per agent session gavin launches, right
/// after it is created.
///
/// Best-effort and silent on failure, like the provisional tab rename
/// every launcher does beside it: the agent is already running, and a
/// daemon too old to take the patterns simply keeps the pre-v21
/// behaviour. A profile with no verified patterns sends nothing, which
/// the daemon reads as "no failure detection for this session" -- never
/// as "nothing failed".
///
/// Agent sessions only. A `command` tool step is a shell whose verdict is
/// its exit code (tools spec T5), and arming it would let a build log
/// that happens to print an agent's error text stall a rail.
export async function armFailureDetection(
  sessionId: string,
  patterns: string[]
): Promise<void> {
  if (patterns.length === 0) return;
  try {
    await backend.setFailurePatterns(sessionId, patterns);
  } catch {
    // A daemon older than v21 refuses the request; a quiet agent then
    // reads as idle exactly as it did before any of this existed.
  }
}

/// A conversation id for a run about to be launched, or null.
///
/// Two gates, and both have to pass. The PROFILE has to have a verified
/// `--session-id` argv (`mintConversationId`), and the DAEMON has to be
/// new enough to persist the id on the run record. A v20 daemon parses
/// the widened SetStepRun / LinkCardSession fine and drops both fields,
/// so an id minted against one would ride in the agent's argv and then
/// vanish -- leaving a conversation nobody can name and a Resume button
/// promising to reopen it.
///
/// So: no daemon, no id. The launch is exactly the pre-v21 launch, and
/// Resume falls back to the written reconstruction, which still works.
export function conversationIdForLaunch(agent: { sessionIdArgs: string }): string | null {
  if (featureBlockedReason(get(daemonCompat), "conversationResume")) return null;
  return mintConversationId(agent.sessionIdArgs);
}

/// The commit a run about to be launched in `cwd` will be diffed
/// against, or null.
///
/// Two gates, like `conversationIdForLaunch` above, and the daemon one
/// comes first: a v25 daemon parses the widened `LinkCardSession` fine
/// and drops the sha, so resolving one would cost a git call and then
/// leave a Changes button diffing against nothing. The second gate is
/// git's own answer -- a launch directory in no repository, or a
/// repository with no commit yet, has no baseline, and that is a fact
/// about the checkout rather than a failure.
///
/// Resolved at LAUNCH because it cannot be resolved later: an agent's
/// first minutes move HEAD and dirty the tree, and nothing afterwards
/// can say where it began. Never throws -- a run must not fail to start
/// because git was slow to answer a question about its history.
export async function baseShaForLaunch(cwd: string): Promise<string | null> {
  if (featureBlockedReason(get(daemonCompat), "runChanges")) return null;
  try {
    return await backend.gitHeadSha(cwd);
  } catch {
    return null;
  }
}

/// The app-wide custom agent, in the shape `resolveAgentConfig` takes.
/// One spelling so a launcher, a settings panel and a derived store
/// cannot each unpack the struct slightly differently.
function customAgentDefault(defaults: AgentDefaults) {
  return { command: defaults.customCommand, modelFlag: defaults.customModelFlag };
}

/// Where a workspace stands on the three config.toml keys that name
/// something gavin executes -- see `workspaceTrust.ts` for what they are
/// and why they are gated.
export interface ConfigTrust {
  /// The keys as they stand on disk right now.
  keys: ExecutionKeys;
  /// Their digest, "" when there is nothing to approve.
  hash: string;
  /// Whether the human has approved exactly these values. TRUE for a
  /// config that names none of them -- there is nothing to say yes to.
  trusted: boolean;
  /// Whether there is a decision outstanding: keys are present and
  /// unapproved. What the notices key off, so a workspace with nothing
  /// to approve never shows one.
  needsApproval: boolean;
}

/// Assembled from three sources because the keys live in two files: the
/// `[agent]` block rides on the daemon's tree, `[worktree] setup` is read
/// from config.toml beside it, and the marker is in config.json.
///
/// An absent setup entry means "not read yet", which hashes differently
/// from the approved value and so reads as unapproved -- the right answer
/// for the moments before the first read lands, since the alternative is
/// a window in which a cloned repo's command launches.
function trustFrom(
  tree: GavinTree | undefined,
  setup: string[] | undefined,
  workspace: Workspace | undefined
): ConfigTrust {
  const keys = executionKeys(
    tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
    setup ?? []
  );
  const trusted = configTrusted(keys, workspace?.trustedConfigHash);
  return {
    keys,
    hash: executionKeysHash(keys),
    trusted,
    needsApproval: hasExecutionKeys(keys) && !trusted,
  };
}

/// One workspace's trust state, once, for an action.
export function configTrustFor(workspaceId: string): ConfigTrust {
  return trustFrom(
    get(gavinTrees)[workspaceId],
    get(worktreeSetups)[workspaceId],
    get(layoutState).workspaces.find((w) => w.id === workspaceId)
  );
}

/// The same answer reactively: `$configTrusts(workspaceId)`. A component
/// that read the one-shot helper would keep whatever was true at mount --
/// and at mount the setup read has usually not landed, so it would sit on
/// "not approved" for the life of the view.
export const configTrusts = derived(
  [gavinTrees, worktreeSetups, layoutState],
  ([$trees, $setups, $layout]) =>
    (workspaceId: string): ConfigTrust =>
      trustFrom($trees[workspaceId], $setups[workspaceId], $layout.workspaces.find((w) => w.id === workspaceId))
);

/// The workspace's `[agent]` block as anything that LAUNCHES may read it:
/// the two execution keys blanked when the config is not approved.
///
/// Every path to an agent goes through this rather than reading the tree
/// directly, so a launch route added later cannot forget to ask. That is
/// also why it is not a parameter on `resolveAgentConfig`: a defaulted
/// one fails open, and a required one is a boolean thirteen call sites
/// have to get right.
export function trustedAgentConfigFor(workspaceId: string): AgentConfig | null {
  const raw = get(gavinTrees)[workspaceId]?.contexts.find((c) => c.kind === "root")?.agent ?? null;
  return trustedAgentConfig(raw, configTrustFor(workspaceId).trusted);
}

/// The reactive spelling: `$trustedAgentConfigs(workspaceId)`.
export const trustedAgentConfigs = derived(
  [gavinTrees, configTrusts],
  ([$trees, $trust]) =>
    (workspaceId: string): AgentConfig | null =>
      trustedAgentConfig(
        $trees[workspaceId]?.contexts.find((c) => c.kind === "root")?.agent ?? null,
        $trust(workspaceId).trusted
      )
);

/// Records that the human approved exactly the values config.toml holds
/// right now. Called from the approval sheet, which showed them.
///
/// Stamps the CURRENT digest rather than a remembered one: between the
/// sheet opening and the button being pressed the file may have changed
/// underneath, and approving a value nobody was shown is the one thing
/// this gate exists to prevent. A config with nothing to approve stores
/// nothing.
export async function approveWorkspaceConfig(workspaceId: string): Promise<void> {
  const trust = configTrustFor(workspaceId);
  if (!hasExecutionKeys(trust.keys)) return;
  await stampConfigTrust(workspaceId, trust.hash);
}

/// Withdraws approval, putting the keys back to inert. The undo for a
/// human who approved and thought better of it.
export async function revokeWorkspaceConfig(workspaceId: string): Promise<void> {
  await stampConfigTrust(workspaceId, undefined);
}

async function stampConfigTrust(workspaceId: string, hash: string | undefined): Promise<void> {
  const state = get(layoutState);
  const current = state.workspaces.find((w) => w.id === workspaceId);
  if (!current || current.trustedConfigHash === hash) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, trustedConfigHash: hash } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Whether this human has already read exactly this card's content
/// (`cardReview.ts`). False for a card nobody has reviewed, for one whose
/// body or attachments have changed since, and for a workspace that does
/// not exist — every uncertain case fails closed, because the failure is
/// a question rather than a refusal.
///
/// True unconditionally when this workspace's resolved `requireReview`
/// setting is off: the whole gate — every launch's `ensureCardReviewed`,
/// the unattended auto-resume refusal, and the rail step's stall — reads
/// through this one function, so turning the setting off here is what
/// turns it off everywhere at once.
export function cardReviewed(workspaceId: string, path: string, content: CardContent): boolean {
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!resolveRequireReview(workspace?.requireReview, get(requireReviewDefault))) return true;
  return cardContentReviewed(content, workspace?.reviewedCards?.[path]);
}

/// Records that the human has read exactly this content for this card.
///
/// Called from the review sheet, which showed it — and from gavin's own
/// writers (the ⌘N composer, the card editor's save) in the same breath
/// as the write, so a card the human authored never asks them to review
/// their own typing. That is `stampConfigTrust`'s rule one level down,
/// and it is what makes the gate about PROVENANCE rather than about
/// having clicked recently.
///
/// The digest is taken from the content handed in rather than re-read
/// from disk: the caller showed (or wrote) those exact bytes, and
/// stamping a value nobody was shown is the one thing this gate exists to
/// prevent.
export async function stampCardReview(
  workspaceId: string,
  path: string,
  content: CardContent
): Promise<void> {
  const digest = cardContentDigest(content);
  const state = get(layoutState);
  const current = state.workspaces.find((w) => w.id === workspaceId);
  if (!current || current.reviewedCards?.[path] === digest) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, reviewedCards: { ...(w.reviewedCards ?? {}), [path]: digest } } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Records the human's answer to a distinct set of foreign MCP servers
/// (AG-07, `mcpServerTrust.ts`), so `setupAgentIntegration` can be
/// re-run with it and the question is asked once per set rather than on
/// every "Set up / update" click. Same shape as `stampConfigTrust` one
/// function up, for the sibling gate.
export async function recordMcpForeignChoice(workspaceId: string, choice: McpForeignChoice): Promise<void> {
  const state = get(layoutState);
  const current = state.workspaces.find((w) => w.id === workspaceId);
  if (!current) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mcpForeignServersChoice: choice } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}


/// The workspace's resolved agent settings, from config.toml's [agent]
/// block on the root context plus the profile table.
export function resolvedAgentFor(workspaceId: string) {
  return resolveAgentConfig(
    trustedAgentConfigFor(workspaceId),
    get(agentProfilesStore),
    get(agentModelDefaultsStore),
    customAgentDefault(get(agentDefaultsStore))
  );
}

/// This workspace's own complexity overrides, defaulted to empty. Empty
/// means "inherit every level", which is what a workspace that has never
/// opened the table looks like.
export function workspaceComplexityTable(workspaceId: string): ComplexityTable {
  const state = get(layoutState);
  return state.workspaces.find((w) => w.id === workspaceId)?.complexityAgents ?? {};
}

/// The agent that should execute THIS card: the workspace's own, unless
/// the card names another one -- either outright, in its own
/// `agent:`/`model:` lines, or through the `complexity:` level the
/// tables attribute to a different agent. `cardAgentEntry` owns which
/// of the two wins.
///
/// Through `resolveAgentConfig` for the same reason `candidateAgentFor`
/// is: an attributed run is not a special kind of launch. It needs the
/// same fallbacks, the same `promptArgs` refusal, the same failure
/// patterns and the same conversation argv as any other, and a second
/// resolution path here is how those quietly stop matching.
///
/// A card that names nothing, and whose level no table attributes,
/// resolves to EXACTLY `resolvedAgentFor` -- so every launch route can
/// call this unconditionally and behave as it did before either field
/// existed.
export function agentForCard(
  workspaceId: string,
  card: CardAgentFields | null | undefined
) {
  const entry = cardAgentEntry(
    card,
    get(agentDefaultsStore).complexity,
    workspaceComplexityTable(workspaceId)
  );
  if (!entry) return resolvedAgentFor(workspaceId);
  return resolveAgentConfig(
    agentConfigWithAttribution(workspaceAgentConfig(workspaceId), entry),
    get(agentProfilesStore),
    get(agentModelDefaultsStore),
    customAgentDefault(get(agentDefaultsStore))
  );
}

/// The workspace's own `[agent]` block, unresolved. What a per-run
/// override is laid over (`candidateAgentConfig`), and the one thing
/// `resolvedAgentFor` cannot hand back: resolution has already folded
/// the profile table's defaults in by then, so a resolved agent read as
/// a config would pin every inherited value as if the workspace had
/// chosen it.
export function workspaceAgentConfig(workspaceId: string) {
  return trustedAgentConfigFor(workspaceId);
}

/// One best-of-N candidate's agent: the workspace's own settings with
/// this candidate's profile and model laid over them, resolved by the
/// same rules as every other agent in the app.
///
/// Through `resolveAgentConfig` deliberately. A candidate is not a
/// special kind of launch -- it needs the same fallbacks, the same
/// `promptArgs` refusal, the same failure patterns and the same
/// conversation argv as a board Run, and a second resolution path here
/// is how those four quietly stop matching.
export function candidateAgentFor(workspaceId: string, candidate: Candidate) {
  return resolveAgentConfig(
    candidateAgentConfig(workspaceAgentConfig(workspaceId), candidate),
    get(agentProfilesStore),
    get(agentModelDefaultsStore),
    customAgentDefault(get(agentDefaultsStore))
  );
}

/// The same answer, reactively: `$resolvedAgents(workspaceId)`.
///
/// `resolvedAgentFor` above is three `get()`s, which is right for an
/// action -- it runs once, at the moment of the click -- and wrong for a
/// component, which would keep whatever the table said at mount. The
/// table is fetched asynchronously at bootstrap, so at mount it is
/// usually still empty: a control derived from the one-shot helper shows
/// claude-code's answer for the whole session, whatever the workspace
/// actually chose.
///
/// A store OF a function rather than one store per workspace, because
/// the workspace id is a prop the component already has and the three
/// inputs are app-wide.
export const resolvedAgents = derived(
  [trustedAgentConfigs, agentProfilesStore, agentModelDefaultsStore, agentDefaultsStore],
  ([$configs, $profiles, $models, $defaults]) =>
    (workspaceId: string) =>
      resolveAgentConfig($configs(workspaceId), $profiles, $models, customAgentDefault($defaults))
);

/// The same answer for a CARD, reactively: `$cardAgents(workspaceId,
/// card)`.
///
/// `agentForCard` above is four `get()`s, which is right for an action
/// -- it runs once, at the moment of the click -- and wrong for a
/// component, which would keep whatever the profile table said at
/// mount. The table is fetched asynchronously at bootstrap, so a card
/// modal derived from the one-shot helper would show claude-code's
/// model flag for a card the human pointed at codex, and would go on
/// showing it for the life of the modal.
export const cardAgents = derived(
  [trustedAgentConfigs, layoutState, agentProfilesStore, agentModelDefaultsStore, agentDefaultsStore],
  ([$configs, $layout, $profiles, $models, $defaults]) =>
    (workspaceId: string, card: CardAgentFields | null | undefined) => {
      const base = $configs(workspaceId);
      const entry = cardAgentEntry(
        card,
        $defaults.complexity,
        $layout.workspaces.find((w) => w.id === workspaceId)?.complexityAgents ?? {}
      );
      return resolveAgentConfig(
        agentConfigWithAttribution(base, entry),
        $profiles,
        $models,
        customAgentDefault($defaults)
      );
    }
);

// Starts the workspace's main agent: a normal daemon session at the
// workspace root, remembered on the workspace rather than placed in a
// page tree (D12). Never called automatically.
export async function startMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  const agent = resolvedAgentFor(workspaceId);
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, agent.launchCommand);
  } catch (e) {
    setError(String(e));
    return;
  }
  void armFailureDetection(sessionId, agent.failurePatterns);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Starts the main agent already working on something (the wizard's
/// agent-driven steps, W5). Same rules as startMainAgent -- needs a root,
/// refuses when one is already running -- so the session it records is
/// the same one the Home panel shows and bootstrap reattaches.
/// The workspace whose setup wizard is open, or null. A store rather
/// than a prop because two surfaces open it: the creation modal and the
/// Home tab's resume card.
export const wizardWorkspaceId = hotState<Writable<string | null>>(
  "wizardWorkspaceId",
  () => writable(null),
  hotBag
);

export function openWizard(workspaceId: string): void {
  wizardWorkspaceId.set(workspaceId);
}

export function closeWizard(): void {
  wizardWorkspaceId.set(null);
}

export async function startMainAgentWithPrompt(
  workspaceId: string,
  prompt: string
): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  const agent = resolvedAgentFor(workspaceId);
  const command = buildRunCommand(agent.launchCommand, agent.promptArgs, prompt);
  // The wizard gates this button on agentFlowAvailable, so reaching here
  // means the profile changed under an open wizard. Say why rather than
  // launching `cursor '<a whole prompt>'`, which opens a file picker on
  // a path nobody named.
  if (command === null) {
    setError(noPromptReason(agent.label));
    return;
  }
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, command);
  } catch (e) {
    setError(String(e));
    return;
  }
  void armFailureDetection(sessionId, agent.failurePatterns);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function stopMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.mainSessionId) return;
  try {
    await backend.killSession(ws.mainSessionId);
  } catch (e) {
    // A session already gone is not a reason to keep a dead id on screen.
    setError(String(e));
  }
  clearMainSession(workspaceId);
}

/// Agent settings live in config.toml (D35/D41), so this goes through the
/// daemon rather than persistWorkspaces. The value comes back on the next
/// watcher push -- no optimistic local copy to fall out of sync.
export async function setAgentField(
  workspaceId: string,
  key: "profile" | "file" | "command" | "mcp_file" | "mcp_format" | "model" | "model_flag",
  value: string
): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  try {
    await backend.setRootConfigField(ws.rootPath, key, value);
  } catch (e) {
    setError(String(e));
    return;
  }
  // Two of the seven keys are the ones workspace trust gates, so writing
  // one through gavin's own Settings panel or setup wizard would
  // otherwise revoke the human's trust the instant they exercised it --
  // they would type a command, save, and be asked to approve what they
  // had just typed. The write IS the approval, so it carries the new
  // marker.
  //
  // Computed from the value just written laid over the keys as they
  // stand, not from the tree: the watcher push that carries the new value
  // is still ~170ms away, and hashing the OLD command here would approve
  // something nobody asked for.
  if (key === "command" || key === "file") {
    const trust = configTrustFor(workspaceId);
    const keys = { ...trust.keys, [key]: value.trim() };
    await stampConfigTrust(
      workspaceId,
      hasExecutionKeys(keys) ? executionKeysHash(keys) : undefined
    );
  }
}

/// The root config's `prd` — which document leads this workspace. Its own
/// function rather than a sixth key on setAgentField because it is not an
/// agent key: it lives at the document root, and it does not change when
/// the workspace switches CLI. An empty value clears it, putting the
/// workspace back on the scaffolded default.
export async function setPrdPath(workspaceId: string, value: string): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  try {
    await backend.setRootConfigField(ws.rootPath, "prd", value);
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide default model for one profile. Machine-local, so it goes
/// straight to config.json through Tauri and never touches the daemon --
/// which is why it keeps working against a daemon too old for
/// `[agent] model`.
export async function setAgentModelDefault(profileId: string, model: string): Promise<void> {
  try {
    await backend.setAgentModelDefault(profileId, model);
    agentModelDefaultsStore.update((current) => {
      const next = { ...current };
      if (model.trim()) next[profileId] = model.trim();
      else delete next[profileId];
      return next;
    });
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide terminal font size. Machine-local like the theme and the
/// model defaults, so it goes straight to config.json through Tauri and
/// never touches the daemon -- a display preference is nobody else's
/// business, and it must keep working against any daemon.
///
/// Null clears the setting rather than storing a number, which is what
/// puts every workspace that inherits back on gavin's default.
export async function setTerminalFontSizeDefault(size: number | null): Promise<void> {
  const normalized = size === null ? null : normalizeTerminalFontSize(size);
  try {
    await backend.setTerminalFontSize(normalized);
    terminalFontSizeDefault.set(normalized);
  } catch (e) {
    setError(String(e));
  }
}

/// One workspace's own terminal font size, or null to inherit the app-wide
/// one. Rides the workspace record (config.json) like the accent colour and
/// the notification toggles, rather than config.toml: how big the type is
/// on THIS machine is not a project fact to commit.
export async function setWorkspaceFontSize(
  workspaceId: string,
  size: number | null
): Promise<void> {
  const state = get(layoutState);
  const normalized = size === null ? undefined : (normalizeTerminalFontSize(size) ?? undefined);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, terminalFontSize: normalized } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// The app-wide auto-commit default. Machine-local like the theme, the
/// model defaults and the font size, so it goes straight to config.json
/// through Tauri and never touches the daemon -- which is also why this
/// feature needs no protocol bump and no compat gate to work.
///
/// Null clears the setting rather than storing false, which is what puts
/// every workspace that inherits back on gavin's default.
export async function setAutoCommitDefault(enabled: boolean | null): Promise<void> {
  try {
    await backend.setAutoCommit(enabled);
    autoCommitDefault.set(enabled);
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide require-review default. Machine-local like the theme, the
/// model defaults and the auto-commit default, so it goes straight to
/// config.json through Tauri and never touches the daemon.
///
/// Live, unlike `setGitTrackingDefault` below: every workspace that
/// inherits resolves against this value at the moment of its next check
/// (`cardReviewed`), so flipping it changes behaviour immediately rather
/// than seeding a one-time choice.
///
/// Null clears the setting rather than storing `true`, which is what puts
/// every workspace that inherits back on gavin's own default (require it).
export async function setRequireReviewDefault(enabled: boolean | null): Promise<void> {
  try {
    await backend.setRequireReview(enabled);
    requireReviewDefault.set(enabled);
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide git-tracking default. Machine-local beside the theme and
/// the auto-commit default, so it goes straight to config.json through
/// Tauri and never touches the daemon.
///
/// It changes nothing that already exists, deliberately. Every open
/// workspace's answer is a rule in its own repository, and moving a
/// preference is not a licence to rewrite `.gitignore` in each of them.
export async function setGitTrackingDefault(tracked: boolean | null): Promise<void> {
  try {
    await backend.setGitTrackingDefault(tracked);
    gitTrackingDefault.set(tracked);
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide custom agent and complexity table. Machine-local like
/// the theme, the model defaults and the font size, so it goes straight
/// to config.json through Tauri and never touches the daemon -- which is
/// why the complexity TABLE needs no protocol bump and no compat gate,
/// even though the card field it reads does.
///
/// Wholesale rather than per key, matching `setAgentPause`: the panel
/// holds every field already, and a per-key command is how one of them
/// ends up saved while another is dropped.
export async function setAgentDefaults(defaults: AgentDefaults): Promise<void> {
  try {
    await backend.setAgentDefaults(defaults);
    agentDefaultsStore.set(defaults);
  } catch (e) {
    setError(String(e));
  }
}

/// One workspace's complexity overrides. Rides the workspace record
/// (config.json) like the accent colour, the font size and the pause
/// cycle, rather than config.toml: which model tier THIS human spends on
/// a hard card is a habit and a subscription fact about this machine,
/// not something to hand everyone who clones the repo.
///
/// An empty table is stored as ABSENT, so a workspace that clears its
/// last override goes back to inheriting rather than to shadowing the
/// app table with nothing.
export async function setWorkspaceComplexityTable(
  workspaceId: string,
  table: ComplexityTable
): Promise<void> {
  const state = get(layoutState);
  const complexityAgents = Object.keys(table).length > 0 ? table : undefined;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, complexityAgents } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// One workspace's own auto-commit default, or null to inherit the
/// app-wide one. Rides the workspace record (config.json) like the accent
/// colour and the font size, rather than config.toml: whether THIS human
/// wants agents committing for them is not a project fact to commit.
export async function setWorkspaceAutoCommit(
  workspaceId: string,
  enabled: boolean | null
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, autoCommit: enabled ?? undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// One workspace's own require-review setting, or null to inherit the
/// app-wide one. Rides the workspace record (config.json) like
/// `autoCommit`, rather than config.toml: whether THIS human wants the
/// gate on this machine is not a project fact to commit.
export async function setWorkspaceRequireReview(
  workspaceId: string,
  enabled: boolean | null
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, requireReview: enabled ?? undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Records that this workspace's human has answered the git question --
/// in the wizard's git step, in the init prompt, or by flipping the switch
/// on the Settings tab. Every route through the question calls it, because
/// a step that stays unfinished after the human answered it is a step that
/// asks twice.
///
/// The ANSWER is not stored here and must not be: it is the ignore rule in
/// the repository, which git owns. This is only the fact that the question
/// was put, which git has no way to know.
///
/// A no-op once set, so the routes may call it unconditionally rather than
/// each deciding whether a save is owed.
export async function markGitTrackingAsked(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  if (state.workspaces.find((w) => w.id === workspaceId)?.gitTrackingAsked) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, gitTrackingAsked: true } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Records that this workspace's human has answered the require-review
/// question -- in the wizard's review step, or by picking a value on the
/// Settings tab. Same shape and reason as `markGitTrackingAsked`: both
/// answers are legitimate, so this only records that the question was put,
/// never which side was picked.
export async function markRequireReviewAsked(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  if (state.workspaces.find((w) => w.id === workspaceId)?.requireReviewAsked) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, requireReviewAsked: true } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function setWorkspaceColor(workspaceId: string, color: string): Promise<void> {
  const state = get(layoutState);
  const normalized = normalizeColor(color);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, color: normalized } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Pins or unpins a workspace's sidebar row. The stamp is taken here
/// rather than passed in because this is the only place a pin is made,
/// and `pinnedFirst` sorts on it -- a caller free to supply its own
/// moment could reorder rows that were pinned long ago.
///
/// Unpinning stores `undefined`, which `persistWorkspaces` drops from
/// config.json entirely (`skip_serializing_if` on the Rust side): an
/// unpinned row leaves no trace of having been pinned, so a later pin
/// starts from a clean moment instead of an old one.
export async function setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void> {
  const state = get(layoutState);
  const pinnedAt = pinned ? Date.now() : undefined;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, pinnedAt } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// The same, one level down: a page's row inside its workspace.
export async function setPagePinned(
  workspaceId: string,
  pageId: string,
  pinned: boolean
): Promise<void> {
  const state = get(layoutState);
  const data = workspace.setPagePinnedAt(state, workspaceId, pageId, pinned ? Date.now() : undefined);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

/// One writer for every boolean workspace preference that lives in
/// config.json -- the notification toggles and the close confirm. Keyed
/// rather than one function each so a new toggle costs a union member,
/// and so no two of them can disagree about how they persist.
export async function setWorkspaceFlag(
  workspaceId: string,
  key: "notifyNeedsInput" | "notifyFinished" | "confirmTabClose" | "autoResumeRuns",
  value: boolean
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, [key]: value } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Where the Home tab's divider sits for this workspace, as the agent
/// cell's share of the row. `undefined` clears the preference rather
/// than storing today's default -- absence is what lets a later change
/// to the shipped split reach anyone who never dragged the divider.
export async function setHomeAgentShare(
  workspaceId: string,
  share: number | undefined
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, homeAgentShare: share } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// This workspace's own pause cycle. `null` REMOVES the override, which
/// puts the workspace back to inheriting the app-wide one -- not to no
/// pause at all. Turning the cycle off here while the app has one stores
/// a cycle with `enabled: false`, which is why clearing and disabling are
/// two different calls.
export async function setWorkspacePause(
  workspaceId: string,
  cycle: PauseCycle | null
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) => {
    if (w.id !== workspaceId) return w;
    if (cycle === null) {
      const { agentPause: _dropped, ...rest } = w;
      return rest;
    }
    return { ...w, agentPause: cycle };
  });
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

// Git tab preferences (splitter widths, diff layout, discard-confirm
// opt-out): merged, never replaced, so one control's save can't clobber
// another's.
export async function setGitViewPrefs(workspaceId: string, patch: Partial<GitViewPrefs>): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, gitView: { ...(w.gitView ?? {}), ...patch } } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Writes the workspace's in-flight orchestration agent into config.json,
/// or clears it (`null`). One slot per workspace, deliberately: Organize
/// and every rail's Reorganize both end in a write of the WHOLE plan, so
/// two at once overwrite each other rather than dividing the work.
///
/// Persisted rather than held in a store, for the reason `agentCommit`
/// is: the run routinely outlives the window that started it, and a
/// window that comes back with no memory of it starts a second one on
/// top. The session itself IS in the layout tree (it lands on the Agents
/// page), but the tree cannot say what it is doing.
export async function setOrchestrationAgent(
  workspaceId: string,
  record: OrchestrationAgentRecord | null
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, orchestrationAgent: record ?? undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Writes the workspace's in-flight "Develop into a plan…" runs into
/// config.json. A LIST, unlike the slot above: two develop runs on two
/// different cards divide the work rather than overwriting each other,
/// and it is the same card twice that conflicts.
///
/// Persisted for the same reason the orchestration agent is -- a develop
/// run outlives the window that started it, and a window that comes back
/// with no memory of it offers Run on a card whose file is mid-rewrite.
/// Stored empty as ABSENT so an untouched workspace keeps the key out of
/// a file the human reads.
export async function setDevelopingCards(
  workspaceId: string,
  records: DevelopingCardRecord[]
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, developingCards: records.length > 0 ? records : undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

function clearMainSession(workspaceId: string): void {
  const state = get(layoutState);
  // Captured before the clear, and only destroyed when there was one --
  // destroyTerminal("") would be a meaningless call.
  const sessionId = state.workspaces.find((w) => w.id === workspaceId)?.mainSessionId;
  if (!sessionId) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  terminalRegistry.destroyTerminal(sessionId);
  void persistWorkspaces(workspaces, state.activeWorkspaceId);
}

// Splits the pane holding `targetSessionId` and drops a fresh session into
// the new half. Scoped to the target's OWN page, and brings that page on
// screen: a split spawns a session and focuses it, so leaving it on an
// invisible page would be a terminal running where nobody can see it. Both
// are no-ops for the tab bar and the keyboard shortcut, which can only
// address the active page anyway -- they matter for the sidebar, which
// reaches every page of every workspace.
export async function splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void> {
  const state = get(layoutState);
  const location = pageLocationForSession(state, targetSessionId);
  if (!location) return;
  const newId = await createFreshSession(location.workspaceId);
  if (!newId) return;
  const newTree = layout.splitLeaf(location.tree, targetSessionId, direction, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const withFocus = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  const switchedPage = workspace.switchPage(withFocus, location.workspaceId, location.pageId);
  const switchedWs = activateWorkspace(switchedPage, location.workspaceId);
  const data = workspace.switchWorkspaceView(switchedWs, location.workspaceId, "terminal");
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    focusedSessionId: newId,
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Opens `path` as a new file tab, split beside the pane holding
// `anchorSessionId` -- the cmd+click-a-path flow's entry point. Mirrors
// splitPane exactly, except the new tab is a file tab (a fresh opaque id
// recorded in fileTabsById) rather than a freshly spawned session, so no
// create_session call happens at all.
export async function openFileInSplit(anchorSessionId: string, path: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const fileTabsById = { ...state.fileTabsById, [tabId]: { path } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, fileTabsById }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(fileTabsById)) {
    asPathMap[id] = tab.path;
  }
  try {
    await backend.setFileTabs(asPathMap);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Opens a context board as a new board tab, split beside the pane holding
// `anchorSessionId` -- the pane board-icon flow's entry point. Mirrors
// openFileInSplit exactly, with boardTabsById/setBoardTabs in place of the
// file-tab map.
export async function openBoardInSplit(
  anchorSessionId: string,
  workspaceId: string,
  contextFolder: string
): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const boardTabsById = { ...state.boardTabsById, [tabId]: { workspaceId, contextFolder } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, boardTabsById }));
  try {
    await backend.setBoardTabs(boardTabsById);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Opens one of a card's own views -- its detail panel, or the diff of
// what its run did to the checkout -- as a new tab split beside the pane
// holding `anchorSessionId`. Mirrors openBoardInSplit, with
// cardTabsById/setCardTabs in place of the board-tab map.
//
// Unlike the file and board splits this one DEDUPES first (see
// openViewTabInSplit). It is reached from a chip on a terminal tab,
// which the human clicks to check on the agent and clicks again a minute
// later; splitting a second identical pane every time is how a page ends
// up four copies deep in the same card. An already-open view of the same
// card is brought forward instead, wherever on this page it lives.
export function openCardInSplit(
  anchorSessionId: string,
  workspaceId: string,
  path: string,
  view: CardTabView
): Promise<void> {
  return openViewTabInSplit(anchorSessionId, { workspaceId, path, view });
}

/// The follow-up queue for ONE session, split beside the terminal it
/// belongs to. The queue used to be a band under every terminal, which
/// cost the PTY rows to say nothing on every tab where nothing was
/// queued; it is a view a human asks for, like the plan and the diff
/// beside it, so it opens the way those do.
///
/// Keyed by the session and not by a card, with an empty path: the queue
/// outlives whatever card the agent happens to be running, and two tabs
/// on one card have two separate queues. That is also what makes the
/// dedupe below correct for it -- matching on path would fold every
/// session's queue on this page into one pane.
export function openFollowUpsInSplit(
  anchorSessionId: string,
  workspaceId: string
): Promise<void> {
  return openViewTabInSplit(anchorSessionId, {
    workspaceId,
    path: "",
    view: "followups",
    sessionId: anchorSessionId,
  });
}

/// The body both of those share: dedupe, split, record, persist.
async function openViewTabInSplit(anchorSessionId: string, tab: CardTab): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const existing = Object.entries(state.cardTabsById).find(
    ([id, open]) =>
      open.workspaceId === tab.workspaceId &&
      open.path === tab.path &&
      open.view === tab.view &&
      open.sessionId === tab.sessionId &&
      layout.findLeafPath(location.tree, id) !== null
  );
  if (existing) {
    await switchToTab(existing[0]);
    return;
  }
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const cardTabsById = { ...state.cardTabsById, [tabId]: tab };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, cardTabsById }));
  try {
    await backend.setCardTabs(cardTabsById);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

/// Repoints ONE card tab at another card -- the pane's own navigation
/// (the detail panel's Tasks list, its "Part of" row). Deliberately not
/// retargetCardTabs: that one follows a file that MOVED, and moves every
/// pane showing it; this one is a human walking from one card to
/// another in a single pane, and must leave the sibling panes alone.
export async function setCardTabPath(tabId: string, path: string): Promise<void> {
  const state = get(layoutState);
  const tab = state.cardTabsById[tabId];
  if (!tab || tab.path === path) return;
  const cardTabsById = { ...state.cardTabsById, [tabId]: { ...tab, path } };
  layoutState.update((s) => ({ ...s, cardTabsById }));
  await backend.setCardTabs(cardTabsById).catch(() => {});
}

/// Points every open card tab at a path that has just moved -- setting a
/// card Done files it under `plans/done/`, and archiving moves it again.
/// Without this the pane would go on asking the tree for a card that is
/// no longer at that path and render its "this card is gone" state for a
/// card that is merely somewhere else.
export async function retargetCardTabs(from: string, to: string): Promise<void> {
  const state = get(layoutState);
  const cardTabsById: Record<string, CardTab> = {};
  let moved = false;
  for (const [id, tab] of Object.entries(state.cardTabsById)) {
    if (tab.path !== from) {
      cardTabsById[id] = tab;
      continue;
    }
    moved = true;
    cardTabsById[id] = { ...tab, path: to };
  }
  if (!moved) return;
  layoutState.update((s) => ({ ...s, cardTabsById }));
  // Best-effort, like pruneCardTabs: a failed persist costs a stale entry
  // in config.json, never a tab left pointing at the old path.
  await backend.setCardTabs(cardTabsById).catch(() => {});
}

export async function addTab(targetSessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newId = await createFreshSession(location.workspaceId);
  if (!newId) return;
  const newTree = layout.addTab(location.tree, targetSessionId, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: newId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  const closed = await endTabs([sessionId], state.fileTabsById, state.boardTabsById, state.cardTabsById);
  if (!closed) return;
  // Tree first, maps second (see ClosedTabs): the other order leaves the
  // tab in the tree for a render with nothing left to classify it.
  handleSessionExited(sessionId);
  await pruneClosedTabs(closed);
}

// Shared by closeSession (after a successful daemon-side kill) and the
// session-exited event listener (the session is already dead, so no
// killSession call happens here) -- both cases mean "remove this session
// from wherever it lives." Searches every page of every workspace, not
// just the active one -- a session-exited event can arrive for a session
// in a currently-invisible page, since inactive pages/workspaces keep
// their sessions running the same as inactive tabs always have. If
// removing it empties that page's tree entirely, the whole page is
// removed too (see workspace.ts's updatePageLayout doc comment for why
// there's no "clear the layout" alternative).
/// Exit code by session id, for sessions that have ended while this app
/// was running. A tool step is done or stalled by exactly this (tools
/// spec T5), and a session absent from here has no WITNESSED outcome --
/// which is a stall, not a pass.
///
/// Never pruned by age: an entry is a few bytes and the map only grows
/// with sessions that actually ended in this app run. Pruning it would
/// mean a slow rail's finished step could lose its verdict.
export const sessionExits = hotState("sessionExits", () => writable(new Map<string, number>()), hotBag);

export function recordSessionExit(sessionId: string, exitCode: number): void {
  sessionExits.update((m) => new Map(m).set(sessionId, exitCode));
}

export function handleSessionExited(sessionId: string): void {
  // Cleared here rather than left standing like cwd and status, and the
  // difference is what the entry IS. Those are facts about a session
  // that stay true after it ends; a queue is undelivered content, and
  // the daemon drops it with the session for exactly that reason
  // (registry.rs `remove`) -- a follow-up outliving its session is not
  // waiting, it is undeliverable. Dropping it here too keeps the two
  // sides agreeing without needing a push the daemon has no writer left
  // to send on.
  handleQueuedInputsChanged(sessionId, []);
  // And the pane that was showing it, for the same reason: a follow-up
  // queue tab is the one view tab whose subject is a SESSION, so once
  // that session is gone the pane has nothing left to be about -- an
  // empty list and a compose box that would write into a session id the
  // daemon no longer knows. Fired rather than awaited so this function
  // keeps its synchronous contract; closeSession re-reads the store, so
  // it sees the tree this call is about to leave behind.
  for (const [tabId, tab] of Object.entries(get(layoutState).cardTabsById)) {
    if (tab.view === "followups" && tab.sessionId === sessionId) void closeSession(tabId);
  }
  const state = get(layoutState);
  // A main agent session lives outside every page tree (D12), so the
  // search below can never find it -- without this branch its terminal
  // would sit dead on the home forever.
  const owner = workspaceIdForSession(state, sessionId);
  if (owner && state.workspaces.find((w) => w.id === owner)?.mainSessionId === sessionId) {
    clearMainSession(owner);
    return;
  }
  let found: { workspaceId: string; pageId: string; page: { layout: LayoutNode } } | null = null;
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      if (layout.findLeafPath(page.layout, sessionId)) {
        found = { workspaceId: ws.id, pageId: page.id, page };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return;

  const newTree = layout.closeTab(found.page.layout, sessionId);
  let updated = newTree
    ? workspace.updatePageLayout(state, found.workspaceId, found.pageId, newTree)
    : workspace.removePage(state, found.workspaceId, found.pageId);

  let focusedSessionId = state.focusedSessionId;
  if (state.focusedSessionId === sessionId) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  terminalRegistry.destroyTerminal(sessionId);
  void persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

// An MCP-spawned session (daemon push, already Attached by the Rust
// relay). Lands on the workspace's "Agents" page -- found by name,
// created with the session as its first tab when absent. Never steals
// focus (createPage activates the new page, so the previous active page
// is restored). If the workspace no longer exists, the session is
// killed: an agent the human can't see is never allowed to keep running.
export function handleAgentSessionSpawned(workspaceId: string, sessionId: string): void {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    void backend.killSession(sessionId).catch(() => {});
    return;
  }
  const base: WorkspacesData = { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId };
  const agentsPage = ws.pages.find((p) => p.name === "Agents");
  let data: WorkspacesData;
  if (agentsPage) {
    const anchor = layout.allSessionIds(agentsPage.layout)[0];
    const newTree = layout.addTab(agentsPage.layout, anchor, sessionId);
    data = workspace.updatePageLayout(base, workspaceId, agentsPage.id, newTree);
  } else {
    const previousActive = ws.activePageId;
    data = workspace.createPage(base, workspaceId, crypto.randomUUID(), "Agents", {
      type: "leaf",
      tabs: [sessionId],
      activeTabIndex: 0,
    });
    if (previousActive) data = workspace.switchPage(data, workspaceId, previousActive);
  }
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  void persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests. Entries are never removed when a session closes; a
// stale in-memory map entry per session that ever existed in one app run
// is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  // Mirrored into terminalRegistry too: its xterm link provider resolves
  // relative paths against this cwd synchronously, so it can't read the
  // store (and can't import this module back -- that would be circular).
  terminalRegistry.setCwdForLinks(sessionId, cwd);
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}

// Shared by the "session-status-changed" event listener in bootstrap() and
// this file's own tests. Reads the *previous* status before overwriting
// the map -- undefined for a session's first-ever status report -- and
// hands both values plus a resolved display label to notifications.ts,
// which decides whether the specific transition is worth an OS
// notification. Like handleCwdChanged, entries are never removed on
// session exit.
export function handleSessionStatusChanged(sessionId: string, rawStatus: string): void {
  // Through one door: a status this build cannot read must never be
  // mistaken for `idle`, which is the value orchestration acts on by
  // marking a step done (see parseSessionStatus).
  const status = parseSessionStatus(rawStatus);
  const state = get(layoutState);
  const previousStatus = state.sessionStatusById[sessionId];
  layoutState.update((s) => {
    // Any status but `failed` clears the reason with it, matching what
    // the daemon does to the row: a session that started talking again,
    // exited or asked a question is no longer described by the last
    // thing that broke.
    const failureReasonById = { ...s.failureReasonById };
    if (status !== "failed") delete failureReasonById[sessionId];
    // Only a CHANGE restarts the clock. The daemon re-reports a status
    // it has already sent (a re-Attach, a heuristic re-fire), and
    // re-stamping on those would reset every wait the inbox is ordered
    // by -- the same trap the pause anchor has to avoid.
    const statusSinceById =
      previousStatus === status
        ? s.statusSinceById
        : { ...s.statusSinceById, [sessionId]: { at: Date.now(), watched: true } };
    return {
      ...s,
      sessionStatusById: { ...s.sessionStatusById, [sessionId]: status },
      statusSinceById,
      failureReasonById,
      // A read mark acknowledges ONE wait, so anything the daemon says
      // about this session afterwards ends it -- including a repeat of
      // `waiting_for_input`, which the notification path re-emits per
      // bell rather than only on a change. That repeat IS the agent
      // asking again, and it has to be able to raise the badge the human
      // silenced last time.
      readSessionIds: clearSessionRead(readMarks(s), sessionId),
    };
  });
  if (status === "failed") {
    // Held for the reason, which the daemon sends immediately after this
    // (`persist_and_emit_failure` writes StatusChanged first, so every
    // consumer that only reads statuses is never briefly told a reason
    // for a session it still believes is idle). Notifying here would
    // announce a failure with nothing to say about it, and the agent's
    // own sentence is the whole value: a dead network and an expired
    // token want opposite responses from the human.
    pendingFailureNotice.set(sessionId, previousStatus);
    return;
  }
  pendingFailureNotice.delete(sessionId);
  notifyStatus(state, sessionId, previousStatus, status);
}

/// Acknowledges (or un-acknowledges) one session's wait -- the tab
/// menu's "Mark as Read".
///
/// Writes nothing to the daemon on purpose: the session really is still
/// waiting, and every rule that acts on that fact has to keep seeing it.
/// See sessionRead.ts for the full split between what this hides and
/// what it deliberately does not.
export function setSessionRead(sessionId: string, read: boolean): void {
  layoutState.update((s) => {
    const readSessionIds = withSessionRead(readMarks(s), sessionId, read);
    return readSessionIds === s.readSessionIds ? s : { ...s, readSessionIds };
  });
}

/// Every session's status as the ATTENTION surfaces read it: the daemon's
/// own map, with an acknowledged wait showing as idle.
///
/// The badge on a tab, the sidebar's dots and tallies, the hub's fleet
/// figures and its inbox all go through this; orchestration, the
/// follow-up queue, auto-resume, the idle-tab sweep and the task manager
/// all keep reading `sessionStatusById` directly. That is the whole
/// distinction "Mark as Read" rests on, and reading the wrong one is how
/// a silenced badge would come to advance a rail.
export const attentionStatusById = derived(layoutState, ($layout) =>
  attentionStatuses($layout.sessionStatusById, readMarks($layout))
);

/// The same substitution for the pure modules that take a whole state
/// object (sidebarSummary, attentionInbox, appHub): one masked map
/// dropped into the state they already read, so their call sites say
/// which view they are asking for and nothing inside them has to change.
export const attentionState = derived(layoutState, ($layout) => {
  const sessionStatusById = attentionStatuses($layout.sessionStatusById, readMarks($layout));
  return sessionStatusById === $layout.sessionStatusById
    ? $layout
    : { ...$layout, sessionStatusById };
});

/// The status a session held just before it went `failed`, kept only
/// until the reason arrives. See handleSessionStatusChanged.
const pendingFailureNotice = new Map<string, SessionStatus | undefined>();

/// Told about a failure the moment its reason lands, so the unattended
/// half of recovery can decide what to do about it.
///
/// Registered rather than imported, the same direction and for the same
/// reason as `setRailNotificationVoice`: auto-resume reads this module
/// (and orchestration, and card runs), so importing it from here would
/// close a cycle.
///
/// Called only for a LIVE transition -- a failure this app run watched
/// happen. A failure re-baselined on Attach (a reload finding a session
/// that broke while the window was gone) deliberately does not fire it:
/// the previous status is unknown there, so the "never resume a session
/// that was asking a human something" rule could not be honoured, and
/// the human is looking at the window anyway.
export type SessionFailureHook = (
  sessionId: string,
  reason: string,
  previousStatus: SessionStatus | undefined
) => void;

let sessionFailureHook: SessionFailureHook | null = null;

export function setSessionFailureHook(hook: SessionFailureHook | null): void {
  sessionFailureHook = hook;
}

/// @internal - for testing only
export function __resetFailureNotices(): void {
  pendingFailureNotice.clear();
  sessionFailureHook = null;
}

function notifyStatus(
  state: LayoutState,
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  status: SessionStatus,
  failureReason?: string
): void {
  const label = sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId);
  const owner = workspaceIdForSession(state, sessionId);
  const owningWs = owner ? state.workspaces.find((w) => w.id === owner) : undefined;
  // A session owned by no workspace (spawned but not yet landed) keeps
  // today's behaviour rather than going silent.
  void maybeNotifyStatusChange(
    sessionId,
    previousStatus,
    status,
    label,
    {
      needsInput: owningWs?.notifyNeedsInput ?? true,
      finished: owningWs?.notifyFinished ?? true,
    },
    failureReason
  );
}

/// Shared by the "session-failed" listener in bootstrap() and this
/// file's own tests. Rides BESIDE the status the way SessionInterrupted
/// rides beside SessionRestored: the status has already landed, and this
/// carries the one thing a human can act on.
///
/// It also owns the notification for the transition, because it is the
/// only call that holds the reason -- see handleSessionStatusChanged.
/// A push with no pending transition behind it (the same failure read
/// twice, or a reason arriving for a session already known failed)
/// updates the text and stays silent.
export function handleSessionFailed(sessionId: string, reason: string): void {
  const state = get(layoutState);
  layoutState.update((s) => ({
    ...s,
    failureReasonById: { ...s.failureReasonById, [sessionId]: reason },
  }));
  if (!pendingFailureNotice.has(sessionId)) return;
  const previousStatus = pendingFailureNotice.get(sessionId);
  pendingFailureNotice.delete(sessionId);
  notifyStatus(state, sessionId, previousStatus, "failed", reason);
  // After the notification, not before: the tray line is the human's
  // record that something broke, and it has to go out whether or not
  // anything can be done about it automatically.
  sessionFailureHook?.(sessionId, reason, previousStatus);
}

// Shared by the "git-status-changed" event listener in bootstrap() and
// this file's own tests. Unlike handleSessionStatusChanged, there is no
// previous-value read and no notification side effect -- git status
// changes are frequent (every fs-watch trigger, every OSC-133 idle
// prompt) and were never in scope for OS notifications, only the in-app
// dot/sidebar display. Like handleCwdChanged/handleSessionStatusChanged,
// entries are never removed on session exit.
export function handleGitStatusChanged(sessionId: string, status: GitStatus | null): void {
  layoutState.update((s) => ({ ...s, gitStatusById: { ...s.gitStatusById, [sessionId]: status } }));
}

// Shared by the "session-restored" event listener in bootstrap() and this
// file's own tests. Entries are added, never auto-removed by the passage
// of time -- clearRestoredMarker (below) is the only thing that removes
// one, driven by the user actually typing into (or pasting into) that
// specific session.
export function handleSessionRestored(sessionId: string): void {
  layoutState.update((s) => ({ ...s, restoredSessionIds: new Set(s.restoredSessionIds).add(sessionId) }));
}

// Shared by the "session-interrupted" listener in bootstrap() and this
// file's own tests. Deliberately has no counterpart to
// clearRestoredMarker below: the ↻ badge is a note about the SCREEN, and
// typing dismisses it; this is a fact about the RUN, and typing into the
// bare shell recovery left behind does not bring the agent back. The
// card, rail step or commit record bound to this id stops reading as
// interrupted when the human resumes it -- which is a new session, and a
// new id.
export function handleSessionInterrupted(sessionId: string): void {
  layoutState.update((s) => ({
    ...s,
    interruptedSessionIds: new Set(s.interruptedSessionIds).add(sessionId),
  }));
}

// The stronger half of the above: this session's agent did not stop when
// the daemon did. Like `interrupted` and unlike `restored` it is not
// dismissed by typing -- a process does not stop editing the checkout
// because someone ran `ls` in the shell that replaced its tab -- so it
// arrives again on every Attach and is cleared only by the two things
// that actually end it: the daemon confirming the process is gone
// (handleOrphanEnded) and the session itself going away.
export function handleSessionOrphaned(sessionId: string, orphan: OrphanProcess): void {
  layoutState.update((s) => ({
    ...s,
    orphanBySessionId: { ...s.orphanBySessionId, [sessionId]: orphan },
  }));
}

// Called after the daemon has CONFIRMED the process exited, never merely
// after it was signalled. A process that ignored SIGTERM is still there,
// and dropping the badge for it would be the app telling the human a
// comforting thing it just watched fail to happen.
export function handleOrphanEnded(sessionId: string): void {
  layoutState.update((s) => {
    if (s.orphanBySessionId[sessionId] === undefined) return s;
    const orphanBySessionId = { ...s.orphanBySessionId };
    delete orphanBySessionId[sessionId];
    return { ...s, orphanBySessionId };
  });
}

// Called via backend.ts's writeInput hook on every single keystroke and
// paste across every session in the app -- checked against the current
// state BEFORE calling layoutState.update, so the overwhelmingly common
// case (a session that was never restored, or was already cleared) never
// triggers a store update or a new Set allocation at all.
export function clearRestoredMarker(sessionId: string): void {
  if (!get(layoutState).restoredSessionIds.has(sessionId)) return;
  layoutState.update((s) => {
    const next = new Set(s.restoredSessionIds);
    next.delete(sessionId);
    return { ...s, restoredSessionIds: next };
  });
}

// A blank (or whitespace-only) name clears the override rather than
// setting an empty string -- the tab falls back to its cwd-based label
// (or the session-id fragment) again. Updates local state immediately
// (the rename UI closes right away); the persist call is best-effort,
// matching every other action's error-surfacing pattern.
export async function setSessionName(sessionId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  layoutState.update((s) => {
    const sessionNames = { ...s.sessionNames };
    if (trimmed) {
      sessionNames[sessionId] = trimmed;
    } else {
      delete sessionNames[sessionId];
    }
    return { ...s, sessionNames };
  });
  try {
    await backend.setSessionName(sessionId, trimmed);
  } catch (e) {
    setError(String(e));
  }
}

export async function switchToTab(sessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  // The workspace is already the active one, so activateWorkspace never
  // runs -- but this is reachable from the sidebar with the hub up, and
  // choosing a tab plainly means "show me that tab".
  closeAppHub();
  const newTree = layout.switchTab(location.tree, sessionId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: sessionId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Makes sessionId's own page (and workspace) active, and that session
// itself the active tab within its pane AND the page's remembered focus
// -- unlike switchPage alone (which falls back to the page's own
// last-remembered focus, or its first session, not necessarily the one
// that was actually clicked). Used by the sidebar's expanded multi-repo
// session rows (Sidebar.svelte), where each row targets one specific
// session that may not already be its page's active tab, and that page
// may not even be the currently active one.
//
// Ordering below is load-bearing: resolveActiveFocus reads
// getActiveWorkspace/getActivePage, so it must run AFTER switchPage/
// switchWorkspace, not before -- hoisting it above them would silently
// resolve focus against the OLD active page and leave the clicked
// session unfocused, with no test failure in any case where the target
// page/workspace was already active (the only cases the single-workspace
// tests originally covered).
export async function switchToSessionInPage(workspaceId: string, pageId: string, sessionId: string): Promise<void> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const newTree = layout.switchTab(page.layout, sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const withFocus = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  const switchedPage = workspace.switchPage(withFocus, workspaceId, pageId);
  const switched = activateWorkspace(switchedPage, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

export function focusPane(sessionId: string): void {
  const state = get(layoutState);
  const location = activePageLocation(state);
  const workspaces = location
    ? workspace.setPageFocus(state, location.workspaceId, location.pageId, sessionId).workspaces
    : state.workspaces;
  layoutState.update((s) => ({ ...s, workspaces, focusedSessionId: sessionId }));
}

// Updates the active page's sizes without persisting -- used for live
// visual feedback while a divider drag is in progress. Call
// commitLayout() once, on drag-end, to actually persist.
export function previewResizePane(splitPath: number[], sizes: number[]): void {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = layout.resizeSplit(location.tree, splitPath, sizes);
  const workspaces = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree).workspaces;
  layoutState.update((s) => ({ ...s, workspaces }));
}

// Persists whatever the current workspaces array is. Call once after a
// batch of previewResizePane calls (e.g. on pointerup), not per
// intermediate step.
export async function commitLayout(): Promise<void> {
  const state = get(layoutState);
  if (!activePageLocation(state)) return;
  await persistWorkspaces(state.workspaces, state.activeWorkspaceId);
}

// Closes every tab in the pane (within the active page) containing
// anySessionId -- distinct from closeSession (which closes just the one
// named session). Used by the toolbar's "Close Pane" button; Cmd+W stays
// scoped to a single tab via closeSession.
//
// Unlike the old single-tree model, this always persists the result --
// there's no "tree became null, can't persist null" case to skip anymore,
// since Page.layout is never null and an emptied page is removed via
// removePage rather than set to some unrepresentable empty value.
export async function closePane(anySessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const path = layout.findLeafPath(location.tree, anySessionId);
  if (!path) return;
  const leaf = layout.getNodeAtPath(location.tree, path);
  if (leaf.type !== "leaf") return;
  const sessionIds = [...leaf.tabs];

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById, state.cardTabsById);
  if (!closed) return;

  let tree: LayoutNode | null = location.tree;
  for (const id of sessionIds) {
    if (!tree) break;
    tree = layout.closeTab(tree, id);
    terminalRegistry.destroyTerminal(id);
  }

  let updated = tree
    ? workspace.updatePageLayout(state, location.workspaceId, location.pageId, tree)
    : workspace.removePage(state, location.workspaceId, location.pageId);

  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

export async function createWorkspace(name: string): Promise<void> {
  const state = get(layoutState);
  const id = crypto.randomUUID();
  // createWorkspace makes the new workspace active without going through
  // switchWorkspace, so the hub is taken down here rather than there --
  // the hub's own "+ New workspace…" must land you in what it created.
  closeAppHub();
  // Claimed before it is stored, so no window ever reads this workspace
  // as unowned -- which, absence meaning "the main window", would put it
  // in two windows at once the moment anything switched to it there.
  if (!isMainWindow()) await backend.claimWorkspaceWindow(id).catch(() => {});
  const data = workspace.createWorkspace(state, id, name);
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.renameWorkspace(state, workspaceId, name);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const switched = activateWorkspace(state, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

/// Puts a workspace in a window of its own, and stops showing it here.
///
/// The order is the whole of it. This window looks away FIRST, then gives
/// up the terminals it was drawing, and only then asks for the window --
/// so at no point are two live panes reporting two sizes for one PTY. The
/// new window builds its own terminals and asks the daemon to repaint
/// them, which is the same path a reload already takes.
///
/// Both halves of the card's ask are this one function: a workspace you
/// are looking at "moves" to a new window, and one you are not "opens" in
/// one. The difference is only whether this window had to look away, and
/// that is a fact it can read for itself rather than a mode the caller
/// picks.
export async function handOffWorkspace(workspaceId: string): Promise<void> {
  const label = currentWindowLabel();
  const action = windowAction(currentWorkspaceWindows(), workspaceId, label);
  // Already in a window of its own: the honest answer is to raise it, not
  // to open a second one onto the same workspace. "none" is this window
  // being asked to hand over the workspace it IS -- the surfaces withdraw
  // the action then, and this is what makes a stale click harmless.
  if (action !== "open") {
    if (action === "show") await backend.focusWorkspaceWindow(workspaceId).catch(() => {});
    return;
  }
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;

  if (state.activeWorkspaceId === workspaceId && !get(appHubOpen)) {
    const next = nextActiveAfterHandoff(
      state.workspaces,
      currentWorkspaceWindows(),
      label,
      workspaceId
    );
    if (next) await switchWorkspace(next);
    else openAppHub();
  }

  // Every id in the trees, not just the terminals: destroyTerminal is a
  // no-op for a file or board tab, and enumerating which is which here
  // would be a second, drifting copy of the tab maps. The main agent
  // sits outside every page, so it has to be named separately.
  for (const id of workspace.allSessionIdsInWorkspace(ws)) {
    terminalRegistry.destroyTerminal(id);
  }
  if (ws.mainSessionId) terminalRegistry.destroyTerminal(ws.mainSessionId);

  try {
    await backend.openWorkspaceWindow(workspaceId);
  } catch (e) {
    // An alert, never setError: the app behind this is perfectly
    // healthy, and replacing it with the lost-the-daemon overlay
    // because a window would not open would be a far bigger lie than
    // the failure itself.
    await showAlert({
      title: "Couldn't open a new window",
      lines: [`${ws.name} stays in this window.`, String(e)],
    });
  }
}

export async function switchWorkspaceView(workspaceId: string, view: string): Promise<void> {
  // Guarded separately from activateWorkspace, which this deliberately
  // does not call: `activeView` is stored ON the workspace, so a click
  // here on a workspace that lives in another window would persist a tab
  // change that window then adopts -- one window silently redrawing
  // another.
  if (claimedElsewhere(workspaceId)) return;
  const state = get(layoutState);
  // Same reason as switchToTab: the workspace is already active so
  // activateWorkspace never runs, but ⌘2 (and the tab row, and Home's
  // tiles) plainly mean "show me that tab" -- leaving the hub up would
  // change the view underneath it and look like nothing happened.
  closeAppHub();
  const data = workspace.switchWorkspaceView(state, workspaceId, view);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Kills every session across every page of the workspace, then removes
// it -- the same escalation as closePane, one level up. Confirm-before
// prompting is the caller's (Sidebar.svelte's) responsibility, matching
// how confirmPaneClose/confirmTabClose already work.
//
// App-side ONLY: not one file on disk and not one daemon row is touched.
// It used to delete the workspace's kanban board, which made the sidebar
// X silently destroy columns and labels that took real work to arrange --
// the same gesture that closes a tab. Removing a workspace's DATA is now
// the delete wizard's job (Settings > Danger zone), and this leaves a
// tombstone instead so those rows can be reclaimed: the workspace id is
// a uuid minted at creation, so without one the rows are unreachable
// forever.
//
// `remember: false` is the delete wizard's ending: it has just been
// through six screens deciding what to remove, so leaving a record
// offering to bring it all back would contradict the answer the user
// gave. Every other caller wants the tombstone, which is why it is the
// default rather than a flag each of them has to remember.
export async function closeWorkspace(
  workspaceId: string,
  opts: { remember?: boolean } = {}
): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const sessionIds = workspace.allSessionIdsInWorkspace(ws);

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById, state.cardTabsById);
  if (!closed) return;
  // A window whose workspace no longer exists has nothing to show, so it
  // goes with it. After the confirmation, never before: a cancelled close
  // must leave the window standing. A no-op for a workspace in the main
  // window -- removing one must not take the app down.
  await backend.closeWorkspaceWindow(workspaceId).catch(() => {});
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  // Stamped BEFORE the removal, because the tombstone's name and root
  // are read off the workspace that is about to disappear. A rootless
  // workspace produces none -- see rememberRemoved.
  const remembered =
    opts.remember === false ? state : workspace.rememberRemoved(state, workspaceId, Date.now());
  let updated = workspace.removeWorkspace(remembered, workspaceId);
  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
    // Into the store before the persist, which reads the list from
    // there rather than taking it as an argument.
    removedWorkspaces: updated.removedWorkspaces ?? [],
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

/// The delete wizard's last act: the workspace leaves the app the way
/// the sidebar X removes one, but with no tombstone behind it. Named
/// rather than inlined so the one place that means "gone, and do not
/// offer it back" says so at the call site.
export function deleteWorkspaceFromApp(workspaceId: string): Promise<void> {
  return closeWorkspace(workspaceId, { remember: false });
}

// Creates N fresh daemon sessions, builds a tree via buildTree (typically
// one of layout.ts's preset generators), and appends it as a new page to
// the given workspace -- always an explicit workspaceId, never "whichever
// workspace happens to be active," so a caller (e.g. Sidebar.svelte's
// per-workspace "+" button) can add a page to a workspace without first
// switching to it. The new page (and its workspace) become active,
// mirroring "a new tab becomes the active one" elsewhere in this app.
/// Returns the new page's id, so a caller that must bind something to it
/// (an orchestration rail) does not have to guess which page appeared.
/// Null when the workspace is unknown or session creation failed.
/// `cwd` is where the fresh shells open; omitted, the workspace's own
/// root applies (freshSessionCwd), which is what the toolbar's "new
/// page" buttons want. A rail passes its checkout, so the page it spawns
/// for itself opens where that rail actually works rather than at the
/// workspace root.
///
/// `activate: false` builds the page WITHOUT switching to it. A page the
/// human asked for by name should come to the front; one the app made on
/// their behalf must not take the screen they were using -- pressing
/// Start on a rail would otherwise throw them off the Orchestration tab
/// they pressed it in. Same posture createSessionOnPage already takes
/// when it drops a rail's agent onto a page that is not on screen.
///
/// `withAgent` starts EVERY pane on the workspace's configured agent
/// instead of a bare shell -- the "New page" dropdown's checkbox. The
/// agent is resolved here rather than by the caller, because a launch
/// is more than a command: it also has to arm failure detection, or a
/// broken agent on the new page reads as one that finished (the same
/// pairing startMainAgent makes). Resolution is per PAGE, not per pane:
/// four panes of a 2x2 are four sessions of one workspace's agent.
export async function createPage(
  workspaceId: string,
  buildTree: (freshIds: string[]) => LayoutNode,
  sessionCount: number,
  name: string,
  opts: { cwd?: string; activate?: boolean; withAgent?: boolean } = {}
): Promise<string | null> {
  const state = get(layoutState);
  const target = state.workspaces.find((w) => w.id === workspaceId);
  if (!target) return null;
  const previousPageId = target.activePageId;
  const agent = opts.withAgent ? resolvedAgentFor(workspaceId) : null;
  let freshIds: string[];
  try {
    const sessionCwd = opts.cwd || freshSessionCwd(workspaceId);
    freshIds = await Promise.all(
      Array.from({ length: sessionCount }, () =>
        agent ? backend.createSession(sessionCwd, agent.launchCommand) : backend.createSession(sessionCwd)
      )
    );
  } catch (e) {
    setError(String(e));
    return null;
  }
  if (agent) for (const id of freshIds) void armFailureDetection(id, agent.failurePatterns);
  const tree = buildTree(freshIds);
  const pageId = crypto.randomUUID();
  const created = workspace.createPage(state, workspaceId, pageId, name, tree);
  const focusedSessionId = freshIds[0] ?? null;
  const data = workspace.setPageFocus(created, workspaceId, pageId, focusedSessionId);
  const activate = opts.activate !== false;
  // workspace.createPage always activates what it appends, so the
  // non-activating case puts the workspace back on the page it was on.
  const workspaces = activate
    ? data.workspaces
    : data.workspaces.map((w) => (w.id === workspaceId ? { ...w, activePageId: previousPageId } : w));
  layoutState.update((s) => ({
    ...s,
    workspaces,
    activeWorkspaceId: activate ? workspaceId : s.activeWorkspaceId,
    focusedSessionId: activate ? focusedSessionId : s.focusedSessionId,
  }));
  await persistWorkspaces(workspaces, data.activeWorkspaceId);
  return pageId;
}

/// A page of N panes where every pane runs its OWN command in its OWN
/// directory -- what a best-of-N run is, and the one thing `createPage`
/// above cannot express: it opens `sessionCount` bare shells that all
/// share one cwd, which is right for the "New page" presets and wrong
/// for candidates living in N different worktrees.
///
/// Tiled by `presetTiled`, so the shape agrees with the hand-written
/// presets wherever they overlap.
///
/// All-or-nothing: a session that fails to start takes the ones already
/// created down with it and returns null, rather than leaving a page
/// with a hole in it. The caller owns the worktrees those sessions were
/// going to run in, and a half-built page would leave it guessing which
/// of them are still needed.
export async function createTiledPage(
  workspaceId: string,
  name: string,
  specs: readonly { cwd: string; command: string | null }[],
  opts: { activate?: boolean } = {}
): Promise<{ pageId: string; sessionIds: string[] } | null> {
  const state = get(layoutState);
  const target = state.workspaces.find((w) => w.id === workspaceId);
  if (!target || specs.length === 0) return null;
  const previousPageId = target.activePageId;

  const sessionIds: string[] = [];
  try {
    // Sequential, not Promise.all: each session is a real process in a
    // directory that was created moments ago, and starting them in order
    // means a failure names the candidate it belongs to.
    for (const spec of specs) {
      // "" and null both mean "the default", exactly as they do on a
      // SessionLink -- a one-pane page is spawned by callers that carry
      // a rail's launch, not only by best-of-N's real worktree paths.
      sessionIds.push(await backend.createSession(spec.cwd || undefined, spec.command ?? undefined));
    }
  } catch (e) {
    setError(String(e));
    for (const id of sessionIds) void backend.killSession(id).catch(() => {});
    return null;
  }

  const pageId = crypto.randomUUID();
  const created = workspace.createPage(state, workspaceId, pageId, name, layout.presetTiled(sessionIds));
  const focusedSessionId = sessionIds[0] ?? null;
  const data = workspace.setPageFocus(created, workspaceId, pageId, focusedSessionId);
  const activate = opts.activate !== false;
  const workspaces = activate
    ? data.workspaces
    : data.workspaces.map((w) => (w.id === workspaceId ? { ...w, activePageId: previousPageId } : w));
  layoutState.update((s) => ({
    ...s,
    workspaces,
    activeWorkspaceId: activate ? workspaceId : s.activeWorkspaceId,
    focusedSessionId: activate ? focusedSessionId : s.focusedSessionId,
  }));
  await persistWorkspaces(workspaces, data.activeWorkspaceId);
  return { pageId, sessionIds };
}

/// ONE session, and a page built AROUND it: the session is the new
/// page's first and only tab.
///
/// The distinction from `createPage` + `createSessionOnPage` -- what
/// every "make the page, then land the session on it" flow used to be --
/// is the blank shell that pairing leaves behind. `createPage` opens the
/// page with fresh shells of its OWN, so the session the page was made
/// FOR arrives as tab two, behind an idle terminal nobody asked for and
/// first in the strip for the life of the page. When a page exists
/// because something is about to run on it, that something is its first
/// tab.
///
/// `createPage` stays right for the human-facing "+": there the blank
/// shell IS the ask.
export async function createSessionOnNewPage(
  workspaceId: string,
  name: string,
  cwd: string,
  command: string | null,
  opts: { activate?: boolean } = {}
): Promise<{ pageId: string; sessionId: string } | null> {
  const made = await createTiledPage(workspaceId, name, [{ cwd, command }], opts);
  return made ? { pageId: made.pageId, sessionId: made.sessionIds[0] } : null;
}

// Creates a fresh session for a kanban card link, homing it in the given
// workspace: added as a new tab on the workspace's active page if it has
// one, or a freshly created single-pane page (mirroring createPage's own
// default preset) if the workspace has zero pages yet. Unlike
// splitPane/addTab, this always targets an explicit workspaceId rather
// than "whichever page/workspace is currently active" -- the kanban hub
// this is called from is not necessarily showing a terminal view at all.
// cwd/command mirror SessionLink's own shape ("" / null both mean
// "use the default"), converted to undefined here -- the one place that
// conversion happens, so every caller (create-new, re-launch) can just
// pass a SessionLink's fields straight through.
/// createSessionForCard, but landing on a NAMED page rather than the
/// workspace's active one -- what an orchestration rail needs, since a
/// rail binds to a page (orchestration spec §4.3). A null or unknown
/// pageId falls back to createSessionForCard's behavior, which is the
/// Agents-page posture.
export async function createSessionOnPage(
  workspaceId: string,
  pageId: string | null,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const page = pageId ? ws?.pages.find((p) => p.id === pageId) : undefined;
  if (!ws || !page) return createSessionForCard(workspaceId, cwd, command);

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor
    ? layout.addTab(page.layout, anchor, sessionId)
    : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, page.id, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, page.id, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}

export async function createSessionForCard(
  workspaceId: string,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }

  if (ws.pages.length === 0) {
    const pageId = crypto.randomUUID();
    const created = workspace.createPage(state, workspaceId, pageId, "Page 1", layout.presetSingle(sessionId));
    const data = workspace.setPageFocus(created, workspaceId, pageId, sessionId);
    layoutState.update((s) => ({
      ...s,
      workspaces: data.workspaces,
      activeWorkspaceId: workspaceId,
      focusedSessionId: sessionId,
    }));
    await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
    return sessionId;
  }

  const pageId = ws.activePageId ?? ws.pages[0].id;
  const page = ws.pages.find((p) => p.id === pageId);
  if (!page) return sessionId;
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor ? layout.addTab(page.layout, anchor, sessionId) : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}

export async function renamePage(workspaceId: string, pageId: string, name: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.renamePage(state, workspaceId, pageId, name);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function switchPage(workspaceId: string, pageId: string): Promise<void> {
  const state = get(layoutState);
  const switchedPage = workspace.switchPage(state, workspaceId, pageId);
  const switched = activateWorkspace(switchedPage, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

// Kills every session in the page, then removes it -- same escalation as
// closeWorkspace, one level down. Confirm-before prompting is the
// caller's responsibility.
export async function closePage(workspaceId: string, pageId: string): Promise<void> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const sessionIds = layout.allSessionIds(page.layout);

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById, state.cardTabsById);
  if (!closed) return;
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  let updated = workspace.removePage(state, workspaceId, pageId);
  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

export type DropTarget =
  | {
      kind: "page";
      workspaceId: string;
      pageId: string;
      mode: "left" | "right" | "top" | "bottom" | "center";
      // The specific pane within the target page this drop was aimed at,
      // if known (e.g. Pane.svelte always knows its own active tab).
      // Sidebar drops have no specific pane in mind -- the target page
      // isn't rendered while dragging from the sidebar -- so they omit
      // this, and movePaneOrTab falls back to the page's own remembered
      // focus, exactly as it did before this field existed.
      targetSessionId?: string;
      // Where in that pane's tab bar a mode: "center" merge lands. Set
      // only by a drop ON the bar, which draws an insertion caret under
      // the pointer and so has to be obeyed; every other center drop --
      // the sidebar's, or one on the pane's body -- names no position and
      // omits this, keeping the append it has always done.
      targetIndex?: number;
    }
  | { kind: "workspace"; workspaceId: string };

// Moves a whole pane (source.kind === "pane") or a single tab
// (source.kind === "tab") from wherever it currently lives to the given
// target. Handles cross-page and same-page moves uniformly -- when
// source and target page happen to be identical, detach+graft still
// applies, they just both land on that one page's own layout, producing
// a single write instead of two. Dropping onto a workspace (not a
// specific page) always creates a brand-new page there; dropping onto a
// page either grafts a new split in one of 4 directions, or merges as a
// new tab into that page's remembered focused pane (mode "center"). No
// daemon calls are ever made -- this is pure restructuring of the
// already-loaded workspaces array, then a persist.
export async function movePaneOrTab(
  source: { kind: "pane" | "tab"; workspaceId: string; pageId: string; sessionId: string },
  target: DropTarget
): Promise<void> {
  const state = get(layoutState);
  const sourcePage = state.workspaces
    .find((w) => w.id === source.workspaceId)
    ?.pages.find((p) => p.id === source.pageId);
  if (!sourcePage) return;

  // No explicit "same page = no-op" guard here, deliberately: a page can
  // hold multiple panes (e.g. a 2x2 grid), and dragging one pane onto
  // another pane *within that same page* is a legitimate rearrangement,
  // not a no-op -- it produces a genuinely different tree (detach pane A,
  // graft it back in next to pane B in the chosen direction). The one
  // truly degenerate case -- detaching a page's ONLY pane and dropping it
  // back onto that same, now-just-removed page -- is already handled
  // correctly below without a special case: after workspace.removePage
  // runs, that page id no longer exists in `data` at all, so the
  // `if (!targetPage) return;` check further down fails to find it and
  // the whole operation aborts cleanly, before anything is written to the
  // store or persisted.
  const detachResult =
    source.kind === "pane"
      ? layout.detachLeaf(sourcePage.layout, source.sessionId)
      : layout.detachTab(sourcePage.layout, source.sessionId);
  if (!detachResult) return;
  const { tree: sourceTreeAfterDetach, detached } = detachResult;

  let data = sourceTreeAfterDetach
    ? workspace.updatePageLayout(state, source.workspaceId, source.pageId, sourceTreeAfterDetach)
    : workspace.removePage(state, source.workspaceId, source.pageId);

  if (target.kind === "workspace") {
    const targetWs = data.workspaces.find((w) => w.id === target.workspaceId);
    if (!targetWs) return;
    const pageId = crypto.randomUUID();
    data = workspace.createPage(
      data,
      target.workspaceId,
      pageId,
      `Page ${targetWs.pages.length + 1}`,
      detached
    );
  } else {
    const targetPage = data.workspaces
      .find((w) => w.id === target.workspaceId)
      ?.pages.find((p) => p.id === target.pageId);
    if (!targetPage) return;
    // If a specific pane was targeted and it's still present in the
    // (already-detached) target tree, aim the graft/merge at exactly
    // that pane. Otherwise fall back to the page's remembered focus
    // (mergeIntoActivePane's own existing fallback) or a whole-tree graft
    // (graftLeaf) -- the same behavior this had before targetSessionId
    // existed, still correct for Sidebar-originated drops which never
    // set it.
    const hasValidTarget =
      target.targetSessionId !== undefined && layout.findLeafPath(targetPage.layout, target.targetSessionId) !== null;
    const newTargetTree =
      target.mode === "center"
        ? layout.mergeIntoActivePane(
            targetPage.layout,
            hasValidTarget ? (target.targetSessionId as string) : targetPage.focusedSessionId,
            detached,
            target.targetIndex
          )
        : hasValidTarget
          ? layout.graftLeafAt(targetPage.layout, target.targetSessionId as string, detached, target.mode)
          : layout.graftLeaf(targetPage.layout, detached, target.mode);
    data = workspace.updatePageLayout(data, target.workspaceId, target.pageId, newTargetTree);
  }

  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

// Reorders a tab within its own pane's tab bar -- always scoped to the
// active page, since dragging to reorder only ever happens on something
// currently rendered on screen.
export async function reorderTabWithinPane(sessionId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = layout.moveTabWithinLeaf(location.tree, sessionId, targetIndex);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Pins or unpins a tab in the active page. The layout helpers keep pinned
// tabs as a prefix of the pane's tab list, so the tab visibly moves.
// Scoped to the tab's own page, not the active one -- see
// pageLocationForSession. Unlike splitPane this deliberately does NOT
// bring that page on screen: pinning is a bookkeeping change to where a
// tab sits in its own bar, and yanking the view away from what the user
// is looking at would be a far bigger side effect than the edit itself.
export async function setTabPinned(sessionId: string, pinned: boolean): Promise<void> {
  const state = get(layoutState);
  const location = pageLocationForSession(state, sessionId);
  if (!location) return;
  const newTree = pinned
    ? layout.pinTab(location.tree, sessionId)
    : layout.unpinTab(location.tree, sessionId);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function reorderWorkspaceAction(workspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const data = workspace.reorderWorkspace(state, workspaceId, targetIndex);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Moves a page to a new position (reorder within its workspace, or move
// to a different one). If the moved page was the currently active one,
// the app follows it -- activeWorkspaceId (and that workspace's own
// activePageId) switch to keep showing the same page, rather than
// silently changing what's on screen out from under the user mid-drag.
export async function movePageAction(pageId: string, targetWorkspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const wasActivePage = workspace.getActivePage(state)?.id === pageId;
  let data = workspace.movePage(state, pageId, targetWorkspaceId, targetIndex);
  if (wasActivePage) {
    data = activateWorkspace(workspace.switchPage(data, targetWorkspaceId, pageId), targetWorkspaceId);
  }
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}
