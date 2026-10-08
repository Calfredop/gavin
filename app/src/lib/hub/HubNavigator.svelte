<script lang="ts">
  import { tabStripHubViews, type HubView } from "$lib/hub/workspaceViews";
  import { hubNavigatorLabel, hubNavigatorViewIds } from "$lib/hub/hubNavigator";
  import {
    hubTabOrderByWorkspace,
    hubTabPrefsFor,
    hubTabsHiddenByWorkspace,
    hubTabsHiddenDefault,
  } from "$lib/hub/hubTabPrefs";
  import { X } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";

  interface Props {
    workspaceId: string;
    /// The section currently shown over the page, if any.
    open: string | null;
    onselect: (id: string) => void;
    hasRoot: boolean;
    /// The agent file's name (CLAUDE.md, AGENTS.md…), which is what the
    /// hub's own tab for it is called.
    agentFileName: string;
  }

  let { workspaceId, open, onselect, hasRoot, agentFileName }: Props = $props();

  const prefs = $derived(
    hubTabPrefsFor(workspaceId, $hubTabOrderByWorkspace, $hubTabsHiddenByWorkspace, $hubTabsHiddenDefault)
  );
  // Resolved through the same two lists the hub's row uses, so a tab
  // hidden or dragged there is hidden or dragged here.
  const views = $derived.by(() => {
    const byId = new Map<string, HubView>(
      tabStripHubViews(hasRoot, prefs).map((v) => [v.id, v])
    );
    return hubNavigatorViewIds(hasRoot, prefs)
      .map((id) => byId.get(id))
      .filter((v): v is HubView => v !== undefined);
  });
</script>

<!-- A column beside a page, not a row above it: the page's own tab bar
     already owns the top edge. Square buttons, icon only -- the tooltip
     (IconButton's label) carries the name. -->
<nav class="hub-navigator" aria-label="Hub sections">
  {#each views as view (view.id)}
    <IconButton
      icon={view.icon}
      label={hubNavigatorLabel(view, agentFileName)}
      size={16}
      class="hub-navigator-button"
      active={open === view.id}
      onclick={() => onselect(view.id)}
    >
      {#if open === view.id}
        <!-- Says what pressing it again does. -->
        <span class="close-badge" aria-hidden="true"><X size={8} strokeWidth={3} /></span>
      {/if}
    </IconButton>
  {/each}
</nav>

<style>
  .hub-navigator {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    box-sizing: border-box;
    overflow-y: auto;
    background: var(--surface-base);
    border-right: 1px solid var(--border);
  }
  .hub-navigator :global(.hub-navigator-button) {
    width: 28px;
    height: 28px;
    padding: 0;
  }
  /* The workspace's own colour marks the open section. */
  .hub-navigator :global(.hub-navigator-button.active) {
    color: var(--ws-accent, var(--text));
    background: color-mix(in srgb, var(--ws-accent, var(--text)) 16%, transparent);
    border-color: color-mix(in srgb, var(--ws-accent, var(--text)) 45%, transparent);
  }
  .close-badge {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--surface-base);
    background: var(--ws-accent, var(--text-muted));
  }
</style>
