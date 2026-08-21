<script lang="ts">
  import { Play, Pause, RotateCcw, Trash2, Plus } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import OrchestrationStepChip from "./OrchestrationStepChip.svelte";
  import type { CardEntry, NumberedConflict, Orchestration, Rail } from "./orchestration";
  import {
    railStateOf,
    stepStateOf,
    numbersForStep,
    numbersForRail,
    severityForStep,
    severityForRail,
  } from "./orchestration";
  import { highlightedConflict } from "./orchestrationState";
  import { orchDragState } from "./orchestrationDrag";

  interface Props {
    rail: Rail;
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    /// Null when the board has no columns at all — nothing can complete,
    /// and the header says so rather than looking hung.
    doneColumnName: string | null;
    numbered: NumberedConflict[];
    /// Rename is CONTROLLED by the parent: it owns which rail is being
    /// renamed, so a freshly created rail can open straight into it.
    editing: boolean;
    onStartEdit: () => void;
    onRename: (name: string) => void;
    onCancelEdit: () => void;
    onStart: () => void;
    onPause: () => void;
    onReset: () => void;
    onDelete: () => void;
    /// Resolved page name for the bindings row; null when unbound.
    pageName: string | null;
    onBind: () => void;
    onAddStep: () => void;
    onRetryStep: (stepId: string) => void;
    onRemoveStep: (stepId: string) => void;
  }
  let {
    rail,
    orch,
    cards,
    doneColumnName,
    numbered,
    pageName,
    editing,
    onStartEdit,
    onRename,
    onCancelEdit,
    onStart,
    onPause,
    onReset,
    onDelete,
    onBind,
    onAddStep,
    onRetryStep,
    onRemoveStep,
  }: Props = $props();

  const railState = $derived(railStateOf(orch, rail.id));
  const stages = $derived([...rail.stages].sort((a, b) => a.position - b.position));
  // A rail-level conflict (missing/unbound worktree) badges the HEADER,
  // not any chip -- the cause is the binding, not a step.
  const railBadges = $derived(numbersForRail(numbered, rail.id));
  const railSeverity = $derived(severityForRail(numbered, rail.id));

  let draft = $state("");
  // Seeded when edit mode OPENS, not at construction: the parent drops a
  // newly created rail straight into editing without a click, so there is
  // no onclick to seed it there.
  $effect(() => {
    if (editing) draft = rail.name;
  });

  /// Focus AND select: a new rail arrives named "New rail", so the first
  /// keystroke should replace it rather than append to it.
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function commit(): void {
    const name = draft.trim();
    if (name && name !== rail.name) onRename(name);
    else onCancelEdit();
  }

  function runOf(id: string) {
    return orch.stepRuns.find((r) => r.stepId === id) ?? null;
  }

  const drag = $derived($orchDragState);
  // The dragged chip is hidden while it flies, and a stage left holding
  // only it collapses -- matching exactly what the glue measures, so the
  // placeholder index and the commit index agree.
  const stagesShown = $derived(
    stages
      .map((s) => ({ ...s, steps: s.steps.filter((t) => t.id !== drag?.id) }))
      .filter((s) => s.steps.length > 0)
  );
  const newStageAt = $derived(
    drag?.target?.kind === "new-stage" && drag.target.railId === rail.id ? drag.target.index : null
  );
  const intoStage = $derived(drag?.target?.kind === "into-stage" ? drag.target.stageId : null);
</script>

<div class="rail" data-orch-rail={rail.id}>
  <header>
    <div class="name-row">
      {#if editing}
        <input
          class="name-input"
          bind:value={draft}
          use:focusAndSelect
          onblur={commit}
          onkeydown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancelEdit();
          }}
        />
      {:else}
        <button
          type="button"
          class="name"
          title="Rename"
          onclick={onStartEdit}
        >{rail.name}</button>
      {/if}
      {#each railBadges as n (n)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="rail-badge {railSeverity}"
          class:lit={$highlightedConflict === n}
          onmouseenter={() => highlightedConflict.set(n)}
          onmouseleave={() => highlightedConflict.set(null)}
        >{n}</span>
      {/each}
      <span class="state {railState}">{railState}</span>
      {#if railState === "running"}
        <IconButton icon={Pause} label="Pause" onclick={onPause} />
      {:else}
        <IconButton
          icon={Play}
          label={railState === "paused" ? "Resume" : "Start"}
          tone="accent"
          onclick={onStart}
        />
      {/if}
      <IconButton icon={RotateCcw} label="Reset run state" onclick={onReset} />
      <IconButton icon={Trash2} label="Delete rail" tone="danger" onclick={onDelete} />
    </div>
    <button type="button" class="bindings" onclick={onBind}>
      <span class="wt">{rail.worktreePath ?? "no worktree"}</span>
      <span class="pg">{pageName ?? "Agents page"}</span>
    </button>
    {#if !doneColumnName}
      <p class="warn">This board has no columns — nothing can complete.</p>
    {/if}
  </header>

  {#each stagesShown as stage, i (stage.id)}
    {#if newStageAt === i}<div class="stage-placeholder"></div>{/if}
    {#if i > 0 && newStageAt !== i}<div class="connector"></div>{/if}
    <section
      class="stage"
      class:parallel={stage.steps.length > 1}
      class:drop-into={intoStage === stage.id}
      data-orch-stage={stage.id}
      data-orch-stage-pos={stage.position}
    >
      {#if stage.steps.length > 1}
        <span class="stage-label">stage {i + 1} — parallel</span>
      {/if}
      <div class="steps">
        {#each [...stage.steps].sort((a, b) => a.position - b.position) as step (step.id)}
          <OrchestrationStepChip
            stepId={step.id}
            cardPath={step.cardPath}
            entry={cards.get(step.cardPath)}
            state={stepStateOf(orch, step.id)}
            reason={runOf(step.id)?.reason ?? null}
            badges={numbersForStep(numbered, step.id)}
            severity={severityForStep(numbered, step.id)}
            onRetry={() => onRetryStep(step.id)}
            onRemove={() => onRemoveStep(step.id)}
          />
        {/each}
      </div>
    </section>
  {/each}
  {#if newStageAt === stagesShown.length}<div class="stage-placeholder"></div>{/if}

  <button type="button" class="add-step" onclick={onAddStep}>
    <Plus size={13} /> Add step
  </button>
</div>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 8px;
    border-right: 1px solid var(--border);
  }
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 6px;
    background: var(--surface-base);
    border-bottom: 1px solid var(--border);
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    padding: 2px 4px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-size: inherit;
    text-align: left;
    cursor: text;
  }
  .name:hover {
    border-color: var(--border);
  }
  .name-input {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    background: var(--surface-sunken);
    border: 1px solid var(--border-focus);
    border-radius: 4px;
    color: var(--text);
    font-size: inherit;
    font-weight: 600;
  }
  .state {
    font-size: 11px;
    color: var(--text-muted);
  }
  .state.running {
    color: var(--accent-text);
  }
  .state.paused {
    color: var(--warning-text);
  }
  .rail-badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border-warning);
    color: var(--warning-text);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }
  .rail-badge.live {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .rail-badge.lit {
    background: var(--surface-overlay);
  }
  .bindings {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 3px 5px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .bindings:hover {
    background: var(--surface-hover);
    border-color: var(--border);
  }
  .bindings span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bindings .pg {
    color: var(--text-subtle);
    font-size: 10px;
  }
  .warn {
    margin: 0;
    font-size: 11px;
    color: var(--warning-text);
  }
  /* A single-step stage draws bare; only a parallel one gets a band, so
     "these run at the same time" is visible at a glance. */
  .stage.parallel {
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    padding: 6px;
  }
  .stage.drop-into {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .stage-placeholder {
    height: 34px;
    border: 1px dashed var(--border-focus);
    border-radius: 8px;
    background: var(--surface-accent);
  }
  .stage-label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--text-subtle);
  }
  .connector {
    align-self: center;
    width: 1px;
    height: 10px;
    background: var(--border-strong);
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stage.parallel .steps {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .stage.parallel .steps > :global(*) {
    flex: 1 1 120px;
  }
  .add-step {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    background: none;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .add-step:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
