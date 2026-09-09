<script lang="ts">
  import {
    ChevronRight,
    ChevronLeft,
    ChevronDown,
    FileText,
    ListChecks,
    Settings2,
    Group,
  } from "@lucide/svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { orchDragState } from "$lib/orchestrationDrag";
  import { searchDrawer } from "$lib/orchestrationSearch";
  import { toolKindLabel } from "$lib/orchestrationTools";
  import type { Tool } from "$lib/orchestrationTools";
  import type { UnplacedGroup } from "$lib/orchestration";
  import type { GroupTemplate } from "$lib/orchestrationGroups";
  import { toolIcon } from "$lib/ui/toolKindIcon";

  interface Props {
    groups: UnplacedGroup[];
    /// Every tool this workspace can reach: built-in, global, its own.
    tools: Tool[];
    /// Every group template this workspace can reach: its own plus every
    /// global one, in the order templateLibrary already sorted them --
    /// this workspace's first, then the machine's, each alphabetical.
    templates: GroupTemplate[];
    /// Nested children per plan path (orchestration.nestedChildCounts).
    /// A nested child is not listed here -- its plan carries it, on the
    /// board and on a rail alike -- so the plan's row says how many it
    /// carries rather than letting them look lost.
    nestedCounts: Map<string, number>;
    /// Clicking a TOOL or GROUP row adds it to this rail as its own
    /// stage; null when there is no rail to add to yet. The tab renders
    /// this drawer with no rails too (it used to withhold it with the
    /// whole body), so null is a state the rows are SEEN in: those rows
    /// stay listed but inert -- no drag handle, click-to-add disabled --
    /// the same degradation toolsBlocked gives a tool row, and the hint
    /// says to add a rail. A CARD row only loses its drag handle: a
    /// press on one reads the card, which needs no rail at all.
    targetRailId: string | null;
    /// A press on a card row opens that card's detail modal -- the row
    /// IS a kanban card, and the tab already owns the board's modal for
    /// its placed steps. Placement from here is the deliberate gesture:
    /// drag the row onto the rail you mean, or use that rail's own
    /// "+ Add step". (It used to append to whichever rail happened to be
    /// first, a target the row never named.)
    onOpenCard: (cardPath: string) => void;
    /// The tab's search box holds a query: the rows below are the
    /// matches, not the whole pool, and dragging is off.
    filtering?: boolean;
    hiddenCount?: number;
    onAddTool: (toolId: string) => void;
    onManageTools: () => void;
    onAddTemplate: (templateId: string) => void;
    onManageTemplates: () => void;
    /// Why the running daemon cannot carry tools, or null. A daemon
    /// older than v11 has no `tool_id` column: it would accept a tool
    /// step and store a step with neither a card nor a tool, which comes
    /// back as an untitled chip. So the rows stay visible -- the human
    /// should still see what tools ARE -- but inert, with the reason on
    /// hover and no drag handle at all.
    toolsBlocked?: string | null;
    /// Same rule as toolsBlocked, one version later: placing a template
    /// writes a `mode` (FEATURE_MIN_VERSION.groups) just as forming a
    /// group by hand does, so a pre-v15 daemon needs the same inert
    /// degradation here.
    groupsBlocked?: string | null;
  }
  let {
    groups,
    tools,
    templates,
    nestedCounts,
    targetRailId,
    onOpenCard,
    onAddTool,
    onManageTools,
    onAddTemplate,
    onManageTemplates,
    filtering = false,
    hiddenCount = 0,
    toolsBlocked = null,
    groupsBlocked = null,
  }: Props = $props();

  let collapsed = $state(false);
  const dragging = $derived($orchDragState !== null);

  // Built-ins first, then everything the human made, each alphabetical --
  // a stable order, so a tool stays where they last saw it.
  const SCOPE_ORDER: Tool["scope"][] = ["builtin", "workspace", "global"];
  const sortedTools = $derived(
    [...tools].sort(
      (a, b) =>
        SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name)
    )
  );

  // The panel's own quick filter (orchestrationSearch.searchDrawer). It
  // reaches all three lists below -- groups, tools AND cards -- which is
  // what the tab's box above cannot do: that one is a lens over the
  // rails, and a tool has never been on a rail to be found. The two
  // compose, this one applied to what the tab's already handed down.
  //
  // Unlike the tab's box, a query here does NOT take dragging away. The
  // hub locks its drag engine while filtering because rails leave the
  // grid and a new-stage index measured over what is left lands wrong;
  // nothing here moves a rail. A drawer row is grabbed by its own id and
  // dropped at an index measured in the rails, so narrowing this list
  // leaves every drop honest.
  let query = $state("");
  const view = $derived(searchDrawer(query, { templates, tools: sortedTools, groups }));
  // Either box narrowing the pool means the header count owes a "/ of
  // what": the tab's hides cards before they ever reach this component
  // (hiddenCount), and this one hides them here.
  const anyFilter = $derived(filtering || view.filtering);

  // Two different questions, deliberately answered by two numbers. The
  // HEADER answers "how much is left to place", so it skips the done
  // group (unplacedCount). `rows` is just "is this panel empty", which
  // the done group does fill -- otherwise a drawer showing twelve
  // finished cards would also claim every runnable card is on a rail.
  const rows = $derived(view.groups.reduce((n, g) => n + g.cards.length, 0));
  const label = $derived(
    anyFilter
      ? `Unplaced (${view.cardsShown} / ${view.cardsTotal + hiddenCount})`
      : `Unplaced (${view.cardsShown})`
  );

  // Only DEVIATIONS from the default are stored, so a group the human has
  // not touched follows its own isDone rule even as groups come and go.
  let toggled = $state<Record<string, boolean>>({});
  // While filtering every group opens: a collapsed Done group would hide
  // the very row the query just found. Same for the two sections above
  // them -- see `sectionOpen`.
  const isCollapsed = (g: UnplacedGroup): boolean => (anyFilter ? false : (toggled[g.slug] ?? g.isDone));

  // Groups sit ABOVE Tools, for the same reason Tools sit above the
  // cards: a saved group is reached for, not browsed, so it starts open
  // too and stays put while the card list churns underneath both.
  let templatesCollapsed = $state(false);
  /// A section the human collapsed still opens while a query is running:
  /// otherwise the box would report a hit in Tools and show a shut
  /// section. Their own collapsed flag is remembered, not cleared, so
  /// clearing the box puts the panel back the way they left it.
  const sectionOpen = (collapsedFlag: boolean): boolean => view.filtering || !collapsedFlag;
  const SCOPE_CAPTION: Record<GroupTemplate["scope"], string> = {
    workspace: "This workspace",
    global: "All workspaces",
  };

  // Tools sit ABOVE the cards and start open: they are the same handful
  // every time, so they are the part of this panel a human learns to
  // reach for, while the card list churns.
  let toolsCollapsed = $state(false);
  const iconFor = toolIcon;
</script>

<aside class="drawer" class:collapsed class:drop-lit={dragging} data-orch-drawer>
  <button type="button" class="toggle" onclick={() => (collapsed = !collapsed)}>
    {#if collapsed}<ChevronLeft size={14} />{:else}<ChevronRight size={14} />{/if}
    {#if !collapsed}<span class:filtered={anyFilter}>{label}</span>{/if}
  </button>

  {#if !collapsed}
    <!-- Above every hint and every section, because it governs all
         three of them. Hidden with the rest of the panel when the drawer
         is rolled up: a 32px rail has no room for it, and the query it
         holds comes back untouched when the panel opens again. -->
    <div class="search-row">
      <SearchInput
        bind:value={query}
        label="Filter tools, groups and cards"
        placeholder="Filter this panel…"
      />
    </div>
    {#if !targetRailId}
      <!-- No rail means nothing to place onto: the rows below stay
           listed, so the human can see what a first rail would be built
           from, but carry no drag handle, and the tool and group rows
           no click-to-add. A card row stays live -- opening one is
           reading, not placing. The tab keeps this drawer on screen with
           no rails on purpose. -->
      <p class="hint quiet">No rail to place these on yet — add one with “+ Rail”.</p>
    {:else if filtering}
      <!-- The TAB's box, not the one above: that one takes rails out of
           the grid, which is why the hub unhooks its drag engine while
           it is set. A query in this panel's own box leaves every rail
           standing, so it never reaches this branch. -->
      <p class="hint quiet">Filtered — clear the tab's search to drag.</p>
    {:else if dragging && $orchDragState?.kind === "step"}
      <p class="hint">Drop here to take a step off its rail.</p>
    {:else if !dragging}
      <p class="hint quiet">Drag onto a rail. Click a card to open it, a tool to append it.</p>
    {/if}

    <button
      type="button"
      class="group-head"
      disabled={view.filtering}
      onclick={() => (templatesCollapsed = !templatesCollapsed)}
    >
      {#if sectionOpen(templatesCollapsed)}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
      <span class="group-name">Groups</span>
      <span class="group-count" class:filtered={view.filtering}
        >{view.templates.length}{view.filtering ? ` / ${view.templatesTotal}` : ""}</span
      >
    </button>
    {#if sectionOpen(templatesCollapsed)}
      <ul>
        {#each view.templates as t (t.id)}
          <li>
            <button
              type="button"
              data-orch-template={groupsBlocked || !targetRailId ? undefined : t.id}
              class:dragging={$orchDragState?.id === t.id}
              disabled={Boolean(groupsBlocked) || !targetRailId}
              title={groupsBlocked ??
                `${SCOPE_CAPTION[t.scope]}${t.description ? ` — ${t.description}` : ""}`}
              onclick={() => onAddTemplate(t.id)}
            >
              <Group size={12} />
              <span>{t.name}</span>
              <span class="scope">{t.scope === "global" ? "all" : "ws"}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if view.templates.length === 0}
        <p class="empty">{view.filtering ? "No group matches." : "No saved groups yet."}</p>
      {/if}
      <button
        type="button"
        class="manage"
        disabled={Boolean(groupsBlocked)}
        title={groupsBlocked ?? ""}
        onclick={onManageTemplates}
      >
        <Settings2 size={12} /> Manage groups…
      </button>
    {/if}
    <button
      type="button"
      class="group-head"
      disabled={view.filtering}
      onclick={() => (toolsCollapsed = !toolsCollapsed)}
    >
      {#if sectionOpen(toolsCollapsed)}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
      <span class="group-name">Tools</span>
      <span class="group-count" class:filtered={view.filtering}
        >{view.tools.length}{view.filtering ? ` / ${view.toolsTotal}` : ""}</span
      >
    </button>
    {#if sectionOpen(toolsCollapsed)}
      <ul>
        {#each view.tools as tool (tool.id)}
          {@const Icon = iconFor(tool)}
          <li>
            <button
              type="button"
              data-orch-tool={toolsBlocked || !targetRailId ? undefined : tool.id}
              class:dragging={$orchDragState?.id === tool.id}
              disabled={Boolean(toolsBlocked) || !targetRailId}
              title={toolsBlocked ??
                `${toolKindLabel(tool.kind)}${tool.description ? ` — ${tool.description}` : ""}`}
              onclick={() => onAddTool(tool.id)}
            >
              <Icon size={12} />
              <span>{tool.name}</span>
              {#if tool.scope !== "builtin"}
                <span class="scope">{tool.scope === "global" ? "all" : "ws"}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if view.tools.length === 0}
        <p class="empty">{view.filtering ? "No tool matches." : "No tools yet."}</p>
      {/if}
      <button
        type="button"
        class="manage"
        disabled={Boolean(toolsBlocked)}
        title={toolsBlocked ?? ""}
        onclick={onManageTools}
      >
        <Settings2 size={12} /> Manage tools…
      </button>
    {/if}
    {#each view.groups as group (group.slug)}
      <button
        type="button"
        class="group-head"
        disabled={anyFilter}
        onclick={() => (toggled = { ...toggled, [group.slug]: !isCollapsed(group) })}
      >
        {#if isCollapsed(group)}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <span class="group-name">{group.status}</span>
        <span class="group-count">{group.cards.length}</span>
      </button>
      {#if !isCollapsed(group)}
        <ul>
          {#each group.cards as entry (entry.plan.path)}
            {@const nested = nestedCounts.get(entry.plan.path) ?? 0}
            <li>
              <button
                type="button"
                data-orch-card={targetRailId ? entry.plan.path : undefined}
                class:dragging={$orchDragState?.id === entry.plan.path}
                title={nested > 0
                  ? `Carries ${nested} nested ${nested === 1 ? "task" : "tasks"} — placing this plan places them too`
                  : undefined}
                onclick={() => onOpenCard(entry.plan.path)}
              >
                {#if entry.plan.kind === "plan"}<ListChecks size={12} />{:else}<FileText size={12} />{/if}
                <span>{entry.plan.title}</span>
                {#if nested > 0}<span class="scope nested">+{nested}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    {#if rows === 0}
      <p class="empty">{anyFilter ? "No unplaced card matches." : "Every runnable card is on a rail."}</p>
    {/if}
  {/if}
</aside>

<style>
  .drawer {
    flex: none;
    width: 220px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface-sunken);
    overflow-y: auto;
  }
  .drawer.collapsed {
    width: 32px;
  }
  .drawer.drop-lit {
    outline: 2px dashed var(--border-focus);
    outline-offset: -2px;
  }
  .toggle .filtered {
    color: var(--accent-text);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .search-row {
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }
  .hint {
    margin: 0;
    padding: 8px;
    color: var(--accent-text);
    font-size: 11px;
  }
  .hint.quiet {
    color: var(--text-subtle);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  li button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  /* Dimmed, not hidden: the row is the drag's grab target, and removing
     it mid-gesture is what makes WKWebView drop the pointerup. */
  li button.dragging {
    opacity: 0.35;
  }
  li button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: 8px 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 4px 6px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .group-head:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .group-head:disabled {
    cursor: default;
  }
  .group-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-count {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
  }
  /* "3 / 14" while the panel's own box is on, in the same accent the
     header count uses, so the section says at a glance that it is
     showing a slice and not all it has. */
  .group-count.filtered {
    color: var(--accent-text);
  }
  /* "ws" / "all" rather than a full word: the row's job is the tool's
     NAME, and the scope only has to be checkable at a glance. Built-ins
     carry no tag at all -- they are the unmarked default. */
  .scope {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-subtle);
    font-size: 9px;
    text-transform: uppercase;
  }
  /* Not uppercased like the tool/template scope tags: this one is a
     number, and "+3" says nothing louder in capitals. */
  .scope.nested {
    text-transform: none;
  }
  .manage {
    display: flex;
    align-items: center;
    gap: 5px;
    width: calc(100% - 8px);
    margin: 0 4px 6px;
    padding: 5px 6px;
    background: none;
    border: 1px dashed var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
  }
  .manage:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .manage:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
</style>
