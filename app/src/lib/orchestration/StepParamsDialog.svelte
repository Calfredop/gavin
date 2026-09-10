<script lang="ts">
  // One input per parameter a tool declares, for one step. What is saved
  // is only what DIFFERS from the tool's default (tools spec §5.4), so a
  // later edit to that default still reaches a step that never
  // deliberately overrode it.
  import Modal from "$lib/core/Modal.svelte";
  import {
    gavinActionOf,
    pruneOverrides,
    resolveToolBody,
    startRailWorkspaceChoices,
    toolKindLabel,
  } from "$lib/orchestration/orchestrationTools";
  import type { Tool } from "$lib/orchestration/orchestrationTools";

  interface Props {
    tool: Tool;
    /// The step's current overrides, sparse.
    params: Record<string, string>;
    /// This step's own workspace -- excluded from the `start-rail`
    /// workspace picker, since that field's blank default already means it.
    workspaceId: string;
    /// Every workspace the app knows of, for that same picker.
    workspaces: { id: string; name: string; rootPath?: string | null }[];
    onSave: (params: Record<string, string>) => void;
    onClose: () => void;
  }
  let { tool, params, workspaceId, workspaces, onSave, onClose }: Props = $props();

  // Seeded DENSE from the defaults, so every field renders with the
  // value that will actually be used; pruneOverrides thins it back out
  // on the way to the plan.
  //
  // Seeded in an $effect keyed on the TOOL, not at construction: the
  // dialog outlives a library edit that adds or renames a parameter, and
  // re-keying on `params` instead would clobber what the human is
  // typing every time the plan store settles.
  let draft = $state<Record<string, string>>({});
  $effect(() => {
    const shape = tool.params;
    draft = Object.fromEntries(shape.map((p) => [p.name, params[p.name] ?? p.default]));
  });

  // The `start-rail` action's own picker: every OTHER rooted workspace,
  // since a blank value already means this one.
  const workspaceChoices = $derived(startRailWorkspaceChoices(workspaces, workspaceId));
  const namedWorkspace = $derived((draft.workspace ?? "").trim());
  // A step saved before this parameter existed, or one whose target
  // workspace has since been removed -- either way an ID the picker
  // cannot offer, and dropping it silently would swap in "this
  // workspace" under the human without them touching the field.
  const missingWorkspace = $derived(
    namedWorkspace !== "" && !workspaceChoices.some((w) => w.id === namedWorkspace)
  );

  // A `gavin` tool has no body to preview: its body NAMES the action
  // rather than being source. So it promises what it will do, which is
  // the same promise the resolved body makes for the other three kinds.
  const namedRail = $derived((draft.rail ?? "").trim());
  const targetWorkspaceName = $derived(
    namedWorkspace
      ? (workspaces.find((w) => w.id === namedWorkspace)?.name ?? "a workspace that no longer exists")
      : null
  );
  const preview = $derived(
    gavinActionOf(tool) === "start-rail"
      ? namedRail
        ? targetWorkspaceName
          ? `Start the rail “${namedRail}” in ${targetWorkspaceName}.`
          : `Start the rail “${namedRail}”.`
        : "Nothing — with no rail named, this step stalls when the rail reaches it."
      : resolveToolBody(tool, draft)
  );
  const changed = $derived(Object.keys(pruneOverrides(tool, draft)).length);

  function save(): void {
    onSave(pruneOverrides(tool, draft));
    onClose();
  }

  function resetToDefaults(): void {
    draft = Object.fromEntries(tool.params.map((p) => [p.name, p.default]));
  }
</script>

<Modal {onClose}>
  <div class="body">
    <header>
      <h3>{tool.name}</h3>
      <span class="kind">{toolKindLabel(tool.kind)}</span>
    </header>
    {#if tool.description}
      <p class="desc">{tool.description}</p>
    {/if}

    <div class="fields">
      {#each tool.params as param (param.name)}
        <label>
          <span class="label">{param.label || param.name}</span>
          {#if gavinActionOf(tool) === "start-rail" && param.name === "workspace"}
            <select bind:value={draft.workspace}>
              <option value="">This workspace (default)</option>
              {#each workspaceChoices as ws (ws.id)}
                <option value={ws.id}>{ws.name}</option>
              {/each}
              {#if missingWorkspace}
                <option value={namedWorkspace}>{targetWorkspaceName}</option>
              {/if}
            </select>
          {:else}
            <input
              bind:value={draft[param.name]}
              placeholder={param.default}
              spellcheck="false"
            />
          {/if}
          {#if draft[param.name] !== param.default}
            <span class="default">default: {param.default || "(empty)"}</span>
          {/if}
        </label>
      {/each}
    </div>

    <!-- The resolved body, so the human can see exactly what will run
         BEFORE the rail reaches this step -- literal substitution (T3)
         means a stray quote is visible here and nowhere else. -->
    <p class="preview-label">
      <!-- An `until` step's body IS what runs, so the preview stays the
           resolved command -- but the command alone does not say that
           failing it sends the rail backwards, which is the whole tool. -->
      {tool.kind === "gavin"
        ? "This step will do:"
        : tool.kind === "until"
          ? "This step will run, and re-run the step before it until this passes:"
          : tool.kind === "pr"
            ? "This step will wait on this rail's pull request, re-running the step before it while a check fails:"
            : tool.kind === "review"
              ? "This step will hold the rail here until you skip it, or mark it done:"
              : "This step will run:"}
    </p>
    <pre class="preview">{preview}</pre>

    <footer>
      <button type="button" class="ghost" onclick={resetToDefaults} disabled={changed === 0}>
        Reset to defaults
      </button>
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="primary" onclick={save}>Save</button>
    </footer>
  </div>
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 420px;
    max-width: 560px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .kind {
    color: var(--text-subtle);
    font-size: 11px;
  }
  .desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .label {
    color: var(--text-muted);
    font-size: 11px;
  }
  input,
  select {
    padding: 5px 7px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--border-focus);
  }
  .default {
    color: var(--text-subtle);
    font-size: 10px;
  }
  .preview-label {
    margin: 0;
    color: var(--text-muted);
    font-size: 11px;
  }
  .preview {
    margin: 0;
    padding: 8px;
    max-height: 160px;
    overflow: auto;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spacer {
    flex: 1;
  }
  button {
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .ghost:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .ghost:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  .primary {
    background: var(--surface-accent);
    border: 1px solid var(--border-focus);
    color: var(--accent-text);
  }
</style>
