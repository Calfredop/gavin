<script lang="ts">
  import type { SplitRow } from "./diffRows";

  interface Props {
    rows: SplitRow[];
    isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean;
    actionLabel: string;
    onHunkAction: (hunkIndex: number) => void;
    onExpand: (hunkIndex: number) => void;
  }
  let { rows, isCollapsed, canAct, actionLabel, onHunkAction, onExpand }: Props = $props();

  const lineCounts = $derived(new Map(rows.filter((r) => r.kind === "hunk").map((r) => [r.hunkIndex, r.lineCount])));
  function hidden(hunkIndex: number): boolean {
    return isCollapsed(hunkIndex, lineCounts.get(hunkIndex) ?? 0);
  }
</script>

<div class="split">
  {#each rows as row, i (row.kind === "hunk" ? "h" + row.hunkIndex : "p" + i)}
    {#if row.kind === "hunk"}
      <div class="hunk">
        <span class="header">{row.header}</span>
        <span class="spacer"></span>
        {#if hidden(row.hunkIndex)}
          <button type="button" class="act" onclick={() => onExpand(row.hunkIndex)}>Expand ({row.lineCount} lines)</button>
        {/if}
        {#if canAct}
          <button type="button" class="act" onclick={() => onHunkAction(row.hunkIndex)}>{actionLabel}</button>
        {/if}
      </div>
    {:else if !hidden(row.hunkIndex)}
      <div class="pair">
        <div class="cell {row.left?.kind ?? 'blank'}">
          <span class="no">{row.left?.no ?? ""}</span>
          <span class="text">{row.left?.text ?? ""}</span>
        </div>
        <div class="cell {row.right?.kind ?? 'blank'}">
          <span class="no">{row.right?.no ?? ""}</span>
          <span class="text">{row.right?.text ?? ""}</span>
        </div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .split {
    font-size: 0.76em;
    line-height: 1.45;
  }
  .hunk {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: #20242a;
    color: #8ab4e0;
    border-top: 1px solid #2f2f2f;
    border-bottom: 1px solid #2f2f2f;
    z-index: 1;
  }
  .header {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .act {
    background: transparent;
    border: 1px solid #3a4a5a;
    border-radius: 4px;
    color: #bcd;
    font-family: monospace;
    font-size: 0.95em;
    padding: 1px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover {
    border-color: #6a8aaa;
    color: #eee;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .cell {
    display: grid;
    grid-template-columns: 3.5em minmax(0, 1fr);
    white-space: pre;
    border-right: 1px solid #2a2a2a;
  }
  .no {
    text-align: right;
    padding-right: 6px;
    color: #666;
    user-select: none;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .add {
    background: #17301a;
    color: #b6e3b6;
  }
  .del {
    background: #3a1a1a;
    color: #e8b4b4;
  }
  .context {
    color: #bbb;
  }
  .blank {
    background: #1b1b1b;
  }
</style>
