<script lang="ts">
  import { Play, Pause, RotateCcw, Trash2, Plus } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import OrchestrationStepChip from "./OrchestrationStepChip.svelte";
  import type { CardEntry, Orchestration, Rail } from "./orchestration";
  import { railStateOf, stepStateOf } from "./orchestration";

  interface Props {
    rail: Rail;
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    /// Null when the board has no columns at all — nothing can complete,
    /// and the header says so rather than looking hung.
    doneColumnName: string | null;
    onStart: () => void;
    onPause: () => void;
    onReset: () => void;
    onDelete: () => void;
    onBind: (patch: { worktreePath?: string | null; pageId?: string | null }) => void;
    onAddStep: () => void;
    onRetryStep: (stepId: string) => void;
    onRemoveStep: (stepId: string) => void;
  }
  let {
    rail,
    orch,
    cards,
    doneColumnName,
    onStart,
    onPause,
    onReset,
    onDelete,
    onBind,
    onAddStep,
    onRetryStep,
    onRemoveStep,
  }: Props = $props();

  const state = $derived(railStateOf(orch, rail.id));
  const stages = $derived([...rail.stages].sort((a, b) => a.position - b.position));

  function runOf(id: string) {
    return orch.stepRuns.find((r) => r.stepId === id) ?? null;
  }
</script>

<div class="rail">
  <header>
    <div class="name-row">
      <span class="name">{rail.name}</span>
      <span class="state {state}">{state}</span>
      {#if state === "running"}
        <IconButton icon={Pause} label="Pause" onclick={onPause} />
      {:else}
        <IconButton
          icon={Play}
          label={state === "paused" ? "Resume" : "Start"}
          tone="accent"
          onclick={onStart}
        />
      {/if}
      <IconButton icon={RotateCcw} label="Reset run state" onclick={onReset} />
      <IconButton icon={Trash2} label="Delete rail" tone="danger" onclick={onDelete} />
    </div>
    <!-- SP1 binds with plain inputs; SP2 replaces these with the fork
         dialog and a page picker. -->
    <label class="bind">
      <span>worktree</span>
      <input
        value={rail.worktreePath ?? ""}
        placeholder="(the card's own folder)"
        onchange={(e) => onBind({ worktreePath: e.currentTarget.value.trim() || null })}
      />
    </label>
    <label class="bind">
      <span>page id</span>
      <input
        value={rail.pageId ?? ""}
        placeholder="(the Agents page)"
        onchange={(e) => onBind({ pageId: e.currentTarget.value.trim() || null })}
      />
    </label>
    {#if !doneColumnName}
      <p class="warn">This board has no columns — nothing can complete.</p>
    {/if}
  </header>

  {#each stages as stage, i (stage.id)}
    {#if i > 0}<div class="connector"></div>{/if}
    <section class="stage" class:parallel={stage.steps.length > 1}>
      {#if stage.steps.length > 1}
        <span class="stage-label">stage {i + 1} — parallel</span>
      {/if}
      <div class="steps">
        {#each [...stage.steps].sort((a, b) => a.position - b.position) as step (step.id)}
          <OrchestrationStepChip
            cardPath={step.cardPath}
            entry={cards.get(step.cardPath)}
            state={stepStateOf(orch, step.id)}
            reason={runOf(step.id)?.reason ?? null}
            onRetry={() => onRetryStep(step.id)}
            onRemove={() => onRemoveStep(step.id)}
          />
        {/each}
      </div>
    </section>
  {/each}

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
  .bind {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .bind span {
    flex: none;
  }
  .bind input {
    flex: 1;
    min-width: 0;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 2px 4px;
    font-size: 11px;
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
