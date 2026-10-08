<script lang="ts">
  // One workspace's rails, side by side as the desk lays them out: a
  // swipe apart, one to a page, with a strip of their names above. Each
  // says its state and the press that moves it, and, a tap on Edit away,
  // its stages and steps to change. A thin template over phoneRails.ts
  // (what each rail says) and state/rails.ts (what each press does).
  // Start and Resume arm a rail; the desk runs it.
  import { onMount, tick, untrack } from "svelte";
  import { ChevronDown, ChevronUp, Pause, Pencil, Play, Plus, RotateCcw, Sparkles, Trash2, X } from "@lucide/svelte";
  import { kanbanState } from "$lib/board/kanbanState";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { gavinTrees } from "$lib/core/gavinState";
  import { daemonCompat } from "$lib/core/layoutState";
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
    organizeRails,
    pressRail,
    recoverRails,
    removeStageAsked,
    removeStep,
    renameRail,
    reorganizeRail,
    resetRailAsked,
    setStageMode,
  } from "$companion/state/rails";
  import { onReconnect, reachability, shownError } from "$companion/state/reachability";
  import { openCard, openTerminal } from "$companion/state/workstation";
  import { columnAt, scrollBehaviour } from "$companion/surfaces/phoneBoard";
  import {
    agentPresses,
    cardsToPlace,
    openingRail,
    PRESS_LABEL,
    railRows,
    railStateText,
    type RailRow,
  } from "$companion/surfaces/phoneRails";

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
  const saveError = $derived(shownError($saveErrors[workspace.id], $reachability));
  // Organize and a rail's Reorganize, by the desk's rules: one agent run
  // per workspace, and while it goes each press shows it.
  const agents = $derived(
    agentPresses({
      workspace,
      daemonBlocked: featureBlockedReason($daemonCompat, "orchestration"),
      unplacedCount: choices.length,
    })
  );

  /// The rail open for editing, one at a time.
  let editing = $state<string | null>(null);
  /// A press in flight, by rail, so a second tap does not send a second.
  let pressing = $state<string | null>(null);
  /// An Organize or Reorganize on its way, for the same reason.
  let asking = $state(false);
  /// The add-a-card picker's two answers, for the rail being edited.
  let picked = $state("");
  let into = $state("");
  let failed = $state<string | null>(null);

  onMount(() => {
    void loadRails(workspace.id);
    return onReconnect(() => void recoverRails(workspace.id));
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

  async function askAgent(run: () => Promise<string | null>): Promise<void> {
    if (asking) return;
    asking = true;
    try {
      report(await run());
    } finally {
      asking = false;
    }
  }

  function edit(railId: string | null): void {
    editing = railId;
    picked = "";
    into = "";
    failed = null;
  }

  async function makeRail(): Promise<void> {
    const id = await newRail(workspace.id);
    edit(id);
    await tick();
    show(id);
  }

  // ---- the pager ------------------------------------------------------------
  let pager = $state<HTMLElement | null>(null);
  let shown = $state<string | null>(null);
  // The rail a tap is on its way to. While it is set the strip already
  // names it, and the pages the pager passes on the way are not the
  // human's choice to follow.
  let heading: string | null = null;

  // The rail the surface opens on, once its rails first arrive, and again
  // only when the one shown is deleted: every push redraws the rails, and
  // a rail the human swiped to must not be taken from under their thumb.
  $effect(() => {
    if (!pager || rails.length === 0) return;
    untrack(() => {
      if (shown !== null && rails.some((r) => r.id === shown)) return;
      shown = openingRail(rails);
      const index = rails.findIndex((r) => r.id === shown);
      if (pager) pager.scrollLeft = Math.max(0, index) * pager.clientWidth;
    });
  });

  function show(railId: string): void {
    const index = rails.findIndex((r) => r.id === railId);
    if (!pager || index === -1) return;
    shown = railId;
    heading = railId;
    pager.scrollTo({
      left: index * pager.clientWidth,
      behavior: scrollBehaviour({
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        visible: document.visibilityState === "visible",
      }),
    });
  }

  // A swipe settles on a page; the strip above follows it.
  function followSwipe(): void {
    if (!pager) return;
    const at = columnAt(
      rails.map((r) => r.id),
      pager.scrollLeft,
      pager.clientWidth
    );
    if (at === null) return;
    if (heading !== null) {
      if (at === heading) heading = null;
      return;
    }
    if (at !== shown) shown = at;
  }

  // A finger on the pager takes over from a tap still on its way.
  function takeOver(): void {
    heading = null;
  }

  async function add(row: RailRow): Promise<void> {
    if (!picked) return;
    report(await addCard(workspace.id, row.id, picked, into || null));
    picked = "";
  }
</script>

<div class="rails">
  <div class="top">
    <div class="bar">
      <button type="button" class="action" onclick={() => void makeRail()} disabled={!orch}>
        <Plus size={16} />
        <span>New rail</span>
      </button>
      <button
        type="button"
        class="action"
        class:primary={agents.running}
        disabled={!orch || asking}
        onclick={() => void askAgent(() => organizeRails(workspace.id, agents.organize))}
      >
        <Sparkles size={16} />
        <span>{agents.organizeLabel}</span>
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
  </div>

  {#if !orch}
    <p class="empty">Loading the rails…</p>
  {:else if rails.length === 0}
    <p class="empty">No rails in this workspace yet. A rail runs its cards one stage after another.</p>
  {:else}
    <div class="strip" role="tablist" aria-label="Rails">
      {#each rails as row (row.id)}
        <button
          type="button"
          role="tab"
          class="tab"
          class:shown={row.id === shown}
          aria-selected={row.id === shown}
          onclick={() => show(row.id)}
        >
          <StatusBadge indicator={railIndicator(row.state)} size={14} tip={null} />
          <span class="tab-name">{row.name}</span>
        </button>
      {/each}
    </div>

    <div
      class="pager"
      role="group"
      aria-label="Rails, one at a time"
      bind:this={pager}
      onscroll={followSwipe}
      ontouchstart={takeOver}
      onpointerdown={takeOver}
    >
      {#each rails as row (row.id)}
        {@const open = editing === row.id}
        {@const reorganize = agents.reorganize(row.id)}
        <div class="page">
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
                        <span class="choice mode">
                          <select
                            class="pick"
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
                          <ChevronDown size={16} />
                        </span>
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
                <span class="choice">
                  <select class="pick" aria-label="Card to add" bind:value={picked}>
                    <option value="">Add a card…</option>
                    {#each choices as choice (choice.path)}
                      <option value={choice.path}>{choice.title}{choice.column ? ` · ${choice.column}` : ""}</option>
                    {/each}
                  </select>
                  <ChevronDown size={16} />
                </span>
                <span class="choice">
                  <select class="pick" aria-label="Where it goes" bind:value={into}>
                    <option value="">as a new stage</option>
                    {#each row.stages as stage (stage.id)}
                      <option value={stage.id}>into {stage.label}</option>
                    {/each}
                  </select>
                  <ChevronDown size={16} />
                </span>
                <button type="button" class="action" disabled={!picked} onclick={() => void add(row)}>
                  <Plus size={16} />
                  <span>Add</span>
                </button>
              </div>
              <button
                type="button"
                class="action reorganize"
                class:primary={reorganize.kind === "jump"}
                disabled={asking}
                onclick={() => void askAgent(() => reorganizeRail(workspace.id, row.id, reorganize))}
              >
                <Sparkles size={16} />
                <span>{reorganize.kind === "jump" ? "Jump to the running agent" : "Reorganize with agent"}</span>
              </button>
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
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .rails {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .top {
    flex: 0 0 auto;
    padding: 0 max(12px, env(safe-area-inset-right)) 4px max(12px, env(safe-area-inset-left));
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
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
  .action.reorganize {
    margin-top: 12px;
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
  .step-open:focus-visible,
  .pick:focus-visible {
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
    padding: 20px max(16px, env(safe-area-inset-right)) 20px max(16px, env(safe-area-inset-left));
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .empty.small {
    padding: 8px 0 0;
  }
  /* The strip is the rails at a glance -- each one's name and state --
     and the way between them for a thumb that would rather tap than
     swipe. The board's, so the two surfaces page alike. */
  .strip {
    display: flex;
    flex: 0 0 auto;
    overflow-x: auto;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
    scrollbar-width: none;
  }
  .tab {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    max-width: 60vw;
    min-height: 44px;
    padding: 0 14px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }
  .tab-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab.shown {
    border-bottom-color: var(--accent);
    color: var(--text);
  }
  .tab:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  /* One rail to a page, a swipe to the next: the desk's rails stand
     side by side, and on a phone that row is this. Each page scrolls its
     own rail down. */
  .pager {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .page {
    flex: 0 0 100%;
    box-sizing: border-box;
    min-width: 0;
    padding: 12px max(12px, env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
    overflow-y: auto;
    scroll-snap-align: start;
    scroll-snap-stop: always;
  }
  .rail {
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
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    min-height: 44px;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font: inherit;
    font-size: 16px;
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
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .stage-label {
    min-width: 0;
    overflow: hidden;
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .mode-said {
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  /* A select is as wide as its longest option unless something stops
     it, and a flex item will not shrink below that -- a card title put
     the Add-a-card picker 92px off a 402px phone. So each one takes the
     column and cuts its chosen text short inside it. It also draws its
     own box: WebKit sizes a native select to its font and ignores
     min-height, 29px on an iPhone under a 44px rule. */
  .choice {
    position: relative;
    display: block;
    flex: 1 1 100%;
    min-width: 0;
    max-width: 100%;
  }
  .choice :global(svg) {
    position: absolute;
    top: 50%;
    right: 12px;
    color: var(--text-muted);
    transform: translateY(-50%);
    pointer-events: none;
  }
  .pick {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    min-height: 44px;
    padding: 0 40px 0 10px;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font-size: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
    appearance: none;
  }
  /* A group's mode goes under its label, the stage's tools beside it. */
  .mode {
    order: 1;
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
</style>
