<script lang="ts">
  import { contextMenu, closeContextMenu, isSeparator, type ContextMenuItem } from "./contextMenu";

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

  function onWindowPointerDown(e: PointerEvent): void {
    if ($contextMenu && menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if ($contextMenu && e.key === "Escape") closeContextMenu();
  }

  function onWindowBlur(): void {
    if ($contextMenu) closeContextMenu();
  }

  function onWindowContextMenu(e: MouseEvent): void {
    // A second right-click outside replaces the menu via the target's
    // own handler; inside the menu it is just noise.
    if ($contextMenu && menuEl && menuEl.contains(e.target as Node)) e.preventDefault();
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onkeydown={onWindowKeydown}
  onblur={onWindowBlur}
  oncontextmenu={onWindowContextMenu}
/>

{#if $contextMenu}
  <div class="menu" bind:this={menuEl} style:left="{clamped.x}px" style:top="{clamped.y}px" role="menu">
    {#each $contextMenu.entries as entry, i (i)}
      {#if isSeparator(entry)}
        <div class="separator"></div>
      {:else}
        <button
          type="button"
          class="item"
          class:danger={entry.danger}
          class:active={entry.active}
          disabled={entry.disabled}
          role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={entry.checked === undefined ? undefined : entry.checked}
          onclick={() => pick(entry)}
        >
          <span class="marker">{entry.checked ? "✓" : entry.active ? "•" : ""}</span>
          {entry.label}
        </button>
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item:hover:not(:disabled) {
    background: var(--surface-overlay);
  }
  .item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .item.danger {
    color: var(--danger-text);
  }
  .item.danger:hover:not(:disabled) {
    background: var(--surface-danger);
  }
  .marker {
    width: 10px;
    flex: 0 0 auto;
    color: var(--success-text);
  }
  .separator {
    height: 1px;
    background: var(--surface-overlay);
    margin: 4px 6px;
  }
</style>
