<script lang="ts">
  import { CheckCheck, RotateCw, SkipForward, X } from "@lucide/svelte";
  import BoardCard from "./BoardCard.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import { attentionIndicator, stepIndicator } from "./ui/indicators";
  import { highlightedConflict } from "./orchestrationState";
  import type { Label } from "./kanban";
  import type { CardView, PlacedCardView } from "./planBoard";
  import { attentionTip } from "./orchestration";
  import type { StepAttention, StepState } from "./orchestration";

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
    /// What gavin did to this run without being asked, or null. Same
    /// contract as the chip's: a step that is running again after a
    /// break is otherwise indistinguishable from one that never broke.
    resumeNote?: string | null;
    /// What this RUNNING step is waiting on a human for -- same contract
    /// as the chip's. Never a state of its own: the step is still
    /// running, and this only stops it looking busy when it isn't.
    attention: StepAttention | null;
    /// The board's done column, for the turn-ended tooltip.
    doneColumnName: string | null;
    /// Badge numbers this step belongs to, and the highest severity among
    /// them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
    onRetry: () => void;
    /// Files a step done by hand -- same contract as the chip's.
    onMarkDone: () => void;
    /// Sends the rail PAST this step without claiming it was done --
    /// same contract as the chip's.
    onSkip: () => void;
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
    resumeNote = null,
    attention,
    doneColumnName,
    badges,
    severity,
    onRetry,
    onMarkDone,
    onSkip,
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

  const attentionTitle = $derived(
    attention ? attentionTip(attention, doneColumnName ?? "the done column") : ""
  );
</script>

<div
  data-orch-step={stepId}
  class="step {state}"
  class:attention={attention !== null}
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
    showRailBadge={false}
  >
    {#snippet adornment()}
      <div class="rail-strip">
        <!-- The same badge the chip draws for the same step, now that
             the two agree on what a state looks like: the card used to
             spell `running` as an accent word with no glyph while the
             chip spelt it as an accent ring with no word. The word stays
             as the badge's text -- there is room for it here, and it is
             what makes the ramp of squares readable the first time. A
             stalled step's reason, or the note on a run gavin put back
             by itself, rides in the bubble. -->
        <StatusBadge
          indicator={stepIndicator(state)}
          text={state}
          class="state"
          tip={state === "stalled" && reason ? `Step · stalled: ${reason}` : (resumeNote ?? undefined)}
        />
        <!-- Beside the state, never in place of it: the step really is
             still running, and the rail really is still going. -->
        {#if attention}
          <StatusBadge
            indicator={attentionIndicator(attention)}
            text="needs you"
            tip={attentionTitle}
          />
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
        <!-- The pair, always together: these are the two honest answers
             to a step that is not going to finish on its own, and
             offering only the first is what made "Mark done" the button
             people pressed when they meant "move on". -->
        {#if state === "running" || state === "stalled"}
          <IconButton icon={CheckCheck} label="Mark done" size={13} onclick={onMarkDone} />
          <IconButton
            icon={SkipForward}
            label="Skip and proceed"
            size={13}
            onclick={onSkip}
          />
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
  /* Warning tone, NOT .stalled's danger ring: stalled means the rail
     stopped, this means it is still going and waiting on you. */
  .step.running.attention {
    box-shadow: 0 0 0 2px var(--border-warning);
  }
  .step.done {
    box-shadow: 0 0 0 2px var(--border-success);
  }
  /* Behind the rail like .done, and faded like it -- but a PLAIN ring,
     with none of done's success tone: the rail is past this step and
     nothing about it went right. */
  .step.skipped {
    box-shadow: 0 0 0 2px var(--border);
  }
  .step.done > :global(.card),
  .step.skipped > :global(.card) {
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
  /* Positioning only -- the state names itself in words here because a
     card has room for it, but what those words LOOK like is the badge's
     business now. This rule used to hold a private copy of the tone
     table, and it disagreed with the chip's. `margin-right: auto` keeps
     the buttons on the right, so the strip does not reflow when the
     attention badge appears beside it.

     Descendant :global(), never a leading one: a leading `:global(.state)`
     would restyle every .state in the app, which is how PlanTree's
     `.split` once dimmed LayoutTree. */
  .rail-strip :global(.state) {
    margin-right: auto;
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
