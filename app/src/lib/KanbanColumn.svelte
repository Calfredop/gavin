<script lang="ts">
  import type { Column, Label } from "./kanban";
  import type { CardView } from "./planBoard";
  import type { PlanFileInfo } from "./gavin";
  import BoardCard from "./BoardCard.svelte";
  import { dragState, dropHold, buildDisplaySlots } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  import { renameColumnAction, deleteColumnAction } from "./kanbanState";
  import { gavinTrees, patchPlanCreated } from "./gavinState";
  import { tooltip } from "./tooltip";
  import { buildCreatePlanArgs } from "./cardCompose";
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
    onRunCard?: ((card: CardView) => void) | null;
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

  // Deleting a column never touches card files -- cards whose status
  // matched it fall back to an auto column (D6), so no prompt is needed.
  function deleteColumn(): void {
    void deleteColumnAction(workspaceId, column.id);
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
  <div class="header" data-kb-colgrab={mode === "full" ? column.id : undefined}>
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
    {#if mode === "full"}
      <button type="button" class="delete" aria-label="Delete column" use:tooltip={"Delete column — its cards fall back to an auto column by status"} onclick={deleteColumn}>×</button>
    {/if}
  </div>
  <div class="cards" data-kb-cards>
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-plan={slot.item.id} data-kb-kind={slot.item.kind} data-kb-ctx={slot.item.contextFolder}>
            <BoardCard card={slot.item} labelDefs={labels} onOpen={onOpenPlanCard} {workspaceId} onRun={onRunCard} />
          </div>
        {:else}
          <div class="slot-placeholder" data-kb-ph style:height="{slotDrag?.size?.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
  </div>
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

<style>
  .column {
    background: #232323;
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
    color: #eee;
    font-family: monospace;
    font-weight: bold;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .slot-placeholder {
    border: 1px dashed #555;
    border-radius: 6px;
    background: #202020;
    margin-bottom: 6px;
    box-sizing: border-box;
  }
  .header input {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
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
    color: #888;
    font-weight: normal;
    font-size: 0.85em;
    margin-left: 6px;
    margin-right: auto;
  }
  .delete {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-size: 1.1em;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .add-card {
    background: transparent;
    border: none;
    color: #999;
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
    border: 1px solid #444;
    border-radius: 10px;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 1px 8px;
  }
  .kind-chip.active {
    background: #3a3a3a;
    color: #eee;
    border-color: #666;
  }
  .compose-title,
  .compose-body {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    resize: none;
    width: 100%;
    box-sizing: border-box;
  }
  .compose-context {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
    padding: 4px;
  }
  .compose-error {
    color: #e0b08a;
    font-size: 0.75em;
  }
  .run-now {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #999;
    font-size: 0.8em;
  }
  .run-now input {
    accent-color: #7ea8d8;
  }
  .compose-actions {
    display: flex;
    gap: 6px;
  }
  .compose-actions button {
    background: #3a3a3a;
    border: none;
    border-radius: 4px;
    color: #eee;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.8em;
    padding: 4px 10px;
  }
  .compose-cancel {
    opacity: 0.7;
  }
</style>
