<script lang="ts">
  import { onMount } from "svelte";
  import type { LayoutNode } from "./layout";
  import TerminalPane from "./TerminalPane.svelte";
  import FileViewerPane from "./FileViewerPane.svelte";
  import BoardPane from "./BoardPane.svelte";
  import {
    layoutState,
    daemonCompat,
    switchToTab,
    addTab,
    closeSession,
    focusPane,
    setSessionName,
    openBoardInSplit,
    repairUnknownTabs,
    terminalFontSize,
  } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { kanbanState, cardSessionFor, fetchBoard } from "./kanbanState";
  import { orchestrations, fetchOrchestration } from "./orchestrationState";
  import { linkedCardFor, openLinkedCard, type LinkedCard } from "./cardTabLink";
  import { cardSessionState } from "./columnRunAction";
  import { chipTooltip, runBaseline } from "./runChanges";
  import RunChangesModal from "./RunChangesModal.svelte";
  import { nearestContext } from "./planBoard";
  import { confirmTabClose } from "./confirmClose";
  import { restoredBadge, type RestoredBadge } from "./orphan";
  import { endSessionOrphan } from "./orphanActions";
  import { dirtyPaths } from "./fileEditing";
  import { showAlert } from "./dialog";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildTabMenuEntries } from "./tabMenu";
  import { X, Plus, Kanban, Pin, SquareArrowOutUpRight, FileDiff } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import {
    agentFailedIndicator,
    agentIndicator,
    gitIndicator,
    shellOrphanIndicator,
    shellRestartedIndicator,
    unsavedEditsIndicator,
    type Indicator,
  } from "./ui/indicators";
  import { hintMode } from "./shortcutHints";
  import { hintDigitFor } from "./shortcuts";
  import { tooltip } from "./tooltip";
  import { sessionLabel, folderName, boardTabLabel } from "./paths";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    type DropZone,
  } from "./dragDrop";
  import { movePaneOrTab, reorderTabWithinPane } from "./layoutState";
  import { getActiveWorkspace, getActivePage } from "./workspace";

  let { leaf }: { leaf: Extract<LayoutNode, { type: "leaf" }> } = $props();

  let paneRefs: Record<string, { fit: () => void }> = {};
  let containerEl: HTMLDivElement;

  const isFocused = $derived(
    $layoutState.focusedSessionId !== null && leaf.tabs.includes($layoutState.focusedSessionId)
  );
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

  function fileTabPath(tabId: string): string | null {
    return $layoutState.fileTabsById[tabId]?.path ?? null;
  }

  function boardTab(tabId: string): { workspaceId: string; contextFolder: string } | null {
    return $layoutState.boardTabsById[tabId] ?? null;
  }

  // A board tab's label names its context, live from the tree -- exact
  // information like a file tab's filename, and equally not renameable.
  // The format itself lives in paths.ts, shared with the sidebar's page
  // expansion, so one tab never goes by two names.
  function boardLabel(tabId: string): string {
    const tab = boardTab(tabId);
    if (!tab) return tabId;
    const name = $gavinTrees[tab.workspaceId]?.contexts.find((c) => c.folderPath === tab.contextFolder)?.name;
    return boardTabLabel(name, tab.contextFolder);
  }

  function tabLabel(sessionId: string): string {
    if (boardTab(sessionId)) return boardLabel(sessionId);
    const path = fileTabPath(sessionId);
    // A file tab's label is always its filename -- exact, known
    // information, unlike a terminal's cwd-derived guess, which is why it
    // is also not renameable (see the startEditing guard below).
    if (path) return folderName(path);
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  function tabTooltip(sessionId: string): string {
    const tab = boardTab(sessionId);
    if (tab) return tab.contextFolder;
    const path = fileTabPath(sessionId);
    if (path) return path;
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
  }

  // The active terminal tab's nearest gavin context, if any -- drives the
  // board icon at the end of the tab bar. Follows the LIVE cwd; the tab a
  // click opens is then pinned to the context captured at that moment.
  const activeBoardContext = $derived.by(() => {
    if (fileTabPath(active) || boardTab(active)) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    const ctx = nearestContext($gavinTrees[ws.id], $layoutState.cwdBySessionId[active]);
    return ctx ? { workspaceId: ws.id, folderPath: ctx.folderPath, name: ctx.name } : null;
  });

  // The card this tab's agent is running, if any: the board's Run and an
  // orchestration launch both write a card_sessions binding, so one
  // reverse lookup covers both. Null for every ordinary terminal.
  function linkedCard(sessionId: string): LinkedCard | null {
    if (fileTabPath(sessionId) || boardTab(sessionId)) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    return linkedCardFor($kanbanState[ws.id], $orchestrations[ws.id], $gavinTrees[ws.id], sessionId);
  }

  // The same reverse lookup, one step further: the binding this tab's
  // agent runs under, and the commit its checkout was on when it
  // started. Null for a run with no baseline -- an older daemon, a
  // launch outside a repository -- because a chip is a glyph with no
  // room to explain itself. The card detail modal is where the reason
  // is said; this only appears when there is something to open.
  //
  // Deliberately fetches NOTHING. A count on the chip would be a `git
  // diff` per tab per render, across every pane in the window.
  function runChangesFor(sessionId: string): {
    path: string;
    title: string;
    cwd: string;
    baseSha: string;
    live: boolean;
  } | null {
    const link = linkedCard(sessionId);
    if (!link) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    const binding = cardSessionFor($kanbanState[ws.id], link.path);
    const baseline = runBaseline(binding, $daemonCompat);
    if (baseline.kind !== "ready") return null;
    return {
      path: link.path,
      title: link.title,
      cwd: baseline.cwd,
      baseSha: baseline.baseSha,
      live: cardSessionState($layoutState, binding) === "live",
    };
  }

  /// The tab whose Changes modal is open, if any. One at a time: it is
  /// opened from a tab click and closed from its own header.
  let changesFor = $state<{
    path: string;
    title: string;
    cwd: string;
    baseSha: string;
    live: boolean;
  } | null>(null);

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
    const unknown = leaf.tabs.filter((id) => !boardTab(id) && !fileTabPath(id));
    if (unknown.length > 0) void repairUnknownTabs(unknown);
  });

  // idle intentionally returns null here -- no badge at all is the idle
  // indicator, not a neutral-toned one (see this plan's Global
  // Constraints). The two states that DO draw come from the app's shared
  // agent vocabulary (ui/indicators.ts), so a tab, the board card bound
  // to the same session and the sidebar row under it all say it with the
  // same glyph and the same tone.
  function tabStatusBadge(sessionId: string): Indicator | null {
    const status = $layoutState.sessionStatusById[sessionId];
    // Before every other status: this is the one that used to be
    // indistinguishable from idle -- i.e. from no badge at all -- so a tab
    // whose agent had broken looked exactly like one whose agent was
    // done. The reason is the agent's own line, and the tab is where the
    // human goes to read the rest of it.
    if (status === "failed") return agentFailedIndicator($layoutState.failureReasonById[sessionId]);
    if (status !== "working" && status !== "waiting_for_input") return null;
    return agentIndicator(status);
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

  function startEditing(sessionId: string): void {
    // File and board tabs are never renameable -- their labels are exact.
    if (fileTabPath(sessionId) || boardTab(sessionId)) return;
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
        { tabId: sessionId, kind, path, pinned: isPinnedTab(sessionId), tabs: leaf.tabs, pinnedTabs: leaf.pinned ?? [] },
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

  function handlePaneDragStart(event: DragEvent): void {
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "pane", workspaceId: location.workspaceId, pageId: location.pageId, sessionId: active });
  }

  function handleTabDragStart(event: DragEvent, sessionId: string): void {
    // Prevents this event from also triggering the parent .tab-bar's own
    // dragstart handler via bubbling -- see this task's module-level note
    // on why that would silently turn a single-tab drag into a
    // whole-pane drag.
    event.stopPropagation();
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "tab", workspaceId: location.workspaceId, pageId: location.pageId, sessionId });
  }

  function handleTabDragOver(event: DragEvent, sessionId: string): void {
    if (getDragKind(event) !== "tab") return;
    event.preventDefault();
    event.stopPropagation();
    // Without an explicit dropEffect, the browser shows the "copy" (+)
    // cursor even though setDragPayload set effectAllowed to "move" --
    // dropEffect has to be set on the target's dragover, not just
    // effectAllowed on the source's dragstart.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    tabReorderState = { sessionId, position: x < 0.5 ? "before" : "after" };
  }

  function clearTabReorder(): void {
    tabReorderState = null;
  }

  async function handleTabDrop(event: DragEvent, sessionId: string, index: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const payload = getDragPayload(event);
    tabReorderState = null;
    if (!payload || payload.kind !== "tab") return;
    const location = activeLocation();
    if (!location) return;
    if (
      leaf.tabs.includes(payload.sessionId) &&
      payload.workspaceId === location.workspaceId &&
      payload.pageId === location.pageId
    ) {
      // Reordering within this same pane's own tab bar.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const targetIndex = x < 0.5 ? index : index + 1;
      await reorderTabWithinPane(payload.sessionId, targetIndex);
    } else {
      // A tab from elsewhere, dropped onto a specific tab in this pane --
      // merge it in as a new tab here, same as dropping on .content's
      // center zone. targetSessionId: active pins the merge to THIS
      // pane specifically, not wherever the page's remembered focus
      // happens to point.
      await movePaneOrTab(
        { kind: "tab", workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: "center", targetSessionId: active }
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
  <div class="tab-bar" draggable={editingSessionId === null} ondragstart={handlePaneDragStart}>
    {#each leaf.tabs as sessionId, tabIndex (sessionId)}
      <button
        class="tab"
        class:active={sessionId === active}
        class:focused={sessionId === active && isFocused}
        class:drop-before={tabReorderState?.sessionId === sessionId && tabReorderState.position === "before"}
        class:drop-after={tabReorderState?.sessionId === sessionId && tabReorderState.position === "after"}
        draggable={editingSessionId !== sessionId}
        ondragstart={(e) => handleTabDragStart(e, sessionId)}
        ondragover={(e) => handleTabDragOver(e, sessionId)}
        ondragleave={clearTabReorder}
        ondragend={clearTabReorder}
        ondrop={(e) => handleTabDrop(e, sessionId, tabIndex)}
        onclick={() => switchToTab(sessionId)}
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
        {#if linkedCard(sessionId)}
          {@const link = linkedCard(sessionId)}
          <span
            class="card-link"
            aria-label="Open the card this agent is running"
            use:tooltip={`Open card · ${link?.title}`}
            onclick={(e) => {
              e.stopPropagation();
              if (link) void openLinkedCard(getActiveWorkspace($layoutState)?.id ?? "", link);
            }}
          >
            <SquareArrowOutUpRight size={11} />
          </span>
        {/if}
        {#if runChangesFor(sessionId)}
          {@const run = runChangesFor(sessionId)}
          <span
            class="card-link"
            aria-label="See what this run changed"
            use:tooltip={run ? chipTooltip(run.baseSha) : undefined}
            onclick={(e) => {
              e.stopPropagation();
              changesFor = run;
            }}
          >
            <FileDiff size={11} />
          </span>
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
    <IconButton icon={Plus} label="New Tab" size={14} shortcut="new-tab" onclick={() => addTab(active)} />
    {#if activeBoardContext}
      <IconButton
        icon={Kanban}
        label="Open context board"
        tip={`Open board · ${activeBoardContext.name}`}
        size={14}
        onclick={() => void openBoardInSplit(active, activeBoardContext.workspaceId, activeBoardContext.folderPath)}
      />
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

<!-- Opened from a tab chip, so it lives here rather than in the hub:
     the human is looking at the agent, and the answer to "what has it
     actually done to my checkout" should not require finding its card
     first. -->
{#if changesFor}
  <RunChangesModal
    path={changesFor.path}
    title={changesFor.title}
    cwd={changesFor.cwd}
    baseSha={changesFor.baseSha}
    sessionIsLive={changesFor.live}
    onClose={() => (changesFor = null)}
  />
{/if}

<style>
  .pane-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  .tab-bar {
    display: flex;
    background: var(--surface-raised);
    flex: 0 0 auto;
    /* A pane no longer widens itself to fit its tabs (see .child in
       LayoutTree), so the strip has to carry its own overflow -- without
       this, splitting a pane with several tabs open would clip the last
       ones out of reach instead of merely making them scroll. */
    overflow-x: auto;
    min-width: 0;
  }
  .tab {
    /* Anchors the hold-⌘ hint badge, which overlays rather than
       reflowing the tab bar. */
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    /* border-top is always present (transparent when inactive) so toggling
       the indicator on/off never changes the tab's box height -- box-sizing
       keeps that same 2px folded into the height in both states. */
    border: none;
    border-top: 2px solid transparent;
    box-sizing: border-box;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .tab.active {
    background: var(--surface-base);
    color: var(--text);
  }
  .tab.focused {
    border-top-color: var(--ws-accent, #4a9eff);
  }
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
  /* Quieter than the close control until hovered: it is an offer, not a
     thing every tab wants you to press. */
  .card-link {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    opacity: 0.55;
    color: var(--accent-text);
  }
  .card-link:hover {
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
