<script lang="ts">
  // An agent's browser, live, in a pane split beside its terminal
  // (`browserView.ts`). View-only: the agent drives the browser, and
  // nothing here sends it a click or a key.
  //
  // Deliberately thin: what to draw is `paneShows`, and the stream is the
  // module's -- this only says, while it is on screen, that it wants one.
  import { Globe } from "@lucide/svelte";
  import { paneShows } from "$lib/panes/browserView";
  import { browserBlocked, browserViews } from "$lib/panes/browserViewState";
  import { tooltip } from "$lib/core/tooltip";

  interface Props {
    /// The session whose browser this is -- NOT the tab it sits in.
    sessionId: string;
    visible: boolean;
  }
  let { sessionId, visible }: Props = $props();

  // The contract every pane honors: Pane.svelte calls fit() on all of
  // them. An image scales itself.
  export function fit(): void {}

  // Only while on screen: a pane behind another tab, or on a page nobody
  // is looking at, asks the daemon for nothing.
  $effect(() => {
    if (!visible) return;
    return browserViews.attach(sessionId);
  });

  const views = browserViews.views;
  const view = $derived($views[sessionId]);
  const shows = $derived(paneShows(view, $browserBlocked(sessionId)));
  const url = $derived(shows.kind === "frame" ? shows.url : (view?.info?.url ?? ""));
  const title = $derived(shows.kind === "frame" ? shows.frame.title : (view?.info?.title ?? ""));
</script>

<div class="pane" style:display={visible ? "flex" : "none"}>
  <div class="address" use:tooltip={title || undefined}>
    <Globe size={12} />
    <span class="url">{url || "No page yet"}</span>
    <span class="mode">View only</span>
  </div>
  <div class="screen">
    {#if shows.kind === "frame"}
      <img
        class:stopped={shows.stopped}
        src={`data:image/jpeg;base64,${shows.frame.data}`}
        alt={title || url || "The agent's browser"}
        draggable="false"
      />
      {#if shows.stopped}
        <p class="note over">The browser stopped. This is the last thing it showed.</p>
      {/if}
    {:else if shows.kind === "blocked"}
      <p class="note">{shows.reason}</p>
    {:else if shows.kind === "waiting"}
      <p class="note">Waiting for the browser's first frame…</p>
    {:else}
      <p class="note">This agent's browser is not running. It starts with the agent's first browser tool call.</p>
    {/if}
  </div>
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    flex-direction: column;
    background: var(--surface-base);
    color: var(--text);
    overflow: hidden;
  }
  .address {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--text-muted);
    font-size: 12px;
  }
  .url {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    font-family: monospace;
    user-select: text;
  }
  .mode {
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
  .screen {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-sunken);
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
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
    font-size: 13px;
  }
  .note.over {
    position: absolute;
    bottom: 12px;
    padding: 6px 10px;
    border-radius: 4px;
    background: var(--surface-overlay);
    color: var(--text);
  }
</style>
