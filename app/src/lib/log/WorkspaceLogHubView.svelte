<script lang="ts">
  // The Log tab (v79, ADR 0011): what happened in this workspace, newest
  // first -- cards, runs, rails, human items, Scheduled fires and git --
  // as the daemon recorded it. Thin: the sentences, days, filter, merge and
  // card lookup are workspaceLog.ts, the daemon calls workspaceLogState.ts.
  import { untrack } from "svelte";
  import {
    Archive,
    ArchiveRestore,
    ArrowDownToLine,
    ArrowRightLeft,
    ArrowUpFromLine,
    CalendarClock,
    Check,
    ChevronDown,
    CircleCheck,
    CircleStop,
    CircleX,
    Eraser,
    FilePlus,
    FileX,
    FlaskConical,
    Gavel,
    GitBranch,
    GitCommitHorizontal,
    GitMerge,
    Pause,
    PenLine,
    Play,
    RotateCcw,
    ScrollText,
    Trash2,
    Waypoints,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import { daemonCompat, layoutState, switchWorkspaceView } from "$lib/core/layoutState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { orchestrations } from "$lib/orchestration/orchestrationState";
  import { nowStore } from "$lib/agents/agentPauseState";
  import { tooltip } from "$lib/core/tooltip";
  import { openRunCard } from "$lib/activity/activityNav";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import {
    CATEGORY_LABEL,
    LOG_CATEGORIES,
    NOTICED_ON_START_TIP,
    cardTarget,
    categorySummary,
    clearOptions,
    deletedCards,
    groupByDay,
    iconFor,
    mergeEntries,
    nextCursor,
    pushedIntoView,
    sentenceOf,
    timeLabel,
    toggleCategory,
    type ClearOption,
    type LogCategory,
    type LogEntry,
  } from "$lib/log/workspaceLog";
  import { clearLog, listenForLogEntries, readLogPage, workspaceLogBlockedReason } from "$lib/log/workspaceLogState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ICONS: Record<string, Component> = {
    Archive,
    ArchiveRestore,
    ArrowDownToLine,
    ArrowRightLeft,
    ArrowUpFromLine,
    CalendarClock,
    CircleCheck,
    CircleStop,
    CircleX,
    FilePlus,
    FileX,
    FlaskConical,
    Gavel,
    GitBranch,
    GitCommitHorizontal,
    GitMerge,
    Pause,
    PenLine,
    Play,
    RotateCcw,
    ScrollText,
    Trash2,
    Waypoints,
  };

  // Read through the stores so a daemon restarted to v79, or a root bound,
  // re-derives the gate.
  const blocked = $derived.by(() => {
    void $daemonCompat;
    void $layoutState;
    return workspaceLogBlockedReason(workspaceId);
  });
  const rootPath = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath || null);
  const tree = $derived($gavinTrees[workspaceId]);
  const railIds = $derived(new Set(($orchestrations[workspaceId]?.rails ?? []).map((r) => r.id)));
  const now = $derived(new Date($nowStore));

  let on = $state<LogCategory[]>([...LOG_CATEGORIES]);
  let search = $state("");
  let entries = $state<LogEntry[]>([]);
  let more = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // A token, not identity, guards every read: a slow page for the last
  // filter must not land on this one (Svelte 5 proxies the list, so no
  // comparison of objects can tell them apart).
  let token = 0;

  async function reload(): Promise<void> {
    const mine = ++token;
    loading = true;
    error = null;
    try {
      const page = await readLogPage(workspaceId, null, on, search);
      if (mine !== token) return;
      entries = page.entries;
      more = page.more;
    } catch (e) {
      if (mine === token) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === token) loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!more || loading) return;
    const mine = token;
    loading = true;
    try {
      const page = await readLogPage(workspaceId, nextCursor(entries), on, search);
      if (mine !== token) return;
      entries = mergeEntries(entries, page.entries);
      more = page.more;
    } catch (e) {
      if (mine === token) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === token) loading = false;
    }
  }

  // A new workspace, filter or search reads the first page again; typing
  // is let settle first.
  $effect(() => {
    void workspaceId;
    void on;
    const typed = search;
    if (blocked) return;
    const timer = setTimeout(() => untrack(() => void reload()), typed.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  });

  // Live while the tab is open.
  $effect(() => {
    if (blocked) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void listenForLogEntries((from, pushed) => {
      const add = pushedIntoView(entries, pushed, workspaceId, on, search, more);
      if (add.length > 0) entries = mergeEntries(entries, add);
    }).then((s) => {
      if (gone) s();
      else stop = s;
    });
    return () => {
      gone = true;
      stop?.();
    };
  });

  function onScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) void loadMore();
  }

  const days = $derived(groupByDay(entries, now));
  const deleted = $derived(deletedCards(entries));
  const filtered = $derived(search.trim().length > 0 || on.length < LOG_CATEGORIES.length);

  let pickerOpen = $state(false);
  let clearOpen = $state(false);
  let pickerEl = $state<HTMLElement | null>(null);
  let clearEl = $state<HTMLElement | null>(null);
  function closeMenus(event: PointerEvent): void {
    const target = event.target as Node;
    if (pickerOpen && pickerEl && !pickerEl.contains(target)) pickerOpen = false;
    if (clearOpen && clearEl && !clearEl.contains(target)) clearOpen = false;
  }

  let clearing = $state(false);
  async function clear(option: ClearOption): Promise<void> {
    clearOpen = false;
    clearing = true;
    try {
      const failed = await clearLog(workspaceId, option);
      if (failed) error = failed;
      else await reload();
    } finally {
      clearing = false;
    }
  }
</script>

<svelte:window onpointerdown={closeMenus} />

{#if blocked}
  <div class="empty">{blocked}</div>
{:else}
  <div class="log">
    <div class="head">
      <span class="label">Log</span>
      <span class="picker" bind:this={pickerEl}>
        <button
          type="button"
          class="pick"
          aria-haspopup="true"
          aria-expanded={pickerOpen}
          onclick={() => (pickerOpen = !pickerOpen)}
        >
          <span class="summary">{categorySummary(on)}</span>
          <ChevronDown size={11} />
        </button>
        {#if pickerOpen}
          <span class="menu" role="group" aria-label="Kinds of entry">
            {#each LOG_CATEGORIES as category (category)}
              {@const checked = on.includes(category)}
              <button
                type="button"
                class="option"
                role="menuitemcheckbox"
                aria-checked={checked}
                onclick={() => (on = toggleCategory(on, category))}
              >
                <span class="tick">{#if checked}<Check size={12} />{/if}</span>
                {CATEGORY_LABEL[category]}
              </button>
            {/each}
          </span>
        {/if}
      </span>
      <SearchInput
        class="search"
        value={search}
        onValue={(next) => (search = next)}
        placeholder="Cards, rails, branches, worktrees…"
        label="Search the log"
      />
      <span class="picker clear" bind:this={clearEl}>
        <button
          type="button"
          class="pick"
          aria-haspopup="true"
          aria-expanded={clearOpen}
          disabled={clearing}
          onclick={() => (clearOpen = !clearOpen)}
          use:tooltip={"Delete older log entries. Cards, runs and their history are not touched."}
        >
          <Eraser size={12} /> Clear older than…
        </button>
        {#if clearOpen}
          <span class="menu" role="menu" aria-label="Clear older than">
            {#each clearOptions(now) as option (option.label)}
              <button type="button" class="option" role="menuitem" onclick={() => void clear(option)}>
                {option.label}
              </button>
            {/each}
          </span>
        {/if}
      </span>
    </div>
    {#if error}<p class="err">{error}</p>{/if}

    <div class="rows" onscroll={onScroll}>
      {#if entries.length === 0 && loading}
        <div class="none">Reading the log…</div>
      {:else if entries.length === 0 && filtered}
        <div class="none">Nothing in the log matches.</div>
      {:else if entries.length === 0}
        <div class="none">
          Nothing has happened here yet. Cards, runs, rails, human items, Scheduled fires and git land here as they happen.
        </div>
      {/if}
      {#each days as day (day.key)}
        <div class="day">{day.label}</div>
        {#each day.entries as entry (entry.id)}
          {@const Icon = ICONS[iconFor(entry.kind)] ?? ScrollText}
          <div class="row">
            <span class="time">{timeLabel(entry.at)}</span>
            <span class="icon"><Icon size={13} /></span>
            <span class="sentence">
              {#each sentenceOf(entry, rootPath) as part, i (i)}
                {#if part.type === "card"}
                  {@const target = cardTarget(entry, tree, deleted)}
                  {#if target.state === "open"}
                    <button type="button" class="link" onclick={() => openRunCard(workspaceId, target.path)}>
                      {part.text}
                    </button>
                  {:else if target.state === "gone"}
                    <span class="name">{part.text}</span><span class="gone"> (gone — deleted)</span>
                  {:else}
                    <span class="name">{part.text}</span>
                  {/if}
                {:else if part.type === "rail"}
                  {#if entry.payload.railId && railIds.has(entry.payload.railId)}
                    <button type="button" class="link" onclick={() => void switchWorkspaceView(workspaceId, "orchestration")}>
                      {part.text}
                    </button>
                  {:else}
                    <span class="name">{part.text}</span>
                  {/if}
                {:else if part.type === "name"}
                  <span class="name">{part.text}</span>
                {:else}
                  {part.text}
                {/if}
              {/each}
            </span>
            {#if entry.payload.noticedOnStart}
              <span class="noticed" use:tooltip={NOTICED_ON_START_TIP}>noticed on start</span>
            {/if}
          </div>
        {/each}
      {/each}
      {#if more && entries.length > 0}
        <div class="none">{loading ? "Reading older entries…" : ""}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .log {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--text);
  }
  .empty,
  .none {
    padding: 16px;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--hub-bar-height);
    box-sizing: border-box;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .label {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .head :global(.search) {
    flex: 1;
    max-width: 320px;
  }
  .clear {
    margin-left: auto;
  }
  .picker {
    position: relative;
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 260px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    font-size: 0.72rem;
    padding: 3px 6px;
    cursor: pointer;
  }
  .pick:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 140px;
    padding: 4px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
  }
  .clear .menu {
    left: auto;
    right: 0;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 4px 6px;
    color: var(--text);
    font: inherit;
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
  }
  .option:hover {
    background: var(--surface-hover);
  }
  .tick {
    display: inline-flex;
    width: 12px;
  }
  .err {
    margin: 0;
    padding: 6px 12px;
    color: var(--danger-text);
    font-size: 0.8em;
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 12px;
  }
  .day {
    position: sticky;
    top: 0;
    padding: 10px 12px 4px;
    background: var(--surface-base);
    color: var(--text-muted);
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 12px;
    font-size: 0.85em;
    line-height: 1.45;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .time {
    flex: none;
    width: 3em;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .icon {
    flex: none;
    display: inline-flex;
    align-self: center;
    color: var(--text-muted);
  }
  .sentence {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-weight: 600;
  }
  .gone {
    color: var(--text-muted);
    font-style: italic;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .noticed {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 0.75em;
  }
</style>
