<script lang="ts">
  import { X } from "@lucide/svelte";
  import Modal from "$lib/core/Modal.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { unsavedEditsIndicator } from "$lib/ui/indicators";
  import { gitStore, loadIgnoreFile, saveIgnoreFile, dismissError } from "$lib/git/gitState";
  import { IGNORE_KIND_LABEL, type IgnoreKind } from "$lib/git/gitIgnore";

  interface Props {
    workspaceId: string;
    /// Which tab opens first — a per-file "Ignore…" shortcut lands
    /// directly on its own file; the toolbar button defaults to gitignore.
    kind: IgnoreKind;
    onClose: () => void;
  }
  let { workspaceId, kind: initialKind, onClose }: Props = $props();

  let kind = $state<IgnoreKind>(initialKind);
  // Per-tab drafts, loaded lazily and kept once loaded: switching tabs
  // must not throw away an edit the human has not saved yet, and must
  // not re-fetch a tab that is already open.
  let drafts = $state<Record<IgnoreKind, string | null>>({ gitignore: null, exclude: null });
  let baselines = $state<Record<IgnoreKind, string | null>>({ gitignore: null, exclude: null });
  let loadError = $state<string | null>(null);
  let saving = $state(false);

  const content = $derived(drafts[kind] ?? "");
  const loading = $derived(drafts[kind] === null);
  const dirty = $derived(baselines[kind] !== null && drafts[kind] !== baselines[kind]);
  const saveError = $derived($gitStore[workspaceId]?.error ?? null);

  async function ensureLoaded(k: IgnoreKind): Promise<void> {
    if (drafts[k] !== null) return;
    loadError = null;
    try {
      const text = await loadIgnoreFile(workspaceId, k);
      drafts = { ...drafts, [k]: text };
      baselines = { ...baselines, [k]: text };
    } catch (e) {
      loadError = `Couldn't read ${IGNORE_KIND_LABEL[k]}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  $effect(() => {
    void ensureLoaded(kind);
  });

  function edit(text: string): void {
    drafts = { ...drafts, [kind]: text };
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    saving = true;
    const savedKind = kind;
    const text = content;
    const ok = await saveIgnoreFile(workspaceId, savedKind, text);
    saving = false;
    if (ok) baselines = { ...baselines, [savedKind]: text };
  }
</script>

<Modal {onClose} wide innerScroll>
  <div class="editor">
    <div class="head">
      <div class="titles">
        <h2>Ignore rules</h2>
        <p class="who">
          {#if kind === "gitignore"}Committed with the repo — shared with everyone who clones it.
          {:else}Local to this checkout only — never committed, never shared.{/if}
        </p>
      </div>
      <IconButton icon={X} label="Close" size={14} onclick={onClose} />
    </div>

    <div class="tabs" role="tablist">
      {#each Object.entries(IGNORE_KIND_LABEL) as [k, label] (k)}
        <button type="button" role="tab" aria-selected={kind === k} class:active={kind === k} onclick={() => (kind = k as IgnoreKind)}>
          {label}
          {#if baselines[k as IgnoreKind] !== null && drafts[k as IgnoreKind] !== baselines[k as IgnoreKind]}
            <StatusBadge indicator={unsavedEditsIndicator()} size={9} />
          {/if}
        </button>
      {/each}
    </div>

    {#if loadError}<p class="strip error">{loadError}</p>{/if}
    {#if saveError}
      <p class="strip error" role="alert">
        {saveError}
        <IconButton icon={X} label="Dismiss" size={12} onclick={() => dismissError(workspaceId)} />
      </p>
    {/if}

    <textarea
      class="body"
      spellcheck="false"
      disabled={loading}
      placeholder={loading ? "Loading…" : "One pattern per line…"}
      value={content}
      oninput={(e) => edit(e.currentTarget.value)}
    ></textarea>

    <div class="actions">
      <button type="button" onclick={onClose}>Close</button>
      <button type="button" class="primary" disabled={!dirty || saving || loading} onclick={save}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 10px;
    height: min(70vh, 620px);
    width: min(70vw, 640px);
    font-family: monospace;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .titles {
    min-width: 0;
    flex: 1;
  }
  h2 {
    margin: 0;
    font-size: 1.05em;
  }
  .who {
    margin: 2px 0 0;
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .tabs {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.85em;
    padding: 4px 10px;
    cursor: pointer;
  }
  .tabs button.active {
    background: var(--surface-raised);
    border-color: var(--border-strong);
    color: var(--text);
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 0.85em;
  }
  .strip.error {
    color: var(--danger-text);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    resize: none;
    box-sizing: border-box;
    width: 100%;
    padding: 8px 10px;
    background: var(--surface-base);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    font: inherit;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .body:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex: 0 0 auto;
  }
  .actions button {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .actions .primary {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .actions .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
