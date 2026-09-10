<script lang="ts">
  import { gitStore, select, stageFiles, unstageFiles, stageAll, unstageAll, discardFiles, stashPop, stashApply, selectChanges, addIgnorePattern } from "$lib/git/gitState";
  import { layoutState, setGitViewPrefs } from "$lib/core/layoutState";
  import { DEFAULT_SHARE, shareFromHeight } from "$lib/git/gitChangesSplit";
  import { tooltip } from "$lib/core/tooltip";
  import { LIST_DISPLAY_CAP, type Area, type FileEntry } from "$lib/git/git";
  import { describeFileDiscard, type FileDiscardPrompt } from "$lib/git/discardFlow";
  import { openContextMenuFromEvent, type ContextMenuEntry } from "$lib/core/contextMenu";
  import { ignoreMenuItems, type IgnoreKind } from "$lib/git/gitIgnore";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import GitCommitBox from "$lib/git/GitCommitBox.svelte";
  import GitDiscardDialog from "$lib/git/GitDiscardDialog.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { filterFiles } from "$lib/git/gitSearch";
  import { isSearching } from "$lib/core/search";

  interface Props {
    workspaceId: string;
    onOpenIgnoreEditor: (kind: IgnoreKind) => void;
  }
  let { workspaceId, onOpenIgnoreEditor }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const allUnstaged = $derived(view?.status?.unstaged ?? []);
  const allStaged = $derived(view?.status?.staged ?? []);
  const selected = $derived(view?.selected ?? null);
  const busy = $derived(view?.busy != null);

  // The path filter. Keyboard navigation and the Stage/Unstage-all
  // buttons all run over the FILTERED lists, so what a key or a button
  // does is always what the pane is showing.
  let query = $state("");
  const filtering = $derived(isSearching(query));
  const unstaged = $derived(filterFiles(allUnstaged, query));
  const staged = $derived(filterFiles(allStaged, query));
  const shown = $derived(unstaged.length + staged.length);
  const totalFiles = $derived(allUnstaged.length + allStaged.length);
  const sections = $derived([
    { area: "unstaged" as Area, items: unstaged },
    { area: "staged" as Area, items: staged },
  ]);

  // The divider between the two lists. The split is kept as Unstaged's
  // SHARE of the pair and applied as their flex-grow factors, so it
  // holds whatever height the column has -- see gitChangesSplit.ts.
  const prefShare = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.unstagedShare ?? DEFAULT_SHARE);
  let share = $state(DEFAULT_SHARE);
  $effect(() => {
    share = prefShare;
  });

  // Window-level listeners with a buttons===0 bail-out, like the column
  // splitters in GitHubView: WKWebView drops pointerup when the
  // pointerdown target leaves the DOM, and rows come and go under this
  // one as the watcher refreshes.
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    // The divider's own neighbours are the two blocks it divides.
    const el = e.currentTarget as HTMLElement | null;
    const top = el?.previousElementSibling as HTMLElement | null;
    const bottom = el?.nextElementSibling as HTMLElement | null;
    if (!top || !bottom) return;
    const startY = e.clientY;
    const startH = top.offsetHeight;
    const total = startH + bottom.offsetHeight;
    const startShare = share;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      share = shareFromHeight(startH + ev.clientY - startY, total);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // A click that never moved writes nothing -- which also keeps the
      // two clicks of a double-click from racing the reset below.
      if (share !== startShare) void setGitViewPrefs(workspaceId, { unstagedShare: share });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // Double-click restores the even split the column ships with -- the
  // way back from a divider dragged somewhere unhelpful.
  function evenOut(): void {
    share = DEFAULT_SHARE;
    void setGitViewPrefs(workspaceId, { unstagedShare: undefined });
  }

  // Stage/unstage all means all of WHAT IS LISTED. Unfiltered that is
  // the whole area (the cheap bulk command); filtered it is exactly the
  // matches, never the files the human cannot see.
  function bulk(area: Area): void {
    if (busy) return;
    if (!filtering) {
      void (area === "unstaged" ? stageAll(workspaceId) : unstageAll(workspaceId));
      return;
    }
    const paths = list(area).map((e) => e.path);
    if (paths.length === 0) return;
    void (area === "unstaged" ? stageFiles(workspaceId, paths) : unstageFiles(workspaceId, paths));
  }
  // SP2: a selected stash swaps this column for its read-only file list.
  const stashSel = $derived(view && typeof view.navSelection === "object" ? view.navSelection.stash : null);
  const stashInfo = $derived(stashSel === null ? null : (view?.refs?.stashes.find((s) => s.index === stashSel) ?? null));

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

  // Every row offers the two editor shortcuts; an untracked row also
  // gets the "Ignore this file" quick actions (gitIgnore.ts) -- ignoring
  // an already-tracked file would not stop git from showing it modified,
  // so the pattern items are pointless noise there.
  function openIgnoreMenu(e: MouseEvent, entry: FileEntry): void {
    const patterns: ContextMenuEntry[] =
      entry.status === "?" ? [...ignoreMenuItems(entry.path, false, (kind, pattern) => void addIgnorePattern(workspaceId, kind, pattern)), { separator: true }] : [];
    openContextMenuFromEvent(e, [
      ...patterns,
      { label: "Edit .gitignore…", onPick: () => onOpenIgnoreEditor("gitignore") },
      { label: "Edit .git/info/exclude…", onPick: () => onOpenIgnoreEditor("exclude") },
    ]);
  }

  // ↑/↓ within a list, Tab between lists, Space stages/unstages (spec §4).
  function onKeydown(e: KeyboardEvent): void {
    // Typing inside this listbox must not also drive the selection: the
    // search box and the commit box both live in it, and Space here
    // stages a file. (The commit box was always in range; the guard
    // covers it now too.)
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
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

{#if stashSel !== null}
  <div class="changes stash-view">
    <section class="list">
      <header>
        <span class="title">stash@&#123;{stashSel}&#125;</span>
        <span class="spacer"></span>
        <button type="button" class="all" onclick={() => selectChanges(workspaceId)}>← Local Changes</button>
      </header>
      <div class="stash-msg">{stashInfo?.message ?? ""}{#if stashInfo} · {stashInfo.date}{/if}</div>
      <div class="filter-bar">
        <SearchInput bind:value={query} label="Search stashed files" placeholder="Filter by path…" />
      </div>
      <div class="rows">
        {#if view?.stashFiles === null || view?.stashFiles === undefined}
          <div class="none">Loading…</div>
        {:else if view.stashFiles.length === 0}
          <div class="none">Empty stash</div>
        {:else}
          {#each filterFiles(view.stashFiles, query) as entry (entry.path)}
            <GitFileRow {entry} area="unstaged" selected={false} disabled={true} readonly={true} onSelect={() => {}} onToggle={() => {}} />
          {/each}
        {/if}
      </div>
      <footer class="stash-foot">
        <button type="button" class="all" disabled={busy} onclick={() => stashPop(workspaceId, stashSel)}>Pop</button>
        <button type="button" class="all" disabled={busy} onclick={() => stashApply(workspaceId, stashSel)}>Apply</button>
      </footer>
    </section>
  </div>
{:else}
<div class="changes" tabindex="0" role="listbox" aria-label="Changed files" onkeydown={onKeydown}>
  <div class="filter-bar">
    <SearchInput
      bind:value={query}
      label="Search changed files"
      placeholder="Filter by path…"
      matches={filtering ? { shown, total: totalFiles } : null}
    />
  </div>
  {#each sections as { area, items }, i (area)}
    {#if i > 0}
      <div
        class="hsplit"
        role="separator"
        aria-orientation="horizontal"
        use:tooltip={"Drag to resize \u00b7 double-click to even out"}
        onpointerdown={startResize}
        ondblclick={evenOut}
      ></div>
    {/if}
    <section class="list" class:above-split={i === 0} style:flex-grow={i === 0 ? share : 1 - share}>
      <header>
        <span class="title">{area === "unstaged" ? "Unstaged" : "Staged"}</span>
        <span class="count" class:filtered={filtering}>
          {items.length}{filtering ? ` / ${(area === "unstaged" ? allUnstaged : allStaged).length}` : ""}
        </span>
        <span class="spacer"></span>
        {#if items.length > 0}
          <button
            type="button"
            class="all"
            disabled={busy}
            title={filtering ? `Applies to the ${items.length} shown` : ""}
            onclick={() => bulk(area)}
          >
            {area === "unstaged" ? "Stage" : "Unstage"}
            {filtering ? `${items.length} shown` : "all"}
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
            onContextMenu={(e) => openIgnoreMenu(e, entry)}
          />
        {/each}
        {#if items.length > LIST_DISPLAY_CAP}
          <div class="more">… and {items.length - LIST_DISPLAY_CAP} more</div>
        {/if}
        {#if items.length === 0}
          <div class="none">
            {#if filtering}No match{:else}{area === "unstaged" ? "No unstaged changes" : "Nothing staged"}{/if}
          </div>
        {/if}
      </div>
    </section>
  {/each}
  <GitCommitBox {workspaceId} />
</div>
{/if}

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
    background: var(--surface-sunken);
  }
  .changes:focus-visible {
    box-shadow: inset 0 0 0 1px var(--border-accent);
  }
  .list {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 0.72em;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .count {
    color: var(--success-text);
    font-variant-numeric: tabular-nums;
  }
  .count.filtered {
    color: var(--accent-text);
  }
  .list.above-split {
    /* The divider is the separation; a border under it would double up. */
    border-bottom: 0;
  }
  .hsplit {
    flex: 0 0 4px;
    cursor: row-resize;
    background: var(--surface-raised);
  }
  .hsplit:hover {
    background: var(--surface-selected);
  }
  .filter-bar {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .all {
    text-transform: none;
    letter-spacing: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .all:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
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
    color: var(--text-subtle);
    font-size: 0.75em;
  }
  .stash-view .list {
    flex: 1 1 auto;
    border-bottom: 0;
  }
  .stash-msg {
    padding: 0 8px 6px;
    color: var(--text-muted);
    font-size: 0.75em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stash-foot {
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    font-size: 0.72em;
  }
</style>
