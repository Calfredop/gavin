<script lang="ts">
  // The activity calendar on the phone: one workspace's, as its Activity
  // surface, or every workspace's, as a block under the workspace list.
  // The desk's own component and modules (`$lib/activity/`), opened at
  // Month -- a year scaled to a phone's width is an overview, not a place
  // to start -- with a Year day tapped opening its month, and every jump
  // the phone's own.
  import type { Workspace } from "$lib/core/workspace";
  import ActivityCalendar from "$lib/activity/ActivityCalendar.svelte";
  import { openCard, openWorkspace, showSurface } from "$companion/state/workstation";

  interface Props {
    /// The open workspace; absent at the workspace list, for all of them.
    workspace?: Workspace | null;
  }
  let { workspace = null }: Props = $props();

  function openCardOf(workspaceId: string, path: string): void {
    if (workspace?.id !== workspaceId) openWorkspace(workspaceId);
    openCard(path);
  }

  function openToolsOf(workspaceId: string): void {
    if (workspace?.id !== workspaceId) openWorkspace(workspaceId);
    showSurface("tools");
  }
</script>

<section class="activity" class:block={workspace === null} aria-label="Activity">
  {#if workspace === null}
    <h2>Activity</h2>
  {/if}
  <ActivityCalendar
    workspaceId={workspace?.id ?? null}
    openAt="month"
    yearCellZoom="month"
    onOpenCard={openCardOf}
    onOpenTool={openToolsOf}
  />
</section>

<style>
  .activity {
    padding: 12px 16px;
  }
  .block {
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 4px 0 10px;
    color: var(--text-subtle);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
