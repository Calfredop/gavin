<script lang="ts">
  import { Monitor, Sun, Moon } from "@lucide/svelte";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    agentDefaultsStore,
    dropProfileRefsFromWorkspaces,
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
    headroomDefault,
    setHeadroomDefault,
  } from "$lib/core/layoutState";
  import AgentPrimaryPanel from "$lib/agents/AgentPrimaryPanel.svelte";
  import { effectiveDefaultAgent } from "$lib/cards/complexity";
  import { withAgentEffort } from "$lib/cards/complexity";
  import { effortOptions, modelOptions, CUSTOM_MODEL } from "$lib/agents/agentModel";
  import {
    ADD_TAB,
    ADD_TAB_HINT,
    AGENTS_SECTION,
    GENERAL_TAB,
    addCustomProfile,
    agentsHubTabs,
    agentsTabForQuery,
    isCustomProfileId,
    validAgentsTab,
    type AgentsHubTab,
  } from "$lib/agents/agentsHub";
  import AgentsHubTabs from "$lib/agents/AgentsHubTabs.svelte";
  import {
    agentDefaultsWithoutCustom,
    renameCustomProfile,
    updateCustomProfile,
  } from "$lib/agents/agentsHub";
  import { API_FAMILIES, type ApiFamily } from "$lib/agents/apiFamily";
  import { askConfirm } from "$lib/core/dialog";
  import type { CustomProfile } from "$lib/cards/complexity";
  import { mergeAgentProfiles } from "$lib/core/settings";
  import HeadroomControls from "$lib/agents/HeadroomControls.svelte";
  import { DEFAULT_HEADROOM } from "$lib/agents/compression";
  import { compressionSwitchBlocked } from "$lib/agents/compressionDriver";
  import {
    HEADROOM_RESIDUAL_NOTE,
    headroomDefaultBlocked,
    headroomFromSelect,
    headroomOptions,
    headroomToSelect,
  } from "$lib/agents/headroomSetup";
  import { headroomReading, watchHeadroom } from "$lib/agents/headroomState";
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
    dimInactiveWorkspaces,
    setDimInactiveWorkspaces,
  } from "$lib/sidebar/sidebarPrefs";
  import { hiddenHubViewCount, hubTabsHiddenDefault } from "$lib/hub/hubTabPrefs";
  import HubTabsModal from "$lib/hub/HubTabsModal.svelte";
  import { themeState } from "$lib/ui/themeState.svelte";
  import type { ThemePref } from "$lib/ui/theme";
  import IconButton from "$lib/ui/IconButton.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
  import {
    createSettingsSearchFallback,
    fallbackAllowed,
    withClosestMatch,
    type ClosestMatch,
  } from "$lib/core/settingsSearchFallback";
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import { grantForAnsweredPrompt, DAEMON_SUBJECT } from "$lib/core/confirmGate";
  import { featureBlockedReason, restartOutcome, restartConfirmLines } from "$lib/core/daemonCompat";
  import * as backend from "$lib/core/backend";
  import { typesafeSettings } from "$lib/agents/turnVerdictState";
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
  import { listen } from "@tauri-apps/api/event";
  import {
    ADMISSION_CLEAR,
    ADMISSION_NOTE,
    KEEP_RUNNING_NOTE,
    RELAY_NOTE,
    admissionAfterSave,
    admissionPlaceholder,
    admissionToSave,
    relayAdmissionBlocked,
    relayStateBlocked,
    relayStatus,
    relayUrlHint,
    relayUrlToSave,
    remoteAccessBlocked,
    transportNote,
    type DeviceList,
    type RelayState,
  } from "$lib/core/remoteAccess";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { DEVICES_LABEL } from "$lib/core/devicesPanel";
  import { relayIndicator } from "$lib/ui/indicators";
  import { profilesInUse } from "$lib/agents/agentPauseState";
  import { launchConfigStore, saveLaunchConfig } from "$lib/agents/launchQueue";
  import { ceilingFrom, type LaunchConfig } from "$lib/agents/launchGate";
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

  /// Built-ins ∪ app-wide customs. Defaults is where model/effort rows
  /// for those customs live; the Rust table alone has no named customs.
  const allProfiles = $derived(
    mergeAgentProfiles($agentProfilesStore, $agentDefaultsStore.customProfiles ?? [])
  );
  const profiles = $derived(allProfiles.filter((p) => p.modelFlag || isCustomProfileId(p.id)));

  /// Whether any agent in use can actually be asked about its limits. The
  /// limit gate is offered either way -- a workspace may switch agents --
  /// but saying so beats a control that silently never fires.
  const probed = $derived(
    $agentProfilesStore.some((p) => p.usageProbe && profilesInUse().includes(p.id))
  );

  /// The wall in force, never null: a config nobody has edited resolves
  /// to the shipped default so the fields always have values.
  const launch = $derived($launchConfigStore);

  function editLaunch(patch: Partial<LaunchConfig>): void {
    void saveLaunchConfig({ ...launch, ...patch });
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

  // --- default effort, per profile ----------------------------------------
  //
  // The model rows' machinery again, over `agentDefaults.agentEfforts`:
  // a picker of the CLI's levels, and a box for a level it does not list.
  /// Built-ins with an effort flag, plus every named custom in scope.
  const effortProfiles = $derived(allProfiles.filter((p) => p.effortFlag || isCustomProfileId(p.id)));
  let effortCustomOpen = $state<Record<string, boolean>>({});
  let effortDrafts = $state<Record<string, string>>({});

  function storedEffort(profileId: string): string {
    return $agentDefaultsStore.agentEfforts?.[profileId] ?? "";
  }

  function effortIsCustom(profile: { id: string; efforts?: string[] }): boolean {
    const value = storedEffort(profile.id);
    return effortCustomOpen[profile.id] || (value !== "" && !(profile.efforts ?? []).includes(value));
  }

  function pickEffort(profileId: string, value: string): void {
    if (value === CUSTOM_MODEL) {
      effortCustomOpen = { ...effortCustomOpen, [profileId]: true };
      effortDrafts = { ...effortDrafts, [profileId]: storedEffort(profileId) };
      return;
    }
    effortCustomOpen = { ...effortCustomOpen, [profileId]: false };
    void setAgentDefaults(withAgentEffort($agentDefaultsStore, profileId, value));
  }

  function commitCustomEffort(profileId: string): void {
    const value = (effortDrafts[profileId] ?? storedEffort(profileId)).trim();
    if (value === storedEffort(profileId)) return;
    void setAgentDefaults(withAgentEffort($agentDefaultsStore, profileId, value));
  }

  /// Named customs' API family: dark on a daemon that would drop it.
  const apiFamilyBlocked = $derived(featureBlockedReason($daemonCompat, "customApiFamily"));

  // --- headroom --------------------------------------------------------
  //
  // Live while this page is open: whether it is running, its port and the
  // lifetime total change by themselves, and an install's progress is
  // read off the status. Everything the section draws is
  // headroomSetup.ts's; the controls are shared with the wizard's step.
  onMount(() => watchHeadroom());
  const headroomDefaultGate = $derived(
    headroomDefaultBlocked($headroomReading, compressionSwitchBlocked($daemonCompat))
  );

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

  // The turn verdict. `turnVerdictBlocked` is the daemon gate: without
  // `Request::SessionScreen` (v39) there is no screen to judge, so the
  // switch is dark and says why rather than turning on a feature that
  // would skip every session anyway.
  const turnVerdictBlocked = $derived(featureBlockedReason($daemonCompat, "turnVerdict"));
  // Never the key itself -- the host answers with a boolean, and there is
  // no command that reads one back. The field below writes only.
  let typesafeKeyDraft = $state("");
  let typesafeKeyError = $state<string | null>(null);
  async function saveTypesafeKey() {
    typesafeKeyError = null;
    try {
      typesafeSettings.set(await backend.setTypesafeApiKey(typesafeKeyDraft));
      typesafeKeyDraft = "";
    } catch (e) {
      typesafeKeyError = String(e);
    }
  }
  async function setTypesafeOn(on: boolean) {
    typesafeKeyError = null;
    try {
      typesafeSettings.set(await backend.setTypesafeEnabled(on));
    } catch (e) {
      typesafeKeyError = String(e);
    }
  }
  // Change attribution's own switch. Not gated on the daemon: it reads
  // the bindings and runs git through the host, and needs no request an
  // older daemon lacks.
  async function setChangeAttributionOn(on: boolean) {
    typesafeKeyError = null;
    try {
      typesafeSettings.set(await backend.setTypesafeChangeAttribution(on));
    } catch (e) {
      typesafeKeyError = String(e);
    }
  }
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

  // --- remote access: the switch, the Relay, the admission token ------
  //
  // The template below is the ONE consumer of
  // `FEATURE_MIN_VERSION.remoteAccess`, which the handshake task added
  // and left dead (CLAUDE.md). Every control in the section reads
  // `remoteAccessGate`: without it the entry gates nothing, and a human
  // on a v41 daemon would press Pair a device and get a wire error
  // instead of the version they need.
  //
  // All the rules live in remoteAccess.ts. What is here is the wiring:
  // which call each control makes, which prompt it asks first, and the
  // refetch afterwards.
  const remoteAccessGate = $derived(remoteAccessBlocked($daemonCompat));
  // The admission field's own gate, on top of the section's: a daemon
  // older than v52 parses `SetRemoteAccess` and drops the token, so
  // against one the field would take a token and keep nothing.
  const admissionGate = $derived(relayAdmissionBlocked($daemonCompat));
  /// What "on" means for the daemon that is actually running: one older
  /// than v52 keeps the switch and dials nothing, and the note says so.
  const transportLine = $derived(transportNote($daemonCompat));

  let devices = $state<DeviceList | null>(null);
  let devicesError = $state<string | null>(null);
  let relayDraft = $state("");
  let relayFocused = false;
  /// What is being typed into the admission field, and nothing else: the
  /// field is write-only, so this is empty again the moment it is saved.
  let admissionDraft = $state("");
  /// Read once a second is not needed here: the relay line's age only has
  /// to be right when it is drawn, and every push re-stamps it.
  let nowMs = $state(Date.now());

  /// Whether the daemon reached its Relay: read once on open, then
  /// followed by the daemon's `relay-state-changed` push. Null until read,
  /// and for good against a daemon too old to be asked.
  let relayState = $state<RelayState | null>(null);

  const relayHint = $derived(relayUrlHint(relayDraft));
  const relayGate = $derived(relayStateBlocked($daemonCompat));
  const relayLine = $derived(relayStatus(relayState, nowMs));
  const relayBadge = $derived(
    relayLine.badge === null
      ? null
      : relayIndicator(
          relayLine.badge,
          relayState?.state === "failed" ? `${relayState.why}` : null
        )
  );

  async function refreshRelayState(): Promise<void> {
    if (remoteAccessGate !== null || relayGate !== null) return;
    try {
      relayState = await backend.getRelayState();
    } catch {
      // Not knowing is not a failure to connect.
      relayState = null;
    }
  }

  async function refreshDevices(): Promise<void> {
    if (remoteAccessGate !== null) return;
    devicesError = null;
    try {
      const list = await backend.listDevices();
      devices = list;
      nowMs = Date.now();
      // Same rule as the update endpoint's field: never clobber what the
      // human is in the middle of typing.
      if (!relayFocused) relayDraft = list.relayUrl ?? "";
    } catch (e) {
      devicesError = String(e instanceof Error ? e.message : e);
    }
  }

  // The first read, deliberately NOT in onMount. There may be no compat
  // verdict at mount -- `featureBlockedReason` answers null before the
  // app has connected rather than pre-emptively greying the section out
  // -- and asking then would send `ListDevices` to a daemon nobody has
  // classified yet, turning "restart the daemon" into a wire error. This
  // waits for the verdict and asks once it says the daemon can answer.
  $effect(() => {
    if (remoteAccessGate !== null || devices !== null) return;
    void refreshDevices();
  });
  $effect(() => {
    if (remoteAccessGate !== null || relayGate !== null || relayState !== null) return;
    void refreshRelayState();
  });

  // The Relay's state is the one push this section still hears: pairing
  // and the connect pushes moved to the Devices panel with the list.
  onMount(() => {
    const stop = listen<RelayState>("relay-state-changed", (event) => {
      relayState = event.payload;
      nowMs = Date.now();
    });
    return () => void stop.then((off) => off());
  });

  /// The switch and the relay go together: the request carries both, so
  /// sending one without the other would write the stale value of
  /// whichever was not being edited.
  ///
  /// The admission token does NOT go with them. It is passed only by the
  /// two controls that mean to change it; left out, the daemon keeps the
  /// one it has -- which is what lets the switch be toggled without the
  /// token being typed again.
  async function saveRemoteAccess(
    enabled: boolean,
    relay: string,
    admission?: string
  ): Promise<void> {
    const before = devices;
    devicesError = null;
    if (devices) {
      devices = {
        ...devices,
        remoteAccessEnabled: enabled,
        relayUrl: relayUrlToSave(relay),
        relayAdmissionSet: admissionAfterSave(devices, relayUrlToSave(relay), admission),
      };
    }
    try {
      await backend.setRemoteAccess(enabled, relayUrlToSave(relay), admission);
    } catch (e) {
      devices = before; // roll back a failed write
      devicesError = String(e instanceof Error ? e.message : e);
    }
  }

  /// The admission field lost focus. Nothing typed is nothing to save.
  async function saveAdmission(): Promise<void> {
    const token = admissionToSave(admissionDraft);
    if (token === undefined) return;
    // Emptied before the write, not after: the token should be on
    // screen, even as dots, for no longer than it takes to leave it.
    admissionDraft = "";
    await saveRemoteAccess(devices?.remoteAccessEnabled ?? false, relayDraft, token);
  }

  async function clearAdmission(): Promise<void> {
    admissionDraft = "";
    await saveRemoteAccess(devices?.remoteAccessEnabled ?? false, relayDraft, ADMISSION_CLEAR);
  }

  // --- search ---------------------------------------------------------
  /// One entry per section below, in the same order -- see
  /// SettingsHubView's own SECTIONS for why whole sections, not rows.
  ///
  /// Agents is one section with inner tabs (General, one per agent, and a
  /// trailing "+" to add a custom). Headroom, Tools and TypeSafe stay
  /// top-level. Updates / Daemon / Remote access are app-wide
  /// infrastructure that used to live on each workspace's Settings tab
  /// by mistake.
  ///
  /// Agents is `AGENTS_SECTION` from agentsHub.ts — one keyword table for
  /// both panels. The settingsSearch surface greps splice it in when they
  /// see the bare reference (string literals alone cannot stay in lockstep).
  const SECTIONS: SettingsSection[] = [
    {
      id: "appearance",
      keywords: ["Appearance", "Theme", "Light", "Dark", "system", "dark mode", "colour scheme", "color scheme"],
    },
    { id: "sidebar", keywords: ["Sidebar", "Scratchpad", "Hover to expand", "hover", "peek"] },
    { id: "hub-tabs", keywords: ["Hub tabs", "Sections", "tab row", "hidden"] },
    { id: "terminal", keywords: ["Terminal", "Font size", "font", "text size", "zoom"] },
    {
      id: "cards",
      keywords: ["Cards", "Auto commit", "auto-commit", "commit", "Require review", "review"],
    },
    {
      id: "git",
      keywords: ["Git", "Track gavin's files", "tracking", "gitignore", "initialize"],
    },
    AGENTS_SECTION,
    {
      id: "headroom",
      keywords: [
        "Headroom",
        "compression",
        "compress",
        "tokens saved",
        "savings",
        "proxy",
        "uv",
        "Install",
        "Update",
        "Locate",
        "Check again",
      ],
    },
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
    {
      id: "typesafe",
      keywords: [
        "TypeSafe",
        "Turn verdict",
        "Change attribution",
        "second opinion",
        "API key",
        "question",
        "asking",
        "failure cause",
        "whose change",
        "attribution",
        "shared checkout",
        "jev",
        "settings search",
        "closest match",
        "card link",
        "which card",
        "commit",
        "closest by meaning",
        "search by meaning",
      ],
    },
    {
      id: "memory-wall",
      keywords: [
        "Memory wall",
        "memory",
        "RAM",
        "pressure",
        "ceiling",
        "agents running at once",
        "max agents",
        "concurrent",
        "limit agents",
      ],
    },
    {
      id: "updates",
      keywords: [
        "Updates",
        "Check for updates",
        "Install",
        "Endpoint",
        "update channel",
        "version",
        "upgrade",
        "new version",
        "beta",
      ],
    },
    { id: "daemon", keywords: ["Daemon", "Restart daemon", "gavin-daemon"] },
    {
      id: "remote-access",
      keywords: [
        "Remote access",
        "token",
        "local access",
        "Relay URL",
        "relay",
        "Admission token",
        "push",
        "phone",
        "device",
        "Devices",
      ],
    },
  ];
  let settingsQuery = $state("");
  const literalFilter = $derived(searchSettings(SECTIONS, settingsQuery));
  /// When the matcher finds nothing: the by-meaning fallback's answer for
  /// the settled query, or null. See settingsSearchFallback.ts for the
  /// four promises it keeps. Behind the turn verdict's toggle and key
  /// below -- the one consent that covers every TypeSafe request the app
  /// makes, and whose copy names what this one sends.
  let closestMatch = $state<ClosestMatch | null>(null);
  const searchFallback = createSettingsSearchFallback({
    ask: backend.typesafeAsk,
    allowed: () => fallbackAllowed($typesafeSettings),
    onClosest: (c) => (closestMatch = c),
  });
  $effect(() => {
    searchFallback.note(SECTIONS, settingsQuery, literalFilter);
  });
  $effect(() => () => searchFallback.dispose());
  /// What the panel shows: the literal result, or under an empty one the
  /// closest section, marked. Every `hidden=` below reads this; the box's
  /// own count reads the literal result, so it keeps saying what the
  /// matcher found.
  const settingsFilter = $derived(withClosestMatch(literalFilter, closestMatch, settingsQuery));
  let selectedSection = $state(SECTIONS[0].id);
  $effect(() => {
    if (settingsFilter.visible(selectedSection)) return;
    const first = SECTIONS.find((s) => settingsFilter.visible(s.id));
    if (first) selectedSection = first.id;
  });
  function sectionLabel(section: SettingsSection): string {
    return section.keywords[0] ?? section.id;
  }

  // --- Agents hub --------------------------------------------------------
  let agentsTab = $state<AgentsHubTab>(GENERAL_TAB);
  let agentsQuerySeen = $state("");
  let newCustomName = $state("");
  const agentsTabs = $derived(agentsHubTabs(allProfiles, ADD_TAB_HINT.app));
  /// The agent General is about: the app-wide default, and what its label
  /// reads as in the heading over the block.
  const defaultAgentId = $derived(effectiveDefaultAgent($agentDefaultsStore));
  const defaultAgentLabel = $derived(
    allProfiles.find((p) => p.id === defaultAgentId)?.label ?? defaultAgentId
  );
  $effect(() => {
    const q = settingsQuery;
    if (selectedSection !== "agents" || !q.trim() || q === agentsQuerySeen) return;
    agentsQuerySeen = q;
    agentsTab = agentsTabForQuery("app", q, allProfiles);
  });
  $effect(() => {
    const valid = validAgentsTab(agentsTab, allProfiles, true);
    if (valid !== agentsTab) agentsTab = valid;
  });

  const activeAgentProfile = $derived(allProfiles.find((p) => p.id === agentsTab) ?? null);
  const activeCustom = $derived(
    ($agentDefaultsStore.customProfiles ?? []).find((p) => p.id === agentsTab) ?? null
  );

  async function addAppCustom(): Promise<void> {
    const next = addCustomProfile($agentDefaultsStore.customProfiles ?? [], newCustomName.trim() || "Custom");
    const added = next.find((p) => !($agentDefaultsStore.customProfiles ?? []).some((o) => o.id === p.id));
    await setAgentDefaults({ ...$agentDefaultsStore, customProfiles: next });
    newCustomName = "";
    if (added) agentsTab = added.id;
  }

  async function patchActiveCustom(partial: Partial<Omit<CustomProfile, "id">>): Promise<void> {
    if (!activeCustom) return;
    await setAgentDefaults({
      ...$agentDefaultsStore,
      customProfiles: updateCustomProfile($agentDefaultsStore.customProfiles ?? [], activeCustom.id, partial),
    });
  }

  async function renameActiveCustom(label: string): Promise<void> {
    if (!activeCustom) return;
    await setAgentDefaults({
      ...$agentDefaultsStore,
      customProfiles: renameCustomProfile($agentDefaultsStore.customProfiles ?? [], activeCustom.id, label),
    });
  }

  async function deleteActiveCustom(): Promise<void> {
    if (!activeCustom) return;
    const ok = await askConfirm({
      title: `Delete “${activeCustom.label}”?`,
      lines: [
        "Workspaces still pointing at this custom will fall back to the default agent until they pick another.",
      ],
      confirmLabel: "Delete custom",
      danger: true,
    });
    if (!ok) return;
    const id = activeCustom.id;
    await setAgentDefaults(agentDefaultsWithoutCustom($agentDefaultsStore, id));
    // And every workspace's own per-agent keys for it.
    await dropProfileRefsFromWorkspaces(id);
    agentsTab = GENERAL_TAB;
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
        matches={literalFilter.filtering ? literalFilter : null}
      />
    </div>
    <nav class="nav-list" aria-label="Settings sections">
      {#if settingsFilter.closest}
        <span class="nav-closest">Closest match</span>
      {/if}
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
      <div class="row">
        <span>Sidebar</span>
        <label class="check">
          <input
            type="checkbox"
            checked={$dimInactiveWorkspaces}
            onchange={(e) => setDimInactiveWorkspaces(e.currentTarget.checked)}
          />
          <span>Dim workspaces that are not current</span>
        </label>
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

    <section hidden={!settingsFilter.visible("agents") || selectedSection !== "agents"}>
      <h3>Agents</h3>
      <AgentsHubTabs tabs={agentsTabs} tab={agentsTab} onTab={(t) => (agentsTab = t)} />

      {#if agentsTab === GENERAL_TAB}
        <label class="row">
          <span>Default agent</span>
          <select
            value={effectiveDefaultAgent($agentDefaultsStore)}
            onchange={(e) =>
              void setAgentDefaults({
                ...$agentDefaultsStore,
                defaultAgent: e.currentTarget.value,
              })}
          >
            {#each allProfiles as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </label>
        <p class="hint">
          Used when a workspace has not chosen its own agent. Today that silent fallback was Claude
          Code; this setting makes it explicit. Everything below is that agent's own configuration —
          the same settings its tab shows.
        </p>

        <!-- General edits the SELECTED default agent's own settings: the same
             data its tab shows, so switching the default above just points
             this block at another agent. -->
        <h3 class="sub">{defaultAgentLabel}</h3>
        <AgentPrimaryPanel
          scope="app"
          primaryId={defaultAgentId}
          label={defaultAgentLabel}
          profiles={allProfiles}
          limitsProbed={probed}
        />
      {:else if activeAgentProfile}
        {#if activeCustom}
          <label class="row">
            <span>Name</span>
            <input
              spellcheck="false"
              value={activeCustom.label}
              onblur={(e) => void renameActiveCustom(e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label class="row">
            <span>Command</span>
            <input
              spellcheck="false"
              value={activeCustom.command}
              onblur={(e) => void patchActiveCustom({ command: e.currentTarget.value.trim() })}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label class="row">
            <span>Model flag</span>
            <input
              spellcheck="false"
              value={activeCustom.modelFlag}
              onblur={(e) => void patchActiveCustom({ modelFlag: e.currentTarget.value.trim() })}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label class="row">
            <span>Effort flag</span>
            <input
              spellcheck="false"
              value={activeCustom.effortFlag ?? ""}
              onblur={(e) => void patchActiveCustom({ effortFlag: e.currentTarget.value.trim() })}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <label class="row">
            <span>API family</span>
            <select
              value={activeCustom.apiFamily ?? ""}
              disabled={Boolean(apiFamilyBlocked)}
              title={apiFamilyBlocked ?? ""}
              onchange={(e) =>
                void patchActiveCustom({ apiFamily: e.currentTarget.value as ApiFamily | "" })}
            >
              <option value="">—</option>
              {#each API_FAMILIES as family (family.value)}
                <option value={family.value}>{family.label}</option>
              {/each}
            </select>
          </label>
          {#if apiFamilyBlocked}
            <p class="hint warn">{apiFamilyBlocked}</p>
          {/if}
          <p class="row-actions">
            <button type="button" class="danger" onclick={() => void deleteActiveCustom()}>Delete</button>
          </p>
        {/if}

        {#if activeAgentProfile.modelFlag || isCustomProfileId(activeAgentProfile.id)}
          <div class="row">
            <span>Default model</span>
            <select
              value={selectValue(activeAgentProfile)}
              onchange={(e) => pick(activeAgentProfile.id, e.currentTarget.value)}
            >
              {#each modelOptions(activeAgentProfile, "") as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if isCustom(activeAgentProfile)}
              <input
                class="custom"
                spellcheck="false"
                placeholder="model name"
                value={drafts[activeAgentProfile.id] ?? stored(activeAgentProfile.id)}
                oninput={(e) => (drafts = { ...drafts, [activeAgentProfile.id]: e.currentTarget.value })}
                onblur={() => commitCustom(activeAgentProfile.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
        {/if}
        {#if activeAgentProfile.effortFlag || isCustomProfileId(activeAgentProfile.id)}
          <div class="row">
            <span>Default effort</span>
            <select
              value={effortIsCustom(activeAgentProfile) ? CUSTOM_MODEL : storedEffort(activeAgentProfile.id)}
              onchange={(e) => pickEffort(activeAgentProfile.id, e.currentTarget.value)}
            >
              {#each effortOptions({ effortFlag: activeAgentProfile.effortFlag ?? "", efforts: activeAgentProfile.efforts ?? [] }, "") as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if effortIsCustom(activeAgentProfile)}
              <input
                class="custom"
                spellcheck="false"
                placeholder="effort"
                value={effortDrafts[activeAgentProfile.id] ?? storedEffort(activeAgentProfile.id)}
                oninput={(e) =>
                  (effortDrafts = { ...effortDrafts, [activeAgentProfile.id]: e.currentTarget.value })}
                onblur={() => commitCustomEffort(activeAgentProfile.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
        {/if}

        <AgentPrimaryPanel
          scope="app"
          primaryId={activeAgentProfile.id}
          label={activeAgentProfile.label}
          profiles={allProfiles}
          limitsProbed={probed}
        />
      {:else if agentsTab === ADD_TAB}
        <div class="row">
          <input
            class="custom"
            spellcheck="false"
            placeholder="New custom name"
            aria-label="New custom agent name"
            bind:value={newCustomName}
            onkeydown={(e) => {
              if (e.key === "Enter") void addAppCustom();
            }}
          />
          <button type="button" onclick={() => void addAppCustom()}>Add custom</button>
        </div>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("headroom") || selectedSection !== "headroom"}>
      <h3>Headroom</h3>
      <p class="hint">
        Headroom compresses what your agents send their model — tool output, logs, file reads — so
        the same work spends less of a subscription's limit. gavin installs a version it has tested,
        runs it as part of the daemon, and routes an agent through it only in a workspace with
        compression on.
      </p>
      <div class="compression-controls">
        <HeadroomControls reading={$headroomReading} />
      </div>
      <div class="row">
        <label for="headroom-default">Compression</label>
        <!-- The reason hangs on the wrapping span, not the select: a
             disabled element fires no mouseenter, so a tooltip on it can
             never open. -->
        <span use:tooltip={headroomDefaultGate ?? ""}>
          <select
            id="headroom-default"
            value={headroomToSelect($headroomDefault)}
            disabled={headroomDefaultGate !== null}
            onchange={(e) => void setHeadroomDefault(headroomFromSelect(e.currentTarget.value))}
          >
            {#each headroomOptions(DEFAULT_HEADROOM) as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </span>
      </div>
      {#if headroomDefaultGate}
        <p class="hint warn">{headroomDefaultGate}</p>
      {/if}
      <p class="hint">
        Every workspace that sets nothing of its own follows this. It starts off, so installing
        Headroom never changes how a workspace already talks to its model; a workspace can switch it
        either way on its own Settings tab, under Headroom.
      </p>
      <p class="hint">{HEADROOM_RESIDUAL_NOTE}</p>
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

    <section hidden={!settingsFilter.visible("typesafe") || selectedSection !== "typesafe"}>
      <h3>TypeSafe</h3>
      <p class="hint">
        Two features take a second opinion from TypeSafe, each behind a switch of its own, both on the
        one key below. Each one says what it sends; neither sends anything until you turn it on.
      </p>
      <p class="hint">
        <strong>Turn verdict.</strong> When an agent goes quiet, gavin decides its turn ended from two seconds of silence and one
        error string — which only Claude Code has. An agent that asks you something in a sentence
        rings no bell, so a rail walks past the question; an agent of any other CLI that breaks
        reads as one that finished. Switching this on takes a second opinion.
      </p>
      <p class="hint warn">
        <strong>What leaves this machine.</strong> For a session running a card or a rail step, and
        for no other, gavin sends the last 40 rows of that terminal — the agent's output as it
        appears on screen, which can include file contents, paths and anything else it printed — to
        <code>api.typesafe.ai</code>, once each time that session goes quiet. Nothing is sent for a
        terminal you opened yourself. It costs about $0.00007 a turn, on your key. The settings
        search box — this page's and each workspace's Settings tab's — asks the same service when
        nothing matches what you typed: it sends the words in the box and the sections' own keyword
        lists, and nothing from any workspace, for about $0.00004 a query. The answer is shown under
        a "Closest match" line, never as a hit.
      </p>
      <p class="hint warn">
        <strong>The same switch links commits and searches to cards.</strong> With it on, selecting a
        commit in the Git tab's history sends that commit's message and changed file paths, with the
        title of every card on the board, to <code>api.typesafe.ai</code>, and the pane names the card
        the commit was made for. A board search that matches no card sends the words you typed with
        the same titles, and the board offers the closest cards by meaning. Never a diff, a card's body
        or a file's contents. A link is shown, never written to a card or a commit. About $0.0001 a
        request, on your key.
      </p>
      <div class="row">
        <span>Second opinion</span>
        <label class="check">
          <input
            type="checkbox"
            checked={$typesafeSettings?.enabled ?? false}
            disabled={turnVerdictBlocked !== null}
            onchange={(e) => void setTypesafeOn(e.currentTarget.checked)}
          />
          <span>Ask TypeSafe what a quiet turn came to</span>
        </label>
      </div>
      {#if turnVerdictBlocked}
        <p class="hint warn">{turnVerdictBlocked}</p>
      {/if}
      <p class="hint">
        <strong>Change attribution.</strong> Gavin attributes a change to a card by the commit its run
        started on. In a checkout several cards share, that makes every file every card's: a run's
        Changes view lists other sessions' files as its own, the Review tab groups cards that only
        shared a folder, and the discard prompt cannot say what else goes with the reset. Switching this
        on asks TypeSafe, one changed file at a time, which of the cards that ran in that checkout the
        change belongs to, and shows the answer as a hint: a chip on the file, a line in the discard
        prompt, a collision the Review tab sets aside. It never removes a file from a list and never
        changes what a discard resets.
      </p>
      <p class="hint warn">
        <strong>A separate switch, because more leaves this machine.</strong> Only when another card has
        run in the same checkout, and only when you open a run's changes or the Review tab, gavin sends
        <code>api.typesafe.ai</code> a diff excerpt of each changed file — up to 70 changed lines of your
        source code — together with the card titles and bodies of the cards that ran there. Lockfiles
        and images are skipped. About $0.0001 a file, on your key; nothing is sent for a run alone in
        its worktree.
      </p>
      <div class="row">
        <span>Change attribution</span>
        <label class="check">
          <input
            type="checkbox"
            checked={$typesafeSettings?.changeAttribution ?? false}
            onchange={(e) => void setChangeAttributionOn(e.currentTarget.checked)}
          />
          <span>Ask TypeSafe which card a changed file belongs to</span>
        </label>
      </div>
      <div class="row">
        <span>API key</span>
        <input
          type="password"
          autocomplete="off"
          placeholder={$typesafeSettings?.hasKey ? "A key is set — type a new one to replace it" : "sk-ts-…"}
          bind:value={typesafeKeyDraft}
          onkeydown={(e) => {
            if (e.key === "Enter") void saveTypesafeKey();
          }}
        />
        <button onclick={() => void saveTypesafeKey()}>
          {typesafeKeyDraft.trim() === "" && $typesafeSettings?.hasKey ? "Clear" : "Save"}
        </button>
      </div>
      {#if typesafeKeyError}
        <p class="hint warn">{typesafeKeyError}</p>
      {/if}
      <p class="hint">
        Kept in gavin's <code>config.json</code>, which is readable only by you. It never reaches
        this window — gavin can tell you whether a key is set, not what it is — and it is passed to
        the request on standard input, so it never appears in a process list. Saving an empty field
        clears it.
      </p>
      <p class="hint">
        A second opinion and never a replacement: the daemon's own verdict is untouched, and a
        timeout, an error, a missing key or an answer gavin is not confident in all fall back to
        exactly what it does today. Turning this on can sharpen a verdict; it cannot make one worse.
      </p>
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

      <!-- The switch, the Relay and the admission token. Everything from
           here down is greyed together when the daemon is too old, and
           the reason names the version it needs. The reason hangs on
           WRAPPING spans, never on the disabled control: a disabled
           element fires no mouseenter, so a tooltip on it never opens. -->
      <h3 class="sub">Relay</h3>
      {#if remoteAccessGate}
        <p class="hint warn">{remoteAccessGate}</p>
      {/if}
      <p class="hint">{transportLine}</p>

      <span use:tooltip={remoteAccessGate ?? ""}>
        <label class="check">
          <input
            type="checkbox"
            disabled={remoteAccessGate !== null || devices === null}
            checked={devices?.remoteAccessEnabled ?? false}
            onchange={(e) => void saveRemoteAccess(e.currentTarget.checked, relayDraft)}
          />
          Remote access
        </label>
      </span>
      <p class="hint">{KEEP_RUNNING_NOTE}</p>

      <div class="row endpoint-row">
        <span>Relay URL</span>
        <span class="grow" use:tooltip={remoteAccessGate ?? ""}>
          <input
            type="text"
            placeholder="wss://relay.example/gavin"
            disabled={remoteAccessGate !== null || devices === null}
            bind:value={relayDraft}
            onfocus={() => (relayFocused = true)}
            onblur={() => {
              relayFocused = false;
              void saveRemoteAccess(devices?.remoteAccessEnabled ?? false, relayDraft);
            }}
          />
        </span>
      </div>
      {#if relayBadge}
        <p class="hint relay-status">
          <StatusBadge indicator={relayBadge} text={relayLine.text} />
          {#if relayLine.detail}
            <span class="detail">{relayLine.detail}</span>
          {/if}
        </p>
      {/if}
      <p class="hint">
        {RELAY_NOTE}
        {#if relayHint}
          <span class="detail">{relayHint}</span>
        {/if}
      </p>

      <!-- Write-only. The field starts empty whether or not a token is
           stored, and says which in its placeholder; what is typed is
           saved on leaving the field and the field is emptied. -->
      <div class="row endpoint-row">
        <span>Admission token</span>
        <span class="grow" use:tooltip={remoteAccessGate ?? admissionGate ?? ""}>
          <input
            type="password"
            autocomplete="off"
            placeholder={admissionPlaceholder(devices?.relayAdmissionSet ?? false)}
            disabled={remoteAccessGate !== null || admissionGate !== null || devices === null}
            bind:value={admissionDraft}
            onblur={() => void saveAdmission()}
          />
        </span>
        <span use:tooltip={remoteAccessGate ?? admissionGate ?? ""}>
          <button
            type="button"
            class="manage"
            disabled={remoteAccessGate !== null || admissionGate !== null || !devices?.relayAdmissionSet}
            onclick={() => void clearAdmission()}
          >
            Clear token
          </button>
        </span>
      </div>
      <p class="hint">
        {ADMISSION_NOTE}
        {#if admissionGate && remoteAccessGate === null}
          <span class="warn">{admissionGate}</span>
        {/if}
      </p>

      <p class="hint">
        Pairing a phone and the list of paired Devices are in the sidebar's
        {DEVICES_LABEL} panel.
      </p>
      {#if devicesError}
        <p class="hint warn">{devicesError}</p>
      {/if}
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
  /* The line over a section the by-meaning fallback picked: it is not a
     hit, and the box's count above still says zero. */
  .nav-closest {
    padding: 4px 8px 2px;
    color: var(--text-subtle);
    font-size: 0.72rem;
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
  .compression-controls {
    margin: 12px 0;
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
  /* A heading INSIDE a section: Remote access carries two halves --
     phase 1's local-token switch and phase 2's devices -- and the search
     box narrows whole sections, so splitting them into two nav entries
     would put a wall between a switch and the paragraph that explains
     what it is a switch on. */
  h3.sub {
    margin-top: 18px;
  }
  /* The tooltip's wrapping span must not collapse the field it holds. */
  .row span.grow {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
  }
  .row span.grow input {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
