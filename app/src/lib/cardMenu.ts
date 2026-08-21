// Builds a card's right-click menu (context-menu design): what appears
// depends on kind, binding state, parentage, and the board's columns.
// Surfaces supply the hooks (modal, delete prompt, run, error strip).

import { get } from "svelte/store";
import { openPath } from "@tauri-apps/plugin-opener";
import * as backend from "./backend";
import { kanbanState, cardSessionFor } from "./kanbanState";
import { layoutState, switchWorkspaceView } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { patchPlanField } from "./gavinState";
import { requestedExplorerPath } from "./planExplorer";
import { jumpToBoundSession, relaunchCard } from "./cardRunActions";
import { slugStatus, type CardView } from "./planBoard";
import type { Column } from "./kanban";
import type { ContextMenuEntry } from "./contextMenu";

export interface CardMenuHooks {
  workspaceId: string;
  columns: Column[];
  openDetail: (path: string) => void;
  requestDelete: (card: CardView) => void;
  run: (card: CardView) => void;
  sendToAgent: (card: CardView) => void;
  agentAvailable: boolean;
  reportError: (message: string) => void;
}

export function buildCardMenuEntries(card: CardView, hooks: CardMenuHooks): ContextMenuEntry[] {
  const { workspaceId, columns } = hooks;
  const entries: ContextMenuEntry[] = [];

  entries.push({ label: "Open", onPick: () => hooks.openDetail(card.id) });
  entries.push({
    label: "Open in Plans tab",
    onPick: () => {
      requestedExplorerPath.set(card.id);
      void switchWorkspaceView(workspaceId, "plans");
    },
  });
  entries.push({
    label: "Open externally",
    onPick: () => {
      openPath(card.id).catch((e) => hooks.reportError(`Couldn't open externally: ${e}`));
    },
  });

  if (card.kind !== "note") {
    entries.push({ separator: true });
    const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
    const live = binding !== null && findSessionLocation(get(layoutState), binding.sessionId) !== null;
    if (binding && live) {
      entries.push({
        label: "Jump to session",
        onPick: () => void jumpToBoundSession(workspaceId, card.id),
      });
    } else if (binding) {
      entries.push({
        label: "Re-launch agent",
        onPick: () => {
          void relaunchCard(workspaceId, card.id).then((err) => {
            if (err) hooks.reportError(err);
          });
        },
      });
    } else {
      entries.push({
        label: "Run in dedicated session",
        onPick: () => hooks.run(card),
      });
      entries.push({
        label: "Send to workspace agent",
        disabled: !hooks.agentAvailable,
        onPick: () => hooks.sendToAgent(card),
      });
    }
  }

  entries.push({ separator: true });
  const currentSlug = slugStatus(card.status ?? "");
  for (const col of columns) {
    const active = card.status !== null && slugStatus(col.name) === currentSlug;
    entries.push({
      label: `Move to ${col.name}`,
      active,
      disabled: active,
      onPick: () => {
        void backend
          .setPlanFrontmatterField(card.id, "status", col.name)
          .then(() => patchPlanField(workspaceId, card.id, "status", col.name))
          .catch((e) => hooks.reportError(String(e)));
      },
    });
  }

  if (card.kind === "task" && card.parent !== null) {
    entries.push({
      label: "Un-parent",
      onPick: () => {
        void backend
          .setPlanFrontmatterField(card.id, "parent", "")
          .then(() => patchPlanField(workspaceId, card.id, "parent", ""))
          .catch((e) => hooks.reportError(String(e)));
      },
    });
  }

  entries.push({ separator: true });
  entries.push({ label: "Delete…", danger: true, onPick: () => hooks.requestDelete(card) });

  return entries;
}
