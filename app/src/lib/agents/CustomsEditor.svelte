<script lang="ts">
  import {
    addCustomProfile,
    deleteCustomProfile,
    renameCustomProfile,
    updateCustomProfile,
  } from "$lib/agents/agentsHub";
  import { API_FAMILIES, type ApiFamily } from "$lib/agents/apiFamily";
  import type { CustomProfile } from "$lib/cards/complexity";
  import { askConfirm } from "$lib/core/dialog";

  interface Props {
    profiles: CustomProfile[];
    /// Workspace Customs only manage `local:` ids.
    local?: boolean;
    apiFamilyBlocked?: string | null;
    onChange: (next: CustomProfile[]) => void;
  }
  let { profiles, local = false, apiFamilyBlocked = null, onChange }: Props = $props();

  let selectedId = $state<string | null>(null);
  let newName = $state("");
  let renameDraft = $state("");

  const selected = $derived(profiles.find((p) => p.id === selectedId) ?? null);

  $effect(() => {
    if (selectedId && profiles.some((p) => p.id === selectedId)) return;
    selectedId = profiles[0]?.id ?? null;
  });

  $effect(() => {
    renameDraft = selected?.label ?? "";
  });

  function pick(id: string): void {
    selectedId = id;
  }

  function add(): void {
    const label = newName.trim() || "Custom";
    const next = addCustomProfile(profiles, label, { local });
    const added = next.find((p) => !profiles.some((o) => o.id === p.id));
    onChange(next);
    newName = "";
    if (added) selectedId = added.id;
  }

  function commitRename(): void {
    if (!selected) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === selected.label) return;
    onChange(renameCustomProfile(profiles, selected.id, trimmed));
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    const ok = await askConfirm({
      title: `Delete “${selected.label}”?`,
      lines: [
        "Workspaces still pointing at this custom will fall back to Claude Code until they pick another agent.",
      ],
      confirmLabel: "Delete custom",
      danger: true,
    });
    if (!ok) return;
    const id = selected.id;
    onChange(deleteCustomProfile(profiles, id));
    selectedId = null;
  }

  function patch(partial: Partial<Omit<CustomProfile, "id">>): void {
    if (!selected) return;
    onChange(updateCustomProfile(profiles, selected.id, partial));
  }

  function commitField(key: "command" | "modelFlag" | "effortFlag" | "resumeArgs", value: string): void {
    if (!selected) return;
    const trimmed = value.trim();
    const current = (selected[key] ?? "").trim();
    if (trimmed === current) return;
    if (key === "effortFlag" || key === "resumeArgs") {
      patch(trimmed ? { [key]: trimmed } : { [key]: undefined });
      return;
    }
    patch({ [key]: trimmed });
  }

  function commitFamily(family: ApiFamily): void {
    if (!selected) return;
    const current = (selected.apiFamily ?? "") as ApiFamily;
    if (family === current) return;
    patch(family ? { apiFamily: family } : { apiFamily: undefined });
  }
</script>

<div class="customs">
  <div class="list-col">
    <ul class="list" role="listbox" aria-label="Custom agents">
      {#each profiles as profile (profile.id)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={profile.id === selectedId}
            class:on={profile.id === selectedId}
            onclick={() => pick(profile.id)}
          >
            {profile.label}
          </button>
        </li>
      {:else}
        <li class="empty">No customs yet.</li>
      {/each}
    </ul>
    <div class="add-row">
      <input
        class="custom"
        spellcheck="false"
        placeholder="Name"
        bind:value={newName}
        onkeydown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <button type="button" onclick={add}>Add custom</button>
    </div>
  </div>

  <div class="edit-col">
    {#if selected}
      <div class="row">
        <span>Name</span>
        <input
          class="custom"
          spellcheck="false"
          value={renameDraft}
          oninput={(e) => (renameDraft = e.currentTarget.value)}
          onblur={commitRename}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <button type="button" class="danger" onclick={() => void remove()}>Delete</button>
      </div>
      <div class="row">
        <span>Command</span>
        <input
          class="custom"
          spellcheck="false"
          placeholder="my-agent --flags"
          value={selected.command}
          onchange={(e) => commitField("command", e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <div class="row">
        <span>Model flag</span>
        <input
          class="custom"
          spellcheck="false"
          placeholder="--model"
          value={selected.modelFlag}
          onchange={(e) => commitField("modelFlag", e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <div class="row">
        <span>Effort flag</span>
        <input
          class="custom"
          spellcheck="false"
          placeholder="--effort"
          value={selected.effortFlag ?? ""}
          onchange={(e) => commitField("effortFlag", e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <div class="row">
        <label for="custom-api-family-{selected.id}">API family</label>
        <select
          id="custom-api-family-{selected.id}"
          value={(selected.apiFamily ?? "") as ApiFamily}
          disabled={apiFamilyBlocked !== null}
          onchange={(e) => commitFamily(e.currentTarget.value as ApiFamily)}
        >
          {#each API_FAMILIES as family (family.value)}
            <option value={family.value}>{family.label}</option>
          {/each}
        </select>
      </div>
      {#if apiFamilyBlocked}
        <p class="hint warn">{apiFamilyBlocked}</p>
      {/if}
      <p class="hint">
        {#if local}
          A custom that lives only in this workspace. Pick it from Profile on This agent — it is
          marked <strong>(local)</strong> in every picker here.
        {:else}
          An app-wide custom any workspace can pick. The model and effort flags are how gavin puts
          those on the command; end an effort flag with <code>=</code> when the level attaches
          (<code>--think=high</code>). Defaults can set a model and effort for each custom that
          exists here.
        {/if}
      </p>
      <p class="hint">
        The API family is what lets Headroom compress this agent: Anthropic points
        <code>ANTHROPIC_BASE_URL</code> at Headroom, OpenAI-compatible points
        <code>OPENAI_BASE_URL</code>. None leaves it uncompressed.
      </p>
    {:else}
      <p class="hint">Add a custom to edit its command, flags and API family.</p>
    {/if}
  </div>
</div>

<style>
  .customs {
    display: grid;
    grid-template-columns: minmax(140px, 200px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .list button {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 1em;
    min-height: 44px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .list button:hover {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .list button.on {
    background: var(--surface-overlay);
    color: var(--text);
    border-color: var(--border);
  }
  .empty {
    color: var(--text-subtle);
    padding: 4px 8px;
  }
  .add-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add-row input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .row > span:first-child,
  .row > label:first-child {
    width: 110px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .row select,
  .row input,
  .add-row input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .row input.custom {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 240px;
  }
  .row select {
    min-width: 140px;
    max-width: 240px;
  }
  button {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.92em;
    min-height: 44px;
    padding: 6px 12px;
    cursor: pointer;
  }
  button.danger {
    color: var(--danger-text, #f87171);
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .hint.warn {
    color: var(--warning-text, #fbbf24);
  }
  @media (max-width: 640px) {
    .customs {
      grid-template-columns: 1fr;
    }
  }
</style>
