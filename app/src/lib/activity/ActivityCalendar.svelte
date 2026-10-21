<script lang="ts" module>
  import type { ActivityKind as Kind, Focus as Place } from "$lib/activity/activity";

  /// Where each calendar was, by scope, for this page's life: a row
  /// opens a card somewhere else, and coming back should land on the
  /// hour it was opened from rather than the opening zoom.
  const kept = new Map<string, { focus: Place; kinds: Kind[] }>();
</script>

<script lang="ts">
  // The activity calendar: what happened, drawn over time -- a section of
  // the app hub over every workspace, and a widget on a workspace's Home.
  // A thin template over activity.ts (events, buckets, levels, zoom) and
  // activityLoad.ts (what is read and from where); it decides nothing
  // itself. Hand-rolled SVG for the year and CSS grids below it -- no
  // charting library -- so it draws the same in WKWebView and on a phone.
  import { onMount, untrack } from "svelte";
  import { Check, ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal, RefreshCw, Upload, Wrench } from "@lucide/svelte";
  import * as backend from "$lib/core/backend";
  import { daemonCompat, layoutState } from "$lib/core/layoutState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { tooltip } from "$lib/core/tooltip";
  import { sshLinks } from "$lib/workspace/sshLinkState";
  import { fetchTools, toolRecords } from "$lib/orchestration/toolsState";
  import { BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { runIndicator } from "$lib/ui/indicators";
  import {
    ACTIVITY_KINDS,
    KIND_LABEL,
    LEVELS,
    YEAR_WEEKS,
    badgeOutcome,
    breadcrumb,
    buildEvents,
    cardTitles,
    cellTip,
    cellValue,
    clockLabel,
    dayHours,
    dayLabel,
    eventsIn,
    focusAt,
    hourLabel,
    indexEvents,
    kindSummary,
    levelScale,
    loadWindow,
    monthGrid,
    periodBounds,
    pushRange,
    runDuration,
    runTitle,
    step,
    toggleKind,
    weekdayLabels,
    yearGrid,
    zoomInto,
    zoomOutTo,
    type ActivityEvent,
    type ActivityKind,
    type ActivityRun,
    type Focus,
    type Zoom,
  } from "$lib/activity/activity";
  import {
    loadActivity,
    missingLines,
    planLoads,
    unavailableLine,
    unavailableTip,
    type ActivityLoad,
  } from "$lib/activity/activityLoad";

  interface Props {
    /// One workspace's activity; absent for every workspace's (the app hub).
    workspaceId?: string | null;
    /// The zoom it opens at: Year on the desktop, Month on a phone.
    openAt?: Zoom;
    /// What a tap on one of the Year view's days opens. The day, where a
    /// pointer can aim at one; its month on a phone, where a year scaled
    /// to the width has days far smaller than a finger.
    yearCellZoom?: "day" | "month";
    /// Where a row goes: the surface's own jumps, so this component holds
    /// no navigation of its own (the desk's are activityNav.ts).
    onOpenCard: (workspaceId: string, path: string) => void;
    onOpenTool: (workspaceId: string, toolId: string) => void;
  }

  let { workspaceId = null, openAt = "year", yearCellZoom = "day", onOpenCard, onOpenTool }: Props = $props();

  const scope = $derived(workspaceId ? "workspace" : "app");
  const workspaces = $derived(
    workspaceId ? $layoutState.workspaces.filter((w) => w.id === workspaceId) : $layoutState.workspaces
  );
  const names = $derived(new Map(workspaces.map((w) => [w.id, w.name])));

  let now = $state(Date.now());
  let load = $state<ActivityLoad | null>(null);
  let loading = $state(false);
  const keptKey = untrack(() => `${workspaceId ?? ""}\u0000${openAt}`);
  const keptPlace = kept.get(keptKey);
  let focus = $state<Focus>(keptPlace?.focus ?? untrack(() => focusAt(openAt, Date.now())));
  let kinds = $state<ActivityKind[]>(keptPlace ? [...keptPlace.kinds] : [...ACTIVITY_KINDS]);
  $effect(() => {
    kept.set(keptKey, { focus: { ...focus }, kinds: [...kinds] });
  });
  let expanded = $state<Record<string, boolean>>({});
  let pickerOpen = $state(false);
  let pickerEl = $state<HTMLElement | null>(null);

  // Supersession by token, not identity: a refresh that lands after a
  // newer one started is dropped (CLAUDE.md, Svelte 5 proxies).
  let token = 0;
  async function refresh(): Promise<void> {
    const mine = ++token;
    loading = true;
    const t = Date.now();
    const plans = planLoads(workspaces, $daemonCompat, $sshLinks);
    const result = await loadActivity(plans, loadWindow(t), {
      activityRuns: backend.activityRuns,
      gitActivity: backend.gitActivity,
    });
    if (mine !== token) return;
    now = t;
    load = result;
    loading = false;
    // A tool run is named by its tool, and the library may not have been
    // read yet on this surface.
    for (const src of result.sources) if (src.runs?.some((r) => r.kind === "tool")) void fetchTools(src.workspaceId);
  }

  // Once per scope, then again whenever the window comes back into view;
  // zooming and the kind picker only re-read what is already here.
  $effect(() => {
    void workspaceId;
    untrack(() => void refresh());
  });
  onMount(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  const index = $derived(indexEvents(buildEvents(load?.sources ?? [])));
  const titles = $derived(new Map(workspaces.map((w) => [w.id, cardTitles($gavinTrees[w.id]?.contexts)])));
  const appNames = $derived(scope === "app" ? names : null);

  const year = $derived(yearGrid(now));
  const month = $derived(monthGrid(focus.year, focus.month, now));
  const hours = $derived(dayHours(focus.year, focus.month, focus.day, now));

  // One scale per view, over the cells it draws.
  const level = $derived.by(() => {
    if (focus.zoom === "year") return levelScale(year.cells.map((c) => cellValue(index.days.get(c.key), kinds)));
    if (focus.zoom === "month") return levelScale(month.days.map((c) => cellValue(index.days.get(c.key), kinds)));
    return levelScale(hours.map((h) => cellValue(index.hours.get(h.key), kinds)));
  });

  const crumbs = $derived(breadcrumb(focus));
  const prev = $derived(step(focus, -1, now));
  const next = $derived(step(focus, 1, now));
  const listed = $derived.by(() => {
    if (focus.zoom !== "day" && focus.zoom !== "hour") return [];
    const { start, end } = periodBounds(focus, now);
    return eventsIn(index.events, start, end, kinds);
  });

  const CELL = 10;
  const PITCH = 12;
  const YEAR_W = YEAR_WEEKS * PITCH - (PITCH - CELL);
  const YEAR_H = 7 * PITCH - (PITCH - CELL);
  const weekdays = weekdayLabels();

  function go(f: Focus | null): void {
    if (f) focus = f;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowLeft" && prev) {
      e.preventDefault();
      go(prev);
    } else if (e.key === "ArrowRight" && next) {
      e.preventDefault();
      go(next);
    } else if (e.key === "Escape" && pickerOpen) {
      pickerOpen = false;
    }
  }

  // The picker is this component's own popover rather than the app's
  // context-menu layer: the Companion draws this component and does not
  // mount that layer. Closed by a press anywhere outside it.
  $effect(() => {
    if (!pickerOpen) return;
    const away = (e: PointerEvent) => {
      if (pickerEl && !pickerEl.contains(e.target as Node)) pickerOpen = false;
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

  function toolName(wsId: string, toolId: string | null): string | null {
    if (!toolId) return null;
    return (
      ($toolRecords[wsId] ?? []).find((t) => t.id === toolId)?.name ??
      BUILTIN_TOOLS.find((t) => t.id === toolId)?.name ??
      null
    );
  }

  function title(run: ActivityRun): string {
    return runTitle(run, titles.get(run.workspaceId), toolName(run.workspaceId, run.toolId));
  }

  function openRun(run: ActivityRun): void {
    if (run.kind === "card" && run.path) onOpenCard(run.workspaceId, run.path);
    else if (run.kind === "tool") onOpenTool(run.workspaceId, run.toolId ?? "");
  }

  function openYearCell(c: { year: number; month: number; day: number }): void {
    go(
      yearCellZoom === "month"
        ? zoomInto(focus, { zoom: "month", year: c.year, month: c.month, day: c.day })
        : zoomInto(focus, { zoom: "day", year: c.year, month: c.month, day: c.day })
    );
  }

  function eventKey(e: ActivityEvent): string {
    if (e.type === "run") return `r:${e.run.kind}:${e.run.sessionId}:${e.at}`;
    if (e.type === "commit") return `c:${e.commit.sha}`;
    return `p:${e.push.remoteRef}:${e.at}:${e.push.newSha}`;
  }

  const unavailable = $derived(load ? unavailableLine(load, scope) : null);
  const missing = $derived(load ? missingLines(load, scope) : []);
</script>

<!-- Focusable so ←/→ step the period wherever focus sits inside it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="activity" tabindex="0" role="group" aria-label="Activity calendar" onkeydown={onKey}>
  <div class="bar">
    <nav class="crumbs" aria-label="Zoom">
      {#each crumbs as crumb, i (crumb.zoom)}
        {#if i > 0}<span class="sep" aria-hidden="true">›</span>{/if}
        <button
          type="button"
          class="crumb"
          class:current={crumb.current}
          disabled={crumb.current}
          onclick={() => go(zoomOutTo(focus, crumb.zoom))}
        >
          {crumb.label}
        </button>
      {/each}
    </nav>
    <span class="steps">
      <button type="button" class="icon" aria-label="Previous" disabled={!prev} onclick={() => go(prev)}>
        <ChevronLeft size={13} />
      </button>
      <button type="button" class="icon" aria-label="Next" disabled={!next} onclick={() => go(next)}>
        <ChevronRight size={13} />
      </button>
    </span>
    <span class="picker" bind:this={pickerEl}>
      <button
        type="button"
        class="pick"
        aria-haspopup="true"
        aria-expanded={pickerOpen}
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        <span class="summary">{kindSummary(kinds)}</span>
        <ChevronDown size={11} />
      </button>
      {#if pickerOpen}
        <span class="menu" role="group" aria-label="Kinds of activity">
          {#each ACTIVITY_KINDS as kind (kind)}
            {@const on = kinds.includes(kind)}
            <button
              type="button"
              class="option"
              role="menuitemcheckbox"
              aria-checked={on}
              onclick={() => (kinds = toggleKind(kinds, kind))}
            >
              <span class="tick">{#if on}<Check size={12} />{/if}</span>
              {KIND_LABEL[kind]}
            </button>
          {/each}
        </span>
      {/if}
    </span>
    <button
      type="button"
      class="icon refresh"
      class:spinning={loading}
      aria-label="Refresh activity"
      use:tooltip={"Read the activity again"}
      onclick={() => void refresh()}
    >
      <RefreshCw size={12} />
    </button>
  </div>

  {#if focus.zoom === "year"}
    <div class="year" style:--weeks={YEAR_WEEKS}>
      <div class="months" aria-hidden="true">
        {#each year.months as m (`${m.year}-${m.month}`)}
          <span class="month-label" style:left="{(m.col / YEAR_WEEKS) * 100}%">{m.label}</span>
        {/each}
      </div>
      <!-- Placed by percentage over the grid's own height, so a label
           never makes the row taller than the scaled cells beside it. -->
      <div class="weekdays" aria-hidden="true">
        {#each weekdays as label, row (label)}
          {#if row % 2 === 0}
            <span style:top="{((row * PITCH + CELL / 2) / YEAR_H) * 100}%">{label}</span>
          {/if}
        {/each}
      </div>
      <svg viewBox="0 0 {YEAR_W} {YEAR_H}" style:aspect-ratio="{YEAR_W} / {YEAR_H}" role="grid" aria-label="Last 12 months">
        {#each year.cells as c (c.key)}
          {#if !c.future}
            {@const bucket = index.days.get(c.key)}
            {@const tip = cellTip(dayLabel(c.year, c.month, c.day), bucket, kinds, appNames)}
            <rect
              class="cell l{level(cellValue(bucket, kinds))}"
              x={c.col * PITCH}
              y={c.row * PITCH}
              width={CELL}
              height={CELL}
              rx="2"
              role="gridcell"
              tabindex="-1"
              aria-label={tip}
              use:tooltip={tip}
              onclick={() => openYearCell(c)}
              onkeydown={() => {}}
            />
          {/if}
        {/each}
      </svg>
    </div>
  {:else if focus.zoom === "month"}
    <div class="month">
      {#each weekdays as label (label)}
        <span class="weekday">{label}</span>
      {/each}
      {#each { length: month.lead } as _, i (i)}
        <span class="blank"></span>
      {/each}
      {#each month.days as c (c.key)}
        {@const bucket = index.days.get(c.key)}
        {@const tip = cellTip(dayLabel(c.year, c.month, c.day), bucket, kinds, appNames)}
        <button
          type="button"
          class="day l{c.future ? 0 : level(cellValue(bucket, kinds))}"
          disabled={c.future}
          aria-label={tip}
          use:tooltip={c.future ? null : tip}
          onclick={() => go(zoomInto(focus, { zoom: "day", day: c.day }))}
        >
          {c.day}
        </button>
      {/each}
    </div>
  {:else if focus.zoom === "day"}
    <div class="hours">
      {#each hours as h (h.key)}
        {@const bucket = index.hours.get(h.key)}
        {@const tip = cellTip(`${dayLabel(focus.year, focus.month, focus.day)} ${hourLabel(h.hour)}`, bucket, kinds, appNames)}
        <button
          type="button"
          class="hour l{h.future ? 0 : level(cellValue(bucket, kinds))}"
          disabled={h.future}
          aria-label={tip}
          use:tooltip={h.future ? null : tip}
          onclick={() => go(zoomInto(focus, { zoom: "hour", hour: h.hour }))}
        >
          {String(h.hour).padStart(2, "0")}
        </button>
      {/each}
    </div>
  {/if}

  {#if focus.zoom !== "hour"}
    <div class="legend" aria-hidden="true">
      <span>Less</span>
      {#each { length: LEVELS + 1 } as _, l (l)}
        <span class="swatch l{l}"></span>
      {/each}
      <span>More</span>
    </div>
  {/if}

  {#if focus.zoom === "day" || focus.zoom === "hour"}
    <div class="events">
      {#if listed.length === 0}
        <p class="empty">{load ? "Nothing happened then." : "Reading activity…"}</p>
      {/if}
      {#each listed as e (eventKey(e))}
        {#if e.type === "run"}
          {@const b = badgeOutcome(e.run)}
          {@const took = runDuration(e.run, Math.floor(now / 1000))}
          <button type="button" class="event" onclick={() => openRun(e.run)}>
            <span class="time">{clockLabel(e.at)}</span>
            {#if e.run.kind === "tool"}
              <span class="glyph" aria-hidden="true"><Wrench size={11} /></span>
            {/if}
            <StatusBadge indicator={runIndicator(b.outcome, b.exitCode)} size={11} />
            <span class="what">{title(e.run)}</span>
            {#if appNames}<span class="where">{names.get(e.workspaceId) ?? e.workspaceId}</span>{/if}
            {#if took}<span class="meta">{took}</span>{/if}
          </button>
        {:else if e.type === "commit"}
          {@const open = expanded[e.commit.sha] ?? false}
          <button
            type="button"
            class="event"
            aria-expanded={open}
            onclick={() => (expanded = { ...expanded, [e.commit.sha]: !open })}
          >
            <span class="time">{clockLabel(e.at)}</span>
            <span class="glyph" aria-hidden="true"><GitCommitHorizontal size={12} /></span>
            <span class="what">{e.commit.subject}</span>
            {#if appNames}<span class="where">{names.get(e.workspaceId) ?? e.workspaceId}</span>{/if}
            <span class="meta">{e.commit.sha.slice(0, 7)} · {e.commit.author} · {e.commit.files.length} {e.commit.files.length === 1 ? "file" : "files"}</span>
          </button>
          {#if open}
            <ul class="files">
              {#each e.commit.files as f (f)}
                <li>{f}</li>
              {:else}
                <li class="muted">A merge: its files are on the commits it brought in.</li>
              {/each}
            </ul>
          {/if}
        {:else}
          <div class="event push">
            <span class="time">{clockLabel(e.at)}</span>
            <span class="glyph" aria-hidden="true"><Upload size={12} /></span>
            <span class="what">Pushed {e.push.remoteRef}</span>
            {#if appNames}<span class="where">{names.get(e.workspaceId) ?? e.workspaceId}</span>{/if}
            <span class="meta">{pushRange(e.push)}</span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if unavailable || missing.length > 0}
    <div class="notes">
      {#if unavailable}
        <span class="note" use:tooltip={load ? unavailableTip(load) : null}>{unavailable}</span>
      {/if}
      {#each missing as line (line)}
        <span class="note">{line}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .activity {
    container: activity / inline-size;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text);
    outline: none;
  }
  .activity:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .crumbs {
    display: flex;
    align-items: baseline;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .crumb {
    background: none;
    border: none;
    padding: 1px 3px;
    border-radius: 3px;
    font: inherit;
    color: var(--accent-text);
    cursor: pointer;
  }
  .crumb:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .crumb.current {
    color: var(--text);
    cursor: default;
  }
  .sep {
    color: var(--text-subtle);
  }
  .steps {
    display: inline-flex;
    gap: 2px;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    padding: 0;
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .refresh.spinning :global(svg) {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .picker {
    position: relative;
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 200px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    font-size: 0.72rem;
    padding: 3px 6px;
    cursor: pointer;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 120px;
    padding: 4px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
  }
  .option {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 4px 6px;
    color: var(--text);
    font: inherit;
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
  }
  .option:hover {
    background: var(--surface-hover);
  }
  .tick {
    display: inline-flex;
    width: 12px;
  }

  /* The intensity scale: one hue, four strengths over the empty cell. */
  .l0 {
    --cell: var(--surface-sunken);
  }
  .l1 {
    --cell: color-mix(in srgb, var(--accent) 28%, var(--surface-sunken));
  }
  .l2 {
    --cell: color-mix(in srgb, var(--accent) 50%, var(--surface-sunken));
  }
  .l3 {
    --cell: color-mix(in srgb, var(--accent) 74%, var(--surface-sunken));
  }
  .l4 {
    --cell: var(--accent);
  }

  .year {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 4px;
    max-width: 860px;
  }
  .months {
    grid-column: 2;
    grid-row: 1;
    position: relative;
    height: 1.3em;
  }
  .month-label {
    position: absolute;
    top: 0;
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .weekdays {
    grid-column: 1;
    grid-row: 2;
    position: relative;
    width: 2.6em;
    font-size: 0.7rem;
    line-height: 1;
    color: var(--text-subtle);
  }
  .weekdays span {
    position: absolute;
    left: 0;
    transform: translateY(-50%);
  }
  .year svg {
    grid-column: 2;
    grid-row: 2;
    display: block;
    width: 100%;
    height: auto;
  }
  .cell {
    fill: var(--cell);
    cursor: pointer;
  }
  .cell:hover {
    stroke: var(--border-strong);
    stroke-width: 1;
  }

  .month {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 3px;
    max-width: 420px;
  }
  .weekday {
    text-align: center;
    font-size: 0.7rem;
    color: var(--text-subtle);
  }
  .day {
    aspect-ratio: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 2px 4px;
    background: var(--cell);
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .day.l3,
  .day.l4,
  .hour.l3,
  .hour.l4 {
    color: var(--on-accent);
  }
  .day:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  .day:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .hours {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
    gap: 2px;
  }
  .hour {
    height: 30px;
    padding: 2px 0 0;
    display: flex;
    justify-content: center;
    background: var(--cell);
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
  /* Too narrow for a day in one row -- a phone, where every control is a
     fingertip wide: four rows of six hours. */
  @container activity (max-width: 560px) {
    .hours {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 3px;
    }
    .hour {
      align-items: center;
      padding: 0;
    }
  }
  .hour:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  .hour:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 0.7rem;
    color: var(--text-subtle);
  }
  .swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: var(--cell);
  }

  .events {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    overflow-y: auto;
  }
  .event {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 3px 4px;
    color: var(--text);
    font: inherit;
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
  }
  .event:hover {
    background: var(--surface-hover);
  }
  .event.push {
    cursor: default;
  }
  .event.push:hover {
    background: none;
  }
  .time {
    flex: none;
    color: var(--text-muted);
  }
  .glyph {
    flex: none;
    display: inline-flex;
    color: var(--text-muted);
  }
  .what {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where,
  .meta {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
  }
  /* A phone's width: what a row says about its event goes under it, so
     the subject keeps the line. */
  @container activity (max-width: 560px) {
    .event {
      flex-wrap: wrap;
      row-gap: 1px;
    }
    .where,
    .meta {
      flex: 1 0 100%;
      max-width: none;
      padding-left: 6ch;
      box-sizing: border-box;
      font-size: 0.7rem;
    }
  }
  .files {
    margin: 0 0 4px 52px;
    padding: 0;
    list-style: none;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .files li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted,
  .empty {
    color: var(--text-subtle);
  }
  .empty {
    margin: 4px 0;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.7rem;
    color: var(--warning-text);
  }
  .note {
    align-self: flex-start;
  }
</style>
