<script lang="ts">
  // One workspace's board, to read. A thin template over phoneBoard.ts;
  // the cards are the desktop's own component.
  import { untrack } from "svelte";
  import BoardCard from "$lib/board/BoardCard.svelte";
  import { boardError, kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { attentionStatusById, layoutState } from "$lib/core/layoutState";
  import type { Workspace } from "$lib/core/workspace";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import type { Landing } from "$companion/channel/messages";
  import {
    cardAgent,
    columnAt,
    columnOf,
    landingCard,
    openingColumn,
    phoneBoard,
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
    return boardError(workspace.id);
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
  // the landed card's, else the one work is in flight on. Not again
  // afterwards: every push redraws the board, and a column the human
  // swiped to must not be taken from under their thumb.
  $effect(() => {
    if (!pager || columns.length === 0) return;
    untrack(() => {
      if (shown !== null && columns.some((c) => c.key === shown)) return;
      const opening = columnOf(columns, landed) ?? openingColumn(columns);
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

  // The desktop's card asks for this. Nothing opens yet: reading a card
  // and acting on it arrive together, with the card surface.
  function stay(): void {}
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
            {#snippet agent()}
              {#if badge}
                <span class="agent"><StatusBadge indicator={badge} size={13} text={badge.tip} tip={null} /></span>
              {/if}
            {/snippet}
            <div class="slot" class:landed={card.id === landed} use:reveal={card.id === landed}>
              <BoardCard
                {card}
                labelDefs={board.labels}
                onOpen={stay}
                workspaceId={null}
                adornment={badge ? agent : undefined}
              />
            </div>
          {:else}
            <p class="hint">Nothing here.</p>
          {/each}
        </section>
      {/each}
    </div>
  </div>
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
</style>
