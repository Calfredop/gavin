<script lang="ts">
  import { editableCycle, saveAgentPause } from "../agentPauseState";
  import { pickPath } from "../picker";
  import {
    layoutState,
    agentProfilesStore,
    agentModelDefaultsStore,
    setAgentField,
    trustedAgentConfigs,
  } from "./../layoutState";
  import { resolveAgentConfig, agentFileFromPick } from "./../settings";
  import ConfigTrustNotice from "./../ConfigTrustNotice.svelte";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const agentCfg = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(workspaceId),
      $agentProfilesStore,
      $agentModelDefaultsStore
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

  let fileError = $state<string | null>(null);
  let picking = $state(false);

  /// Points the workspace at an instructions file the repo already has,
  /// BEFORE the next step writes anything. That ordering is the whole
  /// reason this row lives here and not beside the file in Settings: the
  /// Integration step merges gavin's block into whichever file is
  /// configured when it runs, so a repo with its own CLAUDE.md has to be
  /// able to say so first, or it ends up with a second one.
  ///
  /// Deliberately NOT the Settings panel's rename flow: that exists to
  /// move gavin's file to a new name, and picking an existing file is the
  /// opposite intent -- the file to keep is the one that was picked.
  async function pickAgentFile(): Promise<void> {
    if (!root) return;
    fileError = null;
    picking = true;
    try {
      const picked = await pickPath({
        directory: false,
        defaultPath: root,
        title: "Choose the agent instructions file",
      });
      // A cancelled dialog is not an error, and must not clear the
      // message from the pick before it.
      if (typeof picked !== "string") return;
      const result = agentFileFromPick(root, picked);
      if ("error" in result) {
        fileError = result.error;
        return;
      }
      if (result.file !== agentCfg.file) await setAgentField(workspaceId, "file", result.file);
    } catch (e) {
      fileError = String(e instanceof Error ? e.message : e);
    } finally {
      picking = false;
    }
  }

  async function continueStep(): Promise<void> {
    // Always written, even unchanged: the presence of [agent].command in
    // config.toml is what makes this step detectable (spec §3.2).
    await setAgentField(workspaceId, "command", commandDraft.trim() || agentCfg.command);
    onDone();
  }

  /// The app-wide cycle is what the wizard offers: a workspace created
  /// here has no override, so switching this on sets the app default that
  /// every workspace then inherits. Turning it off later per workspace is
  /// Settings' job, not the wizard's.
  const pauseCycle = $derived(editableCycle(null));

  /// Whether the profile being chosen can be asked about its limits, so
  /// the copy does not promise a hold gavin cannot perform.
  const probedHere = $derived(
    $agentProfilesStore.some((p) => p.id === agentCfg.profileId && p.usageProbe)
  );

  async function togglePause(enabled: boolean): Promise<void> {
    await saveAgentPause({ ...pauseCycle, enabled });
  }
</script>

<h3>Which agent?</h3>
<p class="hint">
  gavin writes the integration files for the agent you pick, and starts it with this command.
</p>

<!-- The wizard is where a freshly cloned repo is met for the first time,
     so this is the earliest place the human can see that config.toml
     named a command and gavin is not running it. The Command field below
     shows the resolved one, which is gavin's own until they approve. -->
<ConfigTrustNotice {workspaceId} />

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

<div class="row">
  <span>Instructions</span>
  <!-- The &lrm; bookends are load-bearing — see .path below. -->
  <span class="path" title={root ? `${root}/${agentCfg.file}` : agentCfg.file}
    >&lrm;{agentCfg.file}&lrm;</span
  >
  <button type="button" class="pick" disabled={!root || picking} onclick={() => void pickAgentFile()}
    >Pick…</button
  >
</div>
{#if fileError}
  <p class="warn">{fileError}</p>
{:else}
  <p class="hint indent">
    The next step merges gavin's block into this file. Pick… points the workspace at the CLAUDE.md
    or AGENTS.md this repo already has, instead of starting a second one.
  </p>
{/if}

<label class="row">
  <span>Pause</span>
  <!-- Off by default, like every consent-shaped setting in gavin: an
       existing workspace must not start pausing because it was updated.
       Offered HERE because a subscription limit is a fact about the agent
       being chosen one field above, not about the repo. -->
  <span class="check">
    <input
      type="checkbox"
      checked={pauseCycle.enabled}
      onchange={(e) => void togglePause(e.currentTarget.checked)}
    />
    Sit out {pauseCycle.pauseMinutes} minutes every {Math.round(pauseCycle.periodMinutes / 60)} hours
  </span>
</label>
<p class="hint indent">
  Keeps a rail from spending the tail of a subscription window while nobody is watching.
  Nothing already running is interrupted — only new starts wait. Settings can change the
  numbers later{probedHere ? ", and gavin will also hold when this agent reports a full window" : ""}.
</p>

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
  /* Lines up under the control, not under the label, so it reads as
     belonging to the row above it rather than to the step. */
  .hint.indent {
    margin: -4px 0 10px 90px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.85em;
  }
  .warn {
    margin: -4px 0 10px 90px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Ellipsis on the LEFT, as in HubFilePicker: a path's tail is its
       informative end. The &lrm; bookends keep the slashes inside the
       LTR run so a leading one doesn't detach and park on the right. */
    direction: rtl;
    color: #eee;
  }
  .pick {
    background: #2f2f2f;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    cursor: pointer;
  }
  .pick:disabled {
    opacity: 0.4;
    cursor: default;
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
    /* A preferred width, not a floor: the row has to fit whatever width
       the modal ends up with, and a 260px floor beside an 80px label is
       what pushed the wizard past its panel. */
    flex: 0 1 260px;
    min-width: 0;
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
