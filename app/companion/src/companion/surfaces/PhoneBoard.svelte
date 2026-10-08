<script lang="ts">
  // One workspace's board: its columns a swipe apart, a card a tap away,
  // and a new card or the PRD from the bar above them. A thin template
  // over phoneBoard.ts; the cards are the desktop's own component, and
  // everything done to one is done on its own page (PhoneCard.svelte).
  import { untrack } from "svelte";
  import { BookOpen, Plus } from "@lucide/svelte";
  import BoardCard from "$lib/board/BoardCard.svelte";
  import { boardError, kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { attentionStatusById, layoutState } from "$lib/core/layoutState";
  import type { Workspace } from "$lib/core/workspace";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import type { Landing } from "$companion/channel/messages";
  import { onReconnect, reachability, shownError } from "$companion/state/reachability";
  import { openCard, openPrd, returnedFrom } from "$companion/state/workstation";
  import PhoneCompose from "$companion/surfaces/PhoneCompose.svelte";
  import { waitingCount } from "$companion/surfaces/phoneCard";
  import {
    cardAgent,
    columnAt,
    columnOf,
    landingCard,
    openingColumn,
    phoneBoard,
    recoverBoard,
    scrollBehaviour,
  } from "$companion/surfaces/phoneBoard";

  interface Props {
    workspace: Workspace;
    /// The inbox item this board was opened for, if one: its card is
    /// revealed, and the board opens on that card's column.
    landing?: Landing | null;
  }
  let { workspace, landing = null }: Props = $props();

  const board = $derived(phoneBoard($kanbanState[workspace.id], $gavinTrees[workspace.id]));
  const columns = $derived(board?.columns ?? []);
  const landed = $derived(landingCard($kanbanState[workspace.id], landing));
  // Read through the store so a failed load redraws; the message itself
  // is kept beside the boards, not in them.
  const loadError = $derived.by(() => {
    void $kanbanState;
    return shownError(boardError(workspace.id), $reachability);
  });

  $effect(() => {
    const id = workspace.id;
    if (!workspace.rootPath) return;
    return onReconnect(() => void recoverBoard(id));
  });
  const agents = $derived({
    board: $kanbanState[workspace.id],
    layout: $layoutState,
    statusById: $attentionStatusById,
  });

  let pager = $state<HTMLElement | null>(null);
  let shown = $state<string | null>(null);
  // The column a tap is on its way to. While it is set the strip already
  // names it, and the positions the pager passes through on the way are
  // not the human's choice to follow.
  let heading: string | null = null;

  // The column the board opens on, once, when its columns first arrive:
  // the landed card's, else that of the card the human has just come back
  // from, else the one work is in flight on. Not again afterwards: every
  // push redraws the board, and a column the human swiped to must not be
  // taken from under their thumb.
  $effect(() => {
    if (!pager || columns.length === 0) return;
    untrack(() => {
      if (shown !== null && columns.some((c) => c.key === shown)) return;
      const opening = columnOf(columns, landed) ?? columnOf(columns, $returnedFrom) ?? openingColumn(columns);
      shown = opening;
      const index = columns.findIndex((c) => c.key === opening);
      if (pager && index > 0) pager.scrollLeft = index * pager.clientWidth;
    });
  });

  /// Brings the landed card into view, once it is drawn.
  function reveal(node: HTMLElement, isLanded: boolean): { update(next: boolean): void } {
    const show = (on: boolean): void => {
      if (on) node.scrollIntoView({ block: "center" });
    };
    show(isLanded);
    return { update: show };
  }

  function show(key: string): void {
    const index = columns.findIndex((c) => c.key === key);
    if (!pager || index === -1) return;
    shown = key;
    heading = key;
    pager.scrollTo({
      left: index * pager.clientWidth,
      behavior: scrollBehaviour({
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        visible: document.visibilityState === "visible",
      }),
    });
  }

  // A swipe settles on a page; the strip above follows it.
  function followSwipe(): void {
    if (!pager) return;
    const at = columnAt(
      columns.map((c) => c.key),
      pager.scrollLeft,
      pager.clientWidth
    );
    if (at === null) return;
    if (heading !== null) {
      if (at === heading) heading = null;
      return;
    }
    if (at !== shown) shown = at;
  }

  // A finger on the pager takes over from a tap still on its way.
  function takeOver(): void {
    heading = null;
  }

  // A tap on a card opens it -- or opens the nested task it landed on,
  // which the desk's card draws inside its plan under a mark of its own.
  // A tap on a control inside the card (a plan's chevron) is that
  // control's. The card itself is the keyboard's way in: it is a button,
  // and Enter opens it through `onOpen`.
  function tapped(event: MouseEvent, cardId: string): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, select, textarea")) return;
    openCard(target?.closest("[data-kb-plan]")?.getAttribute("data-kb-plan") ?? cardId);
  }

  // ---- a new card -----------------------------------------------------------
  const columnNames = $derived(($kanbanState[workspace.id]?.columns ?? []).map((c) => c.name));
  let composing = $state(false);

  /// Back from the composer: to the column the card was filed in, where
  /// it now sits last.
  function composed(filed: { path: string; status: string } | null): void {
    composing = false;
    const column = filed ? columns.find((c) => !c.unmatched && c.name === filed.status) : undefined;
    if (column) show(column.key);
  }
</script>

{#if !workspace.rootPath}
  <p class="note">
    This workspace is bound to no folder, so it has no cards. Its terminals are under Sessions.
  </p>
{:else if loadError}
  <p class="note problem">The board could not be read: {loadError}</p>
{:else if !board}
  <p class="note">Reading the board…</p>
{:else if columns.length === 0}
  <p class="note">This board has no columns.</p>
{:else}
  <div class="board">
    <div class="tools">
      <button type="button" class="tool" onclick={() => (composing = true)}>
        <Plus size={16} />
        <span>New card</span>
      </button>
      <button type="button" class="tool" onclick={openPrd}>
        <BookOpen size={16} />
        <span>PRD</span>
      </button>
    </div>
    <div class="strip" role="tablist" aria-label="Columns">
      {#each columns as column (column.key)}
        <button
          type="button"
          role="tab"
          class="tab tone-{column.tone}"
          class:shown={column.key === shown}
          aria-selected={column.key === shown}
          onclick={() => show(column.key)}
        >
          <span class="tab-name">{column.name}</span>
          <span class="tab-count">{column.cards.length}</span>
        </button>
      {/each}
    </div>

    <div
      class="pager"
      role="group"
      aria-label="Cards, one column at a time"
      bind:this={pager}
      onscroll={followSwipe}
      ontouchstart={takeOver}
      onpointerdown={takeOver}
    >
      {#each columns as column (column.key)}
        <section class="page" aria-label={column.name}>
          {#if column.unmatched}
            <p class="hint">No column of this board is called “{column.name}”.</p>
          {/if}
          {#each column.cards as card (card.id)}
            {@const badge = cardAgent(agents, card.id)}
            {@const asks = waitingCount($gavinTrees[workspace.id], card.id)}
            {#snippet agent()}
              {#if badge}
                <span class="agent"><StatusBadge indicator={badge} size={13} text={badge.tip} tip={null} /></span>
              {/if}
              {#if asks > 0}
                <span class="asks">{asks === 1 ? "1 waiting on you" : `${asks} waiting on you`}</span>
              {/if}
            {/snippet}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- the card inside is the keyboard's way in (see `tapped`) -->
            <div
              class="slot"
              class:landed={card.id === landed}
              use:reveal={card.id === landed || card.id === $returnedFrom}
              onclick={(e) => tapped(e, card.id)}
            >
              <BoardCard
                {card}
                labelDefs={board.labels}
                onOpen={openCard}
                workspaceId={null}
                adornment={badge || asks > 0 ? agent : undefined}
              />
            </div>
          {:else}
            <p class="hint">Nothing here.</p>
          {/each}
        </section>
      {/each}
    </div>
  </div>
  {#if composing}
    <PhoneCompose {workspace} columns={columnNames} initialStatus={columns.find((c) => c.key === shown && !c.unmatched)?.name ?? null} onClose={composed} />
  {/if}
{/if}

<style>
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note.problem {
    color: var(--danger-text);
  }
  /* The card an inbox item landed on: outlined, so the eye finds it in
     the column the board opened on. */
  .slot.landed {
    border-radius: 8px;
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .board {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }

  /* The strip is the board's shape at a glance -- every column and how
     full it is -- and the way between them for a thumb that would rather
     tap than swipe. */
  .strip {
    display: flex;
    flex: 0 0 auto;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
    scrollbar-width: none;
  }
  .tab {
    display: inline-flex;
    flex: 0 0 auto;
    /* Centred, not on the baseline: the tab is a thumb tall and its
       label is not, and a baseline would pin the label to the top. */
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 14px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }
  .tab-count {
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .tab.shown {
    border-bottom-color: var(--tab-tone, var(--text-muted));
    color: var(--text);
  }
  .tab.shown .tab-count {
    color: var(--tab-tone, var(--text-muted));
  }
  .tab.tone-progress {
    --tab-tone: var(--accent);
  }
  .tab.tone-done {
    --tab-tone: var(--success);
  }
  .tab:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }

  .pager {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .page {
    flex: 0 0 100%;
    box-sizing: border-box;
    min-width: 0;
    padding: 12px max(12px, env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
    overflow-y: auto;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    /* The desktop's card sizes itself at 0.85em of whatever holds it.
       On a 16px page that is a line a thumb can still miss; this is the
       one number that scales the card without touching it. */
    font-size: 1.125rem;
  }
  .hint {
    margin: 4px 2px 12px;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .agent {
    display: inline-flex;
    font-size: 0.75rem;
  }
  /* The desk's own vocabulary for a card with a question on it
     (the Decisions tab's), as a line a thumb can read. */
  .asks {
    display: inline-flex;
    padding: 1px 6px;
    border: 1px solid var(--border-warning);
    border-radius: 4px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.6875rem;
  }
  .slot {
    cursor: pointer;
  }

  /* What the board can do, above what is on it. */
  .tools {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.8125rem;
  }
  .tool:active {
    background: var(--surface-hover);
  }
  .tool:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
