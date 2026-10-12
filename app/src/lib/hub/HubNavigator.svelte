<script lang="ts">
  import { tabStripHubViews, type HubView } from "$lib/hub/workspaceViews";
  import { hubNavigatorLabel, hubNavigatorViewIds, otherHubNavigatorSide } from "$lib/hub/hubNavigator";
  import {
    hubTabOrderByWorkspace,
    hubTabPrefsFor,
    hubTabsHiddenByWorkspace,
    hubTabsHiddenDefault,
  } from "$lib/hub/hubTabPrefs";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { hubNavigatorSide } from "$lib/hub/hubNavigatorSide";
  import IconButton from "$lib/ui/IconButton.svelte";

  interface Props {
    workspaceId: string;
    /// The section currently shown over the page, if any.
    open: string | null;
    onselect: (id: string) => void;
    hasRoot: boolean;
    /// The agent file's name (CLAUDE.md, AGENTS.md…), which is what the
    /// hub's own tab for it is called.
    agentFileName: string;
  }

  let { workspaceId, open, onselect, hasRoot, agentFileName }: Props = $props();

  function flipSide(): void {
    hubNavigatorSide.update(otherHubNavigatorSide);
  }

  const prefs = $derived(
    hubTabPrefsFor(workspaceId, $hubTabOrderByWorkspace, $hubTabsHiddenByWorkspace, $hubTabsHiddenDefault)
  );
  // Resolved through the same two lists the hub's row uses, so a tab
  // hidden or dragged there is hidden or dragged here.
  const views = $derived.by(() => {
    const byId = new Map<string, HubView>(
      tabStripHubViews(hasRoot, prefs).map((v) => [v.id, v])
    );
    return hubNavigatorViewIds(hasRoot, prefs)
      .map((id) => byId.get(id))
      .filter((v): v is HubView => v !== undefined);
  });
</script>

<!-- A column beside a page, not a row above it: the page's own tab bar
     already owns the top edge. Icon only -- the tooltip (IconButton's
     label) carries the name. -->
<nav class="hub-navigator" class:on-right={$hubNavigatorSide === "right"} aria-label="Hub sections">
  <div class="items">
  {#each views as view (view.id)}
    <IconButton
      icon={view.icon}
      label={hubNavigatorLabel(view, agentFileName)}
      size={16}
      class="hub-navigator-button"
      active={open === view.id}
      onclick={() => onselect(view.id)}
    />
  {/each}
  </div>
  <!-- A quiet notch halfway down; hovering it reveals the button that
       moves the bar to the other edge. -->
  <div class="flip-zone">
    <span class="notch" aria-hidden="true"></span>
    <IconButton
      icon={$hubNavigatorSide === "left" ? ChevronRight : ChevronLeft}
      label={$hubNavigatorSide === "left" ? "Move to the right" : "Move to the left"}
      size={12}
      variant="outlined"
      class="flip-button"
      onclick={flipSide}
    />
  </div>
</nav>

<style>
  .hub-navigator {
    /* Laid over the page's edge, under its tab bar: the tab bar keeps the
       window's full width, and the page shifts clear of the bar (the
       host reserves --hub-nav-width). Above the page, so the mover that
       straddles its edge is not clipped by it. */
    position: absolute;
    z-index: 10;
    top: var(--header-height);
    bottom: 0;
    left: 0;
    width: var(--hub-nav-width, 37px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--surface-base);
    border-right: 1px solid var(--border);
  }
  .hub-navigator.on-right {
    left: auto;
    right: 0;
    border-right: none;
    border-left: 1px solid var(--border);
  }
  .items {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    overflow-y: auto;
  }
  /* Centred ON the bar's inner border, half over the page: the mover
     belongs to the edge, not to the column's content. */
  .flip-zone {
    position: absolute;
    top: 50%;
    right: -11px;
    width: 22px;
    height: 28px;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .on-right .flip-zone {
    right: auto;
    left: -11px;
  }
  .notch {
    width: 3px;
    height: 14px;
    border-radius: 2px;
    background: var(--border-strong);
    opacity: 0.6;
  }
  .flip-zone :global(.flip-button) {
    position: absolute;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    background: var(--surface-overlay);
    opacity: 0;
    pointer-events: none;
  }
  .flip-zone:hover .notch {
    opacity: 0;
  }
  .flip-zone:hover :global(.flip-button) {
    opacity: 1;
    pointer-events: auto;
  }
  .hub-navigator :global(.hub-navigator-button) {
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 0;
  }
  /* The hub tab row's highlight turned on its side (+page.svelte's
     .tab.active): the same accent at the same thickness, on the edge
     that faces the page rather than under the label, since this column
     runs down the page's left. An inset shadow rather than a border so
     opening a section moves nothing -- the tab rows' drop marks draw the
     same way. No box: IconButton's active background is dropped. */
  .hub-navigator :global(.hub-navigator-button.active) {
    color: var(--text);
    background: transparent;
    box-shadow: inset calc(-1 * var(--tab-indicator)) 0 0 0 var(--ws-accent, #d9a648);
  }
</style>
