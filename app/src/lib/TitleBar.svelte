<script lang="ts">
  // The window's own controls, in a corner of their own, and the rail's
  // top row beside them.
  //
  // This used to be a strip spanning the whole sidebar column, carrying
  // the pane controls and the "New page" button as well. Both of those
  // moved to the bar that is now the app's top edge (Pane.svelte's tab
  // row, and the hub tab row in +page.svelte), and the sidebar's own
  // three chrome buttons followed them (SidebarActions.svelte).
  //
  // What was left was still a floor under the column: the strip is
  // INSIDE the sidebar's column, so the platform's window controls --
  // 76px of traffic lights on macOS -- were the narrowest that column
  // could ever collapse to, and a rail of initials had to rattle around
  // in a width the lights had chosen.
  //
  // So the controls stopped being part of the column and became a corner
  // of the window: absolutely positioned at (0, 0), the height of the
  // header row beside it, and painted the header row's surface rather
  // than the sidebar's, because that row is what it is now part of. It
  // is free to be wider than the rail under it -- the head of the header
  // row leaves exactly that much room (SidebarActions.svelte's
  // .corner-overhang), so nothing is ever drawn beneath it.
  //
  // The rail's top row is what stays in flow: it is the height that puts
  // the sidebar's first row on the same line as the view beside it, and
  // it is somewhere to grab the window while the column is open.
  //
  // The corner is the top-LEFT on every platform, which is macOS's own
  // placement and not Windows'. Off macOS the controls were already not
  // where that platform puts them -- they sat at the right-hand end of a
  // 200px strip over the sidebar, which is the middle of the window --
  // so this is one geometry instead of two rather than a change of
  // convention.
  import WindowControls from "./WindowControls.svelte";
  import { isMacSync } from "./platform";
  import { windowDrag } from "./windowDrag";

  // Synchronous: the traffic lights must be on the correct side in the
  // first frame, and plugin-os's platform() is a plain global read.
  const macOS = isMacSync();
</script>

<div class="corner">
  <WindowControls {macOS} />
</div>
<!-- No data-tauri-drag-region: Tauri's injected script would fire its
     own maximize on top of the one windowDrag decides on. -->
<div class="rail-top" use:windowDrag></div>

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
    width: var(--window-corner-width);
    height: var(--header-height);
    box-sizing: border-box;
    /* The header row's surface, not the sidebar's: these controls sit on
       the app's top bar now, and a raised block would read as a piece of
       the sidebar that had slipped out of its column. */
    background: var(--surface-base);
    color: var(--text);
    font-family: sans-serif;
    font-size: 0.8em;
  }
  /* The rest of the rail's top line: the same height and surface, so the
     top of the window is one unbroken bar from the controls across to
     the tabs, and the sidebar starts under it. */
  .rail-top {
    flex: 0 0 auto;
    height: var(--header-height);
    background: var(--surface-base);
  }
</style>
