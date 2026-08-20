<script lang="ts">
  import { splitPath, type Area, type FileEntry } from "./git";
  import { tooltip } from "./tooltip";

  interface Props {
    entry: FileEntry;
    area: Area;
    selected: boolean;
    disabled: boolean;
    onSelect: () => void;
    onToggle: () => void;
  }
  let { entry, area, selected, disabled, onSelect, onToggle }: Props = $props();

  const parts = $derived(splitPath(entry.path));
  const toggleLabel = $derived(area === "unstaged" ? "Stage" : "Unstage");
</script>

<!-- Keyboard handling lives on the enclosing listbox (GitChanges.svelte):
     ↑/↓/Tab/Space move and act on the selection, per the ARIA listbox
     pattern, so the option itself needs no key handler. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="row" class:selected role="option" aria-selected={selected} tabindex="-1" onclick={onSelect} ondblclick={onToggle}>
  <span class="badge s-{entry.status === '?' ? 'untracked' : entry.status}">{entry.status}</span>
  <span class="path">
    {#if entry.oldPath}<span class="dir">{entry.oldPath} → </span>{/if}
    <span class="dir">{parts.dir}</span><span class="name">{parts.name}</span>
  </span>
  <span class="actions">
    <button type="button" use:tooltip={toggleLabel + " file"} {disabled} onclick={(e) => { e.stopPropagation(); onToggle(); }}>
      {area === "unstaged" ? "+" : "−"}
    </button>
  </span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    font-size: 0.78em;
    cursor: default;
    user-select: none;
  }
  .row:hover {
    background: #222;
  }
  .row.selected {
    background: #2a3a4a;
  }
  .badge {
    width: 14px;
    text-align: center;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .s-M { color: #d9b45c; }
  .s-A { color: #8bc98b; }
  .s-D { color: #e08a8a; }
  .s-R, .s-C { color: #8ab4e0; }
  .s-untracked { color: #8bc98b; }
  .s-U { color: #ff6b6b; }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    color: #777;
  }
  .name {
    color: #ddd;
  }
  .actions {
    display: none;
    gap: 4px;
  }
  .row:hover .actions,
  .row.selected .actions {
    display: flex;
  }
  .actions button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    width: 20px;
    height: 18px;
    line-height: 1;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
