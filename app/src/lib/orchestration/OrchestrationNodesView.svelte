<script lang="ts">
  // The Orchestration tab's node graph: a template over
  // orchestrationNodes.ts, drawn the way GitGraphRow draws commits. One
  // row per step, a gutter of lanes on the left -- a dot on the row's
  // lane, the rail's line through its dots, a fork where a parallel
  // group leaves the lane -- and one line of text beside it. Every
  // press hands back to the hub view through the same callbacks the
  // strip's chips use, so a row and a chip are two pictures of one step
  // and never two behaviours.
  //
  // No drag here, on purpose: the strip is where a plan is ARRANGED (the
  // drag engine's hit-testing is written against its columns and bands),
  // and the graph is where it is READ. The hub view attaches the engine
  // only when the strip is on screen.
  import { Ellipsis, Pause, Play } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { tooltip } from "$lib/core/tooltip";
  import { openContextMenuFromEvent, type ContextMenuEntry } from "$lib/core/contextMenu";
  import { attentionIndicator, railIndicator, stepIndicator } from "$lib/ui/indicators";
  import { stepIcon } from "$lib/ui/toolKindIcon";
  import { highlightedConflict } from "$lib/orchestration/orchestrationState";
  import type { CardView, PlacedCardView } from "$lib/core/planBoard";
  import type {
    CardEntry,
    NumberedConflict,
    Orchestration,
    StepAttention,
  } from "$lib/orchestration/orchestration";
  import {
    attentionTip,
    numbersForStep,
    railAttention,
    railStateOf,
    severityForStep,
    stepParams,
    stepStateOf,
  } from "$lib/orchestration/orchestration";
  import { describeOverrides, findTool, toolKindLabel, type Tool } from "$lib/orchestration/orchestrationTools";
  import {
    layoutNodeGraph,
    laneX,
    rowY,
    ROW_H,
    type GraphRow,
  } from "$lib/orchestration/orchestrationNodes";

  interface Props {
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    tools: Tool[];
    /// The board's projection, for a card row's right-click menu: the
    /// same entries the board and the strip offer on that card.
    placedCards: Map<string, PlacedCardView>;
    numbered: NumberedConflict[];
    attentions: Map<string, StepAttention>;
    doneColumnName: string | null;
    /// The search lens (orchestrationSearch.ts): rails with no hit leave
    /// the graph, matching rows light up, the rest dim.
    filtering: boolean;
    railShown: (railId: string) => boolean;
    stepLit: (stepId: string) => boolean;
    onStart: (railId: string) => void;
    onPause: (railId: string) => void;
    onOpenCard: (path: string) => void;
    onCardContextMenu: (card: CardView, e: MouseEvent) => void;
    onRetryStep: (stepId: string) => void;
    onMarkStepDone: (stepId: string) => void;
    onSkipStep: (stepId: string) => void;
    onRemoveStep: (stepId: string) => void;
    onEditStepParams: (stepId: string) => void;
  }
  let {
    orch,
    cards,
    tools,
    placedCards,
    numbered,
    attentions,
    doneColumnName,
    filtering,
    railShown,
    stepLit,
    onStart,
    onPause,
    onOpenCard,
    onCardContextMenu,
    onRetryStep,
    onMarkStepDone,
    onSkipStep,
    onRemoveStep,
    onEditStepParams,
  }: Props = $props();

  type StepRow = Extract<GraphRow, { kind: "step" }>;

  const graph = $derived(layoutNodeGraph(orch, tools, railShown));

  // The commit graph's own dots (GitGraphRow): a filled one on a commit,
  // a larger hollow one on HEAD. A rail's head is the hollow one here.
  const DOT_R = 3.5;
  const HEAD_R = 4.5;

  function colour(n: number): string {
    return `var(--lane-${n})`;
  }

  function rowKey(r: GraphRow): string {
    return r.kind === "rail" ? `rail:${r.railId}` : `step:${r.stepId}`;
  }

  function runOf(stepId: string) {
    return orch.stepRuns.find((r) => r.stepId === stepId) ?? null;
  }

  function toolOf(r: StepRow): Tool | undefined {
    return r.step.toolId ? findTool(tools, r.step.toolId) : undefined;
  }

  /// The chip's own title rule: a tool's name, a deleted tool's id, a
  /// card's title, a card the tree has not resolved by its file name.
  function titleOf(r: StepRow): string {
    const { toolId, cardPath } = r.step;
    if (toolId) return toolOf(r)?.name ?? toolId;
    return cards.get(cardPath)?.plan.title ?? cardPath.split("/").pop() ?? cardPath;
  }

  /// What the row is, in the bubble: the kind it draws its glyph for,
  /// then the overrides a tool step carries (the strip shows them
  /// inline; a row has no room), then a stall's reason.
  function tipOf(r: StepRow): string {
    const tool = toolOf(r);
    const parts: string[] = [];
    if (tool) parts.push(toolKindLabel(tool.kind));
    else if (r.step.toolId) parts.push("tool no longer in the library");
    else parts.push(cards.get(r.step.cardPath)?.plan.kind ?? "card");
    if (tool) {
      const overrides = describeOverrides(tool, stepParams(r.step));
      if (overrides) parts.push(overrides);
    }
    const run = runOf(r.stepId);
    if (run?.state === "stalled" && run.reason) parts.push(`stalled: ${run.reason}`);
    return parts.join(" · ");
  }

  /// Every action the strip's chip offers as buttons, folded into one
  /// menu: a row is one line of text and cannot carry a row of them.
  function openStepMenu(r: StepRow, e: MouseEvent): void {
    const state = stepStateOf(orch, r.stepId);
    const tool = toolOf(r);
    const entries: ContextMenuEntry[] = [];
    if (!r.step.toolId) entries.push({ label: "Open card", onPick: () => onOpenCard(r.step.cardPath) });
    if (tool && tool.params.length > 0) {
      entries.push({ label: "Tool parameters…", onPick: () => onEditStepParams(r.stepId) });
    }
    if (state === "stalled") entries.push({ label: "Retry", onPick: () => onRetryStep(r.stepId) });
    if (state === "running" || state === "stalled") {
      entries.push({ label: "Mark done", onPick: () => onMarkStepDone(r.stepId) });
      entries.push({ label: "Skip and proceed", onPick: () => onSkipStep(r.stepId) });
    }
    entries.push({ label: "Remove from rail", onPick: () => onRemoveStep(r.stepId) });
    openContextMenuFromEvent(e, entries);
  }

  /// A press on a row: a card opens, exactly as a click on the strip's
  /// card does; a tool with parameters opens them; a tool with nothing
  /// to open offers its menu, so no press ever does nothing.
  function activate(r: StepRow, e: MouseEvent): void {
    if (!r.step.toolId) {
      onOpenCard(r.step.cardPath);
      return;
    }
    const tool = toolOf(r);
    if (tool && tool.params.length > 0) onEditStepParams(r.stepId);
    else openStepMenu(r, e);
  }

  /// Right-click: a card row gets the board's own card menu -- move to a
  /// column, run, delete -- because it IS that card; everything else
  /// gets the step menu.
  function contextMenu(r: StepRow, e: MouseEvent): void {
    e.preventDefault();
    const placed = r.step.toolId ? undefined : placedCards.get(r.step.cardPath);
    if (placed) onCardContextMenu(placed.view, e);
    else openStepMenu(r, e);
  }

  function onKey(r: StepRow, e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(r, new MouseEvent("click", { clientX: 0, clientY: 0 }));
  }
</script>

<div class="graph">
  {#if graph.rows.length === 0}
    <p class="empty">
      {filtering
        ? "No rail matches this search."
        : "No rails yet. A rail is a column of stages over your cards — add one, then add steps to it."}
    </p>
  {:else}
    <div class="rows" style:--gutter="{graph.width}px">
      {#each graph.rows as r (rowKey(r))}
        {#if r.kind === "rail"}
          {@const railState = railStateOf(orch, r.railId)}
          {@const attention = railAttention(r.rail, attentions)}
          <!-- The rail's head: its name as the chip a branch ref is on
               its tip commit, in the lane's colour and always beside it,
               then the rail's state and the one control a reader wants
               here. The trigger is the chip's own words: a wait drawn
               quietly, a condition that can never fire as a warning. -->
          <div class="row head" style:--rail-colour={colour(r.colour)}>
            <span class="rail-chip">{r.rail.name}</span>
            <StatusBadge indicator={railIndicator(railState)} text={railState} />
            {#if attention}
              <StatusBadge
                indicator={attentionIndicator(attention)}
                text="needs you"
                tip={attentionTip(attention, doneColumnName ?? "the done column")}
              />
            {/if}
            {#if r.note}
              <span class="note" class:warn={r.note.warn} use:tooltip={r.note.tip ?? ""}>{r.note.text}</span>
            {/if}
            <span class="spacer"></span>
            {#if railState === "running"}
              <IconButton icon={Pause} label="Pause" size={12} onclick={() => onPause(r.railId)} />
            {:else}
              <IconButton
                icon={Play}
                label={railState === "paused" ? "Resume" : "Start"}
                tone="accent"
                size={12}
                onclick={() => onStart(r.railId)}
              />
            {/if}
          </div>
        {:else}
          {@const entry = cards.get(r.step.cardPath)}
          {@const tool = toolOf(r)}
          {@const Icon = stepIcon(entry?.plan.kind, r.step.toolId, tool)}
          {@const state = stepStateOf(orch, r.stepId)}
          {@const run = runOf(r.stepId)}
          {@const attention = attentions.get(r.stepId) ?? null}
          {@const severity = severityForStep(numbered, r.stepId)}
          <!-- One line: the step's glyph and title, the group it is in
               (named once, on the group's first row -- the band the rows
               share says the rest), then what the strip's chip says in
               badges. Run state is the badge and conflict severity the
               fill, as on the chip; the rail's colour stays in the
               gutter, on the dot and the line. -->
          <div
            class="row step {state}"
            class:grouped={r.group !== null}
            class:group-first={r.group?.first === true}
            class:group-last={r.group?.last === true}
            class:sev-live={severity === "live"}
            class:sev-potential={severity === "potential"}
            class:hit={filtering && stepLit(r.stepId)}
            class:dimmed={filtering && !stepLit(r.stepId)}
            role="button"
            tabindex="0"
            use:tooltip={tipOf(r)}
            onclick={(e) => activate(r, e)}
            onkeydown={(e) => onKey(r, e)}
            oncontextmenu={(e) => contextMenu(r, e)}
          >
            <Icon size={12} />
            <span class="title" class:tool={Boolean(r.step.toolId)}>{titleOf(r)}</span>
            {#if r.group?.first}
              <span class="group-chip {r.group.mode}">{r.group.mode} · {r.group.label}</span>
            {/if}
            {#if r.note}
              <span class="note" class:warn={r.note.warn} use:tooltip={r.note.tip ?? r.note.text}>{r.note.text}</span>
            {/if}
            {#if entry && !r.step.toolId && entry.plan.checklistTotal > 0}
              <span class="meta">{entry.plan.checklistDone}/{entry.plan.checklistTotal}</span>
            {/if}
            {#each numbersForStep(numbered, r.stepId) as n (n)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="badge"
                class:lit={$highlightedConflict === n}
                onmouseenter={() => highlightedConflict.set(n)}
                onmouseleave={() => highlightedConflict.set(null)}
              >{n}</span>
            {/each}
            {#if attention}
              <StatusBadge
                indicator={attentionIndicator(attention)}
                size={12}
                tip={attentionTip(attention, doneColumnName ?? "the done column")}
              />
            {/if}
            <StatusBadge
              indicator={stepIndicator(state)}
              size={12}
              tip={state === "stalled" && run?.reason ? `Step · stalled: ${run.reason}` : undefined}
            />
            <IconButton
              icon={Ellipsis}
              label="Step actions…"
              size={12}
              class="menu"
              onclick={(e) => {
                e.stopPropagation();
                openStepMenu(r, e);
              }}
            />
          </div>
        {/if}
      {/each}

      <!-- One SVG over the gutter for every row: the lines first, then
           the dots on top of them. `style:stroke`, not a stroke
           attribute: a presentation attribute does not resolve var(), a
           style property does (GitGraphRow draws its lanes the same
           way). Takes no pointer, so the rows beneath stay pressable. -->
      <svg class="lanes" width={graph.width} height={graph.height} aria-hidden="true">
        {#each graph.edges as edge (edge.id)}
          <path class="edge {edge.kind}" class:dashed={edge.dashed} d={edge.d} style:stroke={colour(edge.colour)} />
          {#if edge.arrow}
            <polygon points={edge.arrow} style:fill={colour(edge.colour)} />
          {/if}
        {/each}
        {#each graph.rows as r (rowKey(r))}
          {#if r.kind === "rail"}
            <circle
              cx={laneX(r.lane)}
              cy={rowY(r.row)}
              r={HEAD_R}
              style:fill="var(--surface-base)"
              style:stroke={colour(r.colour)}
              stroke-width="2"
            />
          {:else}
            <circle
              class="dot"
              class:dimmed={filtering && !stepLit(r.stepId)}
              cx={laneX(r.lane)}
              cy={rowY(r.row)}
              r={DOT_R}
              style:fill={colour(r.colour)}
              style:stroke={colour(r.colour)}
              stroke-width="2"
            />
          {/if}
        {/each}
      </svg>
    </div>
  {/if}
</div>

<style>
  /* The graph scrolls inside the row it shares with the drawer: a list
     of rows, tall rather than wide, the commit graph's own shape. */
  .graph {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 8px 0;
    font-family: monospace;
  }
  .empty {
    margin: 0;
    padding: 4px 12px;
    color: var(--text-muted);
    font-size: 13px;
    font-family: inherit;
    max-width: 380px;
  }
  /* The rows flow; the gutter's SVG is laid over their left edge, which
     `--gutter` (the SVG's width) keeps clear of text. */
  .rows {
    position: relative;
  }
  .lanes {
    position: absolute;
    top: 0;
    left: 8px;
    pointer-events: none;
    overflow: visible;
  }
  .edge {
    fill: none;
    stroke-width: 2;
  }
  .edge.dashed {
    stroke-dasharray: 4 3;
  }
  .dot.dimmed {
    opacity: 0.32;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    box-sizing: border-box;
    padding: 0 8px 0 calc(var(--gutter) + 14px);
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
  }
  .row.step {
    cursor: pointer;
    user-select: none;
  }
  .row.step:hover {
    background: var(--surface-hover);
  }
  .row.step:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .row :global(svg) {
    flex: none;
  }
  /* The branch chip on a tip commit (GitGraphRow's .chip.local.head),
     in the lane's colour: the one word that says which rail this is,
     wearing the colour so the colour is never read on its own. */
  .rail-chip {
    border: 1px solid var(--rail-colour);
    border-radius: 8px;
    padding: 0 6px;
    line-height: 1.4;
    font-size: 11px;
    font-weight: 700;
    color: var(--rail-colour);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A tool is a different KIND of thing from a card; the chip says so
     with a dashed border, and a line of text says so in the muted
     voice a command has next to a card's title. */
  .title.tool {
    color: var(--text-muted);
  }
  /* The group's name, once, on its first row -- a chip like a ref's. A
     fork already draws "parallel"; this is what draws "sequence", so
     the two modes wear different tones of border rather than the same
     grey. */
  .group-chip {
    flex: none;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 0 6px;
    line-height: 1.4;
    font-size: 10px;
    color: var(--text-muted);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .group-chip.sequence {
    border-style: solid;
  }
  .group-chip.parallel {
    border-style: double;
  }
  /* The band the strip draws round a group, as a tint the group's rows
     share, ending on its first and last row. */
  .row.grouped {
    background: var(--surface-overlay);
  }
  .row.step.grouped:hover {
    background: var(--surface-hover);
  }
  .row.group-first {
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
  }
  .row.group-last {
    border-bottom-left-radius: 6px;
    border-bottom-right-radius: 6px;
  }
  /* What a start-rail step could not draw as an arrow, or a rail's
     trigger: inline, truncating before the title does, its full
     sentence in the bubble. */
  .note {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
    color: var(--text-subtle);
  }
  .note.warn {
    color: var(--warning-text);
  }
  .meta {
    flex: none;
    color: var(--text-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .row.hit {
    box-shadow: inset 0 0 0 1px var(--border-accent);
  }
  .row.dimmed {
    opacity: 0.32;
  }
  .row.done,
  .row.skipped {
    color: var(--text-muted);
  }
  /* Severity owns the fill, as on the chip (spec O9); a stall keeps
     its danger fill under either. */
  .row.stalled {
    background: var(--surface-danger);
  }
  .row.sev-potential:not(.stalled) {
    background: var(--surface-warning);
  }
  .row.sev-live:not(.stalled) {
    background: var(--surface-danger);
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
  /* The menu shows itself on the row it belongs to, the way the strip's
     buttons only crowd the chip they are on. Right-click reaches it
     regardless. */
  .row :global(.menu) {
    opacity: 0;
    margin-left: 2px;
  }
  .row:hover :global(.menu),
  .row:focus-within :global(.menu) {
    opacity: 1;
  }
</style>
