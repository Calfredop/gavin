<script lang="ts">
  // The bar that stands while the archive is in select mode. The board's
  // own BoardSelectionBar cannot do this job: its one action is "Run
  // selected", and running a card the human archived is not a thing
  // anyone means -- so the kanban tab shows this one INSTEAD while the
  // archive is up, rather than stacking two bars in the same spot.
  //
  // It stays up with nothing picked, unlike the board's, because in a
  // MODE the bar is also the way out: a bar that vanished at zero would
  // leave the human in a grid whose clicks no longer open cards and no
  // visible way back.

  import { Trash2, CheckCheck, X } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { boardSelection, selectedCards } from "./boardSelection";
  import type { CardView } from "./planBoard";

  interface Props {
    /// The archived cards the grid is showing -- what "Select all"
    /// means, and the set the count is measured against.
    cards: CardView[];
    onSelectAll: () => void;
    onDelete: () => void;
    onExit: () => void;
  }
  let { cards, onSelectAll, onDelete, onExit }: Props = $props();

  // Intersected with what this grid renders, the way every selection
  // surface does it: the selection is app-wide, so a card picked on the
  // board behind the archive must not be counted here -- and must never
  // be swept up by a Delete aimed at archived cards.
  const picked = $derived(selectedCards(cards, $boardSelection));
  const allPicked = $derived(cards.length > 0 && picked.length === cards.length);

  // Esc leaves the mode rather than only clearing the picks: it is the
  // dismissal the rest of the app spells that way, and a mode that
  // swallowed Escape to empty a list would be the odd one out.
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="selection-bar" role="toolbar" aria-label="Archived cards to delete">
  <span class="count">
    {picked.length === 0 ? "Click cards to pick them" : `${picked.length} selected`}
  </span>
  <IconButton
    icon={CheckCheck}
    label="Select every card shown"
    text="Select all"
    variant="outlined"
    size={11}
    disabled={cards.length === 0 || allPicked}
    tip={allPicked
      ? "Every card shown is already picked"
      : `Pick all ${cards.length} ${cards.length === 1 ? "card" : "cards"} the archive is showing`}
    onclick={onSelectAll}
  />
  <IconButton
    icon={Trash2}
    label="Delete selected cards"
    text="Delete"
    tone="danger"
    variant="outlined"
    size={11}
    disabled={picked.length === 0}
    tip={picked.length === 0
      ? "Pick at least one card"
      : `Delete ${picked.length} ${picked.length === 1 ? "card" : "cards"} permanently — you'll be asked first`}
    onclick={onDelete}
  >
    <span class="pick-count">{picked.length}</span>
  </IconButton>
  <IconButton
    icon={X}
    label="Leave select mode"
    size={12}
    tip="Leave select mode (Esc)"
    onclick={onExit}
  />
</div>

<style>
  /* Same anchor as BoardSelectionBar's, deliberately: the two never show
     at once, and a bar that jumped when the archive opened would read as
     a different control. */
  .selection-bar {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    white-space: nowrap;
  }
  .count {
    color: var(--text-muted);
  }
  .pick-count {
    font-size: 0.75em;
    font-family: monospace;
  }
</style>
