<script lang="ts">
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { gitStore, selectDetailFile } from "$lib/git/gitState";
  import { layoutState, setGitViewPrefs } from "$lib/layoutState";
  import { shortSha, LARGE_HUNK_LINES, type DiffLayout } from "$lib/git/git";
  import { toUnifiedRows, toSplitRows } from "$lib/git/diffRows";
  import { tooltip } from "$lib/tooltip";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import GitDiffUnified from "$lib/git/GitDiffUnified.svelte";
  import GitDiffSplit from "$lib/git/GitDiffSplit.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const sha = $derived(view?.selectedCommit ?? null);
  const commit = $derived(sha ? (view?.log?.commits.find((c) => c.sha === sha) ?? null) : null);
  const detail = $derived(view?.commitDetail ?? null);
  const diff = $derived(view?.detailDiff ?? null);
  const layout = $derived<DiffLayout>($layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.diffLayout ?? "unified");
  const unifiedRows = $derived(diff ? toUnifiedRows(diff.hunks) : []);
  const splitRows = $derived(diff ? toSplitRows(diff.hunks) : []);
  const noSelection = new Set<string>();

  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void diff;
    expanded = new Set();
  });
  const isCollapsed = (h: number, n: number): boolean => n > LARGE_HUNK_LINES && !expanded.has(h);
  const expand = (h: number): void => {
    expanded = new Set([...expanded, h]);
  };
  const noop = (): void => {};
  const nullLabel = (): null => null;

  let copied = $state(false);
  async function copySha(): Promise<void> {
    if (!sha) return;
    await writeText(sha);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<div class="detail">
  {#if !sha || !commit}
    <div class="msg">Select a commit to see its details</div>
  {:else}
    <div class="head">
      <button type="button" class="sha" use:tooltip={copied ? "Copied" : "Copy full SHA"} onclick={copySha}>{shortSha(sha)}</button>
      <span class="who" title={commit.email}>{commit.author} &lt;{commit.email}&gt;</span>
      <span class="when">{commit.date}</span>
      <span class="spacer"></span>
      <span class="seg" role="radiogroup" aria-label="Diff layout">
        <button type="button" class:on={layout === "unified"} role="radio" aria-checked={layout === "unified"} onclick={() => setGitViewPrefs(workspaceId, { diffLayout: "unified" })}>Unified</button>
        <button type="button" class:on={layout === "split"} role="radio" aria-checked={layout === "split"} onclick={() => setGitViewPrefs(workspaceId, { diffLayout: "split" })}>Split</button>
      </span>
    </div>
    {#if commit.refs.length > 0}
      <div class="chips">
        {#each commit.refs as r (r.kind + r.name)}<span class="chip {r.kind}">{r.name}</span>{/each}
      </div>
    {/if}
    <pre class="message">{detail?.body ?? commit.subject}</pre>
    <div class="files" role="listbox" aria-label="Changed files">
      {#if !detail}
        <div class="none">Loading…</div>
      {:else if detail.files.length === 0}
        <div class="none">No file changes</div>
      {:else}
        {#each detail.files as entry (entry.path)}
          <GitFileRow
            {entry}
            area="staged"
            selected={view?.detailFile === entry.path}
            disabled={true}
            readonly={true}
            onSelect={() => selectDetailFile(workspaceId, entry.path)}
            onToggle={noop}
          />
        {/each}
      {/if}
    </div>
    <div class="diff">
      {#if !view?.detailFile}
        <div class="msg small">Select a file</div>
      {:else if !diff}
        <div class="msg small">Loading…</div>
      {:else if diff.binary}
        <div class="msg small">Binary file — no text diff</div>
      {:else if diff.tooLarge}
        <div class="msg small">Diff too large (&gt; 2 MB)</div>
      {:else if diff.hunks.length === 0}
        <div class="msg small">No textual changes</div>
      {:else if layout === "split"}
        <GitDiffSplit rows={splitRows} {isCollapsed} canAct={false} actionLabel="" onHunkAction={noop} onExpand={expand} selection={noSelection} onLineClick={noop} onDragRange={noop} selectedLabel={nullLabel} discardLabel={nullLabel} onHunkDiscard={noop} />
      {:else}
        <GitDiffUnified rows={unifiedRows} {isCollapsed} canAct={false} actionLabel="" onHunkAction={noop} onExpand={expand} selection={noSelection} onLineClick={noop} onDragRange={noop} selectedLabel={nullLabel} discardLabel={nullLabel} onHunkDiscard={noop} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
    font-family: monospace;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.78em;
  }
  .sha {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--warning-text);
    font-family: monospace;
    font-size: 1em;
    padding: 1px 7px;
    cursor: pointer;
  }
  .sha:hover {
    border-color: var(--border-strong);
  }
  .who {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.95em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 10px 0;
    font-size: 0.72em;
  }
  .chip {
    border: 1px solid;
    border-radius: 8px;
    padding: 0 6px;
  }
  .chip.local { color: var(--success-text); border-color: var(--border-success); }
  .chip.remote { color: var(--accent-text); border-color: var(--border-accent); }
  .chip.tag { color: var(--warning-text); border-color: var(--border-warning); }
  .chip.stash, .chip.head { color: var(--text-muted); border-color: var(--border); }
  .message {
    margin: 0;
    padding: 8px 10px;
    white-space: pre-wrap;
    color: var(--text);
    font-size: 0.8em;
    max-height: 30%;
    overflow: auto;
    border-bottom: 1px solid var(--border);
  }
  .files {
    flex: 0 1 auto;
    max-height: 35%;
    overflow: auto;
    border-bottom: 1px solid var(--border);
  }
  .diff {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-size: 0.8em;
  }
  .msg.small {
    padding: 16px;
  }
  .none {
    padding: 6px 8px;
    color: var(--text-subtle);
    font-size: 0.75em;
  }
</style>
