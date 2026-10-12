<script lang="ts">
  // Adding a workspace, on a phone: the Workstation's disk a folder at a
  // time from the home folder, and a button for the folder on screen. A
  // thin template over phoneAddWorkspace.ts, the Files surface's walk
  // (phoneFiles.ts) and the desk's tree state (fileTree.ts); the add
  // itself is workstation.ts's.
  import { onMount, untrack } from "svelte";
  import { ChevronLeft, ChevronRight, File, Folder, RefreshCw } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import { gitTrackingDefault, layoutState } from "$lib/core/layoutState";
  import { emptyTree, forgetChildren, withChildren, withError, type FileTreeState } from "$lib/files/fileTree";
  import { INIT_TRACKING_LABEL, resolveGitTracking } from "$lib/git/gitTracking";
  import { addWorkspace, loadSettings, openWorkspace } from "$companion/state/workstation";
  import { browseRoot, browserListing, folderAction, hiddenNote } from "$companion/surfaces/phoneAddWorkspace";
  import { crumbs, folderAbove, folderView, omittedNote } from "$companion/surfaces/phoneFiles";

  let home = $state<string | null>(null);
  let root = $state("/");
  let dir = $state("");
  let tree = $state<FileTreeState>(emptyTree("/"));
  let problem = $state<string | null>(null);
  /// The folder whose gavin set-up is being asked about, or null.
  let asking = $state<{ folder: string; name: string } | null>(null);
  let trackInGit = $state(true);
  let busy = $state(false);
  // Every read carries the generation it began in; one that lands after a
  // newer read began is dropped. A counter, never an identity check.
  let generation = 0;

  onMount(() => {
    // The app-wide git default seeds the question's tick-box.
    void loadSettings();
    void backend
      .homeDir()
      .then((path) => {
        home = path;
        root = browseRoot(path);
        tree = emptyTree(root);
        dir = path;
      })
      .catch((e) => (problem = `This Workstation's home folder could not be found: ${String(e)}`));
  });

  async function read(target: string): Promise<void> {
    const mine = ++generation;
    try {
      const listing = await backend.listDirectory(root, target);
      if (mine !== generation) return;
      tree = withChildren(tree, target, listing.entries, listing.omitted);
    } catch (e) {
      if (mine !== generation) return;
      tree = withError(tree, target, String(e instanceof Error ? e.message : e));
    }
  }

  // Each folder is read the first time it is shown, and not again until
  // asked -- the Files surface's rule.
  $effect(() => {
    const target = dir;
    if (!target) return;
    untrack(() => {
      if (folderView(tree, target).kind === "unread") void read(target);
    });
  });

  // The strip scrolls to its end whenever the folder changes: the folder
  // on screen is the crumb that matters, and it is the last one.
  let crumbStrip = $state<HTMLElement | null>(null);
  $effect(() => {
    void dir;
    if (crumbStrip) crumbStrip.scrollLeft = crumbStrip.scrollWidth;
  });

  const folder = $derived(folderView(tree, dir));
  const listing = $derived(
    folder.kind === "listed" ? browserListing(folder.nodes, $layoutState.workspaces) : null
  );
  const trail = $derived(dir ? crumbs(root, dir) : []);
  const above = $derived(dir ? folderAbove(root, dir) : null);
  const action = $derived(folderAction(dir, root, $layoutState.workspaces));

  function enter(target: string): void {
    problem = null;
    asking = null;
    dir = target;
  }

  function reread(): void {
    problem = null;
    tree = forgetChildren(tree, [dir]);
    void read(dir);
  }

  async function add(target: string, setup: { trackInGit: boolean } | null): Promise<void> {
    busy = true;
    problem = null;
    try {
      await addWorkspace(target, setup);
    } catch (e) {
      problem = `The workspace was not added: ${e instanceof Error ? e.message : String(e)}`;
      busy = false;
    }
  }

  /// A folder gavin already lives in is added straight away; one it does
  /// not is asked about first, as the desk's "Open workspace…" asks.
  async function choose(): Promise<void> {
    if (action.kind === "open") {
      openWorkspace(action.workspaceId);
      return;
    }
    if (action.kind !== "add") return;
    const target = dir;
    const name = action.name;
    busy = true;
    problem = null;
    let scaffolded: boolean;
    try {
      scaffolded = await backend.gavinRootExists(target);
    } catch (e) {
      problem = String(e instanceof Error ? e.message : e);
      busy = false;
      return;
    }
    busy = false;
    if (scaffolded) {
      await add(target, null);
      return;
    }
    trackInGit = resolveGitTracking($gitTrackingDefault);
    asking = { folder: target, name };
  }
</script>

<div class="add">
  {#if home === null && problem === null}
    <p class="note">Finding the home folder…</p>
  {:else if dir}
    <div class="path">
      {#if above !== null}
        <button type="button" class="icon" aria-label="Up one folder" onclick={() => enter(above)}>
          <ChevronLeft size={18} />
        </button>
      {/if}
      <nav class="crumbs" aria-label="Folder" bind:this={crumbStrip}>
        {#each trail as crumb, i (crumb.path)}
          {#if i > 1}<span class="sep">/</span>{/if}
          <button type="button" class="crumb" class:here={crumb.path === dir} onclick={() => enter(crumb.path)}>
            {crumb.name}
          </button>
        {/each}
      </nav>
      {#if home && dir !== home}
        <button type="button" class="home" onclick={() => home && enter(home)}>Home</button>
      {/if}
      <button type="button" class="icon" aria-label="Read this folder again" onclick={reread}>
        <RefreshCw size={16} />
      </button>
    </div>

    <div class="list">
      {#if folder.kind === "unread"}
        <p class="note">Reading…</p>
      {:else if folder.kind === "failed"}
        <div class="note">
          <p class="problem">This folder could not be read: {folder.message}</p>
          <button type="button" class="again" onclick={reread}>Try again</button>
        </div>
      {:else if listing}
        {@const more = [omittedNote(folder.omitted), hiddenNote(listing.hidden)].filter(Boolean).join(" ")}
        {#if more}<p class="hint">{more}</p>{/if}
        {#each listing.rows as row (row.path)}
          {#if row.isDir}
            <button type="button" class="entry" onclick={() => enter(row.path)}>
              <span class="glyph"><Folder size={18} /></span>
              <span class="name">{row.name}</span>
              {#if row.workspace}<span class="chip">workspace</span>{/if}
              {#if row.symlink}<span class="meta">link</span>{/if}
              <ChevronRight size={16} />
            </button>
          {:else}
            <div class="entry file">
              <span class="glyph"><File size={18} /></span>
              <span class="name">{row.name}</span>
            </div>
          {/if}
        {:else}
          <p class="note">Nothing to show in this folder.</p>
        {/each}
      {/if}
    </div>
  {/if}

  <div class="bar">
    {#if problem}
      <p class="problem" role="alert">{problem}</p>
    {/if}
    {#if asking}
      <div class="ask">
        <p class="question">Set up gavin in {asking.name}?</p>
        <p class="detail">
          gavin keeps the board, its cards and the PRD in a .gavin-root folder here. Without it the
          workspace has terminals, Git and Files, and gets a board once it is set up.
        </p>
        <label class="check">
          <input type="checkbox" bind:checked={trackInGit} disabled={busy} />
          <span>{INIT_TRACKING_LABEL}</span>
        </label>
        <div class="acts">
          <button type="button" class="primary" disabled={busy} onclick={() => asking && void add(asking.folder, { trackInGit })}>
            {busy ? "Adding…" : "Set up and add"}
          </button>
          <button type="button" disabled={busy} onclick={() => asking && void add(asking.folder, null)}>Add as it is</button>
          <button type="button" disabled={busy} onclick={() => (asking = null)}>Back</button>
        </div>
      </div>
    {:else if action.kind !== "none"}
      <button type="button" class="primary wide" disabled={busy} onclick={() => void choose()}>
        {busy ? "Adding…" : action.label}
      </button>
    {:else if dir}
      <p class="detail">Open the folder the workspace should work in.</p>
    {/if}
  </div>
</div>

<style>
  .add {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .note p {
    margin: 0 0 12px;
  }
  .path {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    border-bottom: 1px solid var(--border);
  }
  .icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--accent-text);
  }
  .crumbs {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    font-family: monospace;
    font-size: 0.8125rem;
  }
  .crumb {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    white-space: nowrap;
  }
  .crumb.here {
    color: var(--text);
    font-weight: 600;
  }
  .sep {
    color: var(--text-subtle);
  }
  .home {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 8px;
    border: 0;
    background: none;
    color: var(--accent-text);
    font-size: 0.8125rem;
  }
  .hint {
    margin: 0;
    padding: 8px 16px;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    box-sizing: border-box;
    padding: 0 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  button.entry:active {
    background: var(--surface-hover);
  }
  .entry.file {
    min-height: 40px;
    opacity: 0.6;
  }
  .glyph {
    display: inline-flex;
    flex: 0 0 auto;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-family: monospace;
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--border-accent);
    border-radius: 999px;
    color: var(--accent-text);
    font-size: 0.6875rem;
  }
  .meta {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .bar {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .problem {
    margin: 0;
    color: var(--danger-text);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .question {
    margin: 0 0 4px;
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .detail {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .ask {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    color: var(--text);
    font-size: 0.875rem;
  }
  .check input {
    width: 22px;
    height: 22px;
    margin: 0;
    accent-color: var(--accent);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .bar button,
  .again {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .bar button.primary {
    border-color: var(--border-accent);
    background: var(--surface-accent);
    font-weight: 600;
  }
  .bar button.wide {
    width: 100%;
  }
  .bar button:disabled {
    opacity: 0.5;
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
