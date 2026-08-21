<script lang="ts">
  import { FileText, ListChecks, StickyNote, Check, CircleAlert, RotateCw, X } from "@lucide/svelte";
  import { tooltip } from "./tooltip";
  import { highlightedConflict } from "./orchestrationState";
  import IconButton from "./ui/IconButton.svelte";
  import type { CardEntry, StepState } from "./orchestration";

  interface Props {
    /// Drives the drag engine's [data-orch-step] hook. On the chip's own
    /// root, never a wrapper: a display:contents wrapper measures as a
    /// zero rect, which would break the grab offset and the ghost size.
    stepId: string;
    cardPath: string;
    entry: CardEntry | undefined;
    state: StepState;
    reason: string | null;
    /// Badge numbers this step belongs to, and the highest severity
    /// among them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
    onRetry: () => void;
    onRemove: () => void;
  }
  let { stepId, cardPath, entry, state, reason, badges, severity, onRetry, onRemove }: Props = $props();

  const title = $derived(entry?.plan.title ?? cardPath.split("/").pop() ?? cardPath);
  const kind = $derived(entry?.plan.kind ?? "task");
  const Icon = $derived(kind === "plan" ? ListChecks : kind === "note" ? StickyNote : FileText);
</script>

<div
  data-orch-step={stepId}
  class="chip {state}"
  class:sev-live={severity === "live"}
  class:sev-potential={severity === "potential"}
  use:tooltip={state === "stalled" && reason ? reason : undefined}>
  <Icon size={13} />
  <span class="title">{title}</span>
  {#if entry && entry.plan.checklistTotal > 0}
    <span class="checklist">{entry.plan.checklistDone}/{entry.plan.checklistTotal}</span>
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
  {#if state === "done"}<Check size={13} />{/if}
  {#if state === "stalled"}
    <CircleAlert size={13} />
    <IconButton icon={RotateCw} label="Retry" size={13} onclick={onRetry} />
  {/if}
  <IconButton icon={X} label="Remove from rail" size={13} onclick={onRemove} />
</div>

<style>
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 12px;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .checklist {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Run state is a RING, not a fill: SP2's conflict severity colouring
     owns the chip's background, and the two axes must not collide. */
  .chip.running {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--border-focus);
  }
  .chip.done {
    border-color: var(--border-success);
    color: var(--text-muted);
  }
  .chip.stalled {
    border-color: var(--border-danger);
    background: var(--surface-danger);
  }
  /* Severity owns the FILL; run state owns the ring, so the two axes
     never collide (spec O9). A stalled step keeps its danger fill. */
  .chip.sev-potential:not(.stalled) {
    background: var(--surface-warning);
    border-color: var(--border-warning);
  }
  .chip.sev-live:not(.stalled) {
    background: var(--surface-danger);
    border-color: var(--border-danger);
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
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .badge.lit {
    opacity: 1;
    background: var(--surface-overlay);
  }
</style>
