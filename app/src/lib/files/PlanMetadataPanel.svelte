<script lang="ts">
  import { get } from "svelte/store";
  import type { PlanFileInfo } from "$lib/gavin";
  import { statusOptions } from "$lib/files/planExplorer";
  import { gavinTrees, patchPlanField } from "$lib/gavinState";
  import { kanbanState } from "$lib/board/kanbanState";
  import { cardIndex, nestedChildrenOf } from "$lib/orchestration";
  import { guardCompletion } from "$lib/cards/cardCompletion";
  import * as backend from "$lib/backend";
  import { agentProfilesStore, daemonCompat } from "$lib/layoutState";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { COMPLEXITY_LABELS, COMPLEXITY_LEVELS, NO_COMPLEXITY } from "$lib/cards/complexity";
  import CardAgentControls from "$lib/cards/CardAgentControls.svelte";

  interface Props {
    plan: PlanFileInfo;
    workspaceId: string;
    columnNames: string[];
    // Lands any unsaved editor buffer before we rewrite a line of the
    // same file (see FileEditor.flush).
    onBeforeWrite: () => Promise<void>;
  }
  let { plan, workspaceId, columnNames, onBeforeWrite }: Props = $props();

  const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

  /// A v30 daemon's set_plan_field allow-list has no `complexity`, so the
  /// write fails on change. Disabled with the reason instead -- the same
  /// gate the card detail modal and the composer carry.
  const complexityBlocked = $derived(featureBlockedReason($daemonCompat, "complexity"));

  /// A v31 daemon refuses the `agent`/`model` keys AND never parses the
  /// two lines, so a card that already carries an override would read
  /// back as carrying none. Disabled with the reason, like the level
  /// above.
  const cardAgentBlocked = $derived(featureBlockedReason($daemonCompat, "cardAgent"));

  let titleDraft = $state(plan.title);
  let error = $state<string | null>(null);
  // Mirrored into local state rather than read straight off the plan: a
  // refused status write has to put the select back, and a one-way
  // `value={plan.status}` never re-runs when the plan did not change --
  // it would sit there naming a column the card is not in.
  let statusChoice = $state(plan.status ?? "");
  // Reset the draft when a different plan is selected.
  let draftFor = $state(plan.path);
  $effect(() => {
    if (draftFor !== plan.path) {
      titleDraft = plan.title;
      statusChoice = plan.status ?? "";
      draftFor = plan.path;
    }
  });

  const options = $derived(statusOptions(columnNames, plan.status));

  /// The fifth gesture that can file a plan, and the one furthest from
  /// the board: this panel edits the card file directly. Its nested
  /// children come from the tree rather than from a `CardView` -- there
  /// is no board projection on this tab -- and the columns off the board
  /// store, since `columnNames` carries no positions to tell the first
  /// column from the last.
  async function guardStatus(value: string): Promise<boolean> {
    const cards = cardIndex(get(gavinTrees)[workspaceId]);
    const decision = await guardCompletion(
      workspaceId,
      {
        title: plan.title,
        kind: plan.kind,
        status: plan.status,
        children: nestedChildrenOf(plan.path, cards).map((c) => ({
          path: c.plan.path,
          title: c.plan.title,
        })),
      },
      value,
      get(kanbanState)[workspaceId]?.columns ?? []
    );
    if (decision.error) error = decision.error;
    return decision.proceed;
  }

  /// True when the field was actually written -- a caller holding a
  /// control's own draft has to know whether to put it back.
  async function commit(
    key: "title" | "status" | "priority" | "complexity" | "agent" | "model",
    value: string
  ): Promise<boolean> {
    error = null;
    if (key === "status" && !(await guardStatus(value))) return false;
    try {
      await onBeforeWrite();
      await backend.setPlanFrontmatterField(plan.path, key, value);
      // Optimistic: the confirming watcher push is ~3s away.
      patchPlanField(workspaceId, plan.path, key, value);
      return true;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      return false;
    }
  }

  async function commitStatus(): Promise<void> {
    if (statusChoice === (plan.status ?? "")) return;
    // Put back only when nothing was written -- a select still naming a
    // column the card is not in is this panel lying about the card.
    if (!(await commit("status", statusChoice))) statusChoice = plan.status ?? "";
  }

  function commitTitle(): void {
    const next = titleDraft.trim();
    if (!next || next === plan.title) {
      titleDraft = plan.title;
      return;
    }
    void commit("title", next);
  }
</script>

<div class="panel">
  <span class="kind-badge kind-{plan.kind}">{plan.kind}</span>
  <input
    class="title"
    bind:value={titleDraft}
    onblur={commitTitle}
    onkeydown={(e) => {
      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      else if (e.key === "Escape") titleDraft = plan.title;
    }}
  />
  <label>
    Status
    <select
      bind:value={statusChoice}
      onchange={() => void commitStatus()}
    >
      {#each options as option (option)}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </label>
  <label>
    Priority
    <select
      value={plan.priority ?? "none"}
      onchange={(e) => void commit("priority", (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  <label title={complexityBlocked ?? undefined}>
    Complexity
    <select
      value={plan.complexity ?? NO_COMPLEXITY}
      disabled={complexityBlocked !== null}
      onchange={(e) => void commit("complexity", (e.currentTarget as HTMLSelectElement).value)}
    >
      <!-- The absence of the line, not a sixth level: an unrated card
           runs this workspace's own agent. -->
      <option value={NO_COMPLEXITY}>unrated</option>
      {#each COMPLEXITY_LEVELS as level (level)}
        <option value={level} title={COMPLEXITY_LABELS[level].hint}
          >{COMPLEXITY_LABELS[level].label.toLowerCase()}</option
        >
      {/each}
    </select>
  </label>
  <CardAgentControls
    {workspaceId}
    profiles={$agentProfilesStore}
    card={plan}
    blocked={cardAgentBlocked}
    onChange={(key, value) => void commit(key, value)}
  />
  {#if plan.labels.length > 0}
    <span class="labels" title="labels: {plan.labels.join(', ')}">{plan.labels.join(" · ")}</span>
  {/if}
  {#if plan.parseWarning}
    <span class="warn">frontmatter issues</span>
  {/if}
  {#if error}
    <span class="error">{error}</span>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-family: monospace;
    font-size: 0.8em;
    color: var(--text-muted);
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .title {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: 1.1em;
    padding: 2px 6px;
    flex: 1 1 200px;
    min-width: 120px;
  }
  .title:hover,
  .title:focus {
    border-color: var(--border);
    background: var(--surface-base);
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  select {
    background: var(--surface-base);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: inherit;
    padding: 1px 4px;
  }
  /* Same reason as the composer and the detail modal: the rule above
     sets colour and background explicitly, so a `disabled` picker (the
     complexity one, against an older daemon) looked exactly like the two
     live ones next to it. The label carries the reason as a `title`. */
  select:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .warn {
    color: var(--warning-text);
  }
  .error {
    color: var(--danger-text);
  }
  .kind-badge {
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .kind-badge.kind-note {
    border: 1px solid var(--border-warning);
    color: var(--warning-text);
  }
  .kind-badge.kind-task {
    border: 1px solid var(--border-accent);
    color: var(--accent-text);
  }
  .kind-badge.kind-plan {
    border: 1px solid var(--border-success);
    color: var(--success-text);
  }
  .labels {
    color: var(--text-muted);
    font-size: 0.75em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
</style>
