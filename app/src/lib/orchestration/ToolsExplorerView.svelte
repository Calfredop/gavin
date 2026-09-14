<script lang="ts">
  // Plans-like tools editor: left list (action prompts + custom tools),
  // right body editor. Replaces the modal as the primary way to tweak
  // agent prompts at workspace and app scope.
  import { RotateCcw, Save } from "@lucide/svelte";
  import {
    actionPromptById,
    bodySource,
    effectiveBody,
  } from "$lib/agents/actionPrompts";
  import {
    appPromptOverrides,
    setAppPromptOverride,
    setWorkspacePromptOverride,
    workspacePromptOverrides,
  } from "$lib/agents/actionPromptsState";
  import { layoutState } from "$lib/core/layoutState";
  import {
    editableToolsFor,
    promptEditorHint,
    promptListItems,
    sourceLabel,
    type ExplorerScope,
    type ExplorerSelection,
  } from "$lib/orchestration/toolsExplorer";
  import {
    toolBodyEditor,
    toolKindLabel,
    type Tool,
    validateTool,
  } from "$lib/orchestration/orchestrationTools";
  import { fetchTools, renderLibraryFor, saveToolAction, toolRecords } from "$lib/orchestration/toolsState";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";

  interface Props {
    scope: ExplorerScope;
    /// Required when scope is workspace; ignored for app (global tools
    /// still need a workspace id to talk to the daemon — pick any loaded
    /// one, or the active workspace).
    workspaceId?: string | null;
  }
  let { scope, workspaceId = null }: Props = $props();

  let search = $state("");
  let selection = $state<ExplorerSelection | null>(null);
  let draftBody = $state("");
  let dirty = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedFlash = $state(false);

  /// For app-scope global tool saves the daemon still wants a workspace
  /// id on the request; any rooted workspace works because scope=global.
  const daemonWorkspaceId = $derived(
    workspaceId ??
      $layoutState.activeWorkspaceId ??
      $layoutState.workspaces.find((w) => w.rootPath)?.id ??
      null
  );

  $effect(() => {
    const id = daemonWorkspaceId;
    if (id) void fetchTools(id);
  });

  const library = $derived(
    daemonWorkspaceId ? renderLibraryFor($toolRecords, daemonWorkspaceId) : []
  );
  const wsOverrides = $derived(
    scope === "workspace" && workspaceId ? workspacePromptOverrides(workspaceId) : {}
  );
  const promptGroups = $derived(promptListItems($appPromptOverrides, wsOverrides, search));
  const toolItems = $derived(editableToolsFor(library, scope, search));

  const selectedPrompt = $derived.by(() => {
    const sel = selection;
    return sel?.kind === "prompt" ? actionPromptById(sel.id) ?? null : null;
  });
  const selectedTool = $derived.by(() => {
    const sel = selection;
    return sel?.kind === "tool" ? library.find((t) => t.id === sel.id) ?? null : null;
  });

  function selectPrompt(id: string): void {
    const prompt = actionPromptById(id);
    if (!prompt) return;
    selection = { kind: "prompt", id };
    draftBody = effectiveBody(id, prompt.defaultBody, $appPromptOverrides, wsOverrides);
    dirty = false;
    error = null;
    savedFlash = false;
  }

  function selectTool(tool: Tool): void {
    selection = { kind: "tool", id: tool.id };
    draftBody = tool.body;
    dirty = false;
    error = null;
    savedFlash = false;
  }

  function onBodyInput(value: string): void {
    draftBody = value;
    dirty = true;
    savedFlash = false;
  }

  async function save(): Promise<void> {
    if (!selection) return;
    saving = true;
    error = null;
    try {
      if (selection.kind === "prompt") {
        const prompt = actionPromptById(selection.id);
        if (!prompt) throw new Error("Unknown prompt");
        const trimmed = draftBody.trim();
        const body = trimmed === prompt.defaultBody.trim() ? null : draftBody;
        if (scope === "workspace") {
          if (!workspaceId) throw new Error("No workspace");
          await setWorkspacePromptOverride(workspaceId, selection.id, body);
        } else {
          await setAppPromptOverride(selection.id, body);
        }
      } else {
        const tool = selectedTool;
        if (!tool || !daemonWorkspaceId) throw new Error("No tool");
        const next: Tool = { ...tool, body: draftBody };
        // App settings only edits global tools; force scope so a mistaken
        // workspace row cannot be saved from here as workspace-owned.
        if (scope === "app") next.scope = "global";
        const invalid = validateTool(next);
        if (invalid) {
          error = invalid;
          return;
        }
        const err = await saveToolAction(daemonWorkspaceId, next);
        if (err) {
          error = err;
          return;
        }
      }
      dirty = false;
      savedFlash = true;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      saving = false;
    }
  }

  async function resetToDefault(): Promise<void> {
    if (selection?.kind !== "prompt") return;
    const prompt = actionPromptById(selection.id);
    if (!prompt) return;
    draftBody = prompt.defaultBody;
    dirty = true;
    // Persist the clear immediately so source badge updates.
    saving = true;
    error = null;
    try {
      if (scope === "workspace") {
        if (!workspaceId) throw new Error("No workspace");
        await setWorkspacePromptOverride(workspaceId, selection.id, null);
      } else {
        await setAppPromptOverride(selection.id, null);
      }
      dirty = false;
      savedFlash = true;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      saving = false;
    }
  }

  const hint = $derived(
    selectedPrompt ? promptEditorHint(selectedPrompt, draftBody) : null
  );
  const promptSource = $derived(
    selectedPrompt
      ? bodySource(selectedPrompt.id, $appPromptOverrides, wsOverrides)
      : null
  );
  const source = $derived(
    promptSource
      ? sourceLabel(promptSource, scope)
      : selectedTool
        ? selectedTool.scope === "global"
          ? "All workspaces"
          : "This workspace"
        : null
  );

  // Default selection: first prompt, once.
  $effect(() => {
    if (selection) return;
    const first = promptGroups[0]?.items[0];
    if (first) selectPrompt(first.id);
  });
</script>

<div class="explorer" class:app-scope={scope === "app"}>
  <aside class="sidebar">
    <div class="sidebar-head">
      <SearchInput
        bind:value={search}
        label="Search prompts and tools"
        placeholder="Search prompts and tools…"
      />
    </div>
    <div class="sidebar-scroll">
      {#each promptGroups as group (group.groupLabel)}
        <div class="group">
          <div class="group-label">{group.groupLabel}</div>
          {#each group.items as item (item.id)}
            <button
              type="button"
              class="row"
              class:active={selection?.kind === "prompt" && selection.id === item.id}
              onclick={() => selectPrompt(item.id)}
            >
              <span class="row-name">{item.name}</span>
              {#if item.source !== "default"}
                <span class="pill" class:workspace={item.source === "workspace"}></span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}

      {#if toolItems.length > 0}
        <div class="group">
          <div class="group-label">{scope === "app" ? "Global tools" : "Custom tools"}</div>
          {#each toolItems as item (item.id)}
            <button
              type="button"
              class="row"
              class:active={selection?.kind === "tool" && selection.id === item.id}
              onclick={() => selectTool(item.tool)}
            >
              <span class="row-name">{item.name}</span>
              <span class="muted">{toolKindLabel(item.tool.kind)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if promptGroups.length === 0 && toolItems.length === 0}
        <p class="empty-list">No prompts or tools match.</p>
      {/if}
    </div>
  </aside>

  <section class="detail">
    {#if selectedPrompt}
      <header class="detail-head">
        <div class="titles">
          <h3>{selectedPrompt.name}</h3>
          <p class="desc">{selectedPrompt.description}</p>
          {#if source}<p class="source">{source}</p>{/if}
        </div>
        <div class="actions">
          <IconButton
            icon={RotateCcw}
            label="Reset to shipped default"
            disabled={saving || promptSource === "default"}
            onclick={() => void resetToDefault()}
          />
          <button
            type="button"
            class="save"
            disabled={saving || !dirty}
            onclick={() => void save()}
          >
            <Save size={14} /> {savedFlash && !dirty ? "Saved" : "Save"}
          </button>
        </div>
      </header>
      {#if selectedPrompt.params.length > 0}
        <p class="params">
          Placeholders:
          {selectedPrompt.params.map((p) => `{{${p.name}}}`).join(" · ")}
        </p>
      {/if}
      {#if hint}<p class="hint warn">{hint}</p>{/if}
      <textarea
        class="body"
        value={draftBody}
        oninput={(e) => onBodyInput(e.currentTarget.value)}
        spellcheck="true"
        rows={24}
        aria-label="Prompt body"
      ></textarea>
    {:else if selectedTool}
      {@const editor = toolBodyEditor(selectedTool.kind)}
      <header class="detail-head">
        <div class="titles">
          <h3>{selectedTool.name}</h3>
          <p class="desc">{selectedTool.description || toolKindLabel(selectedTool.kind)}</p>
          {#if source}<p class="source">{source}</p>{/if}
        </div>
        <div class="actions">
          <button
            type="button"
            class="save"
            disabled={saving || !dirty || editor.shape !== "text"}
            onclick={() => void save()}
          >
            <Save size={14} /> {savedFlash && !dirty ? "Saved" : "Save"}
          </button>
        </div>
      </header>
      {#if editor.shape === "text"}
        <textarea
          class="body"
          class:mono={editor.mono}
          value={draftBody}
          oninput={(e) => onBodyInput(e.currentTarget.value)}
          spellcheck={!editor.mono}
          rows={editor.rows < 12 ? 16 : editor.rows}
          aria-label={editor.label}
          placeholder={editor.placeholder}
        ></textarea>
      {:else}
        <p class="hint">{editor.shape === "none" ? editor.note : "This tool’s body is an action name, edited in Manage tools…"}</p>
      {/if}
    {:else}
      <p class="empty-detail">Select a prompt or tool to edit.</p>
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {/if}
  </section>
</div>

<style>
  .explorer {
    display: grid;
    grid-template-columns: minmax(220px, 280px) 1fr;
    gap: 0;
    height: 100%;
    min-height: 0;
    border: 1px solid var(--border, #333);
    border-radius: 8px;
    overflow: hidden;
    background: var(--panel, transparent);
  }
  .explorer.app-scope {
    min-height: 420px;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border, #333);
    background: var(--bg-elevated, transparent);
  }
  .sidebar-head {
    padding: 0.6rem 0.7rem;
    border-bottom: 1px solid var(--border, #333);
  }
  .sidebar-scroll {
    overflow: auto;
    flex: 1;
    padding: 0.4rem 0;
  }
  .group-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    padding: 0.55rem 0.85rem 0.25rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.85rem;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .row:hover {
    background: color-mix(in srgb, var(--accent, #4a9eff) 12%, transparent);
  }
  .row.active {
    background: color-mix(in srgb, var(--accent, #4a9eff) 22%, transparent);
  }
  .row-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    font-size: 0.75rem;
    opacity: 0.55;
  }
  .pill {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.75;
  }
  .pill::after {
    content: "app";
  }
  .pill.workspace::after {
    content: "ws";
  }
  .empty-list,
  .empty-detail {
    padding: 1rem;
    opacity: 0.6;
    margin: 0;
  }
  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 0.85rem 1rem 1rem;
    gap: 0.5rem;
  }
  .detail-head {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    justify-content: space-between;
  }
  .titles h3 {
    margin: 0;
    font-size: 1rem;
  }
  .desc,
  .source,
  .params,
  .hint {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .hint.warn {
    color: var(--warning, #d4a017);
    opacity: 1;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-shrink: 0;
  }
  .save {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--border, #444);
    background: var(--accent, #4a9eff);
    color: #fff;
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    font: inherit;
    cursor: pointer;
  }
  .save:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .body {
    flex: 1;
    min-height: 12rem;
    width: 100%;
    resize: vertical;
    font: inherit;
    line-height: 1.45;
    padding: 0.65rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border, #444);
    background: var(--bg, #111);
    color: inherit;
  }
  .body.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
  }
  .error {
    color: var(--danger, #e57373);
    font-size: 0.85rem;
  }
</style>
