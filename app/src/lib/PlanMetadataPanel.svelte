<script lang="ts">
  import type { PlanFileInfo } from "./gavin";
  import { statusOptions } from "./planExplorer";
  import { patchPlanField } from "./gavinState";
  import * as backend from "./backend";

  interface Props {
    plan: PlanFileInfo;
    workspaceId: string;
    columnNames: string[];
    // Lands any unsaved editor buffer before we rewrite a line of the
    // same file (see FileEditor.flush).
    onBeforeWrite: () => Promise<void>;
  }
  let { plan, workspaceId, columnNames, onBeforeWrite }: Props = $props();

  const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

  let titleDraft = $state(plan.title);
  let error = $state<string | null>(null);
  // Reset the draft when a different plan is selected.
  let draftFor = $state(plan.path);
  $effect(() => {
    if (draftFor !== plan.path) {
      titleDraft = plan.title;
      draftFor = plan.path;
    }
  });

  const options = $derived(statusOptions(columnNames, plan.status));

  async function commit(key: "title" | "status" | "priority", value: string): Promise<void> {
    error = null;
    try {
      await onBeforeWrite();
      await backend.setPlanFrontmatterField(plan.path, key, value);
      // Optimistic: the confirming watcher push is ~3s away.
      patchPlanField(workspaceId, plan.path, key, value);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  function commitTitle(): void {
    const next = titleDraft.trim();
    if (!next || next === plan.title) {
      titleDraft = plan.title;
      return;
    }
    void commit("title", next);
  }
</script>

<div class="panel">
  <input
    class="title"
    bind:value={titleDraft}
    onblur={commitTitle}
    onkeydown={(e) => {
      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      else if (e.key === "Escape") titleDraft = plan.title;
    }}
  />
  <label>
    Status
    <select
      value={plan.status ?? ""}
      onchange={(e) => void commit("status", (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each options as option (option)}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </label>
  <label>
    Priority
    <select
      value={plan.priority ?? "none"}
      onchange={(e) => void commit("priority", (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if plan.parseWarning}
    <span class="warn">frontmatter issues</span>
  {/if}
  {#if error}
    <span class="error">{error}</span>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.8em;
    color: #999;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .title {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #eee;
    font-family: inherit;
    font-size: 1.1em;
    padding: 2px 6px;
    flex: 1 1 200px;
    min-width: 120px;
  }
  .title:hover,
  .title:focus {
    border-color: #444;
    background: #1e1e1e;
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
    font-family: inherit;
    padding: 1px 4px;
  }
  .warn {
    color: #d9a648;
  }
  .error {
    color: #e0a0a0;
  }
</style>
