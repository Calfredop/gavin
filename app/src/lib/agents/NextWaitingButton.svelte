<script lang="ts">
  // The top bar's "next" button: every session waiting on a human, one
  // pick away from anywhere in the app. It sits just before New page and
  // is built the way New page is -- an icon and a chevron over the shared
  // menu layer -- on both rows that can be the window's top edge (the hub
  // tab row, and the actions row of a terminal page). nextWaiting.ts
  // holds the menu; this is the template and the jump.
  import { get } from "svelte/store";
  import { SkipForward, ChevronDown } from "@lucide/svelte";
  import { layoutState, attentionState } from "$lib/core/layoutState";
  import { getActiveTree, getActiveView, getActiveWorkspace } from "$lib/core/workspace";
  import { kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
  import { attentionInbox, type AttentionInboxInput } from "$lib/agents/attentionInbox";
  import {
    ALL_CLEAR_TIP,
    NEXT_WAITING_LABEL,
    nextWaitingEntries,
    nextWaitingTip,
    sessionOnScreen,
  } from "$lib/agents/nextWaiting";
  import { contextMenu, openMenuUnder } from "$lib/core/contextMenu";
  import { revealWaitingSession } from "$lib/cards/cardRunActions";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/core/tooltip";

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

  // What the button itself needs: whether anything is waiting, and how
  // much. Neither depends on the clock, so this is not ticked -- the
  // waits a row shows are re-read when the menu opens.
  const rows = $derived(attentionInbox(input, Date.now()));
  const allClear = $derived(rows.length === 0);

  // NewPageButton's guard, for NewPageButton's reason: the menu layer
  // closes on any pointerdown outside itself, before this button's click
  // lands, so the click only opens when no menu was already up.
  let dismissedMenu = false;

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  function openMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    const state = get(layoutState);
    const ws = getActiveWorkspace(state);
    const current = sessionOnScreen(
      ws,
      ws ? getActiveView(ws) : "terminal",
      getActiveTree(state),
      state.focusedSessionId
    );
    openMenuUnder(
      event.currentTarget as HTMLElement,
      nextWaitingEntries(attentionInbox(input, Date.now()), current, (row) => void revealWaitingSession(row))
    );
  }
</script>

<!-- The all-clear bubble hangs on the wrapper, not the button: a
     disabled element fires no mouseenter, so the reason it is disabled
     would never be readable from the button itself. -->
<span class="next-waiting" use:tooltip={allClear ? ALL_CLEAR_TIP : ""}>
  <!-- Amber while something waits: the "wants a human" family (a tab's
       question badge, a rail's "needs you", the hub's pip) already
       speaks in the warning tone. -->
  <IconButton
    icon={SkipForward}
    label={NEXT_WAITING_LABEL}
    tip={nextWaitingTip(rows)}
    tone={allClear ? "default" : "warning"}
    size={14}
    disabled={allClear}
    onpointerdown={onPointerDown}
    onclick={openMenu}
  >
    <ChevronDown size={12} />
  </IconButton>
</span>

<style>
  /* Inline-flex, not the default inline: the wrapper exists only to
     carry the tooltip, and must measure exactly like the button. */
  .next-waiting {
    display: inline-flex;
  }
</style>
