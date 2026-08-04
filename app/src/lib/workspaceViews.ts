import type { Component } from "svelte";
import { Kanban } from "@lucide/svelte";
import KanbanBoard from "./KanbanBoard.svelte";

export interface HubView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
}

export const HUB_VIEWS: HubView[] = [
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
];
