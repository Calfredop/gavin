<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { layoutState, splitPane, closePane, createPage } from "./layoutState";
  import { presetSingle, presetSideBySide, presetGrid2x2, type LayoutNode } from "./layout";
  import { confirmPaneClose } from "./confirmClose";
  import { getActiveWorkspace } from "./workspace";
  import { Columns2, Rows2, X, Square, Grid2x2 } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import WindowControls from "./WindowControls.svelte";
  import { isMacOS } from "./platform";
  import { createDoubleClickTracker, doubleClickAction } from "./titleBarGesture";

  let macOS = $state(false);
  onMount(async () => {
    macOS = await isMacOS();
  });

  // data-tauri-drag-region alone is unreliable depending on the webview
  // version -- startDragging() is the documented, directly-controlled
  // mechanism and is what actually makes the bar draggable. Left-click
  // only, so this doesn't hijack right-click/middle-click.
  //
  // Double-click: the tracker keeps the 2nd mousedown from starting a
  // drag (a native drag swallows the mouseup) and fires on the mouseup
  // if the cursor stayed put -- macOS semantics. The action honors the
  // user's "Double-click a window's title bar to" System Setting, read
  // from NSUserDefaults on the Rust side (null off macOS -> zoom).
  // The spacer deliberately has no data-tauri-drag-region: Tauri's
  // injected script would otherwise fire its own maximize as well.
  const doubleClick = createDoubleClickTracker();

  function onBarMouseDown(event: MouseEvent): void {
    if (doubleClick.mousedown(event) === "drag") {
      getCurrentWindow().startDragging();
    }
  }

  async function onBarMouseUp(event: MouseEvent): Promise<void> {
    if (!doubleClick.mouseup(event)) return;
    const pref = await invoke<string | null>("title_bar_double_click_action");
    const win = getCurrentWindow();
    switch (doubleClickAction(pref)) {
      case "toggleMaximize":
        await win.toggleMaximize();
        break;
      case "minimize":
        await win.minimize();
        break;
      case "none":
        break;
    }
  }

  async function split(direction: "row" | "column"): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await splitPane(id, direction);
  }

  async function handleClosePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (!id) return;
    if (await confirmPaneClose(id)) {
      await closePane(id);
    }
  }

  // Presets create a new page in the active workspace rather than
  // replacing the current one -- the one, unified way to add a page,
  // per this milestone's design.
  async function createPageWithPreset(
    buildTree: (freshIds: string[]) => LayoutNode,
    sessionCount: number
  ): Promise<void> {
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return;
    await createPage(ws.id, buildTree, sessionCount, `Page ${ws.pages.length + 1}`);
  }

  async function applySingle(): Promise<void> {
    await createPageWithPreset(([id]) => presetSingle(id), 1);
  }
  async function applySideBySide(): Promise<void> {
    await createPageWithPreset(([a, b]) => presetSideBySide(a, b), 2);
  }
  async function applyGrid(): Promise<void> {
    await createPageWithPreset(([a, b, c, d]) => presetGrid2x2(a, b, c, d), 4);
  }
</script>

{#snippet actions()}
  <IconButton icon={Columns2} label="Split Right" variant="filled" size={16} onclick={() => split("row")} />
  <IconButton icon={Rows2} label="Split Down" variant="filled" size={16} onclick={() => split("column")} />
  <IconButton icon={X} label="Close Pane" variant="filled" size={16} onclick={handleClosePane} />
  <div class="presets">
    <span>Presets:</span>
    <IconButton icon={Square} label="Single" text="Single" variant="filled" size={14} onclick={applySingle} />
    <IconButton icon={Columns2} label="Side by Side" text="Side by Side" variant="filled" size={14} onclick={applySideBySide} />
    <IconButton icon={Grid2x2} label="2×2 Grid" text="2×2 Grid" variant="filled" size={14} onclick={applyGrid} />
  </div>
{/snippet}

<div class="titlebar">
  {#if macOS}
    <WindowControls {macOS} />
    <div class="drag-spacer" onmousedown={onBarMouseDown} onmouseup={onBarMouseUp}></div>
    <div class="actions">{@render actions()}</div>
  {:else}
    <div class="actions">{@render actions()}</div>
    <div class="drag-spacer" onmousedown={onBarMouseDown} onmouseup={onBarMouseUp}></div>
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
    height: 40px;
  }
  .drag-spacer {
    flex: 1 1 auto;
    height: 100%;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
  }
  .presets {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: 8px;
  }
</style>
