import type { Component } from "svelte";
import { Terminal, Kanban } from "@lucide/svelte";
import TerminalView from "./TerminalView.svelte";
import KanbanBoard from "./KanbanBoard.svelte";

export interface WorkspaceView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
}

export const WORKSPACE_VIEWS: WorkspaceView[] = [
  { id: "terminal", label: "Terminal", icon: Terminal, component: TerminalView },
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
];
