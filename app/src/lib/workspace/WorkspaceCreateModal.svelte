<script lang="ts">
  import { layoutState, setWorkspaceColor } from "$lib/core/layoutState";
  import { DEFAULT_ACCENT } from "$lib/core/settings";
  import WorkspaceRootControl from "$lib/workspace/WorkspaceRootControl.svelte";
  import ColourPicker from "$lib/core/ColourPicker.svelte";
  import Modal from "$lib/core/Modal.svelte";

  interface Props {
    workspaceId: string;
    /// Called when the user finishes; the caller opens the wizard.
    onDone: () => void;
    /// Called when the user backs out. The workspace stays -- unrooted,
    /// exactly what creation produced before this modal existed.
    onSkip: () => void;
  }
  let { workspaceId, onDone, onSkip }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
</script>

{#if ws}
  <Modal onClose={onSkip}>
    <h2>Set up “{ws.name}”</h2>
    <p class="detail">
      Pick the folder this workspace works in. Everything here can be changed later in Settings.
    </p>

    <div class="row">
      <span>Folder</span>
      <WorkspaceRootControl workspace={ws} variant="settings" />
    </div>
    <div class="row">
      <span>Colour</span>
      <ColourPicker
        value={ws.color ?? DEFAULT_ACCENT}
        onChange={(c) => void setWorkspaceColor(workspaceId, c)}
      />
    </div>

    <div class="actions">
      <button type="button" onclick={onSkip}>Skip setup</button>
      <!-- Every later step writes under the root, so there is nothing to
           continue to without one. -->
      <button type="button" disabled={!ws.rootPath} onclick={onDone}>Continue →</button>
    </div>
  </Modal>
{/if}

<style>
  h2 {
    margin: 0 0 6px;
    font-size: 1em;
    font-family: monospace;
    color: #eee;
  }
  .detail {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-family: monospace;
    font-size: 0.85em;
    color: #ccc;
  }
  .row > span:first-child {
    width: 70px;
    flex: 0 0 auto;
    color: #999;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
