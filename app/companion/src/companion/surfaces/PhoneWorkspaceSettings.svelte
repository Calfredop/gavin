<script lang="ts">
  // One workspace's settings, on a phone: ticket 04's half of the
  // workspace record (ADR 0006), written through `set_workspace_settings`,
  // and its agent's model and effort, written to its config.toml as the
  // desk's panel writes them. Never its layout -- nothing here moves a tab
  // at the desk. What the desk's panel has and this does not is the desk's
  // alone (phoneSettings.ts).
  import { onMount } from "svelte";
  import {
    agentDefaultsStore,
    agentModelDefaultsStore,
    agentProfilesStore,
    autoCommitDefault,
    daemonCompat,
    renameWorkspace,
    requireReviewDefault,
    setAgentDefaults,
    setAgentField,
    setWorkspaceAutoCommit,
    setWorkspaceColor,
    setWorkspaceCustomProfiles,
    dropWorkspaceProfileRefs,
    setWorkspaceFlag,
    setWorkspaceFontSize,
    setWorkspaceRequireReview,
    terminalFontSizeDefault,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import {
    ADD_TAB,
    ADD_TAB_HINT,
    GENERAL_TAB,
    addCustomProfile,
    agentsHubTabs,
    profileOptionLabel,
    validAgentsTab,
    type AgentsHubTab,
  } from "$lib/agents/agentsHub";
  import AgentsHubTabs from "$lib/agents/AgentsHubTabs.svelte";
  import CustomsEditor from "$lib/agents/CustomsEditor.svelte";
  import { effortOptions, modelOptions } from "$lib/agents/agentModel";
  import {
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
    resolveRequireReview,
  } from "$lib/cards/cardReview";
  import ColourPicker from "$lib/core/ColourPicker.svelte";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { gavinTrees } from "$lib/core/gavinState";
  import { DEFAULT_ACCENT, fieldCommit, mergeAgentProfiles, resolveAgentConfig } from "$lib/core/settings";
  import type { Workspace } from "$lib/core/workspace";
  import { autoCommitFromSelect, autoCommitOptions, autoCommitToSelect, resolveAutoCommit } from "$lib/git/autoCommit";
  import { fontSizeOptions, resolveTerminalFontSize } from "$lib/terminal/terminalFont";
  import { dismissSaveProblem, loadSettings, saveProblem, saveSetting } from "$companion/state/workstation";
  import PhoneAgentPrimary from "$companion/surfaces/PhoneAgentPrimary.svelte";
  import PhoneModelPicker from "$companion/surfaces/PhoneModelPicker.svelte";
  import PhoneSetting from "$companion/surfaces/PhoneSetting.svelte";
  import PhoneSettingsGroup from "$companion/surfaces/PhoneSettingsGroup.svelte";
  import PhoneToggle from "$companion/surfaces/PhoneToggle.svelte";
  import { folderLine, workspaceAgentView } from "$companion/surfaces/phoneSettings";

  interface Props {
    workspace: Workspace;
  }
  let { workspace: ws }: Props = $props();

  onMount(() => {
    void loadSettings();
  });

  const id = $derived(ws.id);

  // --- workspace ----------------------------------------------------------
  // A draft, so a push from the desk cannot overwrite the name mid-word.
  let nameDraft = $state("");
  let naming = $state(false);
  $effect(() => {
    const name = ws.name;
    if (!naming) nameDraft = name;
  });

  /// A workspace cannot be called nothing: an emptied field is a slip, and
  /// the name stands until something is typed -- the desk's rule.
  function commitName(): void {
    naming = false;
    const next = fieldCommit(nameDraft, ws.name, { empty: "keep" });
    if (next.kind === "write") void saveSetting(() => renameWorkspace(id, next.value));
    else nameDraft = ws.name;
  }

  // --- what it inherits ---------------------------------------------------
  const inheritedFontSize = $derived(resolveTerminalFontSize(undefined, $terminalFontSizeDefault));
  const inheritedAutoCommit = $derived(resolveAutoCommit(undefined, $autoCommitDefault));
  const inheritedRequireReview = $derived(resolveRequireReview(undefined, $requireReviewDefault));

  // --- agent --------------------------------------------------------------
  const rootContext = $derived($gavinTrees[id]?.contexts.find((c) => c.kind === "root"));
  const profiles = $derived(
    mergeAgentProfiles(
      $agentProfilesStore,
      $agentDefaultsStore.customProfiles ?? [],
      ws.customProfiles ?? []
    )
  );
  const resolved = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(id),
      profiles,
      $agentModelDefaultsStore,
      undefined,
      undefined,
      $agentDefaultsStore.agentEfforts,
      $agentDefaultsStore.defaultAgent
    )
  );
  const agent = $derived(
    workspaceAgentView({
      resolved,
      own: rootContext?.agent,
      profiles,
      modelDefaults: $agentModelDefaultsStore,
      effortDefaults: $agentDefaultsStore.agentEfforts,
    })
  );
  const modelBlocked = $derived(featureBlockedReason($daemonCompat, "agentModel"));
  const effortBlocked = $derived(featureBlockedReason($daemonCompat, "agentEffort"));
  const autoResumeBlocked = $derived(featureBlockedReason($daemonCompat, "autoResume"));
  const apiFamilyBlocked = $derived(featureBlockedReason($daemonCompat, "customApiFamily"));

  let agentsTab = $state<AgentsHubTab>(GENERAL_TAB);
  let newLocalCustomName = $state("");
  const agentsTabs = $derived(agentsHubTabs(profiles, ADD_TAB_HINT.workspace));
  $effect(() => {
    const valid = validAgentsTab(agentsTab, profiles, true);
    if (valid !== agentsTab) agentsTab = valid;
  });

  function addLocalCustom(): void {
    const next = addCustomProfile(ws.customProfiles ?? [], newLocalCustomName.trim() || "Custom", {
      local: true,
    });
    const added = next.find((p) => !(ws.customProfiles ?? []).some((o) => o.id === p.id));
    void saveSetting(() => setWorkspaceCustomProfiles(id, next)).then(() => {
      newLocalCustomName = "";
      if (added) agentsTab = added.id;
    });
  }

</script>

<div class="settings">
  {#if $saveProblem}
    <div class="problem" role="alert">
      <p>That change was not saved: {$saveProblem}</p>
      <button type="button" onclick={dismissSaveProblem}>Dismiss</button>
    </div>
  {/if}

  <PhoneSettingsGroup title="Workspace">
    <PhoneSetting label="Name" control="ws-name">
      <input
        id="ws-name"
        bind:value={nameDraft}
        autocomplete="off"
        onfocus={() => (naming = true)}
        onblur={commitName}
        onkeydown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </PhoneSetting>
    <PhoneSetting label="Colour">
      <ColourPicker
        value={ws.color ?? DEFAULT_ACCENT}
        onChange={(colour) => void saveSetting(() => setWorkspaceColor(id, colour))}
      />
    </PhoneSetting>
    <PhoneSetting label="Folder" hint="Where it works. Pointing it at another folder is done at the desk.">
      <span class="folder"><bdi>{folderLine(ws)}</bdi></span>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Terminal">
    <PhoneSetting label="Font size" control="ws-font-size" hint="This workspace's terminals only. Default follows the Workstation's size.">
      <select
        id="ws-font-size"
        value={ws.terminalFontSize === undefined ? "" : String(ws.terminalFontSize)}
        onchange={(e) => {
          const raw = e.currentTarget.value;
          void saveSetting(() => setWorkspaceFontSize(id, raw === "" ? null : Number(raw)));
        }}
      >
        {#each fontSizeOptions(inheritedFontSize, ws.terminalFontSize) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Cards">
    <PhoneSetting
      label="Auto commit"
      control="ws-auto-commit"
      hint="Whether a new card here starts asking its agent to commit when it finishes."
    >
      <select
        id="ws-auto-commit"
        value={autoCommitToSelect(ws.autoCommit)}
        onchange={(e) => {
          const value = autoCommitFromSelect(e.currentTarget.value);
          void saveSetting(() => setWorkspaceAutoCommit(id, value));
        }}
      >
        {#each autoCommitOptions(inheritedAutoCommit) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
    <PhoneSetting
      label="Require review"
      control="ws-require-review"
      hint="Whether a card's first Run here asks for a deliberate yes to what it hands the agent."
    >
      <select
        id="ws-require-review"
        value={requireReviewToSelect(ws.requireReview)}
        onchange={(e) => {
          const value = requireReviewFromSelect(e.currentTarget.value);
          void saveSetting(() => setWorkspaceRequireReview(id, value));
        }}
      >
        {#each requireReviewOptions(inheritedRequireReview) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup
    title="Agents"
    intro="General settings plus one tab per agent — the same Agents hub as at the desk."
  >
    <AgentsHubTabs tabs={agentsTabs} tab={agentsTab} onTab={(t) => (agentsTab = t)} />

    {#if agentsTab === GENERAL_TAB}
      {#if !ws.rootPath}
        <p class="note">This workspace is bound to no folder, so it has no agent to configure.</p>
      {:else if rootContext?.configWarning}
        <p class="warn">This folder's config.toml can't be read. Fix it at the desk to change the agent here.</p>
      {:else}
        <PhoneSetting label="Profile" hint="Changing the agent sets it up again, which is done at the desk.">
          <span class="value"
            >{profileOptionLabel({
              label: agent.profileLabel,
              local: profiles.find((p) => p.id === resolved.profileId)?.local,
            })}</span
          >
        </PhoneSetting>
      {/if}

      <p class="note">
        Everything below is {agent.profileLabel}'s configuration in this workspace — the same settings its
        tab shows. A setting this workspace has not made its own follows the Workstation's.
      </p>
      <PhoneAgentPrimary
        scope="workspace"
        workspaceId={id}
        primaryId={resolved.profileId}
        label={agent.profileLabel}
        {profiles}
      />
    {:else if agentsTab === resolved.profileId}
      {#if !ws.rootPath}
        <p class="note">This workspace is bound to no folder, so it has no agent to configure.</p>
      {:else if rootContext?.configWarning}
        <p class="warn">This folder's config.toml can't be read. Fix it at the desk to change the agent here.</p>
      {:else}
        {#if agent.modelFlag}
          <PhoneSetting label="Model" control="ws-model" warn={modelBlocked}>
            <PhoneModelPicker
              id="ws-model"
              options={modelOptions({ modelFlag: agent.modelFlag, models: agent.models }, agent.inheritedModel)}
              own={agent.ownModel}
              presets={agent.models}
              placeholder="model name"
              disabled={modelBlocked !== null}
              onPick={(model) => void saveSetting(() => setAgentField(id, "model", model))}
            />
          </PhoneSetting>
        {:else}
          <p class="note">gavin has no model flag for {agent.profileLabel}, so it cannot put a model on it.</p>
        {/if}
        {#if agent.effortFlag}
          <PhoneSetting label="Effort" control="ws-effort" warn={effortBlocked}>
            <PhoneModelPicker
              id="ws-effort"
              options={effortOptions({ effortFlag: agent.effortFlag, efforts: agent.efforts }, agent.inheritedEffort)}
              own={agent.ownEffort}
              presets={agent.efforts}
              placeholder="effort"
              disabled={effortBlocked !== null}
              onPick={(effort) => void saveSetting(() => setAgentField(id, "effort", effort))}
            />
          </PhoneSetting>
        {/if}
      {/if}

      <PhoneAgentPrimary
        scope="workspace"
        workspaceId={id}
        primaryId={resolved.profileId}
        label={agent.profileLabel}
        {profiles}
      />
    {:else if agentsTab === ADD_TAB}
      <PhoneSetting label="Add local custom" control="ws-new-local-custom" hint={ADD_TAB_HINT.workspace}>
        <input
          id="ws-new-local-custom"
          spellcheck="false"
          placeholder="New local custom name"
          bind:value={newLocalCustomName}
          onkeydown={(e) => {
            if (e.key === "Enter") addLocalCustom();
          }}
        />
        <button type="button" class="add-custom" onclick={addLocalCustom}>Add local custom</button>
      </PhoneSetting>
    {:else}
      {#if (ws.customProfiles ?? []).some((p) => p.id === agentsTab)}
        <div class="desk-part">
          <CustomsEditor
            local
            profiles={(ws.customProfiles ?? []).filter((p) => p.id === agentsTab)}
            apiFamilyBlocked={apiFamilyBlocked}
            onChange={(next) => {
              const before = (ws.customProfiles ?? []).filter((p) => p.id === agentsTab);
              const others = (ws.customProfiles ?? []).filter((p) => p.id !== agentsTab);
              void saveSetting(() => setWorkspaceCustomProfiles(id, [...others, ...next]));
              // A deleted local leaves everything keyed by it dangling —
              // its fallback chain (and any chain naming it), complexity
              // table (and rows routing to it), pause cycle, prompt lines
              // and CLI args, plus its walk-at threshold. Clean all of it,
              // exactly as the app-wide delete does.
              for (const p of before.filter((p) => !next.some((n) => n.id === p.id))) {
                void saveSetting(() => dropWorkspaceProfileRefs(id, p.id));
                if (($agentDefaultsStore.fallbackThresholds ?? {})[p.id] != null) {
                  const fallbackThresholds = { ...$agentDefaultsStore.fallbackThresholds };
                  delete fallbackThresholds[p.id];
                  void saveSetting(() => setAgentDefaults({ ...$agentDefaultsStore, fallbackThresholds }));
                }
              }
            }}
          />
        </div>
      {/if}
      {@const tabProfile = profiles.find((p) => p.id === agentsTab)}
      {#if tabProfile}
        <PhoneAgentPrimary
          scope="workspace"
          workspaceId={id}
          primaryId={tabProfile.id}
          label={tabProfile.label}
          {profiles}
        />
      {/if}
    {/if}
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Unattended recovery">
    <PhoneToggle
      label="Resume a broken card run by itself"
      checked={ws.autoResumeRuns ?? false}
      disabled={autoResumeBlocked !== null}
      warn={autoResumeBlocked}
      hint="When an agent started from a card stops because its connection died, the machine slept or the API was down, gavin reopens that conversation once."
      onChange={(on) => void saveSetting(() => setWorkspaceFlag(id, "autoResumeRuns", on))}
    />
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Notifications at the desk">
    <PhoneToggle
      label="When a session needs input"
      checked={ws.notifyNeedsInput ?? true}
      onChange={(on) => void saveSetting(() => setWorkspaceFlag(id, "notifyNeedsInput", on))}
    />
    <PhoneToggle
      label="When a session finishes working"
      checked={ws.notifyFinished ?? true}
      onChange={(on) => void saveSetting(() => setWorkspaceFlag(id, "notifyFinished", on))}
    />
  </PhoneSettingsGroup>
</div>

<style>
  .settings {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: calc(24px + env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  .problem {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-danger);
    background: var(--surface-danger);
    color: var(--danger-text);
    font-size: 0.8125rem;
  }
  .problem p {
    flex: 1 1 auto;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .problem button {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
  }
  .folder,
  .value {
    min-width: 0;
    color: var(--text);
    font-family: monospace;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .note,
  .warn {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .note {
    color: var(--text-subtle);
  }
  .warn {
    color: var(--warning-text);
  }
  /* The desk's own components size their text in `em`, for a desk panel's
     smaller type; under a phone's 16px body their hints would read larger
     than every other hint here. */
  .desk-part {
    font-size: 0.8125rem;
  }
  .add-custom {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font: inherit;
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
