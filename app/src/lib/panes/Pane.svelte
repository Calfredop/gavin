<script lang="ts">
  import { onMount } from "svelte";
  import { paneLeadsWindow, paneOwnsActions, type LayoutNode } from "$lib/panes/layout";
  import type { CardTab } from "$lib/core/gavin";
  import TerminalPane from "$lib/terminal/TerminalPane.svelte";
  import FileViewerPane from "$lib/files/FileViewerPane.svelte";
  import BoardPane from "$lib/board/BoardPane.svelte";
  import CardTabPane from "$lib/cards/CardTabPane.svelte";
  import FollowUpQueuePane from "$lib/agents/FollowUpQueuePane.svelte";
  import {
    layoutState,
    daemonCompat,
    switchToTab,
    addTab,
    closeSession,
    splitPane,
    closePane,
    focusPane,
    setSessionName,
    openBoardInSplit,
    openCardInSplit,
    openFollowUpsInSplit,
    queuedInputsById,
    repairUnknownTabs,
    terminalFontSize,
    attentionStatusById,
  } from "$lib/core/layoutState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { kanbanState, cardSessionFor, fetchBoard } from "$lib/board/kanbanState";
  import { orchestrations, fetchOrchestration } from "$lib/orchestration/orchestrationState";
  import { linkedCardFor, type LinkedCard } from "$lib/cards/cardTabLink";
  import { chipTooltip, runBaseline } from "$lib/cards/runChanges";
  import { nearestContext } from "$lib/core/planBoard";
  import { confirmTabClose, confirmPaneClose } from "$lib/shell/confirmClose";
  import { restoredBadge, type RestoredBadge } from "$lib/sessions/orphan";
  import { endSessionOrphan } from "$lib/sessions/orphanActions";
  import { dirtyPaths } from "$lib/files/fileEditing";
  import { showAlert } from "$lib/core/dialog";
  import { openContextMenuFromEvent } from "$lib/core/contextMenu";
  import { buildTabMenuEntries } from "$lib/panes/tabMenu";
  import { windowDrag } from "$lib/shell/windowDrag";
  import {
    X,
    Plus,
    Kanban,
    Pin,
    ListChecks,
    FileDiff,
    MessageSquarePlus,
    Columns2,
    Rows2,
  } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import NewPageButton from "$lib/panes/NewPageButton.svelte";
  import CornerOverhang from "$lib/shell/CornerOverhang.svelte";
  import ShortcutHint from "$lib/ui/ShortcutHint.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import {
    gitIndicator,
    shellOrphanIndicator,
    shellRestartedIndicator,
    tabAgentIndicator,
    unsavedEditsIndicator,
    type Indicator,
  } from "$lib/ui/indicators";
  import { hintMode } from "$lib/core/shortcutHints";
  import { hintDigitFor } from "$lib/core/shortcuts";
  import { tooltip } from "$lib/core/tooltip";
  import { wheelScrollsSideways, scrollsIntoLead } from "$lib/terminal/wheelScroll";
  import {
    followUpsSessionFor,
    isViewTab as tabIsView,
    renameable,
    tabLabel as labelForTab,
    tabTooltip as tooltipForTab,
    type TabNaming,
  } from "$lib/panes/tabIdentity";
  import { queueBlockedReason, queueTip } from "$lib/agents/queuedInput";
  import { queueTargetFor } from "$lib/agents/queuedInputActions";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeTabInsertion,
    reorderIndexWithin,
    type DropZone,
    type ReorderPosition,
  } from "$lib/panes/dragDrop";
  import { movePaneOrTab, reorderTabWithinPane } from "$lib/core/layoutState";
  import { getActiveWorkspace, getActivePage, getActiveTree } from "$lib/core/workspace";

  let { leaf }: { leaf: Extract<LayoutNode, { type: "leaf" }> } = $props();

  let paneRefs: Record<string, { fit: () => void }> = {};
  let containerEl: HTMLDivElement;

  const isFocused = $derived(
    $layoutState.focusedSessionId !== null && leaf.tabs.includes($layoutState.focusedSessionId)
  );
  // One row of actions per page, on the pane the keyboard is already in
  // (layout.ts says which, and why). Only the ACTIVE page renders panes,
  // so its tree is the one to ask.
  const ownsActions = $derived(
    paneOwnsActions(getActiveTree($layoutState), leaf, $layoutState.focusedSessionId)
  );
  // The window's own chrome — the sidebar's collapse toggle and its two
  // list actions — belongs in the window's corner, so it goes on the
  // pane that LEADS the page rather than on the one the keyboard is in.
  // On a terminal page this row is the top edge of the window, and there
  // is nowhere else in it for those buttons to be.
  const leadsWindow = $derived(paneLeadsWindow(getActiveTree($layoutState), leaf));
  const active = $derived(leaf.tabs[leaf.activeTabIndex]);

  // $state, not plain `let` -- editInput is a bind:this target read inside
  // the $effect below, and only $state reads establish reactivity there
  // (see the tabLabel/onMount comment above for the same lesson applied to
  // containerEl, which deliberately does NOT need this because its consumer
  // is onMount, not an $effect).
  let editingSessionId: string | null = $state(null);
  let editValue = $state("");
  let editInput: HTMLInputElement | null = $state(null);

  // Hover feedback for the two different drop surfaces this pane offers:
  // contentDropZone for the 5-zone overlay on .content (grafting from
  // elsewhere, cross-page or same-page), tabReorderState for the
  // before/after insertion indicator when dragging a tab across this
  // pane's own tab-bar.
  let contentDropZone: DropZone | null = $state(null);
  let tabReorderState: { sessionId: string; position: "before" | "after" } | null = $state(null);

  export function fitAll(): void {
    for (const id of leaf.tabs) {
      paneRefs[id]?.fit();
    }
  }

  // Everything tabIdentity.ts needs to say what a tab is and what it is
  // called, gathered once per store change rather than per tab per call.
  const naming = $derived<TabNaming>({
    fileTabsById: $layoutState.fileTabsById,
    boardTabsById: $layoutState.boardTabsById,
    cardTabsById: $layoutState.cardTabsById,
    sessionNames: $layoutState.sessionNames,
    cwdBySessionId: $layoutState.cwdBySessionId,
    trees: $gavinTrees,
    orchestrations: $orchestrations,
  });

  function fileTabPath(tabId: string): string | null {
    return $layoutState.fileTabsById[tabId]?.path ?? null;
  }

  function boardTab(tabId: string): { workspaceId: string; contextFolder: string } | null {
    return $layoutState.boardTabsById[tabId] ?? null;
  }

  function cardTab(tabId: string): CardTab | null {
    return $layoutState.cardTabsById[tabId] ?? null;
  }

  function followUpsFor(tabId: string): string | null {
    return followUpsSessionFor(tabId, naming);
  }

  function isViewTab(tabId: string): boolean {
    return tabIsView(tabId, naming);
  }

  function tabLabel(sessionId: string): string {
    return labelForTab(sessionId, naming);
  }

  function tabTooltip(sessionId: string): string {
    return tooltipForTab(sessionId, naming);
  }

  // The active terminal tab's nearest gavin context, if any -- drives the
  // board icon at the end of the tab bar. Follows the LIVE cwd; the tab a
  // click opens is then pinned to the context captured at that moment.
  const activeBoardContext = $derived.by(() => {
    if (isViewTab(active)) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    const ctx = nearestContext($gavinTrees[ws.id], $layoutState.cwdBySessionId[active]);
    return ctx ? { workspaceId: ws.id, folderPath: ctx.folderPath, name: ctx.name } : null;
  });

  // The card this tab's agent is running, if any: the board's Run and an
  // orchestration launch both write a card_sessions binding, so one
  // reverse lookup covers both. Null for every ordinary terminal.
  function linkedCard(sessionId: string): LinkedCard | null {
    if (isViewTab(sessionId)) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    return linkedCardFor($kanbanState[ws.id], $orchestrations[ws.id], $gavinTrees[ws.id], sessionId);
  }

  // The same reverse lookup, one step further: whether this tab's run has
  // a baseline to diff against, and which commit that is. Null for a run
  // with no baseline -- an older daemon, a launch outside a repository --
  // because a chip is a glyph with no room to explain itself. The card
  // detail panel is where the reason is said; this only appears when
  // there is something to open.
  //
  // Only the sha, because the pane the chip opens re-derives the rest
  // from the binding for itself: copying cwd/live through here would pin
  // the pane to whatever the binding said at the moment of the click, and
  // a re-launch replaces it.
  //
  // Deliberately fetches NOTHING. A count on the chip would be a `git
  // diff` per tab per render, across every pane in the window.
  function runChangesFor(sessionId: string): { path: string; baseSha: string } | null {
    const link = linkedCard(sessionId);
    if (!link) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    const baseline = runBaseline(cardSessionFor($kanbanState[ws.id], link.path), $daemonCompat);
    return baseline.kind === "ready" ? { path: link.path, baseSha: baseline.baseSha } : null;
  }

  // The card link reads two things a terminal page never loads on its
  // own: the board (which holds the card bindings) and the orchestration
  // plan (which decides where the link goes). Without the first there is
  // no link at all until the human visits the Kanban tab; without the
  // second every railed card would be sent to the board instead of to
  // its rail. Both fetches no-op once loaded, so the repeat across panes
  // costs nothing after the first.
  $effect(() => {
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return;
    void fetchBoard(ws.id);
    // Orchestration is a rooted-workspace feature; an unrooted one has
    // no plan to fetch.
    if (ws.rootPath) void fetchOrchestration(ws.id);
  });

  // The tabs below that this pane is about to render as terminals, purely
  // because they are in neither map -- which is the only thing that makes
  // a tab id a session here, and is equally what a board or file tab
  // looks like if its entry is ever lost. repairUnknownTabs asks Rust's
  // copy of the classification, once per id per app run: a real terminal
  // is confirmed and never asked about again, a board or file tab is put
  // back in the map and the terminal built for it destroyed. Without it a
  // lost entry is permanent, and costs a `pty-output` listener plus a
  // resize the daemon refuses every time the pane is rebuilt.
  $effect(() => {
    const unknown = leaf.tabs.filter((id) => !isViewTab(id));
    if (unknown.length > 0) void repairUnknownTabs(unknown);
  });

  // idle intentionally returns null here -- no badge at all is the idle
  // indicator, not a neutral-toned one (see this plan's Global
  // Constraints). The two states that DO draw come from the app's shared
  // agent vocabulary (ui/indicators.ts), so a tab, the board card bound
  // to the same session and the sidebar row under it all say it with the
  // same glyph and the same tone.
  function tabStatusBadge(sessionId: string): Indicator | null {
    // The acknowledged view (layoutState's attentionStatusById): a wait
    // the human marked as read draws no badge, which is the whole point
    // of the mark. Everything else on this tab -- the follow-up queue's
    // gate below, most of all -- still reads the daemon's own status.
    return tabAgentIndicator($attentionStatusById[sessionId], $layoutState.failureReasonById[sessionId]);
  }

  // What the ↻/⚠ badge on this tab says, or null for no badge. All three
  // wordings live in orphan.ts, which is also what SessionDetail and any
  // later session manager read -- one surface describing a surviving
  // agent more softly than another is how a human decides the warning is
  // decorative.
  function tabBadge(sessionId: string): RestoredBadge | null {
    return restoredBadge({
      restored: $layoutState.restoredSessionIds.has(sessionId),
      interrupted: $layoutState.interruptedSessionIds.has(sessionId),
      orphan: $layoutState.orphanBySessionId[sessionId] ?? null,
      compat: $daemonCompat,
    });
  }

  // Absent entirely when this session has no git repo. Dirty and clean
  // now differ by TONE on one branch glyph rather than by fill on a
  // coloured dot: the old outlined-amber "clean" spent the app's
  // attention colour saying there was nothing to attend to, and the
  // filled one was indistinguishable from the unsaved-edits dot two
  // elements along. No branch name or ahead/behind here either; that
  // detail lives entirely in the sidebar (see this plan's Global
  // Constraints).
  function tabGitBadge(sessionId: string): Indicator | null {
    const status = $layoutState.gitStatusById[sessionId];
    if (!status) return null;
    return gitIndicator(status.dirty);
  }

  // The three pane controls, on the pane. They used to live in the app's
  // title bar and act on `focusedSessionId`, which is why that bar had to
  // withdraw them on every hub tab: the focused pane survives a switch to
  // Kanban, so Split there spawned a session into a page nowhere on
  // screen and Close Pane killed one. Read off `active` instead and the
  // question cannot come up -- the pane doing the splitting is the one
  // whose bar was clicked, and it is by definition on screen.
  async function split(direction: "row" | "column"): Promise<void> {
    await splitPane(active, direction);
  }

  async function handleClosePane(): Promise<void> {
    if (await confirmPaneClose(active)) {
      await closePane(active);
    }
  }

  function startEditing(sessionId: string): void {
    // File, board and card tabs are never renameable -- their labels are
    // exact.
    if (!renameable(sessionId, naming)) return;
    editingSessionId = sessionId;
    editValue = tabLabel(sessionId);
  }

  function commitEdit(): void {
    if (editingSessionId === null) return;
    void setSessionName(editingSessionId, editValue);
    editingSessionId = null;
  }

  function cancelEdit(): void {
    editingSessionId = null;
  }

  function isPinnedTab(sessionId: string): boolean {
    return (leaf.pinned ?? []).includes(sessionId);
  }

  function reportMenuError(text: string): void {
    console.error(text);
    void showAlert({ title: "That didn't work", lines: [text] });
  }

  function openTabMenu(e: MouseEvent, sessionId: string): void {
    // Inside the inline rename input the native text menu must keep working.
    if (e.target instanceof HTMLInputElement) return;
    const file = fileTabPath(sessionId);
    const board = boardTab(sessionId);
    const kind = board ? "board" : file ? "file" : "terminal";
    const path = board ? board.contextFolder : (file ?? $layoutState.cwdBySessionId[sessionId] ?? null);
    openContextMenuFromEvent(
      e,
      buildTabMenuEntries(
        {
          tabId: sessionId,
          kind,
          path,
          pinned: isPinnedTab(sessionId),
          tabs: leaf.tabs,
          pinnedTabs: leaf.pinned ?? [],
          // The DAEMON's status, not the masked one the badge above
          // draws: "Mark as Read" has to be offered for the very wait it
          // hides, and reading the masked map would make the entry
          // vanish the moment it was used.
          status: $layoutState.sessionStatusById[sessionId],
          read: $layoutState.readSessionIds?.has(sessionId) === true,
        },
        { startRename: startEditing, reportError: reportMenuError }
      )
    );
  }

  function activeLocation(): { workspaceId: string; pageId: string } | null {
    const ws = getActiveWorkspace($layoutState);
    const page = getActivePage($layoutState);
    if (!ws || !page) return null;
    return { workspaceId: ws.id, pageId: page.id };
  }

  function handleTabDragStart(event: DragEvent, sessionId: string): void {
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "tab", workspaceId: location.workspaceId, pageId: location.pageId, sessionId });
  }

  // The whole BAR takes the drop, not the individual tabs: a pane
  // showing one or two tabs spends most of its header on the empty run
  // after them, and that stretch is exactly what a human aims at to say
  // "move it into that pane". While only the tab buttons answered, every
  // miss fell through to the body below and SPLIT the pane instead --
  // which is the gesture this one is supposed to be an alternative to.
  //
  // Boxes are read off what is drawn rather than off leaf.tabs, so a
  // strip scrolled sideways still measures where the pointer sees it.
  function barInsertion(
    event: DragEvent
  ): { index: number; anchorIndex: number; position: ReorderPosition } | null {
    const bar = event.currentTarget as HTMLElement;
    const boxes = [...bar.querySelectorAll<HTMLElement>(".tab-strip > .tab")].map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    return computeTabInsertion(boxes, event.clientX);
  }

  function handleBarDragOver(event: DragEvent): void {
    if (getDragKind(event) !== "tab") return;
    event.preventDefault();
    // Without an explicit dropEffect, the browser shows the "copy" (+)
    // cursor even though setDragPayload set effectAllowed to "move" --
    // dropEffect has to be set on the target's dragover, not just
    // effectAllowed on the source's dragstart.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const insertion = barInsertion(event);
    tabReorderState = insertion
      ? { sessionId: leaf.tabs[insertion.anchorIndex], position: insertion.position }
      : null;
  }

  // dragleave BUBBLES, so crossing from one tab to the next inside this
  // bar reports a leave for the bar as well. Only a pointer that has left
  // the bar's whole subtree clears the caret -- without the relatedTarget
  // check the indicator blinks out at every tab boundary the drag crosses.
  function handleBarDragLeave(event: DragEvent): void {
    const bar = event.currentTarget as HTMLElement;
    const to = event.relatedTarget as Node | null;
    if (to && bar.contains(to)) return;
    tabReorderState = null;
  }

  function clearTabReorder(): void {
    tabReorderState = null;
  }

  async function handleBarDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    const insertion = barInsertion(event);
    tabReorderState = null;
    if (!payload || payload.kind !== "tab") return;
    const location = activeLocation();
    if (!location || !insertion) return;
    if (
      leaf.tabs.includes(payload.sessionId) &&
      payload.workspaceId === location.workspaceId &&
      payload.pageId === location.pageId
    ) {
      // Reordering within this same pane's own tab bar; the caret's index
      // has to be renumbered for the splice (see reorderIndexWithin).
      const from = leaf.tabs.indexOf(payload.sessionId);
      await reorderTabWithinPane(payload.sessionId, reorderIndexWithin(insertion.index, from));
    } else {
      // A tab from another pane on this page (or, via the sidebar's own
      // routes, another page): it JOINS this pane at the caret rather
      // than splitting anything. targetSessionId pins the merge to THIS
      // pane specifically, not wherever the page's remembered focus
      // happens to point; targetIndex is what makes the caret honest,
      // since a center merge otherwise appends.
      await movePaneOrTab(
        { kind: "tab", workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        {
          kind: "page",
          workspaceId: location.workspaceId,
          pageId: location.pageId,
          mode: "center",
          targetSessionId: active,
          targetIndex: insertion.index,
        }
      );
    }
  }

  function handleContentDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "pane" && kind !== "tab") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = containerEl.getBoundingClientRect();
    contentDropZone = computeDropZone(rect, event.clientX, event.clientY);
  }

  function clearContentDrop(): void {
    contentDropZone = null;
  }

  async function handleContentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearContentDrop();
    if (!payload || (payload.kind !== "pane" && payload.kind !== "tab")) return;
    const location = activeLocation();
    if (!location) return;
    const rect = containerEl.getBoundingClientRect();
    const zone = computeDropZone(rect, event.clientX, event.clientY);
    await movePaneOrTab(
      { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
      { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: zone, targetSessionId: active }
    );
  }

  $effect(() => {
    if (editingSessionId !== null && editInput) {
      editInput.focus();
      editInput.select();
    }
  });

  // onMount, not a $effect gated on containerEl -- containerEl is a plain
  // `let` (bind:this target), so reading it inside $effect would never
  // establish reactivity and the observer would never actually get set up.
  // Svelte guarantees bind:this refs are already populated by the time
  // onMount runs, and this div is never conditionally recreated, so a
  // one-time setup here is both correct and simpler than chasing reactivity.
  onMount(() => {
    const observer = new ResizeObserver(() => fitAll());
    observer.observe(containerEl);
    return () => observer.disconnect();
  });
</script>

<div class="pane-wrapper">
  <div
    class="tab-bar"
    class:drop-target={tabReorderState !== null}
    ondragover={handleBarDragOver}
    ondragleave={handleBarDragLeave}
    ondrop={handleBarDrop}
  >
    <!-- Before the tabs, and outside the scroller: the room the
         window's corner needs when it hangs over a collapsed rail, so
         the first tab of the page is never drawn under the traffic
         lights. Zero-width whenever the column is open. -->
    {#if leadsWindow}
      <CornerOverhang />
    {/if}
    <!-- The tabs scroll under the actions rather than pushing them off
         the pane: a pane with six tabs open must still offer Close Pane.
         Nothing here is a drag source but the tabs themselves -- see the
         spacer below. -->
    <div class="tab-strip" use:wheelScrollsSideways>
        {#each leaf.tabs as sessionId, tabIndex (sessionId)}
        <button
          class="tab"
          class:active={sessionId === active}
          class:focused={sessionId === active && isFocused}
          class:drop-before={tabReorderState?.sessionId === sessionId && tabReorderState.position === "before"}
          class:drop-after={tabReorderState?.sessionId === sessionId && tabReorderState.position === "after"}
          draggable={editingSessionId !== sessionId}
          ondragstart={(e) => handleTabDragStart(e, sessionId)}
          ondragend={clearTabReorder}
          onclick={() => switchToTab(sessionId)}
          use:scrollsIntoLead={sessionId === active}
          class:pinned={isPinnedTab(sessionId)}
          oncontextmenu={(e) => openTabMenu(e, sessionId)}
        >
          {#if isPinnedTab(sessionId)}
            <span class="pin-glyph" title="Pinned"><Pin size={10} /></span>
          {/if}
          <!-- Only the focused pane: ⌘-digits act on the focused pane's
               tabs, so badging any other pane would be a lie. -->
          {#if $hintMode === "cmd" && isFocused}
            {@const digit = hintDigitFor(tabIndex, leaf.tabs.length)}
            {#if digit !== null}
              <ShortcutHint text={String(digit)} />
            {/if}
          {/if}
          {#if editingSessionId === sessionId}
            <input
              class="tab-label-input"
              bind:this={editInput}
              bind:value={editValue}
              onclick={(e) => e.stopPropagation()}
              onblur={commitEdit}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
          {:else}
            <span
              class="tab-label"
              use:tooltip={tabTooltip(sessionId)}
              ondblclick={() => startEditing(sessionId)}>{tabLabel(sessionId)}</span
            >
          {/if}
          {#if tabStatusBadge(sessionId)}
            {@const status = tabStatusBadge(sessionId)}
            {#if status}<StatusBadge indicator={status} size={10} />{/if}
          {/if}
          {#if fileTabPath(sessionId) && $dirtyPaths.has(fileTabPath(sessionId) ?? "")}
            <StatusBadge indicator={unsavedEditsIndicator()} size={10} />
          {/if}
          {#if tabGitBadge(sessionId)}
            {@const git = tabGitBadge(sessionId)}
            {#if git}<StatusBadge indicator={git} size={10} />{/if}
          {/if}
          <!-- `restored` still decides whether the badge is THERE, exactly
               as it always did: it is a note about the screen, and typing
               into the tab dismisses it (clearRestoredMarker). `interrupted`
               only decides what it SAYS while it is up — that half is
               sticky, because the run really is gone, and the card, rail
               step or commit record bound to this session reads it there.
               A tab the human has taken over as a plain shell does not need
               a permanent warning on it.

               An ORPHAN overrides both, including the dismissal: a live
               agent editing this checkout does not stop mattering because
               someone ran `ls` in the shell that replaced its tab. That
               case is the only one with an action behind it, and all three
               wordings come from orphan.ts so no second surface can
               describe them differently. The glyph and the tone come from
               the shared vocabulary (ui/indicators.ts): the shell axis,
               with the orphan as its one danger-toned state. -->
          {#if tabBadge(sessionId)}
            {@const badge = tabBadge(sessionId)!}
            <span
              class="restored-badge"
              class:orphaned={badge.tone === "orphaned"}
              role={badge.canEnd ? "button" : undefined}
              aria-label={badge.canEnd ? "End the process this session left running" : undefined}
              onclick={(e) => {
                if (!badge.canEnd) return;
                e.stopPropagation();
                void endSessionOrphan(sessionId);
              }}
            >
              <StatusBadge
                indicator={badge.tone === "orphaned"
                  ? shellOrphanIndicator()
                  : shellRestartedIndicator(badge.tone === "interrupted")}
                size={10}
                tip={badge.title}
              />
            </span>
          {/if}
          {#if !isPinnedTab(sessionId)}
            <span
              class="close"
              aria-label="Close Tab"
              title="Close Tab"
              onclick={async (e) => {
                e.stopPropagation();
                if (await confirmTabClose(sessionId)) {
                  closeSession(sessionId);
                }
              }}
            >
              <X size={12} />
            </span>
          {/if}
        </button>
      {/each}
    </div>
    <!-- The run of bar after the last tab moves the WINDOW, exactly as
         the hub row's leftover does. It used to start a drag of the
         whole pane instead: a gesture nothing named, sitting on the one
         surface a human reaches for to move a window -- and on a page
         with a single tab that surface is nearly the whole row.
         Dragging a TAB is the drag this row keeps, and it starts on the
         tab, so no press on this bar can mean two things at once. -->
    <div class="drag-spacer" use:windowDrag></div>
    <!-- Everything the bar offers, pinned to the right of it. Three of
         these used to sit in the app's title bar, where they addressed
         "the focused pane" -- a pane the human could not see from a hub
         tab, and could not tell apart from any other one on a split
         page. Here they name their subject by being ON it. The two
         chips beside them came the other way, off the individual tab:
         a tab is a label with a close box, and hanging a second and
         third action inside it made a tab something you had to aim at.
         Both act on the ACTIVE tab, like every other control here.

         Once per page, not once per pane: on a split page only the
         focused pane draws this group (paneOwnsActions), because four
         copies of Split/Close differing only in which pane they act on
         is four toolbars pretending to be one. -->
    {#if ownsActions}
      <div class="tab-actions">
        {#if linkedCard(active)}
          {@const link = linkedCard(active)}
          <IconButton
            icon={ListChecks}
            label="Show the plan this agent is running"
            tip={`Show plan · ${link?.title}`}
            tone="accent"
            size={14}
            onclick={() => {
              const ws = getActiveWorkspace($layoutState);
              if (link && ws) void openCardInSplit(active, ws.id, link.path, "plan");
            }}
          />
        {/if}
        {#if runChangesFor(active)}
          {@const run = runChangesFor(active)}
          <IconButton
            icon={FileDiff}
            label="See what this run changed"
            tip={run ? chipTooltip(run.baseSha) : null}
            tone="accent"
            size={14}
            onclick={() => {
              const ws = getActiveWorkspace($layoutState);
              if (run && ws) void openCardInSplit(active, ws.id, run.path, "changes");
            }}
          />
        {/if}
        {#if !isViewTab(active)}
          <!-- The follow-up queue. Unlike the two chips above it this one
               is not conditional on there being something to show: it is
               also how a follow-up gets WRITTEN, so withholding it until
               one exists would hide the feature behind itself. The badge
               is what makes it conditional -- a bare icon means an empty
               queue.

               The reason hangs on the wrapper, not on the button:
               tooltip.ts binds mouseenter, which a disabled element never
               fires. -->
          {@const blocked = queueBlockedReason(
            queueTargetFor(
              $layoutState.sessionStatusById[active],
              $layoutState.interruptedSessionIds.has(active)
            )
          )}
          {@const queued = $queuedInputsById[active] ?? []}
          <span use:tooltip={blocked ?? undefined}>
            <IconButton
              icon={MessageSquarePlus}
              label="Follow-ups for this agent"
              tip={blocked ?? queueTip(queued) ?? "Queue a follow-up for when this agent finishes its turn"}
              tone={queued.length > 0 ? "accent" : "default"}
              size={14}
              disabled={blocked !== null}
              onclick={() => {
                const ws = getActiveWorkspace($layoutState);
                if (ws) void openFollowUpsInSplit(active, ws.id);
              }}
            >
              {#if queued.length > 0}<span class="queue-count">{queued.length}</span>{/if}
            </IconButton>
          </span>
        {/if}
        {#if activeBoardContext}
          <IconButton
            icon={Kanban}
            label="Open context board"
            tip={`Open board · ${activeBoardContext.name}`}
            size={14}
            onclick={() => void openBoardInSplit(active, activeBoardContext.workspaceId, activeBoardContext.folderPath)}
          />
        {/if}
        <IconButton icon={Plus} label="New Tab" size={14} shortcut="new-tab" onclick={() => addTab(active)} />
        <span class="divider"></span>
        <IconButton icon={Columns2} label="Split Right" size={14} shortcut="split-right" onclick={() => split("row")} />
        <IconButton icon={Rows2} label="Split Down" size={14} shortcut="split-down" onclick={() => split("column")} />
        <IconButton icon={X} label="Close Pane" size={14} onclick={handleClosePane} />
        <!-- Last, and behind a rule: the only control here that is not
             about this pane. It adds a PAGE, and it rides on this row
             because this row is the top of the window on a terminal page,
             exactly as the hub tab row is on every other tab. -->
        <span class="divider"></span>
        <NewPageButton />
      </div>
    {/if}
  </div>
  <div
    class="content"
    class:drop-zone-left={contentDropZone === "left"}
    class:drop-zone-right={contentDropZone === "right"}
    class:drop-zone-top={contentDropZone === "top"}
    class:drop-zone-bottom={contentDropZone === "bottom"}
    class:drop-zone-center={contentDropZone === "center"}
    bind:this={containerEl}
    onmousedown={() => focusPane(active)}
    ondragover={handleContentDragOver}
    ondragleave={clearContentDrop}
    ondragend={clearContentDrop}
    ondrop={handleContentDrop}
  >
    {#each leaf.tabs as sessionId (sessionId)}
      {#if boardTab(sessionId)}
        <BoardPane
          bind:this={paneRefs[sessionId]}
          workspaceId={boardTab(sessionId)?.workspaceId ?? ""}
          contextFolder={boardTab(sessionId)?.contextFolder ?? ""}
          tabId={sessionId}
          visible={sessionId === active}
        />
      {:else if fileTabPath(sessionId)}
        <FileViewerPane
          bind:this={paneRefs[sessionId]}
          path={fileTabPath(sessionId) ?? ""}
          visible={sessionId === active}
        />
      {:else if followUpsFor(sessionId)}
        <FollowUpQueuePane
          bind:this={paneRefs[sessionId]}
          sessionId={followUpsFor(sessionId) ?? ""}
          tabId={sessionId}
          visible={sessionId === active}
        />
      {:else if cardTab(sessionId)}
        {@const tab = cardTab(sessionId)!}
        <CardTabPane
          bind:this={paneRefs[sessionId]}
          workspaceId={tab.workspaceId}
          path={tab.path}
          view={tab.view}
          tabId={sessionId}
          visible={sessionId === active}
        />
      {:else}
        <TerminalPane
          bind:this={paneRefs[sessionId]}
          {sessionId}
          visible={sessionId === active}
          focused={sessionId === $layoutState.focusedSessionId}
          fontSize={$terminalFontSize}
        />
      {/if}
    {/each}
  </div>
</div>

<style>
  .pane-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  /* One of the app's three header rows (see theme.css): this one, the
     workspace's hub tabs and the strip over the sidebar are the same
     height to the pixel. On a terminal page THIS is the top edge of the
     window, so a page and a hub tab have to hand the view under them the
     same starting line. */
  .tab-bar {
    display: flex;
    align-items: stretch;
    height: var(--header-height);
    box-sizing: border-box;
    padding: var(--header-pad-top) 6px 0;
    /* The view's own surface, not the raised one the row inherited from
       the title bar it replaced. Raised, this row was a grey band across
       the top of the window with one black tab cut out of it -- and the
       padding around that tab read as a margin of the sidebar's colour
       leaking in over the page. The hub tab row beside it was already
       flat black; this is that row. What separates the tabs now is the
       hairline below, not a change of surface. */
    background: var(--surface-base);
    flex: 0 0 auto;
    min-width: 0;
  }
  /* A pane no longer widens itself to fit its tabs (see .child in
     LayoutTree), so the strip carries its own overflow -- without this,
     splitting a pane with several tabs open would clip the last ones out
     of reach instead of merely making them scroll. The actions sit
     outside it, so what scrolls away is only ever a tab.

     Grows only as far as its tabs, like the hub row's strip: the
     leftover is the drag spacer's, so an empty stretch of this row moves
     the window instead of being dead bar inside a scroller. */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: var(--tab-gap);
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    /* No visible scrollbar: an overlay bar would land on the active
       tab's indicator, in a row this short. wheelScrollsSideways is what
       reaches the tabs it hides. */
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
  .drag-spacer {
    flex: 1 1 auto;
  }
  /* The bar answers as one surface while a tab is over it, because the
     caret alone marks a point the pointer may be nowhere near -- out on
     the spacer it would be the only feedback, and it sits back at the
     last tab. The blue is .content's drop overlay at a fraction of its
     weight: same language, a tint rather than a wash, since this row
     stays readable underneath. */
  .tab-bar.drop-target {
    background:
      linear-gradient(rgba(74, 158, 255, 0.12), rgba(74, 158, 255, 0.12)),
      var(--surface-base);
  }
  .tab-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    padding-left: 6px;
  }
  /* How many follow-ups are waiting for the active tab's agent. A count
     rather than a dot: the difference between one queued message and
     five is the whole reason to open the pane, and the icon alone --
     which is what an empty queue shows -- already says the action
     exists. Tabular so the row does not shift when 9 becomes 10. */
  .queue-count {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  /* Groups the actions by what they act on -- this tab, this pane, the
     page -- without spending a row of labels on saying so. */
  .divider {
    width: 1px;
    align-self: center;
    height: var(--tab-divider);
    margin: 0 3px;
    background: var(--border);
  }
  .tab {
    /* Anchors the hold-⌘ hint badge, which overlays rather than
       reflowing the tab bar. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    /* The hub tabs' own metrics, from theme.css. These were smaller --
       4px/8px at 0.8em against 6px/10px at 0.85em -- which was invisible
       while the two rows lived on different parts of the window and is
       not now that either of them can be its top edge. */
    padding: var(--tab-pad);
    background: transparent;
    /* Always present (transparent when inactive) so toggling the
       indicator never changes the tab's box height -- box-sizing keeps
       it folded into the height in both states. Underneath, not on top:
       the hub tab's indicator sits on the edge it shares with the view
       it opens, and a page's tabs now say it the same way. */
    border: none;
    border-bottom: var(--tab-indicator) solid transparent;
    box-sizing: border-box;
    color: var(--text-muted);
    font-family: monospace;
    font-size: var(--tab-font-size);
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text);
  }
  /* The hub row's separator, to the pixel (theme.css): down the middle
     of the gap, and short of the row's height so it reads as a rule
     between tabs rather than a box around each one. Off .tab, which is
     already `position: relative` for the hold-⌘ hint. */
  .tab + .tab::before {
    content: "";
    position: absolute;
    left: calc(var(--tab-gap) / -2);
    top: 50%;
    height: var(--tab-divider);
    width: 1px;
    transform: translateY(-50%);
    background: var(--border);
  }
  /* Text alone, as on the hub row. The active tab used to be a black
     fill against a grey bar; on a bar that is already the view's own
     black there is no fill left to give it, and the full-strength text
     against the muted rest is what the hub tabs have always used. */
  .tab.active {
    color: var(--text);
  }
  /* The workspace's accent, exactly as the hub tabs draw it -- including
     the amber a workspace with no colour of its own falls back to. It
     still marks the FOCUSED pane's active tab and nothing else: which
     pane the keyboard is in is a fact only this row can state. */
  .tab.focused {
    border-bottom-color: var(--ws-accent, #d9a648);
  }
  /* Where the bar lands the tab, drawn against the nearest tab to the
     pointer -- including a drop out on the empty run past the last one,
     which reads as "after" it. */
  .tab.drop-before {
    box-shadow: inset 2px 0 0 0 var(--ws-accent, #4a9eff);
  }
  .tab.drop-after {
    box-shadow: inset -2px 0 0 0 var(--ws-accent, #4a9eff);
  }
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pin-glyph {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    margin-right: 2px;
  }
  .tab.pinned {
    padding-right: 10px;
  }
  .restored-badge {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
  }
  /* The one badge here that does something when pressed: a live process
     still editing the folder. The tone is the badge's own; this only
     says it can be clicked. */
  .restored-badge.orphaned {
    cursor: pointer;
  }
  .restored-badge.orphaned:hover {
    opacity: 0.75;
  }
  .tab-label-input {
    max-width: 120px;
    width: 100px;
    background: var(--surface-sunken);
    color: var(--text);
    border: 1px solid var(--border-focus);
    border-radius: 3px;
    font-family: monospace;
    font-size: 1em;
    padding: 0 2px;
  }
  .close {
    opacity: 0.6;
  }
  .close:hover {
    opacity: 1;
  }
  .content {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .content.drop-zone-left::after,
  .content.drop-zone-right::after,
  .content.drop-zone-top::after,
  .content.drop-zone-bottom::after,
  .content.drop-zone-center::after {
    content: "";
    position: absolute;
    background: rgba(74, 158, 255, 0.35);
    pointer-events: none;
    z-index: 2;
  }
  .content.drop-zone-left::after {
    inset: 0 75% 0 0;
  }
  .content.drop-zone-right::after {
    inset: 0 0 0 75%;
  }
  .content.drop-zone-top::after {
    inset: 0 0 75% 0;
  }
  .content.drop-zone-bottom::after {
    inset: 75% 0 0 0;
  }
  .content.drop-zone-center::after {
    inset: 25%;
  }
</style>
