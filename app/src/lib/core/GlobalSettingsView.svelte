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
    restartDaemonInPlace,
    daemonCompat,
  } from "$lib/core/layoutState";
  import ComplexityTable from "$lib/cards/ComplexityTable.svelte";
  import FallbackChainEditor from "$lib/workspace/FallbackChainEditor.svelte";
  import { sanitizeFallbackThreshold } from "$lib/agents/agentFallback";
  import type { Complexity, ComplexityAgent } from "$lib/cards/complexity";
  import { modelOptions, CUSTOM_MODEL } from "$lib/agents/agentModel";
  import { DEFAULT_TERMINAL_FONT_SIZE, fontSizeOptions } from "$lib/terminal/terminalFont";
  import {
    DEFAULT_AUTO_COMMIT,
    autoCommitFromSelect,
    autoCommitOptions,
    autoCommitToSelect,
  } from "$lib/git/autoCommit";
  import {
    DEFAULT_REQUIRE_REVIEW,
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
  } from "$lib/cards/cardReview";
  import { resolveGitTracking } from "$lib/git/gitTracking";
  import {
    scratchpadEnabled,
    setScratchpadEnabled,
    sidebarPeekOnHover,
    setSidebarPeekOnHover,
  } from "$lib/sidebar/sidebarPrefs";
  import { hiddenHubViewCount, hubTabsHiddenDefault } from "$lib/hub/hubTabPrefs";
  import HubTabsModal from "$lib/hub/HubTabsModal.svelte";
  import { themeState } from "$lib/ui/themeState.svelte";
  import type { ThemePref } from "$lib/ui/theme";
  import IconButton from "$lib/ui/IconButton.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import { DEFAULT_CYCLE, MIN_PERIOD_MINUTES, type PauseCycle, validateCycle } from "$lib/agents/agentPause";
  import { grantForAnsweredPrompt, DAEMON_SUBJECT } from "$lib/core/confirmGate";
  import { featureBlockedReason, restartOutcome, restartConfirmLines } from "$lib/core/daemonCompat";
  import * as backend from "$lib/core/backend";
  import { tooltip } from "$lib/core/tooltip";
  import {
    availableUpdate,
    checkingForUpdate,
    lastCheckError,
    lastCheckedAt,
    refreshUpdateChannel,
    runUpdateCheck,
    updateChannel,
  } from "$lib/shell/updatesState";
  import { installConfirmPrompt, runInstall, saveEndpoint } from "$lib/shell/updateActions";
  import {
    availableLine,
    endpointToSave,
    updateBlockedReason,
    upToDateLine,
    type UpdatePrompt,
  } from "$lib/shell/updates";
  import { onMount } from "svelte";
  import { agentPauseStore, profilesInUse, saveAgentPause } from "$lib/agents/agentPauseState";
  import { launchConfigStore, saveLaunchConfig } from "$lib/agents/launchQueue";
  import type { LaunchConfig } from "$lib/agents/launchGate";
  import ToolsExplorerView from "$lib/orchestration/ToolsExplorerView.svelte";

  // Full-page app settings: opened via appSettingsOpen, closed by
  // navigating away (sidebar / hub / workspace), not by a Done button.

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
  /// The wall in force, never null: a config nobody has edited resolves
  /// to the shipped default so the fields always have values.
  const launch = $derived($launchConfigStore);

  /// A blank field means NO CEILING, which is a real answer and not the
  /// same as the shipped four. Zero is not expressible -- a ceiling of
  /// zero holds every launch for ever -- so it reads as blank too.
  function ceilingFrom(raw: string): number | null {
    const value = Number(raw.trim());
    if (!raw.trim() || !Number.isFinite(value) || value < 1) return null;
    return Math.floor(value);
  }

  function editLaunch(patch: Partial<LaunchConfig>): void {
    void saveLaunchConfig({ ...launch, ...patch });
  }

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

  // --- updates ---------------------------------------------------------
  //
  // Above the daemon section because the two are one story: installing an
  // update replaces `gavin-daemon` inside the bundle, and the daemon that
  // is RUNNING was exec'd from the old copy, so the restart below is what
  // finishes the update -- at the cost of every session it holds. App-wide
  // rather than per-workspace: one install, one daemon.
  let endpointDraft = $state("");
  let endpointFocused = $state(false);
  let endpointError = $state<string | null>(null);
  let savingEndpoint = $state(false);
  let installPrompt = $state<UpdatePrompt | null>(null);
  let installing = $state(false);
  let installError = $state<string | null>(null);

  const updateBlocked = $derived($updateChannel ? updateBlockedReason($updateChannel) : null);

  onMount(() => {
    void refreshUpdateChannel();
  });

  $effect(() => {
    const endpoint = $updateChannel?.endpoint ?? "";
    if (!endpointFocused) endpointDraft = endpoint;
  });

  async function applyEndpoint(): Promise<void> {
    const settings = $updateChannel;
    if (!settings) return;
    endpointError = null;
    savingEndpoint = true;
    try {
      await saveEndpoint(endpointToSave(endpointDraft, settings));
      await refreshUpdateChannel();
      availableUpdate.set(null);
      lastCheckedAt.set(null);
      lastCheckError.set(null);
    } catch (e) {
      endpointError = String(e instanceof Error ? e.message : e);
    } finally {
      savingEndpoint = false;
    }
  }

  async function openInstallPrompt(): Promise<void> {
    const update = $availableUpdate;
    if (!update) return;
    installError = null;
    installPrompt = await installConfirmPrompt(update);
  }

  async function doInstall(): Promise<void> {
    const update = $availableUpdate;
    installPrompt = null;
    if (!update) return;
    installing = true;
    installError = null;
    try {
      await runInstall(update);
    } catch (e) {
      installError = String(e instanceof Error ? e.message : e);
    } finally {
      installing = false;
    }
  }

  // --- daemon ----------------------------------------------------------
  let confirmingRestart = $state(false);
  let restarting = $state(false);
  let restartError = $state<string | null>(null);
  let restartedAt = $state<string | null>(null);
  let restartNote = $state<string | null>(null);

  async function restartDaemon(): Promise<void> {
    confirmingRestart = false;
    restarting = true;
    restartError = null;
    restartedAt = null;
    restartNote = null;
    const before = $daemonCompat?.daemonVersion ?? null;
    try {
      const token = await grantForAnsweredPrompt("restart_daemon", [DAEMON_SUBJECT]);
      restartNote = restartOutcome(before, await restartDaemonInPlace(token));
      restartedAt = new Date().toLocaleTimeString();
    } catch (e) {
      restartError = String(e instanceof Error ? e.message : e);
    } finally {
      restarting = false;
    }
  }

  // --- remote access ---------------------------------------------------
  /// `Request::Hello` is a new request TYPE, so an older daemon simply has
  /// no identity to offer; the surface below reads this and greys itself
  /// with the version it needs rather than writing a setting the daemon
  /// would not honour.
  const clientIdentityBlocked = $derived(featureBlockedReason($daemonCompat, "clientIdentity"));
  /// `require_local_token` is a daemon-GLOBAL setting -- a marker file the
  /// daemon reads per request -- not a per-workspace one.
  let requireLocalToken = $state(false);
  let requireLocalTokenLoaded = false;
  $effect(() => {
    if (requireLocalTokenLoaded) return;
    requireLocalTokenLoaded = true;
    void backend
      .getRequireLocalToken()
      .then((v) => (requireLocalToken = v))
      .catch(() => undefined);
  });
  async function toggleRequireLocalToken(enabled: boolean): Promise<void> {
    requireLocalToken = enabled; // optimistic
    try {
      await backend.setRequireLocalToken(enabled);
    } catch {
      requireLocalToken = !enabled; // roll back a failed write
    }
  }

  // --- search ---------------------------------------------------------
  /// One entry per section below, in the same order -- see
  /// SettingsHubView's own SECTIONS for why whole sections, not rows.
  ///
  /// Agent defaults and Custom agent sit above Complexity (the table
  /// names which agent runs each level). Updates / Daemon / Remote
  /// access are app-wide infrastructure that used to live on each
  /// workspace's Settings tab by mistake.
  const SECTIONS: SettingsSection[] = [
    { id: "appearance", keywords: ["Appearance", "Theme", "Light", "Dark", "system"] },
    { id: "sidebar", keywords: ["Sidebar", "Scratchpad", "Hover to expand", "hover", "peek"] },
    { id: "hub-tabs", keywords: ["Hub tabs", "Sections", "tab row", "hidden"] },
    { id: "terminal", keywords: ["Terminal", "Font size", "font"] },
    { id: "cards", keywords: ["Cards", "Auto commit", "commit", "Require review", "review"] },
    {
      id: "git",
      keywords: ["Git", "Track gavin's files", "tracking", "gitignore", "initialize"],
    },
    { id: "agent-defaults", keywords: ["Agent defaults", "model", "Claude Code", "Codex"] },
    { id: "custom-agent", keywords: ["Custom agent", "Command", "Model flag"] },
    {
      id: "tools",
      keywords: [
        "Tools",
        "Action prompts",
        "agent prompt",
        "commit via agent",
        "critical review",
        "prompt overrides",
      ],
    },
    { id: "complexity", keywords: ["Complexity", "difficulty", "agent", "model"] },
    {
      id: "fallback-agent",
      keywords: ["Fallback agent", "fallback chain", "usage limit", "arm"],
    },
    { id: "agent-pause", keywords: ["Agent pause", "pause", "cycle", "limit", "schedule", "usage"] },
    {
      id: "memory-wall",
      keywords: ["Memory wall", "memory", "RAM", "pressure", "ceiling", "agents running at once"],
    },
    {
      id: "updates",
      keywords: ["Updates", "Check for updates", "Install", "Endpoint", "update channel", "version"],
    },
    { id: "daemon", keywords: ["Daemon", "Restart daemon", "gavin-daemon"] },
    { id: "remote-access", keywords: ["Remote access", "token", "local access", "pairing"] },
  ];
  let settingsQuery = $state("");
  const settingsFilter = $derived(searchSettings(SECTIONS, settingsQuery));
  let selectedSection = $state(SECTIONS[0].id);
  $effect(() => {
    if (settingsFilter.visible(selectedSection)) return;
    const first = SECTIONS.find((s) => settingsFilter.visible(s.id));
    if (first) selectedSection = first.id;
  });
  function sectionLabel(section: SettingsSection): string {
    return section.keywords[0] ?? section.id;
  }
</script>

<div class="global-settings">
  <aside class="settings-nav">
    <div class="nav-head">
      <SearchInput
        bind:value={settingsQuery}
        class="settings-search"
        label="Search settings"
        placeholder="Search settings…"
        matches={settingsFilter.filtering ? settingsFilter : null}
      />
    </div>
    <nav class="nav-list" aria-label="Settings sections">
      {#each SECTIONS as section (section.id)}
        <button
          type="button"
          class="nav-item"
          class:active={selectedSection === section.id}
          hidden={!settingsFilter.visible(section.id)}
          aria-current={selectedSection === section.id ? "page" : undefined}
          onclick={() => (selectedSection = section.id)}
        >
          {sectionLabel(section)}
        </button>
      {/each}
    </nav>
  </aside>
  <div class="settings-body">
    <section hidden={!settingsFilter.visible("appearance") || selectedSection !== "appearance"}>
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

    <section hidden={!settingsFilter.visible("sidebar") || selectedSection !== "sidebar"}>
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
      <div class="row">
        <span>Hover to expand</span>
        <label class="check">
          <input
            type="checkbox"
            checked={$sidebarPeekOnHover}
            onchange={(e) => setSidebarPeekOnHover(e.currentTarget.checked)}
          />
          <span>Open the collapsed rail after hovering</span>
        </label>
      </div>
      <p class="hint">
        When the sidebar is its icon rail, hovering it for a moment floats the full column over the
        view — the same overlay a press already opens. Switching this off leaves only the press.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("hub-tabs") || selectedSection !== "hub-tabs"}>
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

    <section hidden={!settingsFilter.visible("terminal") || selectedSection !== "terminal"}>
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

    <section hidden={!settingsFilter.visible("cards") || selectedSection !== "cards"}>
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

    <section hidden={!settingsFilter.visible("git") || selectedSection !== "git"}>
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

    <section hidden={!settingsFilter.visible("agent-defaults") || selectedSection !== "agent-defaults"}>
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

    <section hidden={!settingsFilter.visible("custom-agent") || selectedSection !== "custom-agent"}>
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

    <section hidden={!settingsFilter.visible("tools") || selectedSection !== "tools"}>
      <h3>Tools</h3>
      <p class="hint">
        App-wide agent action prompts and global tools. A workspace can override any prompt on its
        Tools tab; workspace wording wins when both are set.
      </p>
      <div class="tools-explorer">
        <ToolsExplorerView scope="app" />
      </div>
    </section>

    <section hidden={!settingsFilter.visible("complexity") || selectedSection !== "complexity"}>
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

    <section hidden={!settingsFilter.visible("fallback-agent") || selectedSection !== "fallback-agent"}>
      <h3>Fallback agent</h3>
      <p class="hint">
        When a launch's agent is over its usage threshold, walk this chain instead of pausing. A
        workspace can override the chain; workspaces that inherit it are asked to set each agent up
        on focus. Does not rewrite the workspace's active agent.
      </p>
      <FallbackChainEditor
        profiles={$agentProfilesStore}
        value={$agentDefaultsStore.agentFallback ?? []}
        thresholds={$agentDefaultsStore.fallbackThresholds}
        onChange={(chain) =>
          void setAgentDefaults({
            ...$agentDefaultsStore,
            agentFallback: chain ?? [],
          })}
        onThresholdChange={(profileId, percent) =>
          void setAgentDefaults({
            ...$agentDefaultsStore,
            fallbackThresholds: {
              ...($agentDefaultsStore.fallbackThresholds ?? {}),
              [profileId]: sanitizeFallbackThreshold(percent),
            },
          })}
      />
    </section>

    <section hidden={!settingsFilter.visible("agent-pause") || selectedSection !== "agent-pause"}>
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

    <section hidden={!settingsFilter.visible("memory-wall") || selectedSection !== "memory-wall"}>
      <h3>Memory wall</h3>
      <p class="hint">
        A ceiling on how many agents may be taking a turn at once, and a hold while the
        machine is under memory pressure. Nothing mid-turn is ever stopped — new starts
        wait, and they start by themselves when a slot frees. The one thing gavin may
        close is an idle agent whose card is already done, when memory runs short.
      </p>
      <div class="row">
        <span>Agents running at once</span>
        <input
          class="num"
          type="number"
          min="1"
          placeholder="none"
          value={launch.maxInFlight ?? ""}
          onchange={(e) => editLaunch({ maxInFlight: ceilingFrom(e.currentTarget.value) })}
        />
        <span class="unit">blank for no ceiling</span>
      </div>
      <div class="row">
        <span>Under pressure</span>
        <label class="check">
          <input
            type="checkbox"
            checked={launch.holdOnPressure}
            onchange={(e) => editLaunch({ holdOnPressure: e.currentTarget.checked })}
          />
          <span>Hold new agents when memory is under pressure</span>
        </label>
      </div>
      <!-- Its own switch rather than a mode of the hold above: holding a
           start costs nothing, closing a finished agent costs its
           transcript, and a human may want one without the other. -->
      <div class="row">
        <span>Finished cards</span>
        <label class="check">
          <input
            type="checkbox"
            checked={launch.reclaimDoneSessions}
            onchange={(e) => editLaunch({ reclaimDoneSessions: e.currentTarget.checked })}
          />
          <span>Close idle agents of done cards when memory runs short</span>
        </label>
      </div>
    </section>

    <section hidden={!settingsFilter.visible("updates") || selectedSection !== "updates"}>
      <h3>Updates</h3>
      <p class="hint">
        gavin checks once when it starts, and installs nothing on its own. A download is
        verified against the key this build was signed with before any of it is installed.
      </p>
      {#if $availableUpdate}
        <p class="hint">{availableLine($availableUpdate)}</p>
        {#if $availableUpdate.notes}
          <p class="hint detail">{$availableUpdate.notes}</p>
        {/if}
      {:else if $updateChannel}
        <p class="hint">{upToDateLine($updateChannel, $lastCheckedAt)}</p>
      {/if}
      <div class="row">
        <!-- The reason hangs on the wrapping span, not the button: a
             disabled element fires no mouseenter, so a tooltip on it can
             never open. -->
        <span use:tooltip={updateBlocked ?? ""}>
          <button
            type="button"
            class="manage"
            disabled={$checkingForUpdate || updateBlocked !== null}
            onclick={() => void runUpdateCheck("manual")}
          >
            {$checkingForUpdate ? "Checking…" : "Check for updates"}
          </button>
        </span>
        {#if $availableUpdate}
          <button type="button" class="manage" disabled={installing} onclick={() => void openInstallPrompt()}>
            {installing ? "Installing…" : `Install ${$availableUpdate.version}…`}
          </button>
        {/if}
      </div>
      {#if updateBlocked}
        <p class="hint warn">{updateBlocked}</p>
      {/if}
      {#if $lastCheckError}
        <p class="hint warn">Couldn't check for updates: {$lastCheckError}</p>
      {/if}
      {#if installError}
        <p class="hint warn">Couldn't install the update: {installError}</p>
      {/if}
      <div class="row endpoint-row">
        <label for="update-endpoint">Endpoint</label>
        <input
          id="update-endpoint"
          type="text"
          spellcheck="false"
          placeholder="https://…/latest.json"
          bind:value={endpointDraft}
          onfocus={() => (endpointFocused = true)}
          onblur={() => (endpointFocused = false)}
        />
        <button type="button" class="manage" disabled={savingEndpoint} onclick={() => void applyEndpoint()}>
          {savingEndpoint ? "Saving…" : "Save"}
        </button>
      </div>
      <p class="hint">
        The manifest this install polls. Changing it is safe: an update is only ever accepted if
        it was signed with the key pinned in this build, so an endpoint can offer gavin anything
        and gavin will refuse all of it. Empty means nothing is checked.
        {#if $updateChannel?.overridden}
          <span class="detail">Clear the field to go back to the URL this build shipped with.</span>
        {/if}
      </p>
      {#if endpointError}
        <p class="hint warn">Couldn't save the endpoint: {endpointError}</p>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("daemon") || selectedSection !== "daemon"}>
      <h3>Daemon</h3>
      <p class="hint">
        gavin-daemon owns every terminal session and watches your plan files. Restart it after
        rebuilding it, or if sessions and file watching have stopped responding.
      </p>
      <div class="row">
        <button type="button" class="manage" disabled={restarting} onclick={() => (confirmingRestart = true)}>
          {restarting ? "Restarting…" : "Restart daemon"}
        </button>
        {#if restartedAt}
          <span class="hint">Restarted at {restartedAt}.</span>
        {/if}
      </div>
      {#if restartError}
        <p class="hint warn">Couldn't restart the daemon: {restartError}</p>
      {:else if restartNote}
        <p class="hint warn">{restartNote}</p>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("remote-access") || selectedSection !== "remote-access"}>
      <h3>Remote access</h3>
      <p class="hint">
        Every connection to the daemon carries an identity now: the app holds a token the daemon
        minted, and an agent gavin launches is scoped to the workspace and card it was started
        for. Pairing a phone to reach the daemon from away builds on this; those controls will
        appear here.
      </p>
      <!-- The reason hangs on the wrapping span, not the input: a disabled
           element fires no mouseenter, so a tooltip on it never opens. -->
      <span use:tooltip={clientIdentityBlocked ?? ""}>
        <label class="check">
          <input
            type="checkbox"
            disabled={clientIdentityBlocked !== null}
            checked={requireLocalToken}
            onchange={(e) => void toggleRequireLocalToken(e.currentTarget.checked)}
          />
          Require a token for full local access
        </label>
      </span>
      <p class="hint">
        Off by default, so nothing changes today. On, a same-user program that connects without
        the app's token can still read the board and your sessions, but cannot start a shell,
        spawn an agent, stop the daemon, or rewrite the launch command. Turn it on only if you run
        tools you do not trust as your own user.
        {#if clientIdentityBlocked}
          <span class="warn">{clientIdentityBlocked}</span>
        {/if}
      </p>
    </section>

  </div>
</div>

<!-- Outside the panel, not inside its scrolling body: later in the tree
     so it lands on top, the same rule +page.svelte follows for its alert
     layer. -->
{#if hubTabsOpen}
  <HubTabsModal onClose={() => (hubTabsOpen = false)} />
{/if}

{#if installPrompt}
  {@const prompt = installPrompt}
  <ConfirmPrompt
    title={prompt.title}
    lines={prompt.lines}
    choices={[{ label: prompt.confirmLabel, danger: true, onPick: () => void doInstall() }]}
    onCancel={() => (installPrompt = null)}
  />
{/if}

{#if confirmingRestart}
  <ConfirmPrompt
    title="Restart gavin-daemon?"
    lines={restartConfirmLines($daemonCompat)}
    choices={[{ label: "Restart daemon", danger: true, onPick: () => void restartDaemon() }]}
    onCancel={() => (confirmingRestart = false)}
  />
{/if}

<style>
  /* Same family as SettingsHubView: left navigator + detail pane. */
  .global-settings {
    display: grid;
    grid-template-columns: minmax(140px, 180px) minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    color: var(--text);
    font-family: monospace;
    font-size: 0.85em;
  }
  .settings-nav {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .nav-head {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 var(--hub-bar-height);
    height: var(--hub-bar-height);
    min-height: 0;
    max-height: var(--hub-bar-height);
    box-sizing: border-box;
    padding: 0 6px;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .nav-head :global(.settings-search) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .nav-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px;
    overflow-y: auto;
    min-height: 0;
  }
  .nav-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 1em;
    padding: 5px 8px;
    cursor: pointer;
  }
  .nav-item:hover {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .nav-item.active {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .settings-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    overflow-y: auto;
    min-width: 0;
    min-height: 0;
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
  .row > span:first-child,
  .row > label:first-child {
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
  /* Capped for the reason SettingsHubView's model row is: a native
     select is as wide as its widest option, and this panel lists EVERY
     profile -- including opencode, whose catalogue is 450
     provider-qualified names. Uncapped, that one row is wider than the
     pane while the rows above it sit at 140px. */
  .row select {
    min-width: 140px;
    max-width: 240px;
  }
  .row input.custom {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 240px;
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
  .tools-explorer {
    margin-top: 10px;
    min-height: 420px;
    height: min(70vh, 640px);
  }
  .tools-explorer :global(.explorer) {
    height: 100%;
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
  .row button.manage:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* A URL outruns the shared select cap, so it takes the room the row
     has rather than forcing the pane to scroll sideways. */
  .endpoint-row input {
    min-width: 0;
    flex: 1 1 auto;
  }
  .hint.warn {
    color: var(--warning-text);
  }
  .detail {
    opacity: 0.75;
    font-size: 0.9em;
  }
  .warn {
    color: var(--warning-text);
  }
</style>
