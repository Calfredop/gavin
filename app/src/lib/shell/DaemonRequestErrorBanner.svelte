<script lang="ts">
  // One request the daemon refused, on a connection that is still up
  // (session::attach_and_relay's "daemon-request-error"). Same idiom as
  // DaemonCompatBanner beside it: an inline status bar, never an overlay
  // -- the whole point of this component is that the app behind it still
  // works. Routing these through layoutState.status instead is what made
  // a stray resize for an already-dead session blank the entire window.
  import { TriangleAlert } from "@lucide/svelte";
  import { daemonRequestError } from "$lib/core/layoutState";
</script>

{#if $daemonRequestError}
  <div class="banner" role="status">
    <TriangleAlert size={14} />
    <span class="text">The daemon refused a request: {$daemonRequestError}</span>
    <button type="button" class="action" onclick={() => daemonRequestError.set(null)}>Dismiss</button>
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
