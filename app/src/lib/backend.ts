import { invoke } from "@tauri-apps/api/core";
import type { LayoutNode } from "./layout";

export function createSession(): Promise<string> {
  return invoke("create_session");
}

export function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
}

export function getCurrentLayout(): Promise<LayoutNode> {
  return invoke("get_current_layout");
}

export function setLayout(layout: LayoutNode): Promise<void> {
  return invoke("set_layout", { layout });
}

export function writeInput(sessionId: string, data: string): Promise<void> {
  return invoke("write_input", { sessionId, data });
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_session", { sessionId, cols, rows });
}

export function signalFrontendReady(): Promise<void> {
  return invoke("signal_frontend_ready");
}

export function getBootstrapError(): Promise<string | null> {
  return invoke("get_bootstrap_error");
}
