<script lang="ts">
  import { accentVar } from "./settings";
  import {
    layoutState,
    switchWorkspace,
    switchWorkspaceView,
    switchPage,
    renameWorkspace,
    createPage,
    renamePage,
    closeWorkspace,
    closePage,
    setSessionName,
  } from "./layoutState";
  import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
  // The creation flow itself lives in workspaceCreate.ts: the app hub's
  // "+ New workspace…" drives the very same steps, and a second copy of
  // the create → setup → wizard handoff is the shape that drifts.
  import {
    newWorkspaceFlow,
    startCreatingWorkspace,
    setNewWorkspaceName,
    commitNewWorkspace,
    cancelNewWorkspace,
  } from "./workspaceCreate";
  import type { SessionStatus } from "./layoutState";
  import { presetSingle, allSessionIds, findLeafPath, getNodeAtPath } from "./layout";
  import {
    ChevronRight,
    ChevronDown,
    Plus,
    X,
    House,
    Sun,
    Moon,
    Monitor,
    Settings,
    GitBranch,
    Kanban,
    Play,
    Check,
    CircleDashed,
    CircleDot,
    FileText,
    PanelsTopLeft,
    SquareArrowOutUpRight,
  } from "@lucide/svelte";
  import { themeState } from "./ui/themeState.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import type { ThemePref } from "./ui/theme";

  /// System first, matching the default -- and matching the order the
  /// three states read in: follow the OS, or override it either way.
  const THEME_OPTIONS: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
    { pref: "system", label: "Follow system", icon: Monitor },
    { pref: "light", label: "Light", icon: Sun },
    { pref: "dark", label: "Dark", icon: Moon },
  ];
  import { sessionLabel, folderName, boardTabLabel } from "./paths";
  import { resolveHubView, visibleHubViewIds } from "./hubViewMeta";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeReorderPosition,
    type DropZone,
    type ReorderPosition,
  } from "./dragDrop";
  import { movePaneOrTab, reorderWorkspaceAction, movePageAction, switchToSessionInPage } from "./layoutState";
  import { UNFILED_WORKSPACE_ID, getActiveView, sidebarWorkspaceOrder, type Workspace, type Page, type GitStatus } from "./workspace";
  import {
    workspaceGitSummary,
    kanbanSummary,
    railsSummary,
    pageAgentsSummary,
    pageTabRows,
    hasRecap,
    showGitChip,
    type WorkspaceGitSummary,
    type KanbanSummary,
    type RailsSummary,
    type PageAgentsSummary,
    type PageTabRow,
  } from "./sidebarSummary";
  import { rowLinkedCard, openLinkedCard, type LinkedCard } from "./cardTabLink";
  import { orchestrations, fetchOrchestration } from "./orchestrationState";
  import { kanbanState, fetchBoard } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { tooltip } from "./tooltip";
  import { hintMode } from "./shortcutHints";
  import { agentCommitPhase, gitStore } from "./gitState";
  import { hintDigitFor } from "./shortcuts";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
  import { message } from "@tauri-apps/plugin-dialog";
  import { openContextMenuFromEvent } from "./contextMenu";
  import {
    buildWorkspaceMenuEntries,
    buildPageMenuEntries,
    buildSessionRowMenuEntries,
    type SidebarMenuHooks,
  } from "./sidebarMenu";
  import type { TabMenuContext } from "./tabMenu";

  let expanded: Set<string> = $state(new Set());

  // Tracks which pages currently show their tab list -- unrelated to
  // `expanded` above (that Set tracks which WORKSPACES show their page
  // list; this one tracks which PAGES show their tabs). Kept separate
  // rather than reusing one Set, since workspace ids and page ids are
  // different concepts that happen to both be strings.
  let expandedPages: Set<string> = $state(new Set());

  function isPageExpanded(pageId: string): boolean {
    return expandedPages.has(pageId);
  }

  function togglePageExpand(pageId: string): void {
    const next = new Set(expandedPages);
    if (next.has(pageId)) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    expandedPages = next;
  }

  let newWorkspaceInput: HTMLInputElement | null = $state(null);
  // Only the box this surface opened: the hub renders one from the same
  // store, and both showing at once would fight over focus and text.
  const naming = $derived($newWorkspaceFlow.naming?.surface === "sidebar" ? $newWorkspaceFlow.naming : null);

  let editingWorkspaceId: string | null = $state(null);
  let workspaceEditValue = $state("");
  let workspaceEditInput: HTMLInputElement | null = $state(null);

  let editingPageId: string | null = $state(null);
  let pageEditValue = $state("");
  let pageEditInput: HTMLInputElement | null = $state(null);

  // A tab row inside an expanded page renames in place, exactly as the
  // workspace and page rows above it do. The tab menu's "Rename…" reaches
  // this surface now, and sending it off to the tab bar to type the name
  // would undo the reason for acting from the sidebar at all -- the row
  // may belong to a page that isn't even on screen.
  let editingSessionId: string | null = $state(null);
  let sessionEditValue = $state("");
  let sessionEditInput: HTMLInputElement | null = $state(null);

  // Tracks which row is currently being hovered during a drag, and how --
  // recomputed fresh on every dragover, so a stale highlight left behind
  // by an imperfect dragleave (a well-known HTML5 DnD fragility -- it
  // fires when the pointer crosses a CHILD element's boundary too, not
  // just when truly leaving the row) gets corrected the moment the
  // pointer moves onto whatever row is actually now under it. Cleared
  // unconditionally on dragend/drop so nothing lingers after the
  // operation completes.
  type HoverState =
    | { targetId: string; kind: "reorder"; position: ReorderPosition }
    | { targetId: string; kind: "zone"; zone: DropZone }
    | { targetId: string; kind: "append" };
  let hoverState: HoverState | null = $state(null);

  function clearHover(): void {
    hoverState = null;
  }

  // The pinned Scratchpad workspace is always rendered first, separately
  // from the reorderable list -- these two derived values split
  // $layoutState.workspaces accordingly. unfiledWorkspace is null only
  // before bootstrap's first workspaces-ready/poll response arrives
  // (the Rust side always creates it once ready).
  const unfiledWorkspace = $derived($layoutState.workspaces.find((w) => w.id === UNFILED_WORKSPACE_ID) ?? null);
  const regularWorkspaces = $derived($layoutState.workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID));

  // ⌘⌥-number addresses workspaces in the order this sidebar renders
  // them (Scratchpad pinned first) -- the same helper the router uses,
  // so a badge and its shortcut can never point at different rows.
  const orderedWorkspaces = $derived(sidebarWorkspaceOrder($layoutState.workspaces));

  /// ⌘⇧-number switches pages, and only within the ACTIVE workspace --
  /// badging another workspace's pages would promise a jump that
  /// shortcut does not make.
  function pageHint(ws: Workspace, index: number): string | null {
    if ($hintMode !== "cmd-shift" || ws.id !== $layoutState.activeWorkspaceId) return null;
    const digit = hintDigitFor(index, ws.pages.length);
    return digit === null ? null : String(digit);
  }

  function workspaceHint(workspaceId: string): string | null {
    if ($hintMode !== "cmd-alt") return null;
    const index = orderedWorkspaces.findIndex((w) => w.id === workspaceId);
    const digit = index === -1 ? null : hintDigitFor(index, orderedWorkspaces.length);
    return digit === null ? null : String(digit);
  }

  // The count this plan's sidebar badges show -- waiting_for_input only,
  // never a generic aggregate across all three states (see this plan's
  // Global Constraints: "working" is background information, not
  // something a badge needs to draw the eye to).
  function waitingForInputCount(page: Page): number {
    return allSessionIds(page.layout).filter((id) => $layoutState.sessionStatusById[id] === "waiting_for_input").length;
  }

  function workspaceWaitingForInputCount(ws: Workspace): number {
    return ws.pages.reduce((sum, page) => sum + waitingForInputCount(page), 0);
  }

  // The two halves of a workspace's recap row. Both are pure tallies
  // (sidebarSummary.ts); everything below only decides how they read.
  function gitRecap(ws: Workspace): WorkspaceGitSummary {
    const phase = agentCommitPhase($gitStore[ws.id] ?? null);
    return workspaceGitSummary(ws, $layoutState.gitStatusById, phase === "starting" || phase === "running");
  }

  function cardRecap(ws: Workspace): KanbanSummary {
    return kanbanSummary($kanbanState[ws.id], $gavinTrees[ws.id]);
  }

  function railRecap(ws: Workspace): RailsSummary {
    return railsSummary($orchestrations[ws.id]);
  }

  // A page's own half of the recap: what it holds, rather than what the
  // workspace adds up to. Same pure-tally shape as the three above.
  function tabsRecap(page: Page): PageAgentsSummary {
    return pageAgentsSummary(page, $layoutState);
  }

  // What a page expands into: one row per tab, in layout order. Same
  // projection the recap counts, so the rows revealed here always add up
  // to the numbers on the row above them.
  function tabRows(page: Page): PageTabRow[] {
    return pageTabRows(page, $layoutState);
  }

  // The card this row's agent is running, if any -- the reverse lookup
  // over card_sessions that already puts a link on the terminal tab
  // itself (cardTabLink.ts), asked here per WORKSPACE rather than for
  // the active one: the sidebar shows every workspace's pages at once,
  // and a row's link belongs to the workspace it is drawn under. Both
  // stores it reads are already fetched for every rooted workspace by
  // the recap effect below, so this costs no extra traffic.
  function cardLink(ws: Workspace, row: PageTabRow): LinkedCard | null {
    return rowLinkedCard($kanbanState[ws.id], $orchestrations[ws.id], $gavinTrees[ws.id], row);
  }

  // A tab's name in the expansion, by the same rules the tab bar itself
  // uses: a board tab names its context, a file tab its filename, a
  // terminal its custom name or cwd. The two exact ones share paths.ts
  // helpers with Pane.svelte so one tab never goes by two names.
  function tabRowLabel(row: PageTabRow): string {
    if (row.kind === "board") {
      const tab = $layoutState.boardTabsById[row.id];
      if (!tab) return row.id;
      const name = $gavinTrees[tab.workspaceId]?.contexts.find((c) => c.folderPath === tab.contextFolder)?.name;
      return boardTabLabel(name, tab.contextFolder);
    }
    if (row.kind === "file") return folderName($layoutState.fileTabsById[row.id]?.path ?? row.id);
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, row.id);
  }

  // "waiting_for_input" is the data-model name; "Request attention" is
  // what the UI has always called it (Pane.svelte's tab dots say the
  // same), so the two surfaces agree.
  const STATUS_WORD: Record<SessionStatus, string> = {
    working: "Working",
    waiting_for_input: "Request attention",
    idle: "Idle",
  };

  // The checkout a session sits in, named by its folder: for a linked
  // worktree that IS the worktree's own directory name, since git reports
  // a worktree's toplevel as its repo root. The full path is in the
  // tooltip -- two sibling worktrees can share a basename.
  function worktreeName(status: GitStatus): string {
    return folderName(status.repoRoot);
  }

  // One bubble for the whole row: what it is, where it lives, and -- for
  // a session in a repo -- the checkout in full, spelled out where the
  // row itself can only afford glyphs. Deliberately NOT a second tooltip
  // on the git line: mouseenter does not bubble, so a nested one would
  // take over the row's and never hand it back.
  function tabRowTip(row: PageTabRow, status: GitStatus | null): string {
    const lines = [row.status ? STATUS_WORD[row.status] : row.kind === "file" ? "File" : "Board"];
    const where =
      row.kind === "board"
        ? ($layoutState.boardTabsById[row.id]?.contextFolder ?? "")
        : row.kind === "file"
          ? ($layoutState.fileTabsById[row.id]?.path ?? "")
          : ($layoutState.cwdBySessionId[row.id] ?? "");
    if (where) lines.push(where);
    if (status) {
      const sync = formatAheadBehind(status).replace("\u2191", "ahead ").replace("\u2193", "behind ");
      const parts = [status.repoRoot, `on ${status.branch}`, status.dirty ? "uncommitted changes" : "clean"];
      if (sync) parts.push(sync);
      lines.push(parts.join(" -- "));
    }
    return lines.join("\n");
  }

  function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  // Spelled out in the tooltip, because the row itself is deliberately
  // just icons and numbers -- there is no room for labels at 200px.
  function gitRecapTip(git: WorkspaceGitSummary): string {
    // A run in flight leads: it is the only part of this chip that is
    // happening right now rather than merely true. And the repo tally
    // drops out entirely at zero -- a run can be the chip's whole reason
    // for existing, and "0 repos" would be the loudest thing on it.
    const parts: string[] = [];
    if (git.committing) parts.push("an agent is committing");
    if (git.repoCount > 0) parts.push(plural(git.repoCount, "repo", "repos"));
    if (git.dirtyCount > 0) parts.push(`${git.dirtyCount} with uncommitted changes`);
    if (git.ahead > 0) parts.push(`${git.ahead} ahead`);
    if (git.behind > 0) parts.push(`${git.behind} behind`);
    return `${parts.join(", ")} -- open Git`;
  }

  // Names every column, so the three-slot tally never hides which custom
  // column a card is actually sitting in.
  function cardRecapTip(cards: KanbanSummary): string {
    const detail = cards.columns
      .filter((c) => c.count > 0)
      .map((c) => `${c.name} ${c.count}`)
      .join(", ");
    return `${plural(cards.total, "card", "cards")}: ${detail} -- open Kanban`;
  }

  // Names every bucket the row itself renders as bare numbers, including
  // the two it does not: waiting agents (they are the amber badge further
  // along the row, not part of the recap) and the file/board tabs that
  // make up the gap between the tab count and the agent count.
  function tabsRecapTip(tabs: PageAgentsSummary): string {
    const buckets: string[] = [];
    if (tabs.running > 0) buckets.push(`${tabs.running} running`);
    if (tabs.waiting > 0) buckets.push(`${tabs.waiting} waiting for input`);
    if (tabs.idle > 0) buckets.push(`${tabs.idle} idle`);
    const agents = tabs.agents === 0 ? "no agents" : `${plural(tabs.agents, "agent", "agents")}: ${buckets.join(", ")}`;
    const others = tabs.tabs - tabs.agents;
    const rest = others > 0 ? `, ${plural(others, "file or board tab", "file or board tabs")}` : "";
    return `${plural(tabs.tabs, "tab", "tabs")} -- ${agents}${rest}`;
  }

  function railRecapTip(rails: RailsSummary): string {
    const parts: string[] = [];
    if (rails.running > 0) parts.push(`${rails.running} running`);
    if (rails.done > 0) parts.push(`${rails.done} done`);
    if (rails.idle > 0) parts.push(`${rails.idle} idle`);
    return `${plural(rails.total, "rail", "rails")}: ${parts.join(", ")} -- open Orchestration`;
  }

  /// The workspace row's Hub button: switch to that workspace and land on
  /// the hub tab it was last showing -- never on a tab it no longer
  /// offers. Where the home row under the workspace name used to go.
  function openHub(ws: Workspace): void {
    switchWorkspace(ws.id);
    switchWorkspaceView(ws.id, resolveHubView(ws, import.meta.env.DEV));
  }

  /// A recap chip's click: straight to the tab that chip summarises,
  /// falling back to the workspace's usual hub landing when that tab is
  /// not on offer (both Git and Orchestration require a bound root).
  function openHubView(ws: Workspace, view: string): void {
    switchWorkspace(ws.id);
    const offered = visibleHubViewIds(ws.id, import.meta.env.DEV, Boolean(ws.rootPath));
    switchWorkspaceView(ws.id, offered.includes(view) ? view : resolveHubView(ws, import.meta.env.DEV));
  }

  // ahead/behind are only meaningful (and only shown) when hasUpstream is
  // true, and only the non-zero side(s) are shown -- "main" alone when
  // fully up to date with its upstream, "main ↑2" when only ahead,
  // "main ↑2 ↓1" when diverged. Not extracted to workspace.ts: this is
  // presentational string formatting, not branching business logic (see
  // this plan's Global Constraints on what needed its own pure-function
  // test), matching this file's existing local-helper precedent
  // (waitingForInputCount and friends are template-local too).
  function formatAheadBehind(status: GitStatus): string {
    if (!status.hasUpstream) return "";
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    return parts.join(" ");
  }

  function isExpanded(workspaceId: string): boolean {
    return expanded.has(workspaceId);
  }

  function toggleExpand(workspaceId: string): void {
    const next = new Set(expanded);
    if (next.has(workspaceId)) {
      next.delete(workspaceId);
    } else {
      next.add(workspaceId);
    }
    expanded = next;
  }

  function startEditingWorkspace(workspaceId: string, currentName: string): void {
    editingWorkspaceId = workspaceId;
    workspaceEditValue = currentName;
  }

  function commitWorkspaceEdit(): void {
    if (editingWorkspaceId === null) return;
    const trimmed = workspaceEditValue.trim();
    const id = editingWorkspaceId;
    editingWorkspaceId = null;
    if (trimmed) void renameWorkspace(id, trimmed);
  }

  function cancelWorkspaceEdit(): void {
    editingWorkspaceId = null;
  }

  function startEditingPage(pageId: string, currentName: string): void {
    editingPageId = pageId;
    pageEditValue = currentName;
  }

  function commitPageEdit(): void {
    if (editingPageId === null) return;
    const trimmed = pageEditValue.trim();
    const id = editingPageId;
    editingPageId = null;
    if (!trimmed) return;
    const ws = $layoutState.workspaces.find((w) => w.pages.some((p) => p.id === id));
    if (!ws) return;
    void renamePage(ws.id, id, trimmed);
  }

  function cancelPageEdit(): void {
    editingPageId = null;
  }

  function startEditingSession(sessionId: string): void {
    // File and board tabs are never renameable -- their labels are exact
    // (the same rule the tab bar's own rename applies).
    if ($layoutState.fileTabsById[sessionId] || $layoutState.boardTabsById[sessionId]) return;
    editingSessionId = sessionId;
    sessionEditValue = sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  function commitSessionEdit(): void {
    if (editingSessionId === null) return;
    const id = editingSessionId;
    editingSessionId = null;
    void setSessionName(id, sessionEditValue);
  }

  function cancelSessionEdit(): void {
    editingSessionId = null;
  }

  function quickAddPage(workspaceId: string): void {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    void createPage(workspaceId, ([id]) => presetSingle(id), 1, `Page ${ws.pages.length + 1}`);
  }

  function reportMenuError(text: string): void {
    console.error(text);
    void message(text, { title: "gavin", kind: "error" });
  }

  function menuHooks(): SidebarMenuHooks {
    return {
      startRenameWorkspace: (id) => {
        const w = $layoutState.workspaces.find((x) => x.id === id);
        if (w) startEditingWorkspace(w.id, w.name);
      },
      startRenamePage: (id) => {
        const p = $layoutState.workspaces.flatMap((w) => w.pages).find((x) => x.id === id);
        if (p) startEditingPage(p.id, p.name);
      },
      startRenameSession: startEditingSession,
      newPage: quickAddPage,
      reportError: reportMenuError,
    };
  }

  // Inside an inline rename input the native text menu must keep working.
  function inTextInput(e: MouseEvent): boolean {
    return e.target instanceof HTMLInputElement;
  }

  function openWorkspaceMenu(e: MouseEvent, ws: Workspace): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildWorkspaceMenuEntries(ws, menuHooks()));
  }

  function openPageMenu(e: MouseEvent, ws: Workspace, page: Page): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildPageMenuEntries(ws, page, $layoutState.workspaces, menuHooks()));
  }

  // The pane a row's tab actually shares. "Close Others" and the two
  // directional closes are defined over the tabs of ONE leaf, not over
  // the whole page, so the menu has to resolve the leaf itself -- and
  // from here that page may not be the active one, which is exactly why
  // it reads the row's own page tree rather than the app's active tree.
  function leafOf(page: Page, tabId: string): { tabs: string[]; pinned: string[] } {
    const path = findLeafPath(page.layout, tabId);
    const node = path ? getNodeAtPath(page.layout, path) : null;
    if (!node || node.type !== "leaf") return { tabs: [tabId], pinned: [] };
    return { tabs: node.tabs, pinned: node.pinned ?? [] };
  }

  // The tab-bar menu's own context, assembled for a sidebar row: same
  // kind vocabulary ("session" is the row word for what the tab menu
  // calls a terminal) and the same per-kind path -- a board tab's
  // context folder, a file tab's file, a terminal's cwd.
  function rowMenuContext(page: Page, row: PageTabRow): TabMenuContext {
    const leaf = leafOf(page, row.id);
    const board = $layoutState.boardTabsById[row.id];
    const file = $layoutState.fileTabsById[row.id];
    return {
      tabId: row.id,
      kind: row.kind === "session" ? "terminal" : row.kind,
      path: board ? board.contextFolder : (file?.path ?? $layoutState.cwdBySessionId[row.id] ?? null),
      pinned: leaf.pinned.includes(row.id),
      tabs: leaf.tabs,
      pinnedTabs: leaf.pinned,
    };
  }

  function openSessionRowMenu(e: MouseEvent, ws: Workspace, page: Page, row: PageTabRow): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildSessionRowMenuEntries(ws, page, rowMenuContext(page, row), menuHooks()));
  }

  function handleWorkspaceDragStart(event: DragEvent, workspaceId: string): void {
    setDragPayload(event, { kind: "workspace", workspaceId });
  }

  function handleWorkspaceDragOver(event: DragEvent, workspaceId: string): void {
    const kind = getDragKind(event);
    if (!kind) return;
    // The pinned Scratchpad workspace isn't part of the reorderable
    // list, so a dragged workspace has nowhere meaningful to land on
    // it -- ignore.
    if (kind === "workspace" && workspaceId === UNFILED_WORKSPACE_ID) return;
    event.preventDefault();
    // Without an explicit dropEffect, the browser shows the "copy" (+)
    // cursor even though setDragPayload set effectAllowed to "move" --
    // dropEffect has to be set on the target's dragover, not just
    // effectAllowed on the source's dragstart.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "workspace" || kind === "page") {
      hoverState = { targetId: workspaceId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: workspaceId, kind: "append" };
    }
  }

  async function handleWorkspaceDrop(event: DragEvent, ws: Workspace): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload) return;
    if (payload.kind === "workspace") {
      if (ws.id === UNFILED_WORKSPACE_ID) return;
      // Looked up live from the authoritative array (not a loop index
      // passed in) so this is correct regardless of whether the pinned
      // Scratchpad workspace occupies a slot ahead of this row or not.
      // Simple index/index+1 relative to the currently rendered array --
      // an approximation (dragging past an immediate neighbor can land
      // one position off in edge cases, since reorderWorkspace removes
      // the moved item before re-inserting, which can shift indices).
      // Acceptable for a first cut of a manually-tested drag interaction;
      // refine later if it feels wrong in practice.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const position = computeReorderPosition(rect, event.clientY);
      const currentIndex = $layoutState.workspaces.findIndex((w) => w.id === ws.id);
      const targetIndex = position === "before" ? currentIndex : currentIndex + 1;
      await reorderWorkspaceAction(payload.workspaceId, targetIndex);
    } else if (payload.kind === "page") {
      await movePageAction(payload.pageId, ws.id, ws.pages.length);
    } else {
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "workspace", workspaceId: ws.id }
      );
    }
  }

  function handlePageDragStart(event: DragEvent, workspaceId: string, pageId: string): void {
    setDragPayload(event, { kind: "page", workspaceId, pageId });
  }

  function handlePageDragOver(event: DragEvent, pageId: string): void {
    const kind = getDragKind(event);
    if (!kind || kind === "workspace") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "page") {
      hoverState = { targetId: pageId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: pageId, kind: "zone", zone: computeDropZone(rect, event.clientX, event.clientY) };
    }
  }

  async function handlePageDrop(event: DragEvent, ws: Workspace, page: Page, index: number): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload || payload.kind === "workspace") return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (payload.kind === "page") {
      const position = computeReorderPosition(rect, event.clientY);
      const targetIndex = position === "before" ? index : index + 1;
      await movePageAction(payload.pageId, ws.id, targetIndex);
    } else {
      const zone = computeDropZone(rect, event.clientX, event.clientY);
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: ws.id, pageId: page.id, mode: zone }
      );
    }
  }

  // Auto-expands a workspace the first time it becomes active, without
  // fighting a later manual collapse. Gating on activeId actually
  // *changing* (via lastSyncedActiveId, a plain closure var -- it's
  // effect-internal bookkeeping, not rendered, so it doesn't need $state)
  // means `expanded` is only read when activeId itself just changed, not
  // on every run this effect happens to see -- reading `expanded` inside
  // an effect that also writes it otherwise re-triggers itself and
  // silently reverts the very collapse it just observed.
  let lastSyncedActiveId: string | null = null;
  $effect(() => {
    const activeId = $layoutState.activeWorkspaceId;
    if (activeId && activeId !== lastSyncedActiveId) {
      lastSyncedActiveId = activeId;
      if (!expanded.has(activeId)) {
        expanded = new Set(expanded).add(activeId);
      }
    }
  });

  // The recap needs EVERY rooted workspace's board and orchestration, not
  // just the active one's (the hub views only fetch the one they show).
  // The gavin tree needs no fetch of its own: bootstrap already watches
  // every rooted workspace. Requested once each -- the Set is what keeps
  // a FAILED fetch from being retried on every layout change, which the
  // stores' own already-loaded guards would not catch.
  const recapRequested = new Set<string>();
  $effect(() => {
    for (const ws of $layoutState.workspaces) {
      if (ws.rootPath && !recapRequested.has(ws.id)) {
        recapRequested.add(ws.id);
        void fetchBoard(ws.id);
        void fetchOrchestration(ws.id);
      }
    }
  });

  $effect(() => {
    if (naming && newWorkspaceInput) {
      newWorkspaceInput.focus();
    }
  });

  $effect(() => {
    if (editingWorkspaceId !== null && workspaceEditInput) {
      workspaceEditInput.focus();
      workspaceEditInput.select();
    }
  });

  $effect(() => {
    if (editingPageId !== null && pageEditInput) {
      pageEditInput.focus();
      pageEditInput.select();
    }
  });

  $effect(() => {
    if (editingSessionId !== null && sessionEditInput) {
      sessionEditInput.focus();
      sessionEditInput.select();
    }
  });
</script>

{#snippet pageList(ws: Workspace)}
  {@const git = gitRecap(ws)}
  {@const cards = cardRecap(ws)}
  {@const rails = railRecap(ws)}
  <div class="page-list">
    <!-- The workspace's first row: what its checkouts, its board and its
         rails add up to, as icons and counters. Rendered only when there
         is something to count -- an all-zero strip is noise, not a
         recap. -->
    {#if hasRecap(git, cards, rails)}
      <div class="recap-row">
        {#if showGitChip(git)}
          <button
            class="recap-chip git"
            aria-label={gitRecapTip(git)}
            use:tooltip={gitRecapTip(git)}
            onclick={() => openHubView(ws, "git")}
          >
            {#if git.committing}
              <span class="commit-spinner" aria-hidden="true"></span>
            {:else}
              <GitBranch size={11} />
            {/if}
            {#if git.repoCount > 0}<span class="recap-count">{git.repoCount}</span>{/if}
            {#if git.dirtyCount > 0}
              <span class="git-dot dirty"></span>
              <span class="recap-count">{git.dirtyCount}</span>
            {/if}
            {#if git.ahead > 0}<span class="recap-delta">&uarr;{git.ahead}</span>{/if}
            {#if git.behind > 0}<span class="recap-delta">&darr;{git.behind}</span>{/if}
          </button>
        {/if}
        {#if cards.total > 0}
          <button
            class="recap-chip cards"
            aria-label={cardRecapTip(cards)}
            use:tooltip={cardRecapTip(cards)}
            onclick={() => openHubView(ws, "kanban")}
          >
            <Kanban size={11} />
            <span class="card-stat todo">{cards.todo}</span>
            <span class="card-stat progress">{cards.inProgress}</span>
            <span class="card-stat done">{cards.done}</span>
          </button>
        {/if}
        {#if rails.total > 0}
          <button
            class="recap-chip rails"
            aria-label={railRecapTip(rails)}
            use:tooltip={railRecapTip(rails)}
            onclick={() => openHubView(ws, "orchestration")}
          >
            {#if rails.running > 0}
              <span class="rail-stat running"><Play size={10} /><span class="recap-count">{rails.running}</span></span>
            {/if}
            {#if rails.done > 0}
              <span class="rail-stat done"><Check size={10} /><span class="recap-count">{rails.done}</span></span>
            {/if}
            {#if rails.idle > 0}
              <span class="rail-stat idle"><CircleDashed size={10} /><span class="recap-count">{rails.idle}</span></span>
            {/if}
          </button>
        {/if}
      </div>
    {/if}
    {#each ws.pages as page, pageIndex (page.id)}
      {@const tabs = tabsRecap(page)}
      <div class="page-row-group">
        <div
          class="page-row"
          class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId && getActiveView(ws) === "terminal"}
          class:drop-before={hoverState?.targetId === page.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "before"}
          class:drop-after={hoverState?.targetId === page.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "after"}
          class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
          class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
          class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
          class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
          class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
          draggable={editingPageId !== page.id}
          ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
          ondragover={(e) => handlePageDragOver(e, page.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
          oncontextmenu={(e) => openPageMenu(e, ws, page)}
        >
          <!-- Pages expand the way workspaces do, and for the same reason:
               the row is a summary, the expansion is the contents. Offered
               whenever there is a tab to show; an empty page gets a spacer
               instead, so a dead chevron never sits there and the names of
               its neighbours stay on one column. -->
          {#if tabs.tabs > 0}
            <IconButton
              icon={isPageExpanded(page.id) ? ChevronDown : ChevronRight}
              label={isPageExpanded(page.id) ? "Collapse tabs" : "Expand tabs"}
              size={10}
              onclick={() => togglePageExpand(page.id)}
            />
          {:else}
            <span class="page-expand-spacer"></span>
          {/if}
          {#if $hintMode === "cmd-shift"}
            {@const hint = pageHint(ws, pageIndex)}
            {#if hint}<ShortcutHint text={hint} />{/if}
          {/if}
          {#if editingPageId === page.id}
            <input
              class="page-name-input"
              bind:this={pageEditInput}
              bind:value={pageEditValue}
              onclick={(e) => e.stopPropagation()}
              onblur={commitPageEdit}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPageEdit();
                }
              }}
            />
          {:else}
            <span
              class="page-name"
              ondblclick={() => startEditingPage(page.id, page.name)}
              onclick={() => {
                switchWorkspaceView(ws.id, "terminal");
                switchPage(ws.id, page.id);
              }}
            >{page.name}</span>
          {/if}
          <!-- What this page holds: its tab count, then the agents behind
               those tabs, running first. Suppressed while the row is being
               renamed -- the rename input wants the whole row, and this is
               the width being added to it. Waiting agents are deliberately
               absent: they are the badge a few elements along, and showing
               the same number twice on a 200px row buys nothing. -->
          {#if editingPageId !== page.id && tabs.tabs > 0}
            <span class="page-recap" role="group" aria-label={tabsRecapTip(tabs)} use:tooltip={tabsRecapTip(tabs)}>
              <span class="tab-stat total"><PanelsTopLeft size={10} /><span class="recap-count">{tabs.tabs}</span></span>
              {#if tabs.running > 0}
                <span class="tab-stat running"><Play size={9} /><span class="recap-count">{tabs.running}</span></span>
              {/if}
              {#if tabs.idle > 0}
                <span class="tab-stat idle"><CircleDashed size={9} /><span class="recap-count">{tabs.idle}</span></span>
              {/if}
            </span>
          {/if}
          {#if waitingForInputCount(page) > 0}
            <span class="waiting-badge">{waitingForInputCount(page)}</span>
          {/if}
          <button
            class="close-page"
            aria-label="Close Page"
            title="Close Page"
            onclick={async () => {
              if (await confirmPageClose(ws.id, page.id)) {
                void closePage(ws.id, page.id);
              }
            }}
          >
            <X size={10} />
          </button>
        </div>
        <!-- The page's contents. One row per tab in layout order, each
             saying what it is (an agent and its state, or a file / board
             tab) and, underneath, which checkout it sits in: worktree,
             branch, whether it is dirty, how far it has drifted. That
             detail used to crowd the page row itself; it belongs here,
             where there is room for all of it and it is opt-in. -->
        {#if isPageExpanded(page.id)}
          <div class="page-tabs">
            {#each tabRows(page) as row (row.id)}
              {@const gitStatus = row.kind === "session" ? $layoutState.gitStatusById[row.id] : null}
              <div
                class="tab-row"
                class:active={row.id === $layoutState.focusedSessionId}
                use:tooltip={tabRowTip(row, gitStatus)}
                onclick={() => {
                  switchWorkspaceView(ws.id, "terminal");
                  switchToSessionInPage(ws.id, page.id, row.id);
                }}
                oncontextmenu={(e) => openSessionRowMenu(e, ws, page, row)}
              >
                <span class="tab-kind {row.status ?? row.kind}">
                  {#if row.kind === "board"}
                    <Kanban size={10} />
                  {:else if row.kind === "file"}
                    <FileText size={10} />
                  {:else if row.status === "working"}
                    <Play size={10} />
                  {:else if row.status === "waiting_for_input"}
                    <CircleDot size={10} />
                  {:else}
                    <CircleDashed size={10} />
                  {/if}
                </span>
                <span class="tab-body">
                  {#if editingSessionId === row.id}
                    <input
                      class="tab-name-input"
                      bind:this={sessionEditInput}
                      bind:value={sessionEditValue}
                      onclick={(e) => e.stopPropagation()}
                      onblur={commitSessionEdit}
                      onkeydown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitSessionEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelSessionEdit();
                        }
                      }}
                    />
                  {:else}
                    <span class="tab-label" ondblclick={() => startEditingSession(row.id)}>{tabRowLabel(row)}</span>
                  {/if}
                  {#if gitStatus}
                    <span class="tab-git">
                      <span class="worktree">{worktreeName(gitStatus)}</span>
                      <GitBranch size={9} />
                      <span class="git-branch">{gitStatus.branch}</span>
                      <span class="git-dot" class:dirty={gitStatus.dirty} class:clean={!gitStatus.dirty}></span>
                      {#if formatAheadBehind(gitStatus)}
                        <span class="git-ahead-behind">{formatAheadBehind(gitStatus)}</span>
                      {/if}
                    </span>
                  {/if}
                </span>
                <!-- The same jump the terminal tab's own link makes, on
                     the same glyph, so one habit covers both surfaces.
                     Its own bubble even though the row already has one:
                     an unlabelled control has to say what it does, and
                     naming the card is the whole point of the link. The
                     row's bubble does not come back until the pointer
                     re-enters the row (mouseenter does not repeat within
                     it) -- accepted here, unlike on the git line, which
                     is detail rather than a control. -->
                {#if cardLink(ws, row)}
                  {@const link = cardLink(ws, row)}
                  <span
                    class="card-link"
                    aria-label="Open the card this agent is running"
                    use:tooltip={`Open card · ${link?.title}`}
                    onclick={(e) => {
                      e.stopPropagation();
                      if (link) void openLinkedCard(ws.id, link);
                    }}
                  >
                    <SquareArrowOutUpRight size={10} />
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}

<div class="sidebar">
  <div class="sidebar-header">
    <span>Workspaces</span>
    <IconButton icon={Plus} label="New Workspace" size={14} onclick={() => startCreatingWorkspace("sidebar")} />
  </div>
  {#if naming}
    <input
      class="new-workspace-input"
      bind:this={newWorkspaceInput}
      value={naming.name}
      oninput={(e) => setNewWorkspaceName(e.currentTarget.value)}
      onblur={() => void commitNewWorkspace()}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commitNewWorkspace();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelNewWorkspace();
        }
      }}
    />
  {/if}
  <div class="workspace-list">
    {#if unfiledWorkspace}
      {@const ws = unfiledWorkspace}
      <div
        class="workspace-row-group"
        style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
      >
        <div
          class="workspace-row pinned"
          class:active={ws.id === $layoutState.activeWorkspaceId}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws)}
          oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
        >
          <!-- The Scratchpad is a drawer for loose pages, not a
               project: it has no hub worth landing on. The spacer keeps
               its chevron in line with every other workspace's. -->
          <span class="hub-spacer" aria-hidden="true"></span>
          <IconButton
            icon={isExpanded(ws.id) ? ChevronDown : ChevronRight}
            label={isExpanded(ws.id) ? "Collapse" : "Expand"}
            size={12}
            onclick={() => toggleExpand(ws.id)}
          />
          {#if $hintMode === "cmd-alt"}
            {@const hint = workspaceHint(ws.id)}
            {#if hint}<ShortcutHint text={hint} />{/if}
          {/if}
          <span class="workspace-name" onclick={() => switchWorkspace(ws.id)}>{ws.name}</span>
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws)}
        {/if}
      </div>
    {/if}
    {#each regularWorkspaces as ws (ws.id)}
      <div
        class="workspace-row-group"
        style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
      >
        <div
          class="workspace-row"
          class:active={ws.id === $layoutState.activeWorkspaceId}
          class:drop-before={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "before"}
          class:drop-after={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "after"}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          draggable={editingWorkspaceId !== ws.id}
          ondragstart={(e) => handleWorkspaceDragStart(e, ws.id)}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws)}
          oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
        >
          <IconButton
            icon={House}
            label="Hub"
            size={12}
            active={ws.id === $layoutState.activeWorkspaceId && getActiveView(ws) !== "terminal"}
            onclick={() => openHub(ws)}
          />
          <IconButton
            icon={isExpanded(ws.id) ? ChevronDown : ChevronRight}
            label={isExpanded(ws.id) ? "Collapse" : "Expand"}
            size={12}
            onclick={() => toggleExpand(ws.id)}
          />
          {#if editingWorkspaceId === ws.id}
            <input
              class="workspace-name-input"
              bind:this={workspaceEditInput}
              bind:value={workspaceEditValue}
              onclick={(e) => e.stopPropagation()}
              onblur={commitWorkspaceEdit}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitWorkspaceEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelWorkspaceEdit();
                }
              }}
            />
          {:else}
            {#if $hintMode === "cmd-alt"}
              {@const hint = workspaceHint(ws.id)}
              {#if hint}<ShortcutHint text={hint} />{/if}
            {/if}
            <span
              class="workspace-name"
              ondblclick={() => startEditingWorkspace(ws.id, ws.name)}
              onclick={() => switchWorkspace(ws.id)}
            >{ws.name}</span>
          {/if}
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
          <button
            class="close-workspace"
            aria-label="Close Workspace"
            title="Close Workspace"
            onclick={async () => {
              if (await confirmWorkspaceClose(ws.id)) {
                void closeWorkspace(ws.id);
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws)}
        {/if}
      </div>
    {/each}
  </div>
  <div class="sidebar-footer">
    <button class="footer-row" disabled title="Coming soon">
      <Settings size={12} />
      <span>Settings</span>
    </button>
    <div class="footer-row theme-row">
      <span>Theme</span>
      <div class="theme-toggle">
        {#each THEME_OPTIONS as opt (opt.pref)}
          <IconButton
            icon={opt.icon}
            label={opt.label}
            variant="segmented"
            size={12}
            active={themeState.pref === opt.pref}
            onclick={() => void themeState.setPref(opt.pref)}
          />
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sidebar {
    width: 200px;
    flex: 0 0 auto;
    background: var(--surface-raised);
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    display: flex;
    flex-direction: column;
    /* The scroll lives on .workspace-list, not here: a footer on a
       scrolling sidebar would slide away with the content. Pinning it
       pins the header too, which it wasn't before. */
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .workspace-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .sidebar-header {
    /* Pinned now that .sidebar no longer scrolls -- without this it can
       shrink when the workspace list is long. */
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    font-weight: bold;
    color: var(--text-muted);
  }
  .sidebar-header button {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
  }
  .new-workspace-input,
  .workspace-name-input,
  .page-name-input {
    background: var(--surface-sunken);
    color: var(--text);
    border: 1px solid var(--border-focus);
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 2px 4px;
    margin: 0 8px 4px 8px;
    width: calc(100% - 16px);
    box-sizing: border-box;
  }
  .workspace-row-group {
    /* The workspace's colour, as ONE stripe running the full height of
       the group -- the header row, the recap row, the pages and their
       git detail -- rather than a mark on the header alone. Its own
       variable, always set: --ws-accent is inherited from the active
       workspace's container, which would paint every group. */
    border-left: 3px solid var(--row-accent, transparent);
  }
  .workspace-row {
    /* Anchors the hold-⌘ hint badge. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    /* Every padding-left below drops by the stripe's width, so contents
       sit exactly where they did before the group carried a stripe. */
    padding: 4px 8px 4px 5px;
    cursor: pointer;
  }
  /* An IconButton at size 12 measures 24px across (12px icon + 5px of
     padding and 1px of transparent border a side), and this stands in
     for one -- so the Scratchpad's chevron lines up with the chevrons
     that sit beside a Hub button. */
  .hub-spacer {
    flex: 0 0 auto;
    width: 24px;
  }
  .workspace-row.active {
    background: var(--surface-raised);
  }
  .workspace-row.pinned {
    font-style: italic;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }
  .workspace-row.pinned.active {
    color: var(--text);
  }
  .workspace-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waiting-badge {
    flex: 0 0 auto;
    background: var(--danger);
    color: var(--text-inverted);
    border-radius: 8px;
    padding: 0 5px;
    font-size: 0.85em;
    line-height: 1.4;
    min-width: 14px;
    text-align: center;
  }
  .git-branch {
    flex: 0 1 auto;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .git-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    box-sizing: border-box;
  }
  .git-dot.dirty {
    background: var(--warning);
  }
  .git-dot.clean {
    background: transparent;
    border: 1px solid var(--warning);
  }
  .git-ahead-behind {
    flex: 0 1 auto;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .close-workspace,
  .close-page {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    flex: 0 0 auto;
  }
  .close-workspace:hover,
  .close-page:hover {
    opacity: 1;
  }
  .page-list {
    display: flex;
    flex-direction: column;
  }
  .page-row {
    /* Anchors the hold-⌘ hint badge, which overlays the row rather than
       reflowing (and re-truncating) its name. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px 3px 25px;
    cursor: pointer;
  }
  .page-row.active {
    background: var(--surface-base);
    color: var(--text);
  }
  .recap-row {
    display: flex;
    align-items: center;
    /* Wraps rather than overflows: three chips at their widest do not fit
       a 200px sidebar, and a recap that clips is worse than one on two
       lines. */
    flex-wrap: wrap;
    gap: 2px 6px;
    /* 22, not the page rows' 25: the chips carry 3px of padding of their
       own, so their icons land on the same column as the page names. */
    padding: 2px 8px 2px 22px;
    color: var(--text-muted);
  }
  .recap-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 4px;
    background: transparent;
    /* A hairline in the chip's own hue, so the three read as three
       things rather than one run of numbers. */
    border: 1px solid var(--chip-border, var(--border));
    border-radius: 4px;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .recap-chip:hover {
    background: var(--surface-hover);
    border-color: var(--chip-border-hover, var(--border-strong));
    color: var(--text);
  }
  /* CATEGORICAL, not semantic: these three name a context -- git, board,
     rails -- and carry no judgement about it. The --border-* ramp is the
     dimmest tinted hairline the theme offers (and is tuned per theme, a
     lighter step on light surfaces), which is what keeps an identity
     colour from reading as a status. The full-strength hue is held back
     for hover, so a chip only speaks up once you point at it. */
  .recap-chip.git {
    --chip-border: var(--border-warning);
    --chip-border-hover: var(--warning);
  }
  /* Takes the branch glyph's place rather than sitting beside it, so the
     chip keeps its width while a run is in flight -- the sidebar is
     narrow, and a strip of chips that reflows on its own is worse than
     one that stays put. */
  .commit-spinner {
    width: 9px;
    height: 9px;
    flex: 0 0 auto;
    margin: 1px;
    border: 2px solid var(--border-accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: recap-spin 0.8s linear infinite;
  }
  @keyframes recap-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .recap-chip.cards {
    --chip-border: var(--border-accent);
    --chip-border-hover: var(--accent);
  }
  .recap-chip.rails {
    --chip-border: var(--border-success);
    --chip-border-hover: var(--success);
  }
  .recap-chip:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .recap-count {
    font-variant-numeric: tabular-nums;
  }
  .recap-delta {
    font-size: 0.9em;
    white-space: nowrap;
  }
  /* A fixed three-slot tally: to do, in progress, done, always in that
     order and always all three, zeros included -- the positions are what
     make three bare numbers readable, so hiding a zero would only make
     the rest ambiguous. Hairline dividers keep them from reading as one
     number; the tooltip names each column outright. */
  .card-stat {
    font-variant-numeric: tabular-nums;
  }
  .card-stat + .card-stat {
    margin-left: 1px;
    padding-left: 4px;
    border-left: 1px solid var(--border);
  }
  .card-stat.progress {
    color: var(--accent-text);
  }
  .card-stat.done {
    color: var(--success-text);
  }
  /* One tally per rail phase, coloured the way the Orchestration tab
     colours a rail's own state. */
  .rail-stat {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .rail-stat.running {
    color: var(--accent-text);
  }
  .rail-stat.done {
    color: var(--success-text);
  }
  /* The page row's own recap: how many tabs the page holds, and how many
     agents are running / idle behind them. Same icon vocabulary as the
     rails chip above -- Play for running, an unfilled ring for idle, and
     idle left muted rather than coloured -- so the two rows read as one
     system. Borderless, unlike the workspace chips: those are buttons,
     this is a readout, and a 200px page row has no width to spend on a
     hairline that carries no meaning of its own.
     `flex: 0 0 auto`, so the page name and the branch shrink around it:
     they say the same thing truncated, three tiny numbers do not. */
  .page-recap {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .tab-stat {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .tab-stat.running {
    color: var(--accent-text);
  }
  .workspace-row.drop-before,
  .page-row.drop-before {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
  .workspace-row.drop-after,
  .page-row.drop-after {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
  .workspace-row.drop-append {
    background: var(--surface-selected);
  }
  .page-row.drop-zone-left {
    box-shadow: inset 2px 0 0 0 var(--accent);
  }
  .page-row.drop-zone-right {
    box-shadow: inset -2px 0 0 0 var(--accent);
  }
  .page-row.drop-zone-top {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
  .page-row.drop-zone-bottom {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
  .page-row.drop-zone-center {
    background: var(--surface-selected);
  }
  .page-expand-spacer {
    width: 22px;
    flex: 0 0 auto;
  }
  .page-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A page's expanded contents. Indented past the page names the way the
     page names are indented past the workspace names, so the three levels
     read as one outline. */
  .page-tabs {
    display: flex;
    flex-direction: column;
  }
  .tab-row {
    display: flex;
    /* Top, not center: a row with a git line under it is two lines tall,
       and its icon belongs beside the NAME, not floating between them. */
    align-items: flex-start;
    gap: 4px;
    padding: 2px 8px 2px 41px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .tab-row:hover {
    background: var(--surface-base);
  }
  .tab-row.active {
    background: var(--surface-base);
    color: var(--text);
  }
  /* Same three-state vocabulary as the recap above and the terminal tab
     dots: working speaks up in the accent, an unfilled ring is idle, and
     waiting is the one that asks for you -- the warning hue the page
     row's badge already uses for exactly that. File and board tabs stay
     muted; nothing is running behind them to have a state. */
  .tab-kind {
    display: inline-flex;
    /* Aligns the icon to the label's cap height rather than the row's
       top edge, at this row's own (0.9em) size. */
    padding-top: 2px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .tab-kind.working {
    color: var(--accent-text);
  }
  .tab-kind.waiting_for_input {
    color: var(--warning);
  }
  /* Beside the NAME, like .tab-kind on the other side -- a row with a
     git line under it is two lines tall and the link belongs on the
     first. Same muted-until-hovered accent the tab bar's own card link
     uses. */
  .card-link {
    display: inline-flex;
    padding-top: 2px;
    flex: 0 0 auto;
    opacity: 0.55;
    color: var(--accent-text);
  }
  .card-link:hover {
    opacity: 1;
  }
  .tab-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    /* Without this a flex child refuses to shrink below its content, and
       a long branch name would push the row's own width out. */
    min-width: 0;
    flex: 1 1 auto;
  }
  /* The rename input takes the label's place in the row, so it inherits
     the row's own type scale rather than the browser's input default --
     otherwise the row jumps a few pixels taller the moment you rename. */
  .tab-name-input {
    background: var(--surface-sunken);
    color: var(--text);
    border: 1px solid var(--border-focus);
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 0 3px;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .tab-row.active .tab-label {
    color: var(--text);
  }
  /* The second line: which checkout this session is in, and where that
     checkout stands. Its own line rather than trailing the name, because
     four pieces of git detail and a name do not share 200px -- which is
     what pushed this off the page row in the first place. */
  .tab-git {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  /* The worktree is the identity; the branch is the state. Shrink the
     worktree first -- a truncated folder name is still recognisable, a
     truncated branch name is a different branch. */
  .tab-git .worktree {
    /* Shrink factor 3 against .git-branch's 1: when the line is too long
       it is the worktree that gives way first. */
    flex: 0 3 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.75;
  }
  .sidebar-footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    padding: 4px 0;
  }
  .footer-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: inherit;
    text-align: left;
  }
  button.footer-row {
    cursor: pointer;
  }
  button.footer-row:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  button.footer-row:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .theme-row {
    justify-content: space-between;
  }
  .theme-toggle {
    display: flex;
    gap: 2px;
    /* One inset well holding all three, so the active segment reads as a
       selection rather than three unrelated buttons. */
    background: var(--surface-sunken);
    border-radius: 4px;
    padding: 1px;
  }
</style>
