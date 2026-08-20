<script lang="ts">
  import type { SplitRow } from "./diffRows";

  interface Props {
    rows: SplitRow[];
    isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean;
    actionLabel: string;
    onHunkAction: (hunkIndex: number) => void;
    onExpand: (hunkIndex: number) => void;
    selection: ReadonlySet<string>;
    onLineClick: (hunkIndex: number, lineIndex: number, shift: boolean) => void;
    onDragRange: (hunkIndex: number, from: number, to: number) => void;
    selectedLabel: (hunkIndex: number) => string | null;
    /// null hides that hunk's Discard button (staged rows, untracked files).
    discardLabel: (hunkIndex: number) => string | null;
    onHunkDiscard: (hunkIndex: number) => void;
  }
  let {
    rows,
    isCollapsed,
    canAct,
    actionLabel,
    onHunkAction,
    onExpand,
    selection,
    onLineClick,
    onDragRange,
    selectedLabel,
    discardLabel,
    onHunkDiscard,
  }: Props = $props();

  const lineCounts = $derived(new Map(rows.filter((r) => r.kind === "hunk").map((r) => [r.hunkIndex, r.lineCount])));
  function hidden(hunkIndex: number): boolean {
    return isCollapsed(hunkIndex, lineCounts.get(hunkIndex) ?? 0);
  }

  // Gutter drag paints a range within one hunk. Window-level pointerup with
  // a buttons===0 bail-out (WKWebView drops pointerup in some cases).
  let drag: { hunkIndex: number; from: number } | null = null;
  function gutterDown(hunkIndex: number, lineIndex: number, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { hunkIndex, from: lineIndex };
    onDragRange(hunkIndex, lineIndex, lineIndex);
    const up = (): void => {
      drag = null;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  function lineEnter(hunkIndex: number, lineIndex: number, e: PointerEvent): void {
    if (!drag) return;
    if (e.buttons === 0) {
      drag = null;
      return;
    }
    if (drag.hunkIndex === hunkIndex) onDragRange(hunkIndex, drag.from, lineIndex);
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
          {@const sel = selectedLabel(row.hunkIndex)}
          {@const dl = discardLabel(row.hunkIndex)}
          <button type="button" class="act" onclick={() => onHunkAction(row.hunkIndex)}>{sel ?? actionLabel}</button>
          {#if dl}
            <button type="button" class="act danger" onclick={() => onHunkDiscard(row.hunkIndex)}>{dl}</button>
          {/if}
        {/if}
      </div>
    {:else if !hidden(row.hunkIndex)}
      <div class="pair">
        {#each [row.left, row.right] as cell, side (side)}
          {#if cell}
            <!-- Keyboard: Esc clears the selection at the GitDiff container
                 level; cells are pointer targets (listbox pattern). -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="cell {cell.kind}"
              class:selected={selection.has(cell.id)}
              class:selectable={cell.kind !== "context"}
              role="option"
              aria-selected={selection.has(cell.id)}
              tabindex="-1"
              onclick={(e) => onLineClick(row.hunkIndex, cell.lineIndex, e.shiftKey)}
              onpointerenter={(e) => lineEnter(row.hunkIndex, cell.lineIndex, e)}
            >
              <span class="no gutter" role="presentation" onpointerdown={(e) => cell.kind !== "context" && gutterDown(row.hunkIndex, cell.lineIndex, e)}>{cell.no ?? ""}</span>
              <span class="text">{cell.text}</span>
            </div>
          {:else}
            <div class="cell blank"><span class="no"></span><span class="text"></span></div>
          {/if}
        {/each}
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
  .act.danger {
    border-color: #5a3030;
    color: #e0a0a0;
  }
  .act.danger:hover {
    border-color: #9a4040;
    color: #fcc;
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
  .selectable {
    cursor: pointer;
  }
  .gutter {
    cursor: ns-resize;
  }
  .cell.selected {
    outline: 1px solid #6a8aaa;
    outline-offset: -1px;
    filter: brightness(1.25);
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
