<script lang="ts">
  // The top bar's "next" button: the sessions in the active workspace
  // that are waiting on a human, one click away from anywhere in it. It
  // sits just before New page, bound to the active workspace and disabled
  // without one as New page is, on both rows that can be the window's
  // top edge (the hub tab row, and the actions row of a terminal page).
  //
  // Split in two: the icon jumps straight to the next waiting session,
  // and the chevron opens the list over the shared menu layer, the way
  // New page's does. nextWaiting.ts decides the target and builds the
  // menu; this is the template and the jumps.
  import { get } from "svelte/store";
  import { SkipForward, ChevronDown } from "@lucide/svelte";
  import { layoutState, attentionState } from "$lib/core/layoutState";
  import { getActiveTree, getActiveView, getActiveWorkspace } from "$lib/core/workspace";
  import { kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
  import { attentionInbox, type AttentionInboxInput, type AttentionRow } from "$lib/agents/attentionInbox";
  import {
    NEXT_WAITING_LABEL,
    WAITING_LIST_LABEL,
    nextWaitingEntries,
    nextWaitingTarget,
    nextWaitingTip,
    sessionOnScreen,
    workspaceWaiting,
  } from "$lib/agents/nextWaiting";
  import {
    closeContextMenu,
    contextMenu,
    openMenuUnder,
    setContextMenuEntries,
    type ContextMenuEntry,
  } from "$lib/core/contextMenu";
  import { revealWaitingSession } from "$lib/cards/cardRunActions";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/core/tooltip";

  const activeWorkspace = $derived(getActiveWorkspace($layoutState));

  // The hub inbox's own input, from the same stores. `attentionState`
  // rather than `layoutState` for the hub's reason: a wait the human has
  // marked as read is no longer a reason to come and look, so it leaves
  // this menu at the moment it leaves the hub's list.
  const input: AttentionInboxInput = $derived({
    state: $attentionState,
    boards: $kanbanState,
    trees: $gavinTrees,
    orchestrations: $orchestrations,
    stepAttentions: $stepAttentionsByWorkspace,
  });

  // What the button itself needs: whether anything in this workspace is
  // waiting, and how much. Neither depends on the clock, so this is not
  // ticked -- the waits a row shows are re-read when the menu opens.
  const rows = $derived(workspaceWaiting(attentionInbox(input, Date.now()), activeWorkspace?.id ?? null));
  const blocked = $derived(rows.length === 0);

  // Where the human stands, which is what "next" is counted from.
  const current = $derived(
    activeWorkspace
      ? sessionOnScreen(
          activeWorkspace,
          getActiveView(activeWorkspace),
          getActiveTree($layoutState),
          $layoutState.focusedSessionId
        )
      : null
  );
  const tip = $derived(nextWaitingTip(activeWorkspace, rows, current));

  // Read at the click rather than kept in a derived: the list and the
  // place the human stands are both live stores, and the jump has to go
  // where the bubble said a moment ago.
  function jumpNext(): void {
    const target = nextWaitingTarget(rows, current);
    if (target) void revealWaitingSession(target);
  }

  // NewPageButton's guard, for NewPageButton's reason: the menu layer
  // closes on any pointerdown outside itself, before the chevron's click
  // lands, so the click only opens when no menu was already up.
  let dismissedMenu = false;

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  // The entries this button last put on screen. A plain `let`, never
  // $state: it is compared by identity against the menu store's own
  // array (a writable, so no proxy stands between them), and writing it
  // inside the effect below must not re-run that effect.
  let published: ContextMenuEntry[] | null = null;

  function entriesFor(list: AttentionRow[]): ContextMenuEntry[] {
    return nextWaitingEntries(list, current, (row) => void revealWaitingSession(row));
  }

  function openMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    const ws = getActiveWorkspace(get(layoutState));
    if (!ws) return;
    // Re-read with a fresh clock: the rows above are only as new as the
    // last store change, and the menu shows how long each has waited.
    published = entriesFor(workspaceWaiting(attentionInbox(input, Date.now()), ws.id));
    openMenuUnder(event.currentTarget as HTMLElement, published);
  }

  // The open list follows the fleet. A session that answers, fails or
  // starts waiting while the menu is up changes `rows`, and the menu is
  // re-published in place rather than left showing a snapshot -- a row
  // for a question already answered is a jump to nothing. The "you are
  // here" dot moves the same way. Only while the menu on screen is still
  // THIS button's: any other menu, or none, and the list is let go. With
  // nothing left waiting the menu closes, as the button disables.
  $effect(() => {
    const list = rows;
    void current;
    if (published === null) return;
    if (get(contextMenu)?.entries !== published) {
      published = null;
      return;
    }
    if (list.length === 0) {
      published = null;
      closeContextMenu();
      return;
    }
    published = entriesFor(list);
    setContextMenuEntries(published);
  });
</script>

<!-- The bubble hangs on the wrapper while disabled, not on the button: a
     disabled element fires no mouseenter, so the reason it is disabled
     would never be readable from the button itself. -->
<span class="next-waiting" use:tooltip={blocked ? tip : ""}>
  <!-- Amber while something waits: the "wants a human" family (a tab's
       question badge, a rail's "needs you", the hub's pip) already
       speaks in the warning tone. -->
  <IconButton
    icon={SkipForward}
    label={NEXT_WAITING_LABEL}
    {tip}
    tone={blocked ? "default" : "warning"}
    size={14}
    disabled={blocked}
    class="next-jump"
    onclick={jumpNext}
  />
  <IconButton
    icon={ChevronDown}
    label={WAITING_LIST_LABEL}
    tone={blocked ? "default" : "warning"}
    size={12}
    disabled={blocked}
    class="next-list"
    onpointerdown={onPointerDown}
    onclick={openMenu}
  />
</span>

<style>
  /* Inline-flex, not the default inline: the wrapper carries the
     disabled bubble and holds the two halves together, and must measure
     exactly like them. */
  .next-waiting {
    display: inline-flex;
    align-items: center;
  }
  /* The halves sit flush, the chevron narrower than the icon: one
     control with two targets, not two buttons side by side. Each still
     lights its own hover, which is what says which half a click hits. */
  .next-waiting :global(.next-jump) {
    padding-right: 3px;
  }
  .next-waiting :global(.next-list) {
    padding-left: 1px;
    padding-right: 2px;
  }
</style>
