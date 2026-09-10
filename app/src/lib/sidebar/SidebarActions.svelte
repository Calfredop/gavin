<script lang="ts">
  // The sidebar's own chrome: collapse the column, search it, open a
  // folder into it. Drawn in the window's corner (TitleBar.svelte),
  // after the platform's controls and over the column all three act on.
  //
  // They spent a while in the header row beside that corner, because the
  // corner was inside the sidebar's column and everything in it was a
  // floor under how narrow that column could collapse -- three buttons
  // and their gap were ~32px the icon rail could not shed. The corner is
  // out of the column's flow now and sized to `max(controls, rail)`, so
  // over an open column these cost nothing: they sit in the 124px the
  // traffic lights leave of a 200px top row.
  //
  // Collapsed, they stand down entirely. There is no room for them over
  // a 36px rail, a search box has nowhere to go in a column showing
  // initials, and the one button that must survive -- the way back out
  // -- becomes the rail's own first row instead (Sidebar.svelte's
  // .rail-chrome), where it costs exactly what a workspace row costs.
  import IconButton from "$lib/ui/IconButton.svelte";
  import { PanelLeftClose, Search, FolderOpen } from "@lucide/svelte";
  import { sidebarCollapsed, toggleSidebarCollapsed } from "$lib/sidebar/sidebarPrefs";
  import { sidebarSearchOpen, toggleSidebarSearch } from "$lib/sidebar/sidebarSearch";
  import { openWorkspaceFolder } from "$lib/workspace/workspaceOpen";
  import { layoutState } from "$lib/core/layoutState";

  // Keyed off the preference rather than off sidebarShowsRail: a peek is
  // the collapsed column borrowing its full width for a glance, and
  // three buttons appearing in the corner as the pointer passes would be
  // a flicker rather than an offer -- the peek ends the moment the
  // pointer leaves the column to reach for them.
  const collapsed = $derived($sidebarCollapsed);

  // The two that act on the workspace list, which does not exist until
  // the layout is ready. A window that cannot reach its daemon still
  // draws this corner, so these must not pretend the list is there.
  const ready = $derived($layoutState.status === "ready");
</script>

{#if !collapsed}
  <div class="sidebar-actions">
    <IconButton
      icon={PanelLeftClose}
      label="Collapse sidebar"
      size={14}
      onclick={toggleSidebarCollapsed}
    />
    {#if ready}
      <IconButton
        icon={Search}
        label="Search workspaces, pages and sessions"
        size={14}
        active={$sidebarSearchOpen}
        onclick={toggleSidebarSearch}
      />
      <IconButton
        icon={FolderOpen}
        label="Open workspace…"
        size={14}
        onclick={() => void openWorkspaceFolder()}
      />
    {/if}
  </div>
{/if}

<style>
  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    /* Off the traffic lights, which end at their own 12px pad: the two
       groups act on different things and should not read as one row of
       six. */
    padding-left: 4px;
  }
</style>
