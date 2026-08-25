<script lang="ts">
  import {
    Play,
    Pause,
    RotateCcw,
    Trash2,
    Plus,
    SquareStack,
    BrushCleaning,
    CirclePause,
    MessageCircleQuestionMark,
  } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import OrchestrationStepChip from "./OrchestrationStepChip.svelte";
  import OrchestrationStepCard from "./OrchestrationStepCard.svelte";
  import type { Label } from "./kanban";
  import type { CardView, PlacedCardView } from "./planBoard";
  import type {
    CardEntry,
    NumberedConflict,
    Orchestration,
    Rail,
    StepAttention,
  } from "./orchestration";
  import { stepParams, attentionTip, railAttention } from "./orchestration";
  import { findTool } from "./orchestrationTools";
  import type { Tool } from "./orchestrationTools";
  import {
    railStateOf,
    stepStateOf,
    numbersForStep,
    numbersForRail,
    railCardPaths,
    railDoneStepIds,
    severityForStep,
    severityForRail,
  } from "./orchestration";
  import { highlightedConflict } from "./orchestrationState";
  import { orchDragState } from "./orchestrationDrag";
  import { tooltip } from "./tooltip";

  interface Props {
    rail: Rail;
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    /// The tool library, for resolving a tool step's chip. A step whose
    /// tool is absent still renders -- by its id (see the chip).
    tools: Tool[];
    /// The board's own projection of every card, by path. A card step
    /// found here renders as the KANBAN CARD; one that isn't (the board
    /// still loading, or a card deleted out from under the plan) falls
    /// back to the slim chip, which can say so honestly.
    placedCards: Map<string, PlacedCardView>;
    labelDefs: Label[];
    workspaceId: string;
    /// Null when the board has no columns at all — nothing can complete,
    /// and the header says so rather than looking hung.
    doneColumnName: string | null;
    numbered: NumberedConflict[];
    /// Every running step in this workspace that is waiting on a human,
    /// by step id (see stepAttentions). Handed down rather than derived
    /// here, so one computation feeds the chips, this header, the sidebar
    /// recap and the hub tab alike.
    attentions: Map<string, StepAttention>;
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
    /// Opens the column menu at the pointer -- the parent owns the
    /// board's columns and builds the entries, exactly as it does for a
    /// card's own right-click menu.
    onMoveAll: (e: MouseEvent) => void;
    /// Takes the rail's finished steps off it. The cards are untouched:
    /// only the steps that pointed at them leave.
    onClearDone: () => void;
    /// Resolved page name for the bindings row; null when unbound.
    pageName: string | null;
    onBind: () => void;
    onAddStep: () => void;
    onRetryStep: (stepId: string) => void;
    onMarkStepDone: (stepId: string) => void;
    onRemoveStep: (stepId: string) => void;
    /// The tab's search box holds a query. A rail keeps its whole shape
    /// while filtered -- a pipeline with holes in it would read as a
    /// different pipeline -- so the non-matching steps only dim.
    filtering?: boolean;
    stepLit?: (stepId: string) => boolean;
    onEditStepParams: (stepId: string) => void;
    // The board plumbing a card step needs to behave like a card: open,
    // run, right-click. Handed down rather than reached for, so this
    // component stays as dumb as it was.
    onOpenCard: (path: string) => void;
    onRunCard: (card: CardView) => void;
    onSendCardToAgent: (card: CardView) => void;
    agentAvailable: boolean;
    onCardContextMenu: (card: CardView, e: MouseEvent) => void;
  }
  let {
    rail,
    orch,
    cards,
    tools,
    placedCards,
    labelDefs,
    workspaceId,
    doneColumnName,
    numbered,
    attentions,
    pageName,
    editing,
    onStartEdit,
    onRename,
    onCancelEdit,
    onStart,
    onPause,
    onReset,
    onDelete,
    onMoveAll,
    onClearDone,
    onBind,
    onAddStep,
    onRetryStep,
    onMarkStepDone,
    onRemoveStep,
    onEditStepParams,
    onOpenCard,
    onRunCard,
    onSendCardToAgent,
    agentAvailable,
    onCardContextMenu,
    filtering = false,
    stepLit = () => false,
  }: Props = $props();

  const railState = $derived(railStateOf(orch, rail.id));
  // The rail's most urgent step mark, so a hub full of rails says which
  // one needs you without the human reading every stage.
  const attention = $derived(railAttention(rail, attentions));
  const attentionTitle = $derived(
    attention ? attentionTip(attention, doneColumnName ?? "the done column") : ""
  );
  const stages = $derived([...rail.stages].sort((a, b) => a.position - b.position));
  // A rail-level conflict (missing/unbound worktree) badges the HEADER,
  // not any chip -- the cause is the binding, not a step.
  const railBadges = $derived(numbersForRail(numbered, rail.id));
  // What "move all" would act on: cards, not steps -- a tool step has no
  // card and a card written onto two steps is still one file.
  const cardCount = $derived(railCardPaths(rail).length);
  // A disabled button says WHY, in the tooltip -- the two reasons it can
  // be dead are different problems with different fixes.
  const moveAllTip = $derived(
    !doneColumnName
      ? "This board has no columns"
      : cardCount === 0
        ? "This rail carries no cards"
        : `Move all ${cardCount} ${cardCount === 1 ? "card" : "cards"} to a column…`
  );
  // What "clear done" would take off: the finished steps, by the same
  // two facts the scheduler joins -- run state, or the card's own column.
  const doneSteps = $derived(railDoneStepIds(rail, orch, cards, doneColumnName));
  const clearDoneTip = $derived(
    doneSteps.length === 0
      ? "This rail has no done steps"
      : `Remove ${doneSteps.length} done ${doneSteps.length === 1 ? "step" : "steps"} from this rail`
  );
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
      <!-- After the state word, not instead of it: a rail with a step
           waiting on a human is still running, and saying otherwise here
           would contradict the Pause button right beside it. -->
      {#if attention}
        <span class="attention" use:tooltip={attentionTitle}>
          {#if attention === "asking"}
            <MessageCircleQuestionMark size={11} />
          {:else}
            <CirclePause size={11} />
          {/if}
          needs you
        </span>
      {/if}
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
      <IconButton
        icon={SquareStack}
        label="Move all cards to a column…"
        tip={moveAllTip}
        disabled={cardCount === 0 || !doneColumnName}
        onclick={onMoveAll}
      />
      <IconButton
        icon={BrushCleaning}
        label="Clear done steps"
        tip={clearDoneTip}
        disabled={doneSteps.length === 0}
        onclick={onClearDone}
      />
      <IconButton icon={Trash2} label="Delete rail" tone="danger" onclick={onDelete} />
    </div>
    <button type="button" class="bindings" onclick={onBind}>
      <span class="wt">{rail.worktreePath ?? "no worktree"}</span>
      <!-- Not "no page": an unbound rail is not page-less, it gets one
           of its own the moment the human arms it (spec O16). -->
      <span class="pg">{pageName ?? "page at Start"}</span>
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
          <!-- A card step IS the kanban card; a TOOL step keeps the chip,
               because a tool is not a card and the dashed chip is what
               says so. -->
          {@const placed = step.toolId ? undefined : placedCards.get(step.cardPath)}
          {#if placed}
            <OrchestrationStepCard
              stepId={step.id}
              {placed}
              state={stepStateOf(orch, step.id)}
              reason={runOf(step.id)?.reason ?? null}
              attention={attentions.get(step.id) ?? null}
              {doneColumnName}
              badges={numbersForStep(numbered, step.id)}
              severity={severityForStep(numbered, step.id)}
              onRetry={() => onRetryStep(step.id)}
              onMarkDone={() => onMarkStepDone(step.id)}
              onRemove={() => onRemoveStep(step.id)}
              {labelDefs}
              {workspaceId}
              onOpen={onOpenCard}
              onRun={onRunCard}
              onSendToAgent={onSendCardToAgent}
              {agentAvailable}
              onContextMenu={onCardContextMenu}
              dimmed={filtering && !stepLit(step.id)}
              hit={filtering && stepLit(step.id)}
            />
          {:else}
            <OrchestrationStepChip
              stepId={step.id}
              cardPath={step.cardPath}
              entry={cards.get(step.cardPath)}
              toolId={step.toolId ?? null}
              tool={step.toolId ? findTool(tools, step.toolId) : undefined}
              toolParams={stepParams(step)}
              state={stepStateOf(orch, step.id)}
              reason={runOf(step.id)?.reason ?? null}
              attention={attentions.get(step.id) ?? null}
              {doneColumnName}
              badges={numbersForStep(numbered, step.id)}
              severity={severityForStep(numbered, step.id)}
              onRetry={() => onRetryStep(step.id)}
              onMarkDone={() => onMarkStepDone(step.id)}
              onRemove={() => onRemoveStep(step.id)}
              onEditParams={() => onEditStepParams(step.id)}
              dimmed={filtering && !stepLit(step.id)}
              hit={filtering && stepLit(step.id)}
            />
          {/if}
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
  /* Warning tone, matching the chip ring it summarises. A running rail
     keeps its accent-coloured state word: this qualifies that word, it
     does not replace it. */
  .attention {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
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
  /* Wide enough that a card keeps its shape: below this a parallel
     stage's cards wrap and stack, which the band still marks as
     concurrent. */
  .stage.parallel .steps > :global(*) {
    flex: 1 1 200px;
    min-width: 0;
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
