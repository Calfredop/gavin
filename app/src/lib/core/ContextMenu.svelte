<script lang="ts">
  import {
    contextMenu,
    closeContextMenu,
    isSeparator,
    isHeading,
    suppressesNativeMenu,
    type ContextMenuItem,
  } from "$lib/core/contextMenu";
  import { tooltip } from "$lib/core/tooltip";

  let menuEl = $state<HTMLElement | null>(null);
  let clamped = $state({ x: 0, y: 0 });

  // Clamp to the viewport once the menu has a measured size.
  $effect(() => {
    const m = $contextMenu;
    if (!m || !menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    clamped = {
      x: Math.max(4, Math.min(m.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(m.y, window.innerHeight - rect.height - 4)),
    };
  });

  // A toggle acts WITHOUT dismissing: it changed the state the entries
  // were built from, and its handler re-publishes them (see
  // setContextMenuEntries), so the tick lands under the cursor that set
  // it and the pick it qualifies is still one click away.
  function pick(item: ContextMenuItem): void {
    if (item.disabled) return;
    if (!item.keepOpen) closeContextMenu();
    item.onPick();
  }

  function pickSwitch(item: ContextMenuItem): void {
    if (item.disabled || !item.switch) return;
    if (!item.keepOpen) closeContextMenu();
    item.switch.onPick();
  }

  function onWindowPointerDown(e: PointerEvent): void {
    if ($contextMenu && menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if ($contextMenu && e.key === "Escape") closeContextMenu();
  }

  function onWindowBlur(): void {
    if ($contextMenu) closeContextMenu();
  }

  // The app's answer to WKWebView's own menu. Every gavin menu claims its
  // event at the target (openContextMenuFromEvent stops propagation), so
  // a right-click that reaches this window listener is one no surface
  // offered anything for -- and the browser's Reload/Back/Services menu
  // is not the app's answer to it. suppressesNativeMenu holds the two
  // exceptions: a text field's editing menu, and ⌥ as the way through to
  // WebKit (the inspector has no chord in this app).
  function onWindowContextMenu(e: MouseEvent): void {
    if (suppressesNativeMenu(e)) e.preventDefault();
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onkeydown={onWindowKeydown}
  onblur={onWindowBlur}
  oncontextmenu={onWindowContextMenu}
/>

{#if $contextMenu}
  <div class="menu" data-context-menu bind:this={menuEl} style:left="{clamped.x}px" style:top="{clamped.y}px" role="menu">
    {#each $contextMenu.entries as entry, i (i)}
      {#if isSeparator(entry)}
        <div class="separator"></div>
      {:else if isHeading(entry)}
        <div class="heading">{entry.heading}</div>
      {:else}
        <div
          class="item"
          class:danger={entry.danger}
          class:active={entry.active}
          class:has-switch={Boolean(entry.switch)}
          role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={entry.checked === undefined ? undefined : entry.checked}
        >
          <button
            type="button"
            class="item-main"
            disabled={entry.disabled}
            onclick={() => pick(entry)}
            use:tooltip={entry.tip}
          >
            <span class="marker">{entry.checked ? "✓" : entry.active ? "•" : ""}</span>
            <span class="item-label">{entry.label}</span>
            {#if entry.detail}<span class="item-detail">{entry.detail}</span>{/if}
          </button>
          {#if entry.switch}
            <button
              type="button"
              class="item-switch"
              class:active={entry.switch.active}
              aria-label={entry.switch.active ? `Include ${entry.label}` : `Exclude ${entry.label}`}
              aria-pressed={entry.switch.active}
              disabled={entry.disabled}
              onclick={() => pickSwitch(entry)}
            >{entry.switch.label}</button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 2500;
    min-width: 180px;
    max-width: 280px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    align-items: stretch;
    border-radius: 4px;
  }
  .item:hover {
    background: var(--surface-overlay);
  }
  .item.danger:hover {
    background: var(--surface-danger);
  }
  .item-main {
    flex: 1 1 0;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: monospace;
    font-size: 0.8em;
    padding: 5px 8px;
    text-align: left;
  }
  .item.has-switch .item-main {
    border-radius: 4px 0 0 4px;
  }
  .item-main:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .item.danger .item-main {
    color: var(--danger-text);
  }
  .item-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Pushed to the row's end and never shrunk: the label is the part
     that ellipsizes. */
  .item-detail {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 12px;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .marker {
    width: 10px;
    flex: 0 0 auto;
    color: var(--success-text);
  }
  .item-switch {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0 4px 4px 0;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.68em;
    padding: 0 7px;
  }
  .item-switch:hover:not(:disabled) {
    color: var(--text);
  }
  .item-switch.active {
    color: var(--danger);
    background: var(--surface-selected);
  }
  .item-switch:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .item-switch:focus-visible,
  .item-main:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .separator {
    height: 1px;
    background: var(--surface-overlay);
    margin: 4px 6px;
  }
  /* Names the menu; never picked. Indented to the items' own text
     column (their 10px marker plus its 4px gap) so the title and the
     rows below it read off one left edge. */
  .heading {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.75em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 8px 4px 22px;
  }
</style>
