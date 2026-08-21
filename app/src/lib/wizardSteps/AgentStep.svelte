<script lang="ts">
  import { agentProfilesStore, setAgentField } from "./../layoutState";
  import { gavinTrees } from "./../gavinState";
  import { resolveAgentConfig } from "./../settings";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const tree = $derived($gavinTrees[workspaceId]);
  const agentCfg = $derived(
    resolveAgentConfig(
      tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore
    )
  );

  let commandDraft = $state("");
  let seeded = $state(false);
  $effect(() => {
    if (!seeded && agentCfg.command) {
      commandDraft = agentCfg.command;
      seeded = true;
    }
  });

  async function continueStep(): Promise<void> {
    // Always written, even unchanged: the presence of [agent].command in
    // config.toml is what makes this step detectable (spec §3.2).
    await setAgentField(workspaceId, "command", commandDraft.trim() || agentCfg.command);
    onDone();
  }
</script>

<h3>Which agent?</h3>
<p class="hint">
  gavin writes the integration files for the agent you pick, and starts it with this command.
</p>

<label class="row">
  <span>Profile</span>
  <select
    value={agentCfg.profileId}
    onchange={(e) => void setAgentField(workspaceId, "profile", e.currentTarget.value)}
  >
    {#each $agentProfilesStore as profile (profile.id)}
      <option value={profile.id}>{profile.label}</option>
    {/each}
  </select>
</label>

<label class="row">
  <span>Command</span>
  <input bind:value={commandDraft} spellcheck="false" />
</label>

<div class="actions">
  <button type="button" onclick={() => void continueStep()}>Continue →</button>
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
    width: 80px;
    flex: 0 0 auto;
    color: #999;
  }
  .row input,
  .row select {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 260px;
  }
  .actions {
    display: flex;
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
