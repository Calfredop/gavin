<script lang="ts">
  // One human item, with the controls that answer it.
  //
  // A component per item rather than a loop in the tab, because each row
  // carries state of its own -- the option picked, the note typed, the
  // write in flight -- and a single parent holding three maps keyed by
  // line text would lose all of it the moment the tree pushed and the
  // list re-keyed.
  //
  // Thin over decisions.ts: what an answer MEANS, what it refuses, and
  // the confirm's wording all live there. This is the markup, the local
  // buffers, and one call per button.
  import { Check, X, CircleSlash } from "@lucide/svelte";
  import { tooltip } from "$lib/core/tooltip";
  import type { HumanItem, HumanItemOutcome } from "$lib/core/gavin";
  import {
    answerOutcome,
    answerRefusal,
    failAndCloseOutcome,
    failOutcome,
    failRefusal,
    passOutcome,
  } from "$lib/decisions/decisions";

  interface Props {
    item: HumanItem;
    /// Why no control on this row may be pressed, or null. The daemon
    /// version gate: an older daemon parses no item lines at all, so
    /// there is nothing here to answer -- see FEATURE_MIN_VERSION's
    /// `humanItems`. Passed in rather than read here so the tab asks
    /// once for the whole list.
    blockedReason: string | null;
    /// Writes the outcome and tells the card's agent. Resolves to
    /// whether the card was actually WRITTEN -- false for a refused
    /// write and for a "Fail and close" prompt the human dismissed --
    /// which is what this row clears its buffers on.
    onAnswer: (item: HumanItem, outcome: HumanItemOutcome) => Promise<boolean>;
  }
  let { item, blockedReason, onAnswer }: Props = $props();

  // The option the human picked, by its own text rather than its index:
  // the card is the source of truth and an agent may rewrite the
  // `Options:` line under the tab, and an index would then silently
  // point at a different choice.
  let picked = $state<string | null>(null);
  let note = $state("");
  let busy = $state(false);

  const refusal = $derived(blockedReason ?? answerRefusal(picked, note));
  const failRefused = $derived(blockedReason ?? failRefusal(note));

  async function send(outcome: HumanItemOutcome): Promise<void> {
    if (busy) return;
    busy = true;
    let wrote = false;
    try {
      wrote = await onAnswer(item, outcome);
    } finally {
      busy = false;
    }
    // Only on a write that landed. A refused one -- an agent rewrote the
    // card under the tab -- leaves the human's words in the box, which
    // is the whole difference between "try again" and "type it again";
    // so does a "Fail and close" prompt they dismissed.
    if (!wrote) return;
    picked = null;
    note = "";
  }
</script>

<div class="item" class:failed={item.state === "failed"}>
  <div class="head">
    <span class="kind">{item.kind === "decision" ? "Decision" : "Human test"}</span>
    <span class="text">{item.text}</span>
    {#if item.state === "failed"}
      <span class="state" use:tooltip={"A failed test is owed by the agent: fix the work, then re-file the same test to re-arm it."}>
        failed · with the agent
      </span>
    {/if}
  </div>

  {#if item.latest}
    <!-- The last result line, verbatim and unparsed: the date and the
         note ARE the record, and a prettied-up version of them would be
         a second account of what happened. -->
    <p class="latest">{item.latest}</p>
  {/if}

  {#if item.kind === "decision" && item.options.length > 0}
    <div class="options" role="group" aria-label="The options this decision offers">
      {#each item.options as option (option)}
        <button
          type="button"
          class="option"
          class:picked={picked === option}
          disabled={busy || blockedReason !== null}
          onclick={() => (picked = picked === option ? null : option)}
        >
          {option}
        </button>
      {/each}
    </div>
  {/if}

  <textarea
    class="note"
    rows="2"
    placeholder={item.kind === "decision"
      ? item.options.length > 0
        ? "Why, or an answer of your own…"
        : "Your answer…"
      : "What happened (required to fail)…"}
    bind:value={note}
    disabled={busy || blockedReason !== null}
  ></textarea>

  <div class="actions">
    {#if item.kind === "decision"}
      <button
        type="button"
        class="primary"
        disabled={busy || refusal !== null}
        use:tooltip={refusal ?? ""}
        onclick={() => void send(answerOutcome(picked, note))}
      >
        <Check size={13} />
        {busy ? "Answering…" : "Answer"}
      </button>
    {:else}
      <button
        type="button"
        class="primary"
        disabled={busy || blockedReason !== null}
        use:tooltip={blockedReason ?? "The check passed — tick it and tell the agent"}
        onclick={() => void send(passOutcome())}
      >
        <Check size={13} />
        {busy ? "Working…" : "Pass"}
      </button>
      <button
        type="button"
        disabled={busy || failRefused !== null}
        use:tooltip={failRefused ??
          "Writes the failure and leaves the test owed — the agent can fix the work and re-file the same test"}
        onclick={() => void send(failOutcome(note))}
      >
        <X size={13} />
        Fail
      </button>
      <button
        type="button"
        class="danger"
        disabled={busy || failRefused !== null}
        use:tooltip={failRefused ?? "Asks first: this ticks the item, so nothing will ask for it again"}
        onclick={() => void send(failAndCloseOutcome(note))}
      >
        <CircleSlash size={13} />
        Fail and close
      </button>
    {/if}
  </div>
</div>

<style>
  .item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    /* See DecisionsHubView's own note: the app sets no root text
       colour, so a rule that names none renders black on this ground. */
    color: var(--text);
    background: var(--surface-overlay);
  }
  .item.failed {
    border-color: var(--danger);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .kind {
    flex: none;
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .text {
    min-width: 0;
    font-weight: 600;
  }
  .state {
    flex: none;
    font-size: 0.75em;
    color: var(--danger-text);
  }
  .latest {
    margin: 0;
    font-size: 0.78em;
    color: var(--text-muted);
    white-space: pre-wrap;
    /* A result note can be a pasted stack trace: it scrolls inside its
       own box rather than widening the pane, which in WKWebView would
       push the whole tab past the window. */
    overflow-x: auto;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .option {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 0.8em;
    cursor: pointer;
  }
  .option:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .option.picked {
    border-color: var(--accent);
    color: var(--accent);
  }
  .note {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: 0.85em;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 0.8em;
    cursor: pointer;
  }
  .actions button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions .primary {
    border-color: var(--accent);
    color: var(--accent);
  }
  .actions .danger {
    color: var(--danger-text);
  }
</style>
