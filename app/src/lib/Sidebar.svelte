<script lang="ts">
  import { accentVar } from "./settings";
  import GlobalSettingsModal from "./GlobalSettingsModal.svelte";
  import SessionsManagerModal from "./SessionsManagerModal.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import AgentUsageModal from "./AgentUsageModal.svelte";
  import { activePause, nowStore, worstUsageProjection } from "./agentPauseState";
  import { pauseLabel } from "./agentPause";
  import { fleetStripLine, launchGateVerdict } from "./launchQueue";
  import { projectionTooltip } from "./usageProjection";
  // Which of the two app-level panels is open. A store rather than this
  // component's own `$state`, because the app hub's recaps open the same
  // two panels and a flag inside Sidebar.svelte can only be flipped from
  // inside Sidebar.svelte. The mount stays here: the sidebar is on
  // screen for the life of the window, and one mount point is what keeps
  // two openers from putting two panels on top of each other.
  import { closeAppPanel, openAppPanel, showAppPanel } from "./appPanels";
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
    setWorkspacePinned,
    setPagePinned,
    appHubOpen,
    openAppHub,
    agentProfilesStore,
    gitTrackingDefault,
    attentionState,
  } from "./layoutState";
  import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
  // Naming a workspace into existence is the app hub's action now; the
  // sidebar's is "Open workspace…", which starts from a folder. The
  // prompt below is the one question that flow can ask.
  import { pendingOpen, initAndOpen, bindWithoutInit, cancelOpen } from "./workspaceOpen";
  import { INIT_TRACKING_LABEL, resolveGitTracking } from "./gitTracking";
  import { sidebarCollapsed, scratchpadEnabled, toggleSidebarCollapsed } from "./sidebarPrefs";
  import { endSidebarPeek, peekSidebar, sidebarPeek, sidebarShowsRail } from "./sidebarPeek";
  import {
    closeSidebarSearch,
    searchSidebar,
    sidebarSearchOpen,
    sidebarSearchQuery,
    type SidebarHit,
    type SidebarSearchResult,
  } from "./sidebarSearch";
  import { isSearching } from "./search";
  import type { SessionStatus } from "./layoutState";
  import { presetSingle, findLeafPath, getNodeAtPath } from "./layout";
  import {
    ChevronRight,
    ChevronDown,
    Plus,
    X,
    House,
    Settings,
    Gauge,
    GitBranch,
    Kanban,
    ListChecks,
    Check,
    FileText,
    PanelsTopLeft,
    SquareArrowOutUpRight,
    Boxes,
    Activity,
    AppWindow,
    Search,
    Pin,
    PanelLeftOpen,
  } from "@lucide/svelte";
  import { themeState } from "./ui/themeState.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import {
    agentIndicator,
    agentIndicatorByState,
    gitIndicator,
    usageProjectionIndicator,
  } from "./ui/indicators";

  import { sessionLabel, folderName, boardTabLabel, cardTabLabel, followUpsTabLabel } from "./paths";
  import { resolveHubView, visibleHubViewIds } from "./hubViewMeta";
  import { currentHubTabPrefs } from "./hubTabPrefs";
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
  import {
    UNFILED_WORKSPACE_ID,
    getActiveView,
    isPinned,
    sidebarPageOrder,
    sidebarWorkspaceOrder,
    type Workspace,
    type Page,
    type GitStatus,
  } from "./workspace";
  import {
    workspaceGitSummary,
    kanbanSummary,
    railsSummary,
    railStripStats,
    pageAgentsSummary,
    workspaceAgentsSummary,
    pageTabRows,
    hasRecap,
    showGitChip,
    type WorkspaceGitSummary,
    type KanbanSummary,
    type RailsSummary,
    type PageAgentsSummary,
    type PageTabRow,
  } from "./sidebarSummary";
  import { rowLinkedCard, openLinkedCard, linkForCardPath, type LinkedCard } from "./cardTabLink";
  import {
    orchestrations,
    fetchOrchestration,
    stepAttentionsByWorkspace,
  } from "./orchestrationState";
  import { railsWantingAttention } from "./orchestration";
  import { kanbanState, fetchBoard } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { tooltip } from "./tooltip";
  import { availableUpdate } from "./updatesState";
  import { hintMode } from "./shortcutHints";
  import { agentCommitPhase, gitStore } from "./gitState";
  import { hintDigitFor } from "./shortcuts";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
  import { showAlert } from "./dialog";
  import { openContextMenuFromEvent } from "./contextMenu";
  import {
    buildWorkspaceMenuEntries,
    buildPageMenuEntries,
    buildSessionRowMenuEntries,
    type SidebarMenuHooks,
  } from "./sidebarMenu";
  import { closeTabsNow } from "./tabActions";
  import { windowDrag } from "./windowDrag";
  import { isInAnotherWindow } from "./appWindow";
  import { currentWindowLabel, workspaceWindows } from "./appWindowState";
  import type { CloseIdleRequest } from "./idleTabs";
  import type { TabMenuContext } from "./tabMenu";
  import {
    loadWorkspaceExpansion,
    saveWorkspaceExpansion,
    loadExpandedPages,
    saveExpandedPages,
    type WorkspaceExpansion,
  } from "./sidebarExpansion";

  // Which workspaces show their page list, and which pages show their
  // tab list. Kept apart rather than in one Set, since workspace ids and
  // page ids are different concepts that happen to both be strings -- and
  // because only one of the two has a third state (below).
  //
  // Both are restored from storage at mount and written back on every
  // change (sidebarExpansion.ts). `+page.svelte` mounts this component
  // only while the layout is `ready`, so a reload, a hot module swap or a
  // daemon reconnect used to snap every row shut and leave the human
  // re-opening the same workspaces several times a day.
  //
  // The workspaces' side is a TRI-STATE record -- true open, false
  // closed, absent never answered -- because the auto-expand effect
  // further down has to tell a deliberate collapse from a workspace
  // nobody has ruled on yet; a bare set of open ids would read the
  // collapse as the latter and undo it on the next mount. Pages need no
  // such distinction: nothing auto-expands one, so absent and collapsed
  // are the same answer.
  let workspaceExpansion: WorkspaceExpansion = $state(loadWorkspaceExpansion());
  let expandedPages: Set<string> = $state(loadExpandedPages());

  // Every write prunes against what still exists, so entries for deleted
  // workspaces and closed pages -- uuids, which can never match again --
  // don't accumulate for the life of the install.
  function knownWorkspaceIds(): string[] {
    return $layoutState.workspaces.map((ws) => ws.id);
  }

  function knownPageIds(): string[] {
    return $layoutState.workspaces.flatMap((ws) => ws.pages.map((page) => page.id));
  }

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
    saveExpandedPages(next, knownPageIds());
  }

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
  const unfiledWorkspace = $derived(
    $scratchpadEnabled
      ? ($layoutState.workspaces.find((w) => w.id === UNFILED_WORKSPACE_ID) ?? null)
      : null
  );
  const regularWorkspaces = $derived($layoutState.workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID));

  // ⌘⌥-number addresses workspaces in the order this sidebar renders
  // them (Scratchpad pinned first) -- the same helper the router uses,
  // so a badge and its shortcut can never point at different rows.
  const orderedWorkspaces = $derived(
    sidebarWorkspaceOrder($layoutState.workspaces, $scratchpadEnabled)
  );

  /// The list the collapsed rail and the search draw from: exactly the
  /// rows the expanded sidebar would render, in the order it renders
  /// them. Going through orderedWorkspaces rather than re-splitting
  /// pinned-from-rest is what keeps all three views (expanded, collapsed,
  /// searched) naming the same workspaces in the same order.
  const visibleWorkspaces = $derived(orderedWorkspaces);

  /// One letter for the collapsed rail. The first character of the name
  /// rather than an initialism: it is an identifier, not an abbreviation,
  /// and two-letter marks turn a 12px column into a reading exercise.
  /// Falls back to "?" for a name that is somehow empty, so a row is
  /// never a blank button.
  function workspaceInitial(ws: Workspace): string {
    return (ws.name.trim()[0] ?? "?").toUpperCase();
  }

  /// Collapsed and not peeking: the column is its icon rail, and every
  /// row in it is an initial or a glyph. Everything that used to ask
  /// `$sidebarCollapsed` asks this instead, so a peek renders the SAME
  /// sidebar rather than a third version of it.
  const showsRail = $derived(sidebarShowsRail($sidebarCollapsed, $sidebarPeek));
  /// The full column floated over the view rather than filling its own.
  /// Only ever true while the collapse preference is on -- an expanded
  /// sidebar is never an overlay, whatever the peek flag says.
  const peeking = $derived($sidebarCollapsed && $sidebarPeek);

  /// The element the peek is measured against: the pointer leaving it is
  /// what ends the peek, and a press landing outside it is the backstop
  /// for a peek the pointer never entered (the search button opens one
  /// from the header row, where mouseleave alone would never fire).
  /// $state because the $effect below reads it -- a plain `let` binding
  /// establishes no reactivity there.
  let sidebarEl: HTMLElement | null = $state(null);

  /// Both ways out of a peek, wired only while one is up.
  ///
  /// Listeners rather than an `onmouseleave` attribute: the a11y warning
  /// a bare div with a mouse handler earns can only be silenced with a
  /// `svelte-ignore`, and that comment covers every element nested under
  /// it too -- four honest warnings in this file would have gone quiet
  /// with it.
  ///
  /// The press backstop is what covers a peek the pointer never entered:
  /// the header's search button opens one from outside the column, where
  /// mouseleave alone would never fire.
  $effect(() => {
    if (!$sidebarPeek) return;
    const el = sidebarEl;
    if (!el) return;
    const leave = (): void => endSidebarPeek();
    const onDown = (event: MouseEvent): void => {
      if (!el.contains(event.target as Node)) endSidebarPeek();
    };
    el.addEventListener("mouseleave", leave);
    // Capture, so a press that also opens a peek (the header's search
    // button) closes the old one first and opens the new one on click.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      el.removeEventListener("mouseleave", leave);
      window.removeEventListener("mousedown", onDown, true);
    };
  });

  /// Pressing a row on the icon rail opens the peek along with whatever
  /// the row does. Pressing one is the human saying "this column,
  /// please", and answering with only the navigation would leave them
  /// with no way to read what they just landed on short of collapsing
  /// the sidebar back and forth.
  ///
  /// The rows that open a MODAL (task manager, usage, settings) do not
  /// call this: the modal covers the column, so the peek would end on
  /// the first mouse move without ever having been seen.
  function pressedRail(): void {
    if (showsRail) peekSidebar();
  }

  /// The usage semaphore: whether the limits gavin can see will survive
  /// to their own reset at the burn it has measured. Null until there is
  /// something honest to draw, which is also what the pause badge beside
  /// it reads to decide who owns the push to the end of the row.
  ///
  /// The agent's display name is looked up here rather than carried on
  /// the projection (usageProjection.ts): naming the agents is the
  /// surface's job, and keeping it out is what stops the pause module
  /// importing the profile table into its whole dependency graph.
  const usageSemaphore = $derived.by(() => {
    const projection = $worstUsageProjection;
    if (!projection) return null;
    const label =
      $agentProfilesStore.find((p) => p.id === projection.profileId)?.label ??
      projection.profileId;
    return usageProjectionIndicator(
      projection.band,
      projectionTooltip(projection, label, $nowStore)
    );
  });

  const searchOpen = $derived($sidebarSearchOpen && !showsRail);

  /// The result list, or null when nothing is being searched -- which is
  /// what tells the template to leave the ordinary workspace list up. An
  /// open-but-empty search row must not blank the sidebar.
  const searchHits = $derived.by((): SidebarSearchResult | null => {
    if (!searchOpen || !isSearching($sidebarSearchQuery)) return null;
    return searchSidebar(
      {
        workspaces: visibleWorkspaces,
        // The acknowledged view, so a hit's badge says the same thing as
        // the row it jumps to.
        tabs: $attentionState,
        sessionNames: $layoutState.sessionNames,
        cwdBySessionId: $layoutState.cwdBySessionId,
      },
      $sidebarSearchQuery
    );
  });

  /// Focus follows the row opening, so the magnifier is one click and
  /// then typing. `searchOpen` is the guard rather than the store itself:
  /// collapsing the sidebar takes the row down without closing the
  /// search, and focusing an input that is not rendered throws.
  let searchInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (searchOpen && searchInput) searchInput.focus();
  });

  /// Picking a hit closes the search. It is a destination, not a filter:
  /// leaving the results up over the workspace you were just sent to
  /// would hide the very row that says you arrived.
  async function openHit(hit: SidebarHit): Promise<void> {
    closeSidebarSearch();
    if (hit.sessionId && hit.pageId) {
      await switchWorkspaceView(hit.workspaceId, "terminal");
      await switchToSessionInPage(hit.workspaceId, hit.pageId, hit.sessionId);
    } else if (hit.pageId) {
      await switchWorkspaceView(hit.workspaceId, "terminal");
      await switchPage(hit.workspaceId, hit.pageId);
    } else {
      await switchWorkspace(hit.workspaceId);
    }
  }

  /// The pages of a workspace in the order this sidebar draws them:
  /// pinned first. Shared with the ⌘⇧-number router (keyboard.ts calls
  /// the same helper) so a hint badge and the shortcut it promises can
  /// never name different pages.
  function orderedPages(ws: Workspace): Page[] {
    return sidebarPageOrder(ws.pages);
  }

  /// ⌘⇧-number switches pages, and only within the ACTIVE workspace --
  /// badging another workspace's pages would promise a jump that
  /// shortcut does not make. `index` counts the RENDERED rows, which is
  /// what the router counts too.
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

  // The count the sidebar's badges show -- waiting_for_input only, never
  // a generic aggregate across all three states (see this plan's Global
  // Constraints: "working" is background information, not something a
  // badge needs to draw the eye to).
  //
  // Read off the very tallies the recap strip beside it uses
  // (sidebarSummary.ts) rather than walked again here. The page badge is
  // `tabs.waiting` from the recap the row already computed; this is the
  // workspace's own total, and it goes through workspaceAgentsSummary
  // because a sum over ws.pages cannot see the workspace's MAIN agent
  // session -- that one lives outside every page tree (D12), so a Home-tab
  // agent with a question on screen earned no badge anywhere in the
  // sidebar, which is precisely the session a human has no other row to
  // notice.
  //
  // Through `attentionState` -- the layout with acknowledged waits shown
  // as idle -- like every other tally and dot in this sidebar. A wait the
  // human has marked as read is one they have already looked at, and this
  // badge exists to make them look.
  function workspaceWaitingCount(ws: Workspace): number {
    return workspaceAgentsSummary(ws, $attentionState).waiting;
  }

  // Whether this row's workspace is on screen in a different window. The
  // row stays in the list -- the sidebar is the whole fleet, not this
  // window's share of it -- but it is drawn as somewhere else, and every
  // way of clicking it raises that window instead of switching here
  // (layoutState's activation guard).
  function inAnotherWindow(ws: Workspace): boolean {
    return isInAnotherWindow($workspaceWindows, ws.id, currentWindowLabel());
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
    // Every workspace has its own attention map, not just the active
    // one: a rail that needs you in the workspace you are NOT looking at
    // is exactly the one you would otherwise miss.
    const orch = $orchestrations[ws.id];
    const marks = $stepAttentionsByWorkspace[ws.id];
    return railsSummary(orch, orch && marks ? railsWantingAttention(orch, marks) : new Set());
  }

  // A page's own half of the recap: what it holds, rather than what the
  // workspace adds up to. Same pure-tally shape as the three above.
  function tabsRecap(page: Page): PageAgentsSummary {
    return pageAgentsSummary(page, $attentionState);
  }

  // What a page expands into: one row per tab, in layout order. Same
  // projection the recap counts, so the rows revealed here always add up
  // to the numbers on the row above them.
  function tabRows(page: Page): PageTabRow[] {
    return pageTabRows(page, $attentionState);
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
  // uses: a board tab names its context, a file tab its filename, a card
  // tab its card and view, a terminal its custom name or cwd. The exact
  // ones share paths.ts helpers with Pane.svelte so one tab never goes by
  // two names.
  function tabRowLabel(row: PageTabRow): string {
    if (row.kind === "board") {
      const tab = $layoutState.boardTabsById[row.id];
      if (!tab) return row.id;
      const name = $gavinTrees[tab.workspaceId]?.contexts.find((c) => c.folderPath === tab.contextFolder)?.name;
      return boardTabLabel(name, tab.contextFolder);
    }
    if (row.kind === "file") return folderName($layoutState.fileTabsById[row.id]?.path ?? row.id);
    if (row.kind === "card") {
      const tab = $layoutState.cardTabsById[row.id];
      if (!tab) return row.id;
      // The queue tab is the one card tab with no card: its subject is a
      // session, so it is named after that terminal by the same helper
      // the terminal's own row uses.
      if (tab.view === "followups") {
        return followUpsTabLabel(
          sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, tab.sessionId ?? row.id)
        );
      }
      const title = linkForCardPath(
        $orchestrations[tab.workspaceId],
        $gavinTrees[tab.workspaceId],
        tab.path
      ).title;
      return cardTabLabel(title, tab.view);
    }
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, row.id);
  }

  // The row's own bubble opens with the very sentence its badge would
  // have shown, straight from the shared vocabulary -- so the row, the
  // badge on it and the terminal tab above cannot drift into three
  // different words for one daemon status. ("waiting_for_input" is the
  // data-model name and stays put; the human-facing phrasing lives in
  // ui/indicators.ts.)
  function statusWord(status: SessionStatus): string {
    return agentIndicator(status).tip;
  }

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
    const kindWord =
      row.kind === "file"
        ? "File"
        : row.kind === "card"
          ? // The one card row with no card: its subject is a session.
            $layoutState.cardTabsById[row.id]?.view === "followups"
            ? "Follow-ups"
            : "Card"
          : "Board";
    const lines = [row.status ? statusWord(row.status) : kindWord];
    const where =
      row.kind === "board"
        ? ($layoutState.boardTabsById[row.id]?.contextFolder ?? "")
        : row.kind === "file"
          ? ($layoutState.fileTabsById[row.id]?.path ?? "")
          : row.kind === "card"
            ? ($layoutState.cardTabsById[row.id]?.path ?? "")
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
    if (tabs.failed > 0) buckets.push(`${tabs.failed} stopped because something broke`);
    if (tabs.idle > 0) buckets.push(`${tabs.idle} idle`);
    const agents = tabs.agents === 0 ? "no agents" : `${plural(tabs.agents, "agent", "agents")}: ${buckets.join(", ")}`;
    const others = tabs.tabs - tabs.agents;
    const rest = others > 0 ? `, ${plural(others, "file or board tab", "file or board tabs")}` : "";
    return `${plural(tabs.tabs, "tab", "tabs")} -- ${agents}${rest}`;
  }

  function railRecapTip(rails: RailsSummary): string {
    const parts: string[] = [];
    if (rails.running > 0) parts.push(`${rails.running} running`);
    if (rails.attention > 0) parts.push(`${rails.attention} needing you`);
    if (rails.done > 0) parts.push(`${rails.done} done`);
    if (rails.idle > 0) parts.push(`${rails.idle} idle`);
    return `${plural(rails.total, "rail", "rails")}: ${parts.join(", ")} -- open Orchestration`;
  }

  /// The workspace row's Hub button: switch to that workspace and land on
  /// the hub tab it was last showing -- never on a tab it no longer
  /// offers. Where the home row under the workspace name used to go.
  function openHub(ws: Workspace): void {
    switchWorkspace(ws.id);
    switchWorkspaceView(ws.id, resolveHubView(ws, currentHubTabPrefs(ws.id)));
  }

  /// A recap chip's click: straight to the tab that chip summarises,
  /// falling back to the workspace's usual hub landing when that tab is
  /// not on offer (both Git and Orchestration require a bound root).
  ///
  /// Against what the workspace OFFERS, not against what its strip draws:
  /// hiding a tab takes it out of the row, not out of the app, and a chip
  /// that summarises the board still has to be able to open it.
  function openHubView(ws: Workspace, view: string): void {
    switchWorkspace(ws.id);
    const offered = visibleHubViewIds(Boolean(ws.rootPath));
    switchWorkspaceView(ws.id, offered.includes(view) ? view : resolveHubView(ws, currentHubTabPrefs(ws.id)));
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
    return workspaceExpansion[workspaceId] === true;
  }

  /// The one write path, so an answer always reaches storage: an
  /// auto-expand is recorded exactly like a click, and from then on the
  /// workspace is answered and never auto-expands again.
  function setExpanded(workspaceId: string, open: boolean): void {
    workspaceExpansion = { ...workspaceExpansion, [workspaceId]: open };
    saveWorkspaceExpansion(workspaceExpansion, knownWorkspaceIds());
  }

  function toggleExpand(workspaceId: string): void {
    setExpanded(workspaceId, !isExpanded(workspaceId));
  }

  /// The app-wide settings panel. A modal, not a hub tab: every hub tab
  /// renders inside one workspace, which is the wrong shape for a
  /// preference that spans all of them.
  let showGlobalSettings = $state(false);

  // The pending "Close Idle Tabs" confirmation: the frozen id list and
  // the copy describing it, both built when the menu entry was picked.
  let closeIdle = $state<CloseIdleRequest | null>(null);

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
    // File, board and card tabs are never renameable -- their labels are
    // exact (the same rule the tab bar's own rename applies).
    if (
      $layoutState.fileTabsById[sessionId] ||
      $layoutState.boardTabsById[sessionId] ||
      $layoutState.cardTabsById[sessionId]
    )
      return;
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
    void showAlert({ title: "That didn't work", lines: [text] });
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
      confirmCloseIdle: (request) => (closeIdle = request),
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
    openContextMenuFromEvent(e, buildPageMenuEntries(ws, page, $layoutState.workspaces, $layoutState, menuHooks()));
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
    const card = $layoutState.cardTabsById[row.id];
    return {
      tabId: row.id,
      kind: row.kind === "session" ? "terminal" : row.kind,
      path: board
        ? board.contextFolder
        : (file?.path ?? card?.path ?? $layoutState.cwdBySessionId[row.id] ?? null),
      pinned: leaf.pinned.includes(row.id),
      tabs: leaf.tabs,
      pinnedTabs: leaf.pinned,
      // Unmasked, for the reason Pane.svelte's own context spells out:
      // the entry exists to hide this wait, so it has to be able to see
      // it. `row.status` is the masked view the dot beside it draws.
      status: $layoutState.sessionStatusById[row.id],
      read: $layoutState.readSessionIds?.has(row.id) === true,
    };
  }

  function openSessionRowMenu(e: MouseEvent, ws: Workspace, page: Page, row: PageTabRow): void {
    if (inTextInput(e)) return;
    openContextMenuFromEvent(e, buildSessionRowMenuEntries(ws, page, rowMenuContext(page, row), menuHooks()));
  }

  /// Whether this workspace's row can be dragged to a new position, or
  /// be a reorder target. The Scratchpad never could; a pinned row is
  /// the same case -- `pinnedFirst` decides where it goes, so a drop
  /// would land it in the stored array without moving it on screen.
  function isReorderable(workspaceId: string): boolean {
    if (workspaceId === UNFILED_WORKSPACE_ID) return false;
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return !!ws && !isPinned(ws);
  }

  function handleWorkspaceDragStart(event: DragEvent, workspaceId: string): void {
    setDragPayload(event, { kind: "workspace", workspaceId });
  }

  function handleWorkspaceDragOver(event: DragEvent, workspaceId: string): void {
    const kind = getDragKind(event);
    if (!kind) return;
    // A hub tab is being rearranged within its own strip and has nowhere
    // to land here -- refusing it in the dragover is what keeps the
    // sidebar from lighting up under a drag it cannot accept.
    if (kind === "hub-tab") return;
    // Neither the Scratchpad nor a pinned workspace is part of the
    // reorderable list: where they sit is decided for them (top, then
    // pin order), so a dragged workspace has nowhere meaningful to land
    // on either -- ignore. Only the REORDER drop is refused; a page or a
    // pane dropped onto a pinned row still lands in it.
    if (kind === "workspace" && !isReorderable(workspaceId)) return;
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
      if (!isReorderable(ws.id)) return;
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
    } else if (payload.kind === "pane" || payload.kind === "tab") {
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "workspace", workspaceId: ws.id }
      );
    }
  }

  function handlePageDragStart(event: DragEvent, workspaceId: string, pageId: string): void {
    setDragPayload(event, { kind: "page", workspaceId, pageId });
  }

  function handlePageDragOver(event: DragEvent, page: Page): void {
    const kind = getDragKind(event);
    if (!kind || kind === "workspace" || kind === "hub-tab") return;
    // A pinned page is placed by its pin, not by the list -- the same
    // refusal the workspace rows make one level up, and for the same
    // reason. Panes and tabs still drop into it.
    if (kind === "page" && isPinned(page)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "page") {
      hoverState = { targetId: page.id, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: page.id, kind: "zone", zone: computeDropZone(rect, event.clientX, event.clientY) };
    }
  }

  async function handlePageDrop(event: DragEvent, ws: Workspace, page: Page): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload || payload.kind === "workspace" || payload.kind === "hub-tab") return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (payload.kind === "page") {
      if (isPinned(page)) return;
      // Looked up in the AUTHORITATIVE array rather than taken as the
      // loop index, because the two stopped agreeing the moment pinned
      // pages started rendering out of stored order -- and movePage
      // indexes the stored array. The same lookup the workspace drop
      // above has always done.
      const index = ws.pages.findIndex((p) => p.id === page.id);
      if (index === -1) return;
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
  // means `workspaceExpansion` is only read when activeId itself just
  // changed, not on every run this effect happens to see -- reading it
  // inside an effect that also writes it otherwise re-triggers itself and
  // silently reverts the very collapse it just observed.
  //
  // "First time" now means the first time EVER, not the first time this
  // mount: the test is an absent answer rather than a closed row, so a
  // workspace the human collapsed comes back collapsed after a reload
  // instead of being helpfully re-opened every single time.
  let lastSyncedActiveId: string | null = null;
  $effect(() => {
    const activeId = $layoutState.activeWorkspaceId;
    if (activeId && activeId !== lastSyncedActiveId) {
      lastSyncedActiveId = activeId;
      if (workspaceExpansion[activeId] === undefined) {
        setExpanded(activeId, true);
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
            class="recap-group git"
            aria-label={gitRecapTip(git)}
            use:tooltip={gitRecapTip(git)}
            onclick={() => openHubView(ws, "git")}
          >
            <span class="recap-body">
              {#if git.committing}
                <span class="commit-spinner" aria-hidden="true"></span>
              {:else}
                <GitBranch size={11} />
              {/if}
              {#if git.repoCount > 0}<span class="recap-count">{git.repoCount}</span>{/if}
              <!-- No marker of its own: the group already opened with a
                   branch glyph, and a second one here would be the axis
                   restated. What the number needed was the warning tone
                   -- it used to be an amber DOT beside a plain count,
                   the same dot the board drew for priority and the tab
                   bar for unsaved edits. The tooltip spells it out. -->
              {#if git.dirtyCount > 0}
                <span class="recap-count dirty-count">{git.dirtyCount}</span>
              {/if}
              {#if git.ahead > 0}<span class="recap-delta">&uarr;{git.ahead}</span>{/if}
              {#if git.behind > 0}<span class="recap-delta">&darr;{git.behind}</span>{/if}
            </span>
          </button>
        {/if}
        <!-- One number: how many cards the board holds, with the
             column-by-column breakdown in the tooltip. It used to take
             over the whole strip on hover -- git and rails standing down
             so it could spell the columns out inline -- and pointing at
             it is something you do on the way to somewhere else far more
             often than because you wanted the detail, so the strip kept
             rearranging itself under the pointer for no reason. The two
             badges either side of it have always answered with a
             tooltip; this one does now too. -->
        {#if cards.total > 0}
          <button
            class="recap-group cards"
            aria-label={cardRecapTip(cards)}
            use:tooltip={cardRecapTip(cards)}
            onclick={() => openHubView(ws, "kanban")}
          >
            <span class="recap-body">
              <Kanban size={11} />
              <span class="card-total recap-count">{cards.total}</span>
            </span>
          </button>
        {/if}
        <!-- At most two stats, chosen by railStripStats: what is active
             (running, then attention -- the count running was taken out
             of, since a rail needing a human is still going, it just is
             not going to get anywhere on its own), or, when nothing is,
             what is there. All four buckets stay in the tooltip. -->
        {#if rails.total > 0}
          <button
            class="recap-group rails"
            aria-label={railRecapTip(rails)}
            use:tooltip={railRecapTip(rails)}
            onclick={() => openHubView(ws, "orchestration")}
          >
            <span class="recap-body">
              <!-- A rail stage is an agent doing something, so running /
                   needing-you / idle borrow the agent badge rather than
                   drawing a third vocabulary for the same three facts.
                   Only `done` is the rail's own word -- an agent has no
                   such state.

                   11px, the size the branch and board glyphs beside them
                   are drawn at, because in THIS group the badge is the
                   whole content: git and cards each open with a category
                   glyph and put their tally after it, and the rails
                   group has no such glyph to open with. 10px is the size
                   a badge takes where it is a breakdown hanging off a
                   leading stat -- the page row below, the app hub's
                   strip -- and borrowing that size here made the one
                   group whose badge carries the axis the smallest thing
                   in the row. -->
              {#each railStripStats(rails) as key (key)}
                {#if key === "done"}
                  <span class="rail-stat done">
                    <Check size={11} />
                    <span class="recap-count">{rails[key]}</span>
                  </span>
                {:else}
                  <StatusBadge
                    indicator={agentIndicatorByState(key === "running" ? "working" : key === "attention" ? "waiting_for_input" : "idle")}
                    size={11}
                    tip={null}
                    text={rails[key]}
                  />
                {/if}
              {/each}
            </span>
          </button>
        {/if}
      </div>
    {/if}
    {#each orderedPages(ws) as page, pageIndex (page.id)}
      {@const tabs = tabsRecap(page)}
      {@const pagePinned = isPinned(page)}
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
          draggable={editingPageId !== page.id && !pagePinned}
          ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
          ondragover={(e) => handlePageDragOver(e, page)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handlePageDrop(e, ws, page)}
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
              <!-- The agent tallies wear the agent badge (ui/indicators.ts),
                   not a local Play/ring pair: these count the very
                   sessions whose rows are one level down, and the two
                   used to disagree about what "running" looks like. The
                   strip has one bubble of its own, so the badges take
                   none. -->
              {#if tabs.running > 0}
                <StatusBadge indicator={agentIndicatorByState("working")} size={9} tip={null} text={tabs.running} />
              {/if}
              <!-- Its own tally, not folded into idle. Before v21 a broken
                   agent WAS idle here, so this strip told the human a page
                   was quietly finished when what it actually was, was
                   broken. Leaving it out of both buckets instead would be
                   worse still: the agent would vanish from the row. -->
              {#if tabs.failed > 0}
                <StatusBadge indicator={agentIndicatorByState("failed")} size={9} tip={null} text={tabs.failed} />
              {/if}
              {#if tabs.idle > 0}
                <StatusBadge indicator={agentIndicatorByState("idle")} size={9} tip={null} text={tabs.idle} />
              {/if}
            </span>
          {/if}
          {#if tabs.waiting > 0}
            {@const waiting = tabs.waiting}
            <StatusBadge
              indicator={agentIndicatorByState("waiting_for_input")}
              size={10}
              text={waiting}
              tip={`${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting for you on this page`}
              class="waiting-badge"
            />
          {/if}
          <!-- A pinned row keeps the slot but not the action: the close
               is the very thing a pin takes away, and leaving an X there
               (disabled or otherwise) would offer it anyway. Unpin is
               what belongs in its place -- it is the only way back to a
               closable row, it says why the X is gone, and a click aimed
               at the old X does something harmless and reversible
               instead of destroying a page. -->
          {#if pagePinned}
            <IconButton
              icon={Pin}
              label="Unpin"
              size={10}
              class="pin-mark"
              onclick={() => void setPagePinned(ws.id, page.id, false)}
            />
          {:else}
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
          {/if}
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
                <!-- A terminal row leads with the shared agent badge, so
                     the sidebar, the tab bar above it and the board card
                     bound to the same session say the same thing. File
                     and board rows have no agent behind them and get a
                     plain kind glyph instead. The row already carries its
                     own bubble (tabRowTip), so the badge does not add a
                     second one. -->
                {#if row.kind !== "session"}
                  <span class="tab-kind">
                    {#if row.kind === "board"}<Kanban size={10} />{:else if row.kind === "card"}<ListChecks
                        size={10}
                      />{:else}<FileText size={10} />{/if}
                  </span>
                {:else}
                  <StatusBadge indicator={agentIndicator(row.status)} size={10} tip={null} class="tab-kind" />
                {/if}
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
                      <!-- ONE branch glyph, toned by the checkout's state,
                           with the branch name taking the tone from it.
                           There used to be a plain glyph here AND a
                           coloured dot two elements along -- the axis
                           stated twice, the state carried only by the
                           second. The name keeps its own element so it
                           can still truncate. -->
                      <StatusBadge indicator={gitIndicator(gitStatus.dirty)} size={9} tip={null} />
                      <span class="git-branch" class:dirty={gitStatus.dirty}>{gitStatus.branch}</span>
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

<!-- The collapsed column: one row per workspace, and nothing else. An
     initial rather than the same glyph repeated down the rail, because
     the only question this list has to answer while narrow is WHICH
     workspace a row is -- a column of identical house icons answers it
     for none of them. The accent stripe and the active fill are the
     expanded row's own, so a collapsed rail is the same list wearing
     less, not a second design.

     The waiting badge survives the collapse. It is the one fact on a
     workspace row that is about to cost the human time, and a rail that
     dropped it would make collapsing the sidebar a way to stop being
     told. -->
{#snippet collapsedList()}
  <div class="workspace-list collapsed-list">
    {#each visibleWorkspaces as ws (ws.id)}
      {@const waiting = workspaceWaitingCount(ws)}
      <button
        type="button"
        class="collapsed-row"
        class:active={ws.id === $layoutState.activeWorkspaceId}
        style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
        use:tooltip={waiting > 0
          ? `${ws.name} — ${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting for you`
          : ws.name}
        aria-label={ws.name}
        onclick={() => {
          void switchWorkspace(ws.id);
          pressedRail();
        }}
        oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
      >
        <span class="collapsed-initial">{workspaceInitial(ws)}</span>
        {#if waiting > 0}
          <StatusBadge
            indicator={agentIndicatorByState("waiting_for_input")}
            size={9}
            text={waiting}
            tip={null}
            class="waiting-badge"
          />
        {/if}
      </button>
    {/each}
    <!-- Below the last icon is empty rail, not dead space: the same
         window-drag surface the expanded list's spacer offers, so
         collapsing the sidebar never trades away a grab handle. -->
    <div class="list-drag-spacer" use:windowDrag></div>
  </div>
{/snippet}

<!-- What the search row found, in place of the workspace list. Ranked by
     kind first (sidebarSearch.ts): the workspaces, then the pages, then
     the sessions. Each row says what it is with the glyph the sidebar
     already uses for that thing, and names its parent after the label so
     two pages called "main" are told apart by the workspace they sit in
     rather than by which one the human clicks first. -->
{#snippet searchResults(found: SidebarSearchResult)}
  <div class="workspace-list search-results">
    {#if found.hits.length === 0}
      <p class="search-empty">No workspace, page or session matches.</p>
    {:else}
      {#each found.hits as hit (hit.key)}
        <button type="button" class="search-hit" onclick={() => void openHit(hit)}>
          <span class="hit-kind">
            {#if hit.kind === "workspace"}
              <Boxes size={11} />
            {:else if hit.kind === "page"}
              <PanelsTopLeft size={11} />
            {:else}
              <StatusBadge indicator={agentIndicator(hit.status)} size={10} tip={null} />
            {/if}
          </span>
          <span class="hit-label">{hit.label}</span>
          {#if hit.where}<span class="hit-where">{hit.where}</span>{/if}
        </button>
      {/each}
      {#if found.total > found.hits.length}
        <p class="search-empty">{found.total - found.hits.length} more — narrow the search.</p>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="sidebar" class:collapsed={showsRail} class:peeking bind:this={sidebarEl}>
  <!-- No "Workspaces" heading above the list. It named the one thing on
       screen that could not be anything else -- every row under it is a
       workspace -- and it was carrying the + only because it was there.
       That action is "Open workspace…" now and lives in the strip above,
       with the rest of the sidebar's own chrome. -->
  {#if searchOpen}
    <!-- The second row, opened by the strip's magnifier and closed by it,
         by Escape, or by picking a hit. It replaces the workspace list
         rather than filtering it in place: a hit can be a page or a
         session, and neither has a row in that list until its workspace
         is expanded. -->
    <div class="sidebar-search">
      <Search size={12} />
      <input
        bind:this={searchInput}
        class="search-input"
        placeholder="Workspaces, pages, sessions"
        spellcheck="false"
        value={$sidebarSearchQuery}
        oninput={(e) => sidebarSearchQuery.set(e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeSidebarSearch();
          }
        }}
      />
      <IconButton icon={X} label="Close search" size={12} onclick={closeSidebarSearch} />
    </div>
  {/if}
  {#if showsRail}
    <!-- The way back out of the rail, and the first row of it. The
         header row beside this column carries that toggle while the
         sidebar is open; collapsed, there is no room for a row of chrome
         over a 36px column and none is spent -- the toggle costs exactly
         what a workspace row costs, in the column it acts on, and the
         other two chrome buttons stand down until the column is open
         again. -->
    <div class="rail-chrome">
      <button
        type="button"
        class="collapsed-row"
        use:tooltip={"Expand sidebar"}
        aria-label="Expand sidebar"
        onclick={toggleSidebarCollapsed}
      >
        <span class="collapsed-initial"><PanelLeftOpen size={13} /></span>
      </button>
      <div class="footer-divider"></div>
    </div>
    {@render collapsedList()}
  {:else if searchHits}
    {@render searchResults(searchHits)}
  {:else}
    <div class="workspace-list">
      {#if unfiledWorkspace}
        {@const ws = unfiledWorkspace}
        <div
          class="workspace-row-group"
          style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
        >
          <div
            class="workspace-row scratchpad"
            class:active={ws.id === $layoutState.activeWorkspaceId}
            class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
            ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
            ondragleave={clearHover}
            ondragend={clearHover}
            ondrop={(e) => handleWorkspaceDrop(e, ws)}
            oncontextmenu={(e) => openWorkspaceMenu(e, ws)}
          >
            <!-- The Scratchpad is a drawer for loose pages, not a
                 project: it has no hub worth landing on, and nothing
                 standing in for one either. Reserving the column read as a
                 Hub button that had failed to draw, so the row starts at
                 its chevron and is simply narrower than the rest. -->
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
            {#if workspaceWaitingCount(ws) > 0}
              {@const waiting = workspaceWaitingCount(ws)}
              <StatusBadge
                indicator={agentIndicatorByState("waiting_for_input")}
                size={10}
                text={waiting}
                tip={`${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting for you in this workspace`}
                class="waiting-badge"
              />
            {/if}
            <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
          </div>
          {#if isExpanded(ws.id)}
            {@render pageList(ws)}
          {/if}
        </div>
      {/if}
      {#each regularWorkspaces as ws (ws.id)}
        {@const wsPinned = isPinned(ws)}
        <div
          class="workspace-row-group"
          style:--row-accent={accentVar(ws.color, themeState.effective) ?? "transparent"}
        >
          <div
            class="workspace-row"
            class:active={ws.id === $layoutState.activeWorkspaceId}
            class:elsewhere={inAnotherWindow(ws)}
            class:drop-before={hoverState?.targetId === ws.id &&
              hoverState.kind === "reorder" &&
              hoverState.position === "before"}
            class:drop-after={hoverState?.targetId === ws.id &&
              hoverState.kind === "reorder" &&
              hoverState.position === "after"}
            class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
            draggable={editingWorkspaceId !== ws.id && !wsPinned}
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
            {#if inAnotherWindow(ws)}
              <!-- A mark, not a badge: this answers "where is it", which is
                   not one of the axes ui/indicators.ts speaks for. The
                   tooltip names the axis, since a glyph alone cannot. -->
              <span
                class="in-window"
                use:tooltip={"In another window — click to bring it to the front"}
                aria-label="In another window"
              >
                <AppWindow size={11} />
              </span>
            {/if}
            {#if workspaceWaitingCount(ws) > 0}
              {@const waiting = workspaceWaitingCount(ws)}
              <StatusBadge
                indicator={agentIndicatorByState("waiting_for_input")}
                size={10}
                text={waiting}
                tip={`${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting for you in this workspace`}
                class="waiting-badge"
              />
            {/if}
            <IconButton icon={Plus} label="New Page" size={12} onclick={() => quickAddPage(ws.id)} />
            <!-- Unpin stands where the X does on an unpinned row, for the
                 reason the page rows spell out: a pin is what removed
                 the close, so the way back is what belongs in its
                 place. -->
            {#if wsPinned}
              <IconButton
                icon={Pin}
                label="Unpin"
                size={12}
                class="pin-mark"
                onclick={() => void setWorkspacePinned(ws.id, false)}
              />
            {:else}
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
            {/if}
          </div>
          {#if isExpanded(ws.id)}
            {@render pageList(ws)}
          {/if}
        </div>
      {/each}
      <!-- Whatever the list doesn't fill moves the window: a workspace
           list this short still leaves the rest of the column reachable
           as a grab handle, the same way the corner strip's own spacer
           (windowDrag.ts) does across the header row. -->
      <div class="list-drag-spacer" use:windowDrag></div>
    </div>
  {/if}
  <div class="sidebar-footer">
    <!-- First in the footer, not first in the sidebar: the hub is the app
         itself, one level up from any workspace, and the footer is where
         the app's own rows live (the task manager, usage, settings). It
         stays reachable with a workspace open -- gavin has one window and
         the pinned workspace always exists, so there is no "nothing open"
         moment to hang a welcome screen on.

         The rule under it is INSET rather than full width: a full-width
         rule reads as the footer's own top edge (which .sidebar-footer
         already draws), so a second one would say the app row is a
         section of its own rather than the first of four rows. -->
    <button
      type="button"
      class="footer-row app-row"
      class:active={$appHubOpen}
      aria-current={$appHubOpen ? "page" : undefined}
      onclick={() => {
        openAppHub();
        pressedRail();
      }}
    >
      <Boxes size={12} />
      <span>Gavin</span>
    </button>
    <div class="footer-divider"></div>
    <button class="footer-row" onclick={() => showAppPanel("sessions")}>
      <Activity size={12} />
      <span>Task manager</span>
      <!-- The fleet strip. On the Task manager row because that is where
           the answer to it is: the panel behind this row is the one that
           can say WHICH agent is holding the memory. Drawn only when
           there is something to say (launchQueue.fleetStripLine), so a
           quiet machine keeps a plain row rather than a permanent
           "Agents 0/4" the eye learns to skip. -->
      {#if $fleetStripLine}
        <span
          class="footer-badge fleet-strip tone-{$fleetStripLine.tone}"
          use:tooltip={$launchGateVerdict.why ??
            "Agents running now, against the ceiling — and how full the machine is"}
          >{$fleetStripLine.text}</span
        >
      {/if}
    </button>
    <button class="footer-row" onclick={() => showAppPanel("usage")}>
      <Gauge size={12} />
      <span>Usage</span>
      <!-- The semaphore, and the one thing on this row that is about the
           FUTURE: whether the limits gavin can see will survive to their
           own reset at the burn it has measured (usageProjection.ts).
           Nothing is drawn until there is a rate, so an ordinary start-up
           shows an unadorned row rather than a mark meaning "wait".

           It sits before the pause badge because it is the earlier
           warning of the two: amber here is the moment to throttle, and
           "At limit" is what happens to somebody who did not. -->
      {#if usageSemaphore}
        <StatusBadge indicator={usageSemaphore} size={11} class="footer-semaphore" />
      {/if}
      <!-- The pause state lives on the row that explains it. A workspace
           holding for a limit or a scheduled window is the one thing here
           worth seeing without opening anything. -->
      {#if pauseLabel($activePause)}
        <span
          class="footer-badge"
          class:after-semaphore={usageSemaphore !== null}
          use:tooltip={$activePause.why ?? ""}>{pauseLabel($activePause)}</span
        >
      {/if}
    </button>
    <button class="footer-row" onclick={() => (showGlobalSettings = true)}>
      <Settings size={12} />
      <span>Settings</span>
      <!-- The whole of the "quiet check" the update channel makes: one
           check at startup, and if it found something, this. It is a
           label rather than a call to action because nothing here
           installs -- the Updates section of a workspace's Settings tab
           is where the version, the endpoint and the install live, and
           this row is the only thing that says to go and look. -->
      {#if $availableUpdate}
        <span
          class="footer-badge"
          use:tooltip={`gavin ${$availableUpdate.version} is available — Settings › Updates`}
          >{$availableUpdate.version}</span
        >
      {/if}
    </button>
  </div>
</div>

<!-- The one question "Open workspace…" can ask: the folder holds no
     .gavin* yet. Three answers, so it is a ConfirmPrompt rather than an
     askConfirm -- "bind without initializing" is a real answer and not a
     softer version of either of the other two, and the flow has created
     nothing yet, so Cancel genuinely leaves no trace. -->
{#if $pendingOpen}
  {@const pending = $pendingOpen}
  <ConfirmPrompt
    title={`Initialize gavin in “${pending.name}”?`}
    lines={[
      pending.rootPath,
      "Creates .gavin-root/ with a PRD template, config, and plans/docs/specs folders. Nothing existing is overwritten.",
      "Opening without it still gives the folder its terminals, its git tab and its pages — just no board.",
    ]}
    check={{ label: INIT_TRACKING_LABEL, default: resolveGitTracking($gitTrackingDefault) }}
    choices={[
      { label: "Initialize", onPick: (_, tracked) => void initAndOpen(pending, tracked) },
      { label: "Open without initializing", onPick: () => void bindWithoutInit(pending) },
    ]}
    onCancel={cancelOpen}
  />
{/if}

{#if closeIdle}
  {@const pending = closeIdle}
  <ConfirmPrompt
    title={pending.prompt.title}
    lines={pending.prompt.lines}
    choices={[
      {
        label: pending.prompt.confirmLabel,
        danger: true,
        onPick: () => {
          closeIdle = null;
          void closeTabsNow(pending.ids);
        },
      },
    ]}
    onCancel={() => (closeIdle = null)}
  />
{/if}

<!-- Created on demand, never kept hidden: the task manager polls while
     it is mounted, and an always-mounted panel would have the daemon
     walking the process table for the life of the app. -->
{#if $openAppPanel === "sessions"}
  <SessionsManagerModal onClose={closeAppPanel} />
{/if}

{#if $openAppPanel === "usage"}
  <AgentUsageModal onClose={closeAppPanel} />
{/if}

{#if showGlobalSettings}
  <GlobalSettingsModal onClose={() => (showGlobalSettings = false)} />
{/if}

<style>
  .sidebar {
    /* Fills the window's own column under the title strip: the width and
       the divider between the columns belong to that column now (.rail
       in +page.svelte), so the strip carrying the traffic lights is the
       same width as the sidebar and the rule runs the full height. */
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
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
  }
  /* A press on the icon rail floats the whole column over the view for
     as long as the pointer stays in it. It OVERLAYS rather than widening
     the column, and that is the point: the rail is collapsed so the view
     beside it can have the width, and a peek that pushed the content
     across would refit every terminal in the window twice for one
     glance. Anchored to .rail (+page.svelte), which owns the top strip
     this starts below.

     Under the app's modal layers (1000 and up) and over everything in
     the view: it is chrome floated over content, not a dialog. */
  .sidebar.peeking {
    position: absolute;
    top: var(--header-height);
    left: 0;
    bottom: 0;
    width: var(--sidebar-width);
    z-index: 50;
    border-right: 1px solid var(--border);
    box-shadow: 4px 0 14px rgba(0, 0, 0, 0.35);
  }
  .workspace-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* A column, not the plain block stack it used to be: the trailing
       .list-drag-spacer only claims leftover height (flex-grow) if its
       siblings are flex items too, and every row here already renders
       full-width and block-like under align-items' stretch default, so
       nothing about their layout changes. */
    display: flex;
    flex-direction: column;
  }
  /* The rest of the column, once every row and recap has taken its own
     height -- present even when the list is too long to leave any (it
     just settles at zero, same as the corner strip's horizontal
     .drag-spacer does when its row is full). Grabbing it moves the
     window via the same native startDragging() the corner strip and
     the tab rows use, so a snap-assist tool watching for a real window
     drag (Magnet and macOS's own edge tiling included) sees this as
     no different from dragging a native title bar. */
  .list-drag-spacer {
    flex: 1 1 auto;
    min-height: 0;
  }
  /* Everything about the row's box is .footer-row's now; what stays here
     is the one thing the other footer rows have no use for -- the
     selected state, because this row is the only one of the four that
     names a destination rather than opening a modal. */
  .app-row.active {
    background: var(--surface-selected);
    color: var(--text);
  }
  /* Inset on purpose (see the markup): the footer's top border is the
     full-width rule, and a second one would read as a section edge. */
  .footer-divider {
    height: 1px;
    margin: 4px 10px;
    background: var(--border);
  }
  /* Pinned for the reason the "Workspaces" header it replaced was --
     .sidebar does not scroll, so a row that can shrink will, the moment
     the workspace list is long. */
  .sidebar-search {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }
  .search-input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--surface-sunken);
    color: var(--text);
    border: 1px solid var(--border-focus);
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 2px 4px;
  }
  .search-hit {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }
  .search-hit:hover {
    background: var(--surface-hover);
  }
  .hit-kind {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }
  .hit-label {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The parent's name, not a second title: it is here to tell two
     identically named pages apart, so it sits back and takes whatever
     width the name it qualifies has left. */
  .hit-where {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .search-empty {
    margin: 0;
    padding: 8px;
    color: var(--text-muted);
  }
  /* The rail's own first row, above the list rather than in it: the
     workspaces scroll and this must not scroll away with them -- it is
     the only way back to the open column. */
  .rail-chrome {
    flex: 0 0 auto;
  }
  /* Tighter than the footer's rule, which is inset for a 200px column:
     the same 10px each side of a 36px one leaves a stub. */
  .rail-chrome .footer-divider {
    margin: 4px 6px;
  }
  /* The collapsed rail's rows. Centred rather than left-aligned: with no
     names to line up, a left edge would only make the initials look
     dropped. The stripe stays on the group's left, where it is in the
     expanded list. */
  .collapsed-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 4px;
    background: transparent;
    border: none;
    border-left: 3px solid var(--row-accent, transparent);
    color: var(--text-muted);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .collapsed-row:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .collapsed-row.active {
    background: var(--surface-raised);
    color: var(--text);
  }
  /* A chip rather than a bare letter: on a column this narrow the row IS
     an icon, and a letter with nothing around it reads as text that lost
     its line. Sized to the footer rows under it, so the rail is one
     column of marks rather than letters above pictures. */
  .collapsed-initial {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: var(--surface-sunken);
    font-weight: bold;
    letter-spacing: 0;
  }
  .collapsed-row:hover .collapsed-initial,
  .collapsed-row.active .collapsed-initial {
    background: var(--surface-selected);
  }
  /* Collapsed, every footer row is its glyph alone. The words are the
     tooltip's job at this width, and a row that kept them would be the
     one thing forcing the column wider than the window controls need. */
  .sidebar.collapsed .footer-row {
    justify-content: center;
    padding: 6px 4px;
  }
  .sidebar.collapsed .footer-row span {
    display: none;
  }
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
  .workspace-row.active {
    background: var(--surface-raised);
  }
  /* Quieter, not disabled: the row still works -- clicking it raises the
     window the workspace is in. It just is not what this window is
     showing, and must not read as if it could be. */
  .workspace-row.elsewhere .workspace-name {
    opacity: 0.55;
  }
  .in-window {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--text-dim);
  }
  /* The Scratchpad's own row. Named for what it is rather than for
     being first: a workspace the human PINNED is first too now, and one
     class covering both would have styled every pinned row italic and
     muted -- which is the Scratchpad saying "this is the drawer, not a
     project", not something a pin means. */
  .workspace-row.scratchpad {
    font-style: italic;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }
  .workspace-row.scratchpad.active {
    color: var(--text);
  }
  .workspace-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A ring around the agent badge, not a filled red pill. Red was the
     app's loudest colour spent on a fact that is neither broken nor
     urgent -- and the SAME fact rendered amber two rows below, on the
     session row this number counts. Amber now, everywhere, with the ring
     doing the work the fill used to: making a count read as a count. The
     glyph and the tone are the badge's; only the ring is ours. */
  .page-row :global(.waiting-badge),
  .collapsed-row :global(.waiting-badge),
  .workspace-row :global(.waiting-badge) {
    border: 1px solid var(--border-warning);
    border-radius: 8px;
    padding: 0 4px;
    line-height: 1.4;
  }
  .git-branch {
    flex: 0 1 auto;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .git-branch.dirty {
    color: var(--warning-text);
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
  /* Unpin sits in the close button's slot, so it wears the close
     button's metrics -- IconButton's own roomier padding there would
     make a row jump sideways the moment it was pinned. Scoped to the two
     rows rather than left bare: a leading :global(.pin-mark) would style
     every pin glyph in the app. */
  .workspace-row :global(.pin-mark),
  .page-row :global(.pin-mark) {
    padding: 2px;
    flex: 0 0 auto;
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
  /* Three quiet groups of icons and numbers, in exactly the borderless
     readout style the page rows below already use for their own tallies
     (.page-recap) -- so the workspace strip and the page rows read as
     one system rather than two.

     They used to be bordered pills, each ringed in its own categorical
     hue. That made the one row in the sidebar which is purely
     informational also the loudest thing on it, and three rings plus
     their padding do not fit 200px, so the strip wrapped as a matter of
     course. What separates the groups now is space and their leading
     glyph; what colour survives is semantic only. */
  .recap-row {
    display: flex;
    align-items: center;
    gap: 2px 6px;
    /* Kept as a safety net for an unusually wide tally, not as the
       normal case -- without the categorical rings and the card split,
       the strip is a good 50px narrower than it was. */
    flex-wrap: wrap;
    /* 21px + the group's own 1px hairline + 3px padding = the 25px the
       page rows below indent by, so the icons land on exactly the column
       the page names start at. */
    padding: 2px 8px 2px 21px;
    color: var(--text-muted);
  }
  /* The button is a bare hit area and draws nothing. Everything visible
     -- the hairline, the padding, the fill -- belongs to .recap-body
     inside it, which always hugs its own content.

     The split exists for the board group's expansion below, and it is
     what lets the pill stay content-width there without flickering. */
  .recap-group {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: transparent;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  /* A NEUTRAL hairline -- var(--border), the same one every other
     divider in the sidebar uses -- not the three categorical hues these
     carried before. The ring is back to give each group an edge, which
     is what a run of digits needs to read as three separate things; what
     is not back is the ring saying something about the group it wraps. */
  .recap-body {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 3px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .recap-group:hover {
    color: var(--text);
  }
  .recap-group:hover .recap-body {
    background: var(--surface-hover);
    border-color: var(--border-strong);
  }
  /* On the pill, not the hit area, which is a bare box that draws
     nothing -- a ring around it would sit away from the thing it is
     naming. */
  .recap-group:focus-visible {
    outline: none;
  }
  .recap-group:focus-visible .recap-body {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
  /* Takes the branch glyph's place rather than sitting beside it, so the
     group keeps its width while a run is in flight -- the sidebar is
     narrow, and a strip that reflows on its own is worse than one that
     stays put. */
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
  .recap-count {
    font-variant-numeric: tabular-nums;
  }
  /* The counts in this strip are one row of numbers and have to be one
     size. StatusBadge draws its own text at 0.85em, which is right where
     the badge trails a bigger stat, and wrong here: the rails group's
     tally sat beside the git and card tallies a whole step smaller than
     them, which is what reading it as "the rail badge is smaller" was.
     Descendant :global(), never a leading one -- a bare `:global(.badge-text)`
     would resize every badge in the app. */
  .recap-body :global(.badge-text) {
    font-size: inherit;
  }
  /* "of those repos, this many have uncommitted changes" -- the app's
     one meaning for amber (ui/indicators.ts): this wants a human. */
  .dirty-count {
    color: var(--warning-text);
  }
  .recap-delta {
    font-size: 0.9em;
    white-space: nowrap;
  }
  /* Only `done` is drawn here now: running, needing-you and idle are
     the shared agent badge, which brings its own tone with it. */
  .rail-stat {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .rail-stat.done {
    color: var(--success-text);
  }
  /* The page row's own recap: how many tabs the page holds, and how many
     agents are running / idle behind them. The agent counts wear the
     shared agent badge (ui/indicators.ts), the same one the rails chip
     above and the session rows below use, so all three read as one
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
  /* A terminal row's glyph is the shared agent badge, which brings its
     own tone; a file or board row is a plain muted glyph, because
     nothing is running behind it to have a state. The descendant
     :global() reaches into the badge component -- a LEADING one would be
     app-wide, which is how PlanTree's .split once dimmed LayoutTree. */
  .tab-row :global(.tab-kind) {
    display: inline-flex;
    /* Aligns the icon to the label's cap height rather than the row's
       top edge, at this row's own (0.9em) size. */
    padding-top: 2px;
    flex: 0 0 auto;
  }
  .tab-row span.tab-kind {
    color: var(--text-muted);
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
  /* Pushed to the end of the row. Anchored to .footer-row rather than
     left as a bare :global: the class rides on StatusBadge's own element,
     so only :global can reach it, and only the anchor keeps the reach
     inside this component. */
  .footer-row :global(.footer-semaphore) {
    margin-left: auto;
  }
  .footer-badge {
    margin-left: auto;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--surface-sunken);
    color: var(--warning-text);
    font-size: 0.85em;
  }
  /* Two `margin-left: auto` in one flex row split the slack between them,
     which would strand the semaphore in the middle of the row. With both
     drawn it is the semaphore that owns the push and the badge follows
     it -- said with a class rather than a sibling selector, because the
     semaphore's class rides on StatusBadge's element and :global() may
     not sit in the middle of a selector. */
  .footer-badge.after-semaphore {
    margin-left: 4px;
  }
  /* The fleet strip carries its own tone: quiet by default, and only
     coloured when the machine is actually saying something. Same three
     tokens IndicatorTone maps to, so the strip and a badge beside it are
     the same amber. */
  .fleet-strip.tone-neutral {
    color: var(--text-muted);
  }
  .fleet-strip.tone-warning {
    color: var(--warning-text);
  }
  .fleet-strip.tone-danger {
    color: var(--danger-text);
  }
</style>
