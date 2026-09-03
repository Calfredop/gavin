// Builds a card's right-click menu (context-menu design): what appears
// depends on kind, binding state, parentage, and the board's columns.
// Surfaces supply the hooks (modal, delete prompt, run, error strip).

import { get } from "svelte/store";
import { openPath } from "@tauri-apps/plugin-opener";
import * as backend from "./backend";
import { kanbanState, cardSessionFor } from "./kanbanState";
import { layoutState, daemonCompat, switchWorkspaceView } from "./layoutState";
import { patchPlanField } from "./gavinState";
import { requestedExplorerFile } from "./planExplorer";
import { jumpToBoundSession, relaunchCard, developCard, resumeCard } from "./cardRunActions";
import { developAvailable } from "./cardRun";
import { cardSessionState } from "./columnRunAction";
import { findCardPlacement } from "./orchestration";
import {
  orchestrations,
  sendCardToRailAction,
  removeCardFromRailAction,
} from "./orchestrationState";
import { executeArchive, executeUnarchive } from "./archiveActions";
import { bestOfNRequest, bestOfNRuns, runForCard } from "./bestOfNState";
import { featureBlockedReason } from "./daemonCompat";
import { isArchivedCard, slugStatus, type CardView } from "./planBoard";
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
  // The detail modal's button, by the same name and to the same place:
  // the Plans tab with this file selected, its editor in Edit mode.
  entries.push({
    label: "Open in card editor",
    onPick: () => {
      requestedExplorerFile.set({ path: card.id, mode: "edit" });
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
    const sessionState = cardSessionState(get(layoutState), binding);
    const run = runForCard(get(bestOfNRuns)[workspaceId], card.id);
    // A run in flight replaces every run action, and there is exactly one
    // thing to do with it: go and decide. The candidates are not bound to
    // the card (the winner becomes its binding at the pick), so without
    // this the menu would offer to start a SECOND run over the top of the
    // first -- which the launch refuses, but only after the human has
    // been offered it.
    if (run) {
      entries.push({
        label: `Best of ${run.candidates.length} — pick a candidate…`,
        onPick: () => hooks.openDetail(card.id),
      });
    } else if (sessionState === "live") {
      entries.push({
        label: "Jump to session",
        onPick: () => void jumpToBoundSession(workspaceId, card.id),
      });
    } else if (sessionState === "failed") {
      // The agent is still sitting there at its prompt -- so a jump
      // would land the human in a live tab and tell them nothing --
      // but it stopped because something broke. Where the profile
      // verified a resume argv this reopens the SAME conversation
      // (`claude --resume <uuid>`); everywhere else it falls back to
      // the written reconstruction, which is what Resume always did.
      entries.push({
        label: "Resume — the agent stopped because something broke",
        onPick: () => {
          void resumeCard(workspaceId, card).then((err) => {
            if (err) hooks.reportError(err);
          });
        },
      });
    } else if (sessionState === "interrupted") {
      // Resume, not Re-launch: the killed agent left its edits in the
      // checkout, and the resume prompt (gavin-resume) is the one that
      // tells its replacement to find that work before adding to it.
      // Re-launch would replay the ORIGINAL command -- the whole
      // from-scratch second attempt this card exists to stop.
      entries.push({
        label: "Resume — the agent was interrupted",
        onPick: () => {
          void resumeCard(workspaceId, card).then((err) => {
            if (err) hooks.reportError(err);
          });
        },
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
      // Develop before Run: develop the card, then run it. The ellipsis
      // is honest -- the spawned agent interviews the human before it
      // writes anything. developAvailable (cardRun.ts) carries the rule,
      // shared with the card detail modal's button.
      if (developAvailable(card.kind, card.status, binding !== null)) {
        entries.push({
          label: "Develop into a plan…",
          onPick: () => {
            void developCard(workspaceId, card).then((err) => {
              if (err) hooks.reportError(err);
            });
          },
        });
      }
      entries.push({
        label: "Run in dedicated session",
        onPick: () => hooks.run(card),
      });
      // Beside the ordinary Run, because that is what it is a variant
      // of: the same card, the same prompt, N agents instead of one. The
      // ellipsis is honest -- the dialog asks which agents before
      // anything is created.
      entries.push({
        label: "Run on several agents…",
        onPick: () => bestOfNRequest.set({ workspaceId, card }),
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
  // Archiving and restoring, before the column list: they are the two
  // moves that take a card OFF the board or put it back, and reading
  // them beside "Move to Done" is what makes the difference legible.
  const archived = isArchivedCard(card.id);
  const archiveBlocked = featureBlockedReason(get(daemonCompat), "archive");
  const archiveLabel = archived ? "Restore from archive" : "Archive";
  entries.push({
    // The menu has no tooltip layer, so a disabled row has to say why in
    // its own label or read as an unexplained dead entry.
    label: archiveBlocked ? `${archiveLabel} — restart the daemon` : archiveLabel,
    disabled: archiveBlocked !== null,
    onPick: () => {
      const run = archived ? executeUnarchive : executeArchive;
      void run(workspaceId, [card]).then((err) => {
        if (err) hooks.reportError(err);
      });
    },
  });

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
