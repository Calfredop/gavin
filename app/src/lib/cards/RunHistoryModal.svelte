<script lang="ts">
  // Every run a card has had, with what each one cost.
  //
  // A list rather than a chart. The question this answers is "what
  // happened to this card, and which run was expensive" -- twelve rows
  // at most, each of which the human can act on (open the session, see
  // what it changed). A bar chart of twelve values would be a decoration
  // over data that reads perfectly well as a table.
  import Modal from "$lib/Modal.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { runIndicator } from "$lib/ui/indicators";
  import { relativeTime } from "$lib/hub/appHub";
  import {
    historySummary,
    runRows,
    tokenBreakdown,
    tokenProblem,
    tokenSummary,
    totalCost,
  } from "$lib/cards/runHistory";
  import {
    closeRunHistory,
    openRunHistory,
    refreshRunHistory,
    runHistoryStore,
    tokensForRun,
    tokensPending,
  } from "$lib/cards/runHistoryState";
  import { tooltip } from "$lib/tooltip";

  interface Props {
    /// The card whose runs these are. Also the store key.
    path: string;
    title: string;
    workspaceId: string;
    /// Which agent profile's transcripts to read the token counts out
    /// of. The workspace's resolved profile, not the run's: a run does
    /// not record which profile launched it, and the command it kept is
    /// a string, not an id.
    profileId: string;
    /// Opens the session a run belonged to, when it is still there.
    /// Null when this surface cannot navigate.
    onOpenSession?: ((sessionId: string) => void) | null;
    onClose: () => void;
  }
  let { path, title, workspaceId, profileId, onOpenSession = null, onClose }: Props = $props();

  $effect(() => {
    void openRunHistory(path, workspaceId, profileId);
  });

  // Seconds, and it ticks: a running run's duration is measured against
  // now, so without this the open row would freeze at whatever second
  // the panel happened to render.
  let nowSeconds = $state(Math.floor(Date.now() / 1000));
  $effect(() => {
    const timer = setInterval(() => (nowSeconds = Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  });

  const view = $derived($runHistoryStore[path] ?? null);
  const runs = $derived(view?.runs ?? []);
  const rows = $derived(runRows(runs, nowSeconds));
  const summary = $derived(historySummary(runs, nowSeconds));
  const cost = $derived(totalCost(runs.map((run) => tokensForRun(view ?? undefined, run))));

  function close(): void {
    closeRunHistory(path);
    onClose();
  }
</script>

<Modal onClose={close} scrollKey={path} wide innerScroll>
  <div class="run-history">
    <div class="head">
      <div class="titles">
        <h2>{title}</h2>
        <p class="sub">
          {summary}{#if cost} · {cost}{/if}
        </p>
      </div>
      <button
        type="button"
        onclick={() => void refreshRunHistory(path, workspaceId, profileId)}
        disabled={view?.loading}
      >
        Refresh
      </button>
    </div>

    {#if view?.error}<p class="strip error">{view.error}</p>{/if}

    <div class="rows">
      {#if view?.loading && rows.length === 0}
        <div class="none">Reading this card's runs…</div>
      {:else if rows.length === 0}
        <div class="none">Nothing has run this card yet.</div>
      {:else}
        {#each rows as row (row.run.id)}
          {@const report = tokensForRun(view ?? undefined, row.run)}
          {@const pending = tokensPending(view ?? undefined, row.run)}
          {@const problem = tokenProblem(report)}
          <div class="row" class:resumed={row.resumed}>
            <div class="when">
              <StatusBadge
                indicator={runIndicator(row.run.outcome, row.run.exitCode)}
                tip={row.outcomeText}
              />
              <span class="label">{row.label}</span>
              <span class="ago">{relativeTime(row.run.startedAt * 1000, nowSeconds * 1000)}</span>
            </div>

            <div class="facts">
              <span class="outcome" use:tooltip={row.outcomeText}>{row.outcome}</span>
              <!-- A run whose end nobody watched has NO duration. An
                   em dash, never a zero and never a count from its start
                   to now: that would report a run that stopped days ago
                   as a multi-day session. -->
              <span class="duration">{row.duration ?? "—"}</span>
              {#if row.agent}<span class="agent">{row.agent}</span>{/if}
              {#if (row.run.resumeAttempts ?? 0) > 0}
                <span
                  class="auto"
                  use:tooltip={"Gavin resumed this run by itself after a failure it could classify."}
                >
                  {row.run.resumeAttempts} auto-resume{(row.run.resumeAttempts ?? 0) === 1 ? "" : "s"}
                </span>
              {/if}
            </div>

            <div class="cost">
              {#if pending}
                <span class="quiet">Reading…</span>
              {:else if report?.kind === "ready"}
                <span use:tooltip={tokenBreakdown(report) ?? undefined}>{tokenSummary(report)}</span>
              {:else if problem}
                <!-- The sentence, not a zero: a profile gavin cannot read
                     and a run that cost nothing are different facts. -->
                <span class="quiet" use:tooltip={problem}>No cost recorded</span>
              {:else}
                <span class="quiet">—</span>
              {/if}
            </div>

            <div class="go">
              {#if onOpenSession}
                <button type="button" onclick={() => onOpenSession?.(row.run.sessionId)}>
                  Open session
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</Modal>

<style>
  .run-history {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: min(70vh, 720px);
    width: min(88vw, 900px);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .titles {
    min-width: 0;
    flex: 1;
  }
  h2 {
    margin: 0;
    font-size: 1.05em;
  }
  .sub {
    margin: 2px 0 0;
    color: var(--text-dim);
    font-size: 0.85em;
  }
  .strip {
    margin: 8px 0 0;
    font-size: 0.85em;
  }
  .strip.error {
    color: var(--danger);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-top: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.2fr) minmax(0, 0.9fr) auto;
    align-items: center;
    gap: 10px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 0.86em;
  }
  /* A resume is the same work continuing, so it is indented under the
     run it continues rather than given a rule of its own. */
  .row.resumed {
    padding-left: 18px;
  }
  .when {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .label {
    font-weight: 500;
    white-space: nowrap;
  }
  .ago,
  .quiet {
    color: var(--text-dim);
  }
  .facts {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-dim);
  }
  .outcome {
    color: var(--text);
  }
  .duration {
    font-variant-numeric: tabular-nums;
  }
  .agent,
  .auto {
    white-space: nowrap;
  }
  .cost {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .go {
    display: flex;
    justify-content: flex-end;
  }
  .none {
    padding: 24px 4px;
    color: var(--text-dim);
  }
</style>
