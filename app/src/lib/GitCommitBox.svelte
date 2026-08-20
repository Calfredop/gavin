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
    border-top: 1px solid #2f2f2f;
    background: #161616;
    font-size: 0.78em;
  }
  .summary,
  .description {
    width: 100%;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    color: #ddd;
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
    resize: vertical;
  }
  .summary:focus,
  .description:focus {
    outline: none;
    border-color: #4a6a8a;
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
    color: #bbb;
    cursor: pointer;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .commit {
    background: #2d4a2d;
    border: 1px solid #3f6b3f;
    border-radius: 6px;
    color: #cfe8cf;
    padding: 4px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .commit:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .author {
    color: #777;
    font-size: 0.92em;
  }
  .warn {
    color: #d9b45c;
  }
</style>
