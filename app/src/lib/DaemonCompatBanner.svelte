<script lang="ts">
  // Surfaces the compat verdict (session::DaemonCompat): a
  // daemon inside the compat window but older than this app is a
  // working app with a caveat, not an error -- see +page.svelte, which
  // renders this in the working-app branch, never the connection-error
  // one. Styled as an inline status bar rather than an overlay, the same
  // idiom OrchestrationHubView's own `.save-error` bar already uses for
  // "something's off, here's what to do about it."
  import { TriangleAlert } from "@lucide/svelte";
  import { layoutState, daemonCompat, restartDaemonInPlace, runningSessionCount } from "./layoutState";
  import { compatMessage } from "./daemonCompat";

  const message = $derived(compatMessage($daemonCompat, runningSessionCount($layoutState)));

  // Sticks across re-renders of the SAME wording, but resurfaces if the
  // message changes -- e.g. a restart that lands on a still-degraded (or
  // differently degraded) daemon must not stay silenced by a dismissal of
  // the PREVIOUS banner's text.
  let dismissedMessage = $state<string | null>(null);

  // Same idiom as SettingsHubView's own restart control: restartDaemonInPlace
  // (unlike retryConnect, which the button used to call) never touches
  // layoutState.status, so a click here can't blank the working app behind
  // the connecting/error overlays in +page.svelte -- the whole point of
  // showing this as a banner instead of an error screen. It DOES throw on
  // failure, deliberately, so that failure is caught and shown here rather
  // than escaping to the global error screen: a failed restart should leave
  // the user exactly where they were, with an explanation.
  let restarting = $state(false);
  let restartError = $state<string | null>(null);

  async function restart(): Promise<void> {
    restarting = true;
    restartError = null;
    try {
      await restartDaemonInPlace();
      // refreshDaemonCompat (called inside restartDaemonInPlace) updates
      // $daemonCompat; if the restart actually fixed things, `message`
      // above goes null on its own and this banner disappears -- no
      // separate "restarted" confirmation needed.
    } catch (e) {
      restartError = String(e instanceof Error ? e.message : e);
    } finally {
      restarting = false;
    }
  }
</script>

{#if message && message !== dismissedMessage}
  <div class="banner" role="status">
    <div class="row">
      <TriangleAlert size={14} />
      <span class="text">{message}</span>
      <button type="button" class="action" disabled={restarting} onclick={() => void restart()}>
        {restarting ? "Restarting…" : "Restart daemon"}
      </button>
      <button type="button" class="action" onclick={() => (dismissedMessage = message)}>Dismiss</button>
    </div>
    {#if restartError}
      <p class="error">Couldn't restart the daemon: {restartError}</p>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 12px;
    flex: 0 0 auto;
    background: var(--surface-warning);
    border-bottom: 1px solid var(--border-warning);
    color: var(--warning-text);
    font-size: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .action {
    flex: 0 0 auto;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    font-size: 12px;
    cursor: pointer;
  }
  .action:disabled {
    cursor: default;
    opacity: 0.7;
    text-decoration: none;
  }
  .error {
    margin: 0;
    padding-left: 22px;
    color: var(--danger-text);
  }
</style>
