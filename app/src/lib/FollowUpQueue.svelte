<script lang="ts">
  // The follow-up queue strip: a band under a terminal showing what is
  // waiting for that session, why it is waiting, and the four things the
  // human can do about it -- compose, reorder, send now, cancel.
  //
  // It reads the stores itself rather than taking them as props, so
  // TerminalPane -- which every terminal in the app goes through, in a
  // pane and on the Home agent panel alike -- only has to know a session
  // id. Everything it decides comes from queuedInput.ts; the template
  // below chooses no wording of its own.
  import { ChevronDown, ChevronUp, MessageSquarePlus, Send, X } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { tooltip } from "./tooltip";
  import { layoutState, queuedInputsById } from "./layoutState";
  import {
    composeRefusal,
    deliveryHold,
    entryTip,
    previewLine,
    queueBlockedReason,
    queueCountLabel,
    queuedAgeLabel,
    stripVisible,
  } from "./queuedInput";
  import {
    cancelFollowUp,
    moveFollowUp,
    queueFollowUp,
    queueTargetFor,
    sendFollowUpNow,
  } from "./queuedInputActions";

  let { sessionId }: { sessionId: string } = $props();

  let composerOpen = $state(false);
  // Survives the composer closing, and that is deliberate rather than
  // incidental: it is only ever cleared on a SUCCESSFUL queue. The ⌘N
  // card composer has to ask before dropping typed content; this one
  // does not need to ask, because closing it drops nothing -- reopen and
  // the draft is still there. Clearing this on close would turn a stray
  // Escape into lost work and make a confirmation necessary.
  let draft = $state("");
  let error = $state<string | null>(null);

  const queued = $derived($queuedInputsById[sessionId] ?? []);
  // Re-stamped whenever the queue itself changes -- an arrival, a
  // delivery, a reorder, a cancel -- rather than ticked on a timer: the
  // labels are coarse to the minute, and a band only looked at while
  // something is happening does not earn an interval of its own.
  //
  // Tied to the queue rather than taken once at creation, which would be
  // worse than no stamp at all: this component lives as long as its
  // terminal, so an entry queued hours later would be measured against
  // the pane's birth and read as "just now" forever.
  const now = $derived.by(() => {
    void queued;
    return Date.now();
  });
  const target = $derived(
    queueTargetFor(
      $layoutState.sessionStatusById[sessionId],
      $layoutState.interruptedSessionIds.has(sessionId)
    )
  );
  const visible = $derived(stripVisible(target, queued.length, composerOpen));
  const hold = $derived(deliveryHold(target, queued.length));
  const count = $derived(queueCountLabel(queued.length));
  // The reason a queue cannot be TAKEN, computed against the draft so
  // the button is live the moment there is something to send. Distinct
  // from `hold`, which is about the queue that already exists.
  const refusal = $derived(composeRefusal(target, draft));
  // Not composeRefusal: this decides whether the composer may be OPENED
  // at all, and "write the follow-up first" is not a reason to withhold
  // the box you would write it in.
  const composeBlocked = $derived(queueBlockedReason(target));

  async function submit(): Promise<void> {
    const text = draft;
    error = await queueFollowUp(sessionId, target, text);
    if (error) return;
    // Cleared only on success, so a refused queue never loses what the
    // human typed.
    draft = "";
    composerOpen = false;
  }

  async function act(run: Promise<string | null>): Promise<void> {
    error = await run;
  }

  function openComposer(): void {
    error = null;
    composerOpen = true;
  }
</script>

{#if visible}
  <div class="strip">
    <div class="head">
      {#if count}<span class="count">{count}</span>{/if}
      {#if hold}<span class="hold">{hold}</span>{/if}
      <span class="spacer"></span>
      <!-- The reason hangs on this span, not on the button: tooltip.ts
           binds mouseenter, which a disabled element never fires, so a
           disabled control cannot explain itself. -->
      <span use:tooltip={composeBlocked ?? undefined}>
        <IconButton
          icon={MessageSquarePlus}
          label="Queue a follow-up"
          tip={composeBlocked ?? "Queue a follow-up for when this agent finishes its turn"}
          size={13}
          disabled={composeBlocked !== null}
          active={composerOpen}
          onclick={() => (composerOpen ? (composerOpen = false) : openComposer())}
        />
      </span>
    </div>

    {#if queued.length > 0}
      <ol class="queue">
        {#each queued as entry, index (entry.id)}
          <li class="entry">
            <span class="position">{index + 1}</span>
            <span class="text" use:tooltip={entryTip(entry, now)}>{previewLine(entry.text)}</span>
            <span class="age">{queuedAgeLabel(entry.createdAtUs, now)}</span>
            <IconButton
              icon={ChevronUp}
              label="Move this follow-up earlier"
              size={12}
              disabled={index === 0}
              onclick={() => void act(moveFollowUp(sessionId, entry.id, -1))}
            />
            <IconButton
              icon={ChevronDown}
              label="Move this follow-up later"
              size={12}
              disabled={index === queued.length - 1}
              onclick={() => void act(moveFollowUp(sessionId, entry.id, 1))}
            />
            <IconButton
              icon={Send}
              label="Send this follow-up now"
              tip="Send now, without waiting for the agent's turn to end"
              size={12}
              onclick={() => void act(sendFollowUpNow(sessionId, target, entry.id))}
            />
            <IconButton
              icon={X}
              label="Cancel this follow-up"
              tone="danger"
              size={12}
              onclick={() => void act(cancelFollowUp(sessionId, entry.id))}
            />
          </li>
        {/each}
      </ol>
    {/if}

    {#if composerOpen}
      <div class="composer">
        <!-- svelte-ignore a11y_autofocus -- the button that opens this
             band exists only to put the cursor here. -->
        <textarea
          bind:value={draft}
          autofocus
          rows="2"
          placeholder="What should this agent do when it finishes?"
          onkeydown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              // Stopped here rather than left to bubble: the app's
              // Escape handling is the modal stack, and this band is not
              // a modal -- letting it through would close whatever is
              // behind it instead.
              e.preventDefault();
              e.stopPropagation();
              composerOpen = false;
            }
          }}
        ></textarea>
        <div class="composer-actions">
          <span use:tooltip={refusal ?? undefined}>
            <IconButton
              icon={Send}
              label="Queue this follow-up"
              text="Queue"
              variant="outlined"
              tip={refusal ?? "Queue it (⌘↵) — it goes when the agent's turn ends"}
              size={12}
              disabled={refusal !== null}
              onclick={() => void submit()}
            />
          </span>
          <IconButton
            icon={X}
            label="Close the composer"
            text="Close"
            variant="outlined"
            tip="Close it — your draft is kept"
            size={12}
            onclick={() => (composerOpen = false)}
          />
        </div>
      </div>
    {/if}

    {#if error}
      <div class="error" role="alert">
        {error}
        <IconButton icon={X} label="Dismiss" size={11} onclick={() => (error = null)} />
      </div>
    {/if}
  </div>
{/if}

<style>
  .strip {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px 8px;
    background: var(--surface-raised);
    border-top: 1px solid var(--border);
    font-size: 0.78em;
    color: var(--text-muted);
    /* A long queue must not push the terminal out of the pane: the band
       carries its own scroll and stops growing. */
    max-height: 40%;
    overflow-y: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .count {
    color: var(--text);
    font-weight: 600;
    flex: none;
  }
  .hold {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .queue {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 4px;
    border-radius: 4px;
    background: var(--surface-base);
  }
  .position {
    flex: none;
    min-width: 1.2em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .entry .text {
    /* The one element that may shrink: the buttons and the age are fixed
       widths, and it is the message that should ellipsize. */
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .age {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 4px 6px;
    background: var(--surface-base);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .error {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--danger-text);
  }
</style>
