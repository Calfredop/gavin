<script lang="ts">
  import { SMOKE_SECTIONS, loadChecked, saveChecked, totalItems } from "./smokeChecklist";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // Progress is per workspace and survives reloads (localStorage, not the
  // daemon: this is a dev scratchpad, not workspace data anyone else needs).
  let checked = $state<Set<string>>(new Set());
  let loadedFor = $state<string | null>(null);

  $effect(() => {
    if (loadedFor !== workspaceId) {
      checked = loadChecked(workspaceId);
      loadedFor = workspaceId;
    }
  });

  const total = totalItems();
  const done = $derived(checked.size);

  function toggle(id: string): void {
    const next = new Set(checked);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    checked = next;
    saveChecked(workspaceId, next);
  }

  function reset(): void {
    checked = new Set();
    saveChecked(workspaceId, checked);
  }
</script>

<div class="checklist">
  <div class="head">
    <span class="progress">{done}/{total} checked</span>
    <span class="note">Manual passes only — everything here is invisible to the automated suites.</span>
    <button type="button" onclick={reset}>Reset</button>
  </div>

  {#each SMOKE_SECTIONS as section (section.title)}
    <section>
      <h3>{section.title}</h3>
      {#each section.items as item (item.id)}
        <label class="item" class:done={checked.has(item.id)}>
          <input type="checkbox" checked={checked.has(item.id)} onchange={() => toggle(item.id)} />
          <span class="text">
            {item.text}
            {#if item.hint}
              <span class="hint">{item.hint}</span>
            {/if}
          </span>
        </label>
      {/each}
    </section>
  {/each}
</div>

<style>
  .checklist {
    height: 100%;
    overflow-y: auto;
    padding: 16px 20px 32px;
    box-sizing: border-box;
    color: #ddd;
    font-family: monospace;
    font-size: 0.85em;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid #333;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .progress {
    color: #8bc98b;
  }
  .note {
    color: #777;
    font-size: 0.9em;
  }
  .head button {
    margin-left: auto;
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  h3 {
    color: #aaa;
    font-size: 0.9em;
    font-weight: normal;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 16px 0 6px;
  }
  .item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
    line-height: 1.45;
  }
  .item.done .text {
    color: #6d7d6d;
    text-decoration: line-through;
  }
  .item input {
    margin-top: 3px;
    flex: 0 0 auto;
    accent-color: #8bc98b;
  }
  .text {
    display: flex;
    flex-direction: column;
  }
  .hint {
    color: #777;
    font-size: 0.9em;
    text-decoration: none;
  }
</style>
