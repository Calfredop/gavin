<script lang="ts">
  // Save-as-template: one small modal, following ToolLibraryDialog's own
  // form conventions (the fields, the scope chips, the footer) so a
  // human who has already saved a tool recognises this immediately.
  import Modal from "$lib/Modal.svelte";
  import { templateFromStage, droppedCardCount } from "$lib/orchestration/orchestrationGroups";
  import type { GroupTemplateScope } from "$lib/orchestration/orchestrationGroups";
  import type { Stage } from "$lib/orchestration/orchestration";
  import { findTool } from "$lib/orchestration/orchestrationTools";
  import type { Tool } from "$lib/orchestration/orchestrationTools";
  import { count } from "$lib/orchestration/railConfirm";

  interface Props {
    stage: Stage;
    /// To resolve a member's toolId into its name -- the same library
    /// the drawer and the rail already carry, so a workspace's own tool
    /// reads by name here too, not just a builtin.
    tools: Tool[];
    onSave: (name: string, description: string, scope: GroupTemplateScope) => Promise<string | null>;
    onClose: () => void;
  }
  let { stage, tools, onSave, onClose }: Props = $props();

  let name = $state("");
  let description = $state("");
  let scope = $state<GroupTemplateScope>("workspace");
  let error = $state<string | null>(null);
  let saving = $state(false);

  // Seeded once per DISTINCT stage.id, not on every prop update:
  // OrchestrationHubView re-derives `stage` from `orch` on every push
  // (savingTemplateStage's own derivation), and `orchestrations` is
  // replaced wholesale on both the optimistic write and the
  // "orchestration-changed" push -- routine traffic in a workspace with
  // running agents, none of it a rename. Tracking the whole `stage`
  // object here would re-seed on every one of those and silently discard
  // whatever the human is mid-typing. Tracking `stage.id` instead only
  // re-seeds when this dialog is asked to represent a genuinely
  // different group, which is the one case a stale name would actually
  // be wrong.
  let seededStageId: string | null = null;
  $effect(() => {
    if (stage.id === seededStageId) return;
    seededStageId = stage.id;
    name = stage.name ?? "";
  });

  // A template keeps tool steps only, so a mixed group loses its cards
  // (grouping spec G7). Name and scope never change WHICH steps travel,
  // so a placeholder for both here still gives the real member list.
  const members = $derived(templateFromStage(stage, "x", "", "workspace").steps);
  const keeping = $derived(members.length);
  const dropped = $derived(droppedCardCount(stage));
  const nameOf = (toolId: string): string => findTool(tools, toolId)?.name ?? toolId;

  // Save is disabled for two different reasons, and a dead button that
  // does not say which is worse than one that does -- the same rule the
  // rail's own "Save as template…" menu item already applies before this
  // dialog ever opens.
  const disabledReason = $derived(
    name.trim() === ""
      ? "Name this template before saving."
      : keeping === 0
        ? "Nothing to save — this group has no tool steps."
        : null
  );

  async function save(): Promise<void> {
    if (disabledReason || saving) return;
    saving = true;
    const failure = await onSave(name, description, scope);
    saving = false;
    if (failure) {
      error = failure;
      return;
    }
    onClose();
  }
</script>

<Modal onClose={() => !saving && onClose()}>
  <div class="body">
    <header>
      <h3>Save as template</h3>
    </header>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <label>
      <span class="field">Name</span>
      <input bind:value={name} placeholder="Merge and push" />
    </label>
    <label>
      <span class="field">Description</span>
      <input bind:value={description} placeholder="What this group does, in one line" />
    </label>

    <div class="pick">
      <span class="field">Available in</span>
      <div class="chips">
        <button
          type="button"
          class="chip"
          class:on={scope === "workspace"}
          onclick={() => (scope = "workspace")}
        >
          This workspace
        </button>
        <button
          type="button"
          class="chip"
          class:on={scope === "global"}
          onclick={() => (scope = "global")}
        >
          All workspaces
        </button>
      </div>
    </div>

    <div class="members">
      <span class="field">Steps ({keeping})</span>
      {#if keeping === 0}
        <p class="empty">This group has no tool steps to save.</p>
      {:else}
        <ul>
          {#each members as m, i (i)}
            <li>{nameOf(m.toolId)}</li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Only a MIXED group needs this line: a pure-tool group has
         nothing surprising left out, and the member list above already
         says plainly what it is saving. -->
    {#if dropped > 0}
      <p class="warn">
        Saving {count(keeping, "tool step")}. {count(dropped, "card step")}
        {dropped === 1 ? "is" : "are"} not saved: a card belongs to this workspace, so it cannot
        travel in a template.
      </p>
    {/if}

    <!-- A disabled button suppresses mouse events entirely, so a `title`
         on the Save button itself never shows -- neither the native
         tooltip nor this repo's own hover action can fire on it. Printed
         here instead, the same way the dropped-card-count line above is
         always readable rather than hidden behind a hover that cannot
         happen. -->
    {#if disabledReason}
      <p class="disabled-reason">{disabledReason}</p>
    {/if}

    <footer>
      <span class="spacer"></span>
      <button type="button" class="ghost" disabled={saving} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={Boolean(disabledReason) || saving}
        onclick={() => void save()}
      >
        {saving ? "Saving…" : "Save template"}
      </button>
    </footer>
  </div>
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 420px;
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
  .error {
    margin: 0;
    padding: 6px 8px;
    background: var(--surface-danger);
    border: 1px solid var(--border-danger);
    border-radius: 4px;
    color: var(--danger-text);
    font-size: 12px;
  }
  .warn {
    margin: 0;
    color: var(--warning-text);
    font-size: 11px;
  }
  .disabled-reason {
    margin: 0;
    color: var(--text-subtle);
    font-size: 11px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .field {
    color: var(--text-muted);
    font-size: 11px;
  }
  input {
    padding: 5px 7px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
  }
  input:focus {
    outline: none;
    border-color: var(--border-focus);
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
  .members {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .members ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .members li {
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 12px;
  }
  .empty {
    margin: 0;
    color: var(--text-subtle);
    font-size: 11px;
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
  button.primary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
  .primary {
    background: var(--surface-accent);
    border: 1px solid var(--border-focus);
    color: var(--accent-text);
  }
  .primary:disabled,
  .ghost:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
</style>
