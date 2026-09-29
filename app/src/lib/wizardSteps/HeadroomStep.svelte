<script lang="ts">
  import { onMount } from "svelte";
  import {
    agentDefaultsStore,
    agentModelDefaultsStore,
    agentProfilesStore,
    daemonCompat,
    headroomDefault,
    layoutState,
    markHeadroomAsked,
    setWorkspaceHeadroom,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import { resolveAgentConfig } from "$lib/core/settings";
  import { apiFamilyOf } from "$lib/agents/apiFamily";
  import { ownHeadroom, resolveHeadroom } from "$lib/agents/compression";
  import { compressionSwitchBlocked } from "$lib/agents/compressionDriver";
  import HeadroomControls from "$lib/agents/HeadroomControls.svelte";
  import {
    HEADROOM_RESIDUAL_NOTE,
    headroomFromSelect,
    headroomOptions,
    headroomStepOffers,
    headroomSwitchView,
    headroomToSelect,
    type HeadroomReading,
  } from "$lib/agents/headroomSetup";
  import { watchHeadroom } from "$lib/agents/headroomState";

  interface Props {
    workspaceId: string;
    /// Owned by the wizard, because the stepper's tick for this step is
    /// derived from the same reading.
    reading: HeadroomReading | undefined;
    onDone: () => void;
  }
  let { workspaceId, reading, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const agent = $derived(
    resolveAgentConfig($trustedAgentConfigs(workspaceId), $agentProfilesStore, $agentModelDefaultsStore)
  );
  const offers = $derived(headroomStepOffers(reading));
  const inherited = $derived(resolveHeadroom(undefined, $headroomDefault));
  const switchView = $derived(
    headroomSwitchView({
      reading,
      switchBlocked: compressionSwitchBlocked($daemonCompat),
      profileId: agent.profileId,
      customApiFamily: apiFamilyOf($agentDefaultsStore),
    })
  );

  // Live while the step is on screen: an Install started here is followed
  // to the end, and the switch appears the moment Headroom is Verified.
  onMount(() => watchHeadroom());

  /// Picking a side acts at once, like the Settings tab's own switch --
  /// there is no separate Save here.
  function pick(value: string): void {
    void setWorkspaceHeadroom(workspaceId, headroomFromSelect(value));
  }

  /// Continue records that the question was PUT, which is the whole of
  /// this step's evidence: off, the default, is a legitimate answer, and
  /// indistinguishable on disk from nobody having decided. So it marks
  /// even when nothing was touched, as the Review step does -- and even
  /// with Headroom not installed, where continuing is "not now".
  async function done(): Promise<void> {
    await markHeadroomAsked(workspaceId);
    onDone();
  }
</script>

<h3>Headroom</h3>
<p class="hint">
  Headroom compresses what your agents send their model — tool output, logs, file reads — so the
  same work spends less of a subscription's limit. gavin installs a version it has tested and runs
  it for you. Optional, and off unless you turn it on: here, or later on the workspace's Settings
  tab.
</p>

{#if reading === undefined}
  <p class="hint">Checking…</p>
{:else}
  <div class="controls">
    <HeadroomControls {reading} />
  </div>

  {#if offers.switch && ws}
    <div class="row">
      <span>Compress this workspace</span>
      <select
        value={headroomToSelect(ownHeadroom(ws))}
        disabled={switchView.disabled}
        onchange={(e) => pick(e.currentTarget.value)}
      >
        {#each headroomOptions(inherited) as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
    {#each switchView.notes as note (note)}
      <p class="warn">{note}</p>
    {/each}
    <p class="hint small">{HEADROOM_RESIDUAL_NOTE}</p>
  {/if}

  <div class="actions">
    <button type="button" onclick={() => void done()}>Continue →</button>
  </div>
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
  .hint.small {
    margin-top: 8px;
  }
  .controls {
    font-size: 0.8em;
    margin-bottom: 16px;
  }
  .warn {
    margin: 8px 0 0;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 10px 12px;
    color: #ccc;
    font-family: monospace;
  }
  .row select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 4px 6px;
    font-family: monospace;
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
</style>
