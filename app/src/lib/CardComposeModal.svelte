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
  import { open } from "@tauri-apps/plugin-dialog";
  import Modal from "./Modal.svelte";
  import type { Column } from "./kanban";
  import type { Rail } from "./orchestration";
  import type { CardView } from "./planBoard";
  import type { PlanFileInfo } from "./gavin";
  import { gavinTrees, patchPlanCreated } from "./gavinState";
  import { orchestrations, sendCardToRailAction } from "./orchestrationState";
  import {
    buildCreatePlanArgs,
    composeHint,
    composeKeyAction,
    composeWindowKeyAction,
    railToApply,
    COMPOSE_KINDS,
    DEFAULT_COMPOSE_KIND,
    type ComposeField,
    type ComposeKind,
  } from "./cardCompose";
  import {
    addAttachment,
    attachmentFromPick,
    attachmentName,
    removeAttachment,
  } from "./attachments";
  import { daemonCompat, workspaceRootPath } from "./layoutState";
  import { featureBlockedReason } from "./daemonCompat";
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
    /// The rails a card typed here may ride, replacing the workspace's
    /// whole list. Set by a PAGE-SCOPED board (BoardPane): that board
    /// only shows cards bound to its page, so a card filed onto any
    /// other rail would vanish the moment it was written. Exactly one
    /// rail pins it and hides the picker, the way pinnedContext does.
    /// Null leaves the picker offering every rail.
    pageRails?: Rail[] | null;
    /// Offered only when the board can actually run a card.
    onRunCard?: ((card: CardView) => void | Promise<void>) | null;
    onClose: () => void;
  }
  let {
    workspaceId,
    columns,
    initialStatus,
    pinnedContext = null,
    pageRails = null,
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
  // Seeded ONCE from pageRails, for the same reason status and context
  // are: a later prop change must not swap the rail out from under a
  // half-typed card. Survives `reset()` too, so filing a run of cards
  // onto a page's rail is one pick, not one per card.
  let railId = $state<string | null>(untrack(() => pageRails?.[0]?.id ?? null));
  // Attached before the card exists: the whole point of doing it here is
  // that picking a file, filing the card, then reopening it to attach
  // the file is three gestures for one intention. Cleared with the rest
  // of the fields after each commit -- the next card is a different
  // card, and silently inheriting the last one's references is exactly
  // the kind of stale path the run gate exists to catch.
  let attachments = $state<string[]>([]);
  let attachmentsError = $state<string | null>(null);
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
    pageRails ?? [...($orchestrations[workspaceId]?.rails ?? [])].sort((a, b) => a.position - b.position)
  );
  /// A page-scoped board keeps only the cards bound to its page, so on
  /// one of those the rail is COMPULSORY: a card off the rail would
  /// vanish the moment it was written. That takes "none" out of the
  /// picker and the note kind off the chips (a note never rides a rail
  /// -- railToApply refuses it), and with a single rail to ride there is
  /// no choice left to offer at all.
  const railRequired = $derived(pageRails !== null);
  const railPinned = $derived(railRequired && rails.length === 1);
  const kinds = $derived(railRequired ? COMPOSE_KINDS.filter((k) => k !== "note") : COMPOSE_KINDS);
  // A v17 daemon parses CreatePlan happily and drops the new field on
  // the floor, so the card would be filed looking exactly as asked for
  // and carry none of these files. Nothing on the wire catches that --
  // this gate is the only one there is.
  const attachmentsBlocked = $derived(featureBlockedReason($daemonCompat, "attachments"));
  const isMac = isMacSync();

  async function pickAttachment(): Promise<void> {
    attachmentsError = null;
    const root = workspaceRootPath(workspaceId);
    if (root === null) {
      attachmentsError = "This workspace has no root folder, so an attachment has nothing to be relative to.";
      return;
    }
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        defaultPath: root,
        title: "Attach a file to this card",
      });
      // A cancelled dialog is not an error, and must not clear the
      // message from the pick before it.
      if (typeof picked !== "string") return;
      attachments = addAttachment(attachments, attachmentFromPick(root, picked));
    } catch (e) {
      attachmentsError = String(e instanceof Error ? e.message : e);
    }
  }
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
    attachments = [];
    attachmentsError = null;
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
      { kind, title, body, status, attachments },
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
        args.kind,
        undefined,
        args.attachments
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
        attachments: [...attachments],
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
          attachments: [...attachments],
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

  // ...and the same chord once more at the window, because a handler per
  // field only covers the controls that have one. Focus lands on a kind
  // chip, on Add card, or on nothing at all -- clicking the panel's own
  // padding blurs the textarea -- and the chord has to file the card
  // from any of them. Escape already works this way (Modal listens at
  // the window for it); the modal is the thing holding the keys, not
  // whichever control the caret happens to sit in. The handlers above
  // preventDefault, which is what keeps the same keystroke from being
  // filed a second time here on its way up.
  function handleWindowKeydown(e: KeyboardEvent): void {
    if (composeWindowKeyAction(e, isMac) !== "commit") return;
    e.preventDefault();
    void commit(true);
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<Modal {onClose}>
  <div class="head">
    <span class="heading">New card</span>
    <span class="chord">{newCardChord}</span>
  </div>

  <div class="kind-chips">
    {#each kinds as k (k)}
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
    {#if railPinned}
      <!-- Nothing to pick, but the card's destination is still worth
           saying out loud: it is not the board in front of them. -->
      <div class="field">
        <span>Rail</span>
        <span class="pinned-rail">{rails[0].name}</span>
      </div>
    {:else if kind !== "note" && rails.length > 0}
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
          {#if !railRequired}
            <option value={null}>none</option>
          {/if}
          {#each rails as rail (rail.id)}
            <option value={rail.id}>{rail.name}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  <!-- The blocked reason rides the ROW, not the button: tooltip.ts binds
       mouseenter, which a disabled element never fires. -->
  <div class="attachments" title={attachmentsBlocked ?? undefined}>
    <span class="attachments-label">Attachments</span>
    {#each attachments as path (path)}
      <span class="attachment">
        <span class="attachment-name" title={path}>{attachmentName(path)}</span>
        <button
          type="button"
          class="attachment-remove"
          aria-label={`Remove ${attachmentName(path)}`}
          onclick={() => (attachments = removeAttachment(attachments, path))}
        >
          ✕
        </button>
      </span>
    {/each}
    <button
      type="button"
      class="attachment-pick"
      disabled={attachmentsBlocked !== null}
      title={attachmentsBlocked ??
        "Attach a file — inside the root it is stored relative, outside it absolute"}
      onfocus={() => (focusField = "body")}
      onkeydown={(e) => handleKeydown("body", e)}
      onclick={() => void pickAttachment()}
    >
      + Attach…
    </button>
  </div>

  {#if attachmentsError}
    <div class="compose-error">{attachmentsError}</div>
  {/if}

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
  .attachments {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .attachments-label {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.75em;
    margin-right: 4px;
  }
  .attachment {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .attachment-name {
    color: var(--text);
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 4px 2px 8px;
  }
  .attachment-remove,
  .attachment-pick {
    background: transparent;
    border: none;
    color: var(--text-subtle);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 8px;
  }
  .attachment-pick {
    border: 1px dashed var(--border);
    border-radius: 10px;
  }
  .attachment-pick:disabled {
    opacity: 0.4;
    cursor: default;
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
  /* Beats `.field span`'s label width -- this is the value, not a label. */
  .field .pinned-rail {
    width: auto;
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
