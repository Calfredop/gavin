<script lang="ts">
  // The Review tab's left column: finished cards, clustered by the files
  // their runs touched.
  //
  // Collapsible to a rail rather than hideable, for the sidebar's
  // reason: the three columns to the right are all ABOUT the selected
  // card, so a list that could vanish entirely would leave a view with
  // no way back to its own subject. Collapsed it keeps a button to
  // reopen and nothing else.
  import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, RefreshCw, Archive } from "@lucide/svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { tooltip } from "./tooltip";
  import { type ReviewGroup } from "./reviewBoard";
  import type { Column } from "./kanban";

  interface Props {
    groups: ReviewGroup[];
    selected: string | null;
    collapsed: boolean;
    query: string;
    includeArchived: boolean;
    /// Every column on the board, and the ids currently treated as
    /// "review". The picker writes ids; `resolveReviewColumns` turns a
    /// null choice back into the done column.
    columns: Column[];
    reviewColumnIds: string[];
    loading: boolean;
    /// Card paths whose touched files are still being read, so a card is
    /// never drawn as fileless while the answer is in flight.
    loadingPaths: Set<string>;
    /// Which of these cards live in `plans/archive/`. A CardView carries
    /// no archived flag -- being in the archive IS the fact, and
    /// mergePlanCards answers it by which list a card came out of -- so
    /// the host that did the merge hands the answer down.
    archivedPaths: Set<string>;
    onSelect: (path: string) => void;
    onQuery: (next: string) => void;
    onToggleArchived: () => void;
    onToggleColumn: (id: string) => void;
    onToggleCollapsed: () => void;
    onRefresh: () => void;
  }
  let {
    groups,
    selected,
    collapsed,
    query,
    includeArchived,
    columns,
    reviewColumnIds,
    loading,
    loadingPaths,
    archivedPaths,
    onSelect,
    onQuery,
    onToggleArchived,
    onToggleColumn,
    onToggleCollapsed,
    onRefresh,
  }: Props = $props();

  // Groups start open. Collapsing is per group and lives here rather
  // than in the prefs: it is a gesture about what you are reading right
  // now, and a group's identity is its file set, which changes whenever
  // anything in the fleet writes.
  let folded = $state<Set<string>>(new Set());
  const isFolded = (id: string): boolean => folded.has(id);
  function toggleGroup(id: string): void {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    folded = next;
  }

  let pickerOpen = $state(false);
  const total = $derived(groups.reduce((n, g) => n + g.cards.length, 0));
</script>

{#if collapsed}
  <div class="rail">
    <IconButton
      icon={PanelLeftOpen}
      label="Show the review list"
      tip="Show the review list"
      size={14}
      onclick={onToggleCollapsed}
    />
    <span class="rail-count">{total}</span>
  </div>
{:else}
  <div class="list">
    <div class="head">
      <SearchInput
        value={query}
        onValue={onQuery}
        placeholder="Search review…"
        label="Search cards up for review"
        class="grow"
      />
      <IconButton
        icon={Archive}
        label="Show archived cards"
        tip={includeArchived ? "Hide archived cards" : "Show archived cards too"}
        tone={includeArchived ? "accent" : "default"}
        size={14}
        onclick={onToggleArchived}
      />
      <IconButton
        icon={RefreshCw}
        label="Re-read what these cards touched"
        tip="Re-read what these cards touched"
        size={14}
        disabled={loading}
        onclick={onRefresh}
      />
      <IconButton
        icon={PanelLeftClose}
        label="Collapse the review list"
        tip="Collapse the review list"
        size={14}
        onclick={onToggleCollapsed}
      />
    </div>

    <div class="columns">
      <button
        type="button"
        class="picker-toggle"
        aria-expanded={pickerOpen}
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        {#if pickerOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
        Reviewing
        <span class="chosen">{columns.filter((c) => reviewColumnIds.includes(c.id)).map((c) => c.name).join(", ") || "—"}</span>
      </button>
      {#if pickerOpen}
        <div class="picker">
          {#each columns as column (column.id)}
            <label>
              <input
                type="checkbox"
                checked={reviewColumnIds.includes(column.id)}
                onchange={() => onToggleColumn(column.id)}
              />
              {column.name}
            </label>
          {/each}
        </div>
      {/if}
    </div>

    <div class="groups">
      {#if groups.length === 0}
        <p class="empty">
          {query.trim()
            ? "No card up for review matches that."
            : "Nothing is waiting for review."}
        </p>
      {:else}
        {#each groups as group (group.id)}
          <div class="group">
            <button type="button" class="group-head" onclick={() => toggleGroup(group.id)}>
              {#if isFolded(group.id)}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
              <span class="group-label" title={group.files.join("\n")}>{group.label}</span>
              <span class="group-count">{group.cards.length}</span>
            </button>
            {#if group.hint && !isFolded(group.id)}
              <!-- Whatever the header cannot say, decided in
                   reviewBoard.ts: the fileless bucket holds runs nobody
                   measured AND runs measured to have moved nothing, and
                   a same-baseline group holds cards whose file list is
                   one measurement rather than an agreement. Telling
                   either as something it is not is the conflation that
                   module is built around. -->
              <p class="group-hint">{group.hint}</p>
            {/if}
            {#if !isFolded(group.id)}
              <div class="cards" role="listbox" aria-label={group.label}>
                {#each group.cards as candidate (candidate.card.id)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    class="card"
                    class:selected={selected === candidate.card.id}
                    role="option"
                    aria-selected={selected === candidate.card.id}
                    tabindex="-1"
                    onclick={() => onSelect(candidate.card.id)}
                  >
                    <span class="title">{candidate.card.title}</span>
                    <span class="meta">
                      {#if archivedPaths.has(candidate.card.id)}
                        <span class="chip archived">archived</span>
                      {:else if candidate.card.status}
                        <span class="chip">{candidate.card.status}</span>
                      {/if}
                      {#if loadingPaths.has(candidate.card.id)}
                        <span class="files reading">reading…</span>
                      {:else if candidate.files === null}
                        <!-- Never "0 files": a card nobody measured and a
                             card that changed nothing are opposite
                             answers (reviewBoard.ts). -->
                        <span class="files" use:tooltip={"Gavin didn't record where this run started."}>
                          not measured
                        </span>
                      {:else}
                        <span class="files">
                          {candidate.files.length} file{candidate.files.length === 1 ? "" : "s"}
                        </span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px;
    height: 100%;
    border-right: 1px solid var(--border);
    /* See ReviewHubView's `.review`: the app has no root text colour, so
       a rule that names none renders black. */
    color: var(--text);
  }
  .rail-count {
    font-size: 0.75em;
    color: var(--text-muted);
  }
  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    border-right: 1px solid var(--border);
    /* This is the rule the owner's screenshot was about: the card titles
       below inherit from here, and with no colour named they came out
       #2a2a2a on #1e1e1e. See ReviewHubView's `.review`. */
    color: var(--text);
  }
  /* The strip's opposite number -- this column has no strip over it, so
     its search row IS the tab's first row and has to be the same height
     or the two halves of the window start at different y. */
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--review-strip-height);
    box-sizing: border-box;
    padding: 0 6px;
    flex: none;
  }
  .head :global(.grow) {
    flex: 1;
    min-width: 0;
  }
  /* The three column heads' opposite number. `min-height` rather than
     `height`: the picker expands inside this block, and a fixed one
     would clip the checkboxes. Closed, it measures the same as a head,
     so all four rules land on one y. */
  .columns {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: none;
    min-height: var(--review-head-height);
    box-sizing: border-box;
    padding: 0 6px;
    border-bottom: 1px solid var(--border);
  }
  .picker-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 4px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  .chosen {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 4px 6px;
  }
  .picker label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    cursor: pointer;
  }
  .groups {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0 8px;
  }
  .empty {
    margin: 16px 12px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-align: center;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.78em;
    cursor: pointer;
  }
  .group-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .group-count {
    flex: none;
    opacity: 0.7;
  }
  .group-hint {
    margin: 0 8px 4px 22px;
    font-size: 0.75em;
    color: var(--text-muted);
    opacity: 0.85;
  }
  .cards {
    display: flex;
    flex-direction: column;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px 8px 5px 22px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .card:hover {
    background: var(--surface-hover);
  }
  .card.selected {
    background: var(--surface-selected);
    border-left-color: var(--accent);
  }
  .title {
    font-size: 0.88em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.72em;
    color: var(--text-muted);
  }
  .files.reading {
    opacity: 0.7;
  }
  .chip {
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    white-space: nowrap;
  }
  .chip.archived {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
</style>
