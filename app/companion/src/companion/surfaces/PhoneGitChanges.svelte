<script lang="ts">
  // The Changes pane: what is not staged, what is, and the commit box
  // under them. The rows and the box are the desktop's own; a tap on a
  // row opens its diff, and its button stages or unstages it.
  import type { Area, FileEntry } from "$lib/git/git";
  import GitCommitBox from "$lib/git/GitCommitBox.svelte";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import { gitStore, select, stageAll, stageFiles, unstageAll, unstageFiles } from "$lib/git/gitState";
  import { changeSections, gitLocked } from "$companion/surfaces/phoneGit";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const sections = $derived(view ? changeSections(view) : []);
  const locked = $derived(gitLocked(view));

  function toggle(entry: FileEntry, area: Area): void {
    if (locked) return;
    void (area === "unstaged" ? stageFiles(workspaceId, [entry.path]) : unstageFiles(workspaceId, [entry.path]));
  }

  function bulk(area: Area): void {
    if (locked) return;
    void (area === "unstaged" ? stageAll(workspaceId) : unstageAll(workspaceId));
  }
</script>

<div class="changes">
  {#each sections as section (section.area)}
    <section class="section" aria-label={section.title}>
      <header class="section-head">
        <span class="title">{section.title}</span>
        <span class="total">{section.total}</span>
        {#if section.bulk}
          <button type="button" class="bulk" disabled={locked} onclick={() => bulk(section.area)}>
            {section.bulk}
          </button>
        {/if}
      </header>
      {#each section.entries as entry (section.area + ":" + entry.path)}
        <GitFileRow
          {entry}
          area={section.area}
          selected={false}
          disabled={locked}
          onSelect={() => void select(workspaceId, { path: entry.path, area: section.area })}
          onToggle={() => toggle(entry, section.area)}
        />
      {:else}
        <p class="none">{section.empty}</p>
      {/each}
      {#if section.hidden > 0}
        <p class="none">… and {section.hidden} more</p>
      {/if}
    </section>
  {/each}
  <!-- In the scroll, after what it commits, rather than pinned under it:
       the phone's keyboard comes up over whatever is pinned, and a field
       in a scroller is one the page can bring into view. -->
  <div class="commit">
    <GitCommitBox {workspaceId} />
  </div>
</div>

<style>
  .changes {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
    overflow-y: auto;
    /* The desktop's rows and box size themselves in em from here: a
       phone's body size, where the desk's pane is set smaller. */
    font-size: 1.125rem;
  }
  .section {
    border-bottom: 1px solid var(--border);
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px;
    color: var(--text-muted);
    font-size: 0.6875rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .total {
    flex: 1 1 auto;
    color: var(--success-text);
    font-variant-numeric: tabular-nums;
  }
  .bulk {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.75rem;
    letter-spacing: 0;
    text-transform: none;
  }
  .bulk:disabled {
    opacity: 0.45;
  }
  .none {
    margin: 0;
    padding: 4px 12px 12px;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .commit {
    padding: 0 4px 16px;
  }
</style>
