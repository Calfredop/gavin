<script lang="ts">
  // The Review tab's first column: the selected card's agent, or the one
  // button that starts one.
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
  import TerminalPane from "./TerminalPane.svelte";
  import { layoutState, terminalFontSizeDefault } from "./layoutState";
  import { resolveTerminalFontSize } from "./terminalFont";
  import { reviewCardSession } from "./cardRunActions";
  import { cardSessionState } from "./columnRunAction";
  import type { CardSession } from "./kanban";
  import type { CardView } from "./planBoard";

  interface Props {
    workspaceId: string;
    card: CardView | null;
    /// The card's binding, or null when nothing has ever run it.
    binding: CardSession | null;
  }
  let { workspaceId, card, binding }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  // Resolved against THIS workspace rather than through the active one,
  // for MainAgentPanel's reason: a panel that reads the size of whichever
  // workspace happens to be on screen is right only by coincidence.
  const fontSize = $derived(resolveTerminalFontSize(ws?.terminalFontSize, $terminalFontSizeDefault));

  const bound = $derived(cardSessionState($layoutState, binding));
  const sessionId = $derived(bound === "live" ? (binding?.sessionId ?? null) : null);

  let pane = $state<{ fit: () => void } | null>(null);
  export function fit(): void {
    pane?.fit();
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
    <span class="label">Agent</span>
    {#if sessionId}
      <span class="live">running</span>
    {/if}
  </div>
  {#if !card}
    <div class="none">Select a card</div>
  {:else if sessionId}
    <div class="terminal">
      {#key sessionId}
        <TerminalPane bind:this={pane} {sessionId} visible={true} focused={false} {fontSize} />
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
      <p class="hint">
        Opens on a page of its own, with this card's context. It leaves the card where it is.
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
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 6px;
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
  .terminal {
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
