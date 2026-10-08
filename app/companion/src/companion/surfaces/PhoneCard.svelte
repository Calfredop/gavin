<script lang="ts">
  // One card, opened from its board: what it asks of the human first, then
  // everything that can be done to it (spec, stories 46 to 48 and 51). A
  // thin template over phoneCard.ts (which card, what its bar offers) and
  // state/cards.ts (what each control does); the decision and test rows
  // are the Decisions tab's own.
  import { untrack } from "svelte";
  import { Archive, ArchiveRestore, ChevronRight } from "@lucide/svelte";
  import { verdictAttentionStatusById } from "$lib/agents/verdictAttention";
  import { cardSessionState } from "$lib/board/columnRunAction";
  import { cardSessionFor, kanbanState } from "$lib/board/kanbanState";
  import { cardSessionBar, cardSituation, primaryAction, type CardActionId } from "$lib/cards/cardDetail";
  import { childCards, parentCard } from "$lib/cards/cardRelations";
  import { parseChecklist, stripFrontmatter, type ChecklistItem } from "$lib/cards/planChecklist";
  import type { HumanItem, HumanItemOutcome } from "$lib/core/gavin";
  import { gavinTrees } from "$lib/core/gavinState";
  import { attentionStatusById, layoutState } from "$lib/core/layoutState";
  import { isArchivedCard, mergePlanCards, slugStatus } from "$lib/core/planBoard";
  import type { Workspace } from "$lib/core/workspace";
  import DecisionsItemRow from "$lib/decisions/DecisionsItemRow.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import {
    answerItem,
    archiveCard,
    followFile,
    jumpToAgent,
    launch,
    moveCard,
    renameCard,
    tickItem,
  } from "$companion/state/cards";
  import { onReconnect } from "$companion/state/reachability";
  import { closePage, followCard, openCard } from "$companion/state/workstation";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import PhoneMarkdown from "$companion/surfaces/PhoneMarkdown.svelte";
  import { cardAgent, recoverBoard } from "$companion/surfaces/phoneBoard";
  import { allCards, deviceBar, findCard, owedItems, tickableItems } from "$companion/surfaces/phoneCard";

  interface Props {
    workspace: Workspace;
    /// The card's path, as the view holds it.
    path: string;
    /// The surface the card is over, which Back returns to.
    back?: string;
  }
  let { workspace, path, back = "Board" }: Props = $props();

  const board = $derived($kanbanState[workspace.id]);
  const tree = $derived($gavinTrees[workspace.id]);
  const projection = $derived(board ? mergePlanCards(board, tree) : null);
  const card = $derived(findCard(projection, path));
  /// Kept apart from `card` so that a push which redraws the card, but
  /// leaves its file where it was, does not read the file again.
  const cardPath = $derived(card?.id ?? null);
  const everyCard = $derived(allCards(projection));
  const children = $derived(card ? childCards(card, everyCard) : []);
  const partOf = $derived(card ? parentCard(card, everyCard) : null);
  const archived = $derived(cardPath !== null && isArchivedCard(cardPath));
  const nested = $derived(card !== null && card.parent !== null && card.status === null && !card.parentBroken);
  const columns = $derived(board?.columns ?? []);
  const inColumn = $derived(
    card?.status != null && columns.some((c) => slugStatus(c.name) === slugStatus(card?.status ?? ""))
  );

  // A card the Workstation moved -- filed under done/ at the desk, say --
  // is found again by name, and the view follows it there.
  $effect(() => {
    const at = cardPath;
    if (at !== null && at !== path) untrack(() => followCard(path, at));
  });

  // ---- its file ----------------------------------------------------------
  /// Undefined while it is being read; null for a file that is not there.
  let content = $state<string | null | undefined>(undefined);
  let reading: ReturnType<typeof followFile> | null = null;
  $effect(() => {
    const at = cardPath;
    if (at === null) return;
    content = undefined;
    const r = followFile(at, (next) => (content = next));
    reading = r;
    return () => {
      r.stop();
      if (reading === r) reading = null;
    };
  });
  // The board it stands on and its file, read again when the connection
  // comes back: what changed meanwhile was pushed to nobody.
  $effect(() => {
    const id = workspace.id;
    return onReconnect(() => {
      void recoverBoard(id);
      void reading?.reread();
    });
  });
  const body = $derived(content ? stripFrontmatter(content).trim() : "");
  const checklist = $derived(content && cardPath ? tickableItems(parseChecklist(content), tree, cardPath) : []);
  const owed = $derived(cardPath ? owedItems(tree, cardPath) : []);

  // ---- its agent ---------------------------------------------------------
  const binding = $derived(card ? cardSessionFor(board, card.id) : null);
  const bar = $derived.by(() => {
    if (!card) return null;
    const phase = binding ? cardSessionState($layoutState, binding) : "none";
    return deviceBar(
      cardSessionBar(
        cardSituation({
          cardKind: card.kind,
          bestOfN: null,
          binding:
            binding && phase !== "none"
              ? { phase, status: $verdictAttentionStatusById[binding.sessionId] ?? null, orphan: false }
              : null,
          developing: false,
          canDevelop: false,
          runBlocked: false,
        })
      )
    );
  });
  const primary = $derived(primaryAction(bar));
  const badge = $derived(
    card ? cardAgent({ board, layout: $layoutState, statusById: $attentionStatusById }, card.id) : null
  );

  // ---- what the human is told ----------------------------------------------
  let problem = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state<string | null>(null);

  async function act(name: string, action: () => Promise<string | null>): Promise<void> {
    if (busy !== null) return;
    busy = name;
    problem = null;
    notice = null;
    try {
      problem = (await action()) || null;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  function runBarAction(id: CardActionId): void {
    const current = card;
    if (!current) return;
    if (id === "jump") {
      void jumpToAgent(workspace.id, current);
      return;
    }
    if (id === "run" || id === "resume" || id === "relaunch") {
      void act(id, () => launch(workspace.id, current, id));
    }
  }

  // ---- title and column ------------------------------------------------------
  let titleDraft = $state("");
  $effect(() => {
    titleDraft = card?.title ?? "";
  });
  function commitTitle(): void {
    const current = card;
    if (!current) return;
    if (titleDraft.trim() === "" || titleDraft.trim() === current.title) {
      titleDraft = current.title;
      return;
    }
    void act("rename", () => renameCard(workspace.id, current, titleDraft));
  }

  function move(event: Event & { currentTarget: HTMLSelectElement }): void {
    const current = card;
    const select = event.currentTarget;
    const column = select.value;
    if (!current || !column) return;
    void act("move", async () => {
      const error = await moveCard(workspace.id, current, column, columns);
      // Whatever did not happen is not shown as though it had.
      select.value = card?.status ?? "";
      return error;
    });
  }

  // ---- checklist, decisions and tests ----------------------------------------
  async function tick(item: ChecklistItem): Promise<void> {
    const at = cardPath;
    if (!at) return;
    await act(`tick:${item.lineIndex}`, async () => {
      const error = await tickItem(at, item);
      await reading?.reread();
      return error;
    });
  }

  async function answer(item: HumanItem, outcome: HumanItemOutcome): Promise<boolean> {
    const at = cardPath;
    if (!at) return false;
    problem = null;
    notice = null;
    const result = await answerItem(workspace.id, at, item, outcome);
    problem = result.error;
    notice = result.notice;
    return result.wrote;
  }

  function toggleArchive(): void {
    const current = card;
    if (!current) return;
    void act("archive", () => archiveCard(workspace.id, current, archived));
  }
</script>

<PhoneHeader title={card?.title ?? "Card"} {back} onBack={closePage}>
  {#snippet status()}
    {#if badge}
      <StatusBadge indicator={badge} size={14} tip={null} />
    {/if}
  {/snippet}
</PhoneHeader>

<div class="scroll">
  {#if !card}
    <p class="note">
      {projection ? "This card is no longer on the board or in its archive." : "Reading the board…"}
    </p>
  {:else}
    <div class="card">
      <p class="meta">
        <span class="kind kind-{card.kind}">{card.kind}</span>
        <span class="where">{card.contextName} · {card.fileName}</span>
      </p>

      <label class="field">
        <span class="label">Title</span>
        <input
          class="title"
          type="text"
          enterkeyhint="done"
          bind:value={titleDraft}
          disabled={busy === "rename"}
          onblur={commitTitle}
          onkeydown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
      </label>

      {#if archived}
        <p class="archived">Archived — off the board until it is restored.</p>
      {:else}
        <label class="field">
          <span class="label">Column</span>
          <select value={card.status ?? ""} disabled={busy === "move"} onchange={move}>
            {#if nested}
              <option value="">Part of {card.parentTitle}</option>
            {:else if card.status === null}
              <option value="">No column yet — the first</option>
            {:else if !inColumn}
              <option value={card.status}>{card.status} (no such column)</option>
            {/if}
            {#each columns as column (column.id)}
              <option value={column.name}>{column.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if bar}
        <section class="bar tone-{bar.tone}" class:wants-human={bar.wantsHuman} aria-label="The card's agent">
          <p class="headline">{bar.headline}</p>
          {#if bar.actions.length > 0 && !archived}
            <div class="actions">
              {#each bar.actions as action (action.id)}
                <button
                  type="button"
                  class="action"
                  class:primary={action.id === primary}
                  disabled={!action.enabled || busy !== null}
                  onclick={() => runBarAction(action.id)}
                >
                  {busy === action.id ? "Starting…" : action.label}
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      {#if problem}
        <p class="problem" role="alert">{problem}</p>
      {/if}
      {#if notice}
        <p class="notice" role="status">{notice}</p>
      {/if}

      {#if owed.length > 0}
        <section class="section" aria-label="Waiting on you">
          <h2 class="section-title">Waiting on you</h2>
          <div class="items">
            {#each owed as item (`${item.lineIndex}:${item.lineText}`)}
              <DecisionsItemRow {item} blockedReason={null} onAnswer={answer} />
            {/each}
          </div>
        </section>
      {/if}

      {#if checklist.length > 0}
        <section class="section" aria-label="Checklist">
          <h2 class="section-title">Checklist · {card.checklistDone}/{card.checklistTotal}</h2>
          <ul class="checklist">
            {#each checklist as item (item.lineIndex)}
              <li>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled={busy !== null}
                    onchange={() => void tick(item)}
                  />
                  <span class:done={item.checked}>{item.text}</span>
                </label>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if content === undefined}
        <p class="quiet">Reading the card…</p>
      {:else if body}
        <section class="section" aria-label={card.kind === "task" ? "Prompt" : "Body"}>
          <h2 class="section-title">{card.kind === "task" ? "Prompt" : "Body"}</h2>
          {#if card.kind === "task"}
            <!-- A task's body IS what its agent is handed, so it is shown
                 as written, as at the desk. -->
            <pre class="prompt">{body}</pre>
          {:else}
            <PhoneMarkdown content={body} />
          {/if}
        </section>
      {/if}

      {#if children.length > 0}
        <section class="section" aria-label="Tasks">
          <h2 class="section-title">Tasks</h2>
          <ul class="links">
            {#each children as child (child.id)}
              <li>
                <button type="button" class="link" onclick={() => openCard(child.id)}>
                  <span class="link-title">{child.title}</span>
                  <span class="link-status">{child.status ?? "nested"}</span>
                  <ChevronRight size={16} />
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if partOf}
        <section class="section" aria-label="Part of">
          <h2 class="section-title">Part of</h2>
          <button type="button" class="link" onclick={() => openCard(partOf.id)}>
            <span class="link-title">{partOf.title}</span>
            <ChevronRight size={16} />
          </button>
        </section>
      {/if}

      <div class="foot">
        <button type="button" class="action" disabled={busy !== null} onclick={toggleArchive}>
          {#if archived}<ArchiveRestore size={16} />{:else}<Archive size={16} />{/if}
          <span>{archived ? "Restore from archive" : "Archive"}</span>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px max(14px, env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom))
      max(14px, env(safe-area-inset-left));
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    min-width: 0;
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }
  .kind {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .where {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label,
  .section-title {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  /* 16px and no smaller: below it iOS zooms the page into a field the
     moment it takes focus. */
  .title,
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: 16px;
  }
  .title {
    font-weight: 600;
  }
  .title:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .archived {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .bar {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
  }
  /* The desk's bar tones (CardDetailModal's `.session-bar`). */
  .bar.tone-warning {
    border-color: var(--border-warning);
    background: var(--surface-warning);
  }
  .bar.tone-danger {
    border-color: var(--border-danger);
    background: var(--surface-danger);
  }
  .bar.tone-accent {
    border-color: var(--border-accent);
  }
  .headline {
    margin: 0;
  }
  .bar.wants-human .headline {
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action.primary {
    border-color: var(--border-accent);
    background: var(--surface-accent);
    color: var(--accent-text);
  }
  .action:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    opacity: 0.45;
  }
  .action:focus-visible,
  .link:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .problem,
  .notice {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .problem {
    color: var(--danger-text);
  }
  .notice {
    color: var(--text-muted);
  }
  .quiet {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .checklist,
  .links {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid var(--border);
    line-height: 1.4;
  }
  .check input {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin: 0;
    accent-color: var(--accent);
  }
  .check .done {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .prompt {
    margin: 0;
    padding: 10px;
    overflow-x: auto;
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .link {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 0 2px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  .link:active {
    background: var(--surface-hover);
  }
  .link-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-status {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .foot {
    display: flex;
    padding-top: 6px;
  }
</style>
