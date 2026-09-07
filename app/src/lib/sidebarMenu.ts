// Right-click menus for the sidebar: workspace rows, page rows, and the
// tab rows inside an expanded page. Pure builders; the Sidebar supplies
// inline-rename / new-page / error hooks.
import { openPath } from "@tauri-apps/plugin-opener";
import { pickPath } from "./picker";
import * as backend from "./backend";
import {
  closeWorkspace,
  closePage,
  handOffWorkspace,
  movePageAction,
  switchWorkspaceView,
  switchToSessionInPage,
  setWorkspaceRoot,
  setWorkspacePinned,
  setPagePinned,
} from "./layoutState";
import { windowActionLabel } from "./appWindow";
import { currentWindowLabel, currentWorkspaceWindows } from "./appWindowState";
import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
import { buildTabMenuEntries, type TabMenuContext } from "./tabMenu";
import { closeIdlePrompt, idleTabsOnPage, type CloseIdleRequest } from "./idleTabs";
import type { PageTabState } from "./sidebarSummary";
import { UNFILED_WORKSPACE_ID, isPinned, type Workspace, type Page } from "./workspace";
import type { ContextMenuEntry } from "./contextMenu";

export interface SidebarMenuHooks {
  startRenameWorkspace: (workspaceId: string) => void;
  startRenamePage: (pageId: string) => void;
  startRenameSession: (sessionId: string) => void;
  newPage: (workspaceId: string) => void;
  /// Raises the app's own confirmation for "Close Idle Tabs". Not a
  /// native `confirm`: the prompt has to spell out the tabs that STAY,
  /// which is a list, not a sentence.
  confirmCloseIdle: (request: CloseIdleRequest) => void;
  reportError: (message: string) => void;
}

const fail = (report: (m: string) => void, what: string) => (e: unknown) => report(`${what}: ${e}`);

export function buildWorkspaceMenuEntries(ws: Workspace, hooks: SidebarMenuHooks): ContextMenuEntry[] {
  if (ws.id === UNFILED_WORKSPACE_ID) {
    return [{ label: "New Page", onPick: () => hooks.newPage(ws.id) }];
  }
  const root = ws.rootPath ?? null;
  // One entry for both directions, because they are the same wish: "put
  // this workspace where I can see it on its own". It reads "Open in New
  // Window" for a workspace this window holds and "Show in Its Window"
  // for one that already left -- and it is absent entirely in the window
  // that workspace IS, where both would end where they started.
  const windowLabel = windowActionLabel(currentWorkspaceWindows(), ws.id, currentWindowLabel());
  const pinned = isPinned(ws);
  return [
    { label: "Rename…", onPick: () => hooks.startRenameWorkspace(ws.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
    ...(windowLabel
      ? [
          { separator: true } as ContextMenuEntry,
          { label: windowLabel, onPick: () => void handOffWorkspace(ws.id) } as ContextMenuEntry,
        ]
      : []),
    { separator: true },
    { label: pinned ? "Unpin" : "Pin", onPick: () => void setWorkspacePinned(ws.id, !pinned) },
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
      // A pin is what makes a row unclosable, so the entry stays and
      // greys out rather than disappearing: the human is one item up
      // this same menu from being able to close it again, and a
      // vanished action would read as a broken menu instead.
      label: "Close Workspace",
      danger: true,
      disabled: pinned,
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
    const picked = await pickPath({ directory: true, title: "Choose workspace root" });
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

// `tabs` is the live tab state read at right-click time, and only
// "Close Idle Tabs" needs it: which tabs are idle is a fact about
// running agents, not about the page's own record, so it cannot come
// off the Page.
export function buildPageMenuEntries(
  ws: Workspace,
  page: Page,
  allWorkspaces: Workspace[],
  tabs: PageTabState,
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  // "Other pages" a bulk close may actually take: pinned ones are not
  // among them. A pin says this page survives what closes its
  // neighbours, so an action that names the neighbours rather than the
  // page is exactly where that promise would otherwise be broken --
  // quietly, and for every pinned page at once.
  const others = ws.pages.filter((p) => p.id !== page.id && !isPinned(p));
  const pinned = isPinned(page);
  const entries: ContextMenuEntry[] = [
    { label: "Rename…", onPick: () => hooks.startRenamePage(page.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
    { separator: true },
    { label: pinned ? "Unpin" : "Pin", onPick: () => void setPagePinned(ws.id, page.id, !pinned) },
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
  const idle = idleTabsOnPage(page, tabs);
  entries.push(
    { separator: true },
    {
      // Its own group: every other close in this menu takes a whole
      // page, and this one takes tabs out of the page it stays on.
      label: "Close Idle Tabs",
      danger: true,
      disabled: idle.ids.length === 0,
      onPick: () =>
        hooks.confirmCloseIdle({ ids: idle.ids, prompt: closeIdlePrompt(page, idle) }),
    },
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
      // Greyed rather than gone, for the reason the workspace menu's own
      // close spells out.
      label: "Close Page",
      danger: true,
      disabled: pinned,
      onPick: () => {
        void confirmPageClose(ws.id, page.id).then((ok) => (ok ? closePage(ws.id, page.id) : undefined));
      },
    }
  );
  return entries;
}

// A row inside an expanded page is the same tab the tab bar draws, so it
// offers the same menu: close/close-others, pin, split, rename, reveal,
// copy path. Delegating to tabMenu.ts rather than keeping a second,
// thinner copy is the whole point -- one list, one set of labels, and
// every future tab action reaches both surfaces at once. The one entry
// the tab bar has no use for stays on top: from the sidebar you may be
// looking at a page that isn't even on screen.
export function buildSessionRowMenuEntries(
  ws: Workspace,
  page: Page,
  ctx: TabMenuContext,
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  return [
    {
      label: ctx.kind === "terminal" ? "Jump to Session" : "Jump to Tab",
      onPick: () => {
        void switchWorkspaceView(ws.id, "terminal");
        void switchToSessionInPage(ws.id, page.id, ctx.tabId);
      },
    },
    { separator: true },
    ...buildTabMenuEntries(ctx, {
      startRename: hooks.startRenameSession,
      reportError: hooks.reportError,
    }),
  ];
}
