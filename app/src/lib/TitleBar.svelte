<script lang="ts">
  // The window's corner: everything that acts on the WINDOW and on the
  // COLUMN, in one strip over the sidebar -- the platform's controls,
  // then the sidebar's own three buttons, then somewhere to grab it.
  //
  // This used to be a strip spanning the whole sidebar column, carrying
  // the pane controls and the "New page" button as well. Both of those
  // moved to the bar that is now the app's top edge (Pane.svelte's tab
  // row, and the hub tab row in +page.svelte).
  //
  // What was left was still a floor under the column: the strip is
  // INSIDE the sidebar's column, so the platform's window controls --
  // 76px of traffic lights on macOS -- were the narrowest that column
  // could ever collapse to, and a rail of initials had to rattle around
  // in a width the lights had chosen.
  //
  // So the strip stopped being part of the column's flow and became a
  // corner: absolutely positioned at (0, 0), the height of the header
  // row beside it, and free to be wider than the rail under it. The head
  // of that header row leaves exactly the overhang (CornerOverhang.svelte),
  // so nothing is ever drawn beneath the corner.
  //
  // Its width is `max(the platform's controls, the rail)`: over an open
  // column it is that column's own top row, and over a collapsed one it
  // shrinks to the controls and hangs 40px into the row beside it. It
  // keeps the SIDEBAR's surface at both widths, because what it is the
  // header of is the column, not the view.
  //
  // The rail's top row is what stays in flow, under the corner at every
  // width: it is the height that puts the sidebar's first row on the
  // same line as the view beside it.
  //
  // The corner is the top-LEFT on every platform, which is macOS's own
  // placement and not Windows'. Off macOS the controls were already not
  // where that platform puts them -- they sat at the right-hand end of a
  // 200px strip over the sidebar, which is the middle of the window --
  // so this is one geometry instead of two rather than a change of
  // convention.
  import WindowControls from "./WindowControls.svelte";
  import SidebarActions from "./SidebarActions.svelte";
  import { isMacSync } from "./platform";
  import { windowDrag } from "./windowDrag";

  // Synchronous: the traffic lights must be on the correct side in the
  // first frame, and plugin-os's platform() is a plain global read.
  const macOS = isMacSync();
</script>

<div class="corner">
  <WindowControls {macOS} />
  <SidebarActions />
  <!-- No data-tauri-drag-region: Tauri's injected script would fire its
       own maximize on top of the one windowDrag decides on. Whatever the
       chrome leaves of an open column's top row is a handle; collapsed
       there is nothing left over, and the header row's own spacer is
       where the window is grabbed instead. -->
  <div class="drag-spacer" use:windowDrag></div>
</div>
<div class="rail-top"></div>

<style>
  /* Out of the column's flow entirely, so its width is nothing the rail
     has to accommodate. Positioned against .rail (+page.svelte), which
     is the window's top-left corner as long as the sidebar is the
     leftmost thing in the window -- which it is by construction: the
     rail is the first child of the body row. */
  .corner {
    position: absolute;
    top: 0;
    left: 0;
    /* Above the view column's own header row, which is painted later in
       tree order and would otherwise cover whatever of this overhangs a
       collapsed rail. */
    z-index: 1;
    display: flex;
    align-items: center;
    width: max(var(--window-corner-width), var(--rail-width));
    height: var(--header-height);
    box-sizing: border-box;
    padding-right: 6px;
    /* The sidebar's surface, at both widths: this strip is the column's
       header, and the column is what everything in it acts on. */
    background: var(--surface-raised);
    color: var(--text);
    font-family: sans-serif;
    font-size: 0.8em;
  }
  .drag-spacer {
    flex: 1 1 auto;
    height: 100%;
    min-width: 0;
  }
  /* The rail's own top line, in flow under the corner: what actually
     pushes the sidebar down to start on the line the view beside it
     starts on. Same surface, so the seam between the two never shows at
     any width. */
  .rail-top {
    flex: 0 0 auto;
    height: var(--header-height);
    background: var(--surface-raised);
  }
</style>
