<script lang="ts">
  // One facet's checkbox dropdown. A thin template over boardFilters.ts:
  // the options, the summary, the keep-open ticks, and the toggle all
  // live in the pure module so Kanban, Review, Plans (and Plans' own
  // status facet) cannot drift.
  //
  // Opens on the app's one context-menu layer (same shape as
  // NewPageButton / ArchiveDeleteButton): viewport clamping, Escape and
  // click-away are solved once, and a dropdown that is also a right-click
  // menu everywhere else reads as one control.
  import { get } from "svelte/store";
  import { ChevronDown } from "@lucide/svelte";
  import { contextMenu, openMenuUnder, setContextMenuEntries } from "$lib/core/contextMenu";
  import { tooltip } from "$lib/core/tooltip";
  import {
    facetMenuEntries,
    facetSummary,
    toggleFacet,
    type FacetOption,
    type FacetSelection,
  } from "$lib/board/boardFilters";

  interface Props {
    ariaLabel: string;
    tip: string;
    emptyLabel: string;
    options: FacetOption[];
    selected: FacetSelection;
    onChange: (next: FacetSelection) => void;
    /// Invert this facet. The NOT switch flips it; empty selection is
    /// still unset either way.
    exclude?: boolean;
    onExcludeChange?: (next: boolean) => void;
  }

  let {
    ariaLabel,
    tip,
    emptyLabel,
    options,
    selected,
    onChange,
    exclude = false,
    onExcludeChange,
  }: Props = $props();

  const summary = $derived(facetSummary(selected, options, emptyLabel, exclude));
  const disabled = $derived(options.length === 0);
  const invertTip = $derived(
    exclude
      ? "Click to switch — show cards that match the chosen values"
      : "Click to switch — hide cards that match the chosen values"
  );

  // The shared menu layer closes on any pointerdown outside itself, and
  // that lands before this button's click: a naive onclick would shut
  // the dropdown and reopen it in the same press, so the button that
  // opened the menu could never close it. Same guard, same reason, as
  // NewPageButton's.
  let dismissedMenu = false;

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  function entries(sel: FacetSelection) {
    return facetMenuEntries(options, sel, (value) => {
      const next = toggleFacet(sel, value);
      onChange(next);
      setContextMenuEntries(entries(next));
    });
  }

  function openMenu(event: MouseEvent): void {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed || disabled) return;
    openMenuUnder(event.currentTarget as HTMLElement, entries(selected));
  }

  function flipExclude(event: MouseEvent): void {
    event.stopPropagation();
    onExcludeChange?.(!exclude);
  }
</script>

<!-- Tooltip on the wrap so a disabled control (no options yet) still
     names itself: a disabled button never fires mouseenter. -->
<span class="facet-dropdown-wrap" class:excluding={exclude} use:tooltip={disabled ? tip : null}>
  <button
    type="button"
    class="facet-dropdown"
    class:active={selected.length > 0}
    aria-label={ariaLabel}
    aria-haspopup="menu"
    {disabled}
    use:tooltip={disabled ? null : tip}
    onpointerdown={onPointerDown}
    onclick={openMenu}
  >
    <span class="summary">{summary}</span>
    <ChevronDown size={11} />
  </button>
  <button
    type="button"
    class="facet-not"
    class:active={exclude}
    aria-label={exclude ? "Include chosen values" : "Exclude chosen values"}
    aria-pressed={exclude}
    {disabled}
    use:tooltip={invertTip}
    onclick={flipExclude}
  >NOT</button>
</span>

<style>
  .facet-dropdown-wrap {
    display: inline-flex;
    flex: 1 1 0;
    min-width: 0;
    max-width: 196px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .facet-dropdown-wrap:hover {
    border-color: var(--border-strong);
  }
  .facet-dropdown-wrap.excluding {
    border-color: var(--border-strong);
  }
  .facet-dropdown {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1 1 0;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text);
    font-family: monospace;
    font-size: 0.72rem;
    padding: 2px 4px;
    cursor: pointer;
    text-align: left;
  }
  .facet-dropdown:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .facet-dropdown.active {
    color: var(--text);
  }
  .facet-dropdown:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .summary {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facet-not {
    flex: 0 0 auto;
    align-self: stretch;
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.62rem;
    padding: 0 5px;
    cursor: pointer;
  }
  .facet-not:hover:not(:disabled) {
    color: var(--text);
  }
  .facet-not.active {
    color: var(--danger);
    background: var(--surface-selected);
  }
  .facet-not:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .facet-not:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
