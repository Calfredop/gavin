import { invoke } from "@tauri-apps/api/core";
import type { Workspace, WorkspacesData } from "./workspace";

export function createSession(): Promise<string> {
  return invoke("create_session");
}

export function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
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
