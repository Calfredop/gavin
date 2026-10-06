<script lang="ts">
  /// Everything configured PER AGENT besides its launch fields: its
  /// fallback chain, its complexity table, its pause cycle, and its two
  /// add/remove lists (extra prompt lines, extra CLI arguments).
  ///
  /// One component for the General tab and for every agent's own tab, in
  /// the app-wide page (scope "app") and a workspace's Settings tab (scope
  /// "workspace"). General just points it at the agent the page is about
  /// -- the default agent, or the workspace's chosen one -- so there is no
  /// second copy of these controls to drift, and no override layer
  /// between "what General shows" and "what that agent's tab shows": they
  /// are the same data.
  ///
  /// Where a workspace has no value of its own for an agent (the key is
  /// absent) it INHERITS the app-wide one; an own value that is empty is a
  /// real answer ("none"), which is why each block has its own toggle
  /// instead of reading emptiness as inheritance. What the data model
  /// does with all of this is `agentPrimary.ts` (reads and writes) over
  /// `complexity.ts`, `agentPause.ts`, `agentFallback.ts` and
  /// `promptParams.ts`; this file is a template over them.
  import {
    agentDefaultsStore,
    layoutState,
    setAgentDefaults,
    setWorkspaceFallback,
  } from "$lib/core/layoutState";
  import {
    chainForPrimary,
    effectiveFallbackChain,
    sanitizeFallbackThreshold,
    withFallbackChainForPrimary,
    workspaceOwnsFallbackChain,
  } from "$lib/agents/agentFallback";
  import { armNewlyAdded } from "$lib/agents/agentFallbackState";
  import type { Complexity, ComplexityAgent } from "$lib/cards/complexity";
  import { MIN_PERIOD_MINUTES, validateCycle, type PauseCycle } from "$lib/agents/agentPause";
  import {
    ownCycleSeed,
    ownListSeed,
    primaryView,
    saveComplexityTable,
    saveList,
    savePauseCycle,
    type ListKind,
  } from "$lib/agents/agentPrimary";
  import type { AgentsHubScope } from "$lib/agents/agentsHub";
  import type { AgentProfileInfo } from "$lib/core/settings";
  import ComplexityTable from "$lib/cards/ComplexityTable.svelte";
  import FallbackChainEditor from "$lib/workspace/FallbackChainEditor.svelte";
  import PromptParamsEditor from "$lib/agents/PromptParamsEditor.svelte";

  interface Props {
    scope: AgentsHubScope;
    /// The agent these settings belong to, as a launch's PRIMARY.
    primaryId: string;
    /// Its display name, for the copy.
    label: string;
    /// Every profile a picker may offer in this scope.
    profiles: AgentProfileInfo[];
    /// Required in the workspace scope.
    workspaceId?: string;
    /// Whether any agent in use can be asked about its limits; the app
    /// scope says so under the pause fields rather than offering a gate
    /// that silently never fires.
    limitsProbed?: boolean;
  }
  let { scope, primaryId, label, profiles, workspaceId = "", limitsProbed = true }: Props = $props();

  const ws = $derived(
    scope === "workspace" ? ($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null) : null
  );
  const defaults = $derived($agentDefaultsStore);
  const view = $derived(primaryView(scope, primaryId, defaults, ws));

  // ---- fallback --------------------------------------------------------

  function setAppChain(chain: string[] | null): void {
    void setAgentDefaults({
      ...defaults,
      fallbackChains: withFallbackChainForPrimary(defaults.fallbackChains, primaryId, chain ?? []),
    });
  }

  function setWorkspaceChain(chain: string[] | null): void {
    if (!ws) return;
    const before = effectiveFallbackChain(ws.fallbackChains, defaults.fallbackChains, primaryId);
    void setWorkspaceFallback(workspaceId, primaryId, chain).then(() => {
      if (chain) void armNewlyAdded(workspaceId, before, chain);
    });
  }

  function setThreshold(profileId: string, percent: number): void {
    void setAgentDefaults({
      ...defaults,
      fallbackThresholds: {
        ...(defaults.fallbackThresholds ?? {}),
        [profileId]: sanitizeFallbackThreshold(percent),
      },
    });
  }

  // ---- complexity ------------------------------------------------------

  function setComplexity(level: Complexity, entry: ComplexityAgent | null): void {
    const next = { ...view.table };
    if (entry) next[level] = entry;
    else delete next[level];
    void saveComplexityTable(scope, workspaceId, primaryId, defaults, next);
  }

  // ---- pause -----------------------------------------------------------

  /// An edit that is not yet usable (a period under the minimum) stays on
  /// screen so its message can explain itself; nothing is saved until it
  /// is usable again.
  let unusable = $state<PauseCycle | null>(null);
  $effect(() => {
    void primaryId;
    void scope;
    void workspaceId;
    unusable = null;
  });

  const cycle = $derived<PauseCycle>(unusable ?? view.cycleOrDefault);
  const cycleError = $derived(cycle.enabled ? validateCycle(cycle) : null);

  function editCycle(patch: Partial<PauseCycle>): void {
    const next = { ...cycle, ...patch };
    if (next.enabled && validateCycle(next)) {
      unusable = next;
      return;
    }
    unusable = null;
    void savePauseCycle(scope, workspaceId, primaryId, next);
  }

  function setOwnCycle(on: boolean): void {
    unusable = null;
    void savePauseCycle(scope, workspaceId, primaryId, on ? ownCycleSeed(view) : null);
  }

  // ---- prompt lines and CLI arguments ----------------------------------

  function setOwnList(kind: ListKind, on: boolean): void {
    void saveList(scope, workspaceId, primaryId, defaults, kind, on ? ownListSeed(defaults, kind, primaryId) : null);
  }
</script>

<h3 class="sub">Fallback</h3>
<p class="hint">
  When a launch whose resolved agent is {label} is over its usage threshold, walk this chain
  instead of pausing.
</p>
{#if scope === "app"}
  <FallbackChainEditor
    {profiles}
    value={chainForPrimary(defaults.fallbackChains, primaryId)}
    thresholds={defaults.fallbackThresholds}
    onChange={setAppChain}
    onThresholdChange={setThreshold}
  />
{:else if ws}
  <FallbackChainEditor
    {profiles}
    value={chainForPrimary(ws.fallbackChains, primaryId)}
    inherited={chainForPrimary(defaults.fallbackChains, primaryId)}
    inheriting={!workspaceOwnsFallbackChain(ws.fallbackChains, primaryId)}
    thresholds={defaults.fallbackThresholds}
    onChange={setWorkspaceChain}
    onThresholdChange={setThreshold}
  />
{/if}

<h3 class="sub">Complexity</h3>
<p class="hint">
  A card can say how hard its work is, and each level can run a different agent, model or effort —
  so a rename need not spend what a gnarly refactor needs. This is the table for cards launched on
  {label}; a level left alone runs {label} itself.
  {#if scope === "workspace"}
    Without a table of its own, this workspace follows the app-wide one in Settings.
  {/if}
</p>
{#if scope === "workspace"}
  <label class="check">
    <input
      type="checkbox"
      checked={view.ownsTable}
      onchange={(e) =>
        void saveComplexityTable(
          scope,
          workspaceId,
          primaryId,
          defaults,
          e.currentTarget.checked ? { ...view.appTable } : null
        )}
    />
    Give this workspace its own complexity table for {label}
  </label>
{/if}
{#if view.ownsTable}
  <ComplexityTable {profiles} table={view.table} onChange={setComplexity} />
{:else}
  <ComplexityTable {profiles} table={view.appTable} readonly onChange={setComplexity} />
{/if}

<h3 class="sub">Pause</h3>
<p class="hint">
  Sit out part of every window so a rail does not spend a subscription limit while nobody is
  watching. Nothing already running is interrupted — only new starts on {label} wait.
</p>
{#if scope === "workspace"}
  <!-- Absent means INHERIT, which is not the same as off: a workspace that
       wants no pause while the app has one stores a cycle with
       enabled:false, so clearing and disabling are two different
       controls. -->
  <label class="check">
    <input
      type="checkbox"
      checked={view.ownsCycle}
      onchange={(e) => setOwnCycle(e.currentTarget.checked)}
    />
    Give this workspace its own pause settings for {label}
  </label>
{/if}
{#if scope === "workspace" && !view.ownsCycle}
  <p class="hint">
    {#if view.appCycle?.enabled}
      Following the app-wide cycle: {view.appCycle.pauseMinutes} minutes every
      {view.appCycle.periodMinutes} minutes.
    {:else}
      Following the app-wide setting, which is off. Settings → Agents changes it for every
      workspace.
    {/if}
  </p>
{:else}
  <div class="row">
    <span>Scheduled</span>
    <label class="check">
      <input
        type="checkbox"
        checked={cycle.enabled}
        onchange={(e) => editCycle({ enabled: e.currentTarget.checked })}
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
      onchange={(e) => editCycle({ pauseMinutes: Number(e.currentTarget.value) })}
    />
    <span class="unit">minutes every</span>
    <input
      class="num"
      type="number"
      min={MIN_PERIOD_MINUTES}
      disabled={!cycle.enabled}
      value={cycle.periodMinutes}
      onchange={(e) => editCycle({ periodMinutes: Number(e.currentTarget.value) })}
    />
    <span class="unit">minutes</span>
  </div>
  <div class="row">
    <span>At the limit</span>
    <label class="check">
      <input
        type="checkbox"
        checked={cycle.limitEnabled}
        onchange={(e) => editCycle({ limitEnabled: e.currentTarget.checked })}
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
      onchange={(e) => editCycle({ limitPercent: Number(e.currentTarget.value) })}
    />
    <span class="unit">% used</span>
  </div>
  {#if cycleError}
    <p class="hint error">{cycleError}</p>
  {:else if !limitsProbed}
    <p class="hint">
      Holding at a limit needs an agent whose limits gavin can read — today Claude Code and Codex.
      No workspace here runs one, so only the schedule applies.
    </p>
  {/if}
{/if}

<h3 class="sub">Prompt lines</h3>
<p class="hint">
  Extra lines added to the end of every prompt gavin composes for {label} — a card run, a resume, a
  review, the setup flows.
</p>
{#if scope === "workspace"}
  <label class="check">
    <input
      type="checkbox"
      checked={view.ownsPromptLines}
      onchange={(e) => setOwnList("promptExtras", e.currentTarget.checked)}
    />
    Give this workspace its own prompt lines for {label}
  </label>
{/if}
{#if scope === "workspace" && !view.ownsPromptLines}
  <p class="hint">
    {#if view.promptLines.length === 0}
      Following the app-wide setting, which adds nothing.
    {:else}
      Following the app-wide lines ({view.promptLines.length}).
    {/if}
  </p>
{:else}
  <PromptParamsEditor
    items={view.promptLines}
    label="Prompt line"
    placeholder="Answer in British English."
    addLabel="Add prompt line"
    onChange={(next) => void saveList(scope, workspaceId, primaryId, defaults, "promptExtras", next)}
  />
{/if}

<h3 class="sub">CLI arguments</h3>
<p class="hint">
  Extra arguments added to the end of {label}'s launch command, after its model and effort flags.
  Each line is one piece of the command, written exactly as you would type it.
</p>
{#if scope === "workspace"}
  <label class="check">
    <input
      type="checkbox"
      checked={view.ownsCliArgs}
      onchange={(e) => setOwnList("extraCliArgs", e.currentTarget.checked)}
    />
    Give this workspace its own CLI arguments for {label}
  </label>
{/if}
{#if scope === "workspace" && !view.ownsCliArgs}
  <p class="hint">
    {#if view.cliArgs.length === 0}
      Following the app-wide setting, which adds nothing.
    {:else}
      Following the app-wide arguments: {view.cliArgs.join(" ")}
    {/if}
  </p>
{:else}
  <PromptParamsEditor
    items={view.cliArgs}
    label="CLI argument"
    placeholder="--verbose"
    addLabel="Add argument"
    onChange={(next) => void saveList(scope, workspaceId, primaryId, defaults, "extraCliArgs", next)}
  />
{/if}

<style>
  h3.sub {
    margin: 18px 0 10px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 8px;
  }
  .hint.error {
    color: var(--danger-text);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text);
    margin-bottom: 8px;
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
  .row input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .row input.num {
    width: 56px;
    text-align: right;
  }
  .unit {
    color: var(--text-muted);
  }
</style>
