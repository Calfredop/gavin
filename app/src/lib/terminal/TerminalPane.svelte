<script lang="ts">
  import { onMount } from "svelte";
  import { Lock } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import { lockDetail, lockTitle, takeLabel } from "$lib/core/sessionOwnership";
  import { lockBySessionId, ownerClock, ownershipViewer, takeOver } from "$lib/core/sessionOwnershipState";
  import { fitWorthTaking } from "$lib/terminal/terminalFit";
  import { getOrCreateTerminal, restoreScreen, setTerminalFontSize } from "$lib/terminal/terminalRegistry";
  import type { Terminal } from "@xterm/xterm";
  import type { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  // `sessionId` is fixed for the life of the component: onMount is what
  // binds it, and nothing below re-reads it. That is deliberate -- the
  // registry's container has to survive a tree-shape remount with its
  // scrollback intact -- but it makes recreating this pane the caller's
  // job whenever the session changes. Hand it a new id in place and it
  // keeps showing the old session while fit() reports that terminal's
  // measurements to the new one. Both call sites therefore rebuild it:
  // Pane.svelte with an {#each} keyed by sessionId, MainAgentPanel with
  // a {#key}. terminalPaneSession.test.ts holds every call site to it.
  // `lockBar`: whether this pane draws the session lock's bar itself. The
  // dim is always drawn; the Companion's terminal draws its own bar where
  // its input dock goes, and passes false.
  let {
    sessionId,
    visible,
    focused,
    fontSize,
    lockBar = true,
  }: { sessionId: string; visible: boolean; focused: boolean; fontSize: number; lockBar?: boolean } = $props();

  // The session lock (v68): another Device owns this session, so this
  // window's keystrokes are dropped (`setInputGate`) and the screen is
  // dimmed under a bar that says who has it and takes it. Scrolling and
  // selection still reach the terminal -- the dim lets the pointer through
  // -- and the bar floats over the terminal's foot rather than taking rows
  // from it: a refit here would resize the owner's PTY.
  const lock = $derived($lockBySessionId[sessionId] ?? null);
  let taking = $state(false);
  let takeError = $state<string | null>(null);

  async function take(): Promise<void> {
    taking = true;
    takeError = await takeOver(sessionId);
    taking = false;
  }

  let mountPoint: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  // $state, not a plain `let` -- this file uses runes ($props below), so a
  // plain `let` read inside the $effect further down would never establish
  // reactivity and the effect would never re-fire once this flips to true.
  let ready = $state(false);

  // Called by the parent Pane via bind:this whenever this tab's shared
  // pane rectangle changes size -- every tab in a pane gets resized
  // together, not just the active one (see Global Constraints).
  //
  // The measurement is checked BEFORE fitAddon.fit(), not after: the
  // damage is inside fit() itself (it reflows the terminal to the shape
  // FitAddon proposed), so a guard on the reported cols/rows would be too
  // late. Every caller -- this pane's own effects, Pane's ResizeObserver,
  // MainAgentPanel, HomeHubView -- comes through here, so this one check
  // covers the whole family. See fitWorthTaking for what an empty box
  // does to a running agent.
  export function fit(): Promise<void> {
    if (!ready) return Promise.resolve();
    if (!fitWorthTaking(mountPoint.clientWidth, mountPoint.clientHeight)) {
      return Promise.resolve();
    }
    fitAddon.fit();
    const { cols, rows } = term;
    return backend.resizeSession(sessionId, cols, rows).catch(() => {});
  }

  onMount(() => {
    const entry = getOrCreateTerminal(sessionId, fontSize);
    term = entry.term;
    fitAddon = entry.fitAddon;
    mountPoint.appendChild(entry.container);

    ready = true;
    // Awaited, not fired and forgotten: the daemon renders a snapshot at the
    // size it believes the PTY is, so the resize has to reach it first. Both
    // requests ride the streaming connection, which the app writes from one
    // FIFO (stream_writer.rs) and the daemon reads in order, so asking for
    // the snapshot once the resize is queued is enough to sequence them.
    void fit().then(() => restoreScreen(sessionId));
    if (focused) term.focus();
  });

  // The settings panels write a size; this is what carries it to the
  // terminal. Driven from the MOUNTED pane rather than pushed across the
  // registry because a resize is only meaningful for a terminal whose
  // container is in the document -- and an inactive tab's is: it is hidden
  // with `visibility`, so it keeps its rectangle and refits correctly
  // alongside the visible one (the same reason fit() runs for every tab in
  // a pane, not just the active one).
  //
  // The first run is a no-op: onMount already created the terminal at this
  // size, so setTerminalFontSize reports no change and no refit is owed.
  $effect(() => {
    const size = fontSize;
    if (!ready) return;
    if (setTerminalFontSize(sessionId, size)) void fit();
  });

  // Re-focus whenever this session becomes the one with keyboard focus
  // (tracked by layoutState's focusedSessionId, passed down as `focused` --
  // NOT driven by `visible` alone, which only reflects tab-bar selection
  // within a pane and can't tell "am I the pane the user is typing in").
  $effect(() => {
    if (focused && visible && ready) {
      term.focus();
    }
  });
</script>

<div class="pane" class:inactive={!visible}>
  <div class="term" bind:this={mountPoint}></div>
  {#if lock}
    <div class="lock-dim" aria-hidden="true"></div>
    {#if lockBar}
      <div class="lock-bar" role="status">
        <Lock size={14} aria-hidden="true" />
        <div class="lock-words">
          <strong>{lockTitle(lock)}</strong>
          <span>{takeError ?? lockDetail(lock, $ownerClock)}</span>
        </div>
        <button type="button" class="take" disabled={taking} onclick={() => void take()}>
          {takeLabel($ownershipViewer)}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Nothing shares this pane with the terminal any more. The follow-up
       queue used to be a band along the bottom of it, which cost the PTY
       between two and eleven rows depending on what was queued; it lives
       in its own split now, opened from the tab-actions row beside the
       plan and the run's diff. */
    display: flex;
    flex-direction: column;
  }
  .term {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .lock-dim {
    position: absolute;
    inset: 0;
    background: var(--surface-sunken);
    opacity: 0.45;
    pointer-events: none;
    z-index: 2;
  }
  .lock-bar {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.9em;
  }
  .lock-words {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lock-words strong,
  .lock-words span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lock-words span {
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .take {
    flex: none;
    background: var(--surface-accent);
    color: var(--accent-text);
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font: inherit;
  }
  .take:focus-visible {
    outline: 2px solid var(--border-accent);
    outline-offset: 1px;
  }
  .take:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
  /* Defensive: xterm.js's own selection/copy already runs through its
     internal buffer (term.getSelection(), used by clipboard.ts), not the
     browser's native selection -- so the app-wide `user-select: none`
     shouldn't affect it at all. Re-enabling it here explicitly costs
     nothing and removes any risk that some xterm-internal DOM node (e.g.
     its accessibility helpers) turns out to depend on it after all. */
  :global(.xterm),
  :global(.xterm *) {
    -webkit-user-select: text;
    user-select: text;
  }
  /* xterm sizes a cell by measuring a span of 32 "W"s it appends to its
     helpers. 6.0's xterm.css hid that span; the 6.1 beta dropped the rule,
     leaving a row of W's over every terminal's top-left corner and the
     measurement at whatever line-height it inherits. This is 6.0's rule. */
  .pane :global(.xterm-char-measure-element) {
    display: inline-block;
    visibility: hidden;
    position: absolute;
    top: 0;
    left: -9999em;
    line-height: normal;
  }
</style>
