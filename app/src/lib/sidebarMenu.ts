// Right-click menus for the sidebar: workspace rows, page rows, and the
// session rows inside a page's expanded git detail. Pure builders; the
// Sidebar supplies inline-rename / new-page / error hooks.
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import * as backend from "./backend";
import {
  closeWorkspace,
  closePage,
  movePageAction,
  switchWorkspaceView,
  switchToSessionInPage,
  closeSession,
  setWorkspaceRoot,
} from "./layoutState";
import { confirmWorkspaceClose, confirmPageClose, confirmTabClose } from "./confirmClose";
import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";
import type { ContextMenuEntry } from "./contextMenu";

export interface SidebarMenuHooks {
  startRenameWorkspace: (workspaceId: string) => void;
  startRenamePage: (pageId: string) => void;
  newPage: (workspaceId: string) => void;
  reportError: (message: string) => void;
}

const fail = (report: (m: string) => void, what: string) => (e: unknown) => report(`${what}: ${e}`);

export function buildWorkspaceMenuEntries(ws: Workspace, hooks: SidebarMenuHooks): ContextMenuEntry[] {
  if (ws.id === UNFILED_WORKSPACE_ID) {
    return [{ label: "New Page", onPick: () => hooks.newPage(ws.id) }];
  }
  const root = ws.rootPath ?? null;
  return [
    { label: "Rename…", onPick: () => hooks.startRenameWorkspace(ws.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
    { separator: true },
    {
      label: "Open Root in Finder",
      disabled: root === null,
      onPick: () => {
        if (root) openPath(root).catch(fail(hooks.reportError, "Couldn't open in Finder"));
      },
    },
    { label: "Change Root Folder…", onPick: () => void changeWorkspaceRoot(ws.id, hooks.reportError) },
    { separator: true },
    {
      label: "Close Workspace",
      danger: true,
      onPick: () => {
        void confirmWorkspaceClose(ws.id).then((ok) => (ok ? closeWorkspace(ws.id) : undefined));
      },
    },
  ];
}

// Picks a folder and binds it when it already is a gavin root. The
// initialise-or-bind flow for a plain folder belongs to the root control
// on the Home tab, so that is where a plain folder sends the user.
export async function changeWorkspaceRoot(workspaceId: string, reportError: (m: string) => void): Promise<void> {
  try {
    const picked = await open({ directory: true, multiple: false, title: "Choose workspace root" });
    if (typeof picked !== "string") return;
    if (await backend.gavinRootExists(picked)) {
      await setWorkspaceRoot(workspaceId, picked);
      return;
    }
    await switchWorkspaceView(workspaceId, "home");
    reportError("That folder has no .gavin-root yet — use the root control on the Home tab to initialise or bind it.");
  } catch (e) {
    reportError(`Couldn't change root folder: ${e}`);
  }
}

export function buildPageMenuEntries(
  ws: Workspace,
  page: Page,
  allWorkspaces: Workspace[],
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  const others = ws.pages.filter((p) => p.id !== page.id);
  const entries: ContextMenuEntry[] = [
    { label: "Rename…", onPick: () => hooks.startRenamePage(page.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
  ];
  const targets = allWorkspaces.filter((w) => w.id !== ws.id);
  if (targets.length > 0) {
    entries.push({ separator: true });
    for (const target of targets) {
      entries.push({
        label: `Move to ${target.name}`,
        onPick: () => void movePageAction(page.id, target.id, target.pages.length),
      });
    }
  }
  entries.push(
    { separator: true },
    {
      label: "Close Other Pages",
      danger: true,
      disabled: others.length === 0,
      onPick: () => {
        void (async () => {
          for (const p of others) {
            if (!(await confirmPageClose(ws.id, p.id))) return;
            await closePage(ws.id, p.id);
          }
        })();
      },
    },
    {
      label: "Close Page",
      danger: true,
      onPick: () => {
        void confirmPageClose(ws.id, page.id).then((ok) => (ok ? closePage(ws.id, page.id) : undefined));
      },
    }
  );
  return entries;
}

export function buildSessionRowMenuEntries(
  ws: Workspace,
  page: Page,
  sessionId: string,
  cwd: string | null,
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  return [
    {
      label: "Jump to Session",
      onPick: () => {
        void switchWorkspaceView(ws.id, "terminal");
        void switchToSessionInPage(ws.id, page.id, sessionId);
      },
    },
    {
      label: "Open cwd in Finder",
      disabled: cwd === null,
      onPick: () => {
        if (cwd) openPath(cwd).catch(fail(hooks.reportError, "Couldn't open in Finder"));
      },
    },
    { separator: true },
    {
      label: "Close Session",
      danger: true,
      onPick: () => {
        void confirmTabClose(sessionId).then((ok) => (ok ? closeSession(sessionId) : undefined));
      },
    },
  ];
}
