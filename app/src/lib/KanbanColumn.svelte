<script lang="ts">
  import type { Column, Label } from "./kanban";
  import type { CardView } from "./planBoard";
  import type { PlanFileInfo } from "./gavin";
  import BoardCard from "./BoardCard.svelte";
  import { dragState, dropHold, buildDisplaySlots } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import { renameColumnAction, deleteColumnAction } from "./kanbanState";
  import { gavinTrees, patchPlanCreated } from "./gavinState";
  import { kanbanState, cardSessionFor } from "./kanbanState";
  import { tooltip } from "./tooltip";
  import { Play } from "@lucide/svelte";
  import { buildCreatePlanArgs } from "./cardCompose";
  import { columnDeletionPlan, executeDeletion } from "./cardDelete";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { openContextMenuFromEvent, type ContextMenuEntry } from "./contextMenu";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
    column: Column;
    // "full" is the hub board; "planOnly" is the per-context BoardPane
    // (spec §4): read-only header, no column dragging -- one component,
    // both surfaces.
    mode?: "full" | "planOnly";
    labels?: Label[];
    planCards: CardView[];
    // Pins the composer to one context (BoardPane) and hides the picker.
    composerContext?: string | null;
    onOpenPlanCard: (path: string) => void;
    onRunCard?: ((card: CardView) => void | Promise<void>) | null;
    onDeleteCard?: ((card: CardView) => void) | null;
    onCardContextMenu?: ((card: CardView, e: MouseEvent) => void) | null;
    // The full projection (nested included) -- the column-cascade plan
    // needs to find a deleted plan's free children in other columns.
    allCards?: CardView[];
  }
  let {
    workspaceId,
    column,
    mode = "full",
    labels = [],
    planCards,
    composerContext = null,
    onOpenPlanCard,
    onRunCard = null,
    onDeleteCard = null,
    onCardContextMenu = null,
    allCards = [],
  }: Props = $props();

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
  let confirmingColumnDelete = $state(false);
  let deleteError = $state<string | null>(null);

  const cascade = $derived(columnDeletionPlan(planCards, allCards));

  function requestDeleteColumn(): void {
    if (planCards.length === 0) {
      void deleteColumnAction(workspaceId, column.id);
    } else {
      confirmingColumnDelete = true;
    }
  }

  function deleteColumnOnly(): void {
    confirmingColumnDelete = false;
    void deleteColumnAction(workspaceId, column.id);
  }

  async function deleteColumnCascade(): Promise<void> {
    confirmingColumnDelete = false;
    deleteError = null;
    const err = await executeDeletion(workspaceId, cascade);
    if (err) {
      deleteError = err;
      return;
    }
    await deleteColumnAction(workspaceId, column.id);
  }

  // Run all (card-model spec §3): every plan/task in this column with no
  // session binding, sequentially -- each spawn lands on the Agents page
  // and binds before the next starts, so a re-click never double-runs.
  const runnable = $derived(
    onRunCard === null
      ? []
      : planCards.filter(
          (c) => c.kind !== "note" && cardSessionFor($kanbanState[workspaceId], c.id) === null
        )
  );
  let runningAll = $state(false);

  async function runAll(): Promise<void> {
    if (runningAll || !onRunCard) return;
    runningAll = true;
    try {
      const targets = [...runnable];
      for (const card of targets) {
        await onRunCard(card);
      }
    } finally {
      runningAll = false;
    }
  }

  // --- two-speed composer (card-model spec §4) -------------------------
  // Fast path: type a title, Enter -> a kind:note file in this column.
  // The kind chips expand in place: task adds a prompt field, plan adds
  // a body field; both add a context picker (root default) unless
  // composerContext pins one (BoardPane).
  let composing = $state(false);
  let composeKind = $state<"note" | "task" | "plan">("note");
  let composeTitle = $state("");
  let composeBody = $state("");
  let composeContext = $state<string | null>(null);
  let composeError = $state<string | null>(null);
  let composeRunNow = $state(false);
  let composeTitleEl = $state<HTMLTextAreaElement | null>(null);

  const contexts = $derived($gavinTrees[workspaceId]?.contexts ?? []);
  const defaultContext = $derived(
    composerContext ?? (contexts.find((c) => c.kind === "root") ?? contexts[0])?.folderPath ?? null
  );

  $effect(() => {
    if (composing && composeTitleEl) composeTitleEl.focus();
  });

  function resetComposer(): void {
    composeTitle = "";
    composeBody = "";
    composeError = null;
  }

  async function commitComposer(keepOpen: boolean): Promise<void> {
    const contextFolder = composeContext ?? defaultContext;
    if (!contextFolder) {
      composeError = "No gavin context to create in — bind a root first";
      return;
    }
    const ctx = contexts.find((c) => c.folderPath === contextFolder);
    const args = buildCreatePlanArgs(
      { kind: composeKind, title: composeTitle, body: composeBody, status: column.name },
      ctx?.plans.map((p) => p.fileName) ?? []
    );
    if ("error" in args) {
      if (composeTitle.trim() !== "" || keepOpen) composeError = args.error;
      if (composeTitle.trim() === "" && !keepOpen) composing = false;
      return;
    }
    composeError = null;
    try {
      const path = await backend.createPlan(
        contextFolder,
        args.fileName,
        args.title,
        args.status,
        undefined,
        args.body,
        args.kind
      );
      const created: PlanFileInfo = {
        path,
        fileName: args.fileName,
        title: args.title,
        status: args.status,
        priority: null,
        order: null,
        kind: args.kind,
        parent: null,
        labels: [],
        checklistDone: 0,
        checklistTotal: 0,
        parseWarning: false,
      };
      patchPlanCreated(workspaceId, contextFolder, created);
      if (composeRunNow && args.kind === "task" && onRunCard) {
        const ctxName = ctx?.name ?? contextFolder.split("/").at(-1) ?? contextFolder;
        onRunCard({
          id: path,
          title: args.title,
          status: args.status,
          priority: null,
          order: null,
          kind: "task",
          parent: null,
          parentTitle: null,
          parentBroken: false,
          labels: [],
          checklistDone: 0,
          checklistTotal: 0,
          contextName: ctxName,
          contextFolder,
          fileName: args.fileName,
          parseWarning: false,
          nestedChildren: [],
        });
      }
      resetComposer();
      composeRunNow = false;
      if (!keepOpen) composing = false;
      else composeTitleEl?.focus();
    } catch (e) {
      composeError = String(e);
    }
  }

  function handleHeaderContextMenu(e: MouseEvent): void {
    const entries: ContextMenuEntry[] = [];
    if (mode === "full") {
      entries.push({ label: "Rename column", onPick: startRename });
      entries.push({ label: "Add card", onPick: () => (composing = true) });
    }
    if (runnable.length > 0) {
      entries.push({
        label: `Run all (${runnable.length} unbound)`,
        onPick: () => void runAll(),
      });
    }
    if (mode === "full") {
      entries.push({ separator: true });
      entries.push({ label: "Delete column…", danger: true, onPick: requestDeleteColumn });
    }
    openContextMenuFromEvent(e, entries);
  }

  function handleComposerKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commitComposer(true);
    } else if (e.key === "Escape") {
      resetComposer();
      composing = false;
    }
  }
</script>

<div class="column" class:plan-only={mode === "planOnly"} data-kb-col={column.id}>
  <div class="header" role="presentation" data-kb-colgrab={mode === "full" ? column.id : undefined} oncontextmenu={handleHeaderContextMenu}>
    {#if mode === "planOnly"}
      <span class="name readonly">{column.name}</span>
      <span class="count" use:tooltip={planCards.length + (planCards.length === 1 ? " card" : " cards") + " in this column"}>{planCards.length}</span>
    {:else if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else}
      <button type="button" class="name" onclick={startRename} use:tooltip={"Rename column — its name is the status vocabulary"}>{column.name}</button>
      <span class="count" use:tooltip={planCards.length + (planCards.length === 1 ? " card" : " cards") + " in this column"}>{planCards.length}</span>
    {/if}
    {#if runnable.length > 0}
      <button
        type="button"
        class="run-all"
        aria-label="Run all unbound cards"
        disabled={runningAll}
        use:tooltip={"Run " + runnable.length + " unbound " + (runnable.length === 1 ? "card" : "cards") + " with the workspace agent"}
        onclick={() => void runAll()}
      >
        <Play size={10} /><span class="run-all-count">{runnable.length}</span>
      </button>
    {/if}
    {#if mode === "full"}
      <button type="button" class="delete" aria-label="Delete column" use:tooltip={"Delete column — its cards fall back to an auto column by status"} onclick={requestDeleteColumn}>×</button>
    {/if}
  </div>
  <div class="cards" data-kb-cards>
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlanCard} {workspaceId} onRun={onRunCard} onDelete={onDeleteCard} onContextMenu={onCardContextMenu} />
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
  {#if composing}
    <div class="composer">
      <div class="kind-chips">
        {#each ["note", "task", "plan"] as k (k)}
          <button
            type="button"
            class="kind-chip"
            class:active={composeKind === k}
            use:tooltip={k === "note"
              ? "Note — a quick reminder card"
              : k === "task"
                ? "Task — a runnable agent prompt"
                : "Plan — multi-step work with a checklist"}
            onclick={() => (composeKind = k as "note" | "task" | "plan")}
          >
            {k}
          </button>
        {/each}
      </div>
      <textarea
        class="compose-title"
        rows="2"
        placeholder="Card title…"
        bind:value={composeTitle}
        bind:this={composeTitleEl}
        onkeydown={handleComposerKeydown}
      ></textarea>
      {#if composeKind !== "note"}
        <textarea
          class="compose-body"
          rows="4"
          placeholder={composeKind === "task" ? "Agent prompt…" : "Plan body (use - [ ] for tasks)…"}
          bind:value={composeBody}
        ></textarea>
      {/if}
      {#if composeKind === "task"}
        <label class="run-now">
          <input type="checkbox" bind:checked={composeRunNow} />
          Run now with the agent
        </label>
      {/if}
      {#if composeKind !== "note" && !composerContext && contexts.length > 1}
        <select class="compose-context" bind:value={composeContext}>
          {#each contexts as ctx (ctx.folderPath)}
            <option value={ctx.folderPath} selected={ctx.folderPath === defaultContext}>{ctx.name}</option>
          {/each}
        </select>
      {/if}
      {#if composeError}
        <div class="compose-error">{composeError}</div>
      {/if}
      <div class="compose-actions">
        <button type="button" class="compose-add" onclick={() => void commitComposer(false)}>Add</button>
        <button
          type="button"
          class="compose-cancel"
          onclick={() => {
            resetComposer();
            composing = false;
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <button type="button" class="add-card" use:tooltip={"Add a card — a markdown file in this column"} onclick={() => (composing = true)}>+ Add card</button>
  {/if}
</div>

{#if confirmingColumnDelete}
  <ConfirmPrompt
    title={`Delete column "${column.name}"?`}
    lines={[
      `${planCards.length} ${planCards.length === 1 ? "card is" : "cards are"} in this column.`,
      `Column only: the cards fall back to an auto column named "${column.name}".`,
      `Cascade: ${cascade.files.length} card ${cascade.files.length === 1 ? "file" : "files"} deleted (nested tasks included)` +
        (cascade.unparent.length > 0 ? `; ${cascade.unparent.length} elsewhere un-parented.` : "."),
      "Bound agent sessions keep running on the Agents page.",
    ]}
    choices={[
      { label: "Delete column only", onPick: deleteColumnOnly },
      { label: `Delete column + ${cascade.files.length} cards`, danger: true, onPick: () => void deleteColumnCascade() },
    ]}
    onCancel={() => (confirmingColumnDelete = false)}
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
  }
  .delete {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1.1em;
  }
  .run-all {
    background: transparent;
    border: 1px solid var(--border-accent);
    border-radius: 10px;
    color: var(--accent-text);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 6px;
    flex: 0 0 auto;
  }
  .run-all:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .run-all-count {
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
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    font-family: monospace;
  }
  .kind-chips {
    display: flex;
    gap: 4px;
  }
  .kind-chip {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 1px 8px;
  }
  .kind-chip.active {
    background: var(--surface-overlay);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .compose-title,
  .compose-body {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    resize: none;
    width: 100%;
    box-sizing: border-box;
  }
  .compose-context {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.85em;
    padding: 4px;
  }
  .compose-error {
    color: var(--warning-text);
    font-size: 0.75em;
  }
  .delete-error {
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.75em;
    margin-top: 4px;
  }
  .run-now {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .run-now input {
    accent-color: var(--accent);
  }
  .compose-actions {
    display: flex;
    gap: 6px;
  }
  .compose-actions button {
    background: var(--surface-overlay);
    border: none;
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.8em;
    padding: 4px 10px;
  }
  .compose-cancel {
    opacity: 0.7;
  }
</style>
