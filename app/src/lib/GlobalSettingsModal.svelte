<script lang="ts">
  import { Monitor, Sun, Moon } from "@lucide/svelte";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    agentDefaultsStore,
    setAgentModelDefault,
    setAgentDefaults,
    terminalFontSizeDefault,
    setTerminalFontSizeDefault,
    autoCommitDefault,
    setAutoCommitDefault,
    requireReviewDefault,
    setRequireReviewDefault,
    gitTrackingDefault,
    setGitTrackingDefault,
  } from "./layoutState";
  import ComplexityTable from "./ComplexityTable.svelte";
  import type { Complexity, ComplexityAgent } from "./complexity";
  import { modelOptions, CUSTOM_MODEL } from "./agentModel";
  import { DEFAULT_TERMINAL_FONT_SIZE, fontSizeOptions } from "./terminalFont";
  import {
    DEFAULT_AUTO_COMMIT,
    autoCommitFromSelect,
    autoCommitOptions,
    autoCommitToSelect,
  } from "./autoCommit";
  import {
    DEFAULT_REQUIRE_REVIEW,
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
  } from "./cardReview";
  import { resolveGitTracking } from "./gitTracking";
  import { scratchpadEnabled, setScratchpadEnabled } from "./sidebarPrefs";
  import { hiddenHubViewCount, hubTabsHiddenDefault } from "./hubTabPrefs";
  import HubTabsModal from "./HubTabsModal.svelte";
  import { themeState } from "./ui/themeState.svelte";
  import type { ThemePref } from "./ui/theme";
  import IconButton from "./ui/IconButton.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import { searchSettings, type SettingsSection } from "./settingsSearch";
  import Modal from "./Modal.svelte";
  import { DEFAULT_CYCLE, MIN_PERIOD_MINUTES, type PauseCycle, validateCycle } from "./agentPause";
  import { agentPauseStore, profilesInUse, saveAgentPause } from "./agentPauseState";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  /// System first, matching the default -- and matching the order the
  /// three states read in: follow the OS, or override it either way.
  /// Lifted out of the sidebar footer, which no longer carries a theme
  /// control of its own: one setting, one place.
  const THEME_OPTIONS: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
    { pref: "system", label: "Follow system", icon: Monitor },
    { pref: "light", label: "Light", icon: Sun },
    { pref: "dark", label: "Dark", icon: Moon },
  ];

  /// Only profiles gavin knows how to put a model on. A row for `cursor`
  /// or `custom` would be a control that cannot reach the agent.
  const profiles = $derived($agentProfilesStore.filter((p) => p.modelFlag));

  /// The app-wide cycle, or the shipped default while there is none --
  /// an editor needs fields on screen, and `saveAgentPause` is what turns
  /// the default into a stored cycle.
  const cycle = $derived($agentPauseStore ?? { ...DEFAULT_CYCLE, anchorMs: 0 });
  const cycleError = $derived(cycle.enabled ? validateCycle(cycle) : null);

  /// Whether any agent in use can actually be asked about its limits. The
  /// limit gate is offered either way -- a workspace may switch agents --
  /// but saying so beats a control that silently never fires.
  const probed = $derived(
    $agentProfilesStore.some((p) => p.usageProbe && profilesInUse().includes(p.id))
  );

  /// Writes through on every change, refusing an invalid cycle rather
  /// than storing one gavin would then have to ignore at read time.
  function edit(patch: Partial<PauseCycle>): void {
    const next = { ...cycle, ...patch };
    if (next.enabled && validateCycle(next)) {
      // Keep it on screen so the message can explain itself; nothing is
      // saved until it is usable again.
      agentPauseStore.set(next);
      return;
    }
    void saveAgentPause(next);
  }

  /// Which rows have their custom box open. A row whose stored value is
  /// not one of its presets starts open showing that value -- otherwise
  /// a hand-typed default would render as "(unset)" and look lost.
  let customOpen = $state<Record<string, boolean>>({});
  /// Per-row text while typing. Deliberately NOT synced back from the
  /// store by an effect: nothing outside this panel writes config.json's
  /// agentModels, so there is no external push to guard against -- and an
  /// effect that assigns into a $state object it also reads is how you
  /// get a loop. A row with no draft falls back to the stored value.
  let drafts = $state<Record<string, string>>({});

  function stored(profileId: string): string {
    return $agentModelDefaultsStore[profileId] ?? "";
  }

  function isCustom(profile: { id: string; models: string[] }): boolean {
    const value = stored(profile.id);
    return customOpen[profile.id] || (value !== "" && !profile.models.includes(value));
  }

  function selectValue(profile: { id: string; models: string[] }): string {
    return isCustom(profile) ? CUSTOM_MODEL : stored(profile.id);
  }

  function pick(profileId: string, value: string): void {
    if (value === CUSTOM_MODEL) {
      customOpen = { ...customOpen, [profileId]: true };
      drafts = { ...drafts, [profileId]: stored(profileId) };
      return;
    }
    customOpen = { ...customOpen, [profileId]: false };
    void setAgentModelDefault(profileId, value);
  }

  /// The eye list is a panel of its own rather than nine checkboxes in
  /// this one: it is the same list the workspace panel offers, and one
  /// component is what keeps the two saying the same thing.
  let hubTabsOpen = $state(false);
  const hiddenCount = $derived(hiddenHubViewCount($hubTabsHiddenDefault));

  function commitCustom(profileId: string): void {
    const value = (drafts[profileId] ?? stored(profileId)).trim();
    if (value === stored(profileId)) return;
    void setAgentModelDefault(profileId, value);
  }

  /// The custom agent's two fields, saved on blur rather than per
  /// keystroke: a half-typed command written through would be launched
  /// by anything that started an agent mid-edit.
  function commitCustomAgent(patch: { customCommand?: string; customModelFlag?: string }): void {
    const next = { ...$agentDefaultsStore, ...patch };
    if (
      next.customCommand === $agentDefaultsStore.customCommand &&
      next.customModelFlag === $agentDefaultsStore.customModelFlag
    ) {
      return;
    }
    void setAgentDefaults(next);
  }

  /// One complexity row. `null` clears it, which is what "no agent for
  /// this level" means -- the card then runs the workspace's own.
  function setComplexity(level: Complexity, entry: ComplexityAgent | null): void {
    const complexity = { ...$agentDefaultsStore.complexity };
    if (entry) complexity[level] = entry;
    else delete complexity[level];
    void setAgentDefaults({ ...$agentDefaultsStore, complexity });
  }

  // --- search ---------------------------------------------------------
  /// One entry per section below, in the same order -- see
  /// SettingsHubView's own SECTIONS for why whole sections, not rows.
  const SECTIONS: SettingsSection[] = [
    { id: "appearance", keywords: ["Appearance", "Theme", "Light", "Dark", "system"] },
    { id: "sidebar", keywords: ["Sidebar", "Scratchpad"] },
    { id: "hub-tabs", keywords: ["Hub tabs", "Sections", "tab row", "hidden"] },
    { id: "terminal", keywords: ["Terminal", "Font size", "font"] },
    { id: "cards", keywords: ["Cards", "Auto commit", "commit", "Require review", "review"] },
    {
      id: "git",
      keywords: ["Git", "Track gavin's files", "tracking", "gitignore", "initialize"],
    },
    { id: "agent-pause", keywords: ["Agent pause", "pause", "cycle", "limit", "schedule", "usage"] },
    { id: "agent-defaults", keywords: ["Agent defaults", "model", "Claude Code", "Codex"] },
    { id: "custom-agent", keywords: ["Custom agent", "Command", "Model flag"] },
    { id: "complexity", keywords: ["Complexity", "difficulty", "agent", "model"] },
  ];
  let settingsQuery = $state("");
  const settingsFilter = $derived(searchSettings(SECTIONS, settingsQuery));
</script>

<Modal {onClose}>
  <div class="global-settings">
    <h2>Settings</h2>

    <SearchInput
      bind:value={settingsQuery}
      class="settings-search"
      label="Search settings"
      placeholder="Search settings…"
      matches={settingsFilter.filtering ? settingsFilter : null}
    />

    <section hidden={!settingsFilter.visible("appearance")}>
      <h3>Appearance</h3>
      <div class="row">
        <span>Theme</span>
        <div class="theme-toggle">
          {#each THEME_OPTIONS as opt (opt.pref)}
            <IconButton
              icon={opt.icon}
              label={opt.label}
              variant="segmented"
              size={12}
              active={themeState.pref === opt.pref}
              onclick={() => void themeState.setPref(opt.pref)}
            />
          {/each}
        </div>
      </div>
    </section>

    <section hidden={!settingsFilter.visible("sidebar")}>
      <h3>Sidebar</h3>
      <div class="row">
        <span>Scratchpad</span>
        <label class="check">
          <input
            type="checkbox"
            checked={$scratchpadEnabled}
            onchange={(e) => void setScratchpadEnabled(e.currentTarget.checked)}
          />
          <span>Keep its row in the sidebar</span>
        </label>
      </div>
      <p class="hint">
        The Scratchpad is the pinned drawer a page with no workspace of its own lands in. Switching
        it off takes its row out of the sidebar and out of ⌘⌥-number; nothing inside it is closed or
        deleted, and switching it back on brings the row and its pages straight back.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("hub-tabs")}>
      <h3>Hub tabs</h3>
      <div class="row">
        <span>Sections</span>
        <button type="button" class="manage" onclick={() => (hubTabsOpen = true)}>
          {hiddenCount === 0 ? "All shown" : `${hiddenCount} hidden`}…
        </button>
      </div>
      <p class="hint">
        Which sections a workspace's tab row offers, for every workspace that keeps no list of its
        own. Rearranging a row is done in the row itself — unlock it with the button at the end of
        the tabs.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("terminal")}>
      <h3>Terminal</h3>
      <div class="row">
        <span>Font size</span>
        <select
          value={$terminalFontSizeDefault === null ? "" : String($terminalFontSizeDefault)}
          onchange={(e) =>
            void setTerminalFontSizeDefault(
              e.currentTarget.value === "" ? null : Number(e.currentTarget.value)
            )}
        >
          {#each fontSizeOptions(DEFAULT_TERMINAL_FONT_SIZE, $terminalFontSizeDefault) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Every terminal in every workspace, unless the workspace sets a size of its own. Open
        terminals resize as you pick.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("cards")}>
      <h3>Cards</h3>
      <div class="row">
        <span>Auto commit</span>
        <select
          value={autoCommitToSelect($autoCommitDefault)}
          onchange={(e) => void setAutoCommitDefault(autoCommitFromSelect(e.currentTarget.value))}
        >
          {#each autoCommitOptions(DEFAULT_AUTO_COMMIT) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Whether a new task or plan card starts asking the agent to commit its work when it finishes.
        Every workspace that sets nothing of its own follows this; every card can still be switched
        either way on the card itself.
      </p>
      <div class="row">
        <span>Require review</span>
        <select
          value={requireReviewToSelect($requireReviewDefault)}
          onchange={(e) =>
            void setRequireReviewDefault(requireReviewFromSelect(e.currentTarget.value))}
        >
          {#each requireReviewOptions(DEFAULT_REQUIRE_REVIEW) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Whether gavin shows what a card's body will hand an agent and asks for a deliberate yes before
        its first Run. Every workspace that sets nothing of its own follows this; off trusts every
        card the moment you press Run.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("git")}>
      <h3>Git</h3>
      <div class="row">
        <span>Track gavin's files</span>
        <label class="check">
          <input
            type="checkbox"
            checked={resolveGitTracking($gitTrackingDefault)}
            onchange={(e) => void setGitTrackingDefault(e.currentTarget.checked)}
          />
          <!-- Not INIT_TRACKING_LABEL: that is the question the two init
               prompts ask, and this row is the answer they START from.
               Wording them identically would read as a switch that
               reaches back into every workspace already open. -->
          <span>On in workspaces gavin initializes</span>
        </label>
      </div>
      <p class="hint">
        What gavin does when it initializes a workspace: leave .gavin-root/ and every .gavin/ folder
        to be committed with the project, or write an ignore rule for them. Only new workspaces —
        each existing one keeps the answer in its own repository, on its Settings tab.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("agent-pause")}>
      <h3>Agent pause</h3>
      <p class="hint">
        Sit out part of every window so a rail does not spend a subscription limit
        while nobody is watching. Nothing already running is interrupted — only
        new starts wait.
      </p>
      <div class="row">
        <span>Scheduled</span>
        <label class="check">
          <input
            type="checkbox"
            checked={cycle.enabled}
            onchange={(e) => edit({ enabled: e.currentTarget.checked })}
          />
          <span>Pause on a cycle</span>
        </label>
      </div>
      <div class="row">
        <span>Pause for</span>
        <input
          class="num"
          type="number"
          min="1"
          disabled={!cycle.enabled}
          value={cycle.pauseMinutes}
          onchange={(e) => edit({ pauseMinutes: Number(e.currentTarget.value) })}
        />
        <span class="unit">minutes every</span>
        <input
          class="num"
          type="number"
          min={MIN_PERIOD_MINUTES}
          disabled={!cycle.enabled}
          value={cycle.periodMinutes}
          onchange={(e) => edit({ periodMinutes: Number(e.currentTarget.value) })}
        />
        <span class="unit">minutes</span>
      </div>
      <div class="row">
        <span>At the limit</span>
        <label class="check">
          <input
            type="checkbox"
            checked={cycle.limitEnabled}
            onchange={(e) => edit({ limitEnabled: e.currentTarget.checked })}
          />
          <span>Hold when a window is</span>
        </label>
        <input
          class="num"
          type="number"
          min="1"
          max="100"
          disabled={!cycle.limitEnabled}
          value={cycle.limitPercent}
          onchange={(e) => edit({ limitPercent: Number(e.currentTarget.value) })}
        />
        <span class="unit">% used</span>
      </div>
      {#if cycleError}
        <p class="hint error">{cycleError}</p>
      {:else if !probed}
        <p class="hint">
          Holding at a limit needs an agent whose limits gavin can read — today
          Claude Code and Codex. No workspace here runs one, so only the schedule
          applies.
        </p>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("agent-defaults")}>
      <h3>Agent defaults</h3>
      {#if profiles.length === 0}
        <p class="hint">Waiting for the agent profile table…</p>
      {:else}
        {#each profiles as profile (profile.id)}
          <div class="row">
            <span>{profile.label}</span>
            <select
              value={selectValue(profile)}
              onchange={(e) => pick(profile.id, e.currentTarget.value)}
            >
              {#each modelOptions(profile, "") as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if isCustom(profile)}
              <input
                class="custom"
                spellcheck="false"
                placeholder="model name"
                value={drafts[profile.id] ?? stored(profile.id)}
                oninput={(e) => (drafts = { ...drafts, [profile.id]: e.currentTarget.value })}
                onblur={() => commitCustom(profile.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
        {/each}
        <p class="hint">
          Used by any workspace that sets no model of its own. Only Claude Code publishes stable
          aliases — for the rest, type the model name your CLI expects.
        </p>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("custom-agent")}>
      <h3>Custom agent</h3>
      <div class="row">
        <span>Command</span>
        <input
          class="custom"
          spellcheck="false"
          placeholder="my-agent --flags"
          value={$agentDefaultsStore.customCommand}
          onchange={(e) => commitCustomAgent({ customCommand: e.currentTarget.value.trim() })}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <div class="row">
        <span>Model flag</span>
        <input
          class="custom"
          spellcheck="false"
          placeholder="--model"
          value={$agentDefaultsStore.customModelFlag}
          onchange={(e) => commitCustomAgent({ customModelFlag: e.currentTarget.value.trim() })}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <p class="hint">
        The agent behind the <strong>Custom…</strong> profile — your own CLI, launched as written.
        Any workspace on that profile that names no command of its own uses this one. The model flag
        is how gavin puts a model on it: without one it has no way to, so every model control for a
        custom agent stays dark rather than guessing a flag. A workspace can override both on its
        own Settings tab.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("complexity")}>
      <h3>Complexity</h3>
      <p class="hint">
        A card can say how hard its work is, and each level can run a different agent — so a rename
        need not spend the model a gnarly refactor needs. A level left alone runs whatever agent the
        workspace runs; a model on its own keeps that agent and only changes the model. Every
        workspace can override any level on its own Settings tab.
      </p>
      <ComplexityTable
        profiles={$agentProfilesStore}
        table={$agentDefaultsStore.complexity}
        onChange={setComplexity}
      />
    </section>

    <div class="actions">
      <button type="button" onclick={onClose}>Done</button>
    </div>
  </div>
</Modal>

<!-- Outside the panel, not inside it: a modal nested in another modal's
     scrolling body would be clipped by it. Later in the tree so it lands
     on top, the same rule +page.svelte follows for its alert layer. -->
{#if hubTabsOpen}
  <HubTabsModal onClose={() => (hubTabsOpen = false)} />
{/if}

<style>
  /* Deliberately the same rules as SettingsHubView's panel, so the
     app-wide and per-workspace settings read as one family rather than
     two designs that happen to sit next to each other. */
  .global-settings {
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-size: 0.85em;
    min-width: 380px;
  }
  .global-settings :global(.settings-search) {
    flex: 0 0 auto;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  h3 {
    margin: 0 0 10px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .row > span:first-child {
    width: 110px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .row select,
  .row input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .row select {
    min-width: 140px;
  }
  .row input.custom {
    flex: 1 1 auto;
    min-width: 0;
  }
  .theme-toggle {
    display: flex;
    gap: 2px;
    background: var(--surface-sunken);
    border-radius: 4px;
    padding: 1px;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .hint.error {
    color: var(--danger-text);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text);
  }
  .row input.num {
    width: 56px;
    text-align: right;
  }
  .unit {
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .row button.manage {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
</style>
