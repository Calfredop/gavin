<script lang="ts">
  // The follow-up queue for one session: what is waiting for it, why it
  // is waiting, and the four things the human can do about it -- compose,
  // reorder, send now, cancel.
  //
  // This used to be a band under every terminal, which is what it cost:
  // 32px of PTY on a working agent with nothing queued, 171px with three
  // follow-ups and the compose box open. It is a view a human asks for,
  // like the plan and the run's diff beside it in the tab-actions row, so
  // it opens the way those do -- in a split, with room to actually read a
  // queued message rather than the first 80 characters of it.
  //
  // It reads the stores itself rather than taking them as props, so both
  // hosts -- the split pane and the Home tab's agent panel, which has no
  // tab bar to hang an action on -- only have to know a session id.
  // Everything it decides comes from queuedInput.ts; the template below
  // chooses no wording of its own.
  import { ChevronDown, ChevronUp, Send, X } from "@lucide/svelte";
  import Modal from "$lib/Modal.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/tooltip";
  import { layoutState, queuedInputsById } from "$lib/layoutState";
  import {
    composeRefusal,
    deliveryHold,
    queueBlockedReason,
    queueCountLabel,
    queuedAgeLabel,
  } from "$lib/queuedInput";
  import {
    cancelFollowUp,
    moveFollowUp,
    queueFollowUp,
    queueTargetFor,
    sendFollowUpNow,
  } from "$lib/queuedInputActions";

  interface Props {
    sessionId: string;
    /// The terminal's own name, so the pane says whose queue this is.
    sessionName: string;
    /// Draw as a pane rather than as a dialog -- see Modal's own prop.
    /// The tab-actions button splits this off beside the agent it
    /// belongs to, which is the whole reason it is not a modal there.
    inline?: boolean;
    onClose: () => void;
  }
  let { sessionId, sessionName, inline = false, onClose }: Props = $props();

  // Survives a re-render for the same reason it survived the old band's
  // composer closing: it is cleared only on a SUCCESSFUL queue, so a
  // refused write never loses what the human typed.
  let draft = $state("");
  let error = $state<string | null>(null);

  const queued = $derived($queuedInputsById[sessionId] ?? []);
  // Re-stamped whenever the queue itself changes -- an arrival, a
  // delivery, a reorder, a cancel -- rather than ticked on a timer: the
  // labels are coarse to the minute, and a view only looked at while
  // something is happening does not earn an interval of its own.
  //
  // Tied to the queue rather than taken once at creation, which would be
  // worse than no stamp at all: this pane lives as long as its tab, so an
  // entry queued hours later would be measured against the tab's birth
  // and read as "just now" forever.
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
  const hold = $derived(deliveryHold(target, queued.length));
  const count = $derived(queueCountLabel(queued.length));
  // The reason a queue cannot be TAKEN, computed against the draft so the
  // button is live the moment there is something to send. Distinct from
  // `hold`, which is about the queue that already exists.
  const refusal = $derived(composeRefusal(target, draft));
  // Not composeRefusal: this decides whether the box may be written in at
  // all, and "write the follow-up first" is not a reason to disable the
  // box you would write it in.
  const composeBlocked = $derived(queueBlockedReason(target));

  async function submit(): Promise<void> {
    error = await queueFollowUp(sessionId, target, draft);
    if (error) return;
    // Cleared only on success, so a refused queue never loses what the
    // human typed.
    draft = "";
  }

  async function act(run: Promise<string | null>): Promise<void> {
    error = await run;
  }
</script>

<Modal {onClose} {inline} wide innerScroll>
  <div class="queue-view" class:inline>
    <div class="head">
      <div class="titles">
        <h2>Follow-ups</h2>
        <p class="who">{sessionName}</p>
      </div>
      {#if count}<span class="count">{count}</span>{/if}
      <!-- Modal draws no close of its own, and as a pane it answers
           neither Escape nor a click outside -- so this is the only one
           besides the tab's own X. -->
      <IconButton
        icon={X}
        label={inline ? "Close this pane" : "Close"}
        size={14}
        onclick={onClose}
      />
    </div>

    {#if hold}<p class="strip quiet">{hold}</p>{/if}
    {#if error}
      <p class="strip error" role="alert">
        {error}
        <IconButton icon={X} label="Dismiss" size={12} onclick={() => (error = null)} />
      </p>
    {/if}

    <!-- The reason hangs on this wrapper, not on the disabled control:
         tooltip.ts binds mouseenter, which a disabled element never
         fires, so a disabled control cannot explain itself. -->
    <div class="composer" use:tooltip={composeBlocked ?? undefined}>
      <!-- svelte-ignore a11y_autofocus -- only as a dialog, which the
           human opened to type in. A pane is mounted for every tab of
           its leaf, hidden ones included, so autofocus there would take
           the keyboard on behalf of a pane nobody can see. -->
      <textarea
        bind:value={draft}
        autofocus={!inline}
        rows="3"
        disabled={composeBlocked !== null}
        placeholder="What should this agent do when it finishes?"
        onkeydown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            // Stopped here rather than left to bubble: as a pane this is
            // not a modal at all, and letting Escape through would close
            // whatever is behind it instead.
            e.preventDefault();
            e.stopPropagation();
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
            size={13}
            disabled={refusal !== null}
            onclick={() => void submit()}
          />
        </span>
      </div>
    </div>

    <div class="body">
      {#if queued.length === 0}
        <p class="none">Nothing queued. What you write here is delivered when this agent's turn ends.</p>
      {:else}
        <ol class="queue">
          {#each queued as entry, index (entry.id)}
            <li class="entry">
              <span class="position">{index + 1}</span>
              <p class="text">{entry.text}</p>
              <span class="age">{queuedAgeLabel(entry.createdAtUs, now)}</span>
              <span class="entry-actions">
                <IconButton
                  icon={ChevronUp}
                  label="Move this follow-up earlier"
                  size={13}
                  disabled={index === 0}
                  onclick={() => void act(moveFollowUp(sessionId, entry.id, -1))}
                />
                <IconButton
                  icon={ChevronDown}
                  label="Move this follow-up later"
                  size={13}
                  disabled={index === queued.length - 1}
                  onclick={() => void act(moveFollowUp(sessionId, entry.id, 1))}
                />
                <IconButton
                  icon={Send}
                  label="Send this follow-up now"
                  tip="Send now, without waiting for the agent's turn to end"
                  size={13}
                  onclick={() => void act(sendFollowUpNow(sessionId, target, entry.id))}
                />
                <IconButton
                  icon={X}
                  label="Cancel this follow-up"
                  tone="danger"
                  size={13}
                  onclick={() => void act(cancelFollowUp(sessionId, entry.id))}
                />
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .queue-view {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 10px;
    height: min(60vh, 560px);
    width: min(70vw, 620px);
  }
  /* As a pane the size is the pane's, not the window's -- the same
     reason RunChangesModal caps itself only as a dialog. */
  .queue-view.inline {
    height: 100%;
    width: 100%;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .titles {
    min-width: 0;
    flex: 1;
  }
  h2 {
    margin: 0;
    font-size: 1.05em;
  }
  .who {
    margin: 2px 0 0;
    font-size: 0.78em;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex: none;
    font-size: 0.85em;
    color: var(--text);
    font-weight: 600;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 0.85em;
  }
  .quiet {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger-text);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 6px 8px;
    background: var(--surface-base);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
    font-size: 0.9em;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .none {
    margin: 0;
    font-size: 0.85em;
    color: var(--text-subtle);
  }
  .queue {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--surface-base);
    font-size: 0.85em;
  }
  .position {
    flex: none;
    min-width: 1.4em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .entry .text {
    /* The one element that may shrink, and the reason this view exists:
       the band could only ever show the first line of a follow-up cut at
       80 characters. Here the message is the message. */
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .age {
    flex: none;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .entry-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
  }
</style>
