// Builds a pane tab's right-click menu. Pure: state in, entries out;
// side effects go through store actions (mockable) or the hooks.
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";
import { confirmTabClose } from "./confirmClose";
import { bulkCloseTargets } from "./layout";
import { bestOfNRuns, runForSessionAnywhere } from "./bestOfNState";
import { pickCandidate } from "./bestOfNActions";
import { get } from "svelte/store";
import type { ContextMenuEntry } from "./contextMenu";

export interface TabMenuContext {
  tabId: string;
  kind: "terminal" | "file" | "board";
  /** cwd for a terminal, the file for a file tab, the context folder for a board tab. */
  path: string | null;
  pinned: boolean;
  /** The owning leaf's tabs in order, and which of them are pinned. */
  tabs: string[];
  pinnedTabs: string[];
}

export interface TabMenuHooks {
  startRename: (tabId: string) => void;
  reportError: (message: string) => void;
}

export function buildTabMenuEntries(ctx: TabMenuContext, hooks: TabMenuHooks): ContextMenuEntry[] {
  const others = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "others");
  const right = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "right");
  const left = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "left");
  const fail = (what: string) => (e: unknown) => hooks.reportError(`${what}: ${e}`);

  const entries: ContextMenuEntry[] = [
    {
      label: "Close",
      onPick: () => {
        void confirmTabClose(ctx.tabId).then((ok) => (ok ? closeSession(ctx.tabId) : undefined));
      },
    },
    { label: "Close Others", disabled: others.length === 0, onPick: () => void closeTabs(others) },
    { label: "Close to the Right", disabled: right.length === 0, onPick: () => void closeTabs(right) },
    { label: "Close to the Left", disabled: left.length === 0, onPick: () => void closeTabs(left) },
    { separator: true },
    { label: ctx.pinned ? "Unpin" : "Pin", onPick: () => void setTabPinned(ctx.tabId, !ctx.pinned) },
  ];

  // A best-of-N candidate, decided from where the human is actually
  // watching them: the pane. The card detail modal has the same action
  // in a considered list, but a run is watched in the terminals, and
  // making the human find the card to end one they have already judged
  // is the friction this entry removes. Confirm-gated like the modal's
  // -- the same prompt, naming every folder it deletes.
  const inRun = ctx.kind === "terminal" ? runForSessionAnywhere(get(bestOfNRuns), ctx.tabId) : null;
  if (inRun) {
    entries.push(
      { separator: true },
      {
        label:
          inRun.run.candidates.length === 2
            ? "Keep this candidate, discard the other…"
            : `Keep this candidate, discard the other ${inRun.run.candidates.length - 1}…`,
        onPick: () => {
          void pickCandidate(inRun.workspaceId, inRun.run, ctx.tabId).then((err) => {
            if (err) hooks.reportError(err);
          });
        },
      }
    );
  }

  if (ctx.kind === "terminal") {
    entries.push(
      { separator: true },
      { label: "Split Right", onPick: () => void splitPane(ctx.tabId, "row") },
      { label: "Split Down", onPick: () => void splitPane(ctx.tabId, "column") },
      { label: "Rename…", onPick: () => hooks.startRename(ctx.tabId) }
    );
  }

  const path = ctx.path;
  entries.push(
    { separator: true },
    ctx.kind === "file"
      ? {
          label: "Reveal in Finder",
          disabled: path === null,
          onPick: () => {
            if (path) revealItemInDir(path).catch(fail("Couldn't reveal in Finder"));
          },
        }
      : {
          label: "Open Folder in Finder",
          disabled: path === null,
          onPick: () => {
            if (path) openPath(path).catch(fail("Couldn't open in Finder"));
          },
        },
    {
      label: "Copy Path",
      disabled: path === null,
      onPick: () => {
        if (path) writeText(path).catch(fail("Couldn't copy path"));
      },
    }
  );

  return entries;
}
