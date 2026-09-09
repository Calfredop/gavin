<script lang="ts">
  import {
    Play,
    Pause,
    RotateCcw,
    Trash2,
    Plus,
    Sparkles,
    SquareStack,
    BrushCleaning,
    GripVertical,
    Ellipsis,
    LifeBuoy,
    FolderGit2,
    GitBranch,
    PanelsTopLeft,
    Zap,
  } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { resumeNoteFor } from "$lib/autoResume";
  import { resumeTrail } from "$lib/autoResumeState";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { tooltip } from "$lib/tooltip";
  import {
    agentQueuedIndicator,
    attentionIndicator,
    queuedBadgeText,
    railIndicator,
    railRetryIndicator,
  } from "$lib/ui/indicators";
  import { launchGateVerdict } from "$lib/launchQueue";
  import OrchestrationStepChip from "$lib/orchestration/OrchestrationStepChip.svelte";
  import OrchestrationStepCard from "$lib/orchestration/OrchestrationStepCard.svelte";
  import type { Label } from "$lib/board/kanban";
  import type { CardView, PlacedCardView } from "$lib/planBoard";
  import type {
    CardEntry,
    NumberedConflict,
    Orchestration,
    Rail,
    Stage,
    StageMode,
    Step,
    StepAttention,
    StepState,
  } from "$lib/orchestration/orchestration";
  import {
    stepParams,
    attentionTip,
    railAttention,
    railTriggerVerdict,
    runningStageId,
  } from "$lib/orchestration/orchestration";
  import { railRetryLabel } from "$lib/orchestration/orchestrationLoop";
  import { prChips } from "$lib/git/pullRequest";
  import { prPollTick, prReportFor, prReports, requestPr } from "$lib/git/prState";
  import { findTool } from "$lib/orchestration/orchestrationTools";
  import type { OrchestrationAgentAction } from "$lib/orchestration/orchestrationAgent";
  import type { Tool } from "$lib/orchestration/orchestrationTools";
  import {
    railStateOf,
    stepStateOf,
    numbersForStep,
    numbersForRail,
    railCardPaths,
    railDoneStepIds,
    severityForStep,
    severityForRail,
    stageMode,
    isGroup,
    stageLabel,
  } from "$lib/orchestration/orchestration";
  import { highlightedConflict } from "$lib/orchestration/orchestrationState";
  import { orchDragState } from "$lib/orchestration/orchestrationDrag";
  import { openContextMenuFromEvent } from "$lib/contextMenu";
  import { railBindChip, type RailBindChip, type RailBindTab } from "$lib/orchestration/railBind";

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
    /// The rail's consent to resuming its own broken steps, and the
    /// switch that gives it. Part of the PLAN, not a per-viewer
    /// preference -- so it rides the same save every other rail edit
    /// does.
    onToggleAutoResume: (autoResume: boolean) => void;
    /// Why this daemon cannot carry that consent, or null. A v21 daemon
    /// drops the budget field, which would turn one attempt into a loop.
    autoResumeBlocked?: string | null;
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
    /// The checkout this rail's work happens in (`conflictCheckout`), or
    /// null in a rootless workspace. Passed rather than derived here so
    /// the header and the scheduler cannot disagree about which
    /// directory a `gh` runs in.
    checkout: string | null;
    /// Opens the bind dialog on ONE of its three tabs. The header shows
    /// all three bindings as chips, and a chip that opened the dialog at
    /// the top of a list the reader then has to find is a link that only
    /// half arrives.
    onBind: (tab: RailBindTab) => void;
    /// Hand THIS rail to an agent of its own (the header's wand). Scoped
    /// on purpose: the tab header's Organize button is about the cards
    /// nobody placed, this one is about the arrangement of one rail.
    onReorganize: () => void;
    /// What pressing the wand does right now (orchestrationAgent.ts).
    /// `jump` while ANY orchestration agent is running -- the slot is the
    /// workspace's, not this rail's, because both requests rewrite the
    /// whole plan -- and the tip says which run is holding it.
    reorganize: OrchestrationAgentAction;
    onAddStep: () => void;
    onRetryStep: (stepId: string) => void;
    onMarkStepDone: (stepId: string) => void;
    /// Sends the rail past a step without claiming its work happened, and
    /// un-pauses the rail so it actually proceeds (see skipStep).
    onSkipStep: (stepId: string) => void;
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
    /// A group's own controls. The parent owns persistence; this
    /// component only says which stage and what to.
    onSetStageMode: (stageId: string, mode: StageMode) => void;
    onRenameStage: (stageId: string, name: string | null) => void;
    onUngroupStage: (stageId: string) => void;
    onSaveStageAsTemplate: (stageId: string) => void;
    /// Why this daemon cannot carry groups, or null. A daemon older than
    /// v15 has no `mode` column: it accepts a sequential group and hands
    /// it back parallel, so the group would silently run its members at
    /// once in one checkout. The header still renders -- the human should
    /// see the group they built -- but its controls are inert with the
    /// reason on hover.
    groupsBlocked: string | null;
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
    checkout,
    editing,
    onStartEdit,
    onRename,
    onCancelEdit,
    onStart,
    onPause,
    onReset,
    onToggleAutoResume,
    autoResumeBlocked = null,
    onDelete,
    onMoveAll,
    onClearDone,
    onBind,
    onReorganize,
    reorganize,
    onAddStep,
    onRetryStep,
    onMarkStepDone,
    onSkipStep,
    onRemoveStep,
    onEditStepParams,
    onOpenCard,
    onRunCard,
    onSendCardToAgent,
    agentAvailable,
    onCardContextMenu,
    onSetStageMode,
    onRenameStage,
    onUngroupStage,
    onSaveStageAsTemplate,
    groupsBlocked,
    filtering = false,
    stepLit = () => false,
  }: Props = $props();

  const railState = $derived(railStateOf(orch, rail.id));

  /// Whether this step is one the rail would have launched by now and
  /// the launch wall is holding.
  ///
  /// The STAGE matters: only the beat the rail is actually on is being
  /// held. A pending step three stages away is waiting on the rail, and
  /// marking it "held" would blame memory for the rail's own order.
  function heldStep(stageId: string, state: StepState): boolean {
    return (
      state === "pending" &&
      !$launchGateVerdict.allowed &&
      runningStageId(orch, rail.id) === stageId
    );
  }
  // The rail's most urgent step mark, so a hub full of rails says which
  // one needs you without the human reading every stage.
  const attention = $derived(railAttention(rail, attentions));
  const attentionTitle = $derived(
    attention ? attentionTip(attention, doneColumnName ?? "the done column") : ""
  );
  // "retry 2 of 5" while an `until` step is sending the rail back over
  // the step before it. Null the rest of the time, which is almost
  // always -- a loop is a state a rail passes through, not one it sits
  // in, and a badge that were always there would say nothing.
  const retrying = $derived(railRetryLabel(rail, orch, tools));
  // What GitHub says about this rail's branch, off the ONE poll a `pr`
  // step's verdict also comes from (pullRequest.ts). Read-only, and
  // deliberately so: merging is the human's action, so nothing on this
  // row is a button that acts -- the chips only link out.
  //
  // `prPollTick` is read for its effect on this effect's DEPENDENCIES
  // rather than for its value: it emits on every sweep, so the interest
  // below is renewed even when nothing about the pull request has
  // changed. Without that, a settled PR's chips would expire off the
  // header while the human was still reading them.
  $effect(() => {
    void $prPollTick;
    requestPr(checkout, rail.branch);
  });
  const prReport = $derived(prReportFor($prReports, checkout, rail.branch));
  // The clock is read here rather than held, because the only thing that
  // uses it is the "checked 2m ago" tooltip, and this recomputes on every
  // poll -- which is exactly when that age changes.
  const prRow = $derived(prChips(prReport, Math.floor(Date.now() / 1000)));
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

  /// The rail's four settings, each its own chip and each its own way
  /// into the dialog. One button showing a full worktree path and a page
  /// name said what two of them were and offered no way to say WHICH one
  /// you meant to change -- and never mentioned that the branch and the
  /// page were the same dialog away.
  const bindWorktree = $derived(railBindChip("worktree", rail, pageName));
  const bindBranch = $derived(railBindChip("branch", rail, pageName));
  const bindPage = $derived(railBindChip("page", rail, pageName));

  /// The trigger's chip carries a LIVE tooltip the other three do not
  /// need: its value ("after all rails") is the same words whether the
  /// condition is one step from firing, waiting on four rails, or naming
  /// one that no longer exists. So the static chip supplies the value and
  /// the verdict supplies the sentence -- and a condition that can never
  /// fire is drawn as a warning, because only a human ever clears one.
  const triggerVerdict = $derived(railTriggerVerdict(orch, rail));
  const bindTrigger = $derived.by((): RailBindChip => {
    const chip = railBindChip("trigger", rail, pageName);
    if (triggerVerdict.kind === "broken") {
      return { ...chip, tip: `This trigger cannot fire: ${triggerVerdict.reason}.`, warn: true };
    }
    if (triggerVerdict.kind === "wait") {
      return { ...chip, tip: `${chip.tip} Right now: ${triggerVerdict.reason}.` };
    }
    return chip;
  });
  const BIND_ICONS = {
    worktree: FolderGit2,
    branch: GitBranch,
    page: PanelsTopLeft,
    trigger: Zap,
  };

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

  /// The "gavin resumed this run by itself" line for a step, or null.
  ///
  /// Silent for either LOOPING kind, and that exception is load-bearing:
  /// a loop's budget is counted in the same `resumeAttempts` field (see
  /// orchestrationLoop.ts), so a check that went round twice would
  /// otherwise claim its agent broke and was resumed — which nothing
  /// about it is true of. The in-memory trail is keyed by step too, but
  /// only auto-resume ever writes it, so dropping both here is the whole
  /// of the fix.
  function resumeNoteOf(step: Step) {
    const kind = step.toolId ? findTool(tools, step.toolId)?.kind : undefined;
    if (kind === "until" || kind === "pr") return null;
    return resumeNoteFor($resumeTrail[step.id], runOf(step.id)?.resumeAttempts);
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

  // The group being renamed, and its in-progress text -- one stage at a
  // time, the same shape the rail's own name edit uses.
  let renamingStage = $state<string | null>(null);
  let groupDraft = $state("");

  function startGroupRename(stage: Stage): void {
    renamingStage = stage.id;
    groupDraft = stage.name ?? "";
  }

  function commitGroupName(stageId: string): void {
    // "" becomes null, not "" -- an empty name must fall back to the
    // positional label the header renders (stageMode's own doc: absent
    // reads as the default), and a literal empty string would instead
    // render as a blank button.
    const name = groupDraft.trim();
    onRenameStage(stageId, name || null);
    renamingStage = null;
  }

  /// Save-as-template is disabled when the group carries no TOOL steps: a
  /// template stores tool steps only (grouping spec G7), so there would
  /// be nothing to save and a silent no-op is worse than a dead item that
  /// says why. openContextMenuFromEvent's entries have no separate hint
  /// field, so the reason goes straight into the label.
  function openGroupMenu(stage: Stage, e: MouseEvent): void {
    const toolSteps = stage.steps.filter((s) => Boolean(s.toolId)).length;
    openContextMenuFromEvent(e, [
      {
        label: toolSteps === 0 ? "Save as template… — no tool steps" : "Save as template…",
        disabled: toolSteps === 0,
        onPick: () => onSaveStageAsTemplate(stage.id),
      },
      { label: "Ungroup", onPick: () => onUngroupStage(stage.id) },
    ]);
  }
</script>

<!-- One shape for all three bindings, so a chip cannot drift into saying
     its fact differently from its neighbours: icon, current value, the
     tooltip that explains what the default does, and the tab it opens. -->
{#snippet bindChip(chip: RailBindChip)}
  {@const Icon = BIND_ICONS[chip.tab]}
  <button
    type="button"
    class="bind-chip"
    class:unset={!chip.bound}
    class:bind-warn={chip.warn === true}
    use:tooltip={chip.tip}
    onclick={() => onBind(chip.tab)}
  >
    <Icon size={11} />
    <span>{chip.value}</span>
  </button>
{/snippet}

<div class="rail" data-orch-rail={rail.id}>
  <header>
    <!-- Two rows on purpose. A rail is a 280px grid column once the human
         has a handful of them, and one row holding the name, the state
         word and six icon buttons left the name ellipsised down to a few
         characters -- the one thing that says WHICH rail you are reading.
         Row one is the name and what qualifies it (conflicts, state,
         attention); row two is every action. -->
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
      <StatusBadge indicator={railIndicator(railState)} text={railState} />
      <!-- After the state, not instead of it: a rail with a step waiting
           on a human is still running, and saying otherwise here would
           contradict the Pause button right beside it. Same badge the
           step and its chip use for the same fact, one level down. -->
      {#if attention}
        <StatusBadge
          indicator={attentionIndicator(attention)}
          text="needs you"
          tip={attentionTitle}
        />
      {/if}
      <!-- The launch wall, beside the state and never instead of it: a
           held rail is still running, it simply has no slot for its next
           step. A rail is NOT queued -- the scheduler is its queue -- so
           this is a readout, not a cancellable intent, and the badge
           carries the gate's own sentence in its bubble. -->
      {#if railState === "running" && !$launchGateVerdict.allowed}
        <StatusBadge
          indicator={agentQueuedIndicator($launchGateVerdict.reason ?? "ceiling", $launchGateVerdict.why)}
          text={queuedBadgeText($launchGateVerdict.reason ?? "ceiling")}
        />
      {/if}
      <!-- Beside the state, not instead of it, for the same reason the
           attention badge is: the rail is still running. This says which
           DIRECTION -- backwards, over work it has already done once. -->
      {#if retrying}
        <StatusBadge
          indicator={railRetryIndicator()}
          text={retrying}
          tip="Something this rail waits on did not pass — a CI check, or a reviewer — so the step before it is running again ({retrying})"
        />
      {/if}
    </div>
    <div class="action-row">
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
      <IconButton
        icon={Sparkles}
        label={reorganize.kind === "jump" ? "Jump to the running agent" : "Reorganize with agent"}
        tip={reorganize.tip}
        tone={reorganize.kind === "jump" ? "accent" : "default"}
        disabled={reorganize.kind === "blocked"}
        onclick={onReorganize}
      />
      <IconButton icon={RotateCcw} label="Reset run state" onclick={onReset} />
      <!-- Consent, given in advance and per rail. Default off: a rail
           that resumes itself six hours after you walked away made a
           decision that was yours unless you made it here first. -->
      <!-- The reason hangs on the SPAN, not the button. A disabled
           element dispatches no mouseenter, so a tooltip bound to it can
           never explain why it is disabled -- which is the one moment
           the explanation is worth having. -->
      <span use:tooltip={autoResumeBlocked ?? ""}>
        <IconButton
          icon={LifeBuoy}
          label={rail.autoResume ? "Auto-resume: on" : "Auto-resume: off"}
          tip={autoResumeBlocked ??
            (rail.autoResume
              ? "This rail reopens a step's own conversation once when its agent breaks — never after a login prompt, a usage limit or a crash. Click to turn off."
              : "Let this rail reopen a broken step's conversation once, without asking. Click to turn on.")}
          tone={rail.autoResume ? "accent" : "default"}
          active={rail.autoResume === true}
          disabled={autoResumeBlocked !== null}
          onclick={() => onToggleAutoResume(!rail.autoResume)}
        />
      </span>
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
    <div class="bindings">
      <!-- The branch rides on the worktree's line: the two are one
           binding read together — WHICH checkout, on WHICH branch. The
           page is its own fact and gets its own line. Not "no page": an
           unbound rail is not page-less, it gets one of its own the
           moment a step of it actually launches (spec O16) — built
           around that session, which is why it waits for one rather than
           appearing at Start. -->
      <div class="bind-line">
        {@render bindChip(bindWorktree)}
        {@render bindChip(bindBranch)}
      </div>
      <div class="bind-line">
        {@render bindChip(bindPage)}
        <!-- WHEN the rail starts, beside where its sessions land. Always
             drawn, unset and all: a rail that only a human starts is the
             normal case, and a chip that appeared only once a trigger
             existed would be a feature nobody found. -->
        {@render bindChip(bindTrigger)}
      </div>
    </div>
    <!-- Only when there is something to say. A branch with no pull
         request is the resting state of most branches, and a permanent
         grey chip saying so would be noise on every rail. -->
    {#if prRow.length > 0}
      <div class="pr-row">
        {#each prRow as chip (chip.key)}
          {#if chip.href}
            <a
              class="pr-chip {chip.tone}"
              href={chip.href}
              target="_blank"
              rel="noreferrer"
              use:tooltip={chip.tip}>{chip.label}</a>
          {:else}
            <span class="pr-chip {chip.tone}" use:tooltip={chip.tip}>{chip.label}</span>
          {/if}
        {/each}
      </div>
    {/if}
    {#if !doneColumnName}
      <p class="warn">This board has no columns — nothing can complete.</p>
    {/if}
  </header>

  <!-- Everything below the header scrolls, and only this element does:
       the rail is exactly as tall as the grid, the way a kanban column
       is exactly as tall as the board. -->
  <div class="rail-body" data-orch-rail-body>
  {#each stagesShown as stage, i (stage.id)}
    {#if newStageAt === i}<div class="stage-placeholder"></div>{/if}
    {#if i > 0 && newStageAt !== i}<div class="connector"></div>{/if}
    <section
      class="stage"
      class:group={isGroup(stage)}
      class:parallel={isGroup(stage) && stageMode(stage) === "parallel"}
      class:sequence={isGroup(stage) && stageMode(stage) === "sequence"}
      class:drop-into={intoStage === stage.id}
      data-orch-stage={stage.id}
      data-orch-stage-pos={stage.position}
    >
      {#if isGroup(stage)}
        <!-- The blocked reason lives HERE, on the one element in this
             header that is never itself disabled: a disabled control
             suppresses its own hover entirely (no mouseenter, so neither
             the native title nor this repo's own tooltip action ever
             fires), which is exactly the state every child below is in
             while groupsBlocked is set. The grip/name/mode-toggle/⋯ menu
             keep their own titles for the non-blocked case (a real
             per-control hint), but the header itself is what a blocked
             human actually gets to hover. -->
        <div class="group-head" title={groupsBlocked ?? undefined}>
          <!-- The grip and the name are ONE flex item, so the toggle and
               the menu wrap to a second row as a pair exactly when the
               name's full text would otherwise be cut -- and the name
               keeps to one row regardless (its own ellipsis), rather
               than a 280px rail showing "Merge a…" beside a toggle that
               is never truncated. -->
          <div class="group-title">
            <button
              type="button"
              class="grip"
              data-orch-stage-handle={stage.id}
              disabled={Boolean(groupsBlocked)}
              title={groupsBlocked ?? "Drag to move this group"}
              aria-label="Move this group"
            >
              <GripVertical size={12} />
            </button>
            {#if renamingStage === stage.id}
              <input
                class="group-name-input"
                bind:value={groupDraft}
                use:focusAndSelect
                onblur={() => commitGroupName(stage.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") commitGroupName(stage.id);
                  if (e.key === "Escape") renamingStage = null;
                }}
              />
            {:else}
              <button
                type="button"
                class="group-name"
                disabled={Boolean(groupsBlocked)}
                title={groupsBlocked ?? "Rename this group"}
                onclick={() => startGroupRename(stage)}
              >
                {stageLabel(stage, i)}
              </button>
            {/if}
          </div>
          <div class="mode-toggle" title={groupsBlocked ?? undefined}>
            <button
              type="button"
              class:on={stageMode(stage) === "sequence"}
              aria-pressed={stageMode(stage) === "sequence" ? true : undefined}
              disabled={Boolean(groupsBlocked)}
              onclick={() => onSetStageMode(stage.id, "sequence")}>sequence</button
            >
            <button
              type="button"
              class:on={stageMode(stage) === "parallel"}
              aria-pressed={stageMode(stage) === "parallel" ? true : undefined}
              disabled={Boolean(groupsBlocked)}
              onclick={() => onSetStageMode(stage.id, "parallel")}>parallel</button
            >
          </div>
          <IconButton
            icon={Ellipsis}
            label="Group actions…"
            size={13}
            disabled={Boolean(groupsBlocked)}
            tip={groupsBlocked ?? undefined}
            onclick={(e) => openGroupMenu(stage, e)}
          />
        </div>
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
              resumeNote={resumeNoteOf(step)}
              attention={attentions.get(step.id) ?? null}
              {doneColumnName}
              badges={numbersForStep(numbered, step.id)}
              severity={severityForStep(numbered, step.id)}
              onRetry={() => onRetryStep(step.id)}
              onMarkDone={() => onMarkStepDone(step.id)}
              onSkip={() => onSkipStep(step.id)}
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
              held={heldStep(stage.id, stepStateOf(orch, step.id))}
              reason={runOf(step.id)?.reason ?? null}
              resumeNote={resumeNoteOf(step)}
              attention={attentions.get(step.id) ?? null}
              {doneColumnName}
              badges={numbersForStep(numbered, step.id)}
              severity={severityForStep(numbered, step.id)}
              onRetry={() => onRetryStep(step.id)}
              onMarkDone={() => onMarkStepDone(step.id)}
              onSkip={() => onSkipStep(step.id)}
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
</div>

<style>
  /* One column of the strip: at least 280px, growing equally with its
     siblings and never shrinking below that -- the strip scrolls
     sideways instead. Border-box, so 280px is the column's outer width,
     the way the grid track it replaces was (see the strip's own comment
     in OrchestrationHubView for why it is no longer a grid).

     Capped at 380px, because `flex-grow: 1` alone has no ceiling: two
     rails on a wide window each took half the strip, so a chip carrying
     one short title sat in a 700px column and the eye had to travel the
     width of the screen to compare two rails. A kanban column is a flat
     240px; a rail holds strictly more per row than a card does -- a
     stage band, its mode, a step's status -- so it gets a good deal
     more, and the slack past the last rail is where `.add-rail-col`
     goes. 320px was the first cap tried and read as cramped.

     The rail is stretched to the strip's height and never grows past
     it, so its own body is what scrolls -- min-height: 0 is what stops a
     tall stack of stages from pushing the column past the viewport
     instead. */
  .rail {
    flex: 1 0 280px;
    max-width: 380px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 8px;
    border-right: 1px solid var(--border);
  }
  /* Fixed by layout rather than by `position: sticky`: the header is a
     sibling of the scroller now, not a child of it, so it cannot be
     scrolled off in the first place. */
  header {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    background: var(--surface-base);
    border-bottom: 1px solid var(--border);
  }
  /* The rail's one scroll container -- the `.cards` of a kanban column.
     It carries the 8px gap the rail used to, so stage spacing is
     unchanged. */
  .rail-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* The name's row-mate, not its competitor: the actions have a row of
     their own so the name is the only thing on row one that has to give
     width, and six buttons at ~24px each still fit a 280px rail. */
  .action-row {
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
    gap: 2px;
    padding: 1px 4px;
  }
  .bind-line {
    display: flex;
    gap: 3px;
    min-width: 0;
  }
  /* Shaped like the pull-request chips two rules down, because it sits
     directly above them and says the same KIND of thing about the rail --
     the difference is that this one acts. */
  .bind-chip {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    padding: 0 5px;
    background: var(--surface-overlay);
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 10px;
    line-height: 16px;
    text-align: left;
    cursor: pointer;
  }
  .bind-chip:hover {
    background: var(--surface-hover);
    border-color: var(--border);
    color: var(--text);
  }
  /* A binding the rail does not carry is a working default, not a fault:
     quieter than a set one, and never coloured like a warning. */
  .bind-chip.unset {
    background: none;
    color: var(--text-subtle);
  }
  /* The exception, and only the trigger chip ever sets it: a condition
     that can never fire is not a default, it is a rail that will wait
     forever, and nothing but a human clears one.
     Not `.warn`: this file already has one, for the "no columns" line,
     and it sets a font-size -- which would land on the chip through a
     shared class name and make this one chip a pixel taller than the
     three beside it. */
  .bind-chip.bind-warn {
    color: var(--warning-text);
  }
  .bind-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The glyph names the binding, so it must not be the thing that gets
     clipped when the value is long. */
  .bind-chip :global(svg) {
    flex: none;
    opacity: 0.75;
  }
  /* Under the binding it qualifies, not beside the rail name: the name
     row is already the one place a 280px column has to ellipsise, and a
     pull request is a fact about the BRANCH — which is the line directly
     above this one. */
  .pr-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 5px;
  }
  .pr-chip {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text-muted);
    font-size: 10px;
    line-height: 16px;
    white-space: nowrap;
    text-decoration: none;
  }
  a.pr-chip:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  /* The app's one colour vocabulary (ui/indicators.ts): accent is
     happening now, success is finished and clean, warning wants a human,
     danger is broken. Nothing here is a bare coloured dot — every chip
     carries its own words. */
  .pr-chip.accent {
    border-color: var(--border-focus);
    color: var(--accent-text);
  }
  .pr-chip.success {
    color: var(--success-text);
  }
  .pr-chip.warning {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .pr-chip.danger {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .warn {
    margin: 0;
    font-size: 11px;
    color: var(--warning-text);
  }
  /* A single-step stage draws bare; only a GROUP gets a band and a head,
     so "these are one unit" is visible before the human reads the mode
     word underneath. */
  .stage.group {
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
  /* Wraps: the controls drop to a second row when the name needs the
     first one (the `.group-title` rule below decides when). The 4px gap
     is the row gap too. */
  .group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  /* The grip and the name as one flex item sized to the name's FULL
     text (`flex-basis: auto`, no shrink): the head's flex line then
     breaks before the toggle exactly when that text plus the controls
     overflow the rail, and never when a shorter name leaves room for
     all of it on one row. The block is capped at the head's width, so a
     name longer than the whole row still takes ONE row -- the name's
     own ellipsis cuts it there -- instead of the grip and the name
     landing on separate lines. */
  .group-title {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 0 auto;
    min-width: 0;
    max-width: 100%;
  }
  .grip {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-subtle);
  }
  .grip:not(:disabled) {
    cursor: grab;
  }
  .grip:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-muted);
  }
  .grip:disabled {
    cursor: default;
  }
  .group-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 4px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-muted);
    font-size: inherit;
    text-align: left;
    cursor: text;
  }
  .group-name:hover:not(:disabled) {
    border-color: var(--border);
    color: var(--text);
  }
  .group-name:disabled {
    cursor: default;
  }
  .group-name-input {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    background: var(--surface-sunken);
    border: 1px solid var(--border-focus);
    border-radius: 4px;
    color: var(--text);
    font-size: inherit;
  }
  /* A segmented pair, not two independent buttons: exactly one of the
     two is ever "on", so the pressed look is what says which mode this
     group actually runs in. */
  .mode-toggle {
    display: flex;
    flex: none;
    /* At the row's end on either row: the title block absorbs the free
       space on a one-row head anyway, and on a two-row head this is
       what keeps the toggle and the menu at the right edge instead of
       hanging under the grip. */
    margin-left: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .mode-toggle button {
    padding: 2px 6px;
    background: none;
    border: none;
    color: var(--text-subtle);
    font-size: inherit;
    cursor: pointer;
  }
  .mode-toggle button:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .mode-toggle button.on {
    background: var(--surface-selected);
    color: var(--text);
  }
  .mode-toggle button:disabled {
    cursor: default;
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
  /* No gap: the group hit-test (computeOrchDropTarget in
     orchestrationDrag.ts) reads any bare space between members as
     "before/after the whole group", not "this slot" -- a CSS gap here
     reproduces exactly the flicker Task 8's review called out. Every
     member already draws its own border (BoardCard's kind border, the
     tool chip's), so stacked flush they still read as separate steps in
     order -- nothing extra is needed to carry that. */
  .stage.sequence .steps {
    gap: 0;
  }
  .stage.parallel .steps {
    flex-direction: row;
    flex-wrap: wrap;
    /* Column gap only: a parallel group can still wrap onto a second
       row, and a ROW gap there would be the same bare-space bug as
       above, just on the wrap axis instead of the stack axis. */
    row-gap: 0;
    column-gap: 6px;
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
