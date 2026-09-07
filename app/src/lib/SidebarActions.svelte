<script lang="ts">
  // The head of whichever header row is the top edge of the window (the
  // hub tabs, a page's session tabs, or the app hub's own strip): the
  // room the window's corner needs, and — while the sidebar is open —
  // the sidebar's own chrome, search it and open a folder into it.
  //
  // Those buttons used to sit in the strip over the sidebar, beside the
  // traffic lights, and that is exactly what made "collapsed" only a
  // little narrower than "open": the strip is inside the sidebar's
  // column, so its content sets the floor for how narrow that column can
  // get. Three buttons and their gap are ~32px the icon rail could not
  // shed. Over here they cost the column nothing.
  //
  // One instance per window, at the window's top-left corner after the
  // controls: +page.svelte draws it on every headed branch and on a
  // strip of its own for the ones with no header, and Pane.svelte draws
  // it on the pane that LEADS the page (layout.ts's paneLeadsWindow) so
  // that on a split page it is still in the corner rather than wherever
  // the keyboard happens to be.
  import IconButton from "./ui/IconButton.svelte";
  import { PanelLeftClose, Search, FolderOpen } from "@lucide/svelte";
  import { sidebarCollapsed, toggleSidebarCollapsed } from "./sidebarPrefs";
  import { sidebarSearchOpen, toggleSidebarSearch } from "./sidebarSearch";
  import { openWorkspaceFolder } from "./workspaceOpen";
  import { layoutState } from "./layoutState";

  // Collapsed, this row draws nothing but the corner's room. The way
  // back out of the rail is a row IN the rail then (Sidebar.svelte),
  // where it costs the same width the workspaces below it already cost;
  // the other two act on a column that is showing initials, and a search
  // box has nowhere to go in one. Keyed off the preference rather than
  // off sidebarShowsRail, so a peek -- which the pointer cannot leave
  // for this row without ending it -- does not flicker three buttons
  // into the corner on its way past.
  const collapsed = $derived($sidebarCollapsed);

  // The two that act on the workspace list, which does not exist until
  // the layout is ready. A window that cannot reach its daemon still
  // draws this row, so these must not pretend the list is there.
  const ready = $derived($layoutState.status === "ready");
</script>

<div class="sidebar-actions">
  <!-- What the window's corner overhangs the rail by. The corner is
       positioned over the rail's top-left (TitleBar.svelte) and is as
       wide as the platform's controls; the rail under it is as narrow as
       its own rows. Whatever the corner has left over hangs into THIS
       row, and this is the box that keeps the row's first item out from
       under it. Zero whenever the rail is the wider of the two, which is
       the whole of the open state. -->
  <div class="corner-overhang"></div>
  {#if !collapsed}
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
    <!-- The rule belongs to the chrome, not to the row: with the rail
         collapsed there is no chrome here, and a rule on its own would
         read as the first tab's left edge. -->
    <span class="divider"></span>
  {/if}
</div>

<style>
  /* Centred inside the row's padded box, exactly like the actions at the
     other end of it: the top pad belongs to the tab indicator, and these
     buttons line up with the tabs they lead rather than with the traffic
     lights in the corner beside them. */
  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }
  .corner-overhang {
    flex: 0 0 auto;
    width: max(0px, calc(var(--window-corner-width) - var(--rail-width)));
  }
  /* The same rule both header rows draw between their own groups of
     actions -- same height, same colour, same margin -- because it is
     doing the same job at the other end of the bar. */
  .divider {
    width: 1px;
    align-self: center;
    height: var(--tab-divider);
    margin: 0 3px 0 5px;
    background: var(--border);
  }
</style>
