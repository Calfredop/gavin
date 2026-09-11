<script lang="ts">
  // The four checkbox dropdowns Kanban, Review and Plans now answer the
  // same way -- context, kind, rail, label -- plus the link toggle that
  // decides whether THIS tab's answer is the shared one (hubFacets.ts)
  // or its own. One component rather than three copies of the same
  // markup: a change here reaches every tab that renders it, which a
  // third hand-rolled copy would not have.
  //
  // No wrapping element: the host's own `.facets`/`.board-bar` row lays
  // these out beside whatever else belongs there (a status select, an
  // archive toggle), the same way the markup behaved before it moved
  // here.
  import { Link2, Link2Off } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import FacetDropdown from "$lib/board/FacetDropdown.svelte";
  import {
    ALL_CONTEXTS_LABEL,
    ANY_KIND_LABEL,
    ANY_LABEL_LABEL,
    ANY_RAIL_LABEL,
    KIND_FACETS,
    labelFacets,
    railFacets,
    type BoardFacets,
    type ContextFacet,
  } from "$lib/board/boardFilters";
  import type { RailIndex } from "$lib/board/planFilter";

  interface Props {
    facets: BoardFacets;
    contexts: ContextFacet[];
    rails: RailIndex;
    /// The board's label vocabulary. Empty is a real answer -- no labels
    /// yet -- and still renders the control so it does not appear and
    /// vanish; with nothing to tick it sits disabled on "Any label".
    labels?: { name: string }[];
    /// Whether this tab is following the other two right now.
    linked: boolean;
    onChange: (next: BoardFacets) => void;
    onToggleLink: () => void;
  }
  let { facets, contexts, rails, labels = [], linked, onChange, onToggleLink }: Props = $props();
  const labelOptions = $derived(labelFacets(labels));
  const railOptions = $derived(railFacets(rails));
</script>

<FacetDropdown
  ariaLabel="Filter by context"
  tip="Show only the cards in the chosen contexts and their subfolders — nothing chosen is every card"
  emptyLabel={ALL_CONTEXTS_LABEL}
  options={contexts}
  selected={facets.context}
  onChange={(context) => onChange({ ...facets, context })}
/>
<FacetDropdown
  ariaLabel="Filter by kind"
  tip="Show only the chosen kinds of card"
  emptyLabel={ANY_KIND_LABEL}
  options={KIND_FACETS}
  selected={facets.kind}
  onChange={(kind) => onChange({ ...facets, kind })}
/>
<FacetDropdown
  ariaLabel="Filter by rail"
  tip="Show only the cards the chosen orchestration rails carry"
  emptyLabel={ANY_RAIL_LABEL}
  options={railOptions}
  selected={facets.rail}
  onChange={(rail) => onChange({ ...facets, rail })}
/>
<FacetDropdown
  ariaLabel="Filter by label"
  tip="Show only the cards that carry any of the chosen labels"
  emptyLabel={ANY_LABEL_LABEL}
  options={labelOptions}
  selected={facets.label}
  onChange={(label) => onChange({ ...facets, label })}
/>
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
