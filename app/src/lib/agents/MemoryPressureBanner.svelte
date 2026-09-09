<script lang="ts">
  // The machine is at critical pressure and gavin is holding new
  // launches. Same idiom as DaemonRequestErrorBanner beside it -- an
  // inline status bar, never an overlay -- because the app behind it
  // still works, and the one thing it must not do is take over the
  // window at the moment the human most needs to reach a tab.
  //
  // Nothing here kills an agent mid-turn, and no button here ends
  // anything without asking. A hold gates starts, exactly as the token
  // pause does. The three actions are the three things the human can do
  // that the wall will not do for them unasked: look at what is holding
  // the memory, close tabs that are not doing anything, and close the
  // idle agents of cards that are already done. The last of those the
  // wall DOES do by itself under pressure when the setting allows it
  // (doneSessionReclaimState.ts), and the second clause of the line
  // says so when it has.
  import { MemoryStick } from "@lucide/svelte";
  import { get } from "svelte/store";
  import { pressureBannerLine } from "$lib/agents/memory";
  import { fleetMemory, memoryPressure, systemMemory } from "$lib/agents/memoryState";
  import { showAppPanel } from "$lib/panes/appPanels";
  import { layoutState } from "$lib/core/layoutState";
  import { askConfirm } from "$lib/core/dialog";
  import { closeIdlePrompt, idleTabsOnPage } from "$lib/panes/idleTabs";
  import { closeTabsNow } from "$lib/panes/tabActions";
  import { reclaimNowLabel, reclaimedClause } from "$lib/sessions/doneSessionReclaim";
  import { reclaimDoneSessionsNow, reclaimLog, reclaimableNow } from "$lib/sessions/doneSessionReclaimState";

  const line = $derived(
    pressureBannerLine({
      pressure: $memoryPressure,
      agents: $fleetMemory.agents,
      agentBytes: $fleetMemory.rssBytes,
    })
  );

  /// What the wall closed lately.
  const reclaimed = $derived.by(() => {
    // Read for its timing only: the poller replaces the sample every few
    // seconds, which is what lets the ten-minute window expire without a
    // timer of this component's own.
    void $systemMemory;
    return reclaimedClause($reclaimLog, Date.now());
  });

  /// The manual close, present only while there is something it would
  /// close (reclaimNowLabel is null otherwise).
  const reclaimLabel = $derived(reclaimNowLabel($reclaimableNow));

  /// The active page's idle tabs, which is the set the sidebar's own
  /// "Close Idle Tabs" acts on. The same split and the same prompt: two
  /// vocabularies for one action is two things to keep true.
  function activePageIdle() {
    const state = get(layoutState);
    const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    const page = workspace?.pages.find((p) => p.id === workspace.activePageId);
    if (!page) return null;
    const idle = idleTabsOnPage(page, {
      sessionStatusById: state.sessionStatusById,
      fileTabsById: state.fileTabsById,
      boardTabsById: state.boardTabsById,
      cardTabsById: state.cardTabsById,
    });
    return idle.ids.length > 0 ? { page, idle } : null;
  }

  async function closeIdle(): Promise<void> {
    const target = activePageIdle();
    if (!target) return;
    // Asked through dialog.ts, never a native confirm: the capability
    // list is narrowed to `dialog:allow-open`, and the button names its
    // own action rather than saying OK.
    const prompt = closeIdlePrompt(target.page, target.idle);
    if (!(await askConfirm({ ...prompt, danger: true }))) return;
    await closeTabsNow(target.idle.ids);
  }
</script>

{#if line}
  <div class="banner" role="status">
    <MemoryStick size={14} />
    <span class="text">{line}{#if reclaimed}{" "}{reclaimed}{/if}</span>
    <button type="button" class="action" onclick={() => showAppPanel("sessions", "memory")}>
      Open sessions
    </button>
    <button type="button" class="action" onclick={() => void closeIdle()}>Close idle tabs</button>
    {#if reclaimLabel}
      <button type="button" class="action" onclick={() => void reclaimDoneSessionsNow()}>
        {reclaimLabel}
      </button>
    {/if}
  </div>
{/if}

<style>
  /* The danger surface, not the warning one DaemonRequestErrorBanner
     uses: a refused request is one thing that failed, and this is the
     machine about to swap. */
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    flex: 0 0 auto;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 12px;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    flex: 0 0 auto;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    font-size: 12px;
    cursor: pointer;
  }
</style>
