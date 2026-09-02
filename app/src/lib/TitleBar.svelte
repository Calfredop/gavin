<script lang="ts">
  import { get } from "svelte/store";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import {
    layoutState,
    splitPane,
    closePane,
    createPage,
    appHubOpen,
    switchWorkspaceView,
  } from "./layoutState";
  import { confirmPaneClose } from "./confirmClose";
  import { getActiveWorkspace } from "./workspace";
  import { contextMenu, openMenuUnder } from "./contextMenu";
  import { paneControlsApply, newPageEntries, type PagePreset } from "./titleBarActions";
  import { Columns2, Rows2, X, Plus, ChevronDown } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import WindowControls from "./WindowControls.svelte";
  import { isMacSync } from "./platform";
  import { tooltip } from "./tooltip";
  import { createDoubleClickTracker, doubleClickAction } from "./titleBarGesture";

  // Synchronous: the traffic lights must be on the correct side in the
  // first frame, and plugin-os's platform() is a plain global read.
  const macOS = isMacSync();

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

  // The pane controls address the focused pane of the active page, which
  // only exists on screen in the terminal view -- see titleBarActions.ts.
  const paneControls = $derived(paneControlsApply($layoutState, $appHubOpen));
  const activeWorkspace = $derived(getActiveWorkspace($layoutState));

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

  // A preset creates a new page in the active workspace rather than
  // replacing the current one -- the one, unified way to add a page, per
  // this milestone's design. The view switch is what makes the page
  // visible: createPage activates the workspace but never its terminal
  // view, and this button is reachable from every hub tab, where the
  // click would otherwise look like nothing happened.
  async function createPresetPage(preset: PagePreset): Promise<void> {
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return;
    const pageId = await createPage(
      ws.id,
      preset.build,
      preset.sessionCount,
      `Page ${ws.pages.length + 1}`
    );
    if (pageId) await switchWorkspaceView(ws.id, "terminal");
  }

  // The shared menu layer closes on any pointerdown outside itself, and
  // that lands before this button's click: a naive onclick would shut
  // the dropdown and reopen it in the same press, so the button that
  // opened the menu could never close it. The press records whether a
  // menu was already up; the click that follows only opens when none
  // was -- and a keyboard activation, which has no pointerdown at all,
  // always opens.
  let dismissedMenu = false;

  function onNewPagePointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  function openNewPageMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    openMenuUnder(
      event.currentTarget as HTMLElement,
      newPageEntries((preset) => void createPresetPage(preset))
    );
  }
</script>

{#snippet actions()}
  {#if paneControls}
    <IconButton icon={Columns2} label="Split Right" variant="filled" size={16} shortcut="split-right" onclick={() => split("row")} />
    <IconButton icon={Rows2} label="Split Down" variant="filled" size={16} shortcut="split-down" onclick={() => split("column")} />
    <IconButton icon={X} label="Close Pane" variant="filled" size={16} onclick={handleClosePane} />
  {/if}
  <!-- The tooltip hangs on the wrapper, not the button: a disabled
       element fires no mouseenter, so the reason it is disabled would
       never be readable from the button itself. -->
  <span
    class="new-page"
    use:tooltip={activeWorkspace ? "" : "Open a workspace to add a page to"}
  >
    <IconButton
      icon={Plus}
      label="New page"
      text="New page"
      variant="filled"
      size={14}
      disabled={!activeWorkspace}
      onpointerdown={onNewPagePointerDown}
      onclick={openNewPageMenu}
    >
      <ChevronDown size={12} />
    </IconButton>
  </span>
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
  /* Inline-flex, not the default inline: the wrapper exists only to
     carry the tooltip, and must measure exactly like the button. */
  .new-page {
    display: inline-flex;
  }
</style>
