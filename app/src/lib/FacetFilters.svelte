<script lang="ts">
  // The three dropdowns Kanban, Review and Plans now answer the same
  // way -- context, kind, rail -- plus the link toggle that decides
  // whether THIS tab's answer is the shared one (hubFacets.ts) or its
  // own. One component rather than three copies of the same markup: a
  // change here reaches every tab that renders it, which a third
  // hand-rolled copy would not have.
  //
  // No wrapping element: the host's own `.facets`/`.board-bar` row lays
  // these out beside whatever else belongs there (a status select, an
  // archive toggle), the same way the markup behaved before it moved
  // here.
  import { Link2, Link2Off } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/tooltip";
  import { ANY, NO_RAIL, KIND_FACETS, type BoardFacets, type ContextFacet } from "$lib/boardFilters";
  import type { RailIndex } from "$lib/planFilter";

  interface Props {
    facets: BoardFacets;
    contexts: ContextFacet[];
    rails: RailIndex;
    /// Whether this tab is following the other two right now.
    linked: boolean;
    onChange: (next: BoardFacets) => void;
    onToggleLink: () => void;
  }
  let { facets, contexts, rails, linked, onChange, onToggleLink }: Props = $props();
</script>

<select
  value={facets.context}
  aria-label="Filter by context"
  use:tooltip={"Show only the cards in one context and its subfolders — the root is every card"}
  onchange={(e) => onChange({ ...facets, context: e.currentTarget.value })}
>
  {#each contexts as ctx (ctx.value)}
    <option value={ctx.value} title={ctx.folderPath}>{ctx.label}</option>
  {/each}
</select>
<select
  value={facets.kind}
  aria-label="Filter by kind"
  use:tooltip={"Show only one kind of card"}
  onchange={(e) => onChange({ ...facets, kind: e.currentTarget.value })}
>
  <option value={ANY}>Any kind</option>
  {#each KIND_FACETS as facet (facet.value)}
    <option value={facet.value}>{facet.label}</option>
  {/each}
</select>
<select
  value={facets.rail}
  aria-label="Filter by rail"
  use:tooltip={"Show only the cards one orchestration rail carries"}
  onchange={(e) => onChange({ ...facets, rail: e.currentTarget.value })}
>
  <option value={ANY}>Any rail</option>
  <option value={NO_RAIL}>On no rail</option>
  {#each rails.rails as rail (rail.id)}
    <option value={rail.id}>{rail.name}</option>
  {/each}
</select>
<IconButton
  icon={linked ? Link2 : Link2Off}
  label={linked ? "Unlink this tab's filters" : "Link this tab's filters"}
  tip={linked
    ? "Filters follow Kanban, Review and Plans together — click to give this tab its own"
    : "This tab has its own filters — click to follow the others again"}
  variant="outlined"
  tone={linked ? "default" : "accent"}
  active={!linked}
  size={12}
  class="facet-link"
  onclick={onToggleLink}
/>

<style>
  select {
    flex: 1 1 0;
    min-width: 0;
    max-width: 160px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.72rem;
    padding: 2px 4px;
  }
  /* No `flex: 0 0 auto` for .facet-link here: the class rides on
     IconButton's own element, and a :global() rule reaching for it would
     be app-wide -- Svelte's scoping does not confine it to this
     component (globalStyleScope.test.ts). Each host anchors that rule
     under one of ITS OWN scoped classes instead, the way KanbanBoard
     already does for its archive toggle. */
</style>
