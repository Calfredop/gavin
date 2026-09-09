<script lang="ts">
  /// AG-07's disclosure: a workspace's target MCP config already names
  /// servers gavin did not add. Shared between the setup wizard's
  /// Integration step and the Settings agent-integration row -- the two
  /// places `setupAgentIntegration` runs from -- so the two choices read
  /// identically wherever they appear.
  import type { ForeignMcpServer } from "$lib/backend";
  import { mcpForeignNotice } from "$lib/workspace/mcpServerTrust";

  interface Props {
    servers: ForeignMcpServer[];
    isolateRefusal?: string;
    busy?: boolean;
    onKeep: () => void;
    onIsolate: () => void;
  }
  let { servers, isolateRefusal, busy = false, onKeep, onIsolate }: Props = $props();
</script>

<div class="mcp-foreign">
  <p class="hint">{mcpForeignNotice(servers)} Read them before choosing what gavin does next.</p>
  <ul class="rows">
    {#each servers as s (s.name)}
      <li>
        <span class="name">{s.name}</span>
        <code>{s.command}{s.args.length ? " " + s.args.join(" ") : ""}</code>
      </li>
    {/each}
  </ul>
  <div class="actions">
    <button type="button" disabled={busy} onclick={onKeep}>Keep them, add gavin's own</button>
    <button
      type="button"
      class="isolate"
      disabled={busy || Boolean(isolateRefusal)}
      title={isolateRefusal}
      onclick={onIsolate}
    >
      Give gavin its own file
    </button>
  </div>
  {#if isolateRefusal}
    <p class="reason">{isolateRefusal}</p>
  {/if}
</div>

<style>
  .mcp-foreign {
    border: 1px solid var(--border-warning);
    background: var(--surface-warning);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: monospace;
    font-size: 0.8em;
  }
  .hint {
    margin: 0 0 10px;
    color: var(--warning-text);
  }
  .rows {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rows li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    color: var(--text-muted);
  }
  .rows code {
    display: block;
    overflow-x: auto;
    white-space: pre;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-sunken);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .reason {
    margin: 8px 0 0;
    color: var(--text-muted);
  }
</style>
