<script lang="ts">
  import { CREATABLE_GROUPS } from "./planExplorer";
  import type {
    CreatableGroup,
    ExplorerContextNode,
    ExplorerFile,
    ExplorerGroupNode,
  } from "./planExplorer";
  // Icon names are a COMPILE error when wrong (verified against the
  // installed @lucide/svelte): Columns2 is the current name for the old
  // SplitSquareHorizontal.
  import { FileText, TriangleAlert, ChevronRight, ChevronDown, Plus, Columns2, X, Archive } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { message } from "@tauri-apps/plugin-dialog";
  import { openContextMenuFromEvent } from "./contextMenu";
  import {
    contextRowMenuItems,
    fileMenuItems,
    groupRowMenuItems,
    type TreeMenuCallbacks,
    type TreeMenuItem,
  } from "./planTreeMenu";

  interface Props {
    contexts: ExplorerContextNode[];
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onCreateFile: (context: ExplorerContextNode, group: CreatableGroup, title: string) => void;
    // Null when there is no terminal session to anchor a split to.
    onOpenInSplit: ((path: string) => void) | null;
    onDeleteFile: (file: ExplorerFile) => void;
    // Archive group only. Null while the board projection this restores
    // through hasn't loaded.
    onRestoreFile: ((file: ExplorerFile) => void) | null;
    // Reason the archive is unavailable on the running daemon, or null.
    restoreBlocked?: string | null;
    // Outside contexts only: unlist from the navigator (files stay).
    onRemoveOutside: (context: ExplorerContextNode) => void;
  }
  let {
    contexts,
    selectedPath,
    onSelect,
    onCreateFile,
    onOpenInSplit,
    onDeleteFile,
    onRestoreFile,
    restoreBlocked = null,
    onRemoveOutside,
  }: Props = $props();

  // Collapsed rather than expanded ids: .gavin folders are few, so
  // everything starts open and this stays empty in the common case.
  let collapsed = $state<Set<string>>(new Set());
  // Inverted against `collapsed` on purpose: the Done node and the
  // Archive group both start FOLDED (that is the whole point of them),
  // so this holds the ones opened rather than the ones closed.
  let archiveOpen = $state<Set<string>>(new Set());

  /// Whether a group renders its rows. The Archive group is the one
  /// group that defaults to shut: it is the longest list in the tree and
  /// the one nobody is working out of.
  function groupIsOpen(group: ExplorerGroupNode, groupId: string): boolean {
    if (group.group === "archive") return archiveOpen.has(groupId);
    return !collapsed.has(groupId);
  }
  let composer = $state<{ folderPath: string; group: CreatableGroup } | null>(null);
  let composerTitle = $state("");
  // Hoisted: `{#each [...] as const as g}` does not parse -- the `as
  // const` collides with each's own `as` binding.
  const GROUPS = CREATABLE_GROUPS;

  // Inline because the level is data (context.depth), not a fixed class:
  // groups sit one level under their context, files one under the group.
  const INDENT_PX = 14;
  function inset(level: number): string {
    return `${4 + level * INDENT_PX}px`;
  }

  function toggleArchive(id: string): void {
    const next = new Set(archiveOpen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    archiveOpen = next;
  }

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function openComposer(folderPath: string, group: CreatableGroup = "plans"): void {
    composer = { folderPath, group };
    composerTitle = "";
  }

  function closeComposer(): void {
    composer = null;
    composerTitle = "";
  }

  function submitComposer(context: ExplorerContextNode): void {
    const title = composerTitle.trim();
    if (!title || !composer) return;
    onCreateFile(context, composer.group, title);
    closeComposer();
  }

  // Built at event time so the menu always closes over the current
  // props (onOpenInSplit toggles with terminal focus).
  function menuCallbacks(): TreeMenuCallbacks {
    return {
      onSelect,
      onOpenInSplit,
      onDeleteFile,
      onRestoreFile,
      restoreBlocked,
      onCompose: openComposer,
      onRemoveOutside,
      onShowInFinder: showInFinder,
    };
  }

  function showInFinder(folderPath: string): void {
    openPath(folderPath).catch((e) => {
      const text = `Couldn't open in Finder: ${e}`;
      console.error(text);
      void message(text, { title: "gavin", kind: "error" });
    });
  }

  // Opens the app-wide context menu (one ContextMenu layer, mounted at the
  // root) -- the same UI the kanban, tabs and sidebar use.
  function openMenu(e: MouseEvent, items: TreeMenuItem[]): void {
    openContextMenuFromEvent(e, items);
  }
</script>

{#snippet fileRow(file: ExplorerFile, level: number)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="row file-row"
    class:selected={file.path === selectedPath}
    style:padding-left={inset(level)}
    oncontextmenu={(e) => openMenu(e, fileMenuItems(file, menuCallbacks()))}
  >
    <button type="button" class="file" title={file.path} onclick={() => onSelect(file.path)}>
      <span class="glyph"><FileText size={11} /></span>
      <span class="label">{file.label}</span>
      {#if file.priority && file.priority !== "none"}
        <span class="priority priority-{file.priority}" title="Priority: {file.priority}"></span>
      {/if}
      {#if file.status}
        <span class="status">{file.status}</span>
      {/if}
      {#if file.parseWarning}
        <span class="warn" title="Frontmatter has issues"><TriangleAlert size={11} /></span>
      {/if}
    </button>
    {#if onOpenInSplit}
      <IconButton
        icon={Columns2}
        label="Open beside a terminal"
        size={11}
        class="split"
        onclick={() => onOpenInSplit?.(file.path)}
      />
    {/if}
  </div>
{/snippet}

<div class="tree">
  {#each contexts as context (context.folderPath)}
    {@const contextCollapsed = collapsed.has(context.folderPath)}
    <div class="context">
      <!-- svelte-ignore a11y_no_static_element_interactions -- right-click
           is a pointer-only affordance; the row's actions stay reachable
           through its buttons -->
      <div
        class="row context-row"
        style:padding-left={inset(context.depth)}
        oncontextmenu={(e) => openMenu(e, contextRowMenuItems(context, menuCallbacks()))}
      >
        <IconButton
          icon={contextCollapsed ? ChevronRight : ChevronDown}
          label={contextCollapsed ? "Expand context" : "Collapse context"}
          size={12}
          onclick={() => toggle(context.folderPath)}
        />
        <span
          class="name"
          class:outside={context.outside}
          title={context.outside ? `outside workspace — ${context.folderPath}` : context.folderPath}
        >
          {context.name}
        </span>
        {#if context.configWarning}
          <span class="warn" title="config.toml could not be parsed"><TriangleAlert size={11} /></span>
        {/if}
        <IconButton icon={Plus} label="New file in this context" size={12} class="add" onclick={() => openComposer(context.folderPath)} />
      </div>

      {#if composer && composer.folderPath === context.folderPath}
        <div class="composer" style:padding-left={inset(context.depth + 1)}>
          <div class="group-picker">
            {#each GROUPS as g (g)}
              <button
                type="button"
                class:active={composer?.group === g}
                onclick={() => (composer = { folderPath: context.folderPath, group: g })}
              >
                {g}
              </button>
            {/each}
            <button type="button" class="close" title="Close (Esc)" onclick={closeComposer}>
              <X size={12} />
            </button>
          </div>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            placeholder="Title…"
            bind:value={composerTitle}
            onkeydown={(e) => {
              if (e.key === "Enter") submitComposer(context);
              else if (e.key === "Escape") closeComposer();
            }}
          />
        </div>
      {/if}

      {#if !contextCollapsed}
        {#each context.groups as group (group.group)}
          {@const groupId = `${context.folderPath}#${group.group}`}
          {@const isArchive = group.group === "archive"}
          {@const groupOpen = groupIsOpen(group, groupId)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="row group-row"
            style:padding-left={inset(context.depth + 1)}
            oncontextmenu={(e) => openMenu(e, groupRowMenuItems(context, group.group, menuCallbacks()))}
          >
            <IconButton
              icon={groupOpen ? ChevronDown : ChevronRight}
              label={groupOpen ? "Collapse group" : "Expand group"}
              size={12}
              onclick={() => (isArchive ? toggleArchive(groupId) : toggle(groupId))}
            />
            {#if isArchive}
              <span class="glyph"><Archive size={11} /></span>
            {/if}
            <span class="group-label">{group.label}</span>
            <!-- Archived cards count here too: a context whose plans are
                 ALL Done would otherwise read "Plans 0" above a "Done 8". -->
            <span class="count">{group.files.length + group.archived.length}</span>
          </div>
          {#if groupOpen}
            {#each group.files as file (file.path)}
              {@render fileRow(file, context.depth + 2)}
            {/each}
            {#if group.archived.length > 0}
              {@const doneId = `${groupId}#done`}
              {@const doneOpen = archiveOpen.has(doneId)}
              <div class="row group-row" style:padding-left={inset(context.depth + 2)}>
                <IconButton
                  icon={doneOpen ? ChevronDown : ChevronRight}
                  label={doneOpen ? "Hide archived plans" : "Show archived plans"}
                  size={12}
                  onclick={() => toggleArchive(doneId)}
                />
                <span class="group-label">Done</span>
                <span class="count">{group.archived.length}</span>
              </div>
              {#if doneOpen}
                {#each group.archived as file (file.path)}
                  {@render fileRow(file, context.depth + 3)}
                {/each}
              {/if}
            {/if}
          {/if}
        {/each}
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree {
    height: 100%;
    overflow: auto;
    padding: 8px 4px;
    font-family: monospace;
    font-size: 0.8em;
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .file-row.selected {
    background: var(--surface-success);
  }
  .file-row:hover,
  .context-row:hover,
  .group-row:hover {
    background: var(--surface-raised);
  }
  :global(.add),
  :global(.split) {
    margin-left: auto;
    opacity: 0;
  }
  .context-row:hover :global(.add),
  .file-row:hover :global(.split) {
    opacity: 1;
  }
  .name {
    color: var(--success-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.outside {
    color: var(--warning-text);
  }
  .group-label {
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .count {
    color: var(--text-subtle);
    font-size: 0.85em;
  }
  .file {
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
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .glyph {
    display: flex;
    color: var(--text-subtle);
    flex: 0 0 auto;
  }
  .status {
    color: var(--text-subtle);
    font-size: 0.85em;
    flex: 0 0 auto;
  }
  .priority {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .priority-low {
    background: var(--surface-success);
  }
  .priority-medium {
    background: var(--warning);
  }
  .priority-high {
    background: var(--warning);
  }
  .priority-urgent {
    background: var(--danger);
  }
  .warn {
    display: flex;
    color: var(--warning-text);
    flex: 0 0 auto;
  }
  .composer {
    /* left padding is inline: it tracks the context's depth */
    padding: 4px 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .group-picker {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .group-picker button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.85em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .group-picker button.active {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .group-picker button.close {
    border: none;
    margin-left: auto;
    display: flex;
    align-items: center;
    padding: 1px 2px;
  }
  .group-picker button.close:hover {
    color: var(--text);
  }
  .composer input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: inherit;
    padding: 2px 6px;
  }
</style>
