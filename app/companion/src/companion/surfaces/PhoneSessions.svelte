<script lang="ts">
  // A workspace's sessions, and the way to open another. A thin template
  // over sessionList.ts (what each row says) and state/sessions.ts (what
  // opening one does).
  import { onMount } from "svelte";
  import { Bot, ChevronRight, Play, SquareTerminal } from "@lucide/svelte";
  import { verdictAttentionStatusById } from "$lib/agents/verdictAttention";
  import { showAlert } from "$lib/core/dialog";
  import { layoutState } from "$lib/core/layoutState";
  import type { Workspace } from "$lib/core/workspace";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { onReconnect } from "$companion/state/reachability";
  import {
    agentStartedHere,
    launchTables,
    loadLaunchTables,
    startedAt,
    startedHere,
    startSession,
    type SessionKind,
  } from "$companion/state/sessions";
  import { openTerminal } from "$companion/state/workstation";
  import { sessionGroups } from "$companion/surfaces/sessionList";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  /// The clock the started-here group is read against: moved when a start
  /// runs out of the time the desk has to place it (`placingUntil`).
  let now = $state(Date.now());

  const groups = $derived(
    sessionGroups({
      workspace,
      tabs: {
        fileTabsById: $layoutState.fileTabsById,
        boardTabsById: $layoutState.boardTabsById,
        cardTabsById: $layoutState.cardTabsById,
      },
      statusById: $verdictAttentionStatusById,
      sessionNames: $layoutState.sessionNames,
      cwdBySessionId: $layoutState.cwdBySessionId,
      failureReasonById: $layoutState.failureReasonById,
      interruptedSessionIds: $layoutState.interruptedSessionIds,
      startedHere: Object.entries($startedHere)
        .filter(([, workspaceId]) => workspaceId === workspace.id)
        .map(([id]) => id),
      agentStartedHere: $agentStartedHere[workspace.id],
      startedAt: $startedAt,
      now,
    })
  );

  $effect(() => {
    const until = groups.find((g) => g.placingUntil !== undefined)?.placingUntil;
    if (until === undefined) return;
    const timer = setTimeout(() => (now = Date.now()), Math.max(until - Date.now(), 0) + 50);
    return () => clearTimeout(timer);
  });

  let starting = $state<SessionKind | null>(null);

  onMount(() => {
    void loadLaunchTables();
    // The list itself is the Workstation's sessions, read again by
    // state/workstation.ts; what starting one needs, if it failed.
    return onReconnect(() => void loadLaunchTables());
  });

  async function start(kind: SessionKind): Promise<void> {
    if (starting !== null) return;
    starting = kind;
    try {
      openTerminal(await startSession(workspace.id, kind));
    } catch (e) {
      await showAlert({
        title: kind === "terminal" ? "The terminal could not be opened" : "The agent could not be started",
        lines: [e instanceof Error ? e.message : String(e)],
      });
    } finally {
      starting = null;
    }
  }
</script>

<div class="sessions">
  <div class="new">
    <button
      type="button"
      class="start"
      disabled={starting !== null || $launchTables !== "ready"}
      onclick={() => void start("agent")}
    >
      <Bot size={16} />
      <span>{starting === "agent" ? "Starting…" : "New agent"}</span>
    </button>
    <button type="button" class="start" disabled={starting !== null} onclick={() => void start("terminal")}>
      <SquareTerminal size={16} />
      <span>{starting === "terminal" ? "Opening…" : "New terminal"}</span>
    </button>
  </div>

  {#if groups.length === 0}
    <p class="empty">No session is open in this workspace. Start one above; the desk shows it too.</p>
  {:else}
    {#each groups as group (group.key)}
      <section class="group" aria-label={group.title}>
        <h2 class="group-title">{group.title}</h2>
        {#if group.unplaced}
          <p class="unplaced">The desk has not placed these as tabs, so only this phone lists them.</p>
        {/if}
        {#if group.startAgent}
          <button
            type="button"
            class="row"
            disabled={starting !== null || $launchTables !== "ready"}
            onclick={() => void start("workspace-agent")}
          >
            <Play size={16} />
            <span class="text">
              <span class="name">{starting === "workspace-agent" ? "Starting…" : "Start workspace agent"}</span>
              <span class="said">Not running. It works in the workspace's folder, and the desk shows it on Home.</span>
            </span>
          </button>
        {/if}
        <ul class="rows">
          {#each group.rows as row (row.id)}
            <li>
              <button type="button" class="row" onclick={() => openTerminal(row.id)}>
                <StatusBadge indicator={row.badge} size={16} tip={null} />
                <span class="text">
                  <span class="name">{row.name}</span>
                  <span class="said">{row.said}{#if row.folder}<span class="folder">{` · ${row.folder}`}</span>{/if}</span>
                </span>
                <ChevronRight size={18} />
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .sessions {
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
  .new {
    display: flex;
    gap: 8px;
    padding: 12px max(12px, env(safe-area-inset-right)) 4px max(12px, env(safe-area-inset-left));
  }
  .start {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .start:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .start:disabled {
    opacity: 0.45;
  }
  .start:focus-visible {
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
    padding: 0 max(14px, env(safe-area-inset-left));
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .unplaced {
    margin: 0 0 4px;
    padding: 0 max(14px, env(safe-area-inset-left));
    color: var(--text-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px max(12px, env(safe-area-inset-right)) 8px max(14px, env(safe-area-inset-left));
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text-subtle);
    text-align: left;
  }
  .row:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .row:disabled {
    opacity: 0.45;
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
  .folder {
    color: var(--text-subtle);
  }
</style>
