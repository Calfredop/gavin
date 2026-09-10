<script lang="ts">
  import type { CommitInfo } from "$lib/git/git";
  import { MAX_DRAWN_LANE, type GraphRow } from "$lib/git/graphLanes";

  interface Props {
    commit: CommitInfo;
    row: GraphRow;
    /// Lane count of the whole graph, so every row's SVG has the same width.
    width: number;
    selected: boolean;
    onSelect: () => void;
    onMenu: (e: MouseEvent) => void;
  }
  let { commit, row, width, selected, onSelect, onMenu }: Props = $props();

  const LANE_W = 14;
  const ROW_H = 22;
  /// Categorical, not semantic -- adjacent lanes just need to differ. The
  /// actual colours live in theme.css as --lane-1..8 and swap per theme,
  /// because a palette tuned for a dark background washes out on white.
  /// These are var() references, not hexes: SVG presentation attributes
  /// don't resolve var(), so every use below goes through style: instead.
  const LANES = 8;

  const clampLane = (l: number): number => Math.min(l, MAX_DRAWN_LANE);
  const x = (l: number): number => clampLane(l) * LANE_W + LANE_W / 2;
  const svgWidth = $derived(Math.max(1, clampLane(width)) * LANE_W);
  const cx = $derived(x(row.lane));
  const colorOf = (l: number): string => `var(--lane-${(l % LANES) + 1})`;

  // A curve from (fromLane, top) into this row's dot, and from the dot down
  // to (toLane, bottom): cubic with the control points pulled vertical so
  // lanes look like Fork's rails rather than straight diagonals.
  function curveIn(from: number): string {
    const x0 = x(from);
    const mid = ROW_H / 2;
    return `M ${x0} 0 C ${x0} ${mid * 0.8}, ${cx} ${mid * 0.2}, ${cx} ${mid}`;
  }
  function curveOut(to: number): string {
    const x1 = x(to);
    const mid = ROW_H / 2;
    return `M ${cx} ${mid} C ${cx} ${mid + mid * 0.8}, ${x1} ${mid + mid * 0.2}, ${x1} ${ROW_H}`;
  }

  const when = $derived(relative(commit.date));
  function relative(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
    return `${Math.floor(s / (86400 * 365))}y`;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="row" class:selected role="option" aria-selected={selected} tabindex="-1" onclick={onSelect} oncontextmenu={onMenu}>
  <svg class="lanes" width={svgWidth} height={ROW_H} aria-hidden="true">
    {#each row.passes as lane (lane)}
      <line x1={x(lane)} y1="0" x2={x(lane)} y2={ROW_H} style:stroke={colorOf(lane)} stroke-width="2" />
    {/each}
    {#each row.incoming as lane (lane)}
      <path d={curveIn(lane)} style:stroke={colorOf(lane)} stroke-width="2" fill="none" />
    {/each}
    {#each row.outgoing as lane (lane)}
      <path d={curveOut(lane)} style:stroke={colorOf(lane)} stroke-width="2" fill="none" />
    {/each}
    {#if row.fromAbove}
      <line x1={cx} y1="0" x2={cx} y2={ROW_H / 2} style:stroke={colorOf(row.lane)} stroke-width="2" />
    {/if}
    {#if row.hasParent}
      <line x1={cx} y1={ROW_H / 2} x2={cx} y2={ROW_H} style:stroke={colorOf(row.lane)} stroke-width="2" />
    {/if}
    <circle cx={cx} cy={ROW_H / 2} r={commit.isHead ? 4.5 : 3.5} style:fill={commit.isHead ? "var(--surface-base)" : colorOf(row.lane)}
      style:stroke={colorOf(row.lane)} stroke-width="2" />
  </svg>
  <span class="refs">
    {#each commit.refs as r (r.kind + r.name)}
      <span class="chip {r.kind}" class:head={commit.isHead && r.kind === "local"}>{r.name}</span>
    {/each}
    {#if commit.isHead && commit.refs.length === 0}<span class="chip head-only">HEAD</span>{/if}
  </span>
  <span class="subject" title={commit.subject}>{commit.subject}</span>
  <span class="author" title={commit.email}>{commit.author}</span>
  <span class="date" title={commit.date}>{when}</span>
</div>


<style>
  .row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    height: 22px;
    padding: 0 8px 0 4px;
    font-size: 0.78em;
    color: var(--text);
    white-space: nowrap;
    user-select: none;
    cursor: default;
  }
  .row:hover {
    background: var(--surface-sunken);
  }
  .row.selected {
    background: var(--surface-accent);
  }
  .lanes {
    display: block;
    flex: 0 0 auto;
  }
  .refs {
    display: inline-flex;
    gap: 4px;
  }
  .chip {
    border: 1px solid;
    border-radius: 8px;
    padding: 0 6px;
    font-size: 0.85em;
    line-height: 1.4;
  }
  .chip.local {
    color: var(--success-text);
    border-color: var(--border-success);
  }
  .chip.local.head {
    background: var(--surface-success);
    color: var(--success-text);
    font-weight: 700;
  }
  .chip.remote {
    color: var(--accent-text);
    border-color: var(--border-accent);
  }
  .chip.tag {
    color: var(--warning-text);
    border-color: var(--border-warning);
  }
  .chip.stash,
  .chip.head-only {
    color: var(--text-muted);
    border-color: var(--border);
  }
  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
  .author,
  .date {
    color: var(--text-subtle);
    font-size: 0.92em;
  }
</style>
