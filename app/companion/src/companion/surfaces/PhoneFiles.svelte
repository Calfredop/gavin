<script lang="ts">
  // One workspace's files, on a phone: a folder at a time, and a file
  // opened over it in the desk's own editor -- which reads, autosaves and
  // watches exactly as it does at the desk. A thin template over
  // phoneFiles.ts and the desk's tree state (fileTree.ts).
  import { untrack } from "svelte";
  import { ChevronLeft, ChevronRight, File, Folder, RefreshCw } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import type { Workspace } from "$lib/core/workspace";
  import FileEditor from "$lib/files/FileEditor.svelte";
  import { defaultMode } from "$lib/files/fileEditing";
  import {
    baseName,
    emptyTree,
    forgetChildren,
    formatSize,
    withChildren,
    withError,
    type FileNode,
    type FileTreeState,
  } from "$lib/files/fileTree";
  import { loadViewableExtensions } from "$lib/files/fileTypes";
  import { onReconnect } from "$companion/state/reachability";
  import type { FilesPlace } from "$companion/state/viewState";
  import {
    crumbs,
    folderAbove,
    folderView,
    omittedNote,
    startingPlace,
    stillListed,
    tapOn,
    unviewableNote,
  } from "$companion/surfaces/phoneFiles";

  interface Props {
    workspace: Workspace;
    /// Where the surface was, as the Companion's view remembers it. Read
    /// once, when the surface opens.
    place?: FilesPlace;
    /// Told every move, so the view can remember it.
    onPlace: (place: FilesPlace) => void;
  }
  let { workspace, place: remembered, onPlace }: Props = $props();

  // svelte-ignore state_referenced_locally
  const root = workspace.rootPath ?? null;
  // svelte-ignore state_referenced_locally
  let place = $state<FilesPlace>(root ? startingPlace(root, remembered) : { dir: "", file: null });
  let tree = $state<FileTreeState>(emptyTree(root ?? ""));
  let viewable = $state<string[]>([]);
  let notice = $state<string | null>(null);
  // A remembered file is checked against its folder once, the first time
  // the folder is listed: it may have gone while the phone was away. Only
  // then -- a file that goes while it is OPEN is the editor's to report,
  // over the buffer that may be the only copy of what was typed.
  // svelte-ignore state_referenced_locally
  let verifying = place.file !== null;
  // Every read carries the generation it began in, and one that finishes
  // after a newer read of the same folder began is dropped. A counter,
  // never an identity check: `$state` proxies objects.
  let generation = 0;

  const folder = $derived(folderView(tree, place.dir));
  const trail = $derived(root ? crumbs(root, place.dir) : []);

  $effect(() => {
    void loadViewableExtensions().then((list) => (viewable = list));
  });

  async function read(dir: string): Promise<void> {
    if (!root) return;
    const mine = ++generation;
    try {
      const listing = await backend.listDirectory(root, dir);
      if (mine !== generation) return;
      tree = withChildren(tree, dir, listing.entries, listing.omitted);
    } catch (e) {
      if (mine !== generation) return;
      tree = withError(tree, dir, String(e instanceof Error ? e.message : e));
    }
  }

  // The folder on screen, read again when the connection comes back -- a
  // read that failed for want of one shows its error until then.
  $effect(() =>
    onReconnect(() => {
      if (root && place.dir) void read(place.dir);
    })
  );

  // Each folder is read the first time it is shown, and not again until
  // asked: the desk's tree has no watcher either.
  $effect(() => {
    const dir = place.dir;
    if (!root || !dir) return;
    untrack(() => {
      if (folderView(tree, dir).kind === "unread") void read(dir);
    });
  });

  $effect(() => {
    if (!verifying || folder.kind === "unread") return;
    verifying = false;
    untrack(() => {
      if (!stillListed(tree, place)) place = { dir: place.dir, file: null };
    });
  });

  $effect(() => {
    const next = { dir: place.dir, file: place.file };
    untrack(() => onPlace(next));
  });

  function enter(dir: string): void {
    notice = null;
    place = { dir, file: null };
  }

  function tap(node: FileNode): void {
    notice = null;
    switch (tapOn(node, viewable)) {
      case "enter":
        enter(node.path);
        return;
      case "open":
        place = { dir: place.dir, file: node.path };
        return;
      case "unviewable":
        notice = unviewableNote(node);
        return;
    }
  }

  function reread(): void {
    notice = null;
    tree = forgetChildren(tree, [place.dir]);
    void read(place.dir);
  }

  const above = $derived(root ? folderAbove(root, place.dir) : null);
</script>

{#if !root}
  <p class="note">This workspace is bound to no folder, so it has no files to show.</p>
{:else if place.file}
  <div class="open">
    <div class="bar">
      <button type="button" class="back" onclick={() => (place = { dir: place.dir, file: null })}>
        <ChevronLeft size={18} />
        <span class="back-name">{trail.at(-1)?.name ?? "Files"}</span>
      </button>
      <span class="file-name">{baseName(place.file)}</span>
    </div>
    <div class="editor">
      {#key place.file}
        <FileEditor path={place.file} initialMode={defaultMode(place.file, "tab")} canOpenExternally={false} />
      {/key}
    </div>
  </div>
{:else}
  <div class="files">
    <div class="path">
      {#if above !== null}
        <button type="button" class="up" aria-label="Up one folder" onclick={() => enter(above)}>
          <ChevronLeft size={18} />
        </button>
      {/if}
      <nav class="crumbs" aria-label="Folder">
        {#each trail as crumb, i (crumb.path)}
          {#if i > 0}<span class="sep">/</span>{/if}
          <button
            type="button"
            class="crumb"
            class:here={crumb.path === place.dir}
            onclick={() => enter(crumb.path)}
          >
            {crumb.name}
          </button>
        {/each}
      </nav>
      <button type="button" class="up" aria-label="Read this folder again" onclick={reread}>
        <RefreshCw size={16} />
      </button>
    </div>

    {#if notice}
      <p class="notice" role="status">{notice}</p>
    {/if}

    <div class="list">
      {#if folder.kind === "unread"}
        <p class="note">Reading…</p>
      {:else if folder.kind === "failed"}
        <div class="note">
          <p class="problem">This folder could not be read: {folder.message}</p>
          <button type="button" class="again" onclick={reread}>Try again</button>
        </div>
      {:else}
        {@const more = omittedNote(folder.omitted)}
        {#if more}<p class="hint">{more}</p>{/if}
        {#each folder.nodes as node (node.path)}
          <button type="button" class="entry" onclick={() => tap(node)}>
            <span class="glyph">
              {#if node.isDir}<Folder size={18} />{:else}<File size={18} />{/if}
            </span>
            <span class="name">{node.name}</span>
            {#if node.symlink}<span class="meta">link</span>{/if}
            {#if node.isDir}
              <ChevronRight size={16} />
            {:else}
              <span class="meta">{formatSize(node.size)}</span>
            {/if}
          </button>
        {:else}
          <p class="note">Empty folder.</p>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note p {
    margin: 0 0 12px;
  }
  .problem {
    color: var(--danger-text);
    overflow-wrap: anywhere;
  }
  .files,
  .open {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .path {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
    padding: 0 max(4px, env(safe-area-inset-right)) 0 max(4px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
  }
  .up {
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
  .notice {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.8125rem;
    line-height: 1.4;
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
    padding-bottom: env(safe-area-inset-bottom);
    overflow-y: auto;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 0 max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  .entry:active {
    background: var(--surface-hover);
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
  .meta {
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .again {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .bar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 0 max(12px, env(safe-area-inset-right)) 0 max(6px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
  }
  .back {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 2px;
    min-width: 0;
    min-height: 44px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--accent-text);
    font-size: 0.875rem;
  }
  .back-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-family: monospace;
    font-size: 0.875rem;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
</style>
