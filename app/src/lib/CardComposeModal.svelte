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
  import { get } from "svelte/store";
  import { pickPath } from "$lib/picker";
  import Modal from "$lib/Modal.svelte";
  import ConfirmPrompt from "$lib/ConfirmPrompt.svelte";
  import type { Column } from "$lib/kanban";
  import type { Rail } from "$lib/orchestration";
  import type { CardView } from "$lib/planBoard";
  import type { PlanFileInfo } from "$lib/gavin";
  import { gavinTrees, patchPlanCreated } from "$lib/gavinState";
  import { orchestrations, sendCardToRailAction } from "$lib/orchestrationState";
  import { placeCardAtColumnEnd } from "$lib/planDrop";
  import type { MergedBoard } from "$lib/boardSearch";
  import {
    agentActionToApply,
    availableAgentActions,
    buildCreatePlanArgs,
    composeHint,
    composeCloseAction,
    composeKeyAction,
    composedCardView,
    composeWindowKeyAction,
    railToApply,
    toggleAgentAction,
    AGENT_ACTION_LABELS,
    COMPOSE_KINDS,
    DEFAULT_COMPOSE_KIND,
    type AgentAction,
    type ComposeField,
    type ComposeKind,
  } from "$lib/cardCompose";
  import {
    addAttachment,
    attachmentFromPick,
    attachmentName,
    removeAttachment,
  } from "$lib/attachments";
  import { autoCommitAppliesTo } from "$lib/autoCommit";
  import {
    COMPLEXITY_LABELS,
    COMPLEXITY_LEVELS,
    NO_COMPLEXITY,
    parseComplexity,
  } from "$lib/complexity";
  import { daemonCompat, newCardAutoCommit, stampCardReview, workspaceRootPath } from "$lib/layoutState";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { formatShortcut } from "$lib/shortcuts";
  import { isMacSync } from "$lib/platform";
  import * as backend from "$lib/backend";

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
    /// The board's own merged projection, UNFILTERED, and -- on a
    /// page-scoped board -- the page's view of it. A filed card is given
    /// an `order:` that puts it at the END of the column it was filed
    /// into, and that slot is measured against these two (composeSlot).
    /// Null on either leaves the card unordered, which is where a new
    /// card used to land: somewhere in the column's alphabetical tail.
    merged?: MergedBoard | null;
    scoped?: MergedBoard | null;
    /// Offered only when the board can actually run a card.
    onRunCard?: ((card: CardView) => void | Promise<void>) | null;
    /// The other half of the Agent actions group: hand the card straight
    /// to the gavin-develop skill. Separate prop rather than a mode on
    /// `onRunCard` because it is a different launch -- no In Progress
    /// write, no card<->session binding, and a refusal where a run would
    /// jump (cardRunActions.ts) -- and a board that offers one may not
    /// offer the other.
    onDevelopCard?: ((card: CardView) => void | Promise<void>) | null;
    onClose: () => void;
  }
  let {
    workspaceId,
    columns,
    initialStatus,
    pinnedContext = null,
    pageRails = null,
    merged = null,
    scoped = null,
    onRunCard = null,
    onDevelopCard = null,
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
  // Seeded ONCE from the resolved default -- this workspace's setting,
  // else the app-wide one, else off -- with `get` rather than `$store` so
  // a settings change mid-compose cannot flip a box the human has already
  // ticked. Survives `reset()` for the same reason railId does: filing a
  // run of cards that all need committing is one tick, not one per card.
  let autoCommit = $state(get(newCardAutoCommit));
  // How hard the card is, if the human says. Survives `reset()` like
  // `autoCommit` and `railId` above, and for the same reason: filing a
  // run of cards of the same difficulty is one choice, not one per card.
  // Empty means unrated, which is the absence of the line rather than a
  // sixth level -- an unrated card runs the workspace's own agent.
  let complexity = $state<string>(NO_COMPLEXITY);
  // The one thing an agent is asked to do with the card as it is filed,
  // or null for the ordinary case: file it and leave it alone. Cleared
  // after every commit rather than surviving `reset()` like the settings
  // above it -- autoCommit and the level describe the card, while this
  // starts an agent, and inheriting that silently onto the next card
  // typed into the same open composer is a session nobody asked for.
  let agentAction = $state<AgentAction | null>(null);
  let error = $state<string | null>(null);
  let titleEl = $state<HTMLTextAreaElement | null>(null);
  // Drives the footer hint only: which key files a card depends on
  // where the caret is, so the hint has to follow the caret.
  let focusField = $state<ComposeField>("title");
  // Raised by a dismissal gesture over a composer with something in it.
  // The confirm is a sibling modal, drawn over this one, so this flag is
  // also what tells this modal's own key handlers to keep their hands
  // off while the question is on screen.
  let confirmingDiscard = $state(false);
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
  // Exactly the same hole, one version later: a v30 daemon parses
  // CreatePlan happily and drops `complexity` on the floor, so the card
  // would be filed looking rated and run at the workspace's default
  // agent. Nothing on the wire catches that either.
  const complexityBlocked = $derived(featureBlockedReason($daemonCompat, "complexity"));
  // Which boxes the Agent actions group draws at all -- the kind, the
  // rail and what this board handed the composer. Empty takes the whole
  // group off screen: a heading over nothing is a control that looks
  // broken.
  const agentActions = $derived(
    availableAgentActions({
      kind,
      railId,
      canRun: onRunCard !== null,
      canDevelop: onDevelopCard !== null,
    })
  );
  const isMac = isMacSync();

  async function pickAttachment(): Promise<void> {
    attachmentsError = null;
    const root = workspaceRootPath(workspaceId);
    if (root === null) {
      attachmentsError = "This workspace has no root folder, so an attachment has nothing to be relative to.";
      return;
    }
    try {
      const picked = await pickPath({
        directory: false,
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

  // Every way out of the composer that is not "file the card" -- the
  // backdrop, Escape (both via Modal), and the Cancel button. Nothing
  // typed here exists anywhere else yet, and the composer reopens empty,
  // so a gesture that would throw the fields away asks first. An
  // untouched composer closes on the gesture itself: a confirm with
  // nothing to lose is only a second click.
  function requestClose(): void {
    // Escape reaches BOTH modals -- each Modal listens at the window --
    // so without this the composer would re-raise the question the
    // confirm is cancelling.
    if (confirmingDiscard) return;
    if (composeCloseAction({ title, body, attachments }) === "close") onClose();
    else confirmingDiscard = true;
  }

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
      { kind, title, body, status, attachments, autoCommit, complexity },
      ctx?.plans.map((p) => p.fileName) ?? []
    );
    if ("error" in args) {
      // An empty title with the Add button is a plain "nothing to do":
      // close rather than scold. Empty on Enter stays open and says why.
      // Through requestClose, because a card can carry a typed prompt or
      // an attachment with no title yet -- and that is content this
      // button would otherwise drop on the floor.
      if (title.trim() !== "" || keepOpen) error = args.error;
      else requestClose();
      return;
    }
    // Re-measured rather than trusted from the checkbox, exactly as the
    // rail below is: switching the kind chip hides a box without
    // clearing what it set, and a card launched by a control nobody can
    // see is the worst kind of surprise agent. Taken HERE, with `args`,
    // rather than after the writes: the pickers stay live while the card
    // is being written, and a chip switched in that window must not
    // cancel an action the human already asked for on this card. The
    // view it is handed carries the level, so a card filed at
    // "intricate" and acted on in the same gesture reaches the agent
    // that level names rather than the workspace's default.
    const action = agentActionToApply(agentAction, agentActions);
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
        args.attachments,
        args.complexity
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
        complexity: parseComplexity(args.complexity),
        checklistDone: 0,
        checklistTotal: 0,
        parseWarning: false,
      };
      patchPlanCreated(workspaceId, contextFolder, created);
      // Pre-approved by the act of writing it (`cardReview.ts`). The
      // first-Run review exists because a card's body is an agent's
      // prompt and cards arrive with the repository -- but this card did
      // not arrive with anything, it was typed here a second ago. Asking
      // the human to review their own sentence is how a gate becomes a
      // reflex click, and a reflex click is worth nothing on the card
      // that DID arrive with the clone.
      //
      // Stamped from `args`, which is exactly what was written to disk,
      // rather than by reading the file back: the write has already
      // happened and a failed read here would leave the human being asked
      // about their own card.
      void stampCardReview(workspaceId, path, {
        title: args.title,
        body: args.body ?? "",
        attachments: [...attachments],
      });
      // A card carries no `order:`, and unordered cards sort into an
      // alphabetical tail -- so without this the card the human just
      // typed appears wherever its file name falls. Placed at the end of
      // the column it was filed into instead, which is where they were
      // looking. Reads `merged` AFTER the optimistic patch on purpose:
      // the new card is filtered back out of its own block, so the block
      // is the one the human is about to see either way.
      const placeError = await placeCardAtColumnEnd(workspaceId, path, args.status, merged, scoped);
      // Before Run now, so a failure to place the card is not buried
      // under a spawning agent.
      const rail = railToApply(
        args.kind,
        railId,
        rails.map((r) => r.id)
      );
      const railError = rail ? await sendCardToRailAction(workspaceId, rail, path) : null;
      if (action) {
        const ctxName = ctx?.name ?? contextFolder.split("/").at(-1) ?? contextFolder;
        const view = composedCardView(args, path, contextFolder, ctxName, attachments);
        void (action === "run" ? onRunCard?.(view) : onDevelopCard?.(view));
      }
      added += 1;
      reset();
      // The card IS created; the rail or its placement is what failed.
      // Said after the reset so the next card starts from a clean field
      // but the human still learns this one is sitting off the rails --
      // the worse of the two, since a card off the rail leaves a
      // page-scoped board entirely while a misplaced one is merely in
      // the wrong row.
      if (railError) error = `Card created, but it isn't on the rail: ${railError}`;
      else if (placeError) error = `Card created, but not at the end of the column: ${placeError}`;
      agentAction = null;
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
    // Focus stays in this field while the discard confirm sits over the
    // modal, so a bare Enter would file the very card the human is being
    // asked about, leaving the question up over a composer that has
    // already emptied itself.
    if (confirmingDiscard) return;
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
    // The confirm is the modal in front; the chord is not the
    // composer's to act on while a question about it is unanswered.
    if (confirmingDiscard) return;
    if (composeWindowKeyAction(e, isMac) !== "commit") return;
    e.preventDefault();
    void commit(true);
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<Modal onClose={requestClose}>
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
            // now -- or rewriting the card the rail is about to run --
            // would put two agents on one card.
            if (railId) agentAction = null;
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
    <!-- The blocked reason rides the LABEL, not the select: tooltip.ts
         binds mouseenter, which a disabled element never fires. -->
    <label class="field" title={complexityBlocked ?? undefined}>
      <span>Complexity</span>
      <select
        bind:value={complexity}
        disabled={complexityBlocked !== null}
        onfocus={() => (focusField = "body")}
        onkeydown={(e) => handleKeydown("body", e)}
      >
        <!-- Not a sixth level: the absence of the line, which runs this
             workspace's own agent rather than a level's. -->
        <option value={NO_COMPLEXITY}>unrated</option>
        {#each COMPLEXITY_LEVELS as level (level)}
          <option value={level} title={COMPLEXITY_LABELS[level].hint}
            >{COMPLEXITY_LABELS[level].label.toLowerCase()}</option
          >
        {/each}
      </select>
    </label>
  </div>

  <!-- Said out loud rather than left on the label's `title`. A disabled
       select is a control the human has already decided is broken -- it
       is the reason this card was filed -- and nobody hovers a broken
       control waiting for a tooltip to explain it. The greyed picker
       says THAT it is off; this says why, and what lifts it. -->
  {#if complexityBlocked}
    <div class="field-note">{complexityBlocked}</div>
  {/if}

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

  {#if autoCommitAppliesTo(kind)}
    <label class="check-row">
      <input
        type="checkbox"
        bind:checked={autoCommit}
        onfocus={() => (focusField = "body")}
        onkeydown={(e) => handleKeydown("body", e)}
      />
      Auto commit — ask the agent to commit when it finishes
    </label>
  {/if}

  <!-- Grouped, because they are one question with three answers --
       develop it, run it, or neither -- and two loose checkboxes read as
       two independent switches that could both be on. Checkboxes rather
       than radios so "neither" stays reachable: a radio group cannot be
       un-picked, and filing a card with no agent on it is the ordinary
       case. -->
  {#if agentActions.length > 0}
    <fieldset class="agent-actions">
      <legend>Agent actions</legend>
      {#each agentActions as action (action)}
        <label class="check-row" title={AGENT_ACTION_LABELS[action].hint}>
          <input
            type="checkbox"
            checked={agentAction === action}
            onchange={() => (agentAction = toggleAgentAction(agentAction, action))}
            onfocus={() => (focusField = "body")}
            onkeydown={(e) => handleKeydown("body", e)}
          />
          {AGENT_ACTION_LABELS[action].label}
        </label>
      {/each}
    </fieldset>
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
      <button type="button" class="cancel" onclick={requestClose}>Cancel</button>
      <button type="button" class="add" onclick={() => void commit(false)}>Add card</button>
    </div>
  </div>
</Modal>

{#if confirmingDiscard}
  <ConfirmPrompt
    title="Discard this card?"
    lines={[
      "The card has not been created — nothing is written until it is filed.",
      "The title, the body and any attachments picked here are lost.",
    ]}
    choices={[{ label: "Discard", danger: true, onPick: onClose }]}
    onCancel={() => (confirmingDiscard = false)}
  />
{/if}

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
    /* `.fields` ends with no margin of its own and separates its rows by
       6px, so with nothing here the attachments row sat 6px under the
       last select and read as one more picker in that group rather than
       as the next thing. Wider than the gap `.agent-actions` takes,
       because that group has a border doing the same job and this one
       has only the space. */
    margin-top: 12px;
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
  /* A picker the daemon version has taken away (complexity, today) is
     `disabled`, and the rules above set colour AND background
     explicitly -- which beats the UA's own greying, so the dead control
     rendered pixel-identical to the three live ones beside it. Clicking
     it did nothing and nothing on screen said why, which is exactly how
     a gated field reads as a broken one. */
  .field select:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* ...and the label with it, so the whole row reads as one dead
     control rather than a live label beside a faded box. */
  .field:has(select:disabled) span {
    opacity: 0.45;
  }
  /* Why a control above is off, and what lifts it. Muted rather than
     `.compose-error`'s warning colour: nothing the human did failed --
     the field is simply not available against this daemon. */
  .field-note {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.7em;
    margin-top: 6px;
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
  /* Shared by the two checkbox rows -- auto commit and Run now -- so
     the name says what the row IS, not which control reached for it
     first. */
  /* A bordered group rather than a heading over loose rows: the border
     is what says the two boxes answer ONE question, which is the whole
     point of the pair being mutually exclusive. Browser defaults on
     fieldset/legend are removed rather than styled over -- the inset
     border and the notched legend do not belong in this panel. */
  .agent-actions {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 10px 10px;
    margin: 10px 0 0;
    min-width: 0;
  }
  .agent-actions legend {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.75em;
    padding: 0 4px;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
    margin-top: 8px;
  }
  .check-row input {
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
