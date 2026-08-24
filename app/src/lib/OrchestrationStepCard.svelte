<script lang="ts">
  import { Check, CircleAlert, RotateCw, X } from "@lucide/svelte";
  import BoardCard from "./BoardCard.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { tooltip } from "./tooltip";
  import { highlightedConflict } from "./orchestrationState";
  import type { Label } from "./kanban";
  import type { CardView, PlacedCardView } from "./planBoard";
  import type { StepState } from "./orchestration";

  interface Props {
    /// Drives the drag engine's [data-orch-step] hook. It sits on the
    /// wrapper below, which is a real block box: a display:contents
    /// wrapper would measure as a zero rect and break both the grab
    /// offset and the ghost's size.
    stepId: string;
    /// The card itself, exactly as the board projects it, plus the column
    /// it sits in -- the one fact the board never has to state and a rail
    /// always does.
    placed: PlacedCardView;
    state: StepState;
    /// Why the step stalled; null otherwise.
    reason: string | null;
    /// Badge numbers this step belongs to, and the highest severity among
    /// them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
    onRetry: () => void;
    onRemove: () => void;
    // --- everything below is the board's own plumbing, passed straight
    // through so a card on a rail behaves like a card anywhere else.
    labelDefs: Label[];
    workspaceId: string;
    onOpen: (path: string) => void;
    onRun: (card: CardView) => void;
    onSendToAgent: (card: CardView) => void;
    agentAvailable: boolean;
    onContextMenu: (card: CardView, e: MouseEvent) => void;
    /// Search state (orchestrationSearch.ts), same contract as the chip:
    /// `hit` rings the card the query found, `dimmed` fades the ones it
    /// did not. A rail keeps its whole shape while filtered.
    hit?: boolean;
    dimmed?: boolean;
  }
  let {
    stepId,
    placed,
    state,
    reason,
    badges,
    severity,
    onRetry,
    onRemove,
    labelDefs,
    workspaceId,
    onOpen,
    onRun,
    onSendToAgent,
    agentAvailable,
    onContextMenu,
    hit = false,
    dimmed = false,
  }: Props = $props();
</script>

<div
  data-orch-step={stepId}
  class="step {state}"
  class:sev-live={severity === "live"}
  class:sev-potential={severity === "potential"}
  class:hit
  class:dimmed
>
  <BoardCard
    card={placed.view}
    {labelDefs}
    {onOpen}
    {workspaceId}
    {onRun}
    {onSendToAgent}
    {agentAvailable}
    {onContextMenu}
    columnName={placed.columnName}
  >
    {#snippet adornment()}
      <div class="rail-strip">
        {#if state !== "pending"}
          <span class="state {state}" use:tooltip={state === "stalled" && reason ? reason : undefined}>
            {#if state === "done"}<Check size={11} />{/if}
            {#if state === "stalled"}<CircleAlert size={11} />{/if}
            {state}
          </span>
        {/if}
        {#each badges as n (n)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="badge"
            class:lit={$highlightedConflict === n}
            onmouseenter={() => highlightedConflict.set(n)}
            onmouseleave={() => highlightedConflict.set(null)}
          >{n}</span>
        {/each}
        {#if state === "stalled"}
          <IconButton icon={RotateCw} label="Retry" size={13} onclick={onRetry} />
        {/if}
        <IconButton icon={X} label="Remove from rail" size={13} onclick={onRemove} />
      </div>
    {/snippet}
  </BoardCard>
</div>

<style>
  /* The card keeps every one of its own colours; the two rail-only axes
     are drawn AROUND it. Run state is a ring on this wrapper, conflict
     severity a tinted frame just inside it -- so the two never collide
     the way a fill and a fill would (orchestration spec O9). */
  .step {
    border-radius: 8px;
    min-width: 0;
  }
  /* The board card carries its own inter-card margin; here the stage's
     gap owns the spacing. Direct child only -- a NESTED card inside an
     expanded plan still needs its own. */
  .step > :global(.card) {
    margin-bottom: 0;
  }
  .step.running {
    box-shadow: 0 0 0 2px var(--border-focus);
  }
  .step.done {
    box-shadow: 0 0 0 2px var(--border-success);
  }
  .step.done > :global(.card) {
    opacity: 0.75;
  }
  .step.stalled {
    box-shadow: 0 0 0 2px var(--border-danger);
  }
  .step.sev-potential,
  .step.sev-live {
    padding: 3px;
  }
  .step.sev-potential {
    background: var(--surface-warning);
  }
  .step.sev-live {
    background: var(--surface-danger);
  }
  .rail-strip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
  /* The state names itself in words -- on a card there is room for it,
     and "stalled" said outright beats a ring the human has to decode. */
  .state {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: auto;
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .state.running {
    color: var(--accent-text);
  }
  .state.done {
    color: var(--success-text);
  }
  .state.stalled {
    color: var(--danger-text);
  }
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid currentColor;
    color: var(--text-muted);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .badge.lit {
    opacity: 1;
    background: var(--surface-overlay);
  }
  .step.hit {
    border-radius: 6px;
    box-shadow: 0 0 0 1px var(--border-accent);
  }
  /* Faded, never hidden: the rail it sits in is the context that makes
     the match worth finding. */
  .step.dimmed {
    opacity: 0.32;
  }
</style>
