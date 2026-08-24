<script lang="ts">
  import {
    ChevronRight,
    ChevronLeft,
    ChevronDown,
    FileText,
    ListChecks,
    Bot,
    Terminal,
    FileCode2,
    Settings2,
  } from "@lucide/svelte";
  import { orchDragState } from "./orchestrationDrag";
  import { toolKindLabel } from "./orchestrationTools";
  import type { Tool } from "./orchestrationTools";
  import { unplacedCount } from "./orchestration";
  import type { UnplacedGroup } from "./orchestration";

  interface Props {
    groups: UnplacedGroup[];
    /// Every tool this workspace can reach: built-in, global, its own.
    tools: Tool[];
    /// Clicking a row adds it to this rail as its own stage; null when
    /// there is no rail to add to yet.
    targetRailId: string | null;
    onAdd: (cardPath: string) => void;
    /// The tab's search box holds a query: the rows below are the
    /// matches, not the whole pool, and dragging is off.
    filtering?: boolean;
    hiddenCount?: number;
    onAddTool: (toolId: string) => void;
    onManageTools: () => void;
    /// Why the running daemon cannot carry tools, or null. A daemon
    /// older than v11 has no `tool_id` column: it would accept a tool
    /// step and store a step with neither a card nor a tool, which comes
    /// back as an untitled chip. So the rows stay visible -- the human
    /// should still see what tools ARE -- but inert, with the reason on
    /// hover and no drag handle at all.
    toolsBlocked?: string | null;
  }
  let {
    groups,
    tools,
    targetRailId,
    onAdd,
    onAddTool,
    onManageTools,
    filtering = false,
    hiddenCount = 0,
    toolsBlocked = null,
  }: Props = $props();

  let collapsed = $state(false);
  const dragging = $derived($orchDragState !== null);
  // Two different questions, deliberately answered by two numbers. The
  // HEADER answers "how much is left to place", so it skips the done
  // group (unplacedCount). `rows` is just "is this panel empty", which
  // the done group does fill -- otherwise a drawer showing twelve
  // finished cards would also claim every runnable card is on a rail.
  const total = $derived(unplacedCount(groups));
  const rows = $derived(groups.reduce((n, g) => n + g.cards.length, 0));
  const label = $derived(filtering ? `Unplaced (${total} / ${total + hiddenCount})` : `Unplaced (${total})`);

  // Only DEVIATIONS from the default are stored, so a group the human has
  // not touched follows its own isDone rule even as groups come and go.
  let toggled = $state<Record<string, boolean>>({});
  // While filtering every group opens: a collapsed Done group would hide
  // the very row the query just found.
  const isCollapsed = (g: UnplacedGroup): boolean => (filtering ? false : (toggled[g.slug] ?? g.isDone));

  // Tools sit ABOVE the cards and start open: they are the same handful
  // every time, so they are the part of this panel a human learns to
  // reach for, while the card list churns.
  let toolsCollapsed = $state(false);
  const iconFor = (kind: Tool["kind"]) =>
    kind === "agent" ? Bot : kind === "command" ? Terminal : FileCode2;
  // Built-ins first, then everything the human made, each alphabetical --
  // a stable order, so a tool stays where they last saw it.
  const SCOPE_ORDER: Tool["scope"][] = ["builtin", "workspace", "global"];
  const sortedTools = $derived(
    [...tools].sort(
      (a, b) =>
        SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name)
    )
  );
</script>

<aside class="drawer" class:collapsed class:drop-lit={dragging} data-orch-drawer>
  <button type="button" class="toggle" onclick={() => (collapsed = !collapsed)}>
    {#if collapsed}<ChevronLeft size={14} />{:else}<ChevronRight size={14} />{/if}
    {#if !collapsed}<span class:filtered={filtering}>{label}</span>{/if}
  </button>

  {#if !collapsed}
    {#if filtering}
      <p class="hint quiet">Filtered — clear the search to drag.</p>
    {:else if dragging && $orchDragState?.kind === "step"}
      <p class="hint">Drop here to take a step off its rail.</p>
    {:else if !dragging}
      <p class="hint quiet">Drag a card or a tool onto a rail, or click to append it.</p>
    {/if}

    <button
      type="button"
      class="group-head"
      onclick={() => (toolsCollapsed = !toolsCollapsed)}
    >
      {#if toolsCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
      <span class="group-name">Tools</span>
      <span class="group-count">{sortedTools.length}</span>
    </button>
    {#if !toolsCollapsed}
      <ul>
        {#each sortedTools as tool (tool.id)}
          {@const Icon = iconFor(tool.kind)}
          <li>
            <button
              type="button"
              data-orch-tool={toolsBlocked ? undefined : tool.id}
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
    {#each groups as group (group.slug)}
      <button
        type="button"
        class="group-head"
        disabled={filtering}
        onclick={() => (toggled = { ...toggled, [group.slug]: !isCollapsed(group) })}
      >
        {#if isCollapsed(group)}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <span class="group-name">{group.status}</span>
        <span class="group-count">{group.cards.length}</span>
      </button>
      {#if !isCollapsed(group)}
        <ul>
          {#each group.cards as entry (entry.plan.path)}
            <li>
              <button
                type="button"
                data-orch-card={entry.plan.path}
                class:dragging={$orchDragState?.id === entry.plan.path}
                disabled={!targetRailId}
                onclick={() => onAdd(entry.plan.path)}
              >
                {#if entry.plan.kind === "plan"}<ListChecks size={12} />{:else}<FileText size={12} />{/if}
                <span>{entry.plan.title}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    {#if rows === 0}
      <p class="empty">{filtering ? "No unplaced card matches." : "Every runnable card is on a rail."}</p>
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
