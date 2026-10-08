<script lang="ts">
  // The Decisions and Review surfaces, one template for both: the cards
  // owed a decision or a human test, each answered in place with the
  // desk's own row, and "Clean stale …" in the head -- the desk's bot and
  // broom, asking first. A thin template over phoneItems.ts (the list)
  // and state/decisions.ts (the clean).
  import { Bot, BrushCleaning } from "@lucide/svelte";
  import { boardError, kanbanState } from "$lib/board/kanbanState";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import type { HumanItem, HumanItemOutcome } from "$lib/core/gavin";
  import { gavinTrees } from "$lib/core/gavinState";
  import { daemonCompat } from "$lib/core/layoutState";
  import type { Workspace } from "$lib/core/workspace";
  import type { CleanKind } from "$lib/decisions/cleanStale";
  import DecisionsItemRow from "$lib/decisions/DecisionsItemRow.svelte";
  import { answerItem } from "$companion/state/cards";
  import { cleanStale } from "$companion/state/decisions";
  import { onReconnect, reachability, shownError } from "$companion/state/reachability";
  import { openCard } from "$companion/state/workstation";
  import { recoverBoard } from "$companion/surfaces/phoneBoard";
  import { NOTHING_OWED, phoneItems } from "$companion/surfaces/phoneItems";

  interface Props {
    workspace: Workspace;
    kind: CleanKind;
  }
  let { workspace, kind }: Props = $props();

  const list = $derived(
    phoneItems(kind, {
      workspaceId: workspace.id,
      tree: $gavinTrees[workspace.id],
      board: $kanbanState[workspace.id],
      hasRoot: Boolean(workspace.rootPath),
      itemsBlockedReason: featureBlockedReason($daemonCompat, "humanItems"),
    })
  );
  const loaded = $derived(workspace.id in $gavinTrees);
  const loadError = $derived.by(() => {
    void $kanbanState;
    return shownError(boardError(workspace.id), $reachability);
  });

  $effect(() => {
    const id = workspace.id;
    if (!workspace.rootPath) return;
    return onReconnect(() => void recoverBoard(id));
  });

  let cleaning = $state(false);
  /// What the last press or answer has to say, and which card it is
  /// about: a line about one card must not sit under another.
  let problem = $state<{ card: string | null; text: string } | null>(null);
  let notice = $state<{ card: string; text: string } | null>(null);

  async function clean(): Promise<void> {
    if (cleaning) return;
    cleaning = true;
    problem = null;
    try {
      const error = await cleanStale(workspace.id, kind, list);
      if (error) problem = { card: null, text: error };
    } finally {
      cleaning = false;
    }
  }

  async function answer(cardPath: string, item: HumanItem, outcome: HumanItemOutcome): Promise<boolean> {
    problem = null;
    notice = null;
    const result = await answerItem(workspace.id, cardPath, item, outcome);
    if (result.error) problem = { card: cardPath, text: result.error };
    if (result.notice) notice = { card: cardPath, text: result.notice };
    return result.wrote;
  }
</script>

{#if !workspace.rootPath}
  <p class="note">This workspace is bound to no folder, so it has no cards.</p>
{:else if loadError}
  <p class="note problem">The board could not be read: {loadError}</p>
{:else if !loaded}
  <p class="note">Reading the cards…</p>
{:else}
  <div class="scroll">
    <div class="head">
      <span class="count">{list.summary ?? ""}</span>
      <button
        type="button"
        class="action"
        aria-label={list.cleanLabel}
        disabled={cleaning}
        onclick={() => void clean()}
      >
        <!-- The desk's bot beside the rails' Clear broom: an agent that cleans. -->
        <Bot size={16} />
        <BrushCleaning size={16} />
        <span>{list.cleanLabel}</span>
      </button>
    </div>
    {#if problem?.card === null}
      <p class="line problem" role="alert">{problem.text}</p>
    {/if}

    {#if list.blocked}
      <p class="note problem">{list.blocked}</p>
    {:else if list.cards.length === 0}
      <p class="note">{NOTHING_OWED[kind]}</p>
    {:else}
      {#each list.cards as card (card.cardPath)}
        <section class="card" aria-label={card.title}>
          <button type="button" class="open" onclick={() => openCard(card.cardPath)}>
            <span class="title">{card.title}</span>
            {#if card.status}<span class="status">{card.status}</span>{/if}
          </button>
          {#if problem && problem.card === card.cardPath}
            <p class="line problem" role="alert">{problem.text}</p>
          {/if}
          {#if notice?.card === card.cardPath}
            <p class="line notice" role="status">{notice.text}</p>
          {/if}
          <div class="items">
            {#each card.items as item (`${item.lineIndex}:${item.lineText}`)}
              <DecisionsItemRow
                {item}
                blockedReason={null}
                onAnswer={(i, outcome) => answer(card.cardPath, i, outcome)}
              />
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    padding: 0 12px calc(16px + env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .scroll .note {
    padding: 16px 4px;
  }
  .problem {
    color: var(--danger-text);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding: 12px 0 4px;
  }
  .count {
    color: var(--warning-text);
    font-size: 0.8125rem;
  }
  .action {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    opacity: 0.45;
  }
  .action:focus-visible,
  .open:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .line {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .notice {
    color: var(--text-muted);
  }
  .card {
    margin-top: 12px;
    padding: 4px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
  }
  /* The card's name opens it, over this list. */
  .open {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font-size: 0.9375rem;
    text-align: left;
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .status {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
