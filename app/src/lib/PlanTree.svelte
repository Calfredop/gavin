<script lang="ts">
  import type { ExplorerContextNode, ExplorerGroup } from "./planExplorer";
  // Icon names are a COMPILE error when wrong (verified against the
  // installed @lucide/svelte): Columns2 is the current name for the old
  // SplitSquareHorizontal.
  import { FileText, TriangleAlert, ChevronRight, ChevronDown, Plus, Columns2 } from "@lucide/svelte";

  interface Props {
    contexts: ExplorerContextNode[];
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onCreateFile: (context: ExplorerContextNode, group: ExplorerGroup, title: string) => void;
    // Null when there is no terminal session to anchor a split to.
    onOpenInSplit: ((path: string) => void) | null;
  }
  let { contexts, selectedPath, onSelect, onCreateFile, onOpenInSplit }: Props = $props();

  // Collapsed rather than expanded ids: .gavin folders are few, so
  // everything starts open and this stays empty in the common case.
  let collapsed = $state<Set<string>>(new Set());
  let composer = $state<{ folderPath: string; group: ExplorerGroup } | null>(null);
  let composerTitle = $state("");

  // Hoisted: `{#each [...] as const as g}` does not parse -- the `as
  // const` collides with each's own `as` binding.
  const GROUPS = ["plans", "docs", "specs"] as const;

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function openComposer(folderPath: string): void {
    composer = { folderPath, group: "plans" };
    composerTitle = "";
  }

  function submitComposer(context: ExplorerContextNode): void {
    const title = composerTitle.trim();
    if (!title || !composer) return;
    onCreateFile(context, composer.group, title);
    composer = null;
    composerTitle = "";
  }
</script>

<div class="tree">
  {#each contexts as context (context.folderPath)}
    {@const contextCollapsed = collapsed.has(context.folderPath)}
    <div class="context">
      <div class="row context-row">
        <button type="button" class="twisty" onclick={() => toggle(context.folderPath)}>
          {#if contextCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        </button>
        <span class="name" title={context.folderPath}>{context.name}</span>
        {#if context.configWarning}
          <span class="warn" title="config.toml could not be parsed"><TriangleAlert size={11} /></span>
        {/if}
        <button
          type="button"
          class="add"
          title="New file in this context"
          onclick={() => openComposer(context.folderPath)}
        >
          <Plus size={12} />
        </button>
      </div>

      {#if composer && composer.folderPath === context.folderPath}
        <div class="composer">
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
          </div>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            placeholder="Title…"
            bind:value={composerTitle}
            onkeydown={(e) => {
              if (e.key === "Enter") submitComposer(context);
              else if (e.key === "Escape") composer = null;
            }}
          />
        </div>
      {/if}

      {#if !contextCollapsed}
        {#each context.groups as group (group.group)}
          {@const groupId = `${context.folderPath}#${group.group}`}
          {@const groupCollapsed = collapsed.has(groupId)}
          <div class="row group-row">
            <button type="button" class="twisty" onclick={() => toggle(groupId)}>
              {#if groupCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
            </button>
            <span class="group-label">{group.label}</span>
            <span class="count">{group.files.length}</span>
          </div>
          {#if !groupCollapsed}
            {#each group.files as file (file.path)}
              <div class="row file-row" class:selected={file.path === selectedPath}>
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
                  <button
                    type="button"
                    class="split"
                    title="Open beside a terminal"
                    onclick={() => onOpenInSplit?.(file.path)}
                  >
                    <Columns2 size={11} />
                  </button>
                {/if}
              </div>
            {/each}
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
    color: #ccc;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .file-row.selected {
    background: #2f3a2f;
  }
  .file-row:hover,
  .context-row:hover,
  .group-row:hover {
    background: #2a2a2a;
  }
  .twisty,
  .add,
  .split {
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0 2px;
  }
  .add,
  .split {
    margin-left: auto;
    opacity: 0;
  }
  .context-row:hover .add,
  .file-row:hover .split {
    opacity: 1;
  }
  .name {
    color: #8bc98b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-label {
    color: #999;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .count {
    color: #666;
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
    color: #7a8a7a;
    flex: 0 0 auto;
  }
  .status {
    color: #777;
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
    background: #6b8e6b;
  }
  .priority-medium {
    background: #d9a648;
  }
  .priority-high {
    background: #d97748;
  }
  .priority-urgent {
    background: #d94848;
  }
  .warn {
    display: flex;
    color: #d9a648;
    flex: 0 0 auto;
  }
  .composer {
    padding: 4px 6px 6px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .group-picker {
    display: flex;
    gap: 4px;
  }
  .group-picker button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #999;
    font-family: inherit;
    font-size: 0.85em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .group-picker button.active {
    background: #333;
    color: #eee;
  }
  .composer input {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: inherit;
    font-size: inherit;
    padding: 2px 6px;
  }
</style>
