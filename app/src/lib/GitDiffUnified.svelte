<script lang="ts">
  import type { UnifiedRow } from "./diffRows";

  interface Props {
    rows: UnifiedRow[];
    isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean;
    actionLabel: string;
    onHunkAction: (hunkIndex: number) => void;
    onExpand: (hunkIndex: number) => void;
  }
  let { rows, isCollapsed, canAct, actionLabel, onHunkAction, onExpand }: Props = $props();

  // Rows of a collapsed hunk are skipped; the hunk header stays and offers Expand.
  const lineCounts = $derived(new Map(rows.filter((r) => r.kind === "hunk").map((r) => [r.hunkIndex, r.lineCount])));
  function hidden(hunkIndex: number): boolean {
    return isCollapsed(hunkIndex, lineCounts.get(hunkIndex) ?? 0);
  }
</script>

<div class="unified">
  {#each rows as row (row.kind === "hunk" ? "h" + row.hunkIndex : row.id)}
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
      <div class="line {row.line.kind}">
        <span class="no">{row.line.oldNo ?? ""}</span>
        <span class="no">{row.line.newNo ?? ""}</span>
        <span class="sign">{row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " "}</span>
        <span class="text">{row.line.text}{#if row.line.noNewline}<span class="eof" title="No newline at end of file">⏎̸</span>{/if}</span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .unified {
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
  .line {
    display: grid;
    grid-template-columns: 3.5em 3.5em 1.2em minmax(0, 1fr);
    white-space: pre;
  }
  .no {
    text-align: right;
    padding-right: 6px;
    color: #666;
    user-select: none;
  }
  .sign {
    color: #888;
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
  .eof {
    color: #d9b45c;
    margin-left: 4px;
  }
</style>
