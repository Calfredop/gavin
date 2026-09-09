<script lang="ts">
  // The archive, as the kanban tab shows it: one grid of cards, newest
  // first. Not a column -- these cards have left the board, and laying
  // them out in a strip would invite the reading that they are still in
  // one.
  //
  // Clicks come from the SAME delegated engine the board uses, attached
  // with cards locked: a locked candidate never activates a drag but
  // still opens a card and still shift-selects, so an archived card
  // behaves exactly like a board card that a search is filtering.

  import BoardCard from "$lib/board/BoardCard.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { ArchiveRestore, Check } from "@lucide/svelte";
  import { attachBoardDrag } from "$lib/board/kanbanDragGlue";
  import { boardSelection, toggleCardSelected, clearBoardSelection } from "$lib/board/boardSelection";
  import { archivedOn } from "$lib/files/archive";
  import { tooltip } from "$lib/tooltip";
  import type { Label } from "$lib/board/kanban";
  import type { CardView } from "$lib/planBoard";

  interface Props {
    workspaceId: string;
    cards: CardView[];
    labels: Label[];
    /// Cards the search box is hiding; 0 when unfiltered.
    hiddenCount?: number;
    /// Picking mode, for the Delete dropdown's "selected" route. A plain
    /// click TOGGLES instead of opening the card, which is the whole
    /// point of a mode: shift+click alone would make the human learn a
    /// chord to answer a question the menu just asked them.
    selectMode?: boolean;
    onOpenCard: (path: string) => void;
    onRestore: (card: CardView) => void;
    onDeleteCard: ((card: CardView) => void) | null;
    onCardContextMenu: ((card: CardView, e: MouseEvent) => void) | null;
    /// Null while the running daemon is too old to serve the archive.
    restoreBlocked?: string | null;
  }
  let {
    workspaceId,
    cards,
    labels,
    hiddenCount = 0,
    selectMode = false,
    onOpenCard,
    onRestore,
    onDeleteCard,
    onCardContextMenu,
    restoreBlocked = null,
  }: Props = $props();

  let gridEl = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!gridEl) return;
    return attachBoardDrag({
      root: gridEl,
      allowColumns: false,
      commit: () => {},
      cardsLocked: () => true,
      click: (kind, id, mods) => {
        if (kind !== "plan") return;
        // `selectMode` is read HERE rather than in the effect body on
        // purpose: a prop read inside a callback gives the live value
        // without making the mode a dependency, so toggling it does not
        // tear the drag engine down and rebuild it under the pointer.
        if (mods.shift || selectMode) {
          toggleCardSelected(id);
        } else {
          clearBoardSelection();
          onOpenCard(id);
        }
      },
    });
  });

  const empty = $derived(cards.length === 0);
</script>

<div class="archive" bind:this={gridEl}>
  {#if empty}
    <div class="empty">
      {#if hiddenCount > 0}
        <p>No archived card matches this search.</p>
        <p class="detail">{hiddenCount} archived {hiddenCount === 1 ? "card is" : "cards are"} hidden.</p>
      {:else}
        <p>Nothing archived yet.</p>
        <p class="detail">
          Archive a card from its right-click menu, or clear the whole Done column with its
          archive button.
        </p>
      {/if}
    </div>
  {:else}
    <div class="grid">
      {#each cards as card (card.id)}
        {@const on = archivedOn(card.modifiedAt)}
        <div
          class="cell"
          class:picked={$boardSelection.includes(card.id)}
          data-kb-plan={card.id}
          data-kb-kind={card.kind}
          data-kb-ctx={card.contextFolder}
        >
          <BoardCard
            {card}
            labelDefs={labels}
            onOpen={onOpenCard}
            {workspaceId}
            onDelete={onDeleteCard}
            onContextMenu={onCardContextMenu}
            columnName={card.status}
          >
            {#snippet adornment()}
              <div class="stamp">
                {#if selectMode}
                  <!-- A box, not a tick alone: an empty one has to read
                       as "not picked" rather than as a missing glyph. -->
                  <span
                    class="tick"
                    class:on={$boardSelection.includes(card.id)}
                    aria-hidden="true"
                  >
                    {#if $boardSelection.includes(card.id)}<Check size={9} />{/if}
                  </span>
                {/if}
                <span class="when" use:tooltip={on ? `Archived ${on}` : "This card's file date couldn't be read"}>
                  {on ?? "—"}
                </span>
                <IconButton
                  icon={ArchiveRestore}
                  label="Restore from archive"
                  size={11}
                  class="restore"
                  disabled={restoreBlocked !== null || selectMode}
                  tip={restoreBlocked ??
                    (selectMode
                      ? "Leave select mode to restore a card"
                      : "Restore — files the card back on the board by its status")}
                  onclick={() => onRestore(card)}
                />
              </div>
            {/snippet}
          </BoardCard>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .archive {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    box-sizing: border-box;
  }
  /* auto-fill, not auto-fit: a lone archived card should keep a card's
     width instead of stretching across the whole tab. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    align-items: start;
  }
  /* The card's own margin-bottom is for a column's stack; in a grid the
     gap owns the spacing. */
  .cell :global(.card) {
    margin-bottom: 0;
  }
  .cell.picked {
    border-radius: 8px;
    outline: 1px solid var(--border-accent);
    outline-offset: 2px;
  }
  .tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    flex: none;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    color: var(--accent-fg, #fff);
  }
  .tick.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .stamp {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .when {
    color: var(--text-subtle);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
  .stamp :global(.restore) {
    margin-left: auto;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 100%;
    color: var(--text-muted);
    font-family: monospace;
    text-align: center;
  }
  .empty .detail {
    color: var(--text-subtle);
    font-size: 0.85em;
    max-width: 42ch;
  }
</style>
