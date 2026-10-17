<script lang="ts">
  // A workspace's tools, and running one. A thin template over
  // phoneTools.ts (what each row says) and state/tools.ts (what loading
  // and running one does). A row opens in place: what the tool is, its
  // last run, its parameters and Run.
  import { onMount } from "svelte";
  import { ChevronDown, ChevronRight, Play, SquareTerminal } from "@lucide/svelte";
  import { daemonCompat } from "$lib/core/layoutState";
  import type { Workspace } from "$lib/core/workspace";
  import { toolRunsStore } from "$lib/orchestration/toolRunsState";
  import { renderLibraryFor, toolRecords } from "$lib/orchestration/toolsState";
  import { runIndicator } from "$lib/ui/indicators";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { toolIcon } from "$lib/ui/toolKindIcon";
  import { lastRunsFor, toolRunAxis, toolRunTip, type ToolRun } from "$lib/workspace/workspaceTools";
  import { onReconnect } from "$companion/state/reachability";
  import { loadTools, runTool } from "$companion/state/tools";
  import { openTerminal } from "$companion/state/workstation";
  import { seededValues, toolGroups, toolsEmptyLine, type ToolRow } from "$companion/surfaces/phoneTools";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  let search = $state("");
  /// The row open in place, by tool id.
  let expanded = $state<string | null>(null);
  /// Whether the open row shows what it runs.
  let showBody = $state(false);
  /// What has been typed into the open row's parameters.
  let typed = $state<Record<string, string>>({});
  let starting = $state<string | null>(null);
  /// Why the last Run did not start, by tool id.
  let refused = $state<Record<string, string>>({});
  /// The clock a run's age is read against.
  let now = $state(Date.now());

  const library = $derived(renderLibraryFor($toolRecords, workspace.id));
  const lastRuns = $derived(lastRunsFor($toolRunsStore, workspace.id));
  const groups = $derived(
    toolGroups({
      library,
      lastRuns,
      search,
      compat: $daemonCompat,
      rootPath: workspace.rootPath || null,
      nowMs: now,
    })
  );
  const runsError = $derived($toolRunsStore[workspace.id]?.error ?? null);

  onMount(() => {
    void loadTools(workspace.id);
    const tick = setInterval(() => (now = Date.now()), 30_000);
    const stop = onReconnect(() => void loadTools(workspace.id));
    return () => {
      clearInterval(tick);
      stop();
    };
  });

  function toggle(id: string): void {
    expanded = expanded === id ? null : id;
    showBody = false;
    typed = {};
  }

  function badgeFor(run: ToolRun) {
    const axis = toolRunAxis(run);
    const tip = toolRunTip(run);
    return { ...runIndicator(axis.outcome, axis.exitCode), tip, label: tip };
  }

  function bodyLabel(row: ToolRow): string {
    return row.kindLabel === "Agent prompt" ? "prompt" : row.kindLabel === "Bash command" ? "command" : "script";
  }

  async function run(row: ToolRow): Promise<void> {
    if (starting !== null) return;
    starting = row.id;
    const { [row.id]: _cleared, ...rest } = refused;
    refused = rest;
    const failure = await runTool(workspace.id, row.id, seededValues(row.params, typed));
    starting = null;
    if (failure) refused = { ...refused, [row.id]: failure };
  }
</script>

<div class="tools">
  <div class="search">
    <input type="search" placeholder="Search tools" aria-label="Search tools" autocomplete="off" bind:value={search} />
  </div>

  {#if runsError}
    <p class="problem">The tools' last runs could not be read: {runsError}</p>
  {/if}

  {#if groups.length === 0}
    <p class="empty">{toolsEmptyLine(search)}</p>
  {:else}
    {#each groups as group (group.scope)}
      <section class="group" aria-label={group.title}>
        <h2 class="group-title">{group.title}</h2>
        <ul class="rows">
          {#each group.rows as row (row.id)}
            {@const tool = library.find((t) => t.id === row.id)}
            {@const Icon = tool ? toolIcon(tool) : Play}
            {@const open = expanded === row.id}
            <li class:open>
              <button type="button" class="row" aria-expanded={open} onclick={() => toggle(row.id)}>
                <Icon size={18} />
                <span class="text">
                  <span class="name">{row.name}</span>
                  <span class="said">{row.description || row.kindLabel}</span>
                  {#if row.run}
                    <span class="chip"><StatusBadge indicator={badgeFor(row.run.run)} size={12} text={row.run.chip} /></span>
                  {/if}
                </span>
                {#if open}<ChevronDown size={18} />{:else}<ChevronRight size={18} />{/if}
              </button>

              {#if open}
                <div class="detail">
                  <p class="meta">{row.kindLabel}{row.cwd ? ` · runs in ${row.cwd}` : ""}</p>
                  {#if row.description}
                    <p class="description">{row.description}</p>
                  {/if}
                  {#if row.run}
                    <p class="last">Last run: {row.run.sentence}</p>
                    {#if row.run.open}
                      <button type="button" class="action" onclick={() => openTerminal(row.run!.run.sessionId)}>
                        <SquareTerminal size={16} />
                        <span>Open its session</span>
                      </button>
                    {/if}
                  {/if}

                  {#if !row.blocked}
                    {#each row.params as param (param.name)}
                      <label class="param">
                        <span class="param-label">{param.label || param.name}</span>
                        <input
                          type="text"
                          autocomplete="off"
                          autocapitalize="off"
                          spellcheck="false"
                          value={typed[param.name] ?? param.default}
                          oninput={(e) => (typed = { ...typed, [param.name]: e.currentTarget.value })}
                        />
                      </label>
                    {/each}
                    <button
                      type="button"
                      class="run"
                      disabled={starting !== null}
                      onclick={() => void run(row)}
                    >
                      <Play size={16} />
                      <span>{starting === row.id ? "Starting…" : "Run"}</span>
                    </button>
                  {:else if !row.run?.open}
                    <p class="blocked">{row.blocked}</p>
                  {/if}
                  {#if refused[row.id]}
                    <p class="problem" role="alert">{refused[row.id]}</p>
                  {/if}

                  {#if row.body.trim()}
                    <button type="button" class="action" aria-expanded={showBody} onclick={() => (showBody = !showBody)}>
                      <span>{showBody ? `Hide the ${bodyLabel(row)}` : `Show the ${bodyLabel(row)}`}</span>
                    </button>
                    {#if showBody}
                      <pre class="body">{row.body}</pre>
                    {/if}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .tools {
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
  .search {
    padding: 12px 12px 4px;
  }
  .search input {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
  }
  .search input:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .empty {
    margin: 0;
    padding: 20px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .group-title {
    margin: 16px 0 4px;
    padding: 0 14px;
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    border-bottom: 1px solid var(--border);
  }
  li.open {
    background: var(--surface-sunken);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 12px 8px 14px;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  .row:active {
    background: var(--surface-hover);
  }
  .row:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name,
  .said {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
  }
  .said {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .chip {
    display: flex;
    font-size: 0.75rem;
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 14px 16px;
  }
  .meta,
  .description,
  .last,
  .blocked,
  .problem {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.45;
    -webkit-user-select: text;
    user-select: text;
  }
  .meta {
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }
  .description,
  .last {
    color: var(--text);
  }
  .blocked {
    color: var(--text-muted);
  }
  .problem {
    padding: 0 14px;
    color: var(--danger-text);
    overflow-wrap: anywhere;
  }
  .detail .problem {
    padding: 0;
  }
  .param {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .param-label {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .param input {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
  }
  .param input:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .run,
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .run {
    font-weight: 600;
  }
  .run:active:not(:disabled),
  .action:active {
    background: var(--surface-hover);
  }
  .run:disabled {
    opacity: 0.45;
  }
  .run:focus-visible,
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .body {
    margin: 0;
    padding: 10px 12px;
    max-height: 50vh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font-size: 0.8125rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
</style>
