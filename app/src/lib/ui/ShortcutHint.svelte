<script lang="ts">
  // The small key badge shown while the command key is held. Purely
  // presentational: each surface decides WHEN to render one and where it
  // sits; this owns only how it looks.
  let { text }: { text: string } = $props();
</script>

<span class="shortcut-hint" aria-hidden="true">{text}</span>

<style>
  .shortcut-hint {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
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
    pointer-events: none;
  }
</style>
