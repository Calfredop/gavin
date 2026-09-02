<script lang="ts">
  import { Play, Plus } from "@lucide/svelte";
  import OrchestrationRail from "./OrchestrationRail.svelte";
  import OrchestrationConflicts from "./OrchestrationConflicts.svelte";
  import OrchestrationDragPreview from "./OrchestrationDragPreview.svelte";
  import OrchestrationDrawer from "./OrchestrationDrawer.svelte";
  import RailBindDialog from "./RailBindDialog.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import { searchOrchestration } from "./orchestrationSearch";
  import ToolLibraryDialog from "./ToolLibraryDialog.svelte";
  import StepParamsDialog from "./StepParamsDialog.svelte";
  import { attachOrchestrationDrag } from "./orchestrationDragGlue";
  import Modal from "./Modal.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, refreshBoard, kanbanState, cardSessionFor } from "./kanbanState";
  import { mergePlanCards, indexCardViews, type CardView, type PlacedCardView } from "./planBoard";
  import { runCard, sendToMainAgent } from "./cardRunActions";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { buildCardMenuEntries } from "./cardMenu";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { requestedCardDetail, takeCardDetailRequest } from "./cardTabLink";
  import { layoutState, daemonCompat } from "./layoutState";
  import { featureBlockedReason } from "./daemonCompat";
  import {
    cardIndex,
    doneColumn,
    railCardsToMove,
    detectConflicts,
    numberConflicts,
    describeConflict,
    groupUnplacedByStatus,
    conflictsForRail,
    availableCards,
    nestedChildCounts,
    unfinishedCards,
    planIndex,
    stepParams,
    findStep,
    findStage,
    runnableIdleRails,
  } from "./orchestration";
  import type { Rail } from "./orchestration";
  import {
    railDeleteConfirm,
    railClearDoneConfirm,
    groupRemoveConfirm,
    runAllConfirm,
  } from "./railConfirm";
  import { findTool, toolKindLabel } from "./orchestrationTools";
  import { generateAction, generateButtonLabel, reorganizeAction } from "./orchestrationAgent";
  import { toolRecords, fetchTools, refreshTools, renderLibraryFor } from "./toolsState";
  import {
    groupTemplateRecords,
    libraryFor as templateLibraryFor,
    fetchGroupTemplates,
    saveGroupTemplateAction,
  } from "./groupTemplatesState";
  import { templateFromStage } from "./orchestrationGroups";
  import GroupTemplateSaveDialog from "./GroupTemplateSaveDialog.svelte";
  import {
    orchestrations,
    fetchOrchestration,
    refreshOrchestration,
    saveErrors,
    dismissSaveError,
    addRailAction,
    deleteRailAction,
    addStepAsStageAction,
    removeStepAction,
    startRail,
    pauseRail,
    resumeRail,
    resetRail,
    retryStep,
    markStepDone,
    makeStageSequentialAction,
    moveStepIntoStageAction,
    moveStepToNewStageAction,
    addCardAsStageAction,
    addStepToStageAction,
    requestGenerate,
    requestRailReorganize,
    revealOrchestrationAgent,
    renameRailAction,
    addToolAsStepAction,
    addToolAsStageAction,
    addToolToStageAction,
    addTemplateAsStageAction,
    addTemplateToStageAction,
    setStepParamsAction,
    moveRailCardsAction,
    clearDoneStepsAction,
    stepAttentionsByWorkspace,
    setStageModeAction,
    renameStageAction,
    moveStageToIndexAction,
    removeStageAction,
    ungroupStageAction,
  } from "./orchestrationState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const orch = $derived($orchestrations[workspaceId] ?? null);
  const board = $derived($kanbanState[workspaceId] ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const cards = $derived(cardIndex(tree));
  const doneName = $derived(board ? (doneColumn(board)?.name ?? null) : null);
  // Which running steps are waiting on a human. Read from the store
  // rather than computed here: the sidebar recap and the hub tab want the
  // same answer, and a view that only exists while it is mounted is the
  // wrong owner for it (see startScheduler).
  const attentions = $derived($stepAttentionsByWorkspace[workspaceId] ?? new Map());
  // The board's OWN projection, so a card on a rail is the very same card
  // object the kanban tab renders -- kind colours, labels, priority,
  // checklist, nesting and all -- carrying the one fact a rail has to add:
  // which column it sits in.
  const merged = $derived(board ? mergePlanCards(board, tree) : null);
  const placedCards = $derived<Map<string, PlacedCardView>>(
    merged ? indexCardViews(merged) : new Map()
  );
  const allCards = $derived<CardView[]>([...placedCards.values()].map((p) => p.view));
  const rails = $derived([...(orch?.rails ?? [])].sort((a, b) => a.position - b.position));
  // null, not [], while the refs snapshot is still loading -- unknown
  // must not read as "every worktree is gone".
  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? null);
  // Null on the same principle, for `branch-missing` (spec O15).
  const branchNames = $derived($gitStore[workspaceId]?.refs?.branches.map((b) => b.name) ?? null);
  const numbered = $derived(
    orch ? numberConflicts(detectConflicts(orch, tree, worktrees, branchNames)) : []
  );
  // renderLibraryFor, not libraryFor: while the fetch is in flight the
  // drawer shows the ten built-ins rather than an empty panel. The
  // SCHEDULER uses libraryFor, which can tell loading from empty.
  const tools = $derived(renderLibraryFor($toolRecords, workspaceId));
  // Unlike tools there is no built-in fallback to render meanwhile (see
  // groupTemplatesState's own doc): an empty Groups section for a beat,
  // while the fetch is in flight, is honest.
  const templates = $derived(templateLibraryFor($groupTemplateRecords, workspaceId) ?? []);

  // The card detail modal, opened from a tab's card-link button (and
  // from a step chip's own menu once it has one): a step is a card, and
  // the human should not have to cross to the board to read it. The
  // projection is the board's own -- same modal, same columns, same
  // nested children -- so nothing about a card reads differently here.
  let openPlanPath = $state<string | null>(null);
  const openPlan = $derived<CardView | null>(
    openPlanPath ? (allCards.find((c) => c.id === openPlanPath) ?? null) : null
  );

  $effect(() => {
    const path = takeCardDetailRequest($requestedCardDetail, workspaceId, "orchestration");
    if (path) openPlanPath = path;
  });

  let picking = $state<string | null>(null);
  let managingTools = $state(false);
  /// Which tab ToolLibraryDialog opens on -- the drawer's own "Manage
  /// tools…" and "Manage groups…" buttons share one dialog instance
  /// rather than opening a second one for the same two-scope question.
  let libraryDialogTab = $state<"tools" | "groups">("tools");
  /// The tool step whose parameters are being edited, by step id.
  let editingParamsFor = $state<string | null>(null);
  // The rail whose bindings are being edited, set by the rail header and
  // by the conflicts box's inline fix.
  let binding = $state<string | null>(null);

  // A rail's two destructive header buttons ask first, in the app's own
  // ConfirmPrompt: both take steps off the plan for good, and neither is
  // undoable. Held as {kind, railId} rather than a rail object so a plan
  // that reloads under the open prompt re-derives fresh counts (or
  // closes, if the rail went).
  let railPrompt = $state<{ kind: "delete" | "clear"; railId: string } | null>(null);
  const promptRail = $derived.by<Rail | null>(() => {
    const p = railPrompt;
    return p ? (orch?.rails.find((r) => r.id === p.railId) ?? null) : null;
  });
  const railPromptContent = $derived.by(() => {
    const p = railPrompt;
    if (!p || !promptRail || !orch) return null;
    return p.kind === "delete"
      ? railDeleteConfirm(promptRail, orch)
      : railClearDoneConfirm(promptRail, orch, cards, doneName);
  });

  // Closes the prompt BEFORE the write: a failed write is reported by
  // the save-error strip these actions already feed, and a prompt left
  // standing over it would be asking a second time.
  function confirmRailPrompt(pending: { kind: "delete" | "clear"; railId: string }): void {
    railPrompt = null;
    if (pending.kind === "delete") void deleteRailAction(workspaceId, pending.railId);
    else void clearDoneStepsAction(workspaceId, pending.railId);
  }

  // "Run all": arm every idle rail that still has a stage to start. Held
  // as a bare flag rather than a captured list of rails so a plan that
  // reloads under the open prompt re-derives what it is about to do --
  // and closes, the way the rail prompts do, if there is nothing left to
  // start by the time the human reaches the button.
  let runAllPrompt = $state(false);
  const runnableRails = $derived(orch ? runnableIdleRails(orch) : []);
  const runAllContent = $derived.by(() =>
    runAllPrompt && orch && runnableRails.length > 0 ? runAllConfirm(orch) : null
  );
  const runAllTip = $derived(
    runnableRails.length === 0
      ? "No idle rail has anything left to run"
      : `Start ${runnableRails.length} idle ${runnableRails.length === 1 ? "rail" : "rails"}…`
  );

  /// SEQUENTIALLY, never in parallel. Every run-state write reads the
  /// store, applies to that snapshot and writes the whole thing back
  /// (mutateRunState), so two starts in flight at once would both build
  /// on the same `railRuns` and the second would drop the first's row --
  /// a rail left looking idle while its steps launch. The ids are taken
  /// before the first await for the same reason: `runnableRails` is
  /// derived, and the rail it starts leaves it on the very next tick.
  async function runAll(): Promise<void> {
    const ids = runnableRails.map((r) => r.id);
    runAllPrompt = false;
    for (const id of ids) await startRail(workspaceId, id);
  }

  // The group whose "Save as template…" dialog is open, by stage id --
  // set by the rail's own ⋯ menu (Task 9), resolved to a Stage below so
  // a plan that reloads under the open dialog re-derives it fresh (or
  // closes, if the stage went some other way meanwhile).
  let savingTemplateFor = $state<string | null>(null);
  const savingTemplateStage = $derived(
    savingTemplateFor && orch ? findStage(orch, savingTemplateFor) : null
  );

  // A group dropped on the drawer takes every step it holds off the plan
  // with it, unlike every other unplace (one step) -- so it asks first,
  // by stage id rather than a whole Stage so a plan that reloads under
  // the open prompt re-derives a fresh count (or closes, if the group
  // went some other way meanwhile).
  let groupRemovePrompt = $state<string | null>(null);
  const groupRemoveContent = $derived.by(() => {
    const stageId = groupRemovePrompt;
    if (!stageId || !orch) return null;
    const stage = findStage(orch, stageId);
    return stage ? groupRemoveConfirm(stage, cards) : null;
  });

  function confirmGroupRemove(stageId: string): void {
    groupRemovePrompt = null;
    void removeStageAction(workspaceId, stageId);
  }

  // --- the card surface -------------------------------------------------
  // A card step IS a kanban card here, so this tab owns the same three
  // pieces of furniture the board does: the detail modal, the delete
  // prompt, and an error strip for writes that fail. Everything routes
  // through the same helpers, so a rail card and a board card cannot
  // drift apart.
  let openCardPath = $state<string | null>(null);
  const openCard = $derived<CardView | null>(
    openCardPath ? (placedCards.get(openCardPath)?.view ?? null) : null
  );
  let cardWriteError = $state<string | null>(null);

  const agentAvailable = $derived(Boolean(ws?.mainSessionId));

  async function handleRun(card: CardView): Promise<void> {
    cardWriteError = null;
    const err = await runCard(workspaceId, card);
    if (err) cardWriteError = err;
  }

  async function handleSendToAgent(card: CardView): Promise<void> {
    cardWriteError = null;
    const err = await sendToMainAgent(workspaceId, card);
    if (err) cardWriteError = err;
  }

  function handleCardContextMenu(card: CardView, e: MouseEvent): void {
    if (!board) return;
    openContextMenuFromEvent(
      e,
      buildCardMenuEntries(card, {
        workspaceId,
        columns: board.columns,
        openDetail: (path) => (openCardPath = path),
        requestDelete: (c) => (pendingDelete = c),
        run: (c) => void handleRun(c),
        sendToAgent: (c) => void handleSendToAgent(c),
        agentAvailable,
        reportError: (msg) => (cardWriteError = msg),
      })
    );
  }

  // The rail's own "move all": one entry per board column, each saying
  // how many of the rail's cards that pick would actually rewrite. A
  // column every card already sits in is marked and dead, exactly as a
  // card's own current column is in its menu.
  function handleMoveAll(rail: Rail, e: MouseEvent): void {
    if (!board) return;
    const columns = [...board.columns].sort((a, b) => a.position - b.position);
    openContextMenuFromEvent(
      e,
      columns.map((col) => {
        const paths = railCardsToMove(rail, cards, col.name);
        const n = paths.length;
        return {
          label:
            n === 0
              ? `All cards are in ${col.name}`
              : `Move ${n} ${n === 1 ? "card" : "cards"} to ${col.name}`,
          active: n === 0,
          disabled: n === 0,
          onPick: () => {
            void moveRailCardsAction(workspaceId, rail.id, col.name).then((err) => {
              if (err) cardWriteError = err;
            });
          },
        };
      })
    );
  }

  // Deleting a card FILE from a rail is the board's own cascade, prompt
  // and all -- the step referencing it disappears with the card, because
  // a step is only ever a reference (spec O2).
  let pendingDelete = $state<CardView | null>(null);
  const pendingPlan = $derived<DeletionPlan | null>(
    pendingDelete ? deletionPlanFor(pendingDelete, allCards) : null
  );
  const pendingDeleteLines = $derived.by(() => {
    if (!pendingDelete || !pendingPlan) return [];
    const lines = [`Deletes ${pendingDelete.fileName} permanently.`];
    const nested = pendingPlan.files.length - 1;
    if (nested > 0) lines.push(`Also deletes ${nested} nested ${nested === 1 ? "task" : "tasks"}.`);
    if (pendingPlan.unparent.length > 0)
      lines.push(
        `${pendingPlan.unparent.length} free-standing ${pendingPlan.unparent.length === 1 ? "task keeps" : "tasks keep"} their column (un-parented).`
      );
    if (pendingPlan.files.some((f) => cardSessionFor(board, f.id) !== null))
      lines.push("A bound agent session keeps running on the Agents page.");
    return lines;
  });

  async function confirmDelete(): Promise<void> {
    const plan = pendingPlan;
    pendingDelete = null;
    if (!plan) return;
    cardWriteError = null;
    const err = await executeDeletion(workspaceId, plan);
    if (err) cardWriteError = err;
  }

  // The cards a rail can take on -- see availableCards for what is left
  // out and why. The DRAWER gets this full set: it buckets by status and
  // starts the done bucket collapsed, so a finished card is reachable for
  // the rail that wants one without being in anyone's way.
  const placed = $derived(
    new Set((orch?.rails ?? []).flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.cardPath))))
  );
  const available = $derived(availableCards(cards, placed));
  // The "+ Add step" picker and Generate get the set with finished work
  // taken out -- neither has the drawer's bucket to put it in, so both
  // would otherwise offer up (and Generate would instruct an agent to
  // place) cards the scheduler marks done and cascades straight past.
  const pickable = $derived(unfinishedCards(available, planIndex(cards), board));
  // A nested child is not on offer -- its plan carries it -- so both
  // surfaces say how many each plan carries. Without it the children the
  // human wrote would have simply gone missing from the panel.
  const nestedCounts = $derived(nestedChildCounts(cards));
  const allUnplacedGroups = $derived(board ? groupUnplacedByStatus(available, board) : []);

  // The search lens (orchestrationSearch.ts): rails with no hit leave
  // the grid, matching chips light up inside the rails that stay, and
  // the drawer filters like any other list.
  let search = $state("");
  const lens = $derived(searchOrchestration(orch, cards, search));
  const unplaced = $derived(lens.filterUnplaced(allUnplacedGroups));
  const unplacedGroups = $derived(unplaced.groups);
  const shownRails = $derived(rails.filter((r) => lens.railShown(r.id)));
  // A plain boolean, not `lens.filtering`: `lens` is a fresh object on
  // every keystroke, and the drag effect below would then tear down and
  // re-attach the engine on each one. A derived primitive only notifies
  // when it actually flips.
  const filtering = $derived(lens.filtering);

  // Which rail's name is being edited. Owned here so a rail created by
  // the button below can open straight into rename mode.
  let editingRailId = $state<string | null>(null);

  async function newRail(): Promise<void> {
    editingRailId = await addRailAction(workspaceId, "New rail");
  }

  $effect(() => {
    void fetchOrchestration(workspaceId);
    void fetchBoard(workspaceId);
    // The board is no longer just the status vocabulary here: its columns
    // and labels are drawn on every card step, so a stale one shows stale
    // cards. Same refresh the kanban tab does on reveal.
    void refreshBoard(workspaceId);
    void refreshOrchestration(workspaceId);
    // Re-read on a compat change too: against a pre-v11 daemon every
    // GetTools is refused, so the library stays unfetched. Restarting
    // the daemon from the banner is exactly the moment it becomes
    // readable, and nothing else in this effect would notice.
    void $daemonCompat;
    void fetchTools(workspaceId);
    void refreshTools(workspaceId);
    void fetchGroupTemplates(workspaceId);
    if (root) {
      ensureGitView(workspaceId, root);
      void refreshGit(workspaceId);
    }
  });

  // No re-tick effect here: this component being mounted is exactly what
  // the scheduler must NOT depend on. `+page.svelte` renders one hub view
  // at a time and a terminal page renders none, so a rail driven from
  // here only advanced while this tab was on screen. The trigger lives in
  // orchestrationState's startScheduler, on the same stores, for the life
  // of the app.

  let gridEl = $state<HTMLElement | null>(null);
  // Listening happens on the row that holds BOTH the grid and the drawer,
  // so a card can be dragged from one into the other.
  let bodyEl = $state<HTMLElement | null>(null);

  // $effect, NOT onMount: the elements below live inside the loaded
  // branch, so at mount time the plan is still being fetched and both
  // binds are null. onMount would early-return and never run again --
  // the drag engine would simply never attach. KanbanBoard attaches the
  // same way for the same reason. The returned teardown runs when the
  // elements change or the tab unmounts.
  // Drag is off while the grid is filtered: rails and drawer rows leave
  // the DOM, and a new-stage index measured over what is left would drop
  // the step at the wrong position. Re-attaches the moment the box is
  // cleared. (Nothing else rides this engine here -- its click callback
  // is a no-op -- so simply not attaching is the whole lock.)
  $effect(() => {
    if (!bodyEl || !gridEl || filtering) return;
    return attachOrchestrationDrag({
      root: bodyEl,
      scrollEl: gridEl,
      commit: (drag) => {
        // `id` is a step id for a step drag, a card path for a card
        // drag, a tool id for a tool drag, and a STAGE id for a "stage"
        // drag -- one more source, the same drop-target vocabulary.
        //
        // An "into-stage" target can turn a single-step stage into a
        // group (or grow one further), which DOES need a daemon that can
        // carry `mode` (FEATURE_MIN_VERSION.groups) -- a pre-v15 daemon
        // has neither column and would silently hand the stage back
        // parallel. "template" sits on the same footing: placing one is
        // also how a group gets FORMED (a fresh one at "new-stage", or
        // an existing one grown at "into-stage") and writes `mode` either
        // way.
        //
        // A whole-stage drag ("stage") is gated too, but not because its
        // own two reachable targets write `mode` -- they don't: `unplace`
        // runs removeStage and `new-stage` runs moveStageToIndex, and a
        // v14 daemon executes either correctly. This gesture only exists
        // because groups exist, so it travels with the same gate as a
        // matter of scope, not necessity -- deliberately conservative,
        // not forced. Refusing here, before any mutator runs, keeps one
        // message regardless of which of the three: the drawer rows, the
        // header's own controls and a drag's drop all say the same thing.
        const wouldGroup =
          drag.target.kind === "into-stage" || drag.kind === "stage" || drag.kind === "template";
        if (wouldGroup && groupsBlocked) {
          saveErrors.update((e) => ({ ...e, [workspaceId]: groupsBlocked }));
          return;
        }
        if (drag.kind === "stage") {
          // Moving the whole group. `into-stage` never occurs for this
          // kind -- computeOrchDropTarget skips the stage loop outright
          // for a "stage" drag, since nested groups are out of scope --
          // so only the remaining two targets need a branch.
          if (drag.target.kind === "new-stage") {
            void moveStageToIndexAction(workspaceId, drag.id, drag.target.railId, drag.target.index);
          } else if (drag.target.kind === "unplace") {
            // Unlike every other unplace, this one takes every step the
            // group holds with it, so it asks first rather than running
            // straight through, the same discipline a rail delete uses.
            groupRemovePrompt = drag.id;
          }
          return;
        }
        if (drag.kind === "card") {
          if (drag.target.kind === "into-stage") {
            void addStepToStageAction(workspaceId, drag.target.stageId, drag.id, drag.target.index);
          } else if (drag.target.kind === "new-stage") {
            void addCardAsStageAction(workspaceId, drag.target.railId, drag.target.index, drag.id);
          }
          return;
        }
        if (drag.kind === "tool") {
          if (drag.target.kind === "into-stage") {
            void addToolToStageAction(workspaceId, drag.target.stageId, drag.id, drag.target.index);
          } else if (drag.target.kind === "new-stage") {
            void addToolAsStageAction(workspaceId, drag.target.railId, drag.target.index, drag.id);
          }
          return;
        }
        if (drag.kind === "template") {
          // `drag.id` is the template's own id, resolved against the
          // library that fed the drawer -- a template deleted mid-drag
          // (another session, the manager tab) leaves nothing to place,
          // so this quietly does nothing rather than placing a stale
          // copy.
          const template = templates.find((t) => t.id === drag.id);
          if (!template) return;
          if (drag.target.kind === "into-stage") {
            void addTemplateToStageAction(workspaceId, drag.target.stageId, drag.target.index, template);
          } else if (drag.target.kind === "new-stage") {
            void addTemplateAsStageAction(workspaceId, drag.target.railId, drag.target.index, template);
          }
          return;
        }
        if (drag.target.kind === "unplace") {
          void removeStepAction(workspaceId, drag.id);
        } else if (drag.target.kind === "into-stage") {
          void moveStepIntoStageAction(workspaceId, drag.id, drag.target.stageId, drag.target.index);
        } else {
          void moveStepToNewStageAction(workspaceId, drag.id, drag.target.railId, drag.target.index);
        }
      },
      // A press with no movement on a CARD step opens that card, exactly
      // as a click on the board does. `cardPath` is set when the press
      // landed on a card of its own -- a nested child inside an expanded
      // plan -- and that one opens as itself. A tool step has no card to
      // open, and a drawer row fires its own onclick, so both fall
      // through to nothing.
      click: (stepId, cardPath) => {
        if (cardPath) {
          openCardPath = cardPath;
          return;
        }
        const step = orch ? findStep(orch, stepId) : null;
        if (step && !step.toolId) openCardPath = step.cardPath;
      },
    });
  });

  // Every orchestration write (SetOrchestration/SetRailRun/SetStepRun) is
  // gated at protocol v10 (see protocol::min_version_for) -- against an
  // older daemon these buttons would otherwise dispatch requests the wire
  // guard in session.rs's `gate` silently refuses, with no explanation.
  // Reusing the same featureBlockedReason the banner is built from keeps
  // the wording (and the version numbers) identical wherever the app
  // names this.
  const orchestrationBlocked = $derived(featureBlockedReason($daemonCompat, "orchestration"));
  // Tools are gated a version ABOVE orchestration, so there is a real
  // daemon -- v10 -- that runs rails happily and knows nothing of tools.
  // Handed one, it stores a step with neither a card nor a tool: an
  // untitled chip, and a plan the current daemon then refuses to save.
  // Gating every surface that can place a tool is what stops that step
  // being written in the first place (dropImpossibleSteps clears up the
  // ones already stored).
  const toolsBlocked = $derived(featureBlockedReason($daemonCompat, "tools"));
  // The conflict panel's repair now WRITES a mode (Task 6) instead of
  // splitting the stage. Against a pre-groups daemon that field is
  // silently dropped -- the badge would never clear, and the human would
  // retry the same button forever with no explanation.
  const groupsBlocked = $derived(featureBlockedReason($daemonCompat, "groups"));
  const conflictSummary = $derived(
    orch
      ? numbered.map(({ n, conflict }) => `${n}. ${describeConflict(conflict, cards, orch, tools)}`)
      : []
  );

  // The workspace's one orchestration agent slot (orchestrationAgent.ts).
  // Both buttons read it: a run holding it makes every one of them a jump
  // to that run instead of a second launch, because both requests rewrite
  // the WHOLE plan and would overwrite each other.
  const agentRun = $derived(ws?.orchestrationAgent ?? null);
  const generateFor = $derived(
    generateAction({
      run: agentRun,
      // Measured over every unplaced card, never the search lens's view:
      // Generate hands the agent the real set, so a filter that happens
      // to hide them all must not claim there is nothing left to place.
      unplacedCount: pickable.length,
      hasRoot: root !== null,
      daemonBlocked: orchestrationBlocked,
    })
  );
  const reorganizeFor = $derived((railId: string) =>
    reorganizeAction({ run: agentRun, railId, hasRoot: root !== null, daemonBlocked: orchestrationBlocked })
  );

  // Both agent buttons end the same way: a session of their own is
  // spawned in the workspace root and the view jumps to it. No hop to
  // Home any more -- the request no longer lands in the main agent's
  // terminal, so Home is not where the answer appears.
  function handOff(err: string | null): void {
    if (err) saveErrors.update((e) => ({ ...e, [workspaceId]: err }));
  }

  /// The header button: the unplaced cards are the job.
  async function generate(): Promise<void> {
    handOff(await requestGenerate(workspaceId, pickable, conflictSummary));
  }

  /// A rail header's button: that one rail is the job, and it is handed
  /// only the conflicts that concern it -- its own rail-level ones plus
  /// every step-level one naming a step it holds.
  async function reorganizeRail(railId: string): Promise<void> {
    const rail = rails.find((r) => r.id === railId);
    if (!orch || !rail) return;
    const summary = conflictsForRail(numbered, rail).map(
      ({ n, conflict }) => `${n}. ${describeConflict(conflict, cards, orch, tools)}`
    );
    handOff(await requestRailReorganize(workspaceId, railId, cards, tools, summary));
  }

  /// One press, two meanings: start the run, or land in the one already
  /// going. Never a dead button -- a disabled control cannot explain
  /// itself, and "why can I not press this" is exactly the question a
  /// run holding the slot answers by showing itself.
  function pressGenerate(): void {
    if (generateFor.kind === "jump") void revealOrchestrationAgent(workspaceId);
    else if (generateFor.kind === "start") void generate();
  }

  function pressReorganize(railId: string): void {
    const action = reorganizeFor(railId);
    if (action.kind === "jump") void revealOrchestrationAgent(workspaceId);
    else if (action.kind === "start") void reorganizeRail(railId);
  }

  function onStart(railId: string): void {
    const paused = orch?.railRuns.find((r) => r.railId === railId)?.state === "paused";
    void (paused ? resumeRail(workspaceId, railId) : startRail(workspaceId, railId));
  }
</script>

<div class="view">
  <header class="bar">
    <!-- No heading: the hub's tab strip already names this view, and a
         second "Orchestration" only ate the row the search wants. -->
    <SearchInput
      bind:value={search}
      class="bar-search"
      label="Search rails and cards"
      placeholder="Search rails, steps, unplaced cards…"
    />
    {#if lens.filtering}
      <span class="summary">
        {lens.railsShown} {lens.railsShown === 1 ? "rail" : "rails"} ·
        {lens.stepsMatched} {lens.stepsMatched === 1 ? "step" : "steps"} ·
        {unplaced.shown} unplaced
      </span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="add-rail"
      disabled={generateFor.kind === "blocked"}
      title={generateFor.tip}
      onclick={pressGenerate}
    >
      {generateButtonLabel(agentRun)}
    </button>
    <button
      type="button"
      class="add-rail"
      disabled={runnableRails.length === 0}
      title={runAllTip}
      onclick={() => (runAllPrompt = true)}
    >
      <Play size={14} /> Run all
    </button>
    <button
      type="button"
      class="add-rail"
      disabled={Boolean(orchestrationBlocked)}
      title={orchestrationBlocked ?? ""}
      onclick={() => void newRail()}
    >
      <Plus size={14} /> Rail
    </button>
  </header>

  {#if $saveErrors[workspaceId]}
    <div class="save-error">
      <span>{$saveErrors[workspaceId]}</span>
      <button type="button" onclick={() => dismissSaveError(workspaceId)}>Dismiss</button>
    </div>
  {/if}

  <!-- A card write failing is a different fact from the PLAN failing to
       save, so it gets its own line rather than borrowing that one. -->
  {#if cardWriteError}
    <div class="save-error">
      <span>{cardWriteError}</span>
      <button type="button" onclick={() => (cardWriteError = null)}>Dismiss</button>
    </div>
  {/if}

  {#if orch}
    <OrchestrationConflicts
      {workspaceId}
      {numbered}
      {cards}
      {orch}
      {tools}
      {groupsBlocked}
      onBindWorktree={(railId) => (binding = railId)}
      onMakeSequential={(stageId) => void makeStageSequentialAction(workspaceId, stageId)}
    />
  {/if}

  {#if !orch}
    {#if orchestrationBlocked}
      <p class="empty">{orchestrationBlocked}</p>
    {:else}
      <p class="empty">Loading…</p>
    {/if}
  {:else if rails.length === 0}
    <p class="empty">
      No rails yet. A rail is a column of stages over your cards — add one, then add steps to it.
    </p>
  {:else}
    <div class="body" bind:this={bodyEl}>
      <div class="grid" bind:this={gridEl}>
      {#if lens.filtering && shownRails.length === 0}
        <p class="empty">No rail matches this search.</p>
      {/if}
      {#each shownRails as rail (rail.id)}
        <OrchestrationRail
          {rail}
          {orch}
          {cards}
          {tools}
          {placedCards}
          {workspaceId}
          labelDefs={board?.labels ?? []}
          doneColumnName={doneName}
          {numbered}
          {attentions}
          onStart={() => onStart(rail.id)}
          onPause={() => void pauseRail(workspaceId, rail.id)}
          onReset={() => void resetRail(workspaceId, rail.id)}
          onDelete={() => (railPrompt = { kind: "delete", railId: rail.id })}
          onMoveAll={(e) => handleMoveAll(rail, e)}
          onClearDone={() => (railPrompt = { kind: "clear", railId: rail.id })}
          pageName={ws?.pages.find((p) => p.id === rail.pageId)?.name ?? null}
          editing={editingRailId === rail.id}
          onStartEdit={() => (editingRailId = rail.id)}
          onRename={(name) => {
            void renameRailAction(workspaceId, rail.id, name);
            editingRailId = null;
          }}
          onCancelEdit={() => (editingRailId = null)}
          onBind={() => (binding = rail.id)}
          onReorganize={() => pressReorganize(rail.id)}
          reorganize={reorganizeFor(rail.id)}
          onAddStep={() => (picking = rail.id)}
          onRetryStep={(stepId) => void retryStep(workspaceId, stepId)}
          onMarkStepDone={(stepId) => void markStepDone(workspaceId, stepId)}
          onRemoveStep={(stepId) => void removeStepAction(workspaceId, stepId)}
          filtering={lens.filtering}
          stepLit={lens.stepLit}
          onEditStepParams={(stepId) => (editingParamsFor = stepId)}
          onOpenCard={(path) => (openCardPath = path)}
          onRunCard={(card) => void handleRun(card)}
          onSendCardToAgent={(card) => void handleSendToAgent(card)}
          {agentAvailable}
          onCardContextMenu={handleCardContextMenu}
          {groupsBlocked}
          onSetStageMode={(stageId, mode) => void setStageModeAction(workspaceId, stageId, mode)}
          onRenameStage={(stageId, name) => void renameStageAction(workspaceId, stageId, name)}
          onUngroupStage={(stageId) => void ungroupStageAction(workspaceId, stageId)}
          onSaveStageAsTemplate={(stageId) => (savingTemplateFor = stageId)}
        />
      {/each}
      </div>
      <OrchestrationDrawer
        groups={unplacedGroups}
        filtering={lens.filtering}
        hiddenCount={unplaced.total - unplaced.shown}
        {tools}
        {templates}
        {nestedCounts}
        targetRailId={rails[0]?.id ?? null}
        onAdd={(cardPath) => void addStepAsStageAction(workspaceId, rails[0].id, cardPath)}
        onAddTool={(toolId) => void addToolAsStepAction(workspaceId, rails[0].id, toolId)}
        onAddTemplate={(templateId) => {
          // The click-to-add path every drawer row gets: appended as its
          // own new group at this rail's end, the same "past the end"
          // append addToolAsStepAction gives a clicked tool.
          const template = templates.find((t) => t.id === templateId);
          if (template) {
            void addTemplateAsStageAction(workspaceId, rails[0].id, rails[0].stages.length, template);
          }
        }}
        onManageTools={() => {
          libraryDialogTab = "tools";
          managingTools = true;
        }}
        onManageTemplates={() => {
          libraryDialogTab = "groups";
          managingTools = true;
        }}
        {toolsBlocked}
        {groupsBlocked}
      />
    </div>
  {/if}
</div>

<OrchestrationDragPreview
  {orch}
  {cards}
  {tools}
  {templates}
  {placedCards}
  labelDefs={board?.labels ?? []}
  dragRoot={bodyEl}
/>

{#if managingTools}
  <ToolLibraryDialog
    {workspaceId}
    {tools}
    {templates}
    initialTab={libraryDialogTab}
    onClose={() => (managingTools = false)}
  />
{/if}

{#if savingTemplateFor && savingTemplateStage}
  {@const stage = savingTemplateStage}
  <GroupTemplateSaveDialog
    {stage}
    {tools}
    onSave={(name, description, scope) =>
      saveGroupTemplateAction(workspaceId, templateFromStage(stage, name, description, scope))}
    onClose={() => (savingTemplateFor = null)}
  />
{/if}

{#if editingParamsFor && orch}
  {@const step = orch.rails
    .flatMap((r) => r.stages.flatMap((s) => s.steps))
    .find((t) => t.id === editingParamsFor)}
  {@const tool = step?.toolId ? findTool(tools, step.toolId) : undefined}
  {#if step && tool}
    <StepParamsDialog
      {tool}
      params={stepParams(step)}
      onSave={(params) => void setStepParamsAction(workspaceId, step.id, params)}
      onClose={() => (editingParamsFor = null)}
    />
  {/if}
{/if}

{#if openPlan && board}
  <CardDetailModal
    card={openPlan}
    {workspaceId}
    columns={board.columns}
    labels={board.labels}
    {allCards}
    onClose={() => (openPlanPath = null)}
    onOpenCard={(path) => (openPlanPath = path)}
    onPathChange={(path) => (openPlanPath = path)}
  />
{/if}

{#if binding && orch}
  {@const bindingRail = orch.rails.find((r) => r.id === binding)}
  {#if bindingRail}
    <RailBindDialog {workspaceId} rail={bindingRail} onClose={() => (binding = null)} />
  {/if}
{/if}

{#if railPrompt && railPromptContent}
  {@const pending = railPrompt}
  <ConfirmPrompt
    title={railPromptContent.title}
    lines={railPromptContent.lines}
    choices={[
      {
        label: railPromptContent.confirmLabel,
        danger: true,
        onPick: () => void confirmRailPrompt(pending),
      },
    ]}
    onCancel={() => (railPrompt = null)}
  />
{/if}

{#if runAllContent}
  <ConfirmPrompt
    title={runAllContent.title}
    lines={runAllContent.lines}
    choices={[{ label: runAllContent.confirmLabel, onPick: () => void runAll() }]}
    onCancel={() => (runAllPrompt = false)}
  />
{/if}

{#if groupRemovePrompt && groupRemoveContent}
  {@const pendingStageId = groupRemovePrompt}
  <ConfirmPrompt
    title={groupRemoveContent.title}
    lines={groupRemoveContent.lines}
    choices={[
      {
        label: groupRemoveContent.confirmLabel,
        danger: true,
        onPick: () => confirmGroupRemove(pendingStageId),
      },
    ]}
    onCancel={() => (groupRemovePrompt = null)}
  />
{/if}

{#if pendingDelete}
  <ConfirmPrompt
    title={`Delete "${pendingDelete.title}"?`}
    lines={pendingDeleteLines}
    choices={[{ label: "Delete", danger: true, onPick: () => void confirmDelete() }]}
    onCancel={() => (pendingDelete = null)}
  />
{/if}

{#if openCard && board}
  <CardDetailModal
    card={openCard}
    {workspaceId}
    columns={board.columns}
    labels={board.labels}
    {allCards}
    onClose={() => (openCardPath = null)}
    onOpenCard={(path) => (openCardPath = path)}
  />
{/if}

{#if picking}
  {@const railId = picking}
  <Modal onClose={() => (picking = null)}>
    <div class="picker-body">
      <h3>Add a step</h3>
      <!-- Both step kinds, because the drawer's click-to-add can only
           reach the FIRST rail; this picker is how a card or a tool
           lands on a specific one without dragging. -->
      <p class="pick-head">Cards</p>
      {#if pickable.length === 0}
        <!-- Two different nothings, and the human is owed the difference:
             a board with work left that is all placed, versus one whose
             every remaining card is finished. The second is reached from
             the drawer's done bucket, not from here. -->
        <p class="empty">
          {available.length === 0
            ? "Every runnable card is already on a rail."
            : "Every card left to place is finished."}
        </p>
      {:else}
        <ul class="picker">
          {#each pickable as entry (entry.plan.path)}
            <!-- A nested child is not on this list: its plan carries it.
                 The count is what says so on the plan's row, rather than
                 the children just being absent. -->
            {@const nested = nestedCounts.get(entry.plan.path) ?? 0}
            <li>
              <button
                type="button"
                title={nested > 0
                  ? `Carries ${nested} nested ${nested === 1 ? "task" : "tasks"} — placing this plan places them too`
                  : undefined}
                onclick={() => {
                  void addStepAsStageAction(workspaceId, railId, entry.plan.path);
                  picking = null;
                }}
              >
                <span class="pick-title">{entry.plan.title}</span>
                <span class="pick-kind">
                  {nested > 0 ? `${entry.plan.kind} · +${nested} nested` : entry.plan.kind}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="pick-head">Tools</p>
      <ul class="picker">
        {#each tools as tool (tool.id)}
          <li>
            <button
              type="button"
              disabled={Boolean(toolsBlocked)}
              title={toolsBlocked ?? ""}
              onclick={() => {
                void addToolAsStepAction(workspaceId, railId, tool.id);
                picking = null;
              }}
            >
              <span class="pick-title">{tool.name}</span>
              <span class="pick-kind">{toolKindLabel(tool.kind)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </Modal>
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-base);
    color: var(--text);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .bar :global(.bar-search) {
    flex: 1 1 auto;
    max-width: 420px;
  }
  .summary {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .add-rail {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .add-rail:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .add-rail:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .save-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 12px;
  }
  .save-error button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .empty {
    padding: 16px 12px;
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  /* Rails are grid columns and stage index is the row track, so a
     horizontal band across the grid reads as roughly concurrent
     (orchestration spec O8).

     The grid scrolls sideways ONLY. `grid-template-rows: minmax(0, 1fr)`
     is the whole trick: it gives the single row a definite height equal
     to the grid's, so a rail taller than the viewport scrolls its own
     stages (`.rail-body`) instead of growing the row and taking every
     other rail's header off-screen with it -- the kanban's rule, where
     the strip scrolls x and each column scrolls its own cards. `auto`
     rows plus `align-items: start` was the shared vertical scroll this
     replaces. */
  .grid {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(280px, 1fr);
    grid-template-rows: minmax(0, 1fr);
    overflow-x: auto;
    overflow-y: hidden;
  }
  .picker-body {
    min-width: 320px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .picker {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 32vh;
    overflow-y: auto;
  }
  .pick-head {
    margin: 10px 0 4px;
    color: var(--text-subtle);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pick-head:first-of-type {
    margin-top: 0;
  }
  .picker button {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
    padding: 6px 8px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .picker button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .picker button:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .pick-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick-kind {
    color: var(--text-subtle);
    font-size: 11px;
  }
</style>
