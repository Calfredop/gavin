<script lang="ts">
  // Everything waiting on the human, on a screen of its own: a thin
  // template over hub/inboxView.ts. Grouped by Workstation, then
  // workspace, filtered by kind, and windowed -- only the entries near
  // the screen are drawn, so a thousand items are not a thousand live
  // buttons.
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import type { Snippet } from "svelte";
  import type { AttentionKind } from "$shell/connection/attention";
  import type { InboxRow } from "$shell/hub/inbox";
  import { groupedEntries, kindPlural, kindTotals, listLayout, visibleRange, type InboxEntry } from "$shell/hub/inboxView";
  import InboxItem from "$shell/surfaces/InboxItem.svelte";

  interface Props {
    rows: InboxRow[];
    onOpenItem: (row: InboxRow) => void;
    onBack: () => void;
    /// The hub's own lines -- a visit opening or failing -- which a tap
    /// here starts.
    notices?: Snippet;
  }
  let { rows, onOpenItem, onBack, notices }: Props = $props();

  let kind = $state<AttentionKind | null>(null);
  const totals = $derived(kindTotals(rows));
  /// A kind whose last item went is no filter any more.
  const shown = $derived(kind && totals.some((t) => t.kind === kind) ? kind : null);
  const entries = $derived(groupedEntries(rows, shown));

  // Each entry type's height, read off a hidden one of each: they follow
  // the phone's text size. Until then, near enough to bound the first
  // drawing.
  let itemHeight = $state(0);
  let workstationHeight = $state(0);
  let workspaceHeight = $state(0);
  const layout = $derived(
    listLayout(entries, {
      item: itemHeight || 96,
      workstation: workstationHeight || 48,
      workspace: workspaceHeight || 40,
    })
  );

  let scroller = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  /// A screen above and below what is on it, so a flick does not outrun
  /// the drawing.
  const span = $derived(viewport || 900);
  const range = $derived(visibleRange(layout, scrollTop, span, span));
  // Numbers, so a scroll that keeps the same entries redraws nothing.
  const start = $derived(range.start);
  const end = $derived(range.end);
  const visible = $derived(entries.slice(start, end).map((entry, i) => ({ entry, top: layout.offsets[start + i] })));

  function filter(next: AttentionKind | null): void {
    kind = next;
    if (scroller) scroller.scrollTop = 0;
    scrollTop = 0;
  }

  const PROBE: InboxRow = {
    key: "probe",
    workstationId: "probe",
    workstationName: "",
    workspace: "",
    kind: "waiting",
    text: "",
    target: null,
  };
</script>

{#snippet line(entry: InboxEntry)}
  {#if entry.type === "workstation"}
    <h2 class="group"><span class="name">{entry.name}</span><span class="count">{entry.count}</span></h2>
  {:else if entry.type === "workspace"}
    <h3 class="space">{entry.name}</h3>
  {:else}
    <InboxItem row={entry.row} fixed onOpen={onOpenItem} />
  {/if}
{/snippet}

<PhoneHeader title="Waiting on you" back="Workstations" {onBack} />
{@render notices?.()}
<div class="filters" role="group" aria-label="Show">
  <button type="button" class="filter" aria-pressed={shown === null} onclick={() => filter(null)}>
    All <span class="count">{rows.length}</span>
  </button>
  {#each totals as total (total.kind)}
    <button type="button" class="filter" aria-pressed={shown === total.kind} onclick={() => filter(total.kind)}>
      {kindPlural(total.kind)} <span class="count">{total.count}</span>
    </button>
  {/each}
</div>
<div
  class="list"
  bind:this={scroller}
  bind:clientHeight={viewport}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
  <ul class="track" style:height="{layout.total}px">
    {#each visible as { entry, top } (entry.key)}
      <li class="slot slot-{entry.type}" style:transform="translateY({top}px)">
        {@render line(entry)}
      </li>
    {/each}
  </ul>
  <!-- One of each, never seen, to measure. -->
  <div class="probes" aria-hidden="true" inert>
    <div class="slot slot-workstation" bind:offsetHeight={workstationHeight}>
      {@render line({ type: "workstation", key: "probe-ws", name: "Workstation", count: 1 })}
    </div>
    <div class="slot slot-workspace" bind:offsetHeight={workspaceHeight}>
      {@render line({ type: "workspace", key: "probe-space", name: "Workspace" })}
    </div>
    <div class="slot slot-item" bind:offsetHeight={itemHeight}>
      {@render line({ type: "item", key: "probe-item", row: PROBE })}
    </div>
  </div>
</div>

<style>
  .filters {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    scrollbar-width: none;
  }
  .filter {
    flex: 0 0 auto;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: 22px;
    background: none;
    color: var(--text);
    font-size: 0.875rem;
    white-space: nowrap;
  }
  .filter[aria-pressed="true"] {
    border-color: var(--border-accent);
    background: var(--surface-accent);
    color: var(--accent-text);
  }
  .filter .count {
    color: var(--text-muted);
  }
  .list {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
    overflow-y: auto;
  }
  .track {
    position: relative;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .slot {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    box-sizing: border-box;
    padding: 0 var(--space-2);
  }
  .slot-item {
    padding-bottom: var(--space-1);
  }
  .group {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    margin: 0;
    padding: var(--space-2) 0 var(--space-1);
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
  }
  .group .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .group .count {
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 400;
  }
  .space {
    margin: 0;
    padding: var(--space-1) 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1.4;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .probes {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .probes .slot {
    position: static;
  }
</style>
