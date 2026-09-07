<script lang="ts">
  // Eight strips over the window's border, each one a resize grip.
  // A thin template over windowResize.ts, which holds the table and the
  // reasons; see that file for why GTK and Windows need this and macOS
  // does not.
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { isMacSync } from "./platform";
  import { needsResizeGrips, resizeZones, type ResizeDirection } from "./windowResize";

  // Synchronous, like TitleBar's own read: the grips have to be right in
  // the first frame, and plugin-os's platform() is a plain global read.
  const show = needsResizeGrips(isMacSync());
  const zones = resizeZones();

  function grab(event: MouseEvent, direction: ResizeDirection): void {
    if (event.button !== 0) return;
    // Before the window manager takes the pointer: once it has it, no
    // further DOM event arrives for this press, so anything that must
    // not also happen has to be stopped now.
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging(direction);
  }
</script>

{#if show}
  {#each zones as zone (zone.direction)}
    <div
      class="grip"
      role="presentation"
      style="{zone.style};cursor:{zone.cursor}"
      onmousedown={(e) => grab(e, zone.direction)}
    ></div>
  {/each}
{/if}

<style>
  /* Fixed, so the grips follow the viewport rather than any scrolled
     ancestor, and above every surface in the app: the top edge runs
     over the tab row and the left edge over the sidebar, which is
     exactly where a native frame would sit. */
  .grip {
    position: fixed;
    z-index: 9999;
    background: transparent;
  }
</style>
