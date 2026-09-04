<script lang="ts">
  import { ChevronDown, ChevronRight, TriangleAlert } from "@lucide/svelte";
  import { highlightedConflict } from "./orchestrationState";
  import { describeConflict, conflictRailId } from "./orchestration";
  import { loadConflictsCollapsed, saveConflictsCollapsed } from "./orchestrationConflictBanner";
  import type { CardEntry, NumberedConflict, Orchestration } from "./orchestration";
  import type { Tool } from "./orchestrationTools";
  import { railBindFix, type RailBindTab } from "./railBind";

  interface Props {
    /// Whose box this is: the collapse is remembered per workspace.
    workspaceId: string;
    numbered: NumberedConflict[];
    cards: Map<string, CardEntry>;
    orch: Orchestration;
    /// Tool names, so a conflict naming a tool step reads as "Push
    /// branch" rather than as a uuid.
    tools: Tool[];
    /// Opens the rail's bind dialog on the tab that actually repairs
    /// this conflict. One label served every rail-level conflict before,
    /// naming the worktree even when the cause was a missing BRANCH --
    /// and then landing on the worktree list.
    onBindRail: (railId: string, tab: RailBindTab) => void;
    /// The repair for a parallel stage (grouping spec G5): tell the group
    /// to run its members one at a time. The group stays whole.
    onMakeSequential: (stageId: string) => void;
    /// The repair for a nested task placed on a rail beside its parent:
    /// give it a status, which makes it a card of its own instead of one
    /// the plan's agent already carries (cardCompletion.ts). Both steps
    /// stay where the human put them -- this settles which of the two is
    /// the piece of work, rather than taking one off.
    onBreakOut: (cardPath: string) => void;
    /// The column that repair would file it into, for the button's own
    /// words. Null on a board with no columns, where the button cannot
    /// name a destination and so is not offered.
    breakOutColumn: string | null;
    /// featureBlockedReason(compat, "groups"), or null when the daemon can
    /// take a mode write. The repair now flips `mode` (Task 6) instead of
    /// splitting the stage -- an older daemon drops that field silently,
    /// so a disabled button here has to say why rather than let the badge
    /// never clear.
    groupsBlocked: string | null;
  }
  let {
    workspaceId,
    numbered,
    cards,
    orch,
    tools,
    onBindRail,
    onMakeSequential,
    onBreakOut,
    breakOutColumn,
    groupsBlocked,
  }: Props = $props();

  // Open on first appearance, then whatever the human last chose. The box
  // outlives its own component: `+page.svelte` renders one hub view at a
  // time, so every trip to Kanban and back used to re-run this line and
  // re-open a box that had just been closed.
  let collapsed = $state(loadConflictsCollapsed(workspaceId));

  // A workspace switch keeps this instance alive and only swaps the prop,
  // so the seed has to be re-read rather than trusted from mount.
  $effect(() => {
    collapsed = loadConflictsCollapsed(workspaceId);
  });

  function toggle() {
    collapsed = !collapsed;
    saveConflictsCollapsed(workspaceId, collapsed);
  }

  const liveCount = $derived(numbered.filter((x) => x.conflict.severity === "live").length);
</script>

<!-- Absent entirely when there are none: an empty box is noise. -->
{#if numbered.length > 0}
  <section class="conflicts" class:has-live={liveCount > 0}>
    <button type="button" class="head" onclick={toggle}>
      {#if collapsed}<ChevronRight size={14} />{:else}<ChevronDown size={14} />{/if}
      <TriangleAlert size={14} />
      <span>
        {numbered.length}
        {numbered.length === 1 ? "conflict" : "conflicts"}
        {#if liveCount > 0}<em>· {liveCount} live</em>{/if}
      </span>
    </button>

    {#if !collapsed}
      <ul>
        {#each numbered as { n, conflict } (n)}
          {@const railId = conflictRailId(conflict)}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class={conflict.severity}
            class:lit={$highlightedConflict === n}
            onmouseenter={() => highlightedConflict.set(n)}
            onmouseleave={() => highlightedConflict.set(null)}
          >
            <span class="badge">{n}</span>
            <span class="text">{describeConflict(conflict, cards, orch, tools)}</span>
            {#if conflict.kind === "declared"}<span class="tag">agent note</span>{/if}
            {#if railId}
              {@const fix = railBindFix(conflict.kind)}
              <button type="button" class="fix" onclick={() => onBindRail(railId, fix.tab)}>
                {fix.label}
              </button>
            {:else if conflict.kind === "same-worktree" && conflict.stageId}
              <button
                type="button"
                class="fix"
                disabled={Boolean(groupsBlocked)}
                title={groupsBlocked ?? undefined}
                onclick={() => onMakeSequential(conflict.stageId as string)}
              >
                Run in sequence
              </button>
            {:else if conflict.kind === "nested-with-parent" && breakOutColumn}
              <button
                type="button"
                class="fix"
                title={`Give it a status of its own in ${breakOutColumn} — it stays part of the plan`}
                onclick={() => onBreakOut(conflict.cardPath)}
              >
                Break out
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .conflicts {
    border-bottom: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--text);
  }
  .conflicts.has-live {
    border-bottom-color: var(--border-danger);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    color: var(--warning-text);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .conflicts.has-live .head {
    color: var(--danger-text);
  }
  .head em {
    font-style: normal;
    font-weight: 400;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 12px 8px;
    max-height: 22vh;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 4px;
    font-size: 12px;
  }
  li.lit {
    background: var(--surface-hover);
  }
  /* Severity is the colour; the badge number carries pairing (spec O9). */
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--border-warning);
    color: var(--warning-text);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  li.live .badge {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .tag {
    flex: none;
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .fix {
    flex: none;
    background: none;
    border: none;
    color: var(--accent-text);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
  }
  .fix:disabled {
    cursor: default;
    opacity: 0.7;
    text-decoration: none;
  }
</style>
