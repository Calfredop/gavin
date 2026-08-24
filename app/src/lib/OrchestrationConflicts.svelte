<script lang="ts">
  import { ChevronDown, ChevronRight, TriangleAlert } from "@lucide/svelte";
  import { highlightedConflict } from "./orchestrationState";
  import { describeConflict, conflictRailId } from "./orchestration";
  import type { CardEntry, NumberedConflict, Orchestration } from "./orchestration";
  import type { Tool } from "./orchestrationTools";

  interface Props {
    numbered: NumberedConflict[];
    cards: Map<string, CardEntry>;
    orch: Orchestration;
    /// Tool names, so a conflict naming a tool step reads as "Push
    /// branch" rather than as a uuid.
    tools: Tool[];
    onBindWorktree: (railId: string) => void;
    /// The repair for a parallel stage (spec O13): split it into
    /// consecutive single-step stages. Only offered for scope "stage" --
    /// no single stage can fix two rails sharing a checkout.
    onMakeSequential: (stageId: string) => void;
  }
  let { numbered, cards, orch, tools, onBindWorktree, onMakeSequential }: Props = $props();

  let collapsed = $state(false);

  const liveCount = $derived(numbered.filter((x) => x.conflict.severity === "live").length);
</script>

<!-- Absent entirely when there are none: an empty box is noise. -->
{#if numbered.length > 0}
  <section class="conflicts" class:has-live={liveCount > 0}>
    <button type="button" class="head" onclick={() => (collapsed = !collapsed)}>
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
              <button type="button" class="fix" onclick={() => onBindWorktree(railId)}>
                {conflict.kind === "branch-missing" ? "Bind branch…" : "Bind worktree…"}
              </button>
            {:else if conflict.kind === "same-worktree" && conflict.stageId}
              <button
                type="button"
                class="fix"
                onclick={() => onMakeSequential(conflict.stageId as string)}
              >
                Make sequential
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
</style>
