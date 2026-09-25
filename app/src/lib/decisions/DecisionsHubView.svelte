<script lang="ts">
  // The Decisions tab: everything in this workspace waiting on a human,
  // answered where it is read.
  //
  // The board answers "what is being worked on" and Review answers "what
  // did this work do to the checkout". This answers the question that
  // stops both of them: what is waiting on ME. Its rows are subjects
  // rather than sessions — a card carrying open items, a waiting session
  // nobody filed a card for, a rail review gate, a card nobody has read
  // — because the human's next move is about the SUBJECT, and a card
  // whose agent is also asking is one errand rather than two.
  //
  // Thin, like every other hub view: what the list is and what an answer
  // means live in decisions.ts, the writes in decisionsActions.ts, the
  // selection in decisionsState.ts. The agent column below the items is
  // Review's own ReviewAgentPane, reused as-is — a card's agent and its
  // plan are the same two things to look at here as there, and a second
  // panel would be a second vocabulary for one card.
  import { BookOpen, Check, SkipForward } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { cardSessionFor, fetchBoard, refreshBoard, kanbanState } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { attentionState, daemonCompat } from "$lib/core/layoutState";
  import { featureBlockedReason } from "$lib/core/daemonCompat";
  import { flattenCardViews, mergePlanCards, type CardView } from "$lib/core/planBoard";
  import { tooltip } from "$lib/core/tooltip";
  import { waitLabel, rowTip, REASON_LABEL, attentionInbox } from "$lib/agents/attentionInbox";
  import { revealWaitingSession } from "$lib/cards/cardRunActions";
  import { nowStore } from "$lib/agents/agentPauseState";
  import { turnVerdictById, verdictsOf } from "$lib/agents/turnVerdictState";
  import { cardIndex } from "$lib/orchestration/orchestration";
  import {
    fetchOrchestration,
    orchestrations,
    stepAttentionsByWorkspace,
  } from "$lib/orchestration/orchestrationState";
  import { toolRecords, renderLibraryFor } from "$lib/orchestration/toolsState";
  import ReviewAgentPane from "$lib/review/ReviewAgentPane.svelte";
  import DecisionsItemRow from "$lib/decisions/DecisionsItemRow.svelte";
  import {
    NOTHING_WAITING,
    decisionsList,
    resolveSelection,
    subjectAgentLine,
    subjectDetail,
    subjectTitle,
    subjectWaits,
    summaryLine,
    type DecisionCard,
    type DecisionSubject,
  } from "$lib/decisions/decisions";
  import {
    answerHumanItem,
    markGateDone,
    skipGate,
  } from "$lib/decisions/decisionsActions";
  import { decisionsPrefs, prefsFor, setDecisionsPrefs } from "$lib/decisions/decisionsState";
  import type { HumanItem, HumanItemOutcome } from "$lib/core/gavin";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // The three fetches this tab would otherwise never make, exactly as
  // the Review tab makes them. All no-op once loaded; the refresh on
  // reveal is how an item filed in another window reaches this list.
  $effect(() => {
    void fetchBoard(workspaceId);
  });
  $effect(() => {
    void refreshBoard(workspaceId);
  });
  $effect(() => {
    void fetchOrchestration(workspaceId);
  });

  const board = $derived($kanbanState[workspaceId]);
  const tree = $derived($gavinTrees[workspaceId]);
  const prefs = $derived(prefsFor($decisionsPrefs, workspaceId));

  // `attentionState` and not `layoutState`, for the hub inbox's own
  // reason: a wait the human has marked as read is no longer a reason to
  // come and look, so it leaves this list at the moment it leaves the
  // hub's. The ACTIONS read layoutState instead (see decisionsActions).
  //
  // `$nowStore` is the app's one ticker (30s), so the waits here age and
  // the list re-orders without a timer of this tab's own.
  const inbox = $derived(
    attentionInbox(
      {
        state: $attentionState,
        boards: $kanbanState,
        trees: $gavinTrees,
        orchestrations: $orchestrations,
        stepAttentions: $stepAttentionsByWorkspace,
        // `verdictsOf($turnVerdictById)`, exactly as AppHubView passes
        // it, and never the raw per-session statuses: those carry no
        // verdict at all, so an agent that asked its question in a
        // sentence rings no bell and would be in no list here.
        verdicts: verdictsOf($turnVerdictById),
        // This tab's question is "what is waiting on me", so an agent
        // that gave up and said why belongs in it. A rail behind the
        // same agent says that as a stall; the one with no rail behind
        // it is in no other list in the app.
        includeBlocked: true,
      },
      $nowStore
    )
  );

  const cards = $derived<ReadonlyMap<string, DecisionCard>>(
    new Map(
      [...cardIndex(tree)].map(([path, entry]) => [
        path,
        { plan: entry.plan, contextFolder: entry.contextFolder },
      ])
    )
  );
  const bindings = $derived<ReadonlyMap<string, string>>(
    new Map((board?.cardSessions ?? []).map((cs) => [cs.path, cs.sessionId]))
  );

  // The gate on the ITEMS and nothing else: an older daemon still lists
  // waiting sessions and rail gates perfectly well — none of that is new
  // — it simply never parsed a `Decision:` line, so the cards carrying
  // them cannot be shown. Reading that silence as "no card asks
  // anything" is the failure the compat entry exists to prevent.
  const itemsBlockedReason = $derived(featureBlockedReason($daemonCompat, "humanItems"));

  const list = $derived(
    decisionsList({
      workspaceId,
      cards,
      bindings,
      inbox,
      rails: $orchestrations[workspaceId]?.rails ?? [],
      marks: $stepAttentionsByWorkspace[workspaceId] ?? new Map(),
      tools: renderLibraryFor($toolRecords, workspaceId),
      itemsBlockedReason,
    })
  );
  const summary = $derived(summaryLine(list.summary));

  // Re-resolved against the list on every change rather than merely
  // remembered: rows leave as they are answered, so a stored id
  // routinely points at nothing and would draw an empty pane beside a
  // list with plenty in it.
  const selected = $derived(resolveSelection(list.subjects, prefs.selected));

  // ...and then written down, so the answer stops moving — ReviewHubView's
  // own reason: `resolveSelection` falls back to the first row, and the
  // first row changes as the waits age, so left underived the pane would
  // re-target itself while the human was reading it. Terminates on its
  // own: once stored, the resolver answers with the stored id for as long
  // as the list still holds it.
  $effect(() => {
    const id = selected;
    if (id === null || id === prefs.selected) return;
    untrack(() => setDecisionsPrefs(workspaceId, { selected: id }));
  });

  const subject = $derived<DecisionSubject | null>(
    list.subjects.find((s) => s.id === selected) ?? null
  );

  // What ReviewAgentPane needs and this tab has no other reason to
  // build: the projection's cards, so the plan panel's Tasks list and
  // "Part of" row resolve. Deliberately every card and not the listed
  // ones — most of a card's links are to cards nobody is waiting on.
  const merged = $derived(board ? mergePlanCards(board, tree) : null);
  const allCards = $derived<CardView[]>(merged ? flattenCardViews(merged) : []);
  const cardView = $derived<CardView | null>(
    subject?.kind === "card" || subject?.kind === "unreviewed"
      ? (allCards.find((c) => c.id === subjectCardPath(subject)) ?? null)
      : null
  );
  const binding = $derived(cardView && board ? cardSessionFor(board, cardView.id) : null);

  function subjectCardPath(s: DecisionSubject): string | null {
    if (s.kind === "card") return s.cardPath;
    if (s.kind === "unreviewed") return s.cardPath;
    return null;
  }

  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state(false);

  // Both lines belong to the SUBJECT that produced them: leaving a
  // notice about one card up while the human reads another would credit
  // this row with somebody else's outcome. Tracked by id rather than by
  // object identity, because a `$state` proxy is never identical to the
  // value it wraps and a subject is rebuilt on every store emission.
  let messagesFor = $state<string | null>(null);
  $effect(() => {
    const id = selected;
    if (messagesFor === id) return;
    messagesFor = id;
    error = null;
    notice = null;
  });

  // Answers with whether the card was actually written, which is what
  // the row clears its buffers on: a refused write and a dismissed
  // prompt both have to leave the human's words where they typed them.
  async function answer(item: HumanItem, outcome: HumanItemOutcome): Promise<boolean> {
    if (subject?.kind !== "card") return false;
    error = null;
    notice = null;
    const result = await answerHumanItem(
      workspaceId,
      subject.cardPath,
      item,
      outcome,
      subject.sessionId
    );
    error = result.error;
    notice = result.notice;
    return result.wrote;
  }

  async function gate(action: (ws: string, stepId: string) => Promise<string | null>): Promise<void> {
    if (subject?.kind !== "gate" || busy) return;
    busy = true;
    error = null;
    notice = null;
    try {
      error = await action(workspaceId, subject.stepId);
    } finally {
      busy = false;
    }
  }

  // An unreviewed card's answer is to READ it, and the card's own detail
  // panel is where that review lives: it composes the exact prompt an
  // agent would receive and raises the sheet (CardDetailModal's Review
  // control). Switching the pane below to Plan puts that panel on
  // screen, rather than this tab assembling a second composer that could
  // drift from the one the launch uses.
  function openCardReview(): void {
    setDecisionsPrefs(workspaceId, { pane: "plan" });
  }

  // The row's own column tracks are pinned rather than left implicit,
  // and the two head bands are named once here so the items column and
  // the agent pane below it line up: ReviewAgentPane reads
  // `--review-head-height` for its own head, and a pane mounted outside
  // a `.review` would otherwise draw it at whatever the browser made of
  // an unset variable. See ReviewHubView's `.review` for the measured
  // numbers.
  let colsEl = $state<HTMLElement | null>(null);
  let agentPane = $state<{ fit: () => void } | null>(null);
  onMount(() => {
    if (!colsEl) return;
    const observer = new ResizeObserver(() => agentPane?.fit());
    observer.observe(colsEl);
    return () => observer.disconnect();
  });

  function select(id: string): void {
    setDecisionsPrefs(workspaceId, { selected: id });
  }

  const columns = $derived(board?.columns ?? []);
</script>

<div class="decisions">
  <div class="list">
    <div class="list-head">
      <span class="label">Waiting on you</span>
      {#if summary}<span class="count">{summary}</span>{/if}
    </div>
    <div class="rows" role="listbox" aria-label="Everything in this workspace waiting on you">
      {#if list.subjects.length === 0}
        <div class="none">{NOTHING_WAITING}</div>
      {:else}
        {#each list.subjects as row (row.id)}
          <button
            type="button"
            class="row"
            class:active={row.id === selected}
            class:quiet={!subjectWaits(row)}
            role="option"
            aria-selected={row.id === selected}
            onclick={() => select(row.id)}
          >
            <span class="row-title">{subjectTitle(row)}</span>
            <span class="row-detail">{subjectDetail(row)}</span>
            {#if row.waitedMs !== null}
              <span class="row-wait">{waitLabel(row.waitedMs, row.watched)}</span>
            {/if}
          </button>
        {/each}
      {/if}
      {#if list.itemsBlockedReason}
        <!-- Under the rows rather than instead of them: the sessions and
             gates above ARE the whole truth about themselves, and only
             the card items are missing. -->
        <div class="blocked">Decisions and human tests can't be shown: {list.itemsBlockedReason}</div>
      {/if}
    </div>
  </div>

  <div class="panes">
    <div class="strip">
      <span class="title">{subject ? subjectTitle(subject) : "Nothing selected"}</span>
      {#if subject && subject.kind !== "gate"}
        <span class="sub">{subjectDetail(subject)}</span>
      {/if}
    </div>

    <div class="cols" bind:this={colsEl}>
      <div class="items">
        <div class="head"><span class="label">What it needs</span></div>
        <div class="item-list">
          {#if !subject}
            <div class="none">Nothing to answer.</div>
          {:else if subject.kind === "card"}
            {#if list.itemsBlockedReason}
              <div class="none">{list.itemsBlockedReason}</div>
            {:else if subject.items.length === 0}
              <!-- A card row with no items is one whose AGENT is waiting.
                   The answer is in the terminal below, not here. -->
              <div class="none">
                <p>
                  This card asks nothing in writing — its agent is {REASON_LABEL[
                    subject.reason ?? "asking"
                  ].toLowerCase()}. Answer it in the session below.
                </p>
                {#if subjectAgentLine(subject)}
                  <p class="said">“{subjectAgentLine(subject)}”</p>
                {/if}
              </div>
            {:else}
              <!-- Keyed on the line INDEX, which is what gavin.ts says
                   it is for: a key within one snapshot. The line text
                   would look like the more stable choice and is the one
                   that can crash — two identical `Decision:` lines on
                   one card are legal (only a re-filed TEST is
                   de-duplicated), and a duplicate key in a keyed each
                   throws. The cost is a half-typed note lost when an
                   agent inserts a line above this one, which is the
                   cheaper of the two. -->
              {#each subject.items as item (item.lineIndex)}
                <DecisionsItemRow
                  {item}
                  blockedReason={list.itemsBlockedReason}
                  onAnswer={answer}
                />
              {/each}
            {/if}
          {:else if subject.kind === "session"}
            <div class="none">
              <p>{REASON_LABEL[subject.row.reason]} — no card is filed for this session.</p>
              {#if subjectAgentLine(subject)}
                <!-- The agent's own line. For a `blocked` row it is the
                     only thing in this pane a human can act on: the
                     label says it stopped, this says what stopped it. -->
                <p class="said">“{subjectAgentLine(subject)}”</p>
              {/if}
              <button
                type="button"
                use:tooltip={rowTip(subject.row)}
                onclick={() => void revealWaitingSession(subject.row)}
              >
                Go to the session
              </button>
            </div>
          {:else if subject.kind === "gate"}
            <div class="none">
              <p>
                Rail “{subject.railName}” is parked on this review step because it was told to be.
                Look at the work, then send the rail on.
              </p>
              <div class="gate-actions">
                <button
                  type="button"
                  disabled={busy}
                  use:tooltip={"Sends the rail past this step and says nobody ran it"}
                  onclick={() => void gate(skipGate)}
                >
                  <SkipForward size={13} />
                  Skip the step
                </button>
                <button
                  type="button"
                  disabled={busy}
                  use:tooltip={"Records the review as done work and sends the rail on"}
                  onclick={() => void gate(markGateDone)}
                >
                  <Check size={13} />
                  Mark it done
                </button>
              </div>
            </div>
          {:else}
            <div class="none">
              <p>
                Nobody has read this card's body, and a card body is the agent's prompt — so rail
                “{subject.railName}” refused to hand it over. Read what an agent would receive, then
                Retry the step on the Orchestration tab.
              </p>
              <button type="button" onclick={openCardReview}>
                <BookOpen size={13} />
                Open this card's review
              </button>
            </div>
          {/if}
          {#if error}<p class="error">{error}</p>{/if}
          {#if notice}<p class="notice">{notice}</p>{/if}
        </div>
      </div>

      <ReviewAgentPane
        bind:this={agentPane}
        {workspaceId}
        card={cardView}
        {binding}
        pane={prefs.pane}
        onPane={(next) => setDecisionsPrefs(workspaceId, { pane: next })}
        {columns}
        labels={board?.labels ?? []}
        {allCards}
        onOpenCard={(path) => select(`card:${path}`)}
        onPathChange={(path) => select(`card:${path}`)}
      />
    </div>
  </div>
</div>

<style>
  .decisions {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    /* The tab's own text colour, and the reason it has to be said at
       all: nothing in the app sets a root one, so an element with no
       `color` inherits the user agent's black — which on this ground is
       a row title at 1.1:1. Said once here so the panes below inherit
       it. See ReviewHubView's `.review`, which learned this the same
       way, and which is also where the two band heights come from:
       ReviewAgentPane reads --review-head-height for its own head, so a
       pane mounted outside a `.review` has to be given it. */
    color: var(--text);
    --review-strip-height: var(--hub-bar-height);
    --review-head-height: 28px;
  }
  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .list-head,
  .strip {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--review-strip-height);
    box-sizing: border-box;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .label {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .count,
  .sub {
    flex: none;
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "title wait" "detail wait";
    gap: 0 8px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.active {
    background: var(--surface-selected);
  }
  /* A row the agent owes, not the human: listed so it can be seen, and
     dimmed so it is not read as work waiting to be done. */
  .row.quiet .row-title {
    color: var(--text-muted);
  }
  .row-title {
    grid-area: title;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-detail {
    grid-area: detail;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.76em;
    color: var(--text-muted);
  }
  .row-wait {
    grid-area: wait;
    align-self: center;
    flex: none;
    font-size: 0.76em;
    color: var(--text-subtle);
  }
  .panes {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A grid, not two flex children: the items column is elastic and the
     agent pane holds a terminal, and only a `minmax(0, …)` track keeps a
     long line from widening the whole row instead of scrolling inside
     it. */
  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .cols > :global(*) {
    min-width: 0;
    border-left: 1px solid var(--border);
  }
  .cols > :global(*:first-child) {
    border-left: none;
  }
  .items {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    height: var(--review-head-height);
    box-sizing: border-box;
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .item-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
  }
  .none {
    padding: 6px 2px;
    color: var(--text-muted);
    font-size: 0.82em;
  }
  .rows .none {
    padding: 16px 12px;
    text-align: center;
  }
  .none p {
    margin: 0 0 8px;
  }
  /* The agent's own words, marked as a quotation rather than as more of
     gavin's prose: everything else in this pane is the app talking. */
  .none p.said {
    color: var(--text);
    font-style: italic;
    overflow-wrap: anywhere;
  }
  .none button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 1em;
    cursor: pointer;
  }
  .none button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .gate-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .blocked {
    padding: 10px 12px;
    font-size: 0.78em;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
  }
  .error {
    margin: 8px 0 0;
    font-size: 0.8em;
    color: var(--danger-text);
  }
  .notice {
    margin: 8px 0 0;
    font-size: 0.8em;
    color: var(--text-muted);
  }
</style>
