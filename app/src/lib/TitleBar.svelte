<script lang="ts">
  // What is left of the title bar: the window's controls, somewhere to
  // grab it, and the sidebar's own chrome actions. It used to span the
  // window and carry the pane controls and the "New page" button as
  // well; both of those moved to the bar that is now the app's top edge
  // (Pane.svelte's tab row, and the hub tab row in +page.svelte), and the
  // strip came down to the width of the sidebar it sits over -- which is
  // what lets the hub and the page reach the top of the window at all.
  //
  // Its height is the shared header height, so the sidebar's first row
  // starts on the same line as the view beside it.
  //
  // The three actions on the far side from the window controls act on
  // the COLUMN, not on any workspace: collapse it, search it, open a
  // folder into it. They sit here rather than in a header row of their
  // own because this strip is already the sidebar's first row -- a
  // second row of buttons under it would cost the workspace list a row
  // of height to say nothing new.
  import WindowControls from "./WindowControls.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { PanelLeftClose, PanelLeftOpen, Search, FolderOpen } from "@lucide/svelte";
  import { isMacSync } from "./platform";
  import { windowDrag } from "./windowDrag";
  import { sidebarCollapsed, toggleSidebarCollapsed } from "./sidebarPrefs";
  import { sidebarSearchOpen, toggleSidebarSearch } from "./sidebarSearch";
  import { openWorkspaceFolder } from "./workspaceOpen";
  import { layoutState } from "./layoutState";

  // Synchronous: the traffic lights must be on the correct side in the
  // first frame, and plugin-os's platform() is a plain global read.
  const macOS = isMacSync();

  // The collapse toggle is window chrome and always applies; the other
  // two act on the workspace list, which does not exist until the layout
  // is ready. This strip is deliberately rendered ahead of that check
  // (+page.svelte) so a window that cannot reach its daemon is still
  // movable and closable -- these two must not pretend otherwise.
  const ready = $derived($layoutState.status === "ready");
</script>

{#snippet actions()}
  <div class="bar-actions">
    <IconButton
      icon={$sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
      label={$sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      size={14}
      onclick={toggleSidebarCollapsed}
    />
    <!-- Both withdrawn while collapsed: the search box opens in the row
         below this one, which a collapsed column has no width for, and
         the open action would leave the new workspace's name unreadable
         on the rail it lands in. The toggle above stays, so the way back
         is never more than one click. -->
    {#if ready && !$sidebarCollapsed}
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
{/snippet}

<div class="titlebar">
  {#if macOS}
    <WindowControls {macOS} />
    <!-- No data-tauri-drag-region: Tauri's injected script would fire
         its own maximize on top of the one windowDrag decides on. -->
    <div class="drag-spacer" use:windowDrag></div>
    {@render actions()}
  {:else}
    {@render actions()}
    <div class="drag-spacer" use:windowDrag></div>
    <WindowControls {macOS} />
  {/if}
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    background: var(--surface-raised);
    color: var(--text);
    font-family: sans-serif;
    font-size: 0.8em;
    flex: 0 0 auto;
    height: var(--header-height);
  }
  .drag-spacer {
    flex: 1 1 auto;
    height: 100%;
    /* Load-bearing while the column is collapsed: the rail is then only
       as wide as this strip's content, and a spacer that collapsed to
       nothing would leave the window with no handle at all on the one
       layout where the hub row is not beside it either. */
    min-width: 12px;
  }
  .bar-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
  }
</style>
