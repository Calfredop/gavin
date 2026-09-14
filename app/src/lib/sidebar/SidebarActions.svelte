<script lang="ts">
  // The sidebar's own chrome: open a folder into the column, search it,
  // collapse / expand it. Drawn in the window's corner (TitleBar.svelte),
  // at the right of the strip -- the leftover between the platform's
  // controls and this group is the drag handle -- over the column all
  // three act on.
  //
  // They spent a while in the header row beside that corner, because the
  // corner was inside the sidebar's column and everything in it was a
  // floor under how narrow that column could collapse -- three buttons
  // and their gap were ~32px the icon rail could not shed. The corner is
  // out of the column's flow now and sized to `max(controls, rail)`, so
  // over an open column these cost nothing: they sit in the 124px the
  // traffic lights leave of a 200px top row.
  //
  // Collapsed, Open and Search stand down (a search box has nowhere to
  // go in a column of initials). The toggle stays: it is the way back
  // out, and it has to keep living next to the window controls -- not
  // as the rail's first row -- because a hover-peek redraws the full
  // column and would hide a rail-only button for as long as the pointer
  // stays on it. The corner widens by one IconButton for it
  // (--window-corner-min on .app.sidebar-collapsed).
  import IconButton from "$lib/ui/IconButton.svelte";
  import { PanelLeftClose, PanelLeftOpen, Search, FolderOpen } from "@lucide/svelte";
  import { sidebarCollapsed, toggleSidebarCollapsed } from "$lib/sidebar/sidebarPrefs";
  import { sidebarSearchOpen, toggleSidebarSearch } from "$lib/sidebar/sidebarSearch";
  import { openWorkspaceFolder } from "$lib/workspace/workspaceOpen";
  import { layoutState } from "$lib/core/layoutState";

  // Keyed off the preference rather than off sidebarShowsRail: a peek is
  // the collapsed column borrowing its full width for a glance. Open /
  // Search must not flicker into the corner as the pointer passes -- the
  // peek ends the moment the pointer leaves the column to reach for
  // them. The toggle is the exception: it stays put at both widths so
  // there is always a way back without chasing a disappearing row.
  const collapsed = $derived($sidebarCollapsed);

  // The two that act on the workspace list, which does not exist until
  // the layout is ready. A window that cannot reach its daemon still
  // draws this corner, so these must not pretend the list is there.
  const ready = $derived($layoutState.status === "ready");
</script>

<div class="sidebar-actions">
  {#if !collapsed && ready}
    <IconButton
      icon={FolderOpen}
      label="Open workspace…"
      size={14}
      onclick={() => void openWorkspaceFolder()}
    />
    <IconButton
      icon={Search}
      label="Search workspaces, pages and sessions"
      size={14}
      active={$sidebarSearchOpen}
      onclick={toggleSidebarSearch}
    />
  {/if}
  <IconButton
    icon={collapsed ? PanelLeftOpen : PanelLeftClose}
    label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    size={14}
    onclick={toggleSidebarCollapsed}
  />
</div>

<style>
  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    /* Off the drag spacer, so a grab that ends at this group does not
       land on the first button. The two groups already sit at opposite
       ends of the strip; this is only a hit-target gap. */
    padding-left: 4px;
  }
</style>
