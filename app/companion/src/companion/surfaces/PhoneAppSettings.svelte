<script lang="ts">
  // The Workstation's own settings and its agents' configuration, on a
  // phone. The desk's settings page draws these through the same stores,
  // writers and option lists; what it has and this does not is the desk's
  // alone (phoneSettings.ts says which, and why). Every write goes
  // through `saveSetting`, which says on this screen when one failed.
  import { onMount } from "svelte";
  import { Monitor, Moon, Sun } from "@lucide/svelte";
  import {
    agentDefaultsStore,
    agentModelDefaultsStore,
    agentProfilesStore,
    autoCommitDefault,
    daemonCompat,
    gitTrackingDefault,
    requireReviewDefault,
    setAgentDefaults,
    setAgentModelDefault,
    setAutoCommitDefault,
    setGitTrackingDefault,
    setRequireReviewDefault,
    setTerminalFontSizeDefault,
    terminalFontSizeDefault,
  } from "$lib/core/layoutState";
  import { sanitizeFallbackThreshold } from "$lib/agents/agentFallback";
  import {
    APP_AGENTS_TABS,
    isCustomProfileId,
    type AppAgentsTab,
  } from "$lib/agents/agentsHub";
  import AgentsHubTabs from "$lib/agents/AgentsHubTabs.svelte";
  import CustomsEditor from "$lib/agents/CustomsEditor.svelte";
  import { effortOptions, modelOptions } from "$lib/agents/agentModel";
  import { mergeAgentProfiles } from "$lib/core/settings";
  import { DEFAULT_CYCLE, MIN_PERIOD_MINUTES, validateCycle, type PauseCycle } from "$lib/agents/agentPause";
  import { agentPauseStore, saveAgentPause } from "$lib/agents/agentPauseState";
  import { ceilingFrom, type LaunchConfig } from "$lib/agents/launchGate";
  import { launchConfigStore, saveLaunchConfig } from "$lib/agents/launchQueue";
  import ComplexityTable from "$lib/cards/ComplexityTable.svelte";
  import { withAgentEffort, type Complexity, type ComplexityAgent } from "$lib/cards/complexity";
  import {
    DEFAULT_REQUIRE_REVIEW,
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
  } from "$lib/cards/cardReview";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import {
    DEFAULT_AUTO_COMMIT,
    autoCommitFromSelect,
    autoCommitOptions,
    autoCommitToSelect,
  } from "$lib/git/autoCommit";
  import { resolveGitTracking } from "$lib/git/gitTracking";
  import { DEFAULT_TERMINAL_FONT_SIZE, fontSizeOptions } from "$lib/terminal/terminalFont";
  import type { ThemePref } from "$lib/ui/theme";
  import { themeState } from "$lib/ui/themeState.svelte";
  import FallbackChainEditor from "$lib/workspace/FallbackChainEditor.svelte";
  import { dismissSaveProblem, loadSettings, saveProblem, saveSetting } from "$companion/state/workstation";
  import PhoneModelPicker from "$companion/surfaces/PhoneModelPicker.svelte";
  import PhoneSetting from "$companion/surfaces/PhoneSetting.svelte";
  import PhoneSettingsGroup from "$companion/surfaces/PhoneSettingsGroup.svelte";
  import PhoneToggle from "$companion/surfaces/PhoneToggle.svelte";

  onMount(() => {
    void loadSettings();
  });

  const THEMES: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
    { pref: "system", label: "System", icon: Monitor },
    { pref: "light", label: "Light", icon: Sun },
    { pref: "dark", label: "Dark", icon: Moon },
  ];

  /// Built-ins ∪ app-wide customs (the Rust table alone has no named customs).
  const allProfiles = $derived(
    mergeAgentProfiles($agentProfilesStore, $agentDefaultsStore.customProfiles ?? [])
  );
  const modelProfiles = $derived(allProfiles.filter((p) => p.modelFlag || isCustomProfileId(p.id)));
  const effortProfiles = $derived(allProfiles.filter((p) => p.effortFlag || isCustomProfileId(p.id)));
  const apiFamilyBlocked = $derived(featureBlockedReason($daemonCompat, "customApiFamily"));

  let agentsTab = $state<AppAgentsTab>("defaults");

  /// The app-wide cycle, or the shipped default while there is none: the
  /// fields need values, and saving is what turns the default into one.
  const cycle = $derived($agentPauseStore ?? { ...DEFAULT_CYCLE, anchorMs: 0 });
  const cycleError = $derived(cycle.enabled ? validateCycle(cycle) : null);
  const launch = $derived($launchConfigStore);

  function editCycle(patch: Partial<PauseCycle>): void {
    const next = { ...cycle, ...patch };
    // An unusable cycle stays on screen, so the message can explain it,
    // and is not saved until it is usable again -- the desk's rule.
    if (next.enabled && validateCycle(next)) {
      agentPauseStore.set(next);
      return;
    }
    void saveSetting(() => saveAgentPause(next));
  }

  function editLaunch(patch: Partial<LaunchConfig>): void {
    void saveSetting(() => saveLaunchConfig({ ...launch, ...patch }));
  }

  function setComplexity(level: Complexity, entry: ComplexityAgent | null): void {
    const complexity = { ...$agentDefaultsStore.complexity };
    if (entry) complexity[level] = entry;
    else delete complexity[level];
    void saveSetting(() => setAgentDefaults({ ...$agentDefaultsStore, complexity }));
  }
</script>

<div class="settings">
  {#if $saveProblem}
    <div class="problem" role="alert">
      <p>That change was not saved: {$saveProblem}</p>
      <button type="button" onclick={dismissSaveProblem}>Dismiss</button>
    </div>
  {/if}

  <PhoneSettingsGroup title="Appearance">
    <PhoneSetting label="Theme" hint="The Workstation's own theme: the desk and every Device draw it.">
      <div class="segments" role="group" aria-label="Theme">
        {#each THEMES as theme (theme.pref)}
          <button
            type="button"
            class="segment"
            class:on={themeState.pref === theme.pref}
            aria-pressed={themeState.pref === theme.pref}
            onclick={() => void saveSetting(() => themeState.setPref(theme.pref))}
          >
            <theme.icon size={16} />
            <span>{theme.label}</span>
          </button>
        {/each}
      </div>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Terminal">
    <PhoneSetting
      label="Font size"
      control="app-font-size"
      hint="Every terminal in every workspace, unless the workspace sets a size of its own."
    >
      <select
        id="app-font-size"
        value={$terminalFontSizeDefault === null ? "" : String($terminalFontSizeDefault)}
        onchange={(e) => {
          const raw = e.currentTarget.value;
          void saveSetting(() => setTerminalFontSizeDefault(raw === "" ? null : Number(raw)));
        }}
      >
        {#each fontSizeOptions(DEFAULT_TERMINAL_FONT_SIZE, $terminalFontSizeDefault) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Cards">
    <PhoneSetting
      label="Auto commit"
      control="app-auto-commit"
      hint="Whether a new card starts asking its agent to commit when it finishes, in every workspace that sets nothing of its own."
    >
      <select
        id="app-auto-commit"
        value={autoCommitToSelect($autoCommitDefault)}
        onchange={(e) => {
          const value = autoCommitFromSelect(e.currentTarget.value);
          void saveSetting(() => setAutoCommitDefault(value));
        }}
      >
        {#each autoCommitOptions(DEFAULT_AUTO_COMMIT) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
    <PhoneSetting
      label="Require review"
      control="app-require-review"
      hint="Whether a card's first Run asks for a deliberate yes to what it hands the agent, in every workspace that sets nothing of its own."
    >
      <select
        id="app-require-review"
        value={requireReviewToSelect($requireReviewDefault)}
        onchange={(e) => {
          const value = requireReviewFromSelect(e.currentTarget.value);
          void saveSetting(() => setRequireReviewDefault(value));
        }}
      >
        {#each requireReviewOptions(DEFAULT_REQUIRE_REVIEW) as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </PhoneSetting>
  </PhoneSettingsGroup>

  <PhoneSettingsGroup title="Git">
    <PhoneToggle
      label="Track gavin's files in workspaces gavin sets up"
      checked={resolveGitTracking($gitTrackingDefault)}
      hint="What a new workspace starts with. Each existing one keeps the answer in its own repository."
      onChange={(tracked) => void saveSetting(() => setGitTrackingDefault(tracked))}
    />
  </PhoneSettingsGroup>

  <PhoneSettingsGroup
    title="Agents"
    intro="Defaults, named customs, complexity, fallback and pause — the same Agents hub as at the desk."
  >
    <AgentsHubTabs tabs={APP_AGENTS_TABS} tab={agentsTab} onTab={(t) => (agentsTab = t as AppAgentsTab)} />

    {#if agentsTab === "defaults"}
      {#if modelProfiles.length === 0}
        <p class="note">Waiting for the agent profile table…</p>
      {/if}
      {#each modelProfiles as profile (profile.id)}
        <PhoneSetting label="{profile.label} model" control="model-{profile.id}">
          <PhoneModelPicker
            id="model-{profile.id}"
            options={modelOptions(profile, "")}
            own={$agentModelDefaultsStore[profile.id] ?? ""}
            presets={profile.models}
            placeholder="model name"
            onPick={(model) => void saveSetting(() => setAgentModelDefault(profile.id, model))}
          />
        </PhoneSetting>
      {/each}
      {#each effortProfiles as profile (profile.id)}
        <PhoneSetting label="{profile.label} effort" control="effort-{profile.id}">
          <PhoneModelPicker
            id="effort-{profile.id}"
            options={effortOptions({ effortFlag: profile.effortFlag ?? "", efforts: profile.efforts ?? [] }, "")}
            own={$agentDefaultsStore.agentEfforts?.[profile.id] ?? ""}
            presets={profile.efforts ?? []}
            placeholder="effort"
            onPick={(effort) =>
              void saveSetting(() => setAgentDefaults(withAgentEffort($agentDefaultsStore, profile.id, effort)))}
          />
        </PhoneSetting>
      {/each}
    {:else if agentsTab === "customs"}
      <div class="desk-part">
        <CustomsEditor
          profiles={$agentDefaultsStore.customProfiles ?? []}
          apiFamilyBlocked={apiFamilyBlocked}
          onChange={(next) =>
            void saveSetting(() => setAgentDefaults({ ...$agentDefaultsStore, customProfiles: next }))}
        />
      </div>
    {:else if agentsTab === "complexity"}
      <p class="note">
        Which agent, model and effort runs a card of each difficulty. A level left alone runs the
        workspace's own agent.
      </p>
      <div class="desk-part">
        <ComplexityTable
          profiles={allProfiles}
          table={$agentDefaultsStore.complexity}
          onChange={setComplexity}
        />
      </div>
    {:else if agentsTab === "fallback"}
      <p class="note">
        When a launch's agent is over its usage threshold, walk this chain instead of pausing.
      </p>
      <div class="desk-part">
        <FallbackChainEditor
          profiles={allProfiles}
          value={$agentDefaultsStore.agentFallback ?? []}
          thresholds={$agentDefaultsStore.fallbackThresholds}
          onChange={(chain) =>
            void saveSetting(() => setAgentDefaults({ ...$agentDefaultsStore, agentFallback: chain ?? [] }))}
          onThresholdChange={(profileId, percent) =>
            void saveSetting(() =>
              setAgentDefaults({
                ...$agentDefaultsStore,
                fallbackThresholds: {
                  ...($agentDefaultsStore.fallbackThresholds ?? {}),
                  [profileId]: sanitizeFallbackThreshold(percent),
                },
              })
            )}
        />
      </div>
    {:else if agentsTab === "pause"}
      <p class="note">
        Sit out part of every window so a rail does not spend a subscription's limit while nobody is
        watching. Nothing already running is interrupted.
      </p>
      <PhoneToggle label="Pause on a cycle" checked={cycle.enabled} onChange={(on) => editCycle({ enabled: on })} />
      <PhoneSetting label="Pause for">
        <input
          type="number"
          inputmode="numeric"
          min="1"
          aria-label="Minutes paused"
          disabled={!cycle.enabled}
          value={cycle.pauseMinutes}
          onchange={(e) => editCycle({ pauseMinutes: Number(e.currentTarget.value) })}
        />
        <span class="unit">minutes every</span>
        <input
          type="number"
          inputmode="numeric"
          min={MIN_PERIOD_MINUTES}
          aria-label="Minutes in a cycle"
          disabled={!cycle.enabled}
          value={cycle.periodMinutes}
          onchange={(e) => editCycle({ periodMinutes: Number(e.currentTarget.value) })}
        />
        <span class="unit">minutes</span>
      </PhoneSetting>
      <PhoneToggle
        label="Hold when a usage window is nearly spent"
        checked={cycle.limitEnabled}
        onChange={(on) => editCycle({ limitEnabled: on })}
      />
      <PhoneSetting label="Hold at" warn={cycleError}>
        <input
          type="number"
          inputmode="numeric"
          min="1"
          max="100"
          aria-label="Percent of the window used"
          disabled={!cycle.limitEnabled}
          value={cycle.limitPercent}
          onchange={(e) => editCycle({ limitPercent: Number(e.currentTarget.value) })}
        />
        <span class="unit">% used</span>
      </PhoneSetting>
    {/if}
  </PhoneSettingsGroup>

  <PhoneSettingsGroup
    title="Memory wall"
    intro="A ceiling on how many agents take a turn at once, and a hold while the machine is short of memory. New starts wait; nothing mid-turn is stopped."
  >
    <PhoneSetting label="Agents running at once" hint="Blank for no ceiling.">
      <input
        type="number"
        inputmode="numeric"
        min="1"
        placeholder="none"
        aria-label="Agents running at once"
        value={launch.maxInFlight ?? ""}
        onchange={(e) => editLaunch({ maxInFlight: ceilingFrom(e.currentTarget.value) })}
      />
    </PhoneSetting>
    <PhoneToggle
      label="Hold new agents when memory is under pressure"
      checked={launch.holdOnPressure}
      onChange={(on) => editLaunch({ holdOnPressure: on })}
    />
    <PhoneToggle
      label="Close idle agents of done cards when memory runs short"
      checked={launch.reclaimDoneSessions}
      onChange={(on) => editLaunch({ reclaimDoneSessions: on })}
    />
  </PhoneSettingsGroup>

  <p class="desk-only">
    Updates, the daemon, remote access and Devices stay at the desk, as do Headroom and TypeSafe.
  </p>
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
    padding: 10px max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border-danger, var(--border));
    background: var(--surface-danger, var(--surface-sunken));
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
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
  }
  .segments {
    display: flex;
    flex: 1 1 auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .segment {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    border: 0;
    background: var(--surface-base);
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .segment + .segment {
    border-left: 1px solid var(--border);
  }
  .segment.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .note,
  .desk-only {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }
  .desk-only {
    padding: 16px max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
    line-height: 1.45;
  }
  /* The desk's own components size their text in `em`, for a desk panel's
     smaller type; under a phone's 16px body their hints would read larger
     than every other hint here. */
  .desk-part {
    font-size: 0.8125rem;
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
