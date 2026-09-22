<script lang="ts">
  // The top bar's "next" button: the sessions in the active workspace
  // that are waiting on a human, one pick away from anywhere in it. It
  // sits just before New page and is built the way New page is -- an
  // icon and a chevron over the shared menu layer, bound to the active
  // workspace and disabled without one -- on both rows that can be the
  // window's top edge (the hub tab row, and the actions row of a terminal
  // page). nextWaiting.ts holds the menu; this is the template and the
  // jump.
  import { get } from "svelte/store";
  import { SkipForward, ChevronDown } from "@lucide/svelte";
  import { layoutState, attentionState } from "$lib/core/layoutState";
  import { getActiveTree, getActiveView, getActiveWorkspace } from "$lib/core/workspace";
  import { kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
  import { attentionInbox, type AttentionInboxInput } from "$lib/agents/attentionInbox";
  import {
    NEXT_WAITING_LABEL,
    nextWaitingEntries,
    nextWaitingTip,
    sessionOnScreen,
    workspaceWaiting,
  } from "$lib/agents/nextWaiting";
  import { contextMenu, openMenuUnder } from "$lib/core/contextMenu";
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
  const tip = $derived(nextWaitingTip(activeWorkspace, rows));

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
    if (!ws) return;
    const current = sessionOnScreen(ws, getActiveView(ws), getActiveTree(state), state.focusedSessionId);
    openMenuUnder(
      event.currentTarget as HTMLElement,
      nextWaitingEntries(
        workspaceWaiting(attentionInbox(input, Date.now()), ws.id),
        current,
        (row) => void revealWaitingSession(row)
      )
    );
  }
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
