<script lang="ts">
  // The tool library: one modal, two modes. List mode shows what exists,
  // grouped by scope; edit mode is the form. Built-ins are read-only and
  // offer Duplicate rather than Edit (tools spec T4).
  import { Bot, Terminal, FileCode2, Plus, Copy, Pencil, Trash2 } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import {
    TOOL_KINDS,
    toolKindLabel,
    emptyTool,
    duplicateTool,
    validateTool,
    undeclaredPlaceholders,
    type Tool,
    type ToolKind,
    type ToolScope,
  } from "./orchestrationTools";
  import { saveToolAction, deleteToolAction } from "./toolsState";

  interface Props {
    workspaceId: string;
    tools: Tool[];
    onClose: () => void;
  }
  let { workspaceId, tools, onClose }: Props = $props();

  /// Null is list mode. Editing holds a DRAFT, never a library object --
  /// the list re-renders from the store the moment a save lands, and
  /// mutating a library entry in place would fight that.
  let editing = $state<Tool | null>(null);
  let error = $state<string | null>(null);
  let confirmingDelete = $state<string | null>(null);
  let saving = $state(false);

  const iconFor = (kind: ToolKind) =>
    kind === "agent" ? Bot : kind === "command" ? Terminal : FileCode2;

  const SECTIONS: Array<{ scope: ToolScope; title: string; blurb: string }> = [
    { scope: "workspace", title: "This workspace", blurb: "Only this workspace sees these." },
    { scope: "global", title: "All workspaces", blurb: "Shared by every workspace on this machine." },
    { scope: "builtin", title: "Built-in", blurb: "Shipped with gavin. Duplicate one to change it." },
  ];

  const byScope = $derived((scope: ToolScope) =>
    tools.filter((t) => t.scope === scope).sort((a, b) => a.name.localeCompare(b.name))
  );

  const undeclared = $derived(editing ? undeclaredPlaceholders(editing) : []);

  function startNew(): void {
    error = null;
    editing = emptyTool(crypto.randomUUID());
  }

  function startEdit(tool: Tool): void {
    error = null;
    // A copy, so Cancel really cancels.
    editing = { ...tool, params: tool.params.map((p) => ({ ...p })) };
  }

  function startDuplicate(tool: Tool): void {
    error = null;
    editing = duplicateTool(tool, crypto.randomUUID());
  }

  async function save(): Promise<void> {
    if (!editing || saving) return;
    const problem = validateTool(editing);
    if (problem) {
      error = problem;
      return;
    }
    saving = true;
    const failure = await saveToolAction(workspaceId, editing);
    saving = false;
    if (failure) {
      error = failure;
      return;
    }
    editing = null;
  }

  async function remove(toolId: string): Promise<void> {
    const failure = await deleteToolAction(workspaceId, toolId);
    confirmingDelete = null;
    if (failure) error = failure;
  }

  function addParam(): void {
    if (!editing) return;
    editing.params = [...editing.params, { name: "", label: "", default: "" }];
  }

  function removeParam(index: number): void {
    if (!editing) return;
    editing.params = editing.params.filter((_, i) => i !== index);
  }
</script>

<Modal onClose={editing ? () => (editing = null) : onClose}>
  <div class="body">
    {#if !editing}
      <header>
        <h3>Tools</h3>
        <button type="button" class="primary" onclick={startNew}>
          <Plus size={13} /> New tool
        </button>
      </header>
      <p class="intro">
        A tool is a reusable step: an agent prompt, a bash command, or a bash script. Drag one onto
        a rail from the drawer.
      </p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="sections">
        {#each SECTIONS as section (section.scope)}
          {@const rows = byScope(section.scope)}
          <section>
            <h4>{section.title}</h4>
            <p class="blurb">{section.blurb}</p>
            {#if rows.length === 0}
              <p class="empty">Nothing here yet.</p>
            {:else}
              <ul>
                {#each rows as tool (tool.id)}
                  {@const Icon = iconFor(tool.kind)}
                  <li>
                    <Icon size={13} />
                    <span class="name">{tool.name}</span>
                    <span class="kind">{toolKindLabel(tool.kind)}</span>
                    {#if tool.params.length > 0}
                      <span class="params">{tool.params.length}p</span>
                    {/if}
                    {#if confirmingDelete === tool.id}
                      <span class="confirm">Delete?</span>
                      <button type="button" class="danger" onclick={() => void remove(tool.id)}>
                        Delete
                      </button>
                      <button type="button" class="ghost" onclick={() => (confirmingDelete = null)}>
                        Keep
                      </button>
                    {:else if tool.scope === "builtin"}
                      <IconButton
                        icon={Copy}
                        label="Duplicate to edit"
                        size={13}
                        onclick={() => startDuplicate(tool)}
                      />
                    {:else}
                      <IconButton
                        icon={Copy}
                        label="Duplicate"
                        size={13}
                        onclick={() => startDuplicate(tool)}
                      />
                      <IconButton
                        icon={Pencil}
                        label="Edit"
                        size={13}
                        onclick={() => startEdit(tool)}
                      />
                      <IconButton
                        icon={Trash2}
                        label="Delete"
                        tone="danger"
                        size={13}
                        onclick={() => (confirmingDelete = tool.id)}
                      />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>

      <footer>
        <span class="spacer"></span>
        <button type="button" class="ghost" onclick={onClose}>Done</button>
      </footer>
    {:else}
      <header>
        <h3>{tools.some((t) => t.id === editing?.id) ? "Edit tool" : "New tool"}</h3>
      </header>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <label>
        <span class="field">Name</span>
        <input bind:value={editing.name} placeholder="Deploy to staging" />
      </label>
      <label>
        <span class="field">Description</span>
        <input bind:value={editing.description} placeholder="What this does, in one line" />
      </label>

      <div class="row">
        <div class="pick">
          <span class="field">Runs as</span>
          <div class="chips">
            {#each TOOL_KINDS as kind (kind)}
              <button
                type="button"
                class="chip"
                class:on={editing.kind === kind}
                onclick={() => editing && (editing.kind = kind)}
              >
                {toolKindLabel(kind)}
              </button>
            {/each}
          </div>
        </div>
        <div class="pick">
          <span class="field">Available in</span>
          <div class="chips">
            <button
              type="button"
              class="chip"
              class:on={editing.scope === "workspace"}
              onclick={() => editing && (editing.scope = "workspace")}
            >
              This workspace
            </button>
            <button
              type="button"
              class="chip"
              class:on={editing.scope === "global"}
              onclick={() => editing && (editing.scope = "global")}
            >
              All workspaces
            </button>
          </div>
        </div>
      </div>

      <label>
        <span class="field">
          {editing.kind === "agent" ? "Prompt" : editing.kind === "command" ? "Command" : "Script"}
        </span>
        <textarea
          bind:value={editing.body}
          class:mono={editing.kind !== "agent"}
          rows={editing.kind === "command" ? 3 : 8}
          spellcheck={editing.kind === "agent"}
          placeholder={editing.kind === "agent"
            ? "What the agent should do, in this rail's checkout."
            : "./deploy.sh {{env}}"}
        ></textarea>
      </label>
      <p class="hint">
        Use <code>{"{{name}}"}</code> to drop a parameter in. Substitution is literal — you own the
        quoting.
      </p>
      {#if undeclared.length > 0}
        <p class="warn">
          No parameter declares {undeclared.map((n) => `{{${n}}}`).join(", ")} — it will be left in
          the body as written.
        </p>
      {/if}

      <div class="params-head">
        <span class="field">Parameters</span>
        <button type="button" class="ghost small" onclick={addParam}>
          <Plus size={12} /> Add
        </button>
      </div>
      {#if editing.params.length === 0}
        <p class="empty">No parameters — the body runs exactly as written.</p>
      {:else}
        <div class="params-grid">
          <span class="col">name</span>
          <span class="col">label</span>
          <span class="col">default</span>
          <span></span>
          {#each editing.params as _param, i (i)}
            <input bind:value={editing.params[i].name} placeholder="env" spellcheck="false" />
            <input bind:value={editing.params[i].label} placeholder="Environment" />
            <input bind:value={editing.params[i].default} placeholder="staging" spellcheck="false" />
            <IconButton
              icon={Trash2}
              label="Remove parameter"
              tone="danger"
              size={13}
              onclick={() => removeParam(i)}
            />
          {/each}
        </div>
      {/if}

      <footer>
        <span class="spacer"></span>
        <button type="button" class="ghost" onclick={() => (editing = null)}>Cancel</button>
        <button type="button" class="primary" disabled={saving} onclick={() => void save()}>
          {saving ? "Saving…" : "Save tool"}
        </button>
      </footer>
    {/if}
  </div>
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 620px;
    max-width: 78vw;
    max-height: 76vh;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h3 {
    flex: 1;
    margin: 0;
    font-size: 14px;
  }
  h4 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .intro,
  .blurb,
  .hint,
  .empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 11px;
  }
  .blurb,
  .empty {
    color: var(--text-subtle);
  }
  .warn {
    margin: 0;
    color: var(--warning-text);
    font-size: 11px;
  }
  .error {
    margin: 0;
    padding: 6px 8px;
    background: var(--surface-danger);
    border: 1px solid var(--border-danger);
    border-radius: 4px;
    color: var(--danger-text);
    font-size: 12px;
  }
  .sections {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  ul {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 12px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind,
  .params,
  .confirm {
    flex: none;
    color: var(--text-subtle);
    font-size: 10px;
  }
  .confirm {
    color: var(--danger-text);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .field,
  .col {
    color: var(--text-muted);
    font-size: 11px;
  }
  .col {
    color: var(--text-subtle);
    font-size: 10px;
  }
  input,
  textarea {
    padding: 5px 7px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
  }
  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--border-focus);
  }
  textarea.mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
  .row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .pick {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .chips {
    display: flex;
    gap: 4px;
  }
  .chip {
    padding: 4px 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
  }
  .chip.on {
    background: var(--surface-accent);
    border-color: var(--border-focus);
    color: var(--accent-text);
  }
  .params-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .params-head .field {
    flex: 1;
  }
  .params-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap: 4px;
    align-items: center;
  }
  code {
    padding: 0 3px;
    background: var(--surface-sunken);
    border-radius: 3px;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    position: sticky;
    bottom: 0;
    padding-top: 8px;
    background: var(--surface-raised);
  }
  .spacer {
    flex: 1;
  }
  button.ghost,
  button.primary,
  button.danger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
  }
  button.small {
    padding: 3px 7px;
    font-size: 11px;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .ghost:hover {
    background: var(--surface-hover);
  }
  .primary {
    background: var(--surface-accent);
    border: 1px solid var(--border-focus);
    color: var(--accent-text);
  }
  .primary:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .danger {
    background: var(--surface-danger);
    border: 1px solid var(--border-danger);
    color: var(--danger-text);
  }
</style>
