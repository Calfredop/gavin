<script lang="ts">
  import { FileText, ListChecks, StickyNote, Check, CircleAlert, RotateCw, X } from "@lucide/svelte";
  import { tooltip } from "./tooltip";
  import IconButton from "./ui/IconButton.svelte";
  import type { CardEntry, StepState } from "./orchestration";

  interface Props {
    cardPath: string;
    entry: CardEntry | undefined;
    state: StepState;
    reason: string | null;
    onRetry: () => void;
    onRemove: () => void;
  }
  let { cardPath, entry, state, reason, onRetry, onRemove }: Props = $props();

  const title = $derived(entry?.plan.title ?? cardPath.split("/").pop() ?? cardPath);
  const kind = $derived(entry?.plan.kind ?? "task");
  const Icon = $derived(kind === "plan" ? ListChecks : kind === "note" ? StickyNote : FileText);
</script>

<div class="chip {state}" use:tooltip={state === "stalled" && reason ? reason : undefined}>
  <Icon size={13} />
  <span class="title">{title}</span>
  {#if entry && entry.plan.checklistTotal > 0}
    <span class="checklist">{entry.plan.checklistDone}/{entry.plan.checklistTotal}</span>
  {/if}
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
</style>
