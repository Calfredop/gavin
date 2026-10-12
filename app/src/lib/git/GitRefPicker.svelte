<script lang="ts">
  import { ChevronDown } from "@lucide/svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { filterList } from "$lib/core/search";
  import type { CompareRefOption } from "$lib/git/git";

  interface Props {
    /// The label the closed button reads, and the menu's aria label.
    label: string;
    value: string | null;
    groups: { head: CompareRefOption[]; branches: CompareRefOption[]; remotes: CompareRefOption[]; worktrees: CompareRefOption[] };
    disabled?: boolean;
    onPick: (value: string) => void;
  }
  let { label, value, groups, disabled = false, onPick }: Props = $props();

  let open = $state(false);
  let query = $state("");

  const sections = $derived([
    { title: "Checkout", options: groups.head },
    { title: "Branches", options: groups.branches },
    { title: "Remotes", options: groups.remotes },
    { title: "Worktrees", options: groups.worktrees },
  ]);
  const filtered = $derived(
    sections.map((s) => ({ ...s, options: filterList(s.options, query, (o) => [o.label, o.value]) }))
  );
  const shown = $derived(sections.flatMap((s) => s.options).find((o) => o.value === value)?.label ?? value ?? "—");

  function pick(option: CompareRefOption): void {
    open = false;
    query = "";
    if (option.value !== value) onPick(option.value);
  }

  // Click-outside closes the menu; window-level so a click anywhere counts.
  function onWindowPointerDown(e: PointerEvent): void {
    if (!open) return;
    const el = e.target as HTMLElement | null;
    if (!el?.closest(".picker")) open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<span class="picker">
  <button type="button" class="current" {disabled} aria-haspopup="menu" aria-expanded={open} aria-label={label} onclick={() => (open = !open)}>
    <span class="name">{shown}</span>
    <ChevronDown size={12} />
  </button>

  {#if open}
    <div class="menu" role="menu" aria-label={label}>
      <div class="filter">
        <SearchInput bind:value={query} label="Filter refs" placeholder="Filter refs…" />
      </div>
      <div class="opts">
        {#each filtered as section (section.title)}
          {#if section.options.length > 0}
            <div class="group">{section.title}</div>
            {#each section.options as option (option.value)}
              <button type="button" class="pick" class:active={option.value === value} role="menuitem" title={option.value} onclick={() => pick(option)}>
                {option.label}
              </button>
            {/each}
          {/if}
        {/each}
        {#if filtered.every((s) => s.options.length === 0)}
          <div class="none">No match</div>
        {/if}
      </div>
    </div>
  {/if}
</span>

<style>
  .picker {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }
  .current {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 2px 8px;
    cursor: pointer;
    max-width: 200px;
  }
  .current:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  .current:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    min-width: 260px;
    max-width: 340px;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
  }
  .filter {
    padding: 2px 2px 4px;
    border-bottom: 1px solid var(--border);
  }
  .opts {
    max-height: 320px;
    overflow-y: auto;
    padding-top: 2px;
  }
  .group {
    padding: 4px 6px 2px;
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.85em;
  }
  .pick {
    display: block;
    width: 100%;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 4px 6px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick:hover {
    background: var(--surface-raised);
  }
  .pick.active {
    color: var(--text);
    font-weight: 600;
  }
  .none {
    padding: 6px 8px;
    color: var(--text-subtle);
  }
</style>
