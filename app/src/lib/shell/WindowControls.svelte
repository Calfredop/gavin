<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { X, Minus, Square, Maximize2, Minimize2 } from "@lucide/svelte";
  import { tooltip } from "$lib/core/tooltip";

  let { macOS }: { macOS: boolean } = $props();

  // Off macOS the middle button draws WHICH WAY it will go: arrows out
  // while the window can still grow, arrows in once it is maximized.
  // Read back off the window rather than flipped on click, because the
  // same toggle happens from outside this component -- a double-click on
  // the drag strip (windowDrag), the OS's own snap gestures, a maximized
  // window dragged off the top edge -- and a locally toggled boolean
  // would drift the first time any of those ran.
  let maximized = $state(false);

  async function readMaximized(): Promise<void> {
    try {
      maximized = await getCurrentWindow().isMaximized();
    } catch {
      // No Tauri window (vitest, a plain browser preview). "Expand" is
      // the safe glyph: it is what an un-maximized window offers.
    }
  }

  onMount(() => {
    // The traffic lights draw the same three shapes at every size, so
    // macOS has no state to follow and no listener to pay for.
    if (macOS) return;
    void readMaximized();
    let stop: (() => void) | null = null;
    let gone = false;
    try {
      // Every maximize and restore is also a resize, so this one
      // listener covers the click here and the toggles from elsewhere.
      void getCurrentWindow()
        .onResized(() => void readMaximized())
        .then((unlisten) => {
          if (gone) unlisten();
          else stop = unlisten;
        })
        .catch(() => {});
    } catch {
      // Same as above: outside a Tauri window there is nothing to watch.
    }
    return () => {
      gone = true;
      stop?.();
    };
  });

  function minimize(): void {
    getCurrentWindow().minimize();
  }

  function toggleMaximize(): void {
    getCurrentWindow().toggleMaximize();
  }

  function close(): void {
    // close(), not destroy() -- close() fires CloseRequested, which
    // +page.svelte's existing onCloseRequested handler already intercepts
    // with the "your sessions will keep running" confirm dialog. Reusing
    // that flow here (rather than duplicating a second confirm prompt) is
    // the whole reason this calls close() instead of destroy().
    getCurrentWindow().close();
  }
</script>

{#if macOS}
  <div class="mac-controls">
    <button class="mac-btn close" aria-label="Close" title="Close" onclick={close}>
      <X size={8} />
    </button>
    <button class="mac-btn minimize" aria-label="Minimize" title="Minimize" onclick={minimize}>
      <Minus size={8} />
    </button>
    <button class="mac-btn maximize" aria-label="Maximize" title="Maximize" onclick={toggleMaximize}>
      <Square size={6} />
    </button>
  </div>
{:else}
  <!-- Close first, minimize last: the reverse of what Windows draws on
       the right-hand end of a title bar, because this corner is not
       there. It is the window's top-LEFT corner on every platform
       (TitleBar.svelte), so the button nearest the window's edge is the
       first one here -- which is the order the traffic lights beside it
       read in, and it keeps the one irreversible button furthest from
       the sidebar's own chrome rather than right against it. -->
  <div class="default-controls">
    <button
      class="win-btn close"
      aria-label="Close"
      use:tooltip={"Close"}
      onclick={close}
    >
      <X size={12} />
    </button>
    <button
      class="win-btn"
      aria-label={maximized ? "Restore" : "Maximize"}
      use:tooltip={maximized ? "Restore" : "Maximize"}
      onclick={toggleMaximize}
    >
      {#if maximized}
        <Minimize2 size={12} />
      {:else}
        <Maximize2 size={12} />
      {/if}
    </button>
    <button class="win-btn" aria-label="Minimize" use:tooltip={"Minimize"} onclick={minimize}>
      <!-- Not lucide's Minus, which centres its line: this bar sits low
           in the box, where the window is going -- down to the taskbar
           -- so the glyph reads as a destination rather than a hyphen.
           Same 24-unit box and 2-unit stroke as the lucide icons beside
           it, so all three weigh the same at 12px. -->
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <line x1="5" y1="17" x2="19" y2="17" />
      </svg>
    </button>
  </div>
{/if}

<style>
  .mac-controls {
    display: flex;
    gap: 8px;
    padding: 0 12px;
    align-items: center;
  }
  .mac-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    padding: 0;
    cursor: pointer;
    color: transparent;
  }
  .mac-controls:hover .mac-btn {
    color: rgba(0, 0, 0, 0.5);
  }
  /* The traffic lights and the Windows close red below are fixed
     platform colours, not theme roles -- macOS draws the same three
     hexes in light and dark, so they stay literal on purpose. */
  .mac-btn.close {
    background: #ff5f57;
  }
  .mac-btn.minimize {
    background: #febc2e;
  }
  .mac-btn.maximize {
    background: #28c840;
  }

  /* Three small tiles rather than three full-height 40px slabs. The
     slabs were a Windows title bar's own geometry, which is what a bar
     spanning the window can afford; this is a corner over the sidebar,
     beside that sidebar's own 14px icon buttons, and it has to read as
     part of the same row.

     The arithmetic here IS --window-corner-width for this platform:
     8 + 3*26 + 2*2 + 6 = 96px (+page.svelte, .app.wide-window-controls).
     windowControls.test.ts holds the two together. */
  .default-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 100%;
    padding: 0 6px 0 8px;
  }
  .win-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .win-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .win-btn:active {
    background: var(--surface-selected);
  }
  .win-btn:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  /* After the rules above so it wins on hover and on press alike. */
  .win-btn.close:hover,
  .win-btn.close:active {
    background: #e81123;
    color: #fff;
  }
</style>
