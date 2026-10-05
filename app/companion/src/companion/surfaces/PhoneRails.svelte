<script lang="ts">
  // One workspace's rails: each one's state and the press that moves it,
  // and, a tap on Edit away, its stages and steps to change. A thin
  // template over phoneRails.ts (what each rail says) and state/rails.ts
  // (what each press does). Start and Resume arm a rail; the desk runs it.
  import { onMount } from "svelte";
  import { ChevronDown, ChevronUp, Pause, Pencil, Play, Plus, RotateCcw, Trash2, X } from "@lucide/svelte";
  import { kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import type { Workspace } from "$lib/core/workspace";
  import { orchestrations, saveErrors, dismissSaveError } from "$lib/orchestration/orchestrationState";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { railIndicator, stepIndicator } from "$lib/ui/indicators";
  import {
    addCard,
    deleteRailAsked,
    loadRails,
    moveStage,
    newRail,
    pressRail,
    removeStageAsked,
    removeStep,
    renameRail,
    resetRailAsked,
    setStageMode,
  } from "$companion/state/rails";
  import { openCard, openTerminal } from "$companion/state/workstation";
  import { cardsToPlace, PRESS_LABEL, railRows, railStateText, type RailRow } from "$companion/surfaces/phoneRails";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  const orch = $derived($orchestrations[workspace.id] ?? null);
  const input = $derived(
    orch ? { orch, tree: $gavinTrees[workspace.id], board: $kanbanState[workspace.id] } : null
  );
  const rails = $derived(input ? railRows(input) : []);
  const choices = $derived(input ? cardsToPlace(input) : []);
  const saveError = $derived($saveErrors[workspace.id] ?? null);

  /// The rail open for editing, one at a time.
  let editing = $state<string | null>(null);
  /// A press in flight, by rail, so a second tap does not send a second.
  let pressing = $state<string | null>(null);
  /// The add-a-card picker's two answers, for the rail being edited.
  let picked = $state("");
  let into = $state("");
  let failed = $state<string | null>(null);

  onMount(() => {
    void loadRails(workspace.id);
  });

  /// Shows a refusal the desk's action returned. The run-state writes
  /// report theirs to the save-error strip instead.
  function report(error: string | null): void {
    failed = error;
  }

  async function press(row: RailRow): Promise<void> {
    if (!row.press || pressing) return;
    pressing = row.id;
    try {
      await pressRail(workspace.id, row.id, row.press);
    } finally {
      pressing = null;
    }
  }

  function edit(railId: string | null): void {
    editing = railId;
    picked = "";
    into = "";
    failed = null;
  }

  async function makeRail(): Promise<void> {
    edit(await newRail(workspace.id));
  }

  async function add(row: RailRow): Promise<void> {
    if (!picked) return;
    report(await addCard(workspace.id, row.id, picked, into || null));
    picked = "";
  }
</script>

<div class="rails">
  <div class="bar">
    <button type="button" class="action" onclick={() => void makeRail()} disabled={!orch}>
      <Plus size={16} />
      <span>New rail</span>
    </button>
    <p class="hint">Starting a rail arms it. The desk runs it.</p>
  </div>

  {#if saveError || failed}
    <div class="error" role="alert">
      <span>{saveError ?? failed}</span>
      <button
        type="button"
        class="icon"
        aria-label="Dismiss"
        onclick={() => {
          dismissSaveError(workspace.id);
          failed = null;
        }}><X size={16} /></button
      >
    </div>
  {/if}

  {#if !orch}
    <p class="empty">Loading the rails…</p>
  {:else if rails.length === 0}
    <p class="empty">No rails in this workspace yet. A rail runs its cards one stage after another.</p>
  {:else}
    {#each rails as row (row.id)}
      {@const open = editing === row.id}
      <section class="rail" aria-label="Rail {row.name}">
        <header class="head">
          <StatusBadge indicator={railIndicator(row.state)} size={16} tip={null} />
          <span class="title">
            {#if open}
              <input
                class="name-field"
                aria-label="Rail name"
                value={row.name}
                onchange={(e) => void renameRail(workspace.id, row.id, e.currentTarget.value).then(report)}
              />
            {:else}
              <span class="name">{row.name}</span>
            {/if}
            <span class="said">{railStateText(row)}{#if row.trigger}<span class="trigger">{` · ${row.trigger}`}</span>{/if}</span>
          </span>
        </header>

        <div class="presses">
          {#if row.press}
            <button
              type="button"
              class="action primary"
              disabled={pressing !== null}
              onclick={() => void press(row)}
            >
              {#if row.press === "pause"}<Pause size={16} />{:else}<Play size={16} />{/if}
              <span>{PRESS_LABEL[row.press]}</span>
            </button>
          {/if}
          {#if row.state !== "running" && (row.state === "paused" || row.finished)}
            <button type="button" class="action" onclick={() => void resetRailAsked(workspace.id, row.id)}>
              <RotateCcw size={16} />
              <span>Reset</span>
            </button>
          {/if}
          <button type="button" class="action" aria-pressed={open} onclick={() => edit(open ? null : row.id)}>
            <Pencil size={16} />
            <span>{open ? "Done" : "Edit"}</span>
          </button>
        </div>

        {#if row.stages.length === 0}
          <p class="empty small">Nothing on this rail yet.</p>
        {/if}
        <ol class="stages">
          {#each row.stages as stage (stage.id)}
            <li class="stage" class:current={stage.current}>
              <div class="stage-head">
                <span class="stage-label">{stage.label}</span>
                {#if stage.group}
                  {#if open}
                    <select
                      class="mode"
                      aria-label="How {stage.label} runs"
                      value={stage.mode}
                      onchange={(e) =>
                        void setStageMode(
                          workspace.id,
                          stage.id,
                          e.currentTarget.value === "sequence" ? "sequence" : "parallel"
                        ).then(report)}
                    >
                      <option value="sequence">one at a time</option>
                      <option value="parallel">all at once</option>
                    </select>
                  {:else}
                    <span class="mode-said">{stage.mode === "sequence" ? "one at a time" : "all at once"}</span>
                  {/if}
                {/if}
                {#if open}
                  <span class="stage-tools">
                    <button
                      type="button"
                      class="icon"
                      aria-label="Move {stage.label} up"
                      disabled={stage.first}
                      onclick={() => void moveStage(workspace.id, row.id, stage.id, -1).then(report)}
                      ><ChevronUp size={18} /></button
                    >
                    <button
                      type="button"
                      class="icon"
                      aria-label="Move {stage.label} down"
                      disabled={stage.last}
                      onclick={() => void moveStage(workspace.id, row.id, stage.id, 1).then(report)}
                      ><ChevronDown size={18} /></button
                    >
                    <button
                      type="button"
                      class="icon"
                      aria-label="Remove {stage.label}"
                      onclick={() => void removeStageAsked(workspace.id, stage.id).then(report)}
                      ><Trash2 size={16} /></button
                    >
                  </span>
                {/if}
              </div>
              <ul class="steps">
                {#each stage.steps as step (step.id)}
                  <li class="step">
                    <button
                      type="button"
                      class="step-open"
                      disabled={!step.sessionId && !step.cardPath}
                      onclick={() => {
                        if (step.sessionId) openTerminal(step.sessionId);
                        else if (step.cardPath) openCard(step.cardPath);
                      }}
                    >
                      <StatusBadge indicator={stepIndicator(step.state)} size={14} tip={null} />
                      <span class="step-text">
                        <span class="step-title">{step.title}</span>
                        {#if step.reason}
                          <span class="step-said problem">{step.reason}</span>
                        {:else if step.column}
                          <span class="step-said">{step.column}</span>
                        {/if}
                      </span>
                    </button>
                    {#if open}
                      <button
                        type="button"
                        class="icon"
                        aria-label="Take {step.title} off the rail"
                        onclick={() => void removeStep(workspace.id, step.id).then(report)}><X size={16} /></button
                      >
                    {/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ol>

        {#if open}
          <div class="adding">
            <select class="pick" aria-label="Card to add" bind:value={picked}>
              <option value="">Add a card…</option>
              {#each choices as choice (choice.path)}
                <option value={choice.path}>{choice.title}{choice.column ? ` · ${choice.column}` : ""}</option>
              {/each}
            </select>
            <select class="pick" aria-label="Where it goes" bind:value={into}>
              <option value="">as a new stage</option>
              {#each row.stages as stage (stage.id)}
                <option value={stage.id}>into {stage.label}</option>
              {/each}
            </select>
            <button type="button" class="action" disabled={!picked} onclick={() => void add(row)}>
              <Plus size={16} />
              <span>Add</span>
            </button>
          </div>
          <button
            type="button"
            class="action danger"
            onclick={() =>
              void deleteRailAsked(workspace.id, row.id).then((error) => {
                report(error);
                if (!error && !$orchestrations[workspace.id]?.rails.some((r) => r.id === row.id)) edit(null);
              })}
          >
            <Trash2 size={16} />
            <span>Delete rail</span>
          </button>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .rails {
    padding: 0 max(12px, env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0 4px;
  }
  .hint {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.75rem;
    line-height: 1.4;
  }
  .action {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action.primary {
    border-color: var(--accent);
  }
  .action.danger {
    margin-top: 8px;
    color: var(--danger-text);
  }
  .action:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    opacity: 0.45;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
  }
  .icon:disabled {
    opacity: 0.3;
  }
  .action:focus-visible,
  .icon:focus-visible,
  .step-open:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    padding-left: 12px;
    border-radius: 6px;
    background: var(--surface-danger, var(--surface-raised));
    color: var(--danger-text);
    font-size: 0.8125rem;
  }
  .error span {
    flex: 1 1 auto;
    overflow-wrap: anywhere;
  }
  .empty {
    margin: 0;
    padding: 20px 4px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .empty.small {
    padding: 8px 0 0;
  }
  .rail {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name-field {
    min-height: 36px;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
  }
  .said {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .trigger {
    color: var(--text-subtle);
  }
  .presses {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .stages {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }
  .stage {
    padding: 6px 0 6px 10px;
    border-left: 2px solid var(--border);
  }
  .stage.current {
    border-left-color: var(--accent);
  }
  .stage-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .stage-label {
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .mode-said {
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .mode,
  .pick {
    min-height: 36px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font-size: 16px;
  }
  .stage-tools {
    display: inline-flex;
    margin-left: auto;
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    display: flex;
    align-items: center;
  }
  .step-open {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 44px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  .step-open:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .step-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .step-title,
  .step-said {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-title {
    color: var(--text);
    font-size: 0.9375rem;
  }
  .step-said {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .problem {
    color: var(--danger-text);
    white-space: normal;
  }
  .adding {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .pick {
    flex: 1 1 100%;
    min-height: 44px;
  }
</style>
