<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { agentProfilesStore } from "./layoutState";
  import { agentUsageStore, nowStore, profilesInUse, refreshUsage } from "./agentPauseState";
  import {
    barPercent,
    displayPercent,
    formatObservedAge,
    formatResetsIn,
    unavailableReason,
    usageSeverity,
    type AgentUsageReport,
  } from "./agentUsage";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  /// Only the profiles some workspace actually runs. A row for an agent
  /// nobody here uses is a bar that means nothing, and for the three
  /// profiles with no probe it would be a paragraph of apology.
  const inUse = $derived(new Set(profilesInUse()));
  const profiles = $derived($agentProfilesStore.filter((p) => inUse.has(p.id)));

  let refreshing = $state<Record<string, boolean>>({});

  async function refresh(profileId: string): Promise<void> {
    refreshing = { ...refreshing, [profileId]: true };
    try {
      await refreshUsage(profileId, true);
    } finally {
      refreshing = { ...refreshing, [profileId]: false };
    }
  }

  /// Absent is NOT `unsupported`: the first read has not landed yet, and
  /// "checking…" is a different sentence from "this agent has no limits".
  function reportFor(profileId: string): AgentUsageReport | undefined {
    return $agentUsageStore[profileId];
  }
</script>

<Modal {onClose}>
  <div class="agent-usage">
    <h2>Agent usage</h2>

    {#if profiles.length === 0}
      <p class="hint">No workspace is running an agent yet.</p>
    {/if}

    {#each profiles as profile (profile.id)}
      {@const report = reportFor(profile.id)}
      <section>
        <header>
          <h3>{profile.label}</h3>
          {#if report?.state === "ready" && report.plan}
            <span class="plan">{report.plan}</span>
          {/if}
          {#if profile.usageProbe}
            <IconButton
              icon={RefreshCw}
              label="Check again"
              size={11}
              disabled={refreshing[profile.id]}
              onclick={() => void refresh(profile.id)}
            />
          {/if}
        </header>

        {#if report == null}
          <p class="hint">Checking…</p>
        {:else if report.state === "ready"}
          {#each report.windows as window (window.id)}
            <div class="window">
              <span class="label">{window.label}</span>
              <div class="track">
                <div
                  class="fill {usageSeverity(window.usedPercent)}"
                  style="width: {barPercent(window.usedPercent)}%"
                ></div>
              </div>
              <span class="pct">{displayPercent(window.usedPercent)}%</span>
              <span class="resets">{formatResetsIn(window.resetsAt, $nowStore) ?? ""}</span>
            </div>
          {/each}
          {#if formatObservedAge(report.observedAt, $nowStore)}
            <!-- The codex route reports last-seen, not live. A number
                 with an age on it is never mistaken for a live one. -->
            <p class="hint">Last reading {formatObservedAge(report.observedAt, $nowStore)}.</p>
          {/if}
        {:else}
          <p class="hint">{unavailableReason(report, profile.label, $nowStore)}</p>
        {/if}
      </section>
    {/each}

    <div class="actions">
      <button onclick={onClose}>Close</button>
    </div>
  </div>
</Modal>

<style>
  .agent-usage {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 380px;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h3 {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .plan {
    color: var(--text-subtle);
    font-size: 0.85em;
  }
  header :global(button) {
    margin-left: auto;
  }
  .window {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }
  .label {
    width: 62px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .track {
    flex: 1 1 auto;
    height: 6px;
    min-width: 60px;
    background: var(--surface-sunken);
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  /* The bands agentUsage.ts owns; the colours only name them. */
  .fill.warn {
    background: var(--warning);
  }
  .fill.critical {
    background: var(--danger);
  }
  .pct {
    width: 38px;
    flex: 0 0 auto;
    text-align: right;
    color: var(--text);
  }
  .resets {
    width: 120px;
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.85em;
  }
  .hint {
    color: var(--text-subtle);
    margin: 4px 0 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
</style>
