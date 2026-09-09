<script lang="ts">
  // The archive's Delete dropdown. A thin template over archiveDelete.ts,
  // opened over the app's one context-menu layer -- the same shape
  // NewPageButton has, and for the same reasons: viewport clamping,
  // Escape and click-away are solved once, and a dropdown that is also a
  // right-click menu everywhere else reads as one control.
  //
  // The button lives beside the archive toggle rather than inside the
  // grid: it acts on the whole archive, and a control that scrolls away
  // with the cards it can delete is one the human has to hunt for at
  // exactly the wrong moment.

  import { get } from "svelte/store";
  import { Trash2, ChevronDown } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { contextMenu, openMenuUnder, type ContextMenuEntry } from "$lib/core/contextMenu";
  import { tooltip } from "$lib/core/tooltip";
  import {
    ARCHIVE_DELETE_TITLE,
    archiveDeleteEntries,
    type AgeBucket,
  } from "$lib/files/archiveDelete";
  import type { CardView } from "$lib/core/planBoard";

  interface Props {
    /// The archived cards the grid is showing. What the age rows measure
    /// -- which is why they are dark while `filtered` is true.
    cards: CardView[];
    /// True when ANY lens is narrowing the archive -- the search box or
    /// one of the three facets. Both, because the two hide cards the
    /// same way and an age sweep must never take one the human cannot
    /// see; the caller composes them, since only it can tell a facet
    /// that hides nothing from one that hides everything.
    filtered: boolean;
    selectMode: boolean;
    selectedCount: number;
    /// Null when the archive is usable; otherwise why it is not.
    blocked?: string | null;
    onEnterSelectMode: () => void;
    onLeaveSelectMode: () => void;
    onDeleteSelected: () => void;
    onDeleteBucket: (bucket: AgeBucket, cards: CardView[]) => void;
  }
  let {
    cards,
    filtered,
    selectMode,
    selectedCount,
    blocked = null,
    onEnterSelectMode,
    onLeaveSelectMode,
    onDeleteSelected,
    onDeleteBucket,
  }: Props = $props();

  // The shared menu layer closes on any pointerdown outside itself, and
  // that lands before this button's click -- so without this the button
  // that opened the menu could never close it. Same guard, same reason,
  // as NewPageButton's.
  let dismissedMenu = false;

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  function entries(): ContextMenuEntry[] {
    // Built at OPEN time, not derived: `Date.now()` is the one input
    // here that is never a store, and a menu whose counts were computed
    // on mount would age silently in a tab left open.
    return archiveDeleteEntries(cards, Date.now(), {
      selectMode,
      selectedCount,
      filtered,
      onEnterSelectMode,
      onLeaveSelectMode,
      onDeleteSelected,
      onDeleteBucket,
    });
  }

  function openMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    openMenuUnder(event.currentTarget as HTMLElement, entries());
  }

  const disabled = $derived(blocked !== null || (cards.length === 0 && !filtered));

  const tip = $derived(
    blocked ??
      (cards.length === 0 && !filtered
        ? "Nothing archived to delete"
        : `${ARCHIVE_DELETE_TITLE} — pick cards, or sweep everything past an age`)
  );
</script>

<!-- The tooltip hangs on the WRAPPER while the button is dark:
     tooltip.ts binds mouseenter, which a disabled element never fires,
     so a reason left on the button itself would be unreadable exactly
     when it is the only thing worth reading. The enabled button keeps
     its own.

     Still openable with nothing shown WHILE filtered: the menu is where
     that reason lives, and a dark button could not say it. -->
<span class="archive-delete-wrap" use:tooltip={disabled ? tip : ""}>
  <IconButton
    icon={Trash2}
    label={ARCHIVE_DELETE_TITLE}
    variant="outlined"
    tone="danger"
    size={12}
    active={selectMode}
    class="archive-delete"
    {disabled}
    tip={disabled ? null : tip}
    onpointerdown={onPointerDown}
    onclick={openMenu}
  >
    <ChevronDown size={11} />
  </IconButton>
</span>

<style>
  /* Inline-flex, not the default inline: the wrapper exists only to
     carry the tooltip, and must measure exactly like the button. */
  .archive-delete-wrap {
    display: inline-flex;
    flex: 0 0 auto;
  }
</style>
