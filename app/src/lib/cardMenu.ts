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
import { findCardPlacement } from "./orchestration";
import {
  orchestrations,
  sendCardToRailAction,
  removeCardFromRailAction,
} from "./orchestrationState";
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

    // The rails, in the order the Orchestration tab shows them. The card
    // lands as the rail's trailing stage; the rail it is already on is
    // marked and disabled, exactly as its own column is below.
    //
    // A workspace with NO rails gets no block at all rather than a dead
    // row: orchestration is opt-in, and the card detail is where the
    // concept gets explained to someone who has not opted in.
    const orch = get(orchestrations)[workspaceId];
    const rails = [...(orch?.rails ?? [])].sort((a, b) => a.position - b.position);
    const placement = orch ? findCardPlacement(orch, card.id) : null;
    if (rails.length > 0) {
      entries.push({ separator: true });
      for (const r of rails) {
        const here = placement?.railId === r.id;
        entries.push({
          label: `Send to rail “${r.name}”`,
          active: here,
          disabled: here,
          onPick: () => {
            void sendCardToRailAction(workspaceId, r.id, card.id).then((err) => {
              if (err) hooks.reportError(err);
            });
          },
        });
      }
      if (placement) {
        const name = rails.find((r) => r.id === placement.railId)?.name ?? "its rail";
        entries.push({
          label: `Take off rail “${name}”`,
          onPick: () => {
            void removeCardFromRailAction(workspaceId, card.id).then((err) => {
              if (err) hooks.reportError(err);
            });
          },
        });
      }
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
