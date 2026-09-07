<script lang="ts">
  // The Tools tab: the library that already exists, with a Run button
  // and a way in to the editor.
  //
  // A template over workspaceTools.ts, which owns every rule -- which
  // tools are listed, which of them run alone, what a last run means,
  // why Run is dark. Nothing is decided here; this file is rows, a
  // search box and a dialog.
  //
  // Every row's Edit, its Duplicate, and New tool all open
  // ToolLibraryDialog -- the SAME dialog the Orchestration tab opens,
  // seeded on the row that was pressed (`editDraftFor`). There is one
  // library, one editor and one store behind both tabs, so a tool
  // written for a rail is runnable here the moment it is saved, and a
  // tool written here is droppable onto a rail.
  //
  // The list holds every kind, not only the runnable three. A tool's
  // kind is editable from this tab now, and a list filtered by kind
  // would make the human who switches one to Loop-until watch it
  // disappear from under the cursor.
  import { onMount } from "svelte";
  import { Copy, FolderOpen, Pencil, Play, Plus, Settings2 } from "@lucide/svelte";
  import { daemonCompat, layoutState, workspaceRootPath } from "./layoutState";
  import { revealSession } from "./cardRunActions";
  import { toolRecords, fetchTools, renderLibraryFor } from "./toolsState";
  import {
    groupTemplateRecords,
    libraryFor as templateLibraryFor,
    fetchGroupTemplates,
  } from "./groupTemplatesState";
  import { toolRunsStore, refreshToolRuns } from "./toolRunsState";
  import { requestToolRun } from "./workspaceToolsActions";
  import { emptyTool, toolKindLabel, type Tool } from "./orchestrationTools";
  import {
    editDraftFor,
    lastRunsFor,
    listedTools,
    matchesToolSearch,
    runBlockedReason,
    toolCwdLabel,
    toolRunAxis,
    toolRunChip,
    toolRunTip,
    toolsEmptyMessage,
    type ToolRun,
  } from "./workspaceTools";
  import IconButton from "./ui/IconButton.svelte";
  import { runIndicator } from "./ui/indicators";
  import SearchInput from "./ui/SearchInput.svelte";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import ToolLibraryDialog from "./ToolLibraryDialog.svelte";
  import ToolRunDialog from "./ToolRunDialog.svelte";
  import { tooltip } from "./tooltip";
  import { toolIcon } from "./ui/toolKindIcon";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let search = $state("");
  /// Null is closed. A non-null value is the library dialog, open on the
  /// draft it carries -- `null` inside it being its own list. Held as one
  /// piece of state rather than a boolean beside a draft, so the dialog
  /// cannot be open on a draft from the time before last: the parent
  /// tears the component down on close and builds a fresh one, and
  /// `initialEdit` is read once at construction.
  let managing = $state<{ draft: Tool | null } | null>(null);
  let error = $state<string | null>(null);

  // A clock, so "4m ago" becomes "5m ago" without the human touching
  // anything. Thirty seconds is the coarsest tick the chip's own
  // resolution can show a change at.
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  // The library is fetched by id rather than by mount count, so two
  // workspaces parked on this tab (one instance, re-pointed) each get
  // their own read. Same discipline the Files tab uses for its root.
  $effect(() => {
    const id = workspaceId;
    void fetchTools(id);
    void fetchGroupTemplates(id);
  });

  // The runs are REFRESHED rather than fetched-once: the human comes
  // back to this tab precisely to see how the last run went, and the
  // daemon pushes nothing when it closes one.
  $effect(() => {
    const id = workspaceId;
    void refreshToolRuns(id, $daemonCompat);
  });

  const library = $derived(renderLibraryFor($toolRecords, workspaceId));
  const templates = $derived(templateLibraryFor($groupTemplateRecords, workspaceId) ?? []);
  const rootPath = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const lastRuns = $derived(lastRunsFor($toolRunsStore, workspaceId));
  const shown = $derived(listedTools(library).filter((t) => matchesToolSearch(t, search)));
  const emptyMessage = $derived(toolsEmptyMessage(shown, search));

  const iconFor = toolIcon;

  function blockedFor(tool: Tool): string | null {
    return runBlockedReason({
      compat: $daemonCompat,
      rootPath: rootPath ?? workspaceRootPath(workspaceId),
      tool,
      lastRun: lastRuns.get(tool.id),
    });
  }

  async function run(tool: Tool): Promise<void> {
    error = await requestToolRun(workspaceId, tool);
  }

  /// Opens the library dialog on this row. A built-in cannot be saved,
  /// so `editDraftFor` hands back a copy of one instead of the original
  /// -- which is why the built-in rows say Duplicate and the rest say
  /// Edit, and why both go through here.
  function edit(tool: Tool): void {
    managing = { draft: editDraftFor(tool, crypto.randomUUID()) };
  }

  // The app's ONE badge vocabulary, composed here rather than in
  // workspaceTools.ts: `ui/indicators.ts` pulls the whole
  // `@lucide/svelte` barrel, and that module is reached from bootstrap.
  // Which axis state and which words is the rule, and it lives there
  // (`toolRunAxis`, `toolRunTip`); this is only the lookup.
  function badgeFor(run: ToolRun) {
    const axis = toolRunAxis(run);
    const tip = toolRunTip(run);
    return { ...runIndicator(axis.outcome, axis.exitCode), state: run.outcome, tip, label: tip };
  }
</script>

<div class="view">
  <header class="bar">
    <!-- No heading: the hub's tab strip already names this view, and a
         second "Tools" would only eat the row the search wants. -->
    <SearchInput
      bind:value={search}
      class="bar-search"
      label="Search tools"
      placeholder="Search tools by name, description or kind…"
    />
    <span class="spacer"></span>
    <button
      type="button"
      class="action"
      onclick={() => (managing = { draft: emptyTool(crypto.randomUUID()) })}
    >
      <Plus size={14} /> New tool
    </button>
    <button type="button" class="action" onclick={() => (managing = { draft: null })}>
      <Settings2 size={14} /> Manage tools…
    </button>
  </header>

  {#if error}
    <div class="save-error">
      <span>{error}</span>
      <button type="button" onclick={() => (error = null)}>Dismiss</button>
    </div>
  {/if}

  {#if $toolRunsStore[workspaceId]?.error}
    <!-- Above the list, never in place of it: the tools are still there
         and still runnable, it is only their history that is missing. -->
    <div class="save-error">
      <span>Couldn't read this workspace's tool runs: {$toolRunsStore[workspaceId]?.error}</span>
      <button type="button" onclick={() => void refreshToolRuns(workspaceId, $daemonCompat)}>
        Retry
      </button>
    </div>
  {/if}

  {#if emptyMessage}
    <p class="empty">{emptyMessage}</p>
  {:else}
    <ul class="tools">
      {#each shown as tool (tool.id)}
        {@const blocked = blockedFor(tool)}
        {@const lastRun = lastRuns.get(tool.id)}
        {@const chip = toolRunChip(lastRun, now)}
        {@const Icon = iconFor(tool)}
        <li class="tool">
          <span class="kind" use:tooltip={toolKindLabel(tool.kind)}><Icon size={14} /></span>
          <div class="text">
            <span class="name">{tool.name}</span>
            {#if tool.description}<span class="desc">{tool.description}</span>{/if}
          </div>
          <span class="meta">
            {#if toolCwdLabel(tool)}
              <span class="cwd" use:tooltip={"This tool runs here, not at the workspace root"}>
                <FolderOpen size={11} /> {toolCwdLabel(tool)}
              </span>
            {/if}
            {#if lastRun && chip}
              <!-- Clickable: the run's session is where the evidence
                   is, and a chip that says "failed" with no way to see
                   why is a dead end. -->
              <button
                type="button"
                class="chip"
                onclick={() => void revealSession(lastRun.sessionId)}
              >
                <StatusBadge indicator={badgeFor(lastRun)} text={chip} />
              </button>
            {/if}
          </span>
          <!-- Editing sits beside Run rather than behind Manage tools…:
               the row the human wants to change is the one they are
               already pointing at. A built-in gets Duplicate for the
               same reason the library's own list does -- it cannot be
               saved, so the only way to edit one is to make a copy. -->
          {#if tool.scope === "builtin"}
            <IconButton
              icon={Copy}
              label="Duplicate to edit"
              size={13}
              onclick={() => edit(tool)}
            />
          {:else}
            <IconButton icon={Pencil} label="Edit" size={13} onclick={() => edit(tool)} />
          {/if}
          <!-- The reason hangs on this span, not on the button: a
               disabled element never fires `mouseenter`, so a title on
               it would be a tooltip that never appears. -->
          <span class="run-slot" use:tooltip={blocked}>
            <button type="button" class="action" disabled={Boolean(blocked)} onclick={() => void run(tool)}>
              <Play size={13} /> Run
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<ToolRunDialog />

{#if managing}
  <ToolLibraryDialog
    {workspaceId}
    tools={library}
    {templates}
    initialEdit={managing.draft}
    onClose={() => (managing = null)}
  />
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: auto;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .bar :global(.bar-search) {
    flex: 1 1 auto;
    max-width: 420px;
  }
  .action {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .action:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .save-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 12px;
  }
  .save-error button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .empty {
    padding: 16px 12px;
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .tools {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tool {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .kind {
    display: flex;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .name {
    font-size: 13px;
    color: var(--text);
  }
  .desc {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }
  .cwd {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .run-slot {
    display: inline-flex;
    flex: 0 0 auto;
  }
</style>
