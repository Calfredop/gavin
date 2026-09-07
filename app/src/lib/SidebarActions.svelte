<script lang="ts">
  // The sidebar's own chrome — collapse the column, search it, open a
  // folder into it — drawn at the head of whichever header row is the
  // top edge of the window (the hub tabs, a page's session tabs, or the
  // app hub's own strip).
  //
  // They used to sit in the strip over the sidebar, beside the traffic
  // lights, and that is exactly what made "collapsed" only a little
  // narrower than "open": the strip is inside the sidebar's column, so
  // its content sets the floor for how narrow that column can get. Three
  // buttons and their gap are ~32px the icon rail could not shed. Over
  // here they cost the column nothing, and what is left in the strip is
  // the window controls — the platform's width, and the real floor.
  //
  // One instance per window, at the window's top-left corner after the
  // controls: +page.svelte draws it on every headed branch and on a
  // strip of its own for the ones with no header, and Pane.svelte draws
  // it on the pane that LEADS the page (layout.ts's paneLeadsWindow) so
  // that on a split page it is still in the corner rather than wherever
  // the keyboard happens to be.
  import IconButton from "./ui/IconButton.svelte";
  import { PanelLeftClose, PanelLeftOpen, Search, FolderOpen } from "@lucide/svelte";
  import { sidebarCollapsed, toggleSidebarCollapsed } from "./sidebarPrefs";
  import { peekSidebar } from "./sidebarPeek";
  import { sidebarSearchOpen, toggleSidebarSearch } from "./sidebarSearch";
  import { openWorkspaceFolder } from "./workspaceOpen";
  import { layoutState } from "./layoutState";

  // The collapse toggle is window chrome and always applies; the other
  // two act on the workspace list, which does not exist until the layout
  // is ready. A window that cannot reach its daemon still draws this row
  // (it is where the collapse toggle lives now), so these two must not
  // pretend the list is there.
  const ready = $derived($layoutState.status === "ready");

  /// Searching a column that is showing initials would put the search
  /// box in a rail with no room for it, so the search opens the peek
  /// first: same sidebar, floated over the view, closed again the moment
  /// the pointer leaves it. The collapse PREFERENCE is untouched — this
  /// is a glance, not a change of mind.
  function search(): void {
    if ($sidebarCollapsed) peekSidebar();
    toggleSidebarSearch();
  }
</script>

<div class="sidebar-actions">
  <IconButton
    icon={$sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
    label={$sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
    size={14}
    onclick={toggleSidebarCollapsed}
  />
  {#if ready}
    <IconButton
      icon={Search}
      label="Search workspaces, pages and sessions"
      size={14}
      active={$sidebarSearchOpen}
      onclick={search}
    />
    <IconButton
      icon={FolderOpen}
      label="Open workspace…"
      size={14}
      onclick={() => void openWorkspaceFolder()}
    />
  {/if}
</div>

<style>
  /* Centred inside the row's padded box, exactly like the actions at the
     other end of it: the top pad belongs to the tab indicator, and these
     buttons line up with the tabs they lead rather than with the traffic
     lights in the column beside them. That seam is where it has always
     been -- the strip over the sidebar has no top pad and never did. */
  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    padding-right: 4px;
  }
</style>
