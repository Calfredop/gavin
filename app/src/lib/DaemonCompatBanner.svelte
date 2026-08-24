<script lang="ts">
  // Surfaces Tasks 1-6b's compat verdict (session::DaemonCompat): a
  // daemon inside the compat window but older than this app is a
  // working app with a caveat, not an error -- see +page.svelte, which
  // renders this in the working-app branch, never the connection-error
  // one. Styled as an inline status bar rather than an overlay, the same
  // idiom OrchestrationHubView's own `.save-error` bar already uses for
  // "something's off, here's what to do about it."
  import { TriangleAlert } from "@lucide/svelte";
  import { layoutState, daemonCompat, retryConnect, runningSessionCount } from "./layoutState";
  import { compatMessage } from "./daemonCompat";

  const message = $derived(compatMessage($daemonCompat, runningSessionCount($layoutState)));

  // Sticks across re-renders of the SAME wording, but resurfaces if the
  // message changes -- e.g. a restart that lands on a still-degraded (or
  // differently degraded) daemon must not stay silenced by a dismissal of
  // the PREVIOUS banner's text.
  let dismissedMessage = $state<string | null>(null);
</script>

{#if message && message !== dismissedMessage}
  <div class="banner" role="status">
    <TriangleAlert size={14} />
    <span class="text">{message}</span>
    <button type="button" class="action" onclick={() => void retryConnect()}>Restart daemon</button>
    <button type="button" class="action" onclick={() => (dismissedMessage = message)}>Dismiss</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    flex: 0 0 auto;
    background: var(--surface-warning);
    border-bottom: 1px solid var(--border-warning);
    color: var(--warning-text);
    font-size: 12px;
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
</style>
