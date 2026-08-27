<script lang="ts">
  // The two-speed composer (card-model spec §4), centred. It used to live
  // at the foot of one column, which put the fields wherever that column
  // happened to be -- off to the right on a wide board, and below the
  // fold on a full one. A modal puts it under the human's eyes wherever
  // the board is scrolled to, and gives the column a picker of its own so
  // the form no longer has to be spatially attached to answer "which
  // column?".
  //
  // Fast path unchanged: type a title, Enter -> a file in the chosen
  // column, field cleared and still open for the next one. It opens on
  // the task chip (DEFAULT_COMPOSE_KIND), so that file is runnable work
  // by default -- a bare Enter simply leaves the prompt empty. The other
  // chips reshape it in place: plan swaps the prompt for a body, note
  // drops the body entirely.
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import type { Column } from "./kanban";
  import type { CardView } from "./planBoard";
  import type { PlanFileInfo } from "./gavin";
  import { gavinTrees, patchPlanCreated } from "./gavinState";
  import { orchestrations, sendCardToRailAction } from "./orchestrationState";
  import {
    buildCreatePlanArgs,
    composeHint,
    composeKeyAction,
    railToApply,
    COMPOSE_KINDS,
    DEFAULT_COMPOSE_KIND,
    type ComposeField,
    type ComposeKind,
  } from "./cardCompose";
  import { formatShortcut } from "./shortcuts";
  import { isMacSync } from "./platform";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
    /// The board's real columns -- their names are the status vocabulary.
    columns: Column[];
    /// The column that opened the composer; the picker starts there.
    initialStatus: string;
    /// Pins every card to one context and hides the picker (BoardPane).
    pinnedContext?: string | null;
    /// Offered only when the board can actually run a card.
    onRunCard?: ((card: CardView) => void | Promise<void>) | null;
    onClose: () => void;
  }
  let {
    workspaceId,
    columns,
    initialStatus,
    pinnedContext = null,
    onRunCard = null,
    onClose,
  }: Props = $props();

  let kind = $state<ComposeKind>(DEFAULT_COMPOSE_KIND);
  let title = $state("");
  let body = $state("");
  // Seeded from the props ONCE, then owned by the pickers: untrack says
  // so out loud, and keeps a later prop change from yanking the column
  // out from under a half-typed card.
  let status = $state(untrack(() => initialStatus));
  let context = $state<string | null>(untrack(() => pinnedContext));
  let railId = $state<string | null>(null);
  let runNow = $state(false);
  let error = $state<string | null>(null);
  let titleEl = $state<HTMLTextAreaElement | null>(null);
  // Drives the footer hint only: which key files a card depends on
  // where the caret is, so the hint has to follow the caret.
  let focusField = $state<ComposeField>("title");
  // Enter keeps the modal open for the next card, so the human needs to
  // see that the last one landed -- the fields clearing is otherwise
  // indistinguishable from the fields being cleared by a failure.
  let added = $state(0);

  const contexts = $derived($gavinTrees[workspaceId]?.contexts ?? []);
  const defaultContext = $derived(
    pinnedContext ?? (contexts.find((c) => c.kind === "root") ?? contexts[0])?.folderPath ?? null
  );
  const rails = $derived(
    [...($orchestrations[workspaceId]?.rails ?? [])].sort((a, b) => a.position - b.position)
  );
  const isMac = isMacSync();
  const newCardChord = formatShortcut("new-card", isMac);
  // A note has no body field, so the hint cannot be left describing
  // one the kind chips just took off screen.
  const hintField = $derived<ComposeField>(kind === "note" ? "title" : focusField);

  $effect(() => {
    titleEl?.focus();
  });

  function reset(): void {
    title = "";
    body = "";
    error = null;
  }

  async function commit(keepOpen: boolean): Promise<void> {
    const contextFolder = context ?? defaultContext;
    if (!contextFolder) {
      error = "No gavin context to create in — bind a root first";
      return;
    }
    const ctx = contexts.find((c) => c.folderPath === contextFolder);
    const args = buildCreatePlanArgs(
      { kind, title, body, status },
      ctx?.plans.map((p) => p.fileName) ?? []
    );
    if ("error" in args) {
      // An empty title with the Add button is a plain "nothing to do":
      // close rather than scold. Empty on Enter stays open and says why.
      if (title.trim() !== "" || keepOpen) error = args.error;
      else onClose();
      return;
    }
    error = null;
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
      // Before Run now, so a failure to place the card is not buried
      // under a spawning agent.
      const rail = railToApply(
        args.kind,
        railId,
        rails.map((r) => r.id)
      );
      const railError = rail ? await sendCardToRailAction(workspaceId, rail, path) : null;
      if (runNow && args.kind === "task" && onRunCard) {
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
      added += 1;
      reset();
      // The card IS created; the rail is what failed. Said after the
      // reset so the next card starts from a clean field but the human
      // still learns this one is sitting off the rails.
      if (railError) error = `Card created, but it isn't on the rail: ${railError}`;
      runNow = false;
      if (!keepOpen) onClose();
      else titleEl?.focus();
    } catch (e) {
      error = String(e);
    }
  }

  // Every field in the composer routes here. The title keeps the fast
  // path (bare Enter files the card); everywhere else Enter belongs to
  // the field -- a plan body is checklist lines, a task body is a
  // prompt -- and the chord is what files it. Wired to the pickers too,
  // so the chord does not stop working one Tab away from the textarea.
  function handleKeydown(field: ComposeField, e: KeyboardEvent): void {
    if (composeKeyAction(field, e, isMac) !== "commit") return;
    e.preventDefault();
    void commit(true);
  }
</script>

<Modal {onClose}>
  <div class="head">
    <span class="heading">New card</span>
    <span class="chord">{newCardChord}</span>
  </div>

  <div class="kind-chips">
    {#each COMPOSE_KINDS as k (k)}
      <button
        type="button"
        class="kind-chip"
        class:active={kind === k}
        title={k === "note"
          ? "Note — a quick reminder card"
          : k === "task"
            ? "Task — a runnable agent prompt"
            : "Plan — multi-step work with a checklist"}
        onclick={() => (kind = k)}
      >
        {k}
      </button>
    {/each}
  </div>

  <textarea
    class="compose-title"
    rows="2"
    placeholder="Card title…"
    bind:value={title}
    bind:this={titleEl}
    onfocus={() => (focusField = "title")}
    onkeydown={(e) => handleKeydown("title", e)}
  ></textarea>

  {#if kind !== "note"}
    <textarea
      class="compose-body"
      rows="5"
      placeholder={kind === "task" ? "Agent prompt…" : "Plan body (use - [ ] for tasks)…"}
      bind:value={body}
      onfocus={() => (focusField = "body")}
      onkeydown={(e) => handleKeydown("body", e)}
    ></textarea>
  {/if}

  <div class="fields">
    {#if columns.length > 1}
      <label class="field">
        <span>Column</span>
        <select bind:value={status} onfocus={() => (focusField = "body")} onkeydown={(e) => handleKeydown("body", e)}>
          {#each columns as column (column.id)}
            <option value={column.name}>{column.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if !pinnedContext && contexts.length > 1}
      <label class="field">
        <span>Context</span>
        <select bind:value={context} onfocus={() => (focusField = "body")} onkeydown={(e) => handleKeydown("body", e)}>
          {#each contexts as ctx (ctx.folderPath)}
            <option value={ctx.folderPath} selected={ctx.folderPath === defaultContext}>{ctx.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if kind !== "note" && rails.length > 0}
      <label class="field">
        <span>Rail</span>
        <select
          bind:value={railId}
          onfocus={() => (focusField = "body")}
          onkeydown={(e) => handleKeydown("body", e)}
          onchange={() => {
            // The rail runs it when the human arms that rail; running it
            // now as well would put two agents on one card.
            if (railId) runNow = false;
          }}
        >
          <option value={null}>none</option>
          {#each rails as rail (rail.id)}
            <option value={rail.id}>{rail.name}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  {#if kind === "task" && !railId && onRunCard}
    <label class="run-now">
      <input
        type="checkbox"
        bind:checked={runNow}
        onfocus={() => (focusField = "body")}
        onkeydown={(e) => handleKeydown("body", e)}
      />
      Run now with the agent
    </label>
  {/if}

  {#if error}
    <div class="compose-error">{error}</div>
  {/if}

  <div class="foot">
    <span class="hint">
      {#if added > 0}
        <span class="added">{added} added</span> ·
      {/if}
      {composeHint(hintField, isMac)}
    </span>
    <div class="actions">
      <button type="button" class="cancel" onclick={onClose}>Cancel</button>
      <button type="button" class="add" onclick={() => void commit(false)}>Add card</button>
    </div>
  </div>
</Modal>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
  }
  .heading {
    font-family: monospace;
    font-weight: bold;
    color: var(--text);
  }
  .chord {
    font-family: monospace;
    font-size: 0.75em;
    color: var(--text-subtle);
    margin-left: auto;
  }
  .kind-chips {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .kind-chip {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 10px;
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
    margin-bottom: 8px;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
  }
  .field span {
    width: 62px;
    flex: 0 0 auto;
  }
  .field select {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .run-now {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
    margin-top: 8px;
  }
  .run-now input {
    accent-color: var(--accent);
  }
  .compose-error {
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.75em;
    margin-top: 8px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .hint {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.7em;
    flex: 1 1 auto;
    min-width: 0;
  }
  .added {
    color: var(--accent-text);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.8em;
    padding: 6px 14px;
  }
  .actions .cancel {
    opacity: 0.7;
  }
</style>
