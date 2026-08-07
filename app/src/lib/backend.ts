import { invoke } from "@tauri-apps/api/core";
import type { Workspace, WorkspacesData } from "./workspace";
import type { Board, Column, Label } from "./kanban";
import type { BoardTab, GavinTree } from "./gavin";

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

export function readFileForViewer(path: string): Promise<{ content: string; truncated: boolean }> {
  return invoke("read_file_for_viewer", { path });
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

export function setPlanFrontmatterField(
  path: string,
  key: "status" | "priority",
  value: string
): Promise<void> {
  return invoke("set_plan_frontmatter_field", { path, key, value });
}

export function getBoard(workspaceId: string): Promise<Board> {
  return invoke("get_board", { workspaceId });
}

export function setBoard(workspaceId: string, columns: Column[], labels: Label[]): Promise<void> {
  return invoke("set_board", { workspaceId, columns, labels });
}

export function deleteBoard(workspaceId: string): Promise<void> {
  return invoke("delete_board", { workspaceId });
}
