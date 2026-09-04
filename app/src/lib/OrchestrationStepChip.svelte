<script lang="ts">
  import {
    FileText,
    ListChecks,
    StickyNote,
    CheckCheck,
    RotateCw,
    SkipForward,
    X,
    Bot,
    Terminal,
    FileCode2,
    Zap,
    Repeat,
    GitPullRequest,
    Sliders,
  } from "@lucide/svelte";
  import { tooltip } from "./tooltip";
  import { highlightedConflict } from "./orchestrationState";
  import IconButton from "./ui/IconButton.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import { attentionIndicator, stepIndicator } from "./ui/indicators";
  import { describeOverrides, toolKindLabel } from "./orchestrationTools";
  import type { Tool } from "./orchestrationTools";
  import { attentionTip } from "./orchestration";
  import type { CardEntry, StepAttention, StepState } from "./orchestration";

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
    /// What gavin did to this run without being asked, or null. Shown on
    /// a step that is RUNNING again after a break, which would otherwise
    /// be indistinguishable from one that never broke.
    resumeNote?: string | null;
    /// What this RUNNING step is waiting on a human for, or null when it
    /// is simply working (see stepAttentions). Never a state of its own:
    /// the step is still `running` and the rail is still going, which is
    /// the whole point -- this only stops it looking busy when it isn't.
    attention: StepAttention | null;
    /// The board's done column, for the turn-ended tooltip. Null when the
    /// board has no columns, in which case the rail header already says
    /// nothing can complete.
    doneColumnName: string | null;
    /// Badge numbers this step belongs to, and the highest severity
    /// among them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
    onRetry: () => void;
    /// Files a step done by hand. Offered while it is running or
    /// stalled: the human can see the work is finished when the step's
    /// own signal says otherwise, and without this the only way past
    /// such a step is to delete it (and the session holding it).
    onMarkDone: () => void;
    /// Sends the rail PAST this step without claiming its work happened.
    /// The other half of the pair above, and the reason both are offered:
    /// "Mark done" was the only way past a step that would not finish, so
    /// it was pressed for work nobody did -- and every tally downstream
    /// then counted that step as delivered.
    onSkip: () => void;
    onRemove: () => void;
    /// Search state (orchestrationSearch.ts). `hit` rings the chip the
    /// query found; `dimmed` fades the ones it did not, so a rail keeps
    /// its shape while the eye goes straight to the match.
    hit?: boolean;
    dimmed?: boolean;
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
    resumeNote = null,
    attention,
    doneColumnName,
    badges,
    severity,
    onRetry,
    onMarkDone,
    onSkip,
    onRemove,
    hit = false,
    dimmed = false,
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
          : tool.kind === "gavin"
            ? Zap
            : tool.kind === "until"
              ? Repeat
              : tool.kind === "pr"
                ? GitPullRequest
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
  const attentionTitle = $derived(
    attention ? attentionTip(attention, doneColumnName ?? "the done column") : ""
  );
  const iconTip = $derived(tool ? toolKindLabel(tool.kind) : undefined);
</script>

<!-- The chip's own bubble says only what the chip IS: the stall reason
     and the attention text now live on the badges that state those
     facts, rather than being repeated by the row around them. -->
<div
  data-orch-step={stepId}
  class="chip {state}"
  class:tool={Boolean(toolId)}
  class:sev-live={severity === "live"}
  class:sev-potential={severity === "potential"}
  class:hit
  class:dimmed
  class:attention-asking={attention === "asking"}
  class:attention-ended={attention === "turn-ended"}
  use:tooltip={resumeNote ?? iconTip}>
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
  <!-- Beside the run state, not instead of it: the step really is still
       running, and a mark that replaced it would read as a stop. The two
       are different axes -- what the RAIL is doing with this step, and
       what the AGENT in it wants -- so they are two badges, and each is
       the same badge that fact wears everywhere else in the app. -->
  {#if attention}
    <StatusBadge indicator={attentionIndicator(attention)} size={13} tip={attentionTitle} />
  {/if}
  <!-- Every state, including the two that used to draw nothing at all.
       `running` was an accent ring and no glyph, so the state a rail
       exists to show was the one carried by colour alone; `pending` was
       blank, which is indistinguishable from a chip that simply has no
       state. A muted square per queued step also gives the whole rail a
       progress column to read down. -->
  <StatusBadge
    indicator={stepIndicator(state)}
    size={13}
    tip={state === "stalled" && reason ? `Step · stalled: ${reason}` : undefined}
  />
  {#if state === "stalled"}
    <IconButton icon={RotateCw} label="Retry" size={13} onclick={onRetry} />
  {/if}
  {#if state === "running" || state === "stalled"}
    <IconButton icon={CheckCheck} label="Mark done" size={13} onclick={onMarkDone} />
    <IconButton icon={SkipForward} label="Skip and proceed" size={13} onclick={onSkip} />
  {/if}
  {#if tool && tool.params.length > 0}
    <IconButton icon={Sliders} label="Tool parameters" size={13} onclick={onEditParams} />
  {/if}
  <IconButton icon={X} label="Remove from rail" size={13} onclick={onRemove} />
</div>

<style>
  .chip.hit {
    border-color: var(--border-accent);
    box-shadow: 0 0 0 1px var(--border-accent);
  }
  /* Faded, never hidden: the stage it sits in is the context that makes
     the match worth finding. */
  .chip.dimmed {
    opacity: 0.32;
  }
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
  /* A ring, like .running, in warning tone -- NOT .stalled's danger
     fill. Stalled means the rail stopped; this means it is still going
     and waiting on you, and the two must not look alike. Both marks
     share the ring: what separates them is the icon and the tooltip,
     because a second colour here would collide with severity's fill. */
  .chip.running.attention-asking,
  .chip.running.attention-ended {
    border-color: var(--border-warning);
    box-shadow: 0 0 0 1px var(--border-warning);
  }
  .chip.done {
    border-color: var(--border-success);
    color: var(--text-muted);
  }
  /* Muted like .done -- the rail is past both -- but the plain border,
     never done's success green: nothing about a skipped step succeeded. */
  .chip.skipped {
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
