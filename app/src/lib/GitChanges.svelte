<script lang="ts">
  import { gitStore, select, stageFiles, unstageFiles, stageAll, unstageAll, discardFiles } from "./gitState";
  import { LIST_DISPLAY_CAP, type Area, type FileEntry } from "./git";
  import { describeFileDiscard, type FileDiscardPrompt } from "./discardFlow";
  import GitFileRow from "./GitFileRow.svelte";
  import GitCommitBox from "./GitCommitBox.svelte";
  import GitDiscardDialog from "./GitDiscardDialog.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const unstaged = $derived(view?.status?.unstaged ?? []);
  const staged = $derived(view?.status?.staged ?? []);
  const selected = $derived(view?.selected ?? null);
  const busy = $derived(view?.busy != null);
  const sections = $derived([
    { area: "unstaged" as Area, items: unstaged },
    { area: "staged" as Area, items: staged },
  ]);

  function list(area: Area): FileEntry[] {
    return area === "unstaged" ? unstaged : staged;
  }

  function toggle(entry: FileEntry, area: Area): void {
    if (busy) return;
    void (area === "unstaged" ? stageFiles(workspaceId, [entry.path]) : unstageFiles(workspaceId, [entry.path]));
  }

  // File-level discard always confirms (spec §4) — it is the one
  // irreversible action here, and `git clean` deletes untracked files.
  let pending = $state<FileDiscardPrompt | null>(null);
  function askDiscard(entry: FileEntry): void {
    if (busy) return;
    pending = describeFileDiscard([entry]);
  }
  function confirmDiscard(): void {
    if (!pending) return;
    const { tracked, untracked } = pending;
    pending = null;
    void discardFiles(workspaceId, tracked, untracked);
  }

  // ↑/↓ within a list, Tab between lists, Space stages/unstages (spec §4).
  function onKeydown(e: KeyboardEvent): void {
    if (!selected) {
      if (e.key === "ArrowDown" && unstaged.length > 0) {
        e.preventDefault();
        void select(workspaceId, { path: unstaged[0].path, area: "unstaged" });
      }
      return;
    }
    const items = list(selected.area);
    const idx = items.findIndex((i) => i.path === selected.path);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) void select(workspaceId, { path: next.path, area: selected.area });
    } else if (e.key === "Tab") {
      const other: Area = selected.area === "unstaged" ? "staged" : "unstaged";
      const target = list(other);
      if (target.length > 0) {
        e.preventDefault();
        void select(workspaceId, { path: target[0].path, area: other });
      }
    } else if (e.key === " ") {
      e.preventDefault();
      const entry = items[idx];
      if (entry) toggle(entry, selected.area);
    }
  }
</script>

<div class="changes" tabindex="0" role="listbox" aria-label="Changed files" onkeydown={onKeydown}>
  {#each sections as { area, items } (area)}
    <section class="list">
      <header>
        <span class="title">{area === "unstaged" ? "Unstaged" : "Staged"}</span>
        <span class="count">{items.length}</span>
        <span class="spacer"></span>
        {#if items.length > 0}
          <button
            type="button"
            class="all"
            disabled={busy}
            onclick={() => (area === "unstaged" ? stageAll(workspaceId) : unstageAll(workspaceId))}
          >
            {area === "unstaged" ? "Stage all" : "Unstage all"}
          </button>
        {/if}
      </header>
      <div class="rows">
        {#each items.slice(0, LIST_DISPLAY_CAP) as entry (area + ":" + entry.path)}
          <GitFileRow
            {entry}
            {area}
            selected={selected?.area === area && selected.path === entry.path}
            disabled={busy}
            onSelect={() => select(workspaceId, { path: entry.path, area })}
            onToggle={() => toggle(entry, area)}
            onDiscard={area === "unstaged" ? () => askDiscard(entry) : undefined}
          />
        {/each}
        {#if items.length > LIST_DISPLAY_CAP}
          <div class="more">… and {items.length - LIST_DISPLAY_CAP} more</div>
        {/if}
        {#if items.length === 0}
          <div class="none">{area === "unstaged" ? "No unstaged changes" : "Nothing staged"}</div>
        {/if}
      </div>
    </section>
  {/each}
  <GitCommitBox {workspaceId} />
</div>

{#if pending}
  <GitDiscardDialog title={pending.title} body={pending.body} offerSkip={false} onConfirm={confirmDiscard} onCancel={() => (pending = null)} />
{/if}

<style>
  .changes {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
    background: #1a1a1a;
  }
  .changes:focus-visible {
    box-shadow: inset 0 0 0 1px #4a6a8a;
  }
  .list {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid #2f2f2f;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 0.72em;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .count {
    color: #8bc98b;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .all {
    text-transform: none;
    letter-spacing: 0;
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .all:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .all:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .more,
  .none {
    padding: 6px 8px;
    color: #666;
    font-size: 0.75em;
  }
</style>
