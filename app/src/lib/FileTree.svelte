<script lang="ts">
  import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { formatSize, type FileNode, type TreeView } from "./fileTree";
  import { isViewableExtension } from "./fileTypes";
  import { openContextMenuFromEvent } from "./contextMenu";
  import { rowMenuItems, type FileTreeMenuCallbacks } from "./fileTreeMenu";

  interface Props {
    /// The rows to draw, already ordered and filtered (fileTree.ts).
    view: TreeView;
    rootPath: string;
    selectedPath: string | null;
    /// Directories with a read in flight. A row that is open, unloaded
    /// and NOT here failed or was never asked -- the three are different
    /// things and the row says which.
    reading: Record<string, true>;
    /// `viewable_extensions` from the host, so every row can say -- and
    /// the menu can label -- whether it opens here or in the OS's app,
    /// without a promise per row.
    viewableExtensions: string[];
    onToggle: (node: FileNode) => void;
    onOpen: (node: FileNode) => void;
    menu: FileTreeMenuCallbacks;
    /// The inline "new file/folder" input, under its directory's row.
    composer: { dir: string; kind: "file" | "folder" } | null;
    onComposerSubmit: (name: string) => void;
    onComposerCancel: () => void;
    /// The path being renamed, whose row becomes an input.
    renaming: string | null;
    onRenameSubmit: (name: string) => void;
    onRenameCancel: () => void;
  }
  let {
    view,
    rootPath,
    selectedPath,
    reading,
    viewableExtensions,
    onToggle,
    onOpen,
    menu,
    composer,
    onComposerSubmit,
    onComposerCancel,
    renaming,
    onRenameSubmit,
    onRenameCancel,
  }: Props = $props();

  // Inline because the level is data, not a fixed class -- same as
  // PlanTree's inset().
  const INDENT_PX = 14;
  function inset(depth: number): string {
    return `${4 + depth * INDENT_PX}px`;
  }

  // Seeded when the input appears and read on submit; the parent never
  // sees a keystroke, only the finished name.
  let draft = $state("");
  let lastEditor: string | null = null;
  $effect(() => {
    // One key for "which inline input is open": a change of either
    // re-seeds the box, so a cancelled rename cannot leak its text into
    // the next one.
    const key = composer ? `new:${composer.dir}:${composer.kind}` : renaming ? `rename:${renaming}` : null;
    if (key === lastEditor) return;
    lastEditor = key;
    draft = renaming ? (renaming.split("/").at(-1) ?? "") : "";
  });

  function submitDraft(): void {
    const name = draft.trim();
    if (!name) return;
    if (renaming) onRenameSubmit(name);
    else if (composer) onComposerSubmit(name);
  }

  function cancelDraft(): void {
    if (renaming) onRenameCancel();
    else onComposerCancel();
  }

  function openMenu(e: MouseEvent, node: FileNode): void {
    openContextMenuFromEvent(
      e,
      rowMenuItems(
        node,
        { isRoot: node.path === rootPath, viewable: isViewableExtension(node.path, viewableExtensions) },
        menu
      )
    );
  }
</script>

<div class="tree">
  {#each view.rows as row (row.node.path)}
    {@const node = row.node}
    {@const isRoot = node.path === rootPath}
    <!-- svelte-ignore a11y_no_static_element_interactions -- right-click is
         a pointer-only affordance; every action stays reachable from the
         row's own button and the tab's toolbar -->
    <div
      class="row"
      class:selected={node.path === selectedPath}
      class:root={isRoot}
      style:padding-left={inset(row.depth)}
      oncontextmenu={(e) => openMenu(e, node)}
    >
      {#if node.isDir}
        <IconButton
          icon={row.expanded ? ChevronDown : ChevronRight}
          label={row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          size={12}
          onclick={() => onToggle(node)}
        />
      {:else}
        <span class="no-chevron"></span>
      {/if}
      {#if renaming === node.path}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="inline"
          autofocus
          aria-label="New name for {node.name}"
          bind:value={draft}
          onblur={cancelDraft}
          onkeydown={(e) => {
            if (e.key === "Enter") submitDraft();
            else if (e.key === "Escape") cancelDraft();
          }}
        />
      {:else}
        <button type="button" class="entry" title={node.path} onclick={() => onOpen(node)}>
          <span class="glyph">
            {#if node.isDir}
              {#if row.expanded}<FolderOpen size={12} />{:else}<Folder size={12} />{/if}
            {:else}
              <File size={12} />
            {/if}
          </span>
          <span class="label">{isRoot ? node.name || node.path : node.name}</span>
          {#if node.symlink}
            <!-- The host reports a link as a non-directory on purpose, so
                 the tree never walks through one. The glyph says why this
                 folder-looking thing has no chevron. -->
            <span class="link" title="symlink — the tree does not follow links"><Link size={10} /></span>
          {/if}
          {#if !node.isDir}
            <span class="size">{formatSize(node.size)}</span>
          {/if}
        </button>
      {/if}
    </div>

    {#if composer && composer.dir === node.path}
      <div class="composer" style:padding-left={inset(row.depth + 1)}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="inline"
          autofocus
          aria-label={composer.kind === "folder" ? "New folder name" : "New file name"}
          placeholder={composer.kind === "folder" ? "folder name…" : "file name…"}
          bind:value={draft}
          onblur={cancelDraft}
          onkeydown={(e) => {
            if (e.key === "Enter") submitDraft();
            else if (e.key === "Escape") cancelDraft();
          }}
        />
      </div>
    {/if}

    {#if node.isDir && row.expanded}
      {#if row.error}
        <div class="note error" style:padding-left={inset(row.depth + 1)}>{row.error}</div>
      {:else if !row.loaded}
        <div class="note" style:padding-left={inset(row.depth + 1)}>
          {reading[node.path] ? "Reading…" : "Not read yet."}
        </div>
      {:else if !view.filtering && row.childCount === 0}
        <div class="note" style:padding-left={inset(row.depth + 1)}>Empty folder.</div>
      {/if}
    {/if}
  {/each}
</div>

<style>
  .tree {
    height: 100%;
    overflow: auto;
    padding: 6px 4px 12px;
    font-family: monospace;
    font-size: 0.8em;
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .row:hover {
    background: var(--surface-raised);
  }
  .row.selected {
    background: var(--surface-success);
  }
  .row.root .label {
    color: var(--success-text);
  }
  .no-chevron {
    /* Exactly the width IconButton occupies, so files line up under the
       folders beside them instead of shifting one glyph left. */
    width: 22px;
    flex: 0 0 auto;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 1px 2px;
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
  }
  .glyph {
    display: flex;
    color: var(--text-subtle);
    flex: 0 0 auto;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    display: flex;
    color: var(--text-subtle);
    flex: 0 0 auto;
  }
  .size {
    margin-left: auto;
    padding-left: 8px;
    color: var(--text-subtle);
    font-size: 0.85em;
    flex: 0 0 auto;
  }
  .note {
    color: var(--text-subtle);
    font-size: 0.85em;
    padding-top: 1px;
    padding-bottom: 2px;
  }
  .note.error {
    color: var(--warning-text);
  }
  .composer {
    padding-top: 2px;
    padding-bottom: 2px;
  }
  .inline {
    background: var(--surface-base);
    border: 1px solid var(--border-focus);
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: inherit;
    padding: 1px 5px;
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
