<script lang="ts">
  // The Orchestration tab's node graph: a template over
  // orchestrationNodes.ts, which decides every rectangle and every edge.
  // This file positions what it is handed, draws the edges in one SVG
  // under the nodes, and hands each press back to the hub view -- the
  // same callbacks the rail strip's chips use, so a node and a chip are
  // two pictures of one step and never two behaviours.
  //
  // No drag here, on purpose: the strip is where a plan is ARRANGED (the
  // drag engine's hit-testing is written against its columns and bands),
  // and the graph is where it is READ. The hub view attaches the engine
  // only when the strip is on screen.
  import { Ellipsis, ListOrdered, Pause, Play, Split } from "@lucide/svelte";
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
  import { layoutNodeGraph, LANE_HEAD_W, type GraphNode } from "$lib/orchestration/orchestrationNodes";

  interface Props {
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    tools: Tool[];
    /// The board's projection, for a card node's right-click menu: the
    /// same entries the board and the strip offer on that card.
    placedCards: Map<string, PlacedCardView>;
    numbered: NumberedConflict[];
    attentions: Map<string, StepAttention>;
    doneColumnName: string | null;
    /// The search lens (orchestrationSearch.ts): rails with no hit leave
    /// the graph, matching nodes light up, the rest dim.
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

  const graph = $derived(layoutNodeGraph(orch, tools, railShown));

  const MODE_ICON = { sequence: ListOrdered, parallel: Split };

  function runOf(stepId: string) {
    return orch.stepRuns.find((r) => r.stepId === stepId) ?? null;
  }

  function toolOf(node: GraphNode): Tool | undefined {
    return node.step.toolId ? findTool(tools, node.step.toolId) : undefined;
  }

  /// The chip's own title rule: a tool's name, a deleted tool's id, a
  /// card's title, a card the tree has not resolved by its file name.
  function titleOf(node: GraphNode): string {
    const { toolId, cardPath } = node.step;
    if (toolId) return toolOf(node)?.name ?? toolId;
    return cards.get(cardPath)?.plan.title ?? cardPath.split("/").pop() ?? cardPath;
  }

  /// What the node is, in the bubble: the kind it draws its glyph for,
  /// then the overrides a tool step carries (the strip shows them
  /// inline; a node has no room), then a stall's reason.
  function tipOf(node: GraphNode): string {
    const tool = toolOf(node);
    const parts: string[] = [];
    if (tool) parts.push(toolKindLabel(tool.kind));
    else if (node.step.toolId) parts.push("tool no longer in the library");
    else parts.push(cards.get(node.step.cardPath)?.plan.kind ?? "card");
    if (tool) {
      const overrides = describeOverrides(tool, stepParams(node.step));
      if (overrides) parts.push(overrides);
    }
    const run = runOf(node.stepId);
    if (run?.state === "stalled" && run.reason) parts.push(`stalled: ${run.reason}`);
    return parts.join(" · ");
  }

  /// Every action the strip's chip offers as buttons, folded into one
  /// menu: a node is a third the chip's width and cannot carry a row of
  /// them.
  function openNodeMenu(node: GraphNode, e: MouseEvent): void {
    const state = stepStateOf(orch, node.stepId);
    const tool = toolOf(node);
    const entries: ContextMenuEntry[] = [];
    if (!node.step.toolId) entries.push({ label: "Open card", onPick: () => onOpenCard(node.step.cardPath) });
    if (tool && tool.params.length > 0) {
      entries.push({ label: "Tool parameters…", onPick: () => onEditStepParams(node.stepId) });
    }
    if (state === "stalled") entries.push({ label: "Retry", onPick: () => onRetryStep(node.stepId) });
    if (state === "running" || state === "stalled") {
      entries.push({ label: "Mark done", onPick: () => onMarkStepDone(node.stepId) });
      entries.push({ label: "Skip and proceed", onPick: () => onSkipStep(node.stepId) });
    }
    entries.push({ label: "Remove from rail", onPick: () => onRemoveStep(node.stepId) });
    openContextMenuFromEvent(e, entries);
  }

  /// A press on a node: a card opens, exactly as a click on the strip's
  /// card does; a tool with parameters opens them; a tool with nothing
  /// to open offers its menu, so no press ever does nothing.
  function activate(node: GraphNode, e: MouseEvent): void {
    if (!node.step.toolId) {
      onOpenCard(node.step.cardPath);
      return;
    }
    const tool = toolOf(node);
    if (tool && tool.params.length > 0) onEditStepParams(node.stepId);
    else openNodeMenu(node, e);
  }

  /// Right-click: a card node gets the board's own card menu -- move to
  /// a column, run, delete -- because it IS that card; everything else
  /// gets the step menu.
  function contextMenu(node: GraphNode, e: MouseEvent): void {
    e.preventDefault();
    const placed = node.step.toolId ? undefined : placedCards.get(node.step.cardPath);
    if (placed) onCardContextMenu(placed.view, e);
    else openNodeMenu(node, e);
  }

  function onKey(node: GraphNode, e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(node, new MouseEvent("click", { clientX: 0, clientY: 0 }));
  }
</script>

<div class="canvas-scroll">
  {#if graph.lanes.length === 0}
    <p class="empty">
      {filtering
        ? "No rail matches this search."
        : "No rails yet. A rail is a column of stages over your cards — add one, then add steps to it."}
    </p>
  {:else}
    <div class="canvas" style:width="{graph.width}px" style:height="{graph.height}px">
      <!-- Lanes first, then groups, then the one SVG of edges, then the
           nodes: an edge runs over a group's fill and under a node, and
           the SVG takes no pointer, so a node stays pressable where an
           arrow crosses it. -->
      {#each graph.lanes as lane (lane.railId)}
        {@const railState = railStateOf(orch, lane.railId)}
        {@const attention = railAttention(lane.rail, attentions)}
        <div
          class="lane"
          style:top="{lane.y}px"
          style:height="{lane.h}px"
          style:--rail-colour="var(--lane-{lane.colour})"
        >
          <div class="lane-head" style:width="{LANE_HEAD_W}px">
            <div class="lane-name-row">
              <span class="lane-name" use:tooltip={lane.rail.name}>{lane.rail.name}</span>
              {#if railState === "running"}
                <IconButton icon={Pause} label="Pause" size={12} onclick={() => onPause(lane.railId)} />
              {:else}
                <IconButton
                  icon={Play}
                  label={railState === "paused" ? "Resume" : "Start"}
                  tone="accent"
                  size={12}
                  onclick={() => onStart(lane.railId)}
                />
              {/if}
            </div>
            <div class="lane-badges">
              <StatusBadge indicator={railIndicator(railState)} text={railState} />
              {#if attention}
                <StatusBadge
                  indicator={attentionIndicator(attention)}
                  text="needs you"
                  tip={attentionTip(attention, doneColumnName ?? "the done column")}
                />
              {/if}
            </div>
            <!-- The trigger, in the strip's chip's words. A wait draws
                 quietly and a condition that can never fire as a warning,
                 the way the chip does; the dashed arrow (when there is
                 one) says the same thing as a line. -->
            {#if lane.note}
              <span class="lane-note" class:warn={lane.note.warn} use:tooltip={lane.note.tip ?? ""}>
                {lane.note.text}
              </span>
            {/if}
          </div>
        </div>
      {/each}

      {#each graph.stages as box (box.stageId)}
        {#if box.mode}
          {@const ModeIcon = MODE_ICON[box.mode]}
          <!-- The group's box. Which mode it runs in is already in the
               geometry -- a chain or a stack -- so the head only names
               it, with the glyph the mode is recognised by: an ordered
               list, a fork. -->
          <div
            class="group {box.mode}"
            style:left="{box.x}px"
            style:top="{box.y}px"
            style:width="{box.w}px"
            style:height="{box.h}px"
          >
            <div class="group-head">
              <ModeIcon size={11} />
              <span class="group-label">{box.label}</span>
              <span class="group-mode">{box.mode}</span>
            </div>
          </div>
        {/if}
      {/each}

      <!-- `style:stroke`, not a stroke attribute: a presentation attribute
           does not resolve var(), a style property does (the commit graph
           draws its lanes the same way). -->
      <svg class="edges" width={graph.width} height={graph.height} aria-hidden="true">
        {#each graph.edges as edge (edge.id)}
          <path
            class="edge {edge.kind}"
            class:dashed={edge.dashed}
            d={edge.d}
            style:stroke="var(--lane-{edge.colour})"
          />
          {#if edge.arrow}
            <polygon points={edge.arrow} style:fill="var(--lane-{edge.colour})" />
          {/if}
        {/each}
      </svg>

      {#each graph.nodes as node (node.stepId)}
        {@const entry = cards.get(node.step.cardPath)}
        {@const tool = toolOf(node)}
        {@const Icon = stepIcon(entry?.plan.kind, node.step.toolId, tool)}
        {@const state = stepStateOf(orch, node.stepId)}
        {@const run = runOf(node.stepId)}
        {@const attention = attentions.get(node.stepId) ?? null}
        {@const severity = severityForStep(numbered, node.stepId)}
        {@const lane = graph.lanes.find((l) => l.railId === node.railId)}
        <!-- The chip's own axes, kept: run state is the ring and the
             badge, conflict severity the fill, a tool step the dashed
             border. What the node adds is the rail's colour as a bar on
             its left edge, always beside the lane that carries the same
             colour and the rail's name. -->
        <div
          class="node {state}"
          class:tool={Boolean(node.step.toolId)}
          class:sev-live={severity === "live"}
          class:sev-potential={severity === "potential"}
          class:hit={filtering && stepLit(node.stepId)}
          class:dimmed={filtering && !stepLit(node.stepId)}
          class:attention-asking={attention === "asking"}
          class:attention-ended={attention === "turn-ended"}
          role="button"
          tabindex="0"
          style:left="{node.x}px"
          style:top="{node.y}px"
          style:width="{node.w}px"
          style:height="{node.h}px"
          style:--rail-colour="var(--lane-{lane?.colour ?? 1})"
          use:tooltip={tipOf(node)}
          onclick={(e) => activate(node, e)}
          onkeydown={(e) => onKey(node, e)}
          oncontextmenu={(e) => contextMenu(node, e)}
        >
          <Icon size={13} />
          <span class="title">{titleOf(node)}</span>
          {#if node.note}
            <span class="note" class:warn={node.note.warn} use:tooltip={node.note.tip ?? node.note.text}>
              {node.note.text}
            </span>
          {/if}
          {#if entry && !node.step.toolId && entry.plan.checklistTotal > 0}
            <span class="checklist">{entry.plan.checklistDone}/{entry.plan.checklistTotal}</span>
          {/if}
          {#each numbersForStep(numbered, node.stepId) as n (n)}
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
              size={13}
              tip={attentionTip(attention, doneColumnName ?? "the done column")}
            />
          {/if}
          <StatusBadge
            indicator={stepIndicator(state)}
            size={13}
            tip={state === "stalled" && run?.reason ? `Step · stalled: ${run.reason}` : undefined}
          />
          <IconButton
            icon={Ellipsis}
            label="Step actions…"
            size={12}
            onclick={(e) => {
              e.stopPropagation();
              openNodeMenu(node, e);
            }}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The graph scrolls both ways inside the row it shares with the
     drawer. The strip only ever scrolls sideways (each rail scrolls its
     own body); a canvas of lanes has a height of its own. */
  .canvas-scroll {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  .empty {
    margin: 0;
    padding: 4px 0;
    color: var(--text-muted);
    font-size: 13px;
    max-width: 380px;
  }
  /* Everything below is placed by orchestrationNodes.ts in canvas
     pixels, so the canvas is the one positioned ancestor. */
  .canvas {
    position: relative;
  }
  .lane {
    position: absolute;
    left: 0;
    right: 0;
    box-sizing: border-box;
    background: var(--surface-sunken);
    border-radius: 8px;
    /* The rail's colour, as a stripe down the lane's edge. */
    border-left: 3px solid var(--rail-colour);
  }
  .lane-head {
    position: sticky;
    left: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 3px;
    height: 100%;
    padding: 8px 8px 8px 10px;
    justify-content: center;
    overflow: hidden;
  }
  .lane-name-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .lane-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: 13px;
    /* The same colour the stripe wears, on the one word that says which
       rail this is -- so the colour is never read on its own. */
    color: var(--rail-colour);
  }
  .lane-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .lane-note {
    font-size: 10px;
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lane-note.warn {
    color: var(--warning-text);
  }
  /* A group's box: the strip's dashed band, solid here because a dashed
     border is what a TOOL node wears and a box full of them would read
     as one more. The head names the mode the geometry already draws. */
  .group {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--surface-overlay);
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    font-size: 10px;
    color: var(--text-muted);
    min-width: 0;
  }
  .group-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-mode {
    margin-left: auto;
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .edges {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
  }
  .edge {
    fill: none;
    stroke-width: 1.5;
  }
  /* The fan is structure, not motion: thinner than the arrows it joins. */
  .edge.fan {
    stroke-width: 1;
    opacity: 0.8;
  }
  .edge.dashed {
    stroke-dasharray: 4 3;
  }
  .node {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    /* The rail's colour as a bar inside the left edge, and the run-state
       ring outside it -- two shadows, so a state rule only ever restates
       the ring and the bar survives every state. */
    --ring: transparent;
    box-shadow:
      inset 3px 0 0 var(--rail-colour),
      0 0 0 1px var(--ring);
  }
  .node:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
  .node :global(svg) {
    flex: none;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* What a start-rail step could not draw as an arrow, inline where the
     strip puts a tool step's overrides. Truncates before the title does
     and carries its full sentence in its bubble. */
  .note {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--text-subtle);
  }
  .note.warn {
    color: var(--warning-text);
  }
  .checklist {
    color: var(--text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  /* The chip's rule, unchanged: a tool is a different KIND of thing from
     a card, and dashed is how it says so. */
  .node.tool {
    border-style: dashed;
  }
  .node.hit {
    border-color: var(--border-accent);
    --ring: var(--border-accent);
  }
  .node.dimmed {
    opacity: 0.32;
  }
  .node.running {
    border-color: var(--border-focus);
    --ring: var(--border-focus);
  }
  .node.running.attention-asking,
  .node.running.attention-ended {
    border-color: var(--border-warning);
    --ring: var(--border-warning);
  }
  .node.done {
    border-color: var(--border-success);
    color: var(--text-muted);
  }
  .node.skipped {
    color: var(--text-muted);
  }
  .node.stalled {
    border-color: var(--border-danger);
    background: var(--surface-danger);
  }
  /* Severity owns the fill, run state the ring (spec O9). */
  .node.sev-potential:not(.stalled) {
    background: var(--surface-warning);
    border-color: var(--border-warning);
  }
  .node.sev-live:not(.stalled) {
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
