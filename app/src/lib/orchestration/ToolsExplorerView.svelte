<script lang="ts">
  // One Plans-like view: sidebar of tools (+ action prompts), full
  // editor on select, Run when the tool can run alone.
  import { Copy, Play, RotateCcw, Save } from "@lucide/svelte";
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
  import { daemonCompat, layoutState, workspaceRootPath } from "$lib/core/layoutState";
  import { tooltip } from "$lib/core/tooltip";
  import { currentPlatform } from "$lib/core/platform";
  import {
    promptEditorHint,
    promptListItems,
    sourceLabel,
    toolBodyIsPromptOverride,
    toolsForExplorer,
    type ExplorerScope,
    type ExplorerSelection,
  } from "$lib/orchestration/toolsExplorer";
  import {
    duplicateTool,
    isBuiltinId,
    TOOL_KINDS,
    toolBodyEditor,
    toolKindLabel,
    type Tool,
    type ToolKind,
    validateTool,
    bodyForKind,
  } from "$lib/orchestration/orchestrationTools";
  import { fetchTools, renderLibraryFor, saveToolAction, toolRecords } from "$lib/orchestration/toolsState";
  import { toolRunsStore, refreshToolRuns } from "$lib/orchestration/toolRunsState";
  import { requestToolRun } from "$lib/workspace/workspaceToolsActions";
  import {
    lastRunsFor,
    runBlockedReason,
    toolRunAxis,
    toolRunChip,
    toolRunTip,
    type ToolRun,
  } from "$lib/workspace/workspaceTools";
  import { revealSession } from "$lib/cards/cardRunActions";
  import { runIndicator } from "$lib/ui/indicators";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { toolIcon } from "$lib/ui/toolKindIcon";
  import { onMount } from "svelte";

  interface Props {
    scope: ExplorerScope;
    workspaceId?: string | null;
    /// Open the library dialog on a new / duplicated draft. Workspace
    /// hub wires this for groups and the rare full-form path; app
    /// settings may omit it.
    onManage?: (draft: Tool | null) => void;
  }
  let { scope, workspaceId = null, onManage }: Props = $props();

  let search = $state("");
  let selection = $state<ExplorerSelection | null>(null);
  /// Working copy for a selected tool (custom or builtin). Null while
  /// a prompt-only row is selected.
  let draftTool = $state<Tool | null>(null);
  let draftBody = $state("");
  let stashedBody = $state<string | null>(null);
  let dirty = $state(false);
  let saving = $state(false);
  let running = $state(false);
  let error = $state<string | null>(null);
  let savedFlash = $state(false);
  let now = $state(Date.now());

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const daemonWorkspaceId = $derived(
    workspaceId ??
      $layoutState.activeWorkspaceId ??
      $layoutState.workspaces.find((w) => w.rootPath)?.id ??
      null
  );

  $effect(() => {
    const id = daemonWorkspaceId;
    if (id) {
      void fetchTools(id);
      if (scope === "workspace") void refreshToolRuns(id, $daemonCompat);
    }
  });

  const library = $derived(
    daemonWorkspaceId ? renderLibraryFor($toolRecords, daemonWorkspaceId) : []
  );
  const wsOverrides = $derived(
    scope === "workspace" && workspaceId ? workspacePromptOverrides(workspaceId) : {}
  );
  const promptGroups = $derived(promptListItems($appPromptOverrides, wsOverrides, search));
  const toolItems = $derived(toolsForExplorer(library, scope, search));
  const lastRuns = $derived(
    daemonWorkspaceId ? lastRunsFor($toolRunsStore, daemonWorkspaceId) : new Map()
  );

  const selectedPrompt = $derived.by(() => {
    const sel = selection;
    return sel?.kind === "prompt" ? actionPromptById(sel.id) ?? null : null;
  });

  const iconFor = toolIcon;

  function badgeFor(run: ToolRun) {
    const axis = toolRunAxis(run);
    const tip = toolRunTip(run);
    return { ...runIndicator(axis.outcome, axis.exitCode), state: run.outcome, tip, label: tip };
  }

  function selectPrompt(id: string): void {
    const prompt = actionPromptById(id);
    if (!prompt) return;
    selection = { kind: "prompt", id };
    draftTool = null;
    draftBody = effectiveBody(id, prompt.defaultBody, $appPromptOverrides, wsOverrides);
    stashedBody = null;
    dirty = false;
    error = null;
    savedFlash = false;
  }

  function selectTool(tool: Tool): void {
    selection = { kind: "tool", id: tool.id };
    draftTool = {
      ...tool,
      params: tool.params.map((p) => ({ ...p })),
      body: toolBodyIsPromptOverride(tool)
        ? effectiveBody(tool.id, tool.body, $appPromptOverrides, wsOverrides)
        : tool.body,
    };
    draftBody = draftTool.body;
    stashedBody = null;
    dirty = false;
    error = null;
    savedFlash = false;
  }

  function markDirty(): void {
    dirty = true;
    savedFlash = false;
  }

  function onBodyInput(value: string): void {
    draftBody = value;
    if (draftTool) draftTool = { ...draftTool, body: value };
    markDirty();
  }

  function pickKind(kind: ToolKind): void {
    if (!draftTool || draftTool.kind === kind || isBuiltinId(draftTool.id)) return;
    if (toolBodyEditor(kind).shape !== "text" && toolBodyEditor(draftTool.kind).shape === "text") {
      stashedBody = draftTool.body;
    }
    const body = bodyForKind(kind, draftTool.body, stashedBody);
    draftTool = { ...draftTool, kind, body };
    draftBody = body;
    markDirty();
  }

  function setField<K extends "name" | "description" | "cwd">(key: K, value: string): void {
    if (!draftTool || isBuiltinId(draftTool.id)) return;
    draftTool = { ...draftTool, [key]: value };
    markDirty();
  }

  async function save(): Promise<void> {
    if (!selection) return;
    saving = true;
    error = null;
    try {
      if (selection.kind === "prompt") {
        const prompt = actionPromptById(selection.id);
        if (!prompt) throw new Error("Unknown prompt");
        const body =
          draftBody.trim() === prompt.defaultBody.trim() ? null : draftBody;
        if (scope === "workspace") {
          if (!workspaceId) throw new Error("No workspace");
          await setWorkspacePromptOverride(workspaceId, selection.id, body);
        } else {
          await setAppPromptOverride(selection.id, body);
        }
      } else if (draftTool && toolBodyIsPromptOverride(draftTool)) {
        const prompt = actionPromptById(draftTool.id)!;
        const body =
          draftBody.trim() === prompt.defaultBody.trim() ? null : draftBody;
        if (scope === "workspace") {
          if (!workspaceId) throw new Error("No workspace");
          await setWorkspacePromptOverride(workspaceId, draftTool.id, body);
        } else {
          await setAppPromptOverride(draftTool.id, body);
        }
        // Refresh draft from library (overrides applied).
        const fresh = library.find((t) => t.id === draftTool!.id);
        if (fresh) selectTool(fresh);
        else draftBody = body ?? prompt.defaultBody;
      } else if (draftTool) {
        if (!daemonWorkspaceId) throw new Error("No tool");
        const next: Tool = { ...draftTool, body: draftBody };
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
    const id =
      selection?.kind === "prompt"
        ? selection.id
        : draftTool && toolBodyIsPromptOverride(draftTool)
          ? draftTool.id
          : null;
    if (!id) return;
    const prompt = actionPromptById(id);
    if (!prompt) return;
    draftBody = prompt.defaultBody;
    if (draftTool) draftTool = { ...draftTool, body: prompt.defaultBody };
    saving = true;
    error = null;
    try {
      if (scope === "workspace") {
        if (!workspaceId) throw new Error("No workspace");
        await setWorkspacePromptOverride(workspaceId, id, null);
      } else {
        await setAppPromptOverride(id, null);
      }
      dirty = false;
      savedFlash = true;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      saving = false;
    }
  }

  function duplicateSelected(): void {
    if (!draftTool || !onManage) return;
    onManage(duplicateTool(draftTool, crypto.randomUUID()));
  }

  const runBlocked = $derived.by(() => {
    if (scope !== "workspace" || !workspaceId || !draftTool) return "Select a tool to run.";
    return runBlockedReason({
      compat: $daemonCompat,
      rootPath: workspaceRootPath(workspaceId),
      tool: { ...draftTool, body: draftBody },
      lastRun: lastRuns.get(draftTool.id),
      platform: currentPlatform(),
    });
  });

  async function runSelected(): Promise<void> {
    if (!workspaceId || !draftTool || runBlocked) return;
    running = true;
    error = null;
    try {
      // Persist dirty edits first so the launch uses what is on screen.
      if (dirty) await save();
      if (error) return;
      const tool = library.find((t) => t.id === draftTool!.id) ?? {
        ...draftTool,
        body: draftBody,
      };
      error = await requestToolRun(workspaceId, tool);
    } finally {
      running = false;
    }
  }

  const hint = $derived(
    selectedPrompt ? promptEditorHint(selectedPrompt, draftBody) : null
  );
  const promptSource = $derived.by(() => {
    if (selectedPrompt) return bodySource(selectedPrompt.id, $appPromptOverrides, wsOverrides);
    if (draftTool && toolBodyIsPromptOverride(draftTool)) {
      return bodySource(draftTool.id, $appPromptOverrides, wsOverrides);
    }
    return null;
  });
  const source = $derived(
    promptSource
      ? sourceLabel(promptSource, scope)
      : draftTool
        ? draftTool.scope === "builtin"
          ? "Built-in"
          : draftTool.scope === "global"
            ? "All workspaces"
            : "This workspace"
        : null
  );

  const bodyEditor = $derived(
    draftTool ? toolBodyEditor(draftTool.kind) : selectedPrompt ? toolBodyEditor("agent") : null
  );
  const canReset = $derived(promptSource !== null && promptSource !== "default");
  const lastRun = $derived(draftTool ? lastRuns.get(draftTool.id) : undefined);
  const chip = $derived(toolRunChip(lastRun, now));

  $effect(() => {
    if (selection) return;
    const firstTool = toolItems[0];
    if (firstTool) selectTool(firstTool.tool);
    else {
      const firstPrompt = promptGroups[0]?.items[0];
      if (firstPrompt) selectPrompt(firstPrompt.id);
    }
  });
</script>

<div class="explorer" class:app-scope={scope === "app"}>
  <aside class="sidebar">
    <div class="sidebar-head">
      <SearchInput
        bind:value={search}
        label="Search tools and prompts"
        placeholder="Search tools and prompts…"
      />
    </div>
    <div class="sidebar-scroll">
      {#if toolItems.length > 0}
        <div class="group">
          <div class="group-label">Tools</div>
          {#each toolItems as item (item.id)}
            {@const Icon = iconFor(item.tool)}
            <button
              type="button"
              class="row"
              class:active={selection?.kind === "tool" && selection.id === item.id}
              onclick={() => selectTool(item.tool)}
            >
              <span class="row-icon"><Icon size={13} /></span>
              <span class="row-name">{item.name}</span>
              {#if item.tool.scope !== "builtin"}
                <span class="muted">{item.scopeLabel === "All workspaces" ? "global" : "ws"}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

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

      {#if toolItems.length === 0 && promptGroups.length === 0}
        <p class="empty-list">No tools or prompts match.</p>
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
            disabled={saving || !canReset}
            onclick={() => void resetToDefault()}
          />
          <button type="button" class="save" disabled={saving || !dirty} onclick={() => void save()}>
            <Save size={14} /> {savedFlash && !dirty ? "Saved" : "Save"}
          </button>
        </div>
      </header>
      {#if selectedPrompt.params.length > 0}
        <p class="params">
          Placeholders: {selectedPrompt.params.map((p) => `{{${p.name}}}`).join(" · ")}
        </p>
      {/if}
      {#if hint}<p class="hint warn">{hint}</p>{/if}
      <textarea
        class="body"
        value={draftBody}
        oninput={(e) => onBodyInput(e.currentTarget.value)}
        spellcheck="true"
        aria-label="Prompt body"
      ></textarea>
    {:else if draftTool}
      {@const builtin = isBuiltinId(draftTool.id)}
      {@const promptBacked = toolBodyIsPromptOverride(draftTool)}
      <header class="detail-head">
        <div class="titles">
          {#if builtin}
            <h3>{draftTool.name}</h3>
            <p class="desc">{draftTool.description || toolKindLabel(draftTool.kind)}</p>
          {:else}
            <input
              class="name-input"
              value={draftTool.name}
              oninput={(e) => setField("name", e.currentTarget.value)}
              aria-label="Tool name"
              placeholder="Name"
            />
            <input
              class="desc-input"
              value={draftTool.description}
              oninput={(e) => setField("description", e.currentTarget.value)}
              aria-label="Description"
              placeholder="What this does, in one line"
            />
          {/if}
          {#if source}<p class="source">{source}</p>{/if}
        </div>
        <div class="actions">
          {#if lastRun && chip}
            <button type="button" class="chip" onclick={() => void revealSession(lastRun.sessionId)}>
              <StatusBadge indicator={badgeFor(lastRun)} text={chip} />
            </button>
          {/if}
          {#if canReset}
            <IconButton
              icon={RotateCcw}
              label="Reset to shipped default"
              disabled={saving}
              onclick={() => void resetToDefault()}
            />
          {/if}
          {#if builtin && onManage}
            <IconButton
              icon={Copy}
              label="Duplicate to edit"
              onclick={duplicateSelected}
            />
          {/if}
          {#if !builtin || promptBacked}
            <button
              type="button"
              class="save"
              disabled={saving || !dirty || (bodyEditor?.shape !== "text" && !promptBacked && builtin)}
              onclick={() => void save()}
            >
              <Save size={14} /> {savedFlash && !dirty ? "Saved" : "Save"}
            </button>
          {/if}
          {#if scope === "workspace"}
            <span class="run-slot" use:tooltip={runBlocked}>
              <button
                type="button"
                class="run"
                disabled={Boolean(runBlocked) || running || saving}
                onclick={() => void runSelected()}
              >
                <Play size={14} /> Run
              </button>
            </span>
          {/if}
        </div>
      </header>

      {#if !builtin}
        <div class="meta-row">
          <span class="field">Runs as</span>
          <div class="chips">
            {#each TOOL_KINDS as kind (kind)}
              <button
                type="button"
                class="kind-chip"
                class:on={draftTool.kind === kind}
                onclick={() => pickKind(kind)}
              >
                {toolKindLabel(kind)}
              </button>
            {/each}
          </div>
        </div>
        <div class="meta-row">
          <span class="field">Working directory</span>
          <input
            class="cwd-input"
            value={draftTool.cwd ?? ""}
            oninput={(e) => setField("cwd", e.currentTarget.value)}
            placeholder="Workspace root"
            spellcheck="false"
          />
        </div>
      {:else}
        <p class="params">{toolKindLabel(draftTool.kind)}</p>
      {/if}

      {#if bodyEditor?.shape === "text" || promptBacked}
        <textarea
          class="body"
          class:mono={bodyEditor?.shape === "text" && bodyEditor.mono}
          value={draftBody}
          oninput={(e) => onBodyInput(e.currentTarget.value)}
          spellcheck={!(bodyEditor?.shape === "text" && bodyEditor.mono)}
          aria-label={bodyEditor?.shape === "text" ? bodyEditor.label : "Prompt"}
          placeholder={bodyEditor?.shape === "text" ? bodyEditor.placeholder : ""}
          readonly={builtin && !promptBacked}
        ></textarea>
      {:else if bodyEditor?.shape === "none"}
        <p class="hint">{bodyEditor.note}</p>
      {:else if bodyEditor?.shape === "action"}
        <p class="hint">Body is the action name “{draftTool.body}”. Duplicate to re-author.</p>
      {/if}
    {:else}
      <p class="empty-detail">Select a tool or prompt to edit.</p>
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
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface-base);
    color: var(--text);
  }
  .explorer.app-scope {
    min-height: 420px;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .sidebar-head {
    padding: 0.6rem 0.7rem;
    border-bottom: 1px solid var(--border);
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
    color: var(--text-subtle);
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
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.active {
    background: var(--surface-selected);
  }
  .row-icon {
    display: flex;
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  .row-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .pill {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted);
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
    color: var(--text-muted);
    margin: 0;
  }
  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 0.85rem 1rem 1rem;
    gap: 0.5rem;
    background: var(--surface-base);
  }
  .detail-head {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    justify-content: space-between;
  }
  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .titles h3 {
    margin: 0;
    font-size: 1rem;
    color: var(--text);
  }
  .name-input,
  .desc-input,
  .cwd-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    padding: 0.35rem 0.5rem;
  }
  .name-input {
    font-size: 1rem;
    font-weight: 600;
  }
  .desc-input {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .desc,
  .source,
  .params,
  .hint {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .hint.warn {
    color: var(--warning-text);
  }
  .actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .save,
  .run {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    font: inherit;
    cursor: pointer;
  }
  .save {
    background: var(--surface-raised);
    color: var(--text);
  }
  .run {
    background: var(--accent);
    color: var(--text-inverted);
  }
  .save:disabled,
  .run:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .run-slot {
    display: inline-flex;
  }
  .chip {
    display: inline-flex;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .meta-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field {
    font-size: 0.75rem;
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .kind-chip {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.75rem;
    padding: 2px 8px;
    cursor: pointer;
  }
  .kind-chip.on {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--surface-selected);
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
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--text);
  }
  .body::placeholder {
    color: var(--text-subtle);
  }
  .body.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
  }
  .body[readonly] {
    opacity: 0.85;
  }
  .error {
    color: var(--danger-text);
    font-size: 0.85rem;
  }
</style>
