<script lang="ts">
  // Everything configured PER AGENT besides its launch fields, on a phone:
  // its fallback chain, complexity table, pause cycle, and the two lines
  // lists (extra prompt lines, extra CLI arguments). The desk's
  // `AgentPrimaryPanel` is the same thing in the desk's own rows; both read
  // and write through `agentPrimary.ts`, so a screen here and a page there
  // cannot disagree about what an agent has, what a workspace inherits, or
  // where an edit goes.
  //
  // One component for the General tab and every agent's own tab, on the
  // Workstation's settings (scope "app") and a workspace's (scope
  // "workspace"). General points it at the agent the screen is about, so
  // there is no second copy to drift.
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
  import { saveSetting } from "$companion/state/workstation";
  import PhoneSetting from "$companion/surfaces/PhoneSetting.svelte";
  import PhoneToggle from "$companion/surfaces/PhoneToggle.svelte";
  import { inheritedPauseLine } from "$companion/surfaces/phoneSettings";

  interface Props {
    scope: AgentsHubScope;
    /// The agent these settings belong to, as a launch's PRIMARY.
    primaryId: string;
    label: string;
    profiles: AgentProfileInfo[];
    /// Required in the workspace scope.
    workspaceId?: string;
  }
  let { scope, primaryId, label, profiles, workspaceId = "" }: Props = $props();

  const ws = $derived(
    scope === "workspace" ? ($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null) : null
  );
  const defaults = $derived($agentDefaultsStore);
  const view = $derived(primaryView(scope, primaryId, defaults, ws));
  /// The list editors hold a half-typed row of their own; a new agent (or
  /// workspace) must start them clean, or the other agent's draft shows up
  /// -- and gets saved -- under this one.
  const editorKey = $derived(`${scope}:${workspaceId}:${primaryId}`);

  function setChain(chain: string[] | null): void {
    if (scope === "app") {
      void saveSetting(() =>
        setAgentDefaults({
          ...defaults,
          fallbackChains: withFallbackChainForPrimary(defaults.fallbackChains, primaryId, chain ?? []),
        })
      );
      return;
    }
    if (!ws) return;
    const before = effectiveFallbackChain(ws.fallbackChains, defaults.fallbackChains, primaryId);
    void saveSetting(() => setWorkspaceFallback(workspaceId, primaryId, chain)).then(() => {
      if (chain) void armNewlyAdded(workspaceId, before, chain);
    });
  }

  function setThreshold(profileId: string, percent: number): void {
    void saveSetting(() =>
      setAgentDefaults({
        ...defaults,
        fallbackThresholds: {
          ...(defaults.fallbackThresholds ?? {}),
          [profileId]: sanitizeFallbackThreshold(percent),
        },
      })
    );
  }

  function setComplexity(level: Complexity, entry: ComplexityAgent | null): void {
    const next = { ...view.table };
    if (entry) next[level] = entry;
    else delete next[level];
    void saveSetting(() => saveComplexityTable(scope, workspaceId, primaryId, defaults, next));
  }

  /// An edit that is not yet usable stays on screen so its message can
  /// explain it, and is not saved until it is usable again -- the desk's
  /// rule.
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
    void saveSetting(() => savePauseCycle(scope, workspaceId, primaryId, next));
  }

  function setOwnCycle(on: boolean): void {
    unusable = null;
    void saveSetting(() => savePauseCycle(scope, workspaceId, primaryId, on ? ownCycleSeed(view) : null));
  }

  function setList(kind: ListKind, list: string[] | null): void {
    void saveSetting(() => saveList(scope, workspaceId, primaryId, defaults, kind, list));
  }
</script>

<p class="note">
  When a launch whose resolved agent is {label} is over its usage threshold, walk this chain instead of
  pausing.
</p>
<div class="desk-part">
  {#if scope === "app"}
    <FallbackChainEditor
      {profiles}
      value={chainForPrimary(defaults.fallbackChains, primaryId)}
      thresholds={defaults.fallbackThresholds}
      onChange={setChain}
      onThresholdChange={setThreshold}
    />
  {:else if ws}
    <FallbackChainEditor
      {profiles}
      value={chainForPrimary(ws.fallbackChains, primaryId)}
      inherited={chainForPrimary(defaults.fallbackChains, primaryId)}
      inheriting={!workspaceOwnsFallbackChain(ws.fallbackChains, primaryId)}
      thresholds={defaults.fallbackThresholds}
      onChange={setChain}
      onThresholdChange={setThreshold}
    />
  {/if}
</div>

<p class="note">
  Which agent, model and effort runs a card of each difficulty when it launches on {label}. A level left
  alone runs {label} itself.
</p>
{#if scope === "workspace"}
  <PhoneToggle
    label="Give this workspace its own complexity table for {label}"
    checked={view.ownsTable}
    hint={view.ownsTable ? null : "Following the Workstation's table."}
    onChange={(own) =>
      void saveSetting(() =>
        saveComplexityTable(scope, workspaceId, primaryId, defaults, own ? { ...view.appTable } : null)
      )}
  />
{/if}
<div class="desk-part">
  <ComplexityTable {profiles} table={view.ownsTable ? view.table : view.appTable} readonly={!view.ownsTable} onChange={setComplexity} />
</div>

<p class="note">
  Sit out part of every window so a rail does not spend a subscription's limit while nobody is watching.
  Nothing already running is interrupted — only new starts on {label} wait.
</p>
{#if scope === "workspace"}
  <PhoneToggle
    label="Give this workspace its own pause settings for {label}"
    checked={view.ownsCycle}
    hint={view.ownsCycle ? null : inheritedPauseLine(view.appCycle)}
    onChange={setOwnCycle}
  />
{/if}
{#if view.ownsCycle}
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

<p class="note">
  Extra lines added to the end of the prompts gavin composes when it starts a {label} session — a card run,
  a review, a rail step, the setup flows. Not the hidden background runs, like a commit through an agent.
</p>
{#if scope === "workspace"}
  <PhoneToggle
    label="Give this workspace its own prompt lines for {label}"
    checked={view.ownsPromptLines}
    hint={view.ownsPromptLines
      ? null
      : view.promptLines.length === 0
        ? "Following the Workstation's setting, which adds nothing."
        : `Following the Workstation's lines (${view.promptLines.length}).`}
    onChange={(own) => setList("promptExtras", own ? ownListSeed(defaults, "promptExtras", primaryId) : null)}
  />
{/if}
{#if view.ownsPromptLines}
  <div class="desk-part">
    {#key editorKey}
      <PromptParamsEditor
        items={view.promptLines}
        label="Prompt line"
        placeholder="Answer in British English."
        addLabel="Add prompt line"
        onChange={(next) => setList("promptExtras", next)}
      />
    {/key}
  </div>
{/if}

<p class="note">
  Extra arguments added to the end of {label}'s launch command, after its model and effort flags, for every
  session and background run. Each line is one piece of the command, written as you would type it.
</p>
{#if scope === "workspace"}
  <PhoneToggle
    label="Give this workspace its own CLI arguments for {label}"
    checked={view.ownsCliArgs}
    hint={view.ownsCliArgs
      ? null
      : view.cliArgs.length === 0
        ? "Following the Workstation's setting, which adds nothing."
        : `Following the Workstation's arguments: ${view.cliArgs.join(" ")}`}
    onChange={(own) => setList("extraCliArgs", own ? ownListSeed(defaults, "extraCliArgs", primaryId) : null)}
  />
{/if}
{#if view.ownsCliArgs}
  <div class="desk-part">
    {#key editorKey}
      <PromptParamsEditor
        items={view.cliArgs}
        label="CLI argument"
        placeholder="--verbose"
        addLabel="Add argument"
        onChange={(next) => setList("extraCliArgs", next)}
      />
    {/key}
  </div>
{/if}

<style>
  .note {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }
  .unit {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  /* The desk's own components size their text in `em`, for a desk panel's
     smaller type; under a phone's 16px body their hints would read larger
     than every other hint here. */
  .desk-part {
    font-size: 0.8125rem;
  }
</style>
