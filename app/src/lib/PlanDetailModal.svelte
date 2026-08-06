<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { PlanCardView } from "./planBoard";
  import type { Priority } from "./kanban";
  import * as backend from "./backend";
  import { patchPlanField } from "./gavinState";
  import { openPath } from "@tauri-apps/plugin-opener";

  interface Props {
    plan: PlanCardView;
    workspaceId: string;
    onClose: () => void;
  }
  let { plan, workspaceId, onClose }: Props = $props();

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
  let priority = $state<Priority>(plan.priority ?? "none");
  let errorMessage = $state<string | null>(null);

  // The one write control (D15): immediate write on change, optimistic
  // patch on success only.
  async function changePriority(): Promise<void> {
    errorMessage = null;
    try {
      await backend.setPlanFrontmatterField(plan.id, "priority", priority);
      patchPlanField(workspaceId, plan.id, "priority", priority);
    } catch (e) {
      errorMessage = String(e);
    }
  }

  async function openExternally(): Promise<void> {
    errorMessage = null;
    try {
      await openPath(plan.id);
    } catch (e) {
      errorMessage = `Couldn't open externally: ${e}`;
    }
  }
</script>

<Modal {onClose}>
  <div class="title">{plan.title}</div>
  <div class="meta">{plan.contextName} · {plan.fileName}</div>
  <div class="path">{plan.id}</div>
  {#if plan.parseWarning}
    <p class="warning">This plan's frontmatter has issues — status or priority may not be readable.</p>
  {/if}
  <div class="row">
    <span class="label">Status</span>
    <span>{plan.status ?? "(none — first column)"}</span>
  </div>
  <label class="row">
    <span class="label">Priority</span>
    <select bind:value={priority} onchange={changePriority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  <div class="actions">
    <button type="button" onclick={openExternally}>Open externally</button>
  </div>
  {#if errorMessage}
    <p class="warning">{errorMessage}</p>
  {/if}
</Modal>

<style>
  .title {
    font-size: 1.1em;
    margin-bottom: 4px;
  }
  .meta {
    color: #8bc98b;
    font-size: 0.85em;
  }
  .path {
    color: #888;
    font-size: 0.8em;
    word-break: break-all;
    user-select: text;
    margin: 6px 0 10px;
  }
  .warning {
    color: #d9a648;
    font-size: 0.85em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
  }
  .label {
    color: #999;
    width: 70px;
    flex: 0 0 auto;
  }
  select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
    font-family: monospace;
    padding: 2px 6px;
  }
  .actions {
    margin-top: 12px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
