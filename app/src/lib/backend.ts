import { invoke } from "@tauri-apps/api/core";
import type { Workspace, WorkspacesData } from "./workspace";
import type { Board, Column, Label } from "./kanban";
import type { BoardTab, GavinTree } from "./gavin";
import type { ApplyMode, FileDiff, FileEntry, InProgressKind, RefsSnapshot, RepoInfo, StatusResult } from "./git";

export function createSession(cwd?: string, command?: string): Promise<string> {
  return invoke("create_session", { cwd, command });
}

export function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
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

export function viewableExtensions(): Promise<string[]> {
  return invoke("viewable_extensions");
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

export function setWorkspacesState(workspaces: Workspace[], activeWorkspaceId: string | null): Promise<void> {
  return invoke("set_workspaces_state", { workspaces, activeWorkspaceId });
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

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_session", { sessionId, cols, rows });
}

export function getSessionNames(): Promise<Record<string, string>> {
  return invoke("get_session_names");
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
export function restartDaemon(): Promise<boolean> {
  return invoke("restart_daemon");
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

export function gavinRootExists(rootPath: string): Promise<boolean> {
  return invoke("gavin_root_exists", { rootPath });
}

export function getBoardTabs(): Promise<Record<string, BoardTab>> {
  return invoke("get_board_tabs");
}

export function setBoardTabs(boardTabs: Record<string, BoardTab>): Promise<void> {
  return invoke("set_board_tabs", { boardTabs });
}

export function seedSmokeTestData(rootPath: string): Promise<void> {
  return invoke("seed_smoke_test_data", { rootPath });
}

export function setupAgentIntegration(rootPath: string): Promise<string[]> {
  return invoke("setup_agent_integration", { rootPath });
}

export function createPlan(
  contextFolder: string,
  fileName: string,
  title: string,
  status?: string,
  priority?: string,
  body?: string,
  kind?: "note" | "task" | "plan",
  parent?: string
): Promise<string> {
  return invoke("create_plan", { contextFolder, fileName, title, status, priority, body, kind, parent });
}

export function setPlanFrontmatterField(
  path: string,
  key: "status" | "priority" | "order" | "title" | "kind" | "parent" | "labels",
  value: string
): Promise<void> {
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

export function deleteCardFile(path: string): Promise<void> {
  return invoke("delete_card_file", { path });
}

export function linkCardSession(
  workspaceId: string,
  path: string,
  sessionId: string,
  cwd: string,
  command: string | null
): Promise<void> {
  return invoke("link_card_session", { workspaceId, path, sessionId, cwd, command });
}

export function unlinkCardSession(workspaceId: string, path: string): Promise<void> {
  return invoke("unlink_card_session", { workspaceId, path });
}

export function deleteBoard(workspaceId: string): Promise<void> {
  return invoke("delete_board", { workspaceId });
}

export function agentProfiles(): Promise<
  Array<{ id: string; label: string; instructionsFile: string; command: string; mcpSupported: boolean }>
> {
  return invoke("agent_profiles");
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
  untracked: boolean
): Promise<FileDiff> {
  return invoke("git_diff", { cwd, path, oldPath, staged, untracked });
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
