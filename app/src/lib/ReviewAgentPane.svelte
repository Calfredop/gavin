<script lang="ts">
  // The Review tab's first column: what this card IS, and who has been
  // working on it.
  //
  // Two views behind one switch, built like ReviewFilePane's diff/edit
  // group so the two ends of the row read as one control vocabulary.
  // Session is the card's agent; Plan is the card itself, drawn by
  // CardDetailModal in its `inline` form -- the same panel CardTabPane
  // mounts for a terminal's "Show plan" chip, so a card never has two
  // different detail panels. Which one is showing is a per-workspace
  // preference (reviewPrefs.ts), not per card: it says how the human is
  // reading the board, and that holds for the whole pass down the list.
  //
  // The terminal is the card's OWN session -- the agent that did the
  // work, still running -- mounted here rather than mirrored. There is
  // one xterm per session in the registry and its container is moved by
  // appendChild, so this pane borrows it while the hub is on screen and
  // TerminalPane's onMount hands it back the moment the human returns to
  // the terminal view. That is also why the mount is keyed on the
  // session id: a TerminalPane binds its session once and never re-reads
  // it, so selecting a different card has to REBUILD this rather than
  // update a prop, or fit() would report this terminal's geometry to
  // that card's agent (the contract terminalPaneSession.test.ts holds
  // every call site to).
  import { Play } from "@lucide/svelte";
  import CardDetailModal from "$lib/CardDetailModal.svelte";
  import TerminalPane from "$lib/TerminalPane.svelte";
  import { layoutState, terminalFontSizeDefault } from "$lib/layoutState";
  import { resolveTerminalFontSize } from "$lib/terminalFont";
  import { reviewCardSession } from "$lib/cardRunActions";
  import { cardSessionState } from "$lib/columnRunAction";
  import type { CardSession, Column, Label } from "$lib/kanban";
  import type { CardView } from "$lib/planBoard";
  import type { ReviewPane } from "$lib/reviewPrefs";

  interface Props {
    workspaceId: string;
    card: CardView | null;
    /// The card's binding, or null when nothing has ever run it.
    binding: CardSession | null;
    /// Which of the two views is showing, and how to change it. Owned by
    /// the tab because it is stored there; this column only draws the
    /// switch.
    pane: ReviewPane;
    onPane: (pane: ReviewPane) => void;
    /// What the detail panel needs and this column has no way to derive:
    /// the board's vocabulary, and every card in the projection so the
    /// panel's Tasks list and "Part of" row can resolve.
    columns: Column[];
    labels: Label[];
    allCards: CardView[];
    /// The panel is click-through -- a nested task, the plan it is part
    /// of -- and it moves its own card's file when a field write files
    /// it. Both come back here as the tab's selection.
    onOpenCard: (path: string) => void;
    onPathChange: (path: string) => void;
  }
  let {
    workspaceId,
    card,
    binding,
    pane,
    onPane,
    columns,
    labels,
    allCards,
    onOpenCard,
    onPathChange,
  }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  // Resolved against THIS workspace rather than through the active one,
  // for MainAgentPanel's reason: a panel that reads the size of whichever
  // workspace happens to be on screen is right only by coincidence.
  const fontSize = $derived(resolveTerminalFontSize(ws?.terminalFontSize, $terminalFontSizeDefault));

  const bound = $derived(cardSessionState($layoutState, binding));
  const sessionId = $derived(bound === "live" ? (binding?.sessionId ?? null) : null);

  // Named for what it holds rather than `pane`, which is now the prop
  // saying which of the two views is on screen.
  let terminalPane = $state<{ fit: () => void } | null>(null);
  export function fit(): void {
    terminalPane?.fit();
  }

  let starting = $state(false);
  let error = $state<string | null>(null);

  async function start(): Promise<void> {
    if (!card || starting) return;
    starting = true;
    error = null;
    try {
      error = await reviewCardSession(workspaceId, card);
    } finally {
      starting = false;
    }
  }

  // What the button says about a binding that is NOT live. Each of these
  // is a different fact about the same card, and one word for all three
  // ("Start") would claim the run never happened.
  const idle = $derived(
    bound === "interrupted"
      ? "This card's agent was a casualty of a daemon restart — its tab holds a bare shell."
      : bound === "failed"
        ? "This card's agent stopped on an error."
        : bound === "exited"
          ? "This card's agent has finished and its session is gone."
          : "Nothing has run this card."
  );
</script>

<div class="agent">
  <div class="head">
    <span class="label">{pane === "plan" ? "Plan" : "Agent"}</span>
    {#if pane === "session" && sessionId}
      <span class="live">running</span>
    {/if}
    <div class="modes" role="group" aria-label="What to show for this card">
      <button
        type="button"
        class:active={pane === "session"}
        onclick={() => onPane("session")}
      >
        Session
      </button>
      <button type="button" class:active={pane === "plan"} onclick={() => onPane("plan")}>
        Plan
      </button>
    </div>
  </div>
  {#if !card}
    <div class="none">Select a card</div>
  {:else if pane === "plan"}
    <!-- Keyed on the card: CardDetailModal reads its file in an effect
         and holds a body buffer for it, and every other host of this
         panel repoints it by writing a new path rather than by swapping
         the prop under it. -->
    <div class="plan">
      {#key card.id}
        <CardDetailModal
          {card}
          {workspaceId}
          {columns}
          {labels}
          {allCards}
          inline
          onClose={() => onPane("session")}
          {onOpenCard}
          {onPathChange}
        />
      {/key}
    </div>
  {:else if sessionId}
    <div class="terminal">
      {#key sessionId}
        <TerminalPane
          bind:this={terminalPane}
          {sessionId}
          visible={true}
          focused={false}
          {fontSize}
        />
      {/key}
    </div>
  {:else}
    <div class="idle">
      <p>{idle}</p>
      <button type="button" onclick={() => void start()} disabled={starting}>
        <Play size={13} />
        {starting ? "Starting…" : "Start agent session"}
      </button>
      <!-- Stated rather than left to be discovered: this launch is the
           one on the board that does NOT move the card, and a reviewer
           whose card vanished from the list would have no way to know
           which action did it. -->
      <!-- Names the Agents page rather than "a page of its own":
           handleAgentSessionSpawned puts the session on the workspace's
           Agents page beside every other spawned agent, and a reviewer
           told to look for a new page would not find one. -->
      <p class="hint">
        Opens on the Agents page too, with this card's context. It leaves the card where it is.
      </p>
      {#if error}<p class="error">{error}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .agent {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    /* See ReviewHubView's `.review`: the app has no root text colour, so
       a rule that names none renders black. */
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--review-head-height);
    box-sizing: border-box;
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .label {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .live {
    font-size: 0.75em;
    color: var(--accent);
  }
  /* The row's other switch, to the pixel: ReviewFilePane's diff/edit
     group. Two controls that answer the same shape of question at the
     two ends of one row have to look like one control, so the metrics
     are copied deliberately rather than approached. */
  .modes {
    display: flex;
    flex: none;
    margin-left: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .modes button {
    padding: 2px 10px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.8em;
    cursor: pointer;
  }
  .modes button + button {
    border-left: 1px solid var(--border);
  }
  .modes button.active {
    background: var(--surface-selected);
    color: var(--text);
  }
  /* Positioned for the same reason `.terminal` above is, and it is the
     same bug twice: Modal's inline backdrop is `position: absolute;
     inset: 0` -- its own comment says "the host is responsible for being
     a positioned box" -- so a static wrapper does not scroll the panel,
     it hands it `.view` and the card detail covers the whole tab
     instead of the column the switch is in. No `overflow` here: the
     panel is `height: 100%` and CardDetailModal passes `innerScroll`,
     so it scrolls its own body. */
  .plan {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  /* Positioned, and load-bearing: TerminalPane's root is `position:
     absolute; inset: 0` -- Pane.svelte stacks a pane's tabs on one
     rectangle and hides the inactive ones with `visibility`, so they
     all have to occupy it at once. A static wrapper does not make the
     terminal sit wrong, it takes it out of this column altogether and
     hands it the nearest positioned ancestor, which is `.view` in
     +page.svelte: the whole tab, painted over the card list, the
     touched files and the diff. MainAgentPanel's `.terminal` carries
     this for the same reason; absolutePaneMount.test.ts holds every
     call site to it. */
  .terminal {
    position: relative;
    flex: 1;
    min-height: 0;
    padding: 4px;
  }
  .none,
  .idle {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .idle p {
    margin: 0;
    max-width: 34ch;
  }
  .idle button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
  }
  .idle button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    font-size: 0.9em;
    opacity: 0.8;
  }
  .error {
    color: var(--danger-text);
  }
</style>
