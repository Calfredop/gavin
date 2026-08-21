<script lang="ts">
  import type { ConflictInfo } from "./git";
  import { resolveWhole, resolveDeleted } from "./gitState";
  import GitDiscardDialog from "./GitDiscardDialog.svelte";

  interface Props {
    workspaceId: string;
    conflict: ConflictInfo;
    locked: boolean;
  }
  let { workspaceId, conflict, locked }: Props = $props();

  const sentence = $derived.by(() => {
    const { ours, theirs } = conflict.labels;
    const p = conflict.path;
    switch (conflict.kind) {
      case "deleteModify":
        if (conflict.deletedBy === "both") return `Both ${ours} and ${theirs} deleted ${p}.`;
        return conflict.deletedBy === "ours" ? `${ours} deleted ${p}; ${theirs} modified it.` : `${theirs} deleted ${p}; ${ours} modified it.`;
      case "addedBoth":
        return `${ours} and ${theirs} both added ${p} with different contents.`;
      case "binary":
        return `${p} is binary and differs between ${ours} and ${theirs}.`;
      case "submodule":
        return `${p} is a submodule pointing at different commits on ${ours} and ${theirs}.`;
      default:
        return `${p} conflicts between ${ours} and ${theirs}.`;
    }
  });

  let confirm = $state<{ title: string; body: string; label: string; run: () => void } | null>(null);

  function ask(title: string, body: string, label: string, run: () => void): void {
    confirm = { title, body, label, run };
  }
  function go(): void {
    const c = confirm;
    confirm = null;
    c?.run();
  }
</script>

<div class="chooser">
  <p class="what">{sentence}</p>
  <div class="buttons">
    {#if conflict.kind === "deleteModify"}
      {#if conflict.deletedBy !== "both"}
        <button
          type="button"
          disabled={locked}
          onclick={() => ask(`Keep ${conflict.path}?`, `The version from ${conflict.deletedBy === "ours" ? conflict.labels.theirs : conflict.labels.ours} is kept and marked resolved.`, "Keep file", () => void resolveDeleted(workspaceId, true))}
        >Keep file</button>
      {/if}
      <button
        type="button"
        class="danger"
        disabled={locked}
        onclick={() => ask(`Delete ${conflict.path}?`, "The file is removed from the working tree and the deletion is marked resolved.", "Delete file", () => void resolveDeleted(workspaceId, false))}
      >Delete file</button>
    {:else}
      <button
        type="button"
        disabled={locked}
        onclick={() => ask(`Keep ${conflict.labels.ours}'s version?`, `${conflict.path} takes ${conflict.labels.ours}'s content and is marked resolved.`, "Keep ours", () => void resolveWhole(workspaceId, "ours"))}
      >Keep ours ({conflict.labels.ours})</button>
      <button
        type="button"
        disabled={locked}
        onclick={() => ask(`Keep ${conflict.labels.theirs}'s version?`, `${conflict.path} takes ${conflict.labels.theirs}'s content and is marked resolved.`, "Keep theirs", () => void resolveWhole(workspaceId, "theirs"))}
      >Keep theirs ({conflict.labels.theirs})</button>
    {/if}
  </div>
</div>

{#if confirm}
  <GitDiscardDialog title={confirm.title} body={confirm.body} offerSkip={false} confirmLabel={confirm.label} onConfirm={go} onCancel={() => (confirm = null)} />
{/if}

<style>
  .chooser {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    height: 100%;
    padding: 20px;
    font-family: monospace;
    color: #ccc;
  }
  .what {
    margin: 0;
    max-width: 60ch;
    text-align: center;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
  button {
    background: #2a3a4a;
    border: 1px solid #4a6a8a;
    border-radius: 6px;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
    padding: 6px 12px;
    cursor: pointer;
  }
  button.danger {
    background: #4a2020;
    border-color: #7a3030;
    color: #f0c0c0;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
