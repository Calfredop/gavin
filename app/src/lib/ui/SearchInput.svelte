<script lang="ts">
  import { Search, X } from "@lucide/svelte";

  interface Props {
    /// The query. Bindable, so a surface that owns local state can just
    /// `bind:value`; a surface whose filter lives in a store passes
    /// `value` plus `onValue` and never binds.
    value?: string;
    placeholder?: string;
    /// Drives aria-label; also the tooltip on the clear button.
    label?: string;
    /// Rendered as "n / total" beside the box while a query is active.
    /// Null hides the count entirely.
    matches?: { shown: number; total: number } | null;
    /// A short line under the box -- what filtering costs on this
    /// surface ("clear to reorder"). Only shown while searching.
    hint?: string | null;
    /// Called on every keystroke and on clear, for store-backed filters.
    onValue?: ((next: string) => void) | null;
    /// Extra classes for positioning by the host.
    class?: string;
  }

  let {
    value = $bindable(""),
    placeholder = "Search…",
    label = "Search",
    matches = null,
    hint = null,
    onValue = null,
    class: extraClass = "",
  }: Props = $props();

  const active = $derived(value.trim().length > 0);

  function set(next: string): void {
    value = next;
    onValue?.(next);
  }

  // Esc clears rather than blurring: the box is a lens the human puts on
  // and takes off, and an Esc that only blurred would leave the surface
  // filtered with no obvious way back.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && active) {
      e.preventDefault();
      e.stopPropagation();
      set("");
    }
  }
</script>

<div class="search {extraClass}" class:active>
  <div class="box">
    <Search size={12} />
    <input
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label={label}
      {placeholder}
      {value}
      oninput={(e) => set(e.currentTarget.value)}
      onkeydown={onKeydown}
    />
    {#if active}
      <button type="button" class="clear" title="Clear search (Esc)" aria-label="Clear search" onclick={() => set("")}>
        <X size={12} />
      </button>
    {/if}
  </div>
  {#if matches && active}
    <span class="count" class:none={matches.shown === 0}>{matches.shown} / {matches.total}</span>
  {/if}
  {#if hint && active}
    <span class="hint">{hint}</span>
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .box {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 2px 6px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-subtle);
  }
  .search.active .box {
    border-color: var(--border-accent);
    color: var(--accent-text);
  }
  .box:focus-within {
    border-color: var(--border-focus);
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--text);
    font-family: monospace;
    font-size: 0.78rem;
    padding: 2px 0;
  }
  input::placeholder {
    color: var(--text-subtle);
  }
  .clear {
    display: flex;
    align-items: center;
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-muted);
    cursor: pointer;
  }
  .clear:hover {
    color: var(--text);
  }
  .count {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }
  .count.none {
    color: var(--warning-text);
  }
  .hint {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.7rem;
    white-space: nowrap;
  }
</style>
