<script lang="ts">
  // Filing a new card from the phone (spec, story 46): the desk's
  // composer, cut to what a thumb types -- a kind, a title, a prompt or a
  // body, the column and, where the workspace has more than one, the
  // context. What it files, and how, is state/cards.ts's `fileCard`.
  import { untrack } from "svelte";
  import { COMPOSE_KINDS, defaultComposeStatus, type ComposeKind } from "$lib/cards/cardCompose";
  import { gavinTrees } from "$lib/core/gavinState";
  import type { Workspace } from "$lib/core/workspace";
  import { fileCard } from "$companion/state/cards";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";

  interface Props {
    workspace: Workspace;
    /// The board's column names: the statuses a card can be filed with.
    columns: string[];
    /// The column the board was showing when this opened.
    initialStatus: string | null;
    /// Closes the composer, with the card it filed and the column it
    /// filed it in, if it filed one.
    onClose: (filed: { path: string; status: string } | null) => void;
  }
  let { workspace, columns, initialStatus, onClose }: Props = $props();

  const KIND_LABELS: Record<ComposeKind, string> = { task: "Task", plan: "Plan", note: "Note" };
  const BODY_LABELS: Record<ComposeKind, string> = { task: "Prompt", plan: "Body", note: "Body" };
  const BODY_HINTS: Record<ComposeKind, string> = {
    task: "What the agent is to do",
    plan: "The steps, as a checklist",
    note: "Anything worth keeping",
  };

  const contexts = $derived(($gavinTrees[workspace.id]?.contexts ?? []).filter((c) => !c.outside));

  let kind = $state<ComposeKind>("task");
  let title = $state("");
  let body = $state("");
  let status = $state(untrack(() => defaultComposeStatus(columns, initialStatus) ?? ""));
  let context = $state(untrack(() => contexts.find((c) => c.kind === "root")?.folderPath ?? contexts[0]?.folderPath ?? ""));
  let problem = $state<string | null>(null);
  let filing = $state(false);

  /// Focus in the title as the sheet opens: typing it is the one thing to
  /// do here. An action rather than `autofocus`, which a page decides for
  /// itself as it loads and not for an element drawn afterwards.
  function focusNow(node: HTMLInputElement): void {
    node.focus();
  }

  async function file(): Promise<void> {
    if (filing) return;
    filing = true;
    problem = null;
    try {
      const filed = await fileCard(workspace.id, { kind, title, body, status, contextFolder: context });
      if ("error" in filed) {
        problem = filed.error;
        return;
      }
      onClose({ path: filed.path, status });
    } finally {
      filing = false;
    }
  }
</script>

<div class="sheet" role="dialog" aria-modal="true" aria-label="New card">
  <PhoneHeader title="New card" back="Cancel" onBack={() => onClose(null)} />
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void file();
    }}
  >
    <div class="kinds" role="radiogroup" aria-label="Kind">
      {#each COMPOSE_KINDS as k (k)}
        <button
          type="button"
          role="radio"
          class="kind"
          class:picked={kind === k}
          aria-checked={kind === k}
          onclick={() => (kind = k)}
        >
          {KIND_LABELS[k]}
        </button>
      {/each}
    </div>

    <label class="field">
      <span class="label">Title</span>
      <input type="text" bind:value={title} enterkeyhint="next" autocomplete="off" use:focusNow />
    </label>

    <label class="field">
      <span class="label">{BODY_LABELS[kind]}</span>
      <textarea bind:value={body} rows="6" placeholder={BODY_HINTS[kind]}></textarea>
    </label>

    <label class="field">
      <span class="label">Column</span>
      <select bind:value={status}>
        {#each columns as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </label>

    {#if contexts.length > 1}
      <label class="field">
        <span class="label">Context</span>
        <select bind:value={context}>
          {#each contexts as c (c.folderPath)}
            <option value={c.folderPath}>{c.name}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if problem}
      <p class="problem" role="alert">{problem}</p>
    {/if}

    <button type="submit" class="file" disabled={filing || title.trim() === "" || !status || !context}>
      {filing ? "Filing…" : "File card"}
    </button>
  </form>
</div>

<style>
  /* Over the whole page, like any page of a phone app, with the board
     under it just as it was left. Fixed to the page, which is itself
     sized to what the keyboard leaves visible (viewport.ts). */
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--surface-base);
  }
  .form {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    padding: 14px max(14px, env(safe-area-inset-right)) calc(20px + env(safe-area-inset-bottom))
      max(14px, env(safe-area-inset-left));
    overflow-y: auto;
  }
  .kinds {
    display: flex;
    gap: 8px;
  }
  .kind {
    flex: 1 1 0;
    min-height: 44px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .kind.picked {
    border-color: var(--border-accent);
    background: var(--surface-accent);
    color: var(--accent-text);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label {
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  /* 16px and no smaller: below it iOS zooms the page into a field the
     moment it takes focus. */
  input,
  textarea,
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: 16px;
  }
  textarea {
    resize: vertical;
    line-height: 1.45;
  }
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible,
  .kind:focus-visible,
  .file:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .problem {
    margin: 0;
    color: var(--danger-text);
    font-size: 0.875rem;
  }
  .file {
    min-height: 48px;
    border: 1px solid var(--border-accent);
    border-radius: 6px;
    background: var(--surface-accent);
    color: var(--accent-text);
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .file:disabled {
    opacity: 0.45;
  }
</style>
