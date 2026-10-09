<script lang="ts">
  import { Globe, MessageSquarePlus } from "@lucide/svelte";
  import TerminalPane from "$lib/terminal/TerminalPane.svelte";
  import BrowserPane from "$lib/panes/BrowserPane.svelte";
  import FollowUpQueueView from "$lib/agents/FollowUpQueueView.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/core/tooltip";
  import {
    layoutState,
    queuedInputsById,
    startMainAgent,
    stopMainAgent,
    setAgentField,
    resolvedAgentFor,
    terminalFontSizeDefault,
    mainBrowserOpen,
    mainBrowserShare,
    hideMainBrowser,
    setMainBrowserShare,
  } from "$lib/core/layoutState";
  import { DEFAULT_TERMINAL_SHARE, terminalShareFromHeight } from "$lib/hub/homeSplit";
  import { chipFor } from "$lib/panes/browserView";
  import { browserBlocked, browserViews } from "$lib/panes/browserViewState";
  import { turnVerdictById } from "$lib/agents/turnVerdictState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { resolveTerminalFontSize } from "$lib/terminal/terminalFont";
  import { queueBlockedReason, queueTip } from "$lib/agents/queuedInput";
  import { queueTargetFor } from "$lib/agents/queuedInputActions";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const sessionId = $derived(ws?.mainSessionId ?? null);
  // Resolved against THIS workspace rather than through layoutState's
  // active-workspace store: the panel is handed a workspaceId, and a panel
  // that reads the size of whichever workspace happens to be on screen
  // would be right only by coincidence.
  const fontSize = $derived(
    resolveTerminalFontSize(ws?.terminalFontSize, $terminalFontSizeDefault)
  );

  let commandDraft = $state("");
  let draftFor = $state<string | null>(null);
  $effect(() => {
    if (draftFor !== workspaceId) {
      // Resolved from config.toml + the profile table (D41), the same
      // value Settings edits. Reading $gavinTrees keeps this reactive to
      // an external config.toml edit.
      void $gavinTrees;
      commandDraft = resolvedAgentFor(workspaceId).command;
      draftFor = workspaceId;
    }
  });

  let pane = $state<{ fit: () => void } | null>(null);
  // The terminal measures itself on mount; a pane mounted in a hidden or
  // just-resized grid cell needs a nudge (the same trap CodeMirror has).
  export function fit(): void {
    pane?.fit();
  }

  // The agent's browser (`browserView.ts`). Every other terminal opens it
  // as a tab split beside it; this cell has no tab bar, so it opens as the
  // cell's lower half and the chip is what hides it again -- which is why
  // the chip stays while it is open, even once the browser has stopped.
  const browserStore = browserViews.views;
  const browserOpen = $derived(sessionId !== null && $mainBrowserOpen.has(sessionId));
  const browserChip = $derived(
    sessionId ? chipFor($browserStore[sessionId], $browserBlocked(sessionId)) : null
  );
  function toggleBrowser(): void {
    if (!sessionId) return;
    if (browserOpen) hideMainBrowser(sessionId);
    else void browserViews.openFromChip(sessionId);
  }
  // Showing, hiding or resizing it changes the terminal's height but not
  // the cell's, so HomeHubView's observer on the cell never sees it.
  let terminalEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = terminalEl;
    if (!el) return;
    const observer = new ResizeObserver(() => pane?.fit());
    observer.observe(el);
    return () => observer.disconnect();
  });

  // The divider between the terminal and the browser, kept as the
  // terminal's share of the pair -- see homeSplit.ts. Written on every
  // move: the share lives in memory, so there is no save to batch.
  const share = $derived($mainBrowserShare[workspaceId] ?? DEFAULT_TERMINAL_SHARE);
  let dragging = $state(false);

  // Window-level listeners with a buttons===0 bail-out, like every other
  // splitter here: WKWebView drops pointerup when the pointerdown target
  // leaves the DOM.
  function startDrag(e: PointerEvent): void {
    e.preventDefault();
    // The divider's own neighbours are the two halves it divides.
    const el = e.currentTarget as HTMLElement | null;
    const top = el?.previousElementSibling as HTMLElement | null;
    const bottom = el?.nextElementSibling as HTMLElement | null;
    if (!top || !bottom) return;
    const startY = e.clientY;
    const startH = top.offsetHeight;
    const total = startH + bottom.offsetHeight;
    const id = workspaceId;
    dragging = true;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      setMainBrowserShare(id, terminalShareFromHeight(startH + ev.clientY - startY, total));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragging = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function start(): void {
    void setAgentField(workspaceId, "command", commandDraft).then(() => startMainAgent(workspaceId));
  }

  // The queue reaches this panel as a dialog rather than as a split.
  // Every other terminal in the app hangs it off the tab-actions row, and
  // this one has no tab bar and no pane to split -- but it is the single
  // most important place to be able to queue, because "Send to workspace
  // agent" lands here.
  let queueOpen = $state(false);
  const queued = $derived(sessionId ? ($queuedInputsById[sessionId] ?? []) : []);
  const queueBlocked = $derived(
    sessionId
      ? queueBlockedReason(
          queueTargetFor(
            $layoutState.sessionStatusById[sessionId],
            $layoutState.interruptedSessionIds.has(sessionId),
            $turnVerdictById[sessionId] ?? null
          )
        )
      : null
  );
</script>

<div class="agent">
  <div class="head">
    <span class="label">Main agent</span>
    {#if sessionId}
      <div class="head-actions">
        {#if browserOpen || browserChip}
          <IconButton
            icon={Globe}
            label={browserOpen ? "Hide this agent's browser" : "Show this agent's browser"}
            tip={browserOpen ? "Hide this agent's browser" : browserChip?.tip}
            tone="accent"
            active={browserOpen}
            size={13}
            onclick={toggleBrowser}
          />
        {/if}
        <!-- The reason hangs on the wrapper: a disabled element never
             fires mouseenter, so it could not explain itself. -->
        <span use:tooltip={queueBlocked ?? undefined}>
          <IconButton
            icon={MessageSquarePlus}
            label="Follow-ups for this agent"
            tip={queueBlocked ?? queueTip(queued) ?? "Queue a follow-up for when this agent finishes its turn"}
            tone={queued.length > 0 ? "accent" : "default"}
            size={13}
            disabled={queueBlocked !== null}
            onclick={() => (queueOpen = true)}
          >
            {#if queued.length > 0}<span class="queue-count">{queued.length}</span>{/if}
          </IconButton>
        </span>
        <button type="button" onclick={() => void stopMainAgent(workspaceId)}>Stop</button>
      </div>
    {/if}
  </div>
  {#if sessionId}
    <div class="terminal" bind:this={terminalEl} style:flex-grow={browserOpen ? share : 1}>
      <!-- Keyed, because nothing above this panel is rebuilt when the
           workspace changes: the hub renders <activeViewDef.component>,
           which is the same HomeHubView value for every workspace, so
           switching between two workspaces that both have an agent
           running only updates props all the way down to here. A
           TerminalPane binds its session in onMount and never re-reads
           it, so without the key the pane would keep the previous
           workspace's terminal on screen while fit() reported that
           terminal's measurements to THIS workspace's session --
           resizing an agent to a geometry its program never drew for.
           Pane.svelte owes the same contract and pays it with an {#each}
           keyed by sessionId. -->
      {#key sessionId}
        <TerminalPane bind:this={pane} {sessionId} visible={true} focused={false} {fontSize} />
      {/key}
    </div>
    {#if browserOpen}
      <div
        class="divider"
        class:dragging
        role="separator"
        aria-orientation="horizontal"
        use:tooltip={"Drag to resize \u00b7 double-click to reset"}
        onpointerdown={startDrag}
        ondblclick={() => setMainBrowserShare(workspaceId, undefined)}
      ></div>
      <div class="browser" style:flex-grow={1 - share}>
        <BrowserPane {sessionId} visible={true} />
      </div>
    {/if}
  {:else}
    <div class="idle">
      <p>No agent running in this workspace.</p>
      <div class="launcher">
        <input
          bind:value={commandDraft}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === "Enter") start();
          }}
        />
        <button type="button" onclick={start}>Start main agent</button>
      </div>
      <p class="hint">Runs at the workspace root. Nothing starts on its own.</p>
    </div>
  {/if}
</div>

{#if queueOpen && sessionId}
  <FollowUpQueueView
    {sessionId}
    sessionName="Main agent"
    onClose={() => (queueOpen = false)}
  />
{/if}

<style>
  .agent {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-family: monospace;
    font-size: 0.75em;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* The number of follow-ups waiting for this agent, in the same shape
     the pane's tab-actions row uses. */
  .queue-count {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-transform: none;
  }
  .head button,
  .launcher button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
    text-transform: none;
  }
  .terminal {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
  }
  /* Under the terminal rather than beside it: the cell already shares
     its row with the summaries, and a landscape page squeezed beside a
     terminal in what is left would leave both unreadable. The two
     flex-grow factors are the divider's share. */
  .browser {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
  }
  /* The grab area, with the border between the halves drawn inside it so
     the line thickens under the pointer the way the Home divider's does. */
  .divider {
    position: relative;
    flex: 0 0 7px;
    margin: -3px 0;
    z-index: 1;
    cursor: row-resize;
  }
  .divider::before {
    content: "";
    position: absolute;
    inset: 3px 0;
    background: var(--border);
  }
  .divider:hover::before,
  .divider.dragging::before {
    inset: 2px 0;
    background: var(--border-strong);
  }
  .idle {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
    padding: 16px;
    text-align: center;
  }
  .launcher {
    display: flex;
    gap: 6px;
  }
  .launcher input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 220px;
  }
  .hint {
    font-size: 0.9em;
    opacity: 0.7;
  }
</style>
