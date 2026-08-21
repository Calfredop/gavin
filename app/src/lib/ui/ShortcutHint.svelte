<script lang="ts">
  // The small key badge shown while the command key is held. Absolutely
  // positioned on purpose: holding ⌘ must not reflow the window. Hosts
  // only need `position: relative` (and, for `end`, room at their right
  // edge -- the badge overlays whatever is there, which is fine for a
  // gesture where nothing is being clicked).
  let { text, placement = "end" }: { text: string; placement?: "end" | "center" } = $props();
</script>

<span class="shortcut-hint {placement}" aria-hidden="true">{text}</span>

<style>
  .shortcut-hint {
    position: absolute;
    z-index: 4;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border: 1px solid var(--ws-accent, var(--border));
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text);
    font-family: monospace;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
  }
  /* Rows: pinned to the right edge, vertically centred. */
  .shortcut-hint.end {
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
  }
  /* Small icon buttons: straight over the icon, since a "⌘⇧D" pill is
     wider than the button it belongs to. */
  .shortcut-hint.center {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
  }
</style>
