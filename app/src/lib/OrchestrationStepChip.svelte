<script lang="ts">
  import {
    FileText,
    ListChecks,
    StickyNote,
    Check,
    CircleAlert,
    RotateCw,
    X,
    Bot,
    Terminal,
    FileCode2,
    Sliders,
  } from "@lucide/svelte";
  import { tooltip } from "./tooltip";
  import { highlightedConflict } from "./orchestrationState";
  import IconButton from "./ui/IconButton.svelte";
  import { describeOverrides, toolKindLabel } from "./orchestrationTools";
  import type { Tool } from "./orchestrationTools";
  import type { CardEntry, StepState } from "./orchestration";

  interface Props {
    /// Drives the drag engine's [data-orch-step] hook. On the chip's own
    /// root, never a wrapper: a display:contents wrapper measures as a
    /// zero rect, which would break the grab offset and the ghost size.
    stepId: string;
    cardPath: string;
    entry: CardEntry | undefined;
    /// Set for a TOOL step. Undefined either because this is a card
    /// step (toolId null) or because the tool was deleted, which the
    /// chip has to render honestly rather than as an empty chip.
    toolId: string | null;
    tool: Tool | undefined;
    toolParams: Record<string, string>;
    state: StepState;
    reason: string | null;
    /// Badge numbers this step belongs to, and the highest severity
    /// among them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
    onRetry: () => void;
    onRemove: () => void;
    /// Opens the params popover. Offered only for a tool that actually
    /// declares parameters.
    onEditParams: () => void;
  }
  let {
    stepId,
    cardPath,
    entry,
    toolId,
    tool,
    toolParams,
    state,
    reason,
    badges,
    severity,
    onRetry,
    onRemove,
    onEditParams,
  }: Props = $props();

  const kind = $derived(entry?.plan.kind ?? "task");
  // A deleted tool still has to render: its id is the only honest label
  // left, and the step stalls with "tool is no longer in the library"
  // the moment the rail reaches it.
  const title = $derived(
    toolId ? (tool?.name ?? toolId) : (entry?.plan.title ?? cardPath.split("/").pop() ?? cardPath)
  );
  const Icon = $derived(
    tool
      ? tool.kind === "agent"
        ? Bot
        : tool.kind === "command"
          ? Terminal
          : FileCode2
      : toolId
        ? Terminal
        : kind === "plan"
          ? ListChecks
          : kind === "note"
            ? StickyNote
            : FileText
  );
  const overrides = $derived(tool ? describeOverrides(tool, toolParams) : "");
  const iconTip = $derived(tool ? toolKindLabel(tool.kind) : undefined);
</script>

<div
  data-orch-step={stepId}
  class="chip {state}"
  class:tool={Boolean(toolId)}
  class:sev-live={severity === "live"}
  class:sev-potential={severity === "potential"}
  use:tooltip={state === "stalled" && reason ? reason : iconTip}>
  <Icon size={13} />
  <span class="title">{title}</span>
  {#if overrides}
    <span class="overrides" title={overrides}>{overrides}</span>
  {/if}
  {#if entry && !toolId && entry.plan.checklistTotal > 0}
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
  {#if tool && tool.params.length > 0}
    <IconButton icon={Sliders} label="Tool parameters" size={13} onclick={onEditParams} />
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
  /* A tool step reads as a different KIND of thing from a card step, so
     it gets a dashed border rather than another colour -- the fill and
     the ring are already spoken for by severity and run state (spec O9). */
  .chip.tool {
    border-style: dashed;
  }
  /* The non-default params, so two "Merge" steps on one rail are
     distinguishable without opening anything. Truncates before the
     title does: the title is what names the step. */
  .overrides {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
    font-size: 11px;
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
