<script lang="ts">
  // The machine is at critical pressure and gavin is holding new
  // launches. Same idiom as DaemonRequestErrorBanner beside it -- an
  // inline status bar, never an overlay -- because the app behind it
  // still works, and the one thing it must not do is take over the
  // window at the moment the human most needs to reach a tab.
  //
  // It NEVER kills anything, and neither does either button. Gavin does
  // not stop an agent it started; a hold gates starts, exactly as the
  // token pause does. The two actions are the two things the human can
  // do that gavin will not do for them: look at what is holding the
  // memory, and close tabs that are not doing anything.
  import { MemoryStick } from "@lucide/svelte";
  import { get } from "svelte/store";
  import { pressureBannerLine } from "./memory";
  import { fleetMemory, memoryPressure } from "./memoryState";
  import { showAppPanel } from "./appPanels";
  import { layoutState } from "./layoutState";
  import { askConfirm } from "./dialog";
  import { closeIdlePrompt, idleTabsOnPage } from "./idleTabs";
  import { closeTabsNow } from "./tabActions";

  const line = $derived(
    pressureBannerLine({
      pressure: $memoryPressure,
      agents: $fleetMemory.agents,
      agentBytes: $fleetMemory.rssBytes,
    })
  );

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
    <span class="text">{line}</span>
    <button type="button" class="action" onclick={() => showAppPanel("sessions", "memory")}>
      Open sessions
    </button>
    <button type="button" class="action" onclick={() => void closeIdle()}>Close idle tabs</button>
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
