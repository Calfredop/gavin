<script lang="ts">
  // What is left of the title bar: the window's controls, and somewhere
  // to grab it. It used to span the window and carry the pane controls
  // and the "New page" button as well; both of those moved to the bar
  // that is now the app's top edge (Pane.svelte's tab row, and the hub
  // tab row in +page.svelte), and the strip came down to the width of
  // the sidebar it sits over -- which is what lets the hub and the page
  // reach the top of the window at all.
  //
  // Its height is the shared header height, so the sidebar's first row
  // starts on the same line as the view beside it.
  import WindowControls from "./WindowControls.svelte";
  import { isMacSync } from "./platform";
  import { windowDrag } from "./windowDrag";

  // Synchronous: the traffic lights must be on the correct side in the
  // first frame, and plugin-os's platform() is a plain global read.
  const macOS = isMacSync();
</script>

<div class="titlebar">
  {#if macOS}
    <WindowControls {macOS} />
    <!-- No data-tauri-drag-region: Tauri's injected script would fire
         its own maximize on top of the one windowDrag decides on. -->
    <div class="drag-spacer" use:windowDrag></div>
  {:else}
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
  }
</style>
