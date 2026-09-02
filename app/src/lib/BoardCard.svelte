<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Label } from "./kanban";
  import { slugStatus, type CardView } from "./planBoard";
  import { FileText, TriangleAlert, StickyNote, Play, Route, Paperclip, ChevronRight, ChevronDown } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import {
    agentExitedIndicator,
    agentFailedIndicator,
    agentIndicator,
    agentInterruptedIndicator,
    priorityIndicator,
  } from "./ui/indicators";
  import { dragState, dropHold, buildNestedSlots } from "./kanbanDrag";
  import { kanbanState, cardSessionFor } from "./kanbanState";
  import { orchestrations } from "./orchestrationState";
  import { cardRailBadge } from "./orchestration";
  import { cardSessionState } from "./columnRunAction";
  import { boardSelection } from "./boardSelection";
  import { tooltip } from "./tooltip";
  import { layoutState, resolvedAgents } from "./layoutState";
  import { agentPromptBlocker } from "./cardRun";
  import { jumpToBoundSession } from "./cardRunActions";
  // Svelte 5 self-import for the nested-children recursion.
  import BoardCardSelf from "./BoardCard.svelte";

  interface Props {
    card: CardView;
    // The board's label vocabulary (name + color); card labels reference
    // it by slug-matched name, unknown names render plain (spec §1).
    labelDefs: Label[];
    onOpen: (path: string) => void;
    nested?: boolean;
    // Enables the session dot + Run affordance (absent in the preview).
    workspaceId?: string | null;
    onRun?: ((card: CardView) => void) | null;
    // The second run mode: hand the card to the RUNNING workspace agent.
    onSendToAgent?: ((card: CardView) => void) | null;
    agentAvailable?: boolean;
    onDelete?: ((card: CardView) => void) | null;
    onContextMenu?: ((card: CardView, e: MouseEvent) => void) | null;
    // The board column this card sits in, as a chip beside the context
    // badge. Only surfaces OFF the board pass it: on the board the column
    // is the strip the card is standing in, and repeating it on every
    // card would be noise.
    columnName?: string | null;
    // The rail glyph beside the kind one, for a card an orchestration
    // rail carries. On by default and suppressed by the rails
    // themselves: inside a rail every card is on one, so the glyph would
    // state the surface the human is already looking at.
    showRailBadge?: boolean;
    // Extra controls the surface owns, rendered as the card's last row.
    // The Orchestration rails hang a step's run state, its conflict
    // badges and its rail buttons here without this component having to
    // learn any of those words.
    adornment?: Snippet;
  }
  let {
    card,
    labelDefs,
    onOpen,
    nested = false,
    workspaceId = null,
    onRun = null,
    onSendToAgent = null,
    agentAvailable = false,
    onDelete = null,
    onContextMenu = null,
    columnName = null,
    showRailBadge = true,
    adornment,
  }: Props = $props();

  // Why this workspace's agent cannot start a card at all, or null.
  // Not about this card: the agent the workspace chose takes no prompt
  // on its command line, so a launch would hand it a prompt it reads as
  // a path and open nothing. Read reactively -- the profile table is
  // fetched asynchronously, and a card mounted before it lands would
  // otherwise keep the empty table's answer.
  const runBlocked = $derived(
    workspaceId === null
      ? null
      : agentPromptBlocker($resolvedAgents(workspaceId).promptArgs, $resolvedAgents(workspaceId).label)
  );

  // Live session binding (card-model spec §3) -- the shared agent
  // vocabulary from ui/indicators, so the badge here, the one on the
  // terminal tab and the one on the sidebar row are the same glyph in the
  // same tone. Exited is the state only a CARD can be in: the binding
  // outlives the session it points at.
  const binding = $derived(
    workspaceId !== null ? cardSessionFor($kanbanState[workspaceId], card.id) : null
  );
  const priorityBadge = $derived(priorityIndicator(card.priority));
  const sessionBadge = $derived.by(() => {
    if (!binding) return null;
    const state = cardSessionState($layoutState, binding);
    // Checked before any status: the daemon's status for an interrupted
    // session describes the bare shell that replaced the agent, so
    // reading it here would paint a working or idle badge over a run that
    // is not happening.
    if (state === "interrupted")
      return { indicator: agentInterruptedIndicator(), action: "open the card to resume it" };
    // Also before any status, and for a sharper version of the same
    // reason: a failed agent's daemon status IS `failed`, but every
    // surface used to read the two quiet seconds behind it as `idle` --
    // an idle badge over a run that broke. Open the card to resume it,
    // never jump into it.
    if (state === "failed")
      return {
        indicator: agentFailedIndicator($layoutState.failureReasonById[binding.sessionId]),
        action: "open the card to resume it",
      };
    if (state === "exited")
      return { indicator: agentExitedIndicator(), action: "open the card for Re-launch" };
    const indicator = agentIndicator($layoutState.sessionStatusById[binding.sessionId]);
    return { indicator, action: "click to open the session" };
  });

  // Which rail carries this card (orchestration spec O2). Read from the
  // store rather than passed down, exactly like the session dot: every
  // board surface renders the same membership, and a step is a REFERENCE
  // to the card, so nothing about the card itself says it.
  const railBadge = $derived(
    showRailBadge && workspaceId !== null ? cardRailBadge($orchestrations[workspaceId], card.id) : null
  );

  async function handleDotClick(): Promise<void> {
    if (workspaceId === null) return;
    // "interrupted" opens the card for the same reason "exited" does:
    // what to do about it (Resume) lives in the detail modal, and
    // jumping into the bare shell the daemon left would say the run is
    // still going.
    const result = await jumpToBoundSession(workspaceId, card.id);
    if (result === "exited" || result === "interrupted" || result === "failed") onOpen(card.id);
  }
  const runnable = $derived(card.kind !== "note" && binding === null && (onRun !== null || onSendToAgent !== null));

  // Shift+click multi-select (boardSelection.ts). Read straight from the
  // app-wide store rather than threaded down as a prop: every board
  // surface renders the same selection, and so does the drag preview.
  const selected = $derived($boardSelection.includes(card.id));

  let expanded = $state(false);

  // Auto-expand while this plan is the drag's nest target (spec §2) --
  // during the drag AND while the drop's writes are in flight.
  const slotDrag = $derived($dragState ?? $dropHold);
  const nestTargeted = $derived(card.kind === "plan" && slotDrag?.target?.nest === card.id);
  const effectiveExpanded = $derived(expanded || nestTargeted);
  const nestedSlots = $derived(
    card.kind === "plan" ? buildNestedSlots(card.nestedChildren, (c) => c.id, slotDrag, card.id) : []
  );

  // Count only, from the parsed frontmatter alone: the daemon never
  // stats these paths on scan, so the card face genuinely cannot know
  // whether any of them still resolve. Brokenness shows where the host
  // has actually looked -- the detail modal, and the run gate's refusal.
  const attachmentCount = $derived(card.attachments?.length ?? 0);

  const labelChips = $derived(
    card.labels.map((name) => ({
      name,
      color: labelDefs.find((l) => slugStatus(l.name) === slugStatus(name))?.color ?? null,
    }))
  );

  // Pointer-driven opening/dragging lives in kanbanDragGlue (click-vs-
  // drag threshold); this covers the keyboard path only.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(card.id);
    }
  }

  // The chevron short-circuits the board glue: its press must not begin
  // a drag candidate on the card.
  function shield(event: PointerEvent): void {
    event.stopPropagation();
  }
</script>

<div
  class="card kind-{card.kind}"
  class:deletable={onDelete !== null}
  class:selected
  class:nested
  class:session-working={sessionBadge?.indicator.state === "working"}
  class:session-waiting={sessionBadge?.indicator.state === "waiting_for_input"}
  class:session-idle={sessionBadge?.indicator.state === "idle"}
  class:session-interrupted={sessionBadge?.indicator.state === "interrupted"}
  class:session-failed={sessionBadge?.indicator.state === "failed"}
  role="button"
  tabindex="0"
  onkeydown={handleKeydown}
  oncontextmenu={(e) => {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(card, e);
  }}
>
  {#if onDelete}
    <button
      type="button"
      class="delete"
      aria-label="Delete card"
      use:tooltip={"Delete this card (its .md file)"}
      onpointerdown={shield}
      onclick={(e) => {
        e.stopPropagation();
        onDelete?.(card);
      }}
    >
      ×
    </button>
  {/if}
  <div class="header">
    <span
      class="glyph"
      use:tooltip={card.kind === "note"
        ? "Note — a reminder"
        : card.kind === "task"
          ? "Task — the body is an agent prompt"
          : card.checklistTotal > 0
            ? "Plan — multi-step work with a checklist"
            : "Plan — multi-step work (no checklist yet)"}
    >
      {#if card.kind === "note"}<StickyNote size={11} />{:else if card.kind === "task"}<Play
          size={11}
        />{:else}<FileText size={11} />{/if}
    </span>
    {#if railBadge}
      <span
        class="rail-glyph"
        use:tooltip={`On rail “${railBadge.railName}” — stage ${railBadge.stageNumber} of ${railBadge.stageCount}`}
      >
        <Route size={11} />
      </span>
    {/if}
    {#if priorityBadge}
      <StatusBadge indicator={priorityBadge} size={12} />
    {/if}
    {#if attachmentCount > 0}
      <span
        class="attachments"
        use:tooltip={attachmentCount === 1
          ? "1 attached file — open the card to see it"
          : `${attachmentCount} attached files — open the card to see them`}
      >
        <Paperclip size={11} />
        <span class="attachment-count">{attachmentCount}</span>
      </span>
    {/if}
    {#if card.kind === "plan" && card.checklistTotal > 0}
      <span class="progress" use:tooltip={"Checklist: " + card.checklistDone + " of " + card.checklistTotal + " done"}>{card.checklistDone}/{card.checklistTotal}</span>
    {/if}
    {#if sessionBadge}
      <button
        type="button"
        class="session-button"
        aria-label="Open the bound agent session"
        onpointerdown={shield}
        onclick={(e) => {
          e.stopPropagation();
          void handleDotClick();
        }}
      >
        <!-- The badge's own tooltip is replaced rather than suppressed:
             on this surface the state is also a control, and the bubble
             is the only place that can say so. -->
        <StatusBadge
          indicator={sessionBadge.indicator}
          size={12}
          tip={`${sessionBadge.indicator.tip} — ${sessionBadge.action}`}
        />
      </button>
    {/if}
    {#if card.parseWarning}
      <span class="warning" use:tooltip={"This card's frontmatter has issues — some fields may be unreadable"}><TriangleAlert size={11} /></span>
    {/if}
    {#if card.kind === "plan" && (card.nestedChildren.length > 0 || nestTargeted)}
      <IconButton
        icon={expanded ? ChevronDown : ChevronRight}
        label={(expanded ? "Collapse " : "Expand ") + card.nestedChildren.length + " nested " + (card.nestedChildren.length === 1 ? "task" : "tasks")}
        size={12}
        class="chevron"
        onpointerdown={shield}
        onclick={(e) => {
          e.stopPropagation();
          expanded = !expanded;
        }}
      >
        <span class="child-count">{card.nestedChildren.length}</span>
      </IconButton>
    {/if}
  </div>
  <div class="title">{card.title}</div>
  {#if card.parent && !nested}
    <span class="parent-chip" class:broken={card.parentBroken} use:tooltip={card.parentBroken ? `parent: ${card.parent} — file not found in this context` : `Part of the plan "${card.parentTitle}"`}>
      {card.parentBroken ? `⚠ ${card.parent}` : card.parentTitle}
    </span>
  {/if}
  {#if labelChips.length > 0}
    <div class="labels">
      {#each labelChips as chip (chip.name)}
        <span class="label-chip" style:border-color={chip.color}>{chip.name}</span>
      {/each}
    </div>
  {/if}
  {#if !nested}
    <div class="meta-row">
      {#if columnName}
        <span class="column-badge" use:tooltip={"Column: " + columnName}>{columnName}</span>
      {/if}
      <span class="context-badge" use:tooltip={card.id}>{card.contextName}</span>
    </div>
  {/if}
  {#if runnable}
    <!-- The block's reason hangs HERE, on the row, not on the button it
         disables: a disabled element fires no mouseenter, so a tooltip
         bound to one can never appear. The row is never disabled.
         "▶ agent" is deliberately NOT gated -- it pastes into a session
         that is already running, and builds no argv at all. -->
    <div class="run-pills" use:tooltip={runBlocked}>
      {#if onRun}
        <button
          type="button"
          class="pill pill-session"
          disabled={runBlocked !== null}
          use:tooltip={runBlocked === null
            ? "Run in a dedicated agent session, bound to this card"
            : null}
          onpointerdown={shield}
          onclick={(e) => {
            e.stopPropagation();
            if (runBlocked === null) onRun?.(card);
          }}
        >
          ▶ session
        </button>
      {/if}
      {#if onSendToAgent}
        <button
          type="button"
          class="pill pill-agent"
          disabled={!agentAvailable}
          use:tooltip={agentAvailable
            ? "Send to the running workspace agent (Home)"
            : "No workspace agent running — start it on the Home tab first"}
          onpointerdown={shield}
          onclick={(e) => {
            e.stopPropagation();
            if (agentAvailable) onSendToAgent?.(card);
          }}
        >
          ▶ agent
        </button>
      {/if}
    </div>
  {/if}
  {#if card.kind === "plan" && effectiveExpanded && nestedSlots.length > 0}
    <div class="nested-area" data-kb-nest={card.id}>
      {#each nestedSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCardSelf card={slot.item} {labelDefs} {onOpen} nested={true} {workspaceId} {onRun} {onSendToAgent} {agentAvailable} {onDelete} {onContextMenu} {showRailBadge} />
          </div>
        {:else}
          <div class="nested-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 30}px"></div>
        {/if}
      {/each}
    </div>
  {/if}
  <!-- Last, AFTER the nested children: the surface's controls act on the
       whole card, expanded plan included. Between the two, the strip
       would read as a divider cutting a plan off from its own tasks. -->
  {#if adornment}
    <div class="adornment">{@render adornment()}</div>
  {/if}
</div>

<style>
  .card {
    position: relative;
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    color: var(--text);
    font-family: monospace;
    font-size: 0.85em;
    user-select: none;
    -webkit-user-select: none;
    transition: box-shadow 120ms, border-color 120ms;
  }
  .card.kind-note {
    background: var(--surface-raised);
    border: 1px solid var(--border);
  }
  .card.kind-task {
    background: var(--surface-accent);
    border: 1px dashed var(--border-accent);
  }
  .card.kind-plan {
    background: var(--surface-success);
    border: 1px dashed var(--border-success);
  }
  .card:hover {
    border-color: var(--border-strong);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  /* A ring rather than a border swap: the kind borders (dashed task,
     dashed plan) still have to read through the selection. */
  .card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .card.selected:hover {
    box-shadow: 0 0 0 2px var(--accent), 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .card.nested {
    margin-bottom: 4px;
    padding: 6px;
    font-size: 0.95em;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  /* Keep header icons clear of the absolute delete button. */
  .card.deletable .header {
    padding-right: 18px;
  }
  .card.nested.deletable .header {
    padding-right: 14px;
  }
  .card.nested .delete {
    top: 2px;
    right: 2px;
    padding: 0 4px;
    font-size: 0.95em;
  }
  .glyph {
    display: flex;
    align-items: center;
    color: var(--success-text);
  }
  .kind-task .glyph {
    color: var(--accent-text);
  }
  .kind-note .glyph {
    color: var(--warning-text);
  }
  /* Muted, not one of the kind colours: the kind glyph beside it owns
     the card's palette (green plan, blue task, amber note), and a second
     coloured glyph would read as a second kind. This one is a fact about
     where the card SITS, like the checklist counter. */
  .rail-glyph {
    display: flex;
    align-items: center;
    color: var(--text-muted);
  }
  .card:hover .rail-glyph {
    color: var(--text);
  }
  .attachments {
    display: flex;
    align-items: center;
    gap: 1px;
    color: var(--text-muted);
  }
  .card:hover .attachments {
    color: var(--text);
  }
  .attachment-count {
    font-family: monospace;
    font-size: 0.7em;
  }
  .progress {
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .warning {
    display: flex;
    align-items: center;
    color: var(--warning-text);
    margin-left: auto;
  }
  /* Scoped ancestor first: `.chevron` reaches IconButton's own element and
     needs :global, but bare it would style every .chevron in the app (see
     PlanTree for what that costs). */
  .header :global(.chevron) {
    margin-left: auto;
  }
  .warning + :global(.chevron) {
    margin-left: 0;
  }
  .child-count {
    font-size: 0.8em;
  }
  .session-button {
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    flex: 0 0 auto;
  }
  /* The spine repeats the badge's own tone so a card can be read from
     across the board, before any glyph is legible. Amber for waiting,
     not red: red is reserved for broken and for urgent (see
     ui/indicators.ts), and an agent politely asking a question is
     neither. */
  .card.session-working {
    border-left: 3px solid var(--border-focus);
  }
  .card.session-waiting {
    border-left: 3px solid var(--border-warning);
  }
  .card.session-idle {
    border-left: 3px solid var(--border-success);
  }
  /* Warning, not success or danger: an interrupted run is neither
     finished nor failed -- it is unfinished work waiting on a decision.
     The spine only; the badge in the header carries the glyph. */
  .card.session-interrupted {
    border-left: 3px solid var(--warning);
  }
  /* Danger, where interrupted takes warning: a restart is something the
     human did, and this is something that happened TO the run. */
  .card.session-failed {
    border-left: 3px solid var(--danger);
  }
  /* In flow, not overlaid: a compact nested card has no spare room, and
     an expanded plan's pills must sit with ITS content rather than below
     its children. Always laid out, so hover changes opacity only --
     never layout. pointer-events follow visibility: an invisible run
     button must never be clickable. */
  .run-pills {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms;
  }
  .card:hover > .run-pills,
  .card:focus-within > .run-pills {
    opacity: 1;
    pointer-events: auto;
  }
  .card.nested .run-pills {
    margin-top: 4px;
    gap: 3px;
  }
  .card:hover .run-pills,
  .card:focus-within .run-pills {
    opacity: 1;
  }
  .pill {
    border-radius: 10px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.72em;
    line-height: 1.5;
    padding: 1px 8px;
    background: var(--surface-raised);
  }
  .pill-session {
    border: 1px solid var(--border-accent);
    color: var(--accent-text);
  }
  .pill-session:hover {
    background: var(--surface-accent);
  }
  .pill-agent {
    border: 1px solid var(--border-success);
    color: var(--success-text);
  }
  .pill-agent:hover:not(:disabled) {
    background: var(--surface-success);
  }
  .card.nested .pill {
    font-size: 0.66em;
    padding: 0 6px;
    line-height: 1.6;
  }
  .pill:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .delete {
    position: absolute;
    top: 3px;
    right: 3px;
    background: rgba(30, 30, 30, 0.85);
    border: none;
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1.05em;
    line-height: 1;
    padding: 1px 5px;
    opacity: 0;
    transition: opacity 120ms, color 120ms, background 120ms;
    z-index: 1;
  }
  .delete:hover {
    color: var(--danger-text);
    background: rgba(60, 30, 28, 0.95);
  }
  .card:hover .delete,
  .card:focus-within .delete {
    opacity: 1;
  }
  .title {
    word-break: break-word;
  }
  .parent-chip {
    display: inline-block;
    border: 1px solid var(--border-accent);
    border-radius: 10px;
    padding: 0 6px;
    font-size: 0.8em;
    color: var(--accent-text);
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .parent-chip.broken {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .label-chip {
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.85em;
  }
  /* The badges wrap rather than truncate the row: a long column name
     must never push the context out of sight. */
  .meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
    min-width: 0;
  }
  .context-badge {
    display: inline-block;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.8em;
    color: var(--text-muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
  /* Filled, not outlined, so it reads as the card's PLACE rather than as
     another tag: labels, the parent chip and the context badge are all
     outlined, and the column is a different kind of fact from all three. */
  .column-badge {
    display: inline-block;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 1px 6px;
    background: var(--surface-overlay);
    font-size: 0.8em;
    color: var(--text);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .adornment {
    margin-top: 6px;
  }
  .kind-plan .context-badge {
    color: var(--success-text);
    border-color: var(--border-success);
  }
  .nested-area {
    margin-top: 8px;
    padding: 6px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.25);
  }
  .nested-placeholder {
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    background: var(--surface-sunken);
    margin-bottom: 4px;
    box-sizing: border-box;
  }
</style>
