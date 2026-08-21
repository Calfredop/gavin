<script lang="ts">
  import { gitStore, setCommitDraft, commit, canCommit } from "./gitState";
  import { tooltip } from "./tooltip";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const stagedCount = $derived(view?.status?.staged.length ?? 0);
  const author = $derived(view?.repo?.author ?? null);
  const unborn = $derived(view?.repo?.unborn ?? false);
  const draft = $derived(view?.commit ?? { summary: "", description: "", amend: false });
  const enabled = $derived(view ? canCommit(view) : false);

  function onKeydown(e: KeyboardEvent): void {
    if (e.metaKey && e.key === "Enter" && enabled) {
      e.preventDefault();
      void commit(workspaceId);
    }
  }
</script>

<div class="box">
  <input
    class="summary"
    type="text"
    placeholder="Summary"
    value={draft.summary}
    oninput={(e) => setCommitDraft(workspaceId, { summary: e.currentTarget.value })}
    onkeydown={onKeydown}
  />
  <textarea
    class="description"
    placeholder="Description"
    rows="3"
    value={draft.description}
    oninput={(e) => setCommitDraft(workspaceId, { description: e.currentTarget.value })}
    onkeydown={onKeydown}
  ></textarea>
  <div class="foot">
    {#if !unborn}
      <label class="amend" use:tooltip={"Replace the last commit with the staged changes and this message"}>
        <input type="checkbox" checked={draft.amend} onchange={(e) => setCommitDraft(workspaceId, { amend: e.currentTarget.checked })} />
        Amend
      </label>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="commit" disabled={!enabled} use:tooltip={"⌘Enter"} onclick={() => commit(workspaceId)}>
      {draft.amend ? "Amend" : `Commit (${stagedCount})`}
    </button>
  </div>
  <div class="author">
    {#if author}
      {author.name} &lt;{author.email}&gt;
    {:else}
      <span class="warn">Set user.name and user.email in git config</span>
    {/if}
  </div>
</div>

<style>
  .box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
    background: var(--surface-sunken);
    font-size: 0.78em;
  }
  .summary,
  .description {
    width: 100%;
    box-sizing: border-box;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
    resize: vertical;
  }
  .summary:focus,
  .description:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .amend {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .commit {
    background: var(--surface-success);
    border: 1px solid var(--border-success);
    border-radius: 6px;
    color: var(--success-text);
    padding: 4px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .commit:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .author {
    color: var(--text-subtle);
    font-size: 0.92em;
  }
  .warn {
    color: var(--warning-text);
  }
</style>
