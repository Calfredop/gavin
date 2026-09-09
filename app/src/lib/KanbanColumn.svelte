<script lang="ts">
  import type { Column, Label } from "$lib/kanban";
  import { isPermanentColumn, type CardView } from "$lib/planBoard";
  import BoardCard from "$lib/BoardCard.svelte";
  import { dragState, dropHold, buildDisplaySlots } from "$lib/kanbanDrag";
  import { flip } from "svelte/animate";
  import { renameColumnAction, deleteColumnAction } from "$lib/kanbanState";
  import { kanbanState, cardSessionFor } from "$lib/kanbanState";
  import { tooltip } from "$lib/tooltip";
  import { layoutState, resolvedAgents } from "$lib/layoutState";
  import { agentPromptBlocker } from "$lib/cardRun";
  import { developingRunIn } from "$lib/developingCards";
  import {
    columnRunAction,
    columnRunTargets,
    columnRunTip,
    columnRunMenuLabel,
    columnRunAllConfirm,
    cardSessionState,
    type CardSessionState,
  } from "$lib/columnRunAction";
  import { Play, RotateCcw, Archive } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { X } from "@lucide/svelte";
  import { formatShortcut } from "$lib/shortcuts";
  import { estimateFor, launchGateVerdict } from "$lib/launchQueue";
  import { isMacSync } from "$lib/platform";
  import { columnDeletionPlan, executeDeletion, executeMoveCards } from "$lib/cardDelete";
  import { grantForAnsweredPrompt } from "$lib/confirmGate";
  import ConfirmPrompt from "$lib/ConfirmPrompt.svelte";
  import { openContextMenuFromEvent, type ContextMenuEntry } from "$lib/contextMenu";
  import { executeArchive, isDoneColumn } from "$lib/archiveActions";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { daemonCompat } from "$lib/layoutState";

  interface Props {
    workspaceId: string;
    column: Column;
    // "full" is the hub board; "planOnly" is the per-context BoardPane
    // (spec §4): read-only header, no column dragging -- one component,
    // both surfaces.
    mode?: "full" | "planOnly";
    labels?: Label[];
    planCards: CardView[];
    onOpenPlanCard: (path: string) => void;
    onRunCard?: ((card: CardView) => void | Promise<void>) | null;
    // The In Progress column's Resume: the same spawn with the prompt
    // that says work on this card already happened. Absent, that column
    // falls back to a plain run.
    onResumeCard?: ((card: CardView) => void | Promise<void>) | null;
    onSendToAgent?: ((card: CardView) => void) | null;
    agentAvailable?: boolean;
    onDeleteCard?: ((card: CardView) => void) | null;
    onCardContextMenu?: ((card: CardView, e: MouseEvent) => void) | null;
    // Opens the board's card composer on this column. The modal is the
    // BOARD's (KanbanBoard/BoardPane): one composer per board, wherever
    // the request came from -- a column's button, its menu, or ⌘N.
    onAddCard?: ((status: string) => void) | null;
    // The full projection (nested included) -- the column-cascade plan
    // needs to find a deleted plan's free children in other columns.
    allCards?: CardView[];
    // Cards this column holds but is not showing, because the board's
    // search box is filtering (boardSearch.ts). Non-zero means
    // `planCards` is a SUBSET: the header says so, and the destructive
    // column actions refuse to run against a partial view.
    hiddenCount?: number;
  }
  let {
    workspaceId,
    column,
    mode = "full",
    labels = [],
    planCards,
    onOpenPlanCard,
    onRunCard = null,
    onResumeCard = null,
    onSendToAgent = null,
    agentAvailable = false,
    onDeleteCard = null,
    onCardContextMenu = null,
    onAddCard = null,
    allCards = [],
    hiddenCount = 0,
  }: Props = $props();

  // "3" normally, "3 / 11" while the board is filtered.
  const filtered = $derived(hiddenCount > 0);
  const totalCount = $derived(planCards.length + hiddenCount);
  const countText = $derived(filtered ? `${planCards.length} / ${totalCount}` : String(planCards.length));
  // Deliberately says LENS, not "search": the board narrows through more
  // than one of them (the search box, and the context / kind / rail
  // facets beside it), and this column is only told how many cards it is
  // not showing. Naming one lens here would tell the human to clear a
  // box that is already empty.
  const countTip = $derived(
    filtered
      ? `${planCards.length} of ${totalCount} cards pass the board's filters`
      : planCards.length + (planCards.length === 1 ? " card" : " cards") + " in this column"
  );
  // Deleting or clearing while filtered would silently act on cards the
  // human cannot see -- the lens has to come off first.
  const FILTERED_TIP = "Clear the board's search and filters first — this column is only showing part of itself";

  let editingName = $state(false);
  // Filled by startRename when editing begins -- initializing from
  // column.name here would freeze the first render's value.
  let nameDraft = $state("");

  function startRename(): void {
    nameDraft = column.name;
    editingName = true;
  }

  function commitRename(): void {
    editingName = false;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== column.name) void renameColumnAction(workspaceId, column.id, trimmed);
  }

  // All cards are file-backed (card-model spec §1): one block per
  // column, rendered through display slots -- while a matching drag is
  // live (or a drop's writes are in flight), the dragged card is hidden
  // and a placeholder occupies the target slot; animate:flip slides the
  // rest.
  const slotDrag = $derived($dragState ?? $dropHold);
  const planSlots = $derived(buildDisplaySlots(planCards, (p) => p.id, slotDrag, column.id));

  // Deleting an EMPTY column is direct. A non-empty one prompts with two
  // choices (card-model delete design): column only (its cards fall back
  // to an auto column, D6) or column + cascade of its card files.
  // The three canonical statuses are permanent: never deleted, never
  // renamed (renaming would break the identity that makes them
  // permanent), but freely reorderable like any other column. Their X
  // CLEARS instead -- the column stays, its cards go.
  const permanent = $derived(isPermanentColumn(column.name));

  let columnPrompt = $state<"delete" | "clear" | null>(null);
  let deleteError = $state<string | null>(null);

  const cascade = $derived(columnDeletionPlan(planCards, allCards));

  // What a MOVE carries, as opposed to what a delete does. Relocating
  // this column's cards rewrites each plan's `status:`, and a nested task
  // has none of its own -- it reads as whatever its parent reads as, and
  // lands in `plans/done/` with it when the column picked is Done. The
  // prompt says so here rather than raising a second dialog of its own
  // (cardCompletion.ts): two prompts in a row is how a human learns to
  // dismiss the second one unread.
  const travellingChildren = $derived(planCards.reduce((n, c) => n + c.nestedChildren.length, 0));

  function requestDeleteColumn(): void {
    if (filtered) return;
    if (planCards.length === 0) {
      void deleteColumnAction(workspaceId, column.id);
    } else {
      columnPrompt = "delete";
    }
  }

  function requestClearColumn(): void {
    if (filtered || planCards.length === 0) return;
    columnPrompt = "clear";
  }

  function deleteColumnOnly(): void {
    columnPrompt = null;
    void deleteColumnAction(workspaceId, column.id);
  }

  async function deleteColumnCascade(): Promise<void> {
    columnPrompt = null;
    deleteError = null;
    const token = await grantForAnsweredPrompt("delete_card_file", cascade.files.map((f) => f.id));
    const err = await executeDeletion(workspaceId, cascade, token);
    if (err) {
      deleteError = err;
      return;
    }
    await deleteColumnAction(workspaceId, column.id);
  }

  // Where a deleted column's cards can go: every OTHER real column
  // (auto columns aren't real -- they exist only while some card wears
  // an unmatched status).
  const moveTargets = $derived(
    ($kanbanState[workspaceId]?.columns ?? []).filter((c) => c.id !== column.id)
  );

  async function moveCardsAndDelete(destinationName: string | null): Promise<void> {
    columnPrompt = null;
    deleteError = null;
    if (!destinationName) return;
    const err = await executeMoveCards(workspaceId, planCards, destinationName);
    if (err) {
      deleteError = err;
      return;
    }
    await deleteColumnAction(workspaceId, column.id);
  }

  async function clearColumn(): Promise<void> {
    columnPrompt = null;
    deleteError = null;
    const token = await grantForAnsweredPrompt("delete_card_file", cascade.files.map((f) => f.id));
    const err = await executeDeletion(workspaceId, cascade, token);
    if (err) deleteError = err;
  }

  // Run all (card-model spec §3), now speaking this column's language
  // (columnRunAction.ts): Start all in To Do, Resume in In Progress,
  // nothing at all in Done, Run all everywhere else. Whatever the verb,
  // the cards run sequentially -- each spawn lands on the Agents page
  // and binds before the next starts, so a re-click never double-runs.
  const runAction = $derived(onRunCard === null ? null : columnRunAction(column.name));

  // Why no card in this column can be started, or null. A whole-column
  // run is the same launch repeated, so a profile that takes no prompt
  // blocks all of them for one reason -- said once, on the header
  // button, rather than as N identical error strips after the click.
  const runBlocked = $derived(
    agentPromptBlocker($resolvedAgents(workspaceId).promptArgs, $resolvedAgents(workspaceId).label)
  );

  function sessionStateFor(path: string): CardSessionState {
    return cardSessionState($layoutState, cardSessionFor($kanbanState[workspaceId], path));
  }

  // A card whose develop agent is rewriting it is not a target for any
  // of the three verbs -- and the count on the button has to agree, or
  // "Start all (7 unbound)" starts six.
  const runnable = $derived(
    runAction
      ? columnRunTargets(
          planCards,
          runAction.mode,
          sessionStateFor,
          (path) => developingRunIn($layoutState, workspaceId, path) !== null
        )
      : []
  );
  let runningAll = $state(false);

  // Asks first: a whole column's worth of agent spawns is not something
  // a click should fire outright. Held as a bare flag rather than a
  // captured target list, the same reason the Orchestration tab's own
  // Run all does (runAllPrompt) -- a column that changes under the open
  // prompt (a card finishes, a new one lands) re-derives fresh content
  // through `runnable`, and closes on its own once nothing is left to run.
  let runAllPrompt = $state(false);
  // The estimate rides `$launchGateVerdict` so the projection keeps up
  // while the prompt is open: the machine moves under it, and a number
  // frozen at the moment the dialog appeared is the number that would
  // still be wrong when the button is pressed.
  const runAllContent = $derived.by(() => {
    // Read so this derivation depends on it; see OrchestrationHubView.
    void $launchGateVerdict;
    if (!runAllPrompt || !runAction || runnable.length === 0) return null;
    return columnRunAllConfirm(
      runAction,
      column.name,
      runnable,
      estimateFor(workspaceId, runnable.length)
    );
  });

  async function runAll(): Promise<void> {
    const action = runAction;
    runAllPrompt = false;
    if (runningAll || !action) return;
    const run = action.mode === "resume" ? (onResumeCard ?? onRunCard) : onRunCard;
    if (!run) return;
    runningAll = true;
    try {
      // Snapshot first: every spawn binds its card, which shrinks
      // `runnable` under the loop's feet.
      const targets = [...runnable];
      for (const card of targets) {
        await run(card);
      }
    } finally {
      runningAll = false;
    }
  }

  // --- archive all (the Done column only) ------------------------------
  // The Done column is the one that grows without bound: every finished
  // card lands there and nothing takes it away. This button is what
  // takes them away -- into `plans/archive/`, off the board, still on
  // disk and still searchable from the archive grid.
  //
  // Only the FULL board offers it: the per-context BoardPane is a
  // read-only structural view (spec §4), and a bulk file move is not
  // something to hide behind a read-only header.
  const archiveBlocked = $derived(featureBlockedReason($daemonCompat, "archive"));
  const canArchiveAll = $derived(
    mode === "full" && isDoneColumn(column.name) && planCards.length > 0
  );
  let archivingAll = $state(false);
  let archiveError = $state<string | null>(null);

  async function archiveAll(): Promise<void> {
    if (archivingAll || filtered || archiveBlocked !== null) return;
    archivingAll = true;
    archiveError = null;
    try {
      // Snapshot: each move takes its card out of `planCards` under the
      // loop's feet, the same reason runAll snapshots.
      const err = await executeArchive(workspaceId, [...planCards]);
      if (err) archiveError = err;
    } finally {
      archivingAll = false;
    }
  }

  // The card composer lives in a modal the BOARD owns (CardComposeModal
  // via KanbanBoard/BoardPane), not at the foot of this column: centred,
  // it lands under the human's eyes wherever a wide board is scrolled to.
  // The column contributes only the status it wants the card to carry.
  const addCardTip = $derived(
    onAddCard
      ? `Add a card to ${column.name} — a markdown file in this column (${formatShortcut("new-card", isMacSync())})`
      : ""
  );

  function handleHeaderContextMenu(e: MouseEvent): void {
    const entries: ContextMenuEntry[] = [];
    if (mode === "full") {
      if (!permanent) entries.push({ label: "Rename column", onPick: startRename });
      if (onAddCard) entries.push({ label: "Add card", onPick: () => onAddCard?.(column.name) });
    }
    if (runAction && runnable.length > 0) {
      entries.push({
        // Left clickable when the agent takes no prompt: a menu row
        // cannot show a tooltip, so a greyed one would say nothing at
        // all, while the click reports the reason in the error strip.
        label: columnRunMenuLabel(runAction, runnable.length),
        onPick: () => (runAllPrompt = true),
      });
    }
    if (mode === "full") {
      entries.push({ separator: true });
      entries.push({
        label: "Clear column…",
        danger: true,
        disabled: filtered || planCards.length === 0,
        onPick: requestClearColumn,
      });
      if (!permanent) {
        entries.push({ label: "Delete column…", danger: true, disabled: filtered, onPick: requestDeleteColumn });
      }
    }
    openContextMenuFromEvent(e, entries);
  }

</script>

<div class="column" class:plan-only={mode === "planOnly"} data-kb-col={column.id}>
  <div class="header" role="presentation" data-kb-colgrab={mode === "full" ? column.id : undefined} oncontextmenu={handleHeaderContextMenu}>
    {#if mode === "planOnly"}
      <span class="name readonly">{column.name}</span>
      <span class="count" class:filtered use:tooltip={countTip}>{countText}</span>
    {:else if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else if permanent}
      <span class="name readonly" use:tooltip={"Permanent column — one of the three canonical statuses. Reorder it freely; it can't be renamed or deleted."}>{column.name}</span>
      <span class="count" class:filtered use:tooltip={countTip}>{countText}</span>
    {:else}
      <button type="button" class="name" onclick={startRename} use:tooltip={"Rename column — its name is the status vocabulary"}>{column.name}</button>
      <span class="count" class:filtered use:tooltip={countTip}>{countText}</span>
    {/if}
    {#if runAction && runnable.length > 0}
      <!-- The reason rides the wrapper, not the button: IconButton binds
           its tooltip to the <button>, and a disabled element never
           fires mouseenter. Null while the agent can run, so this span
           is inert in the ordinary case. -->
      <span class="run-all-wrap" use:tooltip={runBlocked}>
        <IconButton
          icon={runAction.mode === "resume" ? RotateCcw : Play}
          label={runAction.aria}
          tone="accent"
          variant="outlined"
          size={10}
          class="run-all"
          disabled={runningAll || runBlocked !== null}
          tip={runBlocked === null ? columnRunTip(runAction, runnable.length) : null}
          onclick={() => (runAllPrompt = true)}
        >
          <span class="run-all-count">{runnable.length}</span>
        </IconButton>
      </span>
    {/if}
    {#if canArchiveAll}
      <IconButton
        icon={Archive}
        label="Archive all"
        variant="outlined"
        size={10}
        class="archive-all"
        disabled={archivingAll || filtered || archiveBlocked !== null}
        tip={archiveBlocked ??
          (filtered
            ? FILTERED_TIP
            : `Archive all — files ${planCards.length} ${planCards.length === 1 ? "card" : "cards"} away; nothing is deleted`)}
        onclick={() => void archiveAll()}
      >
        <span class="archive-all-count">{planCards.length}</span>
      </IconButton>
    {/if}
    {#if mode === "full"}
      <IconButton
        icon={X}
        label={permanent ? "Clear column" : "Delete column"}
        tone="danger"
        size={13}
        disabled={filtered || (permanent && planCards.length === 0)}
        tip={filtered
          ? FILTERED_TIP
          : permanent
            ? planCards.length === 0
              ? "Nothing to clear — this column is empty"
              : `Clear column — deletes its ${planCards.length} ${planCards.length === 1 ? "card" : "cards"}; the column stays`
            : "Delete column — its cards fall back to an auto column by status"}
        onclick={permanent ? requestClearColumn : requestDeleteColumn}
      />
    {/if}
  </div>
  <div class="cards" data-kb-cards>
    {#if filtered && planCards.length === 0}
      <div class="no-match">Nothing in this column passes the filter</div>
    {/if}
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlanCard} {workspaceId} onRun={onRunCard} {onSendToAgent} {agentAvailable} onDelete={onDeleteCard} onContextMenu={onCardContextMenu} />
          </div>
        {:else}
          <div class="slot-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
  </div>
  {#if deleteError}
    <div class="delete-error">{deleteError}</div>
  {/if}
  {#if archiveError}
    <div class="delete-error">{archiveError}</div>
  {/if}
  {#if onAddCard}
    <button type="button" class="add-card" use:tooltip={addCardTip} onclick={() => onAddCard?.(column.name)}
      >+ Add card</button
    >
  {/if}
</div>

{#if runAllContent}
  <ConfirmPrompt
    title={runAllContent.title}
    lines={runAllContent.lines}
    choices={[{ label: runAllContent.confirmLabel, onPick: () => void runAll() }]}
    onCancel={() => (runAllPrompt = false)}
  />
{/if}

{#if columnPrompt === "clear"}
  <ConfirmPrompt
    title={`Clear column "${column.name}"?`}
    lines={[
      `Deletes ${cascade.files.length} card ${cascade.files.length === 1 ? "file" : "files"} permanently (nested tasks included).`,
      ...(cascade.unparent.length > 0 ? [`${cascade.unparent.length} elsewhere un-parented.`] : []),
      "The column itself stays — it's one of the three permanent statuses.",
      "Bound agent sessions keep running on the Agents page.",
    ]}
    choices={[
      {
        label: `Delete ${cascade.files.length} ${cascade.files.length === 1 ? "card" : "cards"}`,
        danger: true,
        onPick: () => void clearColumn(),
      },
    ]}
    onCancel={() => (columnPrompt = null)}
  />
{/if}

{#if columnPrompt === "delete"}
  <ConfirmPrompt
    title={`Delete column "${column.name}"?`}
    lines={[
      `${planCards.length} ${planCards.length === 1 ? "card is" : "cards are"} in this column.`,
      `Move: each card's status: is rewritten to the column you pick.`,
      ...(travellingChildren > 0
        ? [
            `${travellingChildren} nested ${travellingChildren === 1 ? "task has" : "tasks have"} no status of ${travellingChildren === 1 ? "its" : "their"} own and ${travellingChildren === 1 ? "follows its plan" : "follow their plans"} into that column.`,
          ]
        : []),
      `Leave: the cards fall back to an auto column named "${column.name}".`,
      `Cascade: ${cascade.files.length} card ${cascade.files.length === 1 ? "file" : "files"} deleted (nested tasks included)` +
        (cascade.unparent.length > 0 ? `; ${cascade.unparent.length} elsewhere un-parented.` : "."),
      "Bound agent sessions keep running on the Agents page.",
    ]}
    picker={moveTargets.length > 0
      ? { label: "Move cards to", options: moveTargets.map((c) => ({ value: c.name, label: c.name })) }
      : null}
    choices={[
      {
        label: "Move cards & delete",
        needsPick: true,
        onPick: (picked) => void moveCardsAndDelete(picked),
      },
      { label: "Leave cards (auto column)", onPick: deleteColumnOnly },
      { label: `Delete column + ${cascade.files.length} cards`, danger: true, onPick: () => void deleteColumnCascade() },
    ]}
    onCancel={() => (columnPrompt = null)}
  />
{/if}

<style>
  .column {
    background: var(--surface-raised);
    border-radius: 8px;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: 100%;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: var(--text);
    font-family: monospace;
    font-weight: bold;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .slot-placeholder {
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    background: var(--surface-sunken);
    margin-bottom: 6px;
    box-sizing: border-box;
  }
  .header input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: monospace;
    padding: 2px 4px;
    border-radius: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .header .name {
    cursor: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .column.plan-only .header {
    cursor: default;
  }
  .header .name.readonly {
    cursor: default;
  }
  .count {
    color: var(--text-subtle);
    font-weight: normal;
    font-size: 0.85em;
    margin-left: 6px;
    margin-right: auto;
    font-variant-numeric: tabular-nums;
  }
  .count.filtered {
    color: var(--accent-text);
  }
  .no-match {
    color: var(--text-subtle);
    font-size: 0.75em;
    padding: 4px 2px;
  }
  /* Scoped ancestor first -- see BoardCard's .chevron for why a bare
     :global class rule is an app-wide rule. */
  .header :global(.run-all) {
    flex: 0 0 auto;
  }
  /* The wrapper is the header's flex item now, so it carries what the
     button used to; `display: flex` keeps it the button's exact size,
     which is what the tooltip has to be hoverable over. */
  .run-all-wrap {
    display: flex;
    flex: 0 0 auto;
  }
  .run-all-count,
  .archive-all-count {
    font-size: 0.75em;
    font-family: monospace;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .add-card {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    text-align: left;
    padding: 4px 0;
  }
  .delete-error {
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.75em;
    margin-top: 4px;
  }
</style>
