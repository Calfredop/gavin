import type { AgentDefaults } from "$lib/cards/complexity";
import type { PauseCycle } from "$lib/agents/agentPause";
import type { AgentUsageReport } from "$lib/agents/agentUsage";
import type { SystemMemorySample, WatchmanSample } from "$lib/agents/memory";
import type { LaunchConfig } from "$lib/agents/launchGate";
import type { PrReport } from "$lib/git/pullRequest";
import type { CardRun, TokenReport } from "$lib/cards/runHistory";
import type { ConversationLog } from "$lib/cards/cardRun";
import { invoke } from "@tauri-apps/api/core";
import type { GitStatus, RemovedWorkspace, Workspace, WorkspacesData } from "$lib/core/workspace";
import type { Board, Column, Label } from "$lib/board/kanban";
import type { SuperpowersMark, SuperpowersStatus } from "$lib/agents/superpowers";
import type { GavinTracking } from "$lib/git/gitTracking";
import type { IgnoreKind } from "$lib/git/gitIgnore";
import type { BoardTab, CardTab, GavinTree } from "$lib/core/gavin";
import type { ApplyMode, CommitDetail, ConflictInfo, DiscardReport, FileDiff, FileEntry, InProgressKind, LogPage, RefsSnapshot, RepoInfo, ResetMode, RunChanges, StatusResult } from "$lib/git/git";
import type { ConflictNote, Orchestration, Rail, RailState, StepState } from "$lib/orchestration/orchestration";
import type { ToolRecord } from "$lib/orchestration/orchestrationTools";
import type { ToolRun } from "$lib/workspace/workspaceTools";
import type { GroupTemplateRecord } from "$lib/orchestration/orchestrationGroups";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import type { SessionStatus } from "$lib/core/notifications";
import type { OrphanProcess } from "$lib/sessions/orphan";
import type { QueuedInput } from "$lib/agents/queuedInput";
import type { ManagedSessions } from "$lib/sessions/sessionsManager";
import type { GavinFootprint, McpFootprint, RemovalReport } from "$lib/workspace/workspaceDelete";
import type { AttachmentStatus } from "$lib/cards/attachments";
import type { AvailableUpdate, UpdateSettings } from "$lib/shell/updates";

/// `workspaceRoot` is the workspace the session BELONGS to, as distinct
/// from `cwd`, where it runs. The two differ whenever gavin launches into
/// a worktree — a rail step, a best-of-N candidate — and the daemon keeps
/// them apart because its agent scope gate reads both: an agent confined
/// to its cwd alone is refused every write to the card it was launched
/// for, which lives in the main checkout. Omit it only where there is no
/// workspace to name.
export function createSession(
  cwd?: string,
  command?: string,
  workspaceRoot?: string
): Promise<string> {
  return invoke("create_session", { cwd, command, workspaceRoot });
}


export function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
}

/// Whether the daemon narrows an untokened local connection
/// (`require_local_token`). The daemon reads the same marker file per
/// request, so this reflects the live state.
export function getRequireLocalToken(): Promise<boolean> {
  return invoke("get_require_local_token");
}

/// Turn `require_local_token` on or off. Off (the default) keeps today's
/// full reach for untokened local connections; on refuses them the
/// process-starting requests until they present a token.
export function setRequireLocalToken(enabled: boolean): Promise<void> {
  return invoke("set_require_local_token", { enabled });
}

export function getFileTabs(): Promise<Record<string, string>> {
  return invoke("get_file_tabs");
}

export function setFileTabs(fileTabs: Record<string, string>): Promise<void> {
  return invoke("set_file_tabs", { fileTabs });
}

export function readFileForViewer(
  path: string
): Promise<{ content: string; truncated: boolean; exists: boolean }> {
  return invoke("read_file_for_viewer", { path });
}

export function writeFileForEditor(path: string, content: string): Promise<void> {
  return invoke("write_file_for_editor", { path, content });
}

export function resolvePathUnderCursor(candidate: string, cwd: string): Promise<string | null> {
  return invoke("resolve_path_under_cursor", { candidate, cwd });
}

export function tempDir(): Promise<string> {
  return invoke("temp_dir");
}

/// The Files tab's directory explorer. Every one of these takes the
/// workspace ROOT alongside its target and the host refuses anything
/// that resolves outside it -- see fileviewer.rs. One `list_directory`
/// per opened folder, never a recursive walk and never a watcher: the
/// tree refreshes on demand and after its own mutations.
export function listDirectory(
  root: string,
  path: string
): Promise<{ name: string; isDir: boolean; size: number; symlink: boolean }[]> {
  return invoke("list_directory", { root, path });
}

/// Creates an empty file. Rejects an existing path rather than
/// truncating it.
export function createFile(root: string, path: string): Promise<void> {
  return invoke("create_file", { root, path });
}

/// Creates one directory. A missing parent is an error, not a folder to
/// invent.
export function createDirectory(root: string, path: string): Promise<void> {
  return invoke("create_directory", { root, path });
}

/// Renames or moves an entry inside the root. Refuses to overwrite the
/// destination -- `fs::rename` would do it silently, turning a mistyped
/// rename into a delete with no trip through the Trash.
export function renamePath(root: string, from: string, to: string): Promise<void> {
  return invoke("rename_path", { root, from, to });
}

/// Moves an entry to the OS Trash, through the same route the workspace
/// delete wizard takes. Nothing gavin removes on the human's behalf is
/// unrecoverable.
///
/// `token` comes from `confirmGate.ts` and names this exact path: the
/// host refuses the call without one, so the Trash prompt is a
/// precondition rather than a convention (AS-05/R5). Same for
/// `deleteCardFile`, `removeGavinFootprint` and `restartDaemon` below.
export function trashEntry(root: string, path: string, token: string): Promise<void> {
  return invoke("trash_entry", { root, path, token });
}

/// Hands `path` to the OS's default application, and `revealPath` selects
/// it in the file manager. Both used to be the opener plugin's own
/// `openPath`/`revealItemInDir`, invoked straight from the page: one was
/// scoped to `/**` and `**`, the other to nothing at all, so from a
/// compromised page they launched any app or file on disk (AS-09/R5).
/// The host now answers them against the open workspace roots, a scope
/// that changes while the app runs and so cannot be a static capability.
///
/// A path outside every open workspace rejects with a message naming it;
/// every call site already has somewhere to show that.
export function openPathExternally(path: string): Promise<void> {
  return invoke("open_path_externally", { path });
}

export function revealPathExternally(path: string): Promise<void> {
  return invoke("reveal_path_externally", { path });
}

export function viewableExtensions(): Promise<string[]> {
  return invoke("viewable_extensions");
}

/// One entry per requested path, in the order given, classified by
/// `location` (`attachments.ts` owns what each value means and what to
/// do with it). `absolutePath` is null only for a `refused` entry --
/// resolved against `root`, the checkout the agent will run in: the
/// workspace root for a board Run, the rail's worktree for a step on a
/// bound rail (`resolveAttachmentsForRun` in `cardRunActions.ts` decides).
export function attachmentStatus(root: string, paths: string[]): Promise<AttachmentStatus[]> {
  return invoke("attachment_status", { root, paths });
}

export function watchFileForViewer(path: string): Promise<void> {
  return invoke("watch_file_for_viewer", { path });
}

export function unwatchFileForViewer(path: string): Promise<void> {
  return invoke("unwatch_file_for_viewer", { path });
}

export function getWorkspacesState(): Promise<WorkspacesData> {
  return invoke("get_workspaces_state");
}

export function setWorkspacesState(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  removedWorkspaces: RemovedWorkspace[]
): Promise<void> {
  return invoke("set_workspaces_state", { workspaces, activeWorkspaceId, removedWorkspaces });
}

/// Where every workspace currently is: workspace id -> window label, with
/// absence meaning the main window. See workspace_window.rs -- the map is
/// ephemeral, so this is a fact about right now, never about the config.
export function workspaceWindows(): Promise<Record<string, string>> {
  return invoke("workspace_windows");
}

/// Opens a window for a workspace, answering with the label that now
/// holds it. Idempotent: a workspace that already has a window is raised
/// rather than given a second one.
export function openWorkspaceWindow(workspaceId: string): Promise<string> {
  return invoke("open_workspace_window", { workspaceId });
}

/// Records that a workspace belongs to THIS window -- one created here,
/// or re-keyed onto a removed workspace's id. Without it, a workspace the
/// registry has never heard of reads as the main window's.
export function claimWorkspaceWindow(workspaceId: string): Promise<void> {
  return invoke("claim_workspace_window", { workspaceId });
}

/// Brings the window a workspace is already in to the front.
export function focusWorkspaceWindow(workspaceId: string): Promise<void> {
  return invoke("focus_workspace_window", { workspaceId });
}

/// Closes the window a workspace lives in, if it has one of its own. A
/// no-op for a workspace in the main window.
/// Closes every window a workspace was given, leaving the main window
/// -- the one asking -- for its own caller to destroy last. One round
/// trip rather than one per label: the close prompt is on its way out
/// and has no business awaiting N of them.
export function closeAllWorkspaceWindows(): Promise<void> {
  return invoke("close_all_workspace_windows");
}

export function closeWorkspaceWindow(workspaceId: string): Promise<void> {
  return invoke("close_workspace_window", { workspaceId });
}

/// The app-global light/dark preference. null means System -- the Rust
/// side stores absence rather than the literal string.
export function getThemePref(): Promise<string | null> {
  return invoke("get_theme_pref");
}

export function setThemePref(theme: string | null): Promise<void> {
  return invoke("set_theme_pref", { theme });
}

/// App-wide default model per agent profile id. A workspace with no model
/// of its own inherits the entry for the profile it runs -- machine-local
/// (it lives in config.json beside the theme), unlike the workspace's own
/// model, which is a committed project fact in config.toml.
export function getAgentModelDefaults(): Promise<Record<string, string>> {
  return invoke("get_agent_model_defaults");
}

/// An empty model removes the default rather than storing a blank.
export function setAgentModelDefault(profileId: string, model: string): Promise<void> {
  return invoke("set_agent_model_default", { profileId, model });
}

/// The app-wide terminal font size. null means none was ever set -- the
/// Rust side stores absence rather than repeating the default, the same
/// convention the theme uses, so changing gavin's default moves every
/// install that never chose one.
export function getTerminalFontSize(): Promise<number | null> {
  return invoke("get_terminal_font_size");
}

export function setTerminalFontSize(size: number | null): Promise<void> {
  return invoke("set_terminal_font_size", { size });
}

/// The app-wide default for a new card's auto-commit block. null means
/// none was ever set -- same absence-not-the-default convention as the
/// theme and the font size, so a change to gavin's default reaches every
/// install that never chose. Distinct from `false`, which is an install
/// that chose OFF and must stay off whatever the default becomes.
export function getAutoCommit(): Promise<boolean | null> {
  return invoke("get_auto_commit");
}

export function setAutoCommit(enabled: boolean | null): Promise<void> {
  return invoke("set_auto_commit", { enabled });
}

/// The app-wide default for whether a card must be reviewed before its
/// first Run (`cardReview.ts`, AG-01). null means none was ever set -- same
/// absence-not-the-default convention as the theme, the font size and the
/// auto-commit block. Distinct from `false`, which is an install that
/// chose OFF and must stay off whatever gavin's default becomes.
///
/// Unlike `getGitTrackingDefault`, this is live rather than an
/// initialisation-only seed: a workspace with no override resolves against
/// this value at the moment of every check.
export function getRequireReview(): Promise<boolean | null> {
  return invoke("get_require_review");
}

export function setRequireReview(enabled: boolean | null): Promise<void> {
  return invoke("set_require_review", { enabled });
}

/// The app-wide default a NEW workspace's init starts from. Same
/// absence-not-the-default convention as the theme, the font size and the
/// auto-commit block: null means nobody chose, `false` means an install
/// that chose OFF and must stay off whatever gavin's default becomes.
///
/// A default only. What an EXISTING workspace does is written in its own
/// repo's `.gitignore` and read back through `gavinGitTracking` -- there
/// is no second copy here to keep in step.
export function getGitTrackingDefault(): Promise<boolean | null> {
  return invoke("get_git_tracking_default");
}

export function setGitTrackingDefault(tracked: boolean | null): Promise<void> {
  return invoke("set_git_tracking_default", { tracked });
}

/// What git says about gavin's files under this root, right now. Nothing
/// is cached on either side: `.gitignore` is a file the human may have
/// edited by hand since the last look.
export function gavinGitTracking(root: string): Promise<GavinTracking> {
  return invoke("gavin_git_tracking", { root });
}

/// Writes (or removes) gavin's ignore block and reports where that left
/// things. `untrack` is only ever meaningful for turning tracking OFF, and
/// it stages deletions -- so it carries the human's answer to a question
/// they were asked by name, never the toggle's own implication.
export function setGavinGitTracking(
  root: string,
  tracked: boolean,
  untrack: boolean
): Promise<GavinTracking> {
  return invoke("set_gavin_git_tracking", { root, tracked, untrack });
}

/// One reading of the machine's memory. Straight to Tauri, like the
/// usage probe: this is a sysctl read on the host, so it keeps working
/// across a version skew that has every gavin_* tool failing closed --
/// which is exactly when somebody is most likely to be running a lot of
/// agents at once.
export function systemMemory(): Promise<SystemMemorySample> {
  return invoke("system_memory");
}

/// The live watchman server, or null when there is not one. Never starts
/// one: the host establishes the pid first and only then runs the CLI,
/// because every watchman subcommand -- `watch-list` included -- spawns a
/// server when none is running.
export function watchmanStatus(): Promise<WatchmanSample | null> {
  return invoke("watchman_status");
}

/// Tells a live watchman to stop watching a root. A machine with no
/// server resolves without doing anything: there is nothing holding the
/// root, which is the state the caller wanted.
export function watchmanForget(root: string): Promise<void> {
  return invoke("watchman_forget", { root });
}

/// The app-wide agent pause cycle, machine-local beside the theme.
/// `null` is no cycle at all, which is the shipped default.
export function getAgentPause(): Promise<PauseCycle | null> {
  return invoke("get_agent_pause");
}

/// Replaces it; `null` clears it. The ANCHOR is the caller's to supply
/// and the host never rewrites it -- stamping `now` on every save would
/// slide the pause forward each time somebody nudged a field, so the
/// cycle would never fire for anyone who kept adjusting it.
export function setAgentPause(agentPause: PauseCycle | null): Promise<void> {
  return invoke("set_agent_pause", { agentPause });
}

/// The app-wide launch wall: how many agent turns may be in flight at
/// once, and whether memory pressure holds new ones. `null` means nobody
/// has expressed a preference and gavin's own default applies -- absence
/// rather than the struct, so a later change to the shipped ceiling
/// reaches every install that never touched it.
export function getLaunchConfig(): Promise<LaunchConfig | null> {
  return invoke("get_launch_config");
}

/// Replaces it wholesale, the same shape as `setAgentPause`: the panel
/// holds both fields, so there is no per-key command and no way for one
/// to be saved while the other is dropped.
export function setLaunchConfig(launch: LaunchConfig | null): Promise<void> {
  return invoke("set_launch_config", { launch });
}

/// The app-wide resume flag for the `custom` agent profile (v38), e.g.
/// `--resume`. `null` means nobody has set one, so `custom` resumes not
/// at all -- absence rather than "", the same convention `launch` above
/// takes. A workspace's own override lives on `Workspace.customResumeArgs`
/// instead, alongside `terminalFontSize` and `color`, since it travels
/// with the ordinary workspaces save rather than its own command.
export function getCustomResumeArgs(): Promise<string | null> {
  return invoke("get_custom_resume_args");
}

/// Replaces the app-wide `custom` resume flag; `null` clears it.
export function setCustomResumeArgs(customResumeArgs: string | null): Promise<void> {
  return invoke("set_custom_resume_args", { customResumeArgs });
}

/// The app-wide custom agent (command + model flag) and the complexity
/// table. Machine-local beside the theme and the model defaults, and for
/// the same reason: which CLI is installed here and which model tier this
/// human will spend on a hard card is a fact about this machine, not
/// about the project. Straight to Tauri, so all of it keeps working
/// across a version skew that has every gavin_* tool failing closed.
export function getAgentDefaults(): Promise<AgentDefaults> {
  return invoke("get_agent_defaults");
}

/// Replaces the whole struct. Wholesale rather than per key, the same
/// shape as `setAgentPause`: the panel already holds every field, and a
/// per-key command is how one of them ends up saved while another is
/// dropped.
export function setAgentDefaults(agentDefaults: AgentDefaults): Promise<void> {
  return invoke("set_agent_defaults", { agentDefaults });
}

/// Superpowers plugin status for one workspace root. Straight to Tauri,
/// like the model defaults above: the detector reads the local checkout
/// and the marker lives in the app's own config.json, so none of this
/// needs a daemon request and all of it keeps working across a version
/// skew that has every gavin_* tool failing closed.
///
/// `agentCommand` is the workspace's RESOLVED launch command, whose first
/// token is the binary the detector drives. It is passed rather than read
/// from config.toml host-side because this call fires on a TAB RENDER:
/// a cloned repo naming `[agent] command = "./scripts/setup.sh"` would
/// otherwise have that script executed by merely opening the workspace.
/// Pass what `trustedAgentConfigs` resolved -- the repo's command only
/// once the human approved this config, the profile's until then.
/// `profileId` overlays the workspace's active agent so setup-only
/// arming can probe Codex while `[agent] profile` still names Claude.
export function superpowersStatus(
  rootPath: string,
  agentCommand: string,
  profileId?: string
): Promise<SuperpowersStatus> {
  return invoke("superpowers_status", { rootPath, agentCommand, profileId });
}

/// Runs the install and returns the status that follows it. A failed
/// install is not a rejection -- the returned status carries the run's
/// stdout and stderr for the drawer, and its state is what the detector
/// says afterwards. Rejects only when no install was attempted: a profile
/// gavin must not install into, or a binary it could not spawn.
/// `agentCommand`: as `superpowersStatus` above.
/// `profileId`: as `superpowersStatus` — fallback arming names the chain
/// agent so Install does not write the workspace's active CLI.
export function superpowersInstall(
  rootPath: string,
  agentCommand: string,
  profileId?: string
): Promise<SuperpowersStatus> {
  return invoke("superpowers_install", { rootPath, agentCommand, profileId });
}

/// What the human has told gavin, keyed by workspace root path.
export function getSuperpowersMarks(): Promise<Record<string, SuperpowersMark>> {
  return invoke("get_superpowers_marks");
}

/// `null` forgets what was said, so someone who asserted an install and
/// then removed it has a way back to the honest answer.
export function setSuperpowersMark(
  rootPath: string,
  mark: SuperpowersMark | null
): Promise<void> {
  return invoke("set_superpowers_mark", { rootPath, mark });
}

// Set once by layoutState.ts's bootstrap() -- both real input paths in
// this app (terminalRegistry.ts's per-keystroke term.onData, and
// clipboard.ts's paste action) already call writeInput directly, so
// hooking in here is the one choke point that covers both without either
// of those modules needing to import layoutState.ts back (which would be
// circular, since layoutState.ts already imports terminalRegistry.ts).
let onWriteInput: ((sessionId: string) => void) | null = null;

export function setOnWriteInputHook(handler: (sessionId: string) => void): void {
  onWriteInput = handler;
}

export function writeInput(sessionId: string, data: string): Promise<void> {
  onWriteInput?.(sessionId);
  return invoke("write_input", { sessionId, data });
}

// The four follow-up-queue calls. Every one of them answers with the
// queue it left behind, so a caller never has to wait for the
// `queued-inputs-changed` push to learn what its own request did -- the
// push is what tells the OTHER surfaces watching the same session.

/// Holds a follow-up for a session, or hands it over at once if that
/// session is already idle. Which of the two happens is the daemon's
/// call: the app does not have to know a session's status to queue for
/// it, and a status it read a moment ago would be the wrong one anyway.
export function queueInput(sessionId: string, text: string): Promise<QueuedInput[]> {
  return invoke("queue_input", { sessionId, text });
}

/// Every session's pending follow-ups, flat. The read-back for
/// `queuedInputsById`: `QueuedInputsChanged` is routed to a session's
/// attached writer, so a frontend that reloaded has missed every push
/// the daemon ever sent it.
export function listQueuedInputs(): Promise<QueuedInput[]> {
  return invoke("list_queued_inputs");
}

/// The queue this session should have from now on, in order. Anything
/// omitted is dropped -- one writer for reorder, cancel and clear.
export function setQueuedInputs(sessionId: string, queuedIds: string[]): Promise<QueuedInput[]> {
  return invoke("set_queued_inputs", { sessionId, queuedIds });
}

/// Deliver one queued follow-up now, whatever the session is doing --
/// the override for an agent the human has decided not to wait for.
export function sendQueuedInput(sessionId: string, queuedId: string): Promise<QueuedInput[]> {
  return invoke("send_queued_input", { sessionId, queuedId });
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_session", { sessionId, cols, rows });
}

/// Asks the daemon to repaint this session's terminal from its own model of
/// the screen. See the Rust command for why a reloaded frontend needs it and
/// why it isn't a second Attach.
export function snapshotSession(sessionId: string): Promise<void> {
  return invoke("snapshot_session", { sessionId });
}

export function getSessionNames(): Promise<Record<string, string>> {
  return invoke("get_session_names");
}

/// Whether `sessionId` is still running -- and, when it is, attaches to
/// it so its output and exit reach this window. The recovery path for a
/// HIDDEN run (the Git tab's commit agent) that outlived the window that
/// launched it: bootstrap only reconciles sessions a page references, and
/// a hidden one is referenced by none.
export function adoptSession(sessionId: string): Promise<boolean> {
  return invoke<boolean>("adopt_session", { sessionId });
}

export function setSessionName(sessionId: string, name: string): Promise<void> {
  return invoke("set_session_name", { sessionId, name });
}

export function signalFrontendReady(): Promise<void> {
  return invoke("signal_frontend_ready");
}

export function getBootstrapError(): Promise<string | null> {
  return invoke("get_bootstrap_error");
}

// Resolves true when the app is fully reconnected, false when the daemon
// was restarted but this app process needs a relaunch to rewire.
export function restartDaemon(token: string): Promise<void> {
  return invoke("restart_daemon", { token });
}

/// Stops the daemon on this build's endpoint and leaves it stopped --
/// the difference from `restartDaemon`, which exists to bring it back.
/// Gated: the token must have been minted for a prompt that was on
/// screen (`confirm_gate.rs`).
export function stopDaemon(token: string): Promise<void> {
  return invoke("stop_daemon", { token });
}

/// The update channel, described without touching the network:
/// this build's version, the endpoint it would poll, and whether it has
/// a channel and a pinned key at all (`updater.rs`).
export function updateSettings(): Promise<UpdateSettings> {
  return invoke("update_settings");
}

/// Point this install at a different manifest, or clear the override
/// with null and fall back to the one the build shipped with.
export function setUpdateEndpoint(endpoint: string | null): Promise<void> {
  return invoke("set_update_endpoint", { endpoint });
}

/// Ask the endpoint whether there is a newer release. Null means this
/// install is current. A read -- nothing is downloaded here.
export function checkForUpdate(): Promise<AvailableUpdate | null> {
  return invoke("check_for_update");
}

/// Download, verify against the pinned key, install, and relaunch.
/// Gated: `version` is the confirm-gate subject, so a token minted for
/// one version cannot install another, and the host re-checks that the
/// endpoint still offers exactly it before installing. Does not return
/// on success -- the app is replaced.
export function installUpdate(version: string, token: string): Promise<void> {
  return invoke("install_update", { version, token });
}

// The compat verdict from the most recent connect/reconnect. null before
// the first successful probe -- see DaemonCompatState on the Rust side.
export function daemonCompat(): Promise<DaemonCompat | null> {
  return invoke("daemon_compat");
}

// Fire-and-forget: rides the streaming connection, so there is no reply --
// the initial scan arrives as the first gavin-tree-changed event.
export function watchGavinRoot(workspaceId: string, rootPath: string): Promise<void> {
  return invoke("watch_gavin_root", { workspaceId, rootPath });
}

export function unwatchGavinRoot(workspaceId: string): Promise<void> {
  return invoke("unwatch_gavin_root", { workspaceId });
}

export function getGavinTree(workspaceId: string): Promise<GavinTree> {
  return invoke("get_gavin_tree", { workspaceId });
}

export function initGavinRoot(rootPath: string, workspaceName: string): Promise<void> {
  return invoke("init_gavin_root", { rootPath, workspaceName });
}

export function createGavinContext(parentFolder: string): Promise<void> {
  return invoke("create_gavin_context", { parentFolder });
}

// Scaffolds .gavin in a folder OUTSIDE the workspace root and registers
// it in the root config's extra_contexts so scans include it.
export function addExternalGavinContext(rootPath: string, folder: string): Promise<void> {
  return invoke("add_external_gavin_context", { rootPath, folder });
}

// Unregisters an outside folder; its files are left untouched.
export function removeExternalGavinContext(rootPath: string, folder: string): Promise<void> {
  return invoke("remove_external_gavin_context", { rootPath, folder });
}

/// Answers for the host when the root belongs to an ssh workspace, and
/// rejects when that host is not linked -- there is no disk to ask.
export function gavinRootExists(rootPath: string): Promise<boolean> {
  return invoke("gavin_root_exists", { rootPath });
}

/// Links an ssh workspace to its host: opens the host's link if this is
/// the first workspace on it, resolves the workspace's sessions on that
/// daemon, attaches them, watches the root, and emits `workspaces-synced`
/// (origin `remote:<host>`) with the resolved layout plus
/// `remote-link-ready`. Rejects with ssh's own words when the host cannot
/// be reached or has no `gavin-daemon`. Up to ten seconds on a dead host
/// (`ConnectTimeout`); the host runs it off the main thread.
export function connectRemoteWorkspace(workspaceId: string): Promise<void> {
  return invoke("connect_remote_workspace", { workspaceId });
}

export function getBoardTabs(): Promise<Record<string, BoardTab>> {
  return invoke("get_board_tabs");
}

export function getCardTabs(): Promise<Record<string, CardTab>> {
  return invoke("get_card_tabs");
}

/// One live session's cwd/status/restored/interrupted, as
/// session::SessionBaseline.
export interface SessionBaseline {
  id: string;
  cwd: string;
  /// The daemon's own word for it, unparsed. Run through
  /// `parseSessionStatus` before it reaches the store: a status this
  /// build does not recognise must not read as `idle`.
  status: string;
  restored: boolean;
  /// The run this session held was killed with a previous daemon and its
  /// command was not re-run: a bare shell occupies the tab now. Read back
  /// here rather than only pushed, for the same reason the other three
  /// are -- the push is baselined on Attach, once per app PROCESS.
  interrupted: boolean;
  /// The process this session left RUNNING when its daemon died, if the
  /// daemon probed and found one. `null` from a daemon below v21 means
  /// "never probed" rather than "nothing survived"; see orphan.ts's
  /// orphanDetectionAvailable, which is the only thing allowed to tell
  /// those apart.
  orphan: OrphanProcess | null;
  /// Why this session is `failed`, in the agent's own words, or null.
  /// Baselined for the same reason as the rest -- the `session-failed`
  /// push arrives once per app PROCESS -- and it matters more: a red
  /// session with nothing to say for itself is the state this replaces.
  failureReason: string | null;
}

// The frontend learns cwd/status/restored/interrupted from pushes whose
// baseline the daemon only sends in reply to Attach -- and Attach happens once per app
// PROCESS, not per frontend load. This is how a reloaded frontend gets
// them back; see the Rust command's own doc comment.
export function getSessionBaselines(): Promise<SessionBaseline[]> {
  return invoke("get_session_baselines");
}

/// Ends the process a session left running after its daemon died.
///
/// Takes a session id and nothing else, deliberately: the daemon looks up
/// the pid IT recorded and re-probes its identity before signalling, so
/// no frontend path can aim a signal at an arbitrary process. `ended`
/// false with `stillRunning` true is a process refusing SIGTERM;
/// both false means it had already gone.
export function endOrphan(sessionId: string): Promise<{ ended: boolean; stillRunning: boolean }> {
  return invoke("end_orphan", { sessionId });
}

/// Every session the daemon holds, with one sample of what each costs.
///
/// A POLL, not a subscription: the task manager asks again while it is
/// open and stops when it closes. Unfiltered, unlike
/// `getSessionBaselines` -- exited rows and sessions no page is showing
/// are exactly what this list is for. See session::list_managed_sessions.
export function listManagedSessions(): Promise<ManagedSessions> {
  return invoke("list_managed_sessions");
}

/// Hands the daemon what THIS session's agent prints when it has stopped
/// because something broke, so a quiet agent that BROKE stops reading as
/// one that finished (`session::set_failure_patterns`).
///
/// Called once per agent session, right after it is created. Best-effort
/// on purpose: against a daemon older than v21 the request is refused
/// and a quiet agent reads as idle exactly as it always did, so no
/// caller has to branch on the daemon version to launch an agent.
export function setFailurePatterns(sessionId: string, patterns: string[]): Promise<void> {
  return invoke("set_failure_patterns", { sessionId, patterns });
}

/// The git half of the same read-back, one answer per cwd in the order
/// given -- `null` for a cwd inside no repository. Answered by the host
/// itself rather than the daemon, because GitStatusChanged is both
/// baselined on Attach (once per app PROCESS) and change-only after
/// that: nothing re-sends a status the repo has not altered. See the
/// Rust module's own doc comment.
export function getGitBaselines(cwds: string[]): Promise<(GitStatus | null)[]> {
  return invoke("get_git_baselines", { cwds });
}

export function setBoardTabs(boardTabs: Record<string, BoardTab>): Promise<void> {
  return invoke("set_board_tabs", { boardTabs });
}

export function setCardTabs(cardTabs: Record<string, CardTab>): Promise<void> {
  return invoke("set_card_tabs", { cardTabs });
}

/// One server entry a target MCP config already named that is not
/// gavin's own (AG-07) — command and args verbatim, the shape it would
/// actually launch in.
export interface ForeignMcpServer {
  name: string;
  command: string;
  args: string[];
}

/// What `setupAgentIntegration` found in the target MCP config that is
/// not gavin's, and where. Present on the result only while a decision
/// is outstanding; see `mcpServerTrust.ts`. `isolateRefusal` is set when
/// "isolate" is not available for this profile, so the UI can say why
/// beside the button rather than only after a click fails; absent would
/// mean isolate is available (not reachable for any stock profile yet).
export interface McpForeignServers {
  file: string;
  servers: ForeignMcpServer[];
  isolateRefusal?: string;
}

/// What a setup run wrote, and what it could not (spec §6). `skipped` is
/// [what, why] pairs, rendered verbatim so an unavailable MCP config is
/// visible rather than silent. `mcpForeign` is set instead of the MCP
/// config being written when the target file already names servers
/// gavin did not add and no `mcpForeignChoice` was supplied or matched.
export interface IntegrationResult {
  written: string[];
  skipped: Array<[string, string]>;
  /// The managed files whose previous contents were not gavin's own, as
  /// [file, where the displaced bytes were kept]. Apart from `written`
  /// because it is the only part of a run that says something was LOST,
  /// and empty on an ordinary re-run, which writes bytes that are
  /// already there.
  replaced: Array<[string, string]>;
  mcpForeign?: McpForeignServers;
}

/// `instructionsFile` is the workspace's RESOLVED agent file — the one
/// gavin's marker block is written into. Passed rather than read host-
/// side because `[agent] file` ships with the repository: pass what
/// `resolveAgentConfig` gave you, which workspace trust has already
/// gated, so the file gavin writes is the file its panels name.
///
/// `mcpForeignChoice` is "keep", "isolate", or omitted — the answer to
/// a foreign-server disclosure a previous call's `mcpForeign` returned.
/// Omit it (or pass a value that does not match what is on disk right
/// now) to have the MCP write held back and `mcpForeign` reported
/// instead, rather than assume any particular answer.
export function setupAgentIntegration(
  rootPath: string,
  instructionsFile: string,
  mcpForeignChoice?: "keep" | "isolate",
  profileId?: string
): Promise<IntegrationResult> {
  return invoke("setup_agent_integration", {
    rootPath,
    instructionsFile,
    mcpForeignChoice,
    profileId,
  });
}

export function createPlan(
  contextFolder: string,
  fileName: string,
  title: string,
  status?: string,
  priority?: string,
  body?: string,
  kind?: "note" | "task" | "plan",
  parent?: string,
  attachments?: string,
  complexity?: string
): Promise<string> {
  return invoke("create_plan", {
    contextFolder,
    fileName,
    title,
    status,
    priority,
    body,
    kind,
    parent,
    attachments,
    complexity,
  });
}

/// Resolves to the card's path AFTER the write: a status write can archive
/// the file into `plans/done/`, and callers holding a path as identity have
/// to follow it.
export function setPlanFrontmatterField(
  path: string,
  key:
    | "status"
    | "priority"
    | "order"
    | "title"
    | "kind"
    | "parent"
    | "labels"
    | "attachments"
    | "complexity"
    | "agent"
    | "model",
  value: string
): Promise<string> {
  return invoke("set_plan_frontmatter_field", { path, key, value });
}

export function setChecklistItem(
  path: string,
  lineIndex: number,
  expectedText: string,
  checked: boolean
): Promise<void> {
  return invoke("set_checklist_item", { path, lineIndex, expectedText, checked });
}

// Returns the created task card's path.
export function promoteChecklistItem(planPath: string, item: string): Promise<string> {
  return invoke("promote_checklist_item", { planPath, item });
}

export function getBoard(workspaceId: string): Promise<Board> {
  return invoke("get_board", { workspaceId });
}

export function setBoard(workspaceId: string, columns: Column[], labels: Label[]): Promise<void> {
  return invoke("set_board", { workspaceId, columns, labels });
}

export function deleteCardFile(path: string, token: string): Promise<void> {
  return invoke("delete_card_file", { path, token });
}

/// Moves a card into its context's `plans/archive/` (children included)
/// and resolves with the path it landed on -- the card's identity moves
/// with it, exactly as it does for a status write.
export function archiveCard(path: string): Promise<string> {
  return invoke("archive_card", { path });
}

/// Takes a card back out of the archive, filed by its status. Resolves
/// with its new path.
export function unarchiveCard(path: string): Promise<string> {
  return invoke("unarchive_card", { path });
}

export function linkCardSession(
  workspaceId: string,
  path: string,
  sessionId: string,
  cwd: string,
  command: string | null,
  /// The agent CLI's own conversation id for this run, and the directory
  /// it was LAUNCHED in -- not `cwd` above, which follows OSC 7 and
  /// drifts the moment the agent moves into a worktree. Both null for a
  /// profile with no verified resume argv, which falls back to a written
  /// reconstruction instead.
  conversationId: string | null = null,
  launchCwd: string | null = null,
  /// How many times gavin has resumed this run BY ITSELF. Unlike
  /// setStepRun's, this one OVERWRITES: a card binding is upserted whole
  /// by every call site, so null here means zero rather than "leave it
  /// alone" -- and zero is right for the fresh launches, which are most
  /// of them.
  resumeAttempts: number | null = null,
  /// The commit this run's checkout was on at launch (v26). Null when
  /// the run has no baseline -- outside a repo, on an unborn HEAD, or
  /// against a daemon too old to keep it (`baseShaForLaunch`). Written
  /// whole like the count above: a resume passes the one it found, a
  /// re-launch passes the one it just resolved.
  baseSha: string | null = null
): Promise<void> {
  return invoke("link_card_session", {
    workspaceId,
    path,
    sessionId,
    cwd,
    command,
    conversationId,
    launchCwd,
    resumeAttempts,
    baseSha,
  });
}

export function unlinkCardSession(workspaceId: string, path: string): Promise<void> {
  return invoke("unlink_card_session", { workspaceId, path });
}

/// Every run this card has had, newest first (v27). Empty for a card
/// nobody has launched -- never an error. Gate on
/// FEATURE_MIN_VERSION.runHistory before calling: an older daemon
/// refuses the request, and "your daemon does not keep run history" is a
/// different sentence from "this card has never been run".
export function cardRuns(workspaceId: string, path: string): Promise<CardRun[]> {
  return invoke("card_runs", { workspaceId, path });
}

/// What one run cost, read out of the agent CLI's own transcript by the
/// conversation id gavin minted for it. No daemon involved and no gate:
/// these are files on this machine, and the report names its own reason
/// when there is nothing to read.
export function cardRunTokens(
  profileId: string,
  conversationId: string | null
): Promise<TokenReport> {
  return invoke("card_run_tokens", { profileId, conversationId });
}

/// Whether the conversation a run recorded is still on this machine to
/// be reopened -- answered by the same resolver `cardRunTokens` reads
/// through, so a resume and a token read can never disagree about where
/// a transcript lives. `unknown` is the answer whenever gavin cannot
/// tell, and is the one that changes nothing.
export function conversationLog(
  profileId: string,
  conversationId: string | null
): Promise<ConversationLog> {
  return invoke("conversation_log", { profileId, conversationId });
}

export function deleteBoard(workspaceId: string): Promise<void> {
  return invoke("delete_board", { workspaceId });
}

// --- Removing gavin from a root (the delete wizard) -------------------------

/// Reports what gavin actually put into a root. Reads only; the wizard
/// walks six screens before anything is removed.
export function scanGavinFootprint(rootPath: string): Promise<GavinFootprint> {
  return invoke("scan_gavin_footprint", { rootPath });
}

/// Executes an approved plan: chosen paths to the OS Trash, gavin's
/// server entry stripped from the MCP config, the marker block cut from
/// the instructions file. Never rejects for one bad path -- the report
/// names what did not land and why.
export function removeGavinFootprint(
  rootPath: string,
  plan: { trash: string[]; stripMcpKey: McpFootprint[]; cutBlock: string[] },
  token: string
): Promise<RemovalReport> {
  return invoke("remove_gavin_footprint", { rootPath, plan, token });
}

export function agentProfiles(): Promise<
  Array<{
    id: string;
    label: string;
    instructionsFile: string;
    command: string;
    mcpSupported: boolean;
    mcpConfigFile: string;
    promptArgs: string | null;
    headlessArgs: string;
    modelFlag: string;
    models: string[];
    failurePatterns: string[];
    failureCauses: Array<{ pattern: string; cause: string }>;
    sessionIdArgs: string;
    sessionIdDiscovery: string;
    resumeArgs: string;
    usageProbe: string | null;
  }>
> {
  return invoke("agent_profiles");
}

/// PATH sweep of built-in agent CLIs for the init wizard. `custom` is
/// never included — it has no default command to probe.
export function detectAgentBinaries(): Promise<
  Array<{
    id: string;
    label: string;
    command: string;
    found: boolean;
    path: string | null;
  }>
> {
  return invoke("detect_agent_binaries");
}

/// The models each agent CAN be given right now, keyed by profile id --
/// for the CLIs whose picker is a list of dated ids rather than aliases
/// (codex, opencode). Resolved host-side once per app PROCESS, so a
/// frontend reload costs nothing and a new list needs a new app run.
///
/// A profile with no route, and one whose route answered nothing, is
/// simply absent: the merge treats a missing key and an empty list the
/// same way, and neither is a reason to fail the call.
export function agentModelCatalog(): Promise<Record<string, string[]>> {
  return invoke("agent_model_catalog");
}

/// One agent's subscription-limit windows, or a named reason there are
/// none to show. `force` is the panel's explicit refresh: it skips the
/// host's freshness floor but not its 429 backoff, because a human
/// pressing refresh cannot un-anger the endpoint.
export function agentUsage(profileId: string, force = false): Promise<AgentUsageReport> {
  return invoke("agent_usage", { profileId, force });
}

/// What GitHub says about `branch`'s pull request, read with `gh` in the
/// checkout at `cwd`. Honours a freshness floor host-side, so a caller
/// asking every few seconds costs one request a minute.
///
/// `force` is a human's explicit refresh. The scheduler never passes it:
/// a rail polling a PR on every tick is a rail hammering GitHub.
export function prStatus(cwd: string, branch: string, force = false): Promise<PrReport> {
  return invoke("pr_status", { cwd, branch, force });
}

export function mcpFormats(): Promise<Array<{ id: string; label: string }>> {
  return invoke("mcp_formats");
}

export function moveAgentFile(rootPath: string, from: string, to: string): Promise<void> {
  return invoke("move_agent_file", { rootPath, from, to });
}

export function setRootConfigField(rootPath: string, key: string, value: string): Promise<void> {
  return invoke("set_root_config_field", { rootPath, key, value });
}

// --- Git tab (app/src-tauri/src/git) ---------------------------------------

export function gitRepoInfo(cwd: string): Promise<RepoInfo> {
  return invoke("git_repo_info", { cwd });
}

export function gitStatus(cwd: string): Promise<StatusResult> {
  return invoke("git_status", { cwd });
}

export function gitDiff(
  cwd: string,
  path: string,
  oldPath: string | null,
  staged: boolean,
  untracked: boolean,
  rev: string | null = null
): Promise<FileDiff> {
  return invoke("git_diff", { cwd, path, oldPath, staged, untracked, rev });
}

/// The commit `cwd`'s checkout is on right now, or null when it is in
/// no repository and when HEAD is unborn. One git call, and the only
/// one a launch makes: see `baseShaForLaunch`.
export function gitHeadSha(cwd: string): Promise<string | null> {
  return invoke("git_head_sha", { cwd });
}

/// What one card run changed, against the commit its checkout was on
/// when it started. `cwd` is the run's LAUNCH directory: the command
/// resolves the repository root from it and answers in root-relative
/// paths.
/// `peers` is every other baseline recorded against the same checkout.
/// Given them, the window stops where the next run started, so a run in
/// a checkout several agents share reports its own slice rather than
/// everything the tree has done since. Empty -- the default -- is the
/// unbounded question: what does this checkout look like versus that
/// commit.
export function gitRunChanges(
  cwd: string,
  baseSha: string,
  peers: string[] = []
): Promise<RunChanges> {
  return invoke("git_run_changes", { cwd, baseSha, peers });
}

export function gitDiffSince(
  cwd: string,
  baseSha: string,
  path: string,
  oldPath: string | null,
  untracked: boolean,
  untilSha: string | null = null
): Promise<FileDiff> {
  return invoke("git_diff_since", { cwd, baseSha, path, oldPath, untracked, untilSha });
}

/// Resets the run's checkout to its baseline and moves the named
/// untracked files to the Trash. `untracked` is exactly what the human
/// was shown and agreed to -- never a `git clean`.
export function gitDiscardRun(
  cwd: string,
  baseSha: string,
  untracked: string[]
): Promise<DiscardReport> {
  return invoke("git_discard_run", { cwd, baseSha, untracked });
}

export function gitStageFiles(cwd: string, paths: string[]): Promise<void> {
  return invoke("git_stage_files", { cwd, paths });
}

export function gitUnstageFiles(cwd: string, paths: string[]): Promise<void> {
  return invoke("git_unstage_files", { cwd, paths });
}

export function gitStageAll(cwd: string): Promise<void> {
  return invoke("git_stage_all", { cwd });
}

export function gitUnstageAll(cwd: string): Promise<void> {
  return invoke("git_unstage_all", { cwd });
}

export function gitApplyPatch(cwd: string, patch: string, mode: ApplyMode): Promise<void> {
  return invoke("git_apply_patch", { cwd, patch, mode });
}

export function gitDiscardFiles(cwd: string, tracked: string[], untracked: string[]): Promise<void> {
  return invoke("git_discard_files", { cwd, tracked, untracked });
}

export function gitCommit(cwd: string, message: string, amend: boolean): Promise<void> {
  return invoke("git_commit", { cwd, message, amend });
}

export function gitInit(cwd: string): Promise<void> {
  return invoke("git_init", { cwd });
}

export function gitWatch(cwd: string): Promise<void> {
  return invoke("git_watch", { cwd });
}

export function gitUnwatch(cwd: string): Promise<void> {
  return invoke("git_unwatch", { cwd });
}

/// The text of `.gitignore` (repo toplevel) or `.git/info/exclude`
/// (the checkout's own, resolved through git so a linked worktree gets
/// the COMMON git dir's copy) -- "" when the file does not exist.
export function gitReadIgnoreFile(cwd: string, kind: IgnoreKind): Promise<string> {
  return invoke("git_read_ignore_file", { cwd, kind });
}

/// Overwrites the file with exactly what the editor panel holds.
export function gitWriteIgnoreFile(cwd: string, kind: IgnoreKind, content: string): Promise<void> {
  return invoke("git_write_ignore_file", { cwd, kind, content });
}

/// Appends one pattern as its own line, unless that exact line is
/// already there -- what the untracked-row and file-tree "Ignore"
/// quick actions call.
export function gitAddIgnorePattern(cwd: string, kind: IgnoreKind, pattern: string): Promise<void> {
  return invoke("git_add_ignore_pattern", { cwd, kind, pattern });
}

// --- Git tab SP2: sync, refs, branches, remotes, stashes --------------------

export function gitRefs(cwd: string): Promise<RefsSnapshot> {
  return invoke("git_refs", { cwd });
}

export function gitFetch(cwd: string, remote: string, opId: string): Promise<void> {
  return invoke("git_fetch", { cwd, remote, opId });
}

export function gitPull(cwd: string, opId: string): Promise<void> {
  return invoke("git_pull", { cwd, opId });
}

export function gitPush(cwd: string, remote: string, opId: string): Promise<void> {
  return invoke("git_push", { cwd, remote, opId });
}

export function gitCancelOp(opId: string): Promise<boolean> {
  return invoke("git_cancel_op", { opId });
}

export function gitCheckout(cwd: string, name: string, trackRemote: string | null): Promise<void> {
  return invoke("git_checkout", { cwd, name, trackRemote });
}

export function gitCreateBranch(cwd: string, name: string, from: string | null, checkout: boolean): Promise<void> {
  return invoke("git_create_branch", { cwd, name, from, checkout });
}

export function gitDeleteBranch(cwd: string, name: string, force: boolean): Promise<void> {
  return invoke("git_delete_branch", { cwd, name, force });
}

/// Local branch names already fully merged into `base` — the first of
/// the sweep's four disqualifiers, and the only one git alone can
/// answer. Includes `base` itself.
export function gitMergedBranches(cwd: string, base: string): Promise<string[]> {
  return invoke("git_merged_branches", { cwd, base });
}

export function gitMerge(cwd: string, branch: string): Promise<void> {
  return invoke("git_merge", { cwd, branch });
}

export function gitAbortInProgress(cwd: string, kind: InProgressKind): Promise<void> {
  return invoke("git_abort_in_progress", { cwd, kind });
}

export function gitContinueRebase(cwd: string): Promise<void> {
  return invoke("git_continue_rebase", { cwd });
}

export function gitAddRemote(cwd: string, name: string, url: string): Promise<void> {
  return invoke("git_add_remote", { cwd, name, url });
}

export function gitRemoveRemote(cwd: string, name: string): Promise<void> {
  return invoke("git_remove_remote", { cwd, name });
}

export function gitStashPush(cwd: string, message: string, includeUntracked: boolean): Promise<void> {
  return invoke("git_stash_push", { cwd, message, includeUntracked });
}

export function gitStashPop(cwd: string, index: number): Promise<void> {
  return invoke("git_stash_pop", { cwd, index });
}

export function gitStashApply(cwd: string, index: number): Promise<void> {
  return invoke("git_stash_apply", { cwd, index });
}

export function gitStashDrop(cwd: string, index: number): Promise<void> {
  return invoke("git_stash_drop", { cwd, index });
}

export function gitStashFiles(cwd: string, index: number): Promise<FileEntry[]> {
  return invoke("git_stash_files", { cwd, index });
}

// --- Git tab SP3: worktrees -------------------------------------------------

export function gitWorktreeAdd(cwd: string, path: string, branch: string, from: string | null, newBranch: boolean): Promise<void> {
  return invoke("git_worktree_add", { cwd, path, branch, from, newBranch });
}

export function gitWorktreeRemove(cwd: string, path: string, force: boolean): Promise<void> {
  return invoke("git_worktree_remove", { cwd, path, force });
}

export function gitWorktreePrune(cwd: string): Promise<void> {
  return invoke("git_worktree_prune", { cwd });
}

/// `[worktree] setup` from the workspace's `.gavin-root/config.toml`: what
/// a freshly created worktree has to run before it is usable. Read by the
/// host straight off disk rather than fetched from the daemon, so it needs
/// no protocol version and no compat gate to work.
export function worktreeSetup(rootPath: string): Promise<string[]> {
  return invoke("worktree_setup", { rootPath });
}

// --- Git tab SP4: history ---------------------------------------------------

export function gitLog(cwd: string, all: boolean, skip: number, limit: number): Promise<LogPage> {
  return invoke("git_log", { cwd, all, skip, limit });
}

export function gitCommitDetail(cwd: string, sha: string): Promise<CommitDetail> {
  return invoke("git_commit_detail", { cwd, sha });
}

export function gitCheckoutCommit(cwd: string, sha: string): Promise<void> {
  return invoke("git_checkout_commit", { cwd, sha });
}

export function gitCherryPick(cwd: string, sha: string): Promise<void> {
  return invoke("git_cherry_pick", { cwd, sha });
}

export function gitRevert(cwd: string, sha: string): Promise<void> {
  return invoke("git_revert", { cwd, sha });
}

export function gitReset(cwd: string, sha: string, mode: ResetMode): Promise<void> {
  return invoke("git_reset", { cwd, sha, mode });
}

export function gitContinueInProgress(cwd: string, kind: InProgressKind): Promise<void> {
  return invoke("git_continue_in_progress", { cwd, kind });
}

// --- Git tab: conflict resolution -------------------------------------------

export function gitConflict(cwd: string, path: string): Promise<ConflictInfo> {
  return invoke("git_conflict", { cwd, path });
}

export function gitMarkResolved(cwd: string, path: string): Promise<void> {
  return invoke("git_mark_resolved", { cwd, path });
}

export function gitResolveWhole(cwd: string, path: string, side: "ours" | "theirs"): Promise<void> {
  return invoke("git_resolve_whole", { cwd, path, side });
}

export function gitResolveDeleted(cwd: string, path: string, keep: boolean): Promise<void> {
  return invoke("git_resolve_deleted", { cwd, path, keep });
}

export function gitRestoreConflict(cwd: string, path: string): Promise<void> {
  return invoke("git_restore_conflict", { cwd, path });
}

export function gitMergeToolName(cwd: string): Promise<string | null> {
  return invoke("git_merge_tool_name", { cwd });
}

/// Installs the flow's step skill when the profile supports skills, and
/// returns the prompt that starts the agent on it (spec §7.1).
export function composeAgentPrompt(rootPath: string, flow: "prd" | "agent-file"): Promise<string> {
  return invoke("compose_agent_prompt", { rootPath, flow });
}

// --- Orchestration (SP1) ----------------------------------------------------

export function getOrchestration(workspaceId: string): Promise<Orchestration> {
  return invoke("get_orchestration", { workspaceId });
}

export function setOrchestration(
  workspaceId: string,
  rails: Rail[],
  conflictNotes: ConflictNote[]
): Promise<void> {
  return invoke("set_orchestration", { workspaceId, rails, conflictNotes });
}

/// `workspaceId` says whose daemon holds the rail: a rail id carries no
/// workspace on the wire, so without it the host writes to the local
/// daemon -- wrong for an ssh workspace. Every caller has one and passes
/// it; it is optional only so an older call shape still type-checks.
export function setRailRun(
  railId: string,
  state: RailState,
  currentStageId: string | null,
  workspaceId?: string
): Promise<void> {
  return invoke("set_rail_run", { railId, stateValue: state, currentStageId, workspaceId });
}

export function setStepRun(
  stepId: string,
  state: StepState,
  sessionId: string | null,
  reason: string | null,
  /// See linkCardSession: the conversation this run IS, and where it was
  /// launched, so a stalled step can be resumed as that conversation
  /// rather than reconstructed from an account of it.
  conversationId: string | null = null,
  launchCwd: string | null = null,
  /// How many times gavin has resumed this run by itself. null LEAVES
  /// the stored count alone, the way conversationId does, so the dozen
  /// transitions with nothing to say about the budget -- a stall, a
  /// done, a rail reset -- do not have to carry it. A launch passes 0
  /// explicitly: a new conversation is a new run with a fresh budget.
  resumeAttempts: number | null = null,
  /// Whose daemon holds the step; see setRailRun.
  workspaceId?: string
): Promise<void> {
  return invoke("set_step_run", {
    stepId,
    stateValue: state,
    sessionId,
    reason,
    conversationId,
    launchCwd,
    resumeAttempts,
    workspaceId,
  });
}

// --- The tool library -------------------------------------------------------

export function getTools(workspaceId: string): Promise<ToolRecord[]> {
  return invoke("get_tools", { workspaceId });
}

export function saveTool(tool: ToolRecord): Promise<void> {
  return invoke("save_tool", { tool });
}

/// `workspaceId` routes the delete to the daemon that holds the tool
/// (see setRailRun); a global tool's is the local daemon's either way.
export function deleteTool(id: string, workspaceId?: string): Promise<void> {
  return invoke("delete_tool", { id, workspaceId });
}

// --- Standalone tool runs (v30) ---------------------------------------------
//
// Gate on FEATURE_MIN_VERSION.toolRuns before calling any of these: they
// are new request types, so an older daemon refuses them, and "this
// daemon does not track tool runs" is a different sentence from "this
// tool has never been run".

/// Opens a run for a tool launched from the Tools tab. The daemon closes
/// it itself when the session exits, which is the whole of a `command` or
/// `script` tool's verdict; an `agent` tool's is filed by
/// `setToolRunOutcome` when its turn ends.
export function startToolRun(input: {
  workspaceId: string;
  toolId: string;
  sessionId: string;
  command: string | null;
  launchCwd: string | null;
  conversationId: string | null;
}): Promise<void> {
  return invoke("start_tool_run", input);
}

/// Records a verdict the daemon cannot reach on its own. Only ever an
/// `agent` tool: its session is still alive when its turn ends.
export function setToolRunOutcome(
  sessionId: string,
  outcome: string,
  exitCode: number | null = null
): Promise<void> {
  return invoke("set_tool_run_outcome", { sessionId, outcome, exitCode });
}

/// The LAST run of each of this workspace's tools -- not a history. The
/// Tools tab draws one chip per row, so this is exactly what it needs.
export function toolRuns(workspaceId: string): Promise<ToolRun[]> {
  return invoke("tool_runs", { workspaceId });
}

// --- Group templates --------------------------------------------------------

export function getGroupTemplates(workspaceId: string): Promise<GroupTemplateRecord[]> {
  return invoke("get_group_templates", { workspaceId });
}

export function saveGroupTemplate(template: GroupTemplateRecord): Promise<void> {
  return invoke("save_group_template", { template });
}

export function deleteGroupTemplate(id: string, workspaceId?: string): Promise<void> {
  return invoke("delete_group_template", { id, workspaceId });
}
