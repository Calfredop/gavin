<script lang="ts">
  // The "+" that adds a page, and the preset menu behind it. A
  // component rather than a snippet in one bar, because it now rides on
  // two of them: the workspace's hub tab row, and every pane's tab row
  // on a terminal page. Whichever of those is on screen is the top edge
  // of the app, so the button is where it always was -- top right --
  // without the app owing a full-width strip to keep it there.
  import { get } from "svelte/store";
  import { layoutState, createPage, switchWorkspaceView } from "$lib/layoutState";
  import { getActiveWorkspace } from "$lib/workspace";
  import {
    contextMenu,
    openMenuUnder,
    setContextMenuEntries,
    type ContextMenuEntry,
  } from "$lib/contextMenu";
  import { newPageEntries, NEW_PAGE_TITLE, type PagePreset } from "$lib/panes/newPage";
  import { Plus, ChevronDown } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/tooltip";

  const activeWorkspace = $derived(getActiveWorkspace($layoutState));

  // Whether the next preset opens its panes on the workspace's agent or
  // on bare shells. Component state, not a stored preference: launching
  // an agent per pane is a deliberate act, and a tick remembered from
  // last week would spend a workspace's agent slots on a page the human
  // asked for as terminals.
  let withAgent = $state(false);

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
      `Page ${ws.pages.length + 1}`,
      { withAgent }
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

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  function menuEntries(): ContextMenuEntry[] {
    return newPageEntries(withAgent, toggleWithAgent, (preset) => void createPresetPage(preset));
  }

  // The checkbox leaves the menu up, so the list it lives in has to be
  // re-published for the tick to appear -- the entries are a plain array
  // captured when the menu opened.
  function toggleWithAgent(): void {
    withAgent = !withAgent;
    setContextMenuEntries(menuEntries());
  }

  function openMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    openMenuUnder(event.currentTarget as HTMLElement, menuEntries());
  }
</script>

<!-- The tooltip hangs on the wrapper, not the button: a disabled
     element fires no mouseenter, so the reason it is disabled would
     never be readable from the button itself. -->
<span
  class="new-page"
  use:tooltip={activeWorkspace ? "" : "Open a workspace to add a page to"}
>
  <IconButton
    icon={Plus}
    label={NEW_PAGE_TITLE}
    size={14}
    disabled={!activeWorkspace}
    onpointerdown={onPointerDown}
    onclick={openMenu}
  >
    <ChevronDown size={12} />
  </IconButton>
</span>

<style>
  /* Inline-flex, not the default inline: the wrapper exists only to
     carry the tooltip, and must measure exactly like the button. */
  .new-page {
    display: inline-flex;
  }
</style>
