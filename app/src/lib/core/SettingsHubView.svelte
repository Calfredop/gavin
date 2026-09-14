<script lang="ts">
  import {
    layoutState,
    renameWorkspace,
    setWorkspaceColor,
    setWorkspaceFlag,
    setWorkspacePause,
    setWorkspaceFallback,
    setAgentField,
    setPrdPath,
    agentProfilesStore,
    agentModelDefaultsStore,
    mcpFormatsStore,
    daemonCompat,
    terminalFontSizeDefault,
    setWorkspaceFontSize,
    autoCommitDefault,
    setWorkspaceAutoCommit,
    requireReviewDefault,
    setWorkspaceRequireReview,
    agentDefaultsStore,
    setAgentDefaults,
    setWorkspaceComplexityTable,
    markGitTrackingAsked,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import ComplexityTable from "$lib/cards/ComplexityTable.svelte";
  import type { Complexity, ComplexityAgent } from "$lib/cards/complexity";
  import { fontSizeOptions, resolveTerminalFontSize } from "$lib/terminal/terminalFont";
  import {
    autoCommitFromSelect,
    autoCommitOptions,
    autoCommitToSelect,
    resolveAutoCommit,
  } from "$lib/git/autoCommit";
  import {
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
    resolveRequireReview,
  } from "$lib/cards/cardReview";
  import {
    canToggleTracking,
    needsUntrackConfirm,
    trackingSummary,
    untrackConfirm,
    type ConfirmCopy,
    type GavinTracking,
  } from "$lib/git/gitTracking";
  import { gavinTrees } from "$lib/core/gavinState";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { modelIsCustom as modelIsCustomFor, modelOptions, CUSTOM_MODEL } from "$lib/agents/agentModel";
  import {
    resolveAgentConfig,
    validateAgentFileName,
    validateMcpConfigPath,
    validatePrdPath,
    resolvePrdPath,
    DEFAULT_PRD_PATH,
    prdPathFromPick,
    agentFileFromPick,
    renameDecision,
    deleteBlockedReason as deleteBlockedReasonFor,
    fieldCommit,
    DEFAULT_ACCENT,
  } from "$lib/core/settings";
  import { pickPath } from "$lib/workspace/picker";
  import * as backend from "$lib/core/backend";
  import SuperpowersControls from "$lib/agents/SuperpowersControls.svelte";
  import ConfigTrustNotice from "$lib/workspace/ConfigTrustNotice.svelte";
  import WorkspaceRootControl from "$lib/workspace/WorkspaceRootControl.svelte";
  import ColourPicker from "$lib/core/ColourPicker.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
  import Modal from "$lib/core/Modal.svelte";
  import ConfirmPrompt from "$lib/core/ConfirmPrompt.svelte";
  import AgentChangeWizard from "$lib/workspace/AgentChangeWizard.svelte";
  import FallbackChainEditor from "$lib/workspace/FallbackChainEditor.svelte";
  import WorkspaceDeleteWizard from "$lib/workspace/WorkspaceDeleteWizard.svelte";
  import { tooltip } from "$lib/core/tooltip";
  import { MIN_PERIOD_MINUTES, validateCycle } from "$lib/agents/agentPause";
  import { agentPauseStore, editableCycle, nowStore, pauseFor } from "$lib/agents/agentPauseState";
  import { armNewlyAdded } from "$lib/agents/agentFallbackState";
  import {
    effectiveFallbackChain,
    fallbackThresholdFor,
    sanitizeFallbackThreshold,
  } from "$lib/agents/agentFallback";
  import { superpowersLabel, type SuperpowersMark, type SuperpowersStatus } from "$lib/agents/superpowers";
  import { UNFILED_WORKSPACE_ID } from "$lib/core/workspace";
  import HubTabsModal from "$lib/hub/HubTabsModal.svelte";
  import {
    hiddenHubViewCount,
    hubTabsHiddenByWorkspace,
    hubTabsHiddenDefault,
  } from "$lib/hub/hubTabPrefs";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);

  /// What this workspace would inherit, and what an override starts from.
  const appCycle = $derived($agentPauseStore);
  const inheritedCycle = $derived(editableCycle(null));
  /// Recomputed on every clock tick, so the "right now" line below is a
  /// live countdown rather than whatever was true when the tab mounted.
  const pauseNow = $derived(pauseFor(workspaceId, $nowStore));
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agent = $derived(
    resolveAgentConfig($trustedAgentConfigs(workspaceId), $agentProfilesStore, $agentModelDefaultsStore, {
      command: $agentDefaultsStore.customCommand,
      modelFlag: $agentDefaultsStore.customModelFlag,
    })
  );
  const configWarning = $derived(Boolean(rootContext?.configWarning));
  const hasRoot = $derived(Boolean(ws?.rootPath));
  const profileLabel = $derived(
    $agentProfilesStore.find((p) => p.id === agent.profileId)?.label ?? agent.profileId
  );

  // The Superpowers row's two inputs. Re-read on demand rather than
  // watched: this is a settings panel, not a live view, and the only
  // things that change either value are the controls right below.
  // undefined until the first read lands, so the row can say "checking"
  // instead of drawing an Install button for an unknown state.
  let superpowers = $state<SuperpowersStatus | undefined>(undefined);
  let superpowersMark = $state<SuperpowersMark | undefined>(undefined);
  let spToken = 0;
  async function readSuperpowers(): Promise<void> {
    const root = ws?.rootPath;
    // Cleared first, and the token bumped in the same breath: a switch to
    // another workspace must not leave the previous one's answer on
    // screen, nor let its in-flight read land here.
    superpowers = undefined;
    superpowersMark = undefined;
    const mine = ++spToken;
    if (!root) return;
    const [status, marks] = await Promise.all([
      backend.superpowersStatus(root, agent.command).catch(() => undefined),
      backend.getSuperpowersMarks().catch(() => ({}) as Record<string, SuperpowersMark>),
    ]);
    if (mine !== spToken) return;
    superpowers = status;
    superpowersMark = marks[root];
  }
  $effect(() => {
    void ws?.rootPath;
    // The profile decides which detector runs, so a profile switch has to
    // re-ask -- otherwise the row keeps answering for the agent that was
    // selected a moment ago.
    void agent.profileId;
    void readSuperpowers();
  });

  // Drafts exist so a watcher push cannot overwrite a field mid-type
  // (spec §5.2): a focused input keeps its draft, everything else follows
  // the store.
  let nameDraft = $state("");
  let commandDraft = $state("");
  let fileDraft = $state("");
  let mcpFileDraft = $state("");
  let prdDraft = $state("");
  let focused = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let mcpFileError = $state<string | null>(null);
  let prdError = $state<string | null>(null);
  let pendingMove = $state<{ from: string; to: string } | null>(null);
  /// Opens the agent-change confirm wizard. When equal to the current
  /// profile it is a re-run of setup for that agent; otherwise it is a
  /// switch. Null while no wizard is open. The Profile select keeps
  /// showing the current profile until a switch commits (or cancels).
  let pendingProfileChange = $state<string | null>(null);

  // --- search -------------------------------------------------------------
  /// One entry per section below, in the same order -- the id is what a
  /// section's `hidden` attribute reads back, and the keywords are the
  /// words a human would type for it: the title, its row labels, and a
  /// few of its own nouns, not the connecting prose around them.
  ///
  /// Agent before Complexity: the table names which agent runs each
  /// level, so the profile/command that feed it have to sit above it.
  /// App-wide controls (Updates, Daemon, Remote access) live in the
  /// sidebar Settings page — this panel is per-workspace only.
  const SECTIONS: SettingsSection[] = [
    { id: "workspace", keywords: ["Workspace", "Name", "rename", "Colour", "Color", "accent", "Root", "folder"] },
    { id: "hub-tabs", keywords: ["Hub tabs", "Sections", "tab row", "hidden"] },
    { id: "terminal", keywords: ["Terminal", "Font size", "font"] },
    { id: "cards", keywords: ["Cards", "Auto commit", "commit", "Require review", "review"] },
    { id: "git", keywords: ["Git", "Track", "tracking", "gitignore", "repository"] },
    {
      id: "agent",
      keywords: [
        "Agent",
        "Profile",
        "Command",
        "Model flag",
        "Model",
        "Agent file",
        "PRD file",
        "MCP config",
        "MCP format",
        "Superpowers",
      ],
    },
    { id: "complexity", keywords: ["Complexity", "difficulty", "agent", "model"] },
    { id: "agent-pause", keywords: ["Agent pause", "pause", "cycle", "limit", "usage"] },
    {
      id: "fallback-agent",
      keywords: ["Fallback agent", "fallback chain", "usage limit", "arm"],
    },
    {
      id: "unattended-recovery",
      keywords: ["Unattended recovery", "Resume", "auto resume", "broken card run"],
    },
    { id: "notifications", keywords: ["Notifications", "notify", "needs my input", "session finishes"] },
    { id: "confirmations", keywords: ["Confirmations", "Close confirm", "tab close"] },
    { id: "danger-zone", keywords: ["Danger zone", "Delete workspace", "delete"] },
  ];
  let settingsQuery = $state("");
  const settingsFilter = $derived(searchSettings(SECTIONS, settingsQuery));
  /// Which section the left navigator has selected. Search still hides
  /// unmatched sections; the nav only offers the ones that remain, and
  /// the content pane shows the selection rather than every match at
  /// once -- same shape as Files' tree + detail.
  let selectedSection = $state(SECTIONS[0].id);
  $effect(() => {
    if (settingsFilter.visible(selectedSection)) return;
    const first = SECTIONS.find((s) => settingsFilter.visible(s.id));
    if (first) selectedSection = first.id;
  });
  function sectionLabel(section: SettingsSection): string {
    return section.keywords[0] ?? section.id;
  }

  // --- terminal ---------------------------------------------------------
  /// What this workspace inherits when it sets no size of its own: the
  /// app-wide setting, or gavin's default when there isn't one. Named in
  /// the picker's first row so "Default" is never a number the panel
  /// leaves the reader to guess.
  const inheritedFontSize = $derived(resolveTerminalFontSize(undefined, $terminalFontSizeDefault));

  // --- cards ------------------------------------------------------------
  /// What this workspace inherits when it sets nothing of its own: the
  /// app-wide setting, or gavin's default when there isn't one. Named in
  /// the picker's first row for the same reason the font size is -- a
  /// panel must never show a box whose selected row is secretly doing
  /// something.
  const inheritedAutoCommit = $derived(resolveAutoCommit(undefined, $autoCommitDefault));
  const inheritedRequireReview = $derived(resolveRequireReview(undefined, $requireReviewDefault));

  // --- git --------------------------------------------------------------
  /// What git says about gavin's files in THIS root. Read on demand, like
  /// the Superpowers row above and for the same reason -- the answer lives
  /// in a `.gitignore` the human may have edited in another window, so a
  /// value cached at mount would be a claim rather than a reading.
  ///
  /// `null` while a read is out. The switch is disabled until one lands:
  /// rendering "tracked" for an unknown state is how a click lands on the
  /// opposite of what the human saw.
  let tracking = $state<GavinTracking | null>(null);
  let trackingBusy = $state(false);
  let trackingError = $state<string | null>(null);
  let untrackPrompt = $state<ConfirmCopy | null>(null);
  let trackToken = 0;
  async function readTracking(): Promise<void> {
    const root = ws?.rootPath;
    // Cleared before the token bumps, exactly as readSuperpowers does: a
    // workspace switch must not leave the last root's answer on screen,
    // nor let its in-flight read land under the new one.
    tracking = null;
    trackingError = null;
    const mine = ++trackToken;
    if (!root) return;
    try {
      const next = await backend.gavinGitTracking(root);
      if (mine === trackToken) tracking = next;
    } catch (e) {
      if (mine === trackToken) trackingError = String(e);
    }
  }
  $effect(() => {
    void ws?.rootPath;
    void readTracking();
  });

  /// Applies the switch. `untrack` is the human's separate answer about
  /// the index, never the toggle's own implication -- turning tracking off
  /// writes a rule, and staging deletions in a repo somebody may be
  /// mid-commit in is a second, larger thing to have agreed to.
  async function applyTracking(tracked: boolean, untrack: boolean): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    untrackPrompt = null;
    trackingBusy = true;
    trackingError = null;
    const mine = ++trackToken;
    try {
      const next = await backend.setGavinGitTracking(root, tracked, untrack);
      if (mine === trackToken) tracking = next;
      // Flipping the switch here IS answering the wizard's git step --
      // otherwise the step goes on asking a question this human has
      // already settled, in a panel that shows the answer.
      await markGitTrackingAsked(workspaceId);
    } catch (e) {
      if (mine === trackToken) trackingError = String(e);
    } finally {
      if (mine === trackToken) trackingBusy = false;
    }
  }

  /// The switch itself. Turning it OFF in a repo that has already
  /// committed some of gavin's files asks first, because the useful answer
  /// there ("and take them out of git") stages a change the human has to
  /// see coming. Everywhere else it just acts.
  function toggleTracking(tracked: boolean): void {
    if (needsUntrackConfirm(tracking, tracked)) {
      untrackPrompt = untrackConfirm(tracking?.indexed ?? 0);
      return;
    }
    void applyTracking(tracked, false);
  }

  // --- hub tabs ---------------------------------------------------------
  /// The eye list opens in a panel of its own, shared with app Settings:
  /// one component, so the two levels can never disagree about what the
  /// list contains or what inheriting means.
  let hubTabsOpen = $state(false);
  /// The effective set -- this workspace's own list while it has one, the
  /// app-wide default while it does not -- so the row counts what the
  /// strip actually hides rather than what was stored here.
  const hiddenHubTabs = $derived($hubTabsHiddenByWorkspace[workspaceId] ?? $hubTabsHiddenDefault);
  const hubTabsInherited = $derived(!(workspaceId in $hubTabsHiddenByWorkspace));

  // --- danger zone -----------------------------------------------------
  let deleting = $state(false);

  // Why Delete is unavailable, or null when it is available. A wizard
  // with no root has nothing to scan, and the Scratchpad is pinned --
  // there is no such thing as removing it.
  const deleteBlockedReason = $derived(
    deleteBlockedReasonFor(workspaceId === UNFILED_WORKSPACE_ID, hasRoot)
  );

  $effect(() => {
    const name = ws?.name ?? "";
    if (focused !== "name") nameDraft = name;
  });
  $effect(() => {
    const command = agent.command;
    if (focused !== "command") commandDraft = command;
  });
  $effect(() => {
    const file = agent.file;
    if (focused !== "file") fileDraft = file;
  });
  $effect(() => {
    const mcpFile = rootContext?.agent?.mcpFile ?? "";
    if (focused !== "mcpFile") mcpFileDraft = mcpFile;
  });

  /// Only `custom` gets these: every other profile's layout is verified
  /// in the Rust table, and a box that could override it would be a box
  /// for writing gavin's config to the wrong place.
  const isCustom = $derived(agent.profileId === "custom");
  const mcpFormat = $derived(rootContext?.agent?.mcpFormat ?? $mcpFormatsStore[0]?.id ?? "");

  // --- model ------------------------------------------------------------
  /// The profile row itself, for its flag and presets. `agent` above is
  /// the RESOLVED config, which carries neither.
  const profileInfo = $derived($agentProfilesStore.find((p) => p.id === agent.profileId) ?? null);
  /// What this workspace has set of its OWN, which is not agent.model:
  /// that one has already fallen back to the app-wide default, and the
  /// picker has to be able to tell "inheriting" from "chose the same
  /// value deliberately".
  const ownModel = $derived(rootContext?.agent?.model ?? "");
  const globalModel = $derived($agentModelDefaultsStore[agent.profileId] ?? "");
  /// A v13 daemon refuses the `model` key outright, so the control is
  /// disabled with the reason instead of failing on blur. This is the
  /// only surface that can produce a `model` payload -- the global panel
  /// writes config.json through Tauri and never asks the daemon.
  const modelBlocked = $derived(featureBlockedReason($daemonCompat, "agentModel"));

  // --- model flag -------------------------------------------------------
  /// What this workspace has set of its OWN, which is not
  /// `agent.modelFlag`: that one has already fallen back to the app-wide
  /// custom flag and then to the profile table's, and the box has to be
  /// able to tell "inheriting" from "typed the same thing deliberately".
  const ownModelFlag = $derived(rootContext?.agent?.modelFlag ?? "");
  /// A v30 daemon's SetRootConfigField allow-list has no `model_flag`,
  /// and it does not parse the key back out of config.toml either -- so
  /// a flag written there would compose a model onto a command that then
  /// went nowhere. This is the only surface that can produce the payload.
  const modelFlagBlocked = $derived(featureBlockedReason($daemonCompat, "agentModelFlag"));

  // --- complexity -------------------------------------------------------
  /// This workspace's own overrides. Per LEVEL: a level absent here runs
  /// whatever the app-wide table says, which is what the picker's first
  /// option spells out.
  const complexityTable = $derived(ws?.complexityAgents ?? {});

  // --- the lead document ------------------------------------------------
  /// Which file leads this workspace. Not an agent key: it lives at the
  /// root of config.toml and survives a change of CLI.
  const prdPath = $derived(resolvePrdPath(rootContext));
  /// A v16 daemon's SetRootConfigField allow-list has no `prd`, and it
  /// keeps resolving the PRD against the hard-coded path regardless of
  /// what is written -- so the row is disabled with the reason rather
  /// than accepting a choice nothing downstream would honour.
  const prdBlocked = $derived(featureBlockedReason($daemonCompat, "prdPath"));

  /// A v21 daemon parses the widened LinkCardSession perfectly well and
  /// drops `resumeAttempts` on the floor -- so every automatic resume
  /// would read the budget back as absent, decide the run had never been
  /// resumed, and resume it again. An unbounded loop wearing the costume
  /// of a limit is worse than no feature, so the switch is dark rather
  /// than merely unreliable.
  const autoResumeBlocked = $derived(featureBlockedReason($daemonCompat, "autoResume"));
  $effect(() => {
    const prd = prdPath;
    if (focused !== "prd") prdDraft = prd;
  });

  /// The one field where shown and stored differ: the box displays the
  /// RESOLVED path, so typing the scaffolded default back is a no-op,
  /// while emptying it clears the key -- and only when there is a key to
  /// clear.
  async function commitPrd(): Promise<void> {
    prdError = null;
    const commit = fieldCommit(prdDraft, prdPath, { empty: "clear", stored: rootContext?.prd ?? "" });
    if (commit.kind !== "write") return;
    if (commit.value !== "") {
      prdError = validatePrdPath(commit.value);
      if (prdError) return;
    }
    await setPrdPath(workspaceId, commit.value);
  }

  async function pickPrd(): Promise<void> {
    prdError = null;
    if (!ws?.rootPath) return;
    const picked = await pickPath({
      directory: false,
      defaultPath: ws.rootPath,
      title: "Choose the PRD file",
    });
    if (typeof picked !== "string") return;
    const result = prdPathFromPick(ws.rootPath, picked);
    if ("error" in result) {
      prdError = result.error;
      return;
    }
    prdDraft = result.path;
    await setPrdPath(workspaceId, result.path);
  }

  /// Points the workspace at an instructions file it already has. The
  /// rename flow below is a different intent -- it moves gavin's file to
  /// a new name -- so a pick never offers to move anything.
  async function pickAgentFile(): Promise<void> {
    fileError = null;
    if (!ws?.rootPath) return;
    const picked = await pickPath({
      directory: false,
      defaultPath: ws.rootPath,
      title: "Choose the agent instructions file",
    });
    if (typeof picked !== "string") return;
    const result = agentFileFromPick(ws.rootPath, picked);
    if ("error" in result) {
      fileError = result.error;
      return;
    }
    fileDraft = result.file;
    if (result.file !== agent.file) await setAgentField(workspaceId, "file", result.file);
  }

  let modelCustomOpen = $state(false);
  let modelDraft = $state("");
  $effect(() => {
    const model = ownModel;
    if (focused !== "model") modelDraft = model;
  });

  let modelFlagDraft = $state("");
  $effect(() => {
    const flag = ownModelFlag;
    if (focused !== "modelFlag") modelFlagDraft = flag;
  });

  const modelIsCustom = $derived(modelIsCustomFor(modelCustomOpen, ownModel, profileInfo?.models ?? []));

  function pickModel(value: string): void {
    if (value === CUSTOM_MODEL) {
      modelCustomOpen = true;
      modelDraft = ownModel;
      return;
    }
    modelCustomOpen = false;
    void setAgentField(workspaceId, "model", value);
  }

  /// As above, one fallback further: clearing goes back to the app-wide
  /// custom flag, or failing that to the profile table's own.
  function commitModelFlag(): void {
    const commit = fieldCommit(modelFlagDraft, ownModelFlag, { empty: "clear" });
    if (commit.kind === "write") void setAgentField(workspaceId, "model_flag", commit.value);
  }

  function setComplexity(level: Complexity, entry: ComplexityAgent | null): void {
    const next = { ...complexityTable };
    if (entry) next[level] = entry;
    else delete next[level];
    void setWorkspaceComplexityTable(workspaceId, next);
  }

  /// "" is a real value here, not a no-op: it removes the key and puts
  /// the workspace back on the app-wide default. The box shows this
  /// workspace's OWN model, so shown and stored are the same value.
  function commitModel(): void {
    const commit = fieldCommit(modelDraft, ownModel, { empty: "clear" });
    if (commit.kind === "write") void setAgentField(workspaceId, "model", commit.value);
  }

  function commitMcpFile(): void {
    mcpFileError = null;
    const commit = fieldCommit(mcpFileDraft, rootContext?.agent?.mcpFile ?? "", { empty: "keep" });
    if (commit.kind !== "write") return;
    mcpFileError = validateMcpConfigPath(commit.value);
    if (mcpFileError) return;
    void setAgentField(workspaceId, "mcp_file", commit.value);
  }

  /// A workspace cannot be called nothing, so an emptied box is a slip:
  /// the name stands until something is typed.
  function commitName(): void {
    const commit = fieldCommit(nameDraft, ws?.name ?? "", { empty: "keep" });
    if (commit.kind === "write") void renameWorkspace(workspaceId, commit.value);
  }

  /// Same as the name: an agent with no command is not a thing to save.
  function commitCommand(): void {
    const commit = fieldCommit(commandDraft, agent.command, { empty: "keep" });
    if (commit.kind === "write") void setAgentField(workspaceId, "command", commit.value);
  }

  async function commitFile(): Promise<void> {
    fileError = null;
    const next = fileDraft.trim();
    const problem = validateAgentFileName(next);
    if (problem) {
      fileError = problem;
      return;
    }
    if (!ws?.rootPath || next === agent.file) return;
    const [oldExists, targetExists] = await Promise.all([
      backend
        .readFileForViewer(`${ws.rootPath}/${agent.file}`)
        .then((r) => r.exists)
        .catch(() => false),
      backend
        .readFileForViewer(`${ws.rootPath}/${next}`)
        .then((r) => r.exists)
        .catch(() => false),
    ]);
    const decision = renameDecision(agent.file, next, oldExists, targetExists);
    if (decision === "error") {
      fileError = "That file name can't be used.";
      return;
    }
    if (decision === "prompt") {
      pendingMove = { from: agent.file, to: next };
      return;
    }
    await setAgentField(workspaceId, "file", next);
  }

  async function confirmMove(move: boolean): Promise<void> {
    const pending = pendingMove;
    pendingMove = null;
    if (!pending || !ws?.rootPath) return;
    if (move) {
      try {
        await backend.moveAgentFile(ws.rootPath, pending.from, pending.to);
      } catch (e) {
        fileError = String(e);
        return;
      }
    }
    await setAgentField(workspaceId, "file", pending.to);
  }
</script>

{#if ws}
  <div class="settings">
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
    <section hidden={!settingsFilter.visible("workspace") || selectedSection !== "workspace"}>
      <h3>Workspace</h3>
      <label class="row">
        <span>Name</span>
        <input
          bind:value={nameDraft}
          onfocus={() => (focused = "name")}
          onblur={() => {
            focused = null;
            commitName();
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </label>
      <div class="row">
        <span>Colour</span>
        <ColourPicker
          value={ws.color ?? DEFAULT_ACCENT}
          onChange={(c) => void setWorkspaceColor(workspaceId, c)}
        />
      </div>
      <div class="row">
        <span>Root</span>
        <WorkspaceRootControl workspace={ws} variant="settings" />
      </div>
    </section>

    <section hidden={!settingsFilter.visible("hub-tabs") || selectedSection !== "hub-tabs"}>
      <h3>Hub tabs</h3>
      <div class="row">
        <span>Sections</span>
        <button type="button" onclick={() => (hubTabsOpen = true)}>
          {hiddenHubViewCount(hiddenHubTabs) === 0
            ? "All shown"
            : `${hiddenHubViewCount(hiddenHubTabs)} hidden`}…
        </button>
      </div>
      <p class="hint">
        Which sections this workspace's tab row offers.
        {hubTabsInherited
          ? "It follows the app-wide list in Settings until you change something here."
          : "It keeps a list of its own."}
        Rearranging the row is done in the row itself — unlock it with the button at the end of the
        tabs.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("terminal") || selectedSection !== "terminal"}>
      <h3>Terminal</h3>
      <div class="row">
        <span>Font size</span>
        <select
          value={ws.terminalFontSize === undefined ? "" : String(ws.terminalFontSize)}
          onchange={(e) =>
            void setWorkspaceFontSize(
              workspaceId,
              e.currentTarget.value === "" ? null : Number(e.currentTarget.value)
            )}
        >
          {#each fontSizeOptions(inheritedFontSize, ws.terminalFontSize) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Only this workspace's terminals. Default follows the app-wide size in Settings, so leaving it
        alone is how a workspace tracks that.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("cards") || selectedSection !== "cards"}>
      <h3>Cards</h3>
      <div class="row">
        <span>Auto commit</span>
        <select
          value={autoCommitToSelect(ws.autoCommit)}
          onchange={(e) =>
            void setWorkspaceAutoCommit(workspaceId, autoCommitFromSelect(e.currentTarget.value))}
        >
          {#each autoCommitOptions(inheritedAutoCommit) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Whether a new task or plan card in this workspace starts asking the agent to commit its work
        when it finishes. Every card can still be switched either way on the card itself.
      </p>
      <div class="row">
        <span>Require review</span>
        <select
          value={requireReviewToSelect(ws.requireReview)}
          onchange={(e) =>
            void setWorkspaceRequireReview(workspaceId, requireReviewFromSelect(e.currentTarget.value))}
        >
          {#each requireReviewOptions(inheritedRequireReview) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Whether gavin shows what a card's body will hand an agent and asks for a deliberate yes before
        its first Run in this workspace. Off trusts every card the moment you press Run — the posture
        gavin had before the first-Run review existed.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("git") || selectedSection !== "git"}>
      <h3>Git</h3>
      {#if !hasRoot}
        <!-- Same shape the Agent section takes: without a root there is no
             repository to answer for, and a disabled switch beside a
             "Checking…" that never resolves reads as a hung panel. -->
        <p class="hint">Bind a root folder — there is no repository to track anything in yet.</p>
      {:else}
        <label class="check">
          <input
            type="checkbox"
            checked={tracking?.tracked ?? false}
            disabled={trackingBusy || !canToggleTracking(tracking)}
            onchange={(e) => toggleTracking(e.currentTarget.checked)}
          />
          Track gavin's files in git
        </label>
        <p class="hint">
          .gavin-root/ and every .gavin/ folder — the PRD, the cards, the rails. Off writes an
          ignore block into this repo's .gitignore; the files stay on disk either way and gavin goes
          on reading them.
        </p>
        <p class="hint">{trackingSummary(tracking)}</p>
        {#if trackingError}
          <p class="hint error">{trackingError}</p>
        {/if}
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("agent") || selectedSection !== "agent"}>
      <h3>Agent</h3>
      <!-- Above the Command field it gates: the field shows the RESOLVED
           command, so without this the panel would silently answer with
           the profile's while config.toml said something else. -->
      <ConfigTrustNotice {workspaceId} showApproved />
      {#if !hasRoot}
        <p class="hint">Bind a root folder to configure the agent.</p>
      {:else if configWarning}
        <p class="hint warn">
          This root's config.toml can't be parsed — fix it to edit these settings.
        </p>
      {:else}
        <label class="row">
          <span>Profile</span>
          <select
            value={agent.profileId}
            onchange={(e) => {
              const next = e.currentTarget.value;
              // Revert the select until the wizard commits: otherwise a
              // Cancel would leave the dropdown lying about config.toml.
              e.currentTarget.value = agent.profileId;
              if (next && next !== agent.profileId) pendingProfileChange = next;
            }}
          >
            {#each $agentProfilesStore as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </label>
        <p class="hint row-actions">
          <button
            type="button"
            class="linkish"
            onclick={() => (pendingProfileChange = agent.profileId)}
          >
            Set up {profileLabel} again…
          </button>
          — re-run MCP, skills and Superpowers for this agent without changing the profile.
        </p>
        {#if profileInfo?.usageProbe}
          <label class="row">
            <span>Walk at</span>
            <span class="pct-row">
              <input
                type="number"
                min="1"
                max="100"
                value={fallbackThresholdFor(agent.profileId, $agentDefaultsStore.fallbackThresholds)}
                onchange={(e) =>
                  void setAgentDefaults({
                    ...$agentDefaultsStore,
                    fallbackThresholds: {
                      ...($agentDefaultsStore.fallbackThresholds ?? {}),
                      [agent.profileId]: sanitizeFallbackThreshold(Number(e.currentTarget.value)),
                    },
                  })}
              />
              <span>%</span>
            </span>
          </label>
          <p class="hint">
            New launches walk the fallback chain at this percent, so a tenth of the window stays
            free. Resume of a conversation already on this agent still uses the pause threshold.
          </p>
        {/if}
        <label class="row">
          <span>Command</span>
          <input
            bind:value={commandDraft}
            spellcheck="false"
            onfocus={() => (focused = "command")}
            onblur={() => {
              focused = null;
              commitCommand();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <div class="row">
          <label for="model-flag-{workspaceId}">Model flag</label>
          <input
            id="model-flag-{workspaceId}"
            bind:value={modelFlagDraft}
            spellcheck="false"
            placeholder={profileInfo?.modelFlag || "--model"}
            disabled={Boolean(modelFlagBlocked)}
            title={modelFlagBlocked ?? ""}
            onfocus={() => (focused = "modelFlag")}
            onblur={() => {
              focused = null;
              commitModelFlag();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
        {#if modelFlagBlocked}
          <p class="hint warn">{modelFlagBlocked}</p>
        {:else}
          <p class="hint">
            How gavin puts a model on the command above. Leave it empty for
            {profileLabel}{profileInfo?.modelFlag ? `'s own ${profileInfo.modelFlag}` : ""} — it is
            here for a custom agent, whose flag gavin cannot know.
          </p>
        {/if}
        {#if agent.modelFlag}
          <div class="row model-row">
            <span>Model</span>
            <select
              value={modelIsCustom ? CUSTOM_MODEL : ownModel}
              disabled={Boolean(modelBlocked)}
              title={modelBlocked ?? ""}
              onchange={(e) => pickModel(e.currentTarget.value)}
            >
              {#each modelOptions({ modelFlag: agent.modelFlag, models: profileInfo?.models ?? [] }, globalModel) as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if modelIsCustom}
              <input
                bind:value={modelDraft}
                spellcheck="false"
                placeholder="model name"
                disabled={Boolean(modelBlocked)}
                title={modelBlocked ?? ""}
                onfocus={() => (focused = "model")}
                onblur={() => {
                  focused = null;
                  commitModel();
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
          {#if modelBlocked}
            <p class="hint warn">{modelBlocked}</p>
          {:else if agent.model}
            <p class="hint">Launches as <code>{agent.launchCommand}</code>.</p>
          {/if}
        {:else if profileInfo}
          <p class="hint">
            No model flag, so gavin has no way to put one on the command — name the flag above, or
            put the model in Command itself.
          </p>
        {/if}
        <div class="row">
          <label for="agent-file-{workspaceId}">Agent file</label>
          <input
            id="agent-file-{workspaceId}"
            bind:value={fileDraft}
            spellcheck="false"
            onfocus={() => (focused = "file")}
            onblur={() => {
              focused = null;
              void commitFile();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <button type="button" onclick={() => void pickAgentFile()}>Pick…</button>
        </div>
        {#if fileError}
          <p class="hint warn">{fileError}</p>
        {:else}
          <p class="hint">
            Typing a new name offers to rename gavin's file; Pick… points the workspace at one this
            repo already has.
          </p>
        {/if}
        <div class="row">
          <label for="prd-file-{workspaceId}">PRD file</label>
          <input
            id="prd-file-{workspaceId}"
            bind:value={prdDraft}
            spellcheck="false"
            disabled={Boolean(prdBlocked)}
            title={prdBlocked ?? ""}
            placeholder={DEFAULT_PRD_PATH}
            onfocus={() => (focused = "prd")}
            onblur={() => {
              focused = null;
              void commitPrd();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            disabled={Boolean(prdBlocked)}
            title={prdBlocked ?? ""}
            onclick={() => void pickPrd()}>Pick…</button
          >
        </div>
        {#if prdBlocked}
          <p class="hint warn">{prdBlocked}</p>
        {:else if prdError}
          <p class="hint warn">{prdError}</p>
        {:else}
          <p class="hint">
            The lead document — the PRD tab edits it, and every file gavin writes for an agent names
            it. Empty means <code>{DEFAULT_PRD_PATH}</code>.
          </p>
        {/if}
        {#if isCustom}
          <label class="row">
            <span>MCP config</span>
            <input
              bind:value={mcpFileDraft}
              spellcheck="false"
              placeholder=".myagent/mcp.json"
              onfocus={() => (focused = "mcpFile")}
              onblur={() => {
                focused = null;
                commitMcpFile();
              }}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          {#if mcpFileError}
            <p class="hint warn">{mcpFileError}</p>
          {/if}
          <label class="row">
            <span>MCP format</span>
            <select
              value={mcpFormat}
              onchange={(e) => void setAgentField(workspaceId, "mcp_format", e.currentTarget.value)}
            >
              {#each $mcpFormatsStore as format (format.id)}
                <option value={format.id}>{format.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if agent.mcpSupported}
          <p class="hint">
            MCP integration writes <code>{agent.mcpConfigFile}</code> — set it up from the Root row
            above.
          </p>
        {:else}
          <p class="hint">
            Name the file {profileLabel} reads MCP config from, and gavin can write itself into it.
          </p>
        {/if}

        <div class="sp-row">
          <span class="sp-title">
            {superpowers ? superpowersLabel(superpowers.state) : "Superpowers plugin"}
          </span>
          {#if superpowers}
            <SuperpowersControls
              rootPath={ws?.rootPath ?? null}
              agentCommand={agent.command}
              status={superpowers}
              mark={superpowersMark}
              onChanged={() => void readSuperpowers()}
              allowClear
            />
          {:else}
            <p class="hint">Checking…</p>
          {/if}
          <p class="hint">
            Process skills for {profileLabel} — brainstorm before building, plan before coding,
            debug by narrowing. It is what makes gavin's plan and debug flows deep rather than
            nominal.
          </p>
        </div>
      {/if}
    </section>

    <section hidden={!settingsFilter.visible("complexity") || selectedSection !== "complexity"}>
      <h3>Complexity</h3>
      <p class="hint">
        Which agent runs a card of each difficulty, in this workspace only. A level left on its
        default follows the app-wide table in Settings, so leaving one alone is how this workspace
        tracks that; naming an agent or a model here overrides that level and nothing else.
      </p>
      <ComplexityTable
        profiles={$agentProfilesStore}
        table={complexityTable}
        inherited={$agentDefaultsStore.complexity}
        onChange={setComplexity}
      />
    </section>

    <section hidden={!settingsFilter.visible("agent-pause") || selectedSection !== "agent-pause"}>
      <h3>Agent pause</h3>
      <!-- Absent means INHERIT, which is not the same as off: a
           workspace that wants no pause while the app has one stores a
           cycle with enabled:false, so clearing and disabling are two
           different controls. -->
      <label class="check">
        <input
          type="checkbox"
          checked={ws.agentPause != null}
          onchange={(e) =>
            void setWorkspacePause(
              workspaceId,
              e.currentTarget.checked ? { ...inheritedCycle } : null
            )}
        />
        Give this workspace its own pause settings
      </label>
      {#if ws.agentPause == null}
        <p class="hint">
          {#if appCycle?.enabled}
            Following the app-wide cycle: {appCycle.pauseMinutes} minutes every
            {appCycle.periodMinutes} minutes.
          {:else}
            Following the app-wide setting, which is off. Settings → Agent pause
            changes it for every workspace.
          {/if}
        </p>
      {:else}
        {@const own = ws.agentPause}
        <div class="pause-row">
          <label class="check">
            <input
              type="checkbox"
              checked={own.enabled}
              onchange={(e) =>
                void setWorkspacePause(workspaceId, { ...own, enabled: e.currentTarget.checked })}
            />
            Pause on a cycle
          </label>
        </div>
        <div class="pause-row">
          <span>Pause for</span>
          <input
            class="num"
            type="number"
            min="1"
            disabled={!own.enabled}
            value={own.pauseMinutes}
            onchange={(e) =>
              void setWorkspacePause(workspaceId, {
                ...own,
                pauseMinutes: Number(e.currentTarget.value),
              })}
          />
          <span>minutes every</span>
          <input
            class="num"
            type="number"
            min={MIN_PERIOD_MINUTES}
            disabled={!own.enabled}
            value={own.periodMinutes}
            onchange={(e) =>
              void setWorkspacePause(workspaceId, {
                ...own,
                periodMinutes: Number(e.currentTarget.value),
              })}
          />
          <span>minutes</span>
        </div>
        <div class="pause-row">
          <label class="check">
            <input
              type="checkbox"
              checked={own.limitEnabled}
              onchange={(e) =>
                void setWorkspacePause(workspaceId, {
                  ...own,
                  limitEnabled: e.currentTarget.checked,
                })}
            />
            Hold when a window is
          </label>
          <input
            class="num"
            type="number"
            min="1"
            max="100"
            disabled={!own.limitEnabled}
            value={own.limitPercent}
            onchange={(e) =>
              void setWorkspacePause(workspaceId, {
                ...own,
                limitPercent: Number(e.currentTarget.value),
              })}
          />
          <span>% used</span>
        </div>
        {#if own.enabled && validateCycle(own)}
          <p class="hint error">{validateCycle(own)}</p>
        {/if}
      {/if}
      <p class="hint">
        A pause stops gavin STARTING work — a rail's next step, a card run, an
        automatic resume. An agent already mid-turn finishes, and your own Run
        button always works.
        {#if pauseNow.paused}
          Right now: {pauseNow.why}.
        {/if}
      </p>
    </section>

    <section hidden={!settingsFilter.visible("fallback-agent") || selectedSection !== "fallback-agent"}>
      <h3>Fallback agent</h3>
      <p class="hint">
        When this workspace's agent is over its usage threshold, new launches walk this chain
        instead of pausing. The workspace agent is not rewritten. An agent that is not set up yet
        opens a setup wizard rather than launching degraded.
      </p>
      <FallbackChainEditor
        profiles={$agentProfilesStore}
        value={ws.agentFallback ?? []}
        inherited={$agentDefaultsStore.agentFallback ?? []}
        inheriting={ws.agentFallback == null}
        thresholds={$agentDefaultsStore.fallbackThresholds}
        onChange={(chain) => {
          const before = effectiveFallbackChain(
            ws.agentFallback,
            $agentDefaultsStore.agentFallback
          );
          void setWorkspaceFallback(workspaceId, chain).then(() => {
            if (chain) armNewlyAdded(workspaceId, before, chain);
          });
        }}
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

    <section hidden={!settingsFilter.visible("unattended-recovery") || selectedSection !== "unattended-recovery"}>
      <h3>Unattended recovery</h3>
      <!-- Off by default, and the only setting on this screen that is.
           The others are habits; this one is consent -- a run that
           restarts itself hours after you walked away made a decision
           that was yours unless you made it in advance. -->
      <span use:tooltip={autoResumeBlocked ?? ""}>
        <label class="check">
          <input
            type="checkbox"
            disabled={autoResumeBlocked !== null}
            checked={ws.autoResumeRuns ?? false}
            onchange={(e) => void setWorkspaceFlag(workspaceId, "autoResumeRuns", e.currentTarget.checked)}
          />
          Resume a broken card run by itself
        </label>
      </span>
      <p class="hint">
        When an agent you started from a card stops because its connection died, the machine slept or the
        API was down, gavin reopens that same conversation once — never after a login prompt, a usage
        limit or a crash, and never for a run it did not launch. A rail has its own switch, on the rail.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("notifications") || selectedSection !== "notifications"}>
      <h3>Notifications</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyNeedsInput ?? true}
          onchange={(e) => void setWorkspaceFlag(workspaceId, "notifyNeedsInput", e.currentTarget.checked)}
        />
        When a session needs my input
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyFinished ?? true}
          onchange={(e) => void setWorkspaceFlag(workspaceId, "notifyFinished", e.currentTarget.checked)}
        />
        When a session finishes working
      </label>
      <p class="hint">
        Not shown while the gavin window is focused — except a commit agent's verdict, which stays quiet only while its
        Git tab is the one on screen.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("confirmations") || selectedSection !== "confirmations"}>
      <h3>Confirmations</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.confirmTabClose ?? true}
          onchange={(e) => void setWorkspaceFlag(workspaceId, "confirmTabClose", e.currentTarget.checked)}
        />
        Close confirm
      </label>
      <p class="hint">
        Ask before closing a tab. Off closes tabs straight away — including the last tab in a pane,
        which takes the pane with it.
      </p>
    </section>

    <section hidden={!settingsFilter.visible("danger-zone") || selectedSection !== "danger-zone"}>
      <h3>Danger zone</h3>
      <p class="hint">
        Remove gavin from this workspace's folder: its plans, skills, MCP entry and instructions
        block, plus the board and rails the daemon holds. You are asked about each one, and nothing
        is removed until you confirm.
      </p>
      <!-- The reason hangs on the wrapper, not the button: a disabled
           element fires no mouseenter, so a tooltip on it can never open
           and the control would refuse to explain itself. -->
      <div class="row" use:tooltip={deleteBlockedReason ?? ""}>
        <button
          type="button"
          class="danger"
          disabled={deleteBlockedReason !== null}
          onclick={() => (deleting = true)}
        >
          Delete workspace…
        </button>
        {#if deleteBlockedReason}
          <span class="hint">{deleteBlockedReason}</span>
        {/if}
      </div>
    </section>
    </div>
  </div>

  {#if hubTabsOpen}
    <HubTabsModal {workspaceId} onClose={() => (hubTabsOpen = false)} />
  {/if}

  {#if deleting}
    <WorkspaceDeleteWizard {workspaceId} onClose={() => (deleting = false)} />
  {/if}

  {#if pendingProfileChange}
    <AgentChangeWizard
      {workspaceId}
      fromProfileId={agent.profileId}
      toProfileId={pendingProfileChange}
      onClose={() => (pendingProfileChange = null)}
    />
  {/if}

  <!-- Two real answers, so a ConfirmPrompt rather than an askConfirm:
       "ignore them but leave git alone" is a position somebody holds
       (a shared repo where the removal belongs in its own commit), not a
       softer version of Cancel. Neither is marked `danger` -- nothing is
       deleted and nothing is committed, so Enter on the last choice is
       safe by the prompt's own rule. -->
  {#if untrackPrompt}
    {@const prompt = untrackPrompt}
    <ConfirmPrompt
      title={prompt.title}
      lines={prompt.lines}
      choices={[
        { label: "Ignore only", onPick: () => void applyTracking(false, false) },
        { label: prompt.confirmLabel, onPick: () => void applyTracking(false, true) },
      ]}
      onCancel={() => (untrackPrompt = null)}
    />
  {/if}

  {#if pendingMove}
    <Modal onClose={() => void confirmMove(false)}>
      <p>Move <code>{pendingMove.from}</code>?</p>
      <p class="detail">
        Move it to <code>{pendingMove.to}</code>, or point gavin at <code>{pendingMove.to}</code> and
        leave the old file where it is?
      </p>
      <div class="actions">
        <button type="button" onclick={() => void confirmMove(false)}>Leave it</button>
        <button type="button" onclick={() => void confirmMove(true)}>Move file</button>
      </div>
    </Modal>
  {/if}
{/if}

<style>
  .settings {
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
    /* Locked to the hub first-row band the Scratchpad and Files share. */
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
    width: 90px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .row input,
  .row select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 240px;
  }
  .pct-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pct-row input {
    min-width: 0;
    width: 4.5em;
  }
  /* The only row with two controls side by side, so the shared 240px
     floor becomes a CAP here instead: below it, because two of them
     would push the pair past a narrow pane; above it, because neither
     control has a natural width worth trusting.
     A native select sizes itself to its WIDEST option, and the widest is
     no longer an alias -- opencode's catalogue is 450 provider-qualified
     names, the longest 67 characters, which uncapped draws a select
     wider than the panel. The text box grows for the same reason and had
     the same answer: every row above it stops at 240px, so this one
     does too. What gets clipped is readable in full on the "Launches
     as" line below. */
  .model-row select {
    min-width: 160px;
    max-width: 240px;
  }
  .model-row input {
    min-width: 0;
    flex: 1 1 auto;
    max-width: 240px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .hint.row-actions {
    margin-top: 0;
    margin-bottom: 10px;
  }
  button.linkish {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent, #8ab4f8);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  button.linkish:hover {
    color: var(--text);
  }
  /* Set off from the fields above it: the rows above are all "edit this
     value", and this one is "gavin checked something". */
  .sp-row {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle, #333);
  }
  .sp-title {
    display: block;
    margin-bottom: 8px;
    color: var(--text-normal, #ddd);
  }
  .hint.warn {
    color: var(--warning-text);
  }
  .detail {
    opacity: 0.75;
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .row button {
    /* Sits beside the input rather than stretching with it -- the two
       Pick… rows are the ones with something to compete for. */
    flex: 0 0 auto;
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .row button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .row button.danger {
    color: var(--warning-text);
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
  .pause-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    color: var(--text-muted);
  }
  .pause-row input.num {
    width: 56px;
    text-align: right;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .hint.error {
    color: var(--danger-text);
  }
</style>
