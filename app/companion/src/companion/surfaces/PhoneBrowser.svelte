<script lang="ts">
  // An agent's browser beside its terminal (state/browser.ts). View-only,
  // as at the desk: the agent drives the browser, and nothing here sends
  // it a tap. What to draw is the desk's `paneShows` (phoneBrowser.ts);
  // this only holds the stream while it is drawn.
  import { Globe, X } from "@lucide/svelte";
  import { daemonCompat, layoutState } from "$lib/core/layoutState";
  import { PANE_NOTES } from "$lib/panes/browserView";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { attachBrowser, browserProblems, browserViews, phoneBrowserBlocked } from "$companion/state/browser";
  import { browserViewShows } from "$companion/surfaces/phoneBrowser";

  interface Props {
    sessionId: string;
    onClose: () => void;
  }
  let { sessionId, onClose }: Props = $props();

  $effect(() => attachBrowser(sessionId));

  const view = $derived($browserViews[sessionId]);
  const problem = $derived($browserProblems[sessionId] ?? null);
  const shows = $derived(
    browserViewShows(view, phoneBrowserBlocked($layoutState.workspaces, $daemonCompat, sessionId), problem)
  );
  const url = $derived(shows.kind === "frame" ? shows.url : (view?.info?.url ?? ""));
  const title = $derived(shows.kind === "frame" ? shows.frame.title : (view?.info?.title ?? ""));
</script>

<section class="browser" aria-label="This agent's browser">
  <div class="address">
    <Globe size={14} />
    <span class="url">{url || "No page yet"}</span>
    <span class="mode">View only</span>
    <span class="close">
      <IconButton icon={X} label="Hide this agent's browser" size={18} onclick={onClose} />
    </span>
  </div>
  <div class="screen">
    {#if shows.kind === "frame"}
      <img
        class:stopped={shows.stopped}
        src={`data:image/jpeg;base64,${shows.frame.data}`}
        alt={title || url || "The agent's browser"}
        draggable="false"
      />
      {#if problem}
        <p class="note over">{problem}</p>
      {:else if shows.stopped}
        <p class="note over">{PANE_NOTES.stopped}</p>
      {/if}
    {:else if shows.kind === "blocked"}
      <p class="note">{shows.reason}</p>
    {:else if shows.kind === "waiting"}
      <p class="note">{PANE_NOTES.waiting}</p>
    {:else}
      <p class="note">{PANE_NOTES.idle}</p>
    {/if}
  </div>
</section>

<style>
  /* Above the terminal while the phone is upright, its own width at the
     page's shape, and never more than half the room; beside it once the
     phone is on its side. */
  .browser {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    min-height: 0;
    max-height: 55%;
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .address {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 0 0 12px;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .url {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    font-family: monospace;
  }
  .mode {
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
  .close :global(.icon-button) {
    min-width: 44px;
    min-height: 44px;
  }
  .screen {
    position: relative;
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 0;
    aspect-ratio: 16 / 10;
    overflow: hidden;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
    -webkit-touch-callout: none;
  }
  img.stopped {
    opacity: 0.45;
  }
  .note {
    max-width: 36ch;
    margin: 0;
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .note.over {
    position: absolute;
    bottom: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    background: var(--surface-overlay);
    color: var(--text);
  }
  @media (orientation: landscape) {
    .browser {
      flex: 1 1 0;
      min-width: 0;
      max-height: none;
      border-right: 1px solid var(--border);
      border-bottom: 0;
    }
    .screen {
      flex: 1 1 auto;
      aspect-ratio: auto;
    }
  }
</style>
