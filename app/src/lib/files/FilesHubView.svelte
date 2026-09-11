<script lang="ts">
  import { untrack } from "svelte";
  import { RefreshCw } from "@lucide/svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import {
    layoutState,
    openFileInSplit,
    retargetFileTabs,
    switchWorkspaceView,
  } from "$lib/core/layoutState";
  import * as backend from "$lib/core/backend";
  import { showAlert } from "$lib/core/dialog";
  import { confirmDestructive } from "$lib/core/confirmGate";
  import { isViewableExtension, loadViewableExtensions } from "$lib/files/fileTypes";
  import { defaultMode } from "$lib/files/fileEditing";
  import {
    DEFAULT_TREE_SHARE,
    NO_MATCH_MESSAGE,
    afterCreate,
    afterDelete,
    afterRename,
    collapseDir,
    emptyTree,
    expandDir,
    filesGridColumns,
    forgetChildren,
    isExpanded,
    isLoaded,
    joinPath,
    loadFilesMemory,
    loadedDirs,
    parentPath,
    resolveTreeShare,
    restoreTargets,
    retargetPath,
    saveFilesMemory,
    treeShareFromWidth,
    verifyRestored,
    visibleRows,
    withChildren,
    withError,
    type FileNode,
    type FileTreeState,
  } from "$lib/files/fileTree";
  import type { FileTreeMenuCallbacks } from "$lib/files/fileTreeMenu";
  import { trashPromptLines } from "$lib/files/fileTreeMenu";
  import type { IgnoreKind } from "$lib/git/gitIgnore";
  import FileTree from "$lib/files/FileTree.svelte";
  import FileEditor from "$lib/files/FileEditor.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/core/tooltip";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);

  let tree = $state<FileTreeState>(emptyTree(""));
  let selection = $state<string | null>(null);
  let query = $state("");
  let error = $state<string | null>(null);
  let share = $state(DEFAULT_TREE_SHARE);
  let dragging = $state(false);
  let reading = $state<Record<string, true>>({});
  let viewable = $state<string[]>([]);
  let composer = $state<{ dir: string; kind: "file" | "folder" } | null>(null);
  let renaming = $state<string | null>(null);
  let editor = $state<{ flush: () => Promise<void> } | null>(null);

  // Every async read carries the generation it was issued under and
  // drops its result if the tab has moved on. A token counter, never an
  // identity check: `$state` proxies objects, so comparing the tree it
  // started against would always say "different". Plain `let` -- read
  // inside the effects that write it.
  let generation = 0;
  // The (workspace, root) pair the tree currently holds. Two fields
  // rather than one joined key: a root path can contain anything a
  // filesystem allows, so any separator would be one a path could carry.
  //
  // Both are needed. A workspace SWITCH has to rebuild the tree -- two
  // workspaces parked on their Files tab share one instance of this view
  // -- and so does a workspace that was re-rooted under it.
  let loadedWorkspace: string | null = null;
  let loadedRoot: string | null = null;

  const view = $derived(visibleRows(tree, query));

  // A split needs a terminal session to anchor to; file and board tabs
  // are not sessions. Same rule as the Plans tab.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if (
        $layoutState.fileTabsById[focused] ||
        $layoutState.boardTabsById[focused] ||
        $layoutState.cardTabsById[focused]
      )
        return null;
    return focused;
  });

  // The list is a compile-time constant on the Rust side and cached in
  // fileTypes.ts, so this costs one call for the whole app.
  $effect(() => {
    void loadViewableExtensions().then((list) => (viewable = list));
  });

  // ---- reading ---------------------------------------------------------

  async function readDir(dir: string): Promise<void> {
    const rootPath = root;
    if (!rootPath) return;
    const mine = generation;
    reading = { ...reading, [dir]: true };
    try {
      const entries = await backend.listDirectory(rootPath, dir);
      if (mine !== generation) return;
      tree = withChildren(tree, dir, entries);
    } catch (e) {
      if (mine !== generation) return;
      tree = withError(tree, dir, String(e instanceof Error ? e.message : e));
    } finally {
      if (mine === generation) {
        const next = { ...reading };
        delete next[dir];
        reading = next;
      }
    }
  }

  async function toggle(node: FileNode): Promise<void> {
    if (!node.isDir) return;
    if (isExpanded(tree, node.path)) {
      tree = collapseDir(tree, node.path);
      return;
    }
    tree = expandDir(tree, node.path);
    // Lazy: one read per opened directory, and only the first time.
    // Refresh is the deliberate way to ask again.
    if (!isLoaded(tree, node.path)) await readDir(node.path);
  }

  /// Re-reads one directory. There is no watcher on the repo tree (see
  /// fileTree.ts), so this is how a folder an agent or a terminal
  /// changed catches up.
  async function refresh(dir: string): Promise<void> {
    tree = forgetChildren(tree, [dir]);
    tree = expandDir(tree, dir);
    await readDir(dir);
  }

  /// Refresh from the toolbar: every directory the tree has read, in
  /// depth order, keeping what is open open.
  async function refreshAll(): Promise<void> {
    const dirs = loadedDirs(tree).sort((a, b) => a.length - b.length);
    tree = forgetChildren(tree, dirs);
    for (const dir of dirs) await readDir(dir);
  }

  // ---- restore ---------------------------------------------------------
  //
  // `+page.svelte` renders one hub view at a time and DESTROYS it on
  // every tab switch, so without this the tree folds shut and forgets
  // the open file on each visit (planExplorer.ts reached the same
  // answer for the Plans tab).
  $effect(() => {
    const rootPath = root;
    if (workspaceId === loadedWorkspace && rootPath === loadedRoot) return;
    loadedWorkspace = workspaceId;
    loadedRoot = rootPath;
    // Untracked: `restore` runs synchronously up to its first await and
    // touches `tree`/`reading` on the way, which would otherwise make
    // this effect depend on the very state it is rebuilding.
    untrack(() => {
      generation += 1;
      composer = null;
      renaming = null;
      query = "";
      error = null;
      if (rootPath === null) {
        tree = emptyTree("");
        selection = null;
        return;
      }
      void restore(workspaceId, rootPath, generation);
    });
  });

  async function restore(ws: string, rootPath: string, mine: number): Promise<void> {
    const memory = loadFilesMemory(ws);
    const targets = restoreTargets(rootPath, memory);
    let next = emptyTree(rootPath);
    for (const dir of targets) next = expandDir(next, dir);
    tree = next;
    share = resolveTreeShare(memory.treeShare);
    selection = memory.selected;

    // Parents first, so every read finds its parent already listed.
    for (const dir of targets) {
      if (mine !== generation) return;
      await readDir(dir);
    }
    if (mine !== generation) return;

    // A remembered folder that no longer reads is dropped rather than
    // left explaining itself: the human did not ask about it just now,
    // they asked for the tab. The ROOT is exempt -- a root that cannot
    // be read is news, and the row has to say so.
    for (const dir of Object.keys(tree.errors)) {
      if (dir === rootPath) continue;
      tree = forgetChildren(collapseDir(tree, dir), [dir]);
    }
    // The selection is verified against the tree, never assumed: a file
    // deleted while the tab was away must not leave a phantom in the
    // editor pane.
    if (selection && verifyRestored(tree, selection) === "missing") selection = null;
  }

  // Written on every change rather than on the way out: nothing runs
  // before a tab switch tears this view down. Skipped until the restore
  // above has claimed this workspace, so a switch can never file one
  // workspace's tree under another's key.
  $effect(() => {
    const memory = {
      selected: selection,
      expanded: Object.keys(tree.expanded),
      treeShare: share,
    };
    if (root === null || workspaceId !== loadedWorkspace || root !== loadedRoot) return;
    saveFilesMemory(workspaceId, memory);
  });

  // ---- opening ---------------------------------------------------------

  async function open(node: FileNode): Promise<void> {
    if (node.isDir) {
      await toggle(node);
      return;
    }
    if (isViewableExtension(node.path, viewable)) {
      selection = node.path;
      return;
    }
    // Images, video, binaries, anything unrecognized: the OS's default
    // application, which is the PRD's standing rule for them.
    await backend.openPathExternally(node.path).catch((e) => {
      void showAlert({ title: `Couldn't open ${node.name}`, lines: [String(e)] });
    });
  }

  async function openInTab(node: FileNode): Promise<void> {
    if (!anchorSessionId) return;
    await switchWorkspaceView(workspaceId, "terminal");
    await openFileInSplit(anchorSessionId, node.path);
  }

  // ---- mutations -------------------------------------------------------

  function report(e: unknown): void {
    error = String(e instanceof Error ? e.message : e);
  }

  async function createEntry(name: string): Promise<void> {
    const target = composer;
    composer = null;
    if (!target || !root) return;
    error = null;
    const path = joinPath(target.dir, name);
    try {
      if (target.kind === "folder") await backend.createDirectory(root, path);
      else await backend.createFile(root, path);
    } catch (e) {
      report(e);
      return;
    }
    tree = expandDir(tree, target.dir);
    // The parent may never have been read -- creating into a folder
    // reached through the menu does not require opening it first.
    if (!isLoaded(tree, target.dir)) await readDir(target.dir);
    else tree = afterCreate(tree, path, target.kind === "folder");
    if (target.kind === "file") selection = path;
  }

  async function renameEntry(name: string): Promise<void> {
    const from = renaming;
    renaming = null;
    if (!from || !root) return;
    error = null;
    const to = joinPath(parentPath(from), name);
    if (to === from) return;
    // The editor pane holds an autosaving buffer over the OLD path.
    // Landing it BEFORE the move is what keeps the rename from racing
    // the save -- the same reason the Plans tab flushes before its
    // metadata panel rewrites a line.
    if (selection && (selection === from || selection.startsWith(`${from}/`))) {
      await editor?.flush();
    }
    try {
      await backend.renamePath(root, from, to);
    } catch (e) {
      report(e);
      return;
    }
    // Re-keyed, not re-read: re-reading would fold shut every folder
    // inside the one that just moved.
    tree = afterRename(tree, from, to);
    if (selection) selection = retargetPath(selection, from, to);
    // Every open file tab pointing into the moved path follows it, so a
    // rename never leaves a tab over a file that no longer exists.
    await retargetFileTabs(from, to);
  }

  async function trashEntry(node: FileNode): Promise<void> {
    if (!root) return;
    // confirmDestructive rather than askConfirm: the host refuses
    // trash_entry without the grant this mints, so the prompt is a
    // precondition of the command rather than a habit of this function.
    const token = await confirmDestructive("trash_entry", [node.path], {
      title: `Move ${node.name} to the Trash?`,
      lines: trashPromptLines(node),
      confirmLabel: "Move to Trash",
      // Keeps focus on the dismissing button, so Enter cannot fire it by
      // reflex.
      danger: true,
    });
    if (token === null) return;
    error = null;
    try {
      await backend.trashEntry(root, node.path, token);
    } catch (e) {
      report(e);
      return;
    }
    tree = afterDelete(tree, node.path);
    // The selection is deliberately NOT cleared. FileEditor notices the
    // file has gone and shows its "deleted" banner over the buffer it is
    // holding -- which may be the only copy of unsaved text left. Wiping
    // the pane instead would throw that away to tidy the screen.
  }

  async function copyPath(node: FileNode): Promise<void> {
    await writeText(node.path).catch((e) => report(e));
  }

  async function revealInFinder(node: FileNode): Promise<void> {
    // revealItemInDir selects the entry in its parent window, which is
    // what "Reveal" means; openPath on a folder would open the folder
    // itself and on a file would launch its application.
    await backend.revealPathExternally(node.path).catch((e) => {
      void showAlert({ title: "Couldn't reveal in Finder", lines: [String(e)] });
    });
  }

  async function ignore(kind: IgnoreKind, pattern: string): Promise<void> {
    if (!root) return;
    error = null;
    await backend.gitAddIgnorePattern(root, kind, pattern).catch((e) => report(e));
  }

  const menu = $derived<FileTreeMenuCallbacks>({
    onOpen: (node) => void open(node),
    onOpenInTab: anchorSessionId ? (node) => void openInTab(node) : null,
    onCopyPath: (node) => void copyPath(node),
    onRevealInFinder: (node) => void revealInFinder(node),
    onNewFile: (dir) => {
      renaming = null;
      composer = { dir: dir.path, kind: "file" };
    },
    onNewFolder: (dir) => {
      renaming = null;
      composer = { dir: dir.path, kind: "folder" };
    },
    onRename: (node) => {
      composer = null;
      renaming = node.path;
    },
    onTrash: (node) => void trashEntry(node),
    onRefresh: (dir) => void refresh(dir.path),
    onIgnore: (kind, pattern) => void ignore(kind, pattern),
  });

  // ---- the divider -----------------------------------------------------
  //
  // What is kept is the TREE pane's share of the pair, applied as the
  // grid's two `fr` factors, so the split holds at every pane width --
  // see splitShare.ts for why never a px width.

  // Window-level listeners with a buttons===0 bail-out, like every other
  // splitter here: WKWebView drops pointerup when the pointerdown target
  // leaves the DOM.
  function startDrag(e: PointerEvent): void {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement | null;
    const left = el?.previousElementSibling as HTMLElement | null;
    const right = el?.nextElementSibling as HTMLElement | null;
    if (!left || !right) return;
    const startX = e.clientX;
    const startW = left.offsetWidth;
    const total = startW + right.offsetWidth;
    dragging = true;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      share = treeShareFromWidth(startW + ev.clientX - startX, total);
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

  function resetSplit(): void {
    share = DEFAULT_TREE_SHARE;
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="files" style:grid-template-columns={filesGridColumns(share)}>
    <div class="tree-pane">
      <div class="tree-head">
        <SearchInput
          bind:value={query}
          label="Filter files by name"
          placeholder="Filter files…"
          matches={view.filtering ? { shown: view.shown, total: view.total } : null}
        />
        <IconButton
          icon={RefreshCw}
          label="Re-read every open folder"
          size={12}
          onclick={() => void refreshAll()}
        />
      </div>
      {#if view.filtering && view.shown === 0}
        <!-- Never a bare "no match": this filter only ever sees the
             folders that have been opened, because finding an unopened
             match would mean the recursive walk the lazy tree exists to
             avoid. -->
        <div class="empty small">{NO_MATCH_MESSAGE}</div>
      {:else}
        <FileTree
          {view}
          rootPath={root}
          selectedPath={selection}
          {reading}
          viewableExtensions={viewable}
          onToggle={(node) => void toggle(node)}
          onOpen={(node) => void open(node)}
          {menu}
          {composer}
          onComposerSubmit={(name) => void createEntry(name)}
          onComposerCancel={() => (composer = null)}
          {renaming}
          onRenameSubmit={(name) => void renameEntry(name)}
          onRenameCancel={() => (renaming = null)}
        />
      {/if}
    </div>
    <div
      class="divider"
      class:dragging
      role="separator"
      aria-orientation="vertical"
      use:tooltip={"Drag to resize · double-click to reset"}
      onpointerdown={startDrag}
      ondblclick={resetSplit}
    ></div>
    <div class="detail">
      {#if error}
        <div class="error-strip">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss" onclick={() => (error = null)}>✕</button>
        </div>
      {/if}
      {#if selection === null}
        <div class="empty">Select a file.</div>
      {:else}
        <!-- Keyed on the path so a different file is a fresh editor. A
             RENAME does not change the key twice over: retargetPath moves
             the selection, the editor remounts on the new path, and its
             buffer was flushed before the move. -->
        {#key selection}
          <FileEditor bind:this={editor} path={selection} initialMode={defaultMode(selection, "tab")} />
        {/key}
      {/if}
    </div>
  </div>
{/if}

<style>
  .files {
    display: grid;
    height: 100%;
    min-height: 0;
    /* Columns come from filesGridColumns, inline: the divider between
       them IS the gutter, so there is no column gap of its own. */
  }
  .tree-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .tree-head {
    display: flex;
    align-items: center;
    gap: 4px;
    /* Locked, not auto: SearchInput's min-height would otherwise grow
       this past the hub first-row band the Scratchpad and Kanban share. */
    flex: 0 0 var(--hub-bar-height);
    height: var(--hub-bar-height);
    min-height: 0;
    max-height: var(--hub-bar-height);
    box-sizing: border-box;
    padding: 0 6px;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  /* The grab area is the whole track; only the hairline down its middle
     ever paints, so an idle tab shows no furniture. */
  .divider {
    position: relative;
    cursor: col-resize;
  }
  .divider::before {
    content: "";
    position: absolute;
    inset: 0 2px;
    border-radius: 2px;
    background: transparent;
  }
  .divider:hover::before,
  .divider.dragging::before {
    background: var(--border-strong);
  }
  .detail {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    text-align: center;
  }
  .empty.small {
    height: auto;
    padding: 16px 8px;
  }
  .error-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border-warning);
    border-radius: 6px;
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .error-strip button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
  }
</style>
