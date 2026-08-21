<script lang="ts">
  import { layoutState, startMainAgent, switchWorkspaceView } from "./../layoutState";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const running = $derived(Boolean(ws?.mainSessionId));

  async function launch(): Promise<void> {
    await startMainAgent(workspaceId);
    await switchWorkspaceView(workspaceId, "home");
    onDone();
  }

  async function openHome(): Promise<void> {
    await switchWorkspaceView(workspaceId, "home");
    onDone();
  }
</script>

<h3>{running ? "Your agent is already running" : "Start your agent"}</h3>
<p class="hint">
  {running
    ? "An earlier step started it. It's on the Home tab."
    : "Runs at the workspace root. Nothing starts on its own — this is the only step that spends money."}
</p>

<div class="actions">
  <button type="button" onclick={onDone}>Not now</button>
  {#if running}
    <button type="button" onclick={() => void openHome()}>Open it →</button>
  {:else}
    <button type="button" onclick={() => void launch()}>Start agent →</button>
  {/if}
</div>

<style>
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
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
</style>
