<script lang="ts">
  import { agentModelDefaultsStore, agentProfilesStore, layoutState, trustedAgentConfigs } from "$lib/layoutState";
  import { resolveAgentConfig } from "$lib/settings";
  import * as backend from "$lib/backend";
  import SuperpowersControls from "$lib/SuperpowersControls.svelte";
  import type { SuperpowersMark, SuperpowersStatus } from "$lib/superpowers";

  interface Props {
    workspaceId: string;
    /// Owned by the wizard, because the stepper's tick for this step is
    /// derived from the same two values.
    status: SuperpowersStatus | undefined;
    mark: SuperpowersMark | undefined;
    onChanged: () => void;
    onDone: () => void;
  }
  let { workspaceId, status, mark, onChanged, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const agentCommand = $derived(
    resolveAgentConfig($trustedAgentConfigs(workspaceId), $agentProfilesStore, $agentModelDefaultsStore)
      .command
  );

  let error = $state<string | null>(null);

  /// "Not now" is a decision, and recording it is what stops the Home
  /// banner asking again (S6). Continuing without it leaves the step
  /// genuinely unfinished, which is the honest state for someone who
  /// just clicked past.
  async function notNow(): Promise<void> {
    if (!ws?.rootPath) {
      onDone();
      return;
    }
    error = null;
    try {
      await backend.setSuperpowersMark(ws.rootPath, "skipped");
    } catch (e) {
      error = String(e);
      return;
    }
    onChanged();
    onDone();
  }
</script>

<h3>Superpowers</h3>
<p class="hint">
  A plugin that gives your agent process skills: brainstorm before building, write the plan before
  the code, debug by narrowing rather than guessing. It is what makes gavin's plan and debug flows
  deep rather than nominal — cards get developed properly, and a stuck rail gets diagnosed instead
  of retried. Optional: gavin works without it.
</p>

{#if status}
  <SuperpowersControls rootPath={ws?.rootPath ?? null} {agentCommand} {status} {mark} {onChanged} />
  {#if error}
    <p class="warn">{error}</p>
  {/if}
  <div class="actions">
    <button type="button" class="ghost" onclick={() => void notNow()}>Not now</button>
    <button type="button" onclick={onDone}>Continue →</button>
  </div>
{:else}
  <p class="hint">Checking…</p>
{/if}

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
  .warn {
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
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
  .actions button.ghost {
    background: none;
    color: #888;
  }
</style>
