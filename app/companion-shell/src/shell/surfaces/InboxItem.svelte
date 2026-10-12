<script lang="ts">
  // One thing waiting on the human: its kind, where it is, and what, in
  // two lines at most -- the rest is on the card or terminal it opens.
  import { kindLabel, type InboxRow } from "$shell/hub/inbox";

  interface Props {
    row: InboxRow;
    /// Where it is, beside its kind; null under a heading that says so.
    where?: string | null;
    /// Two lines tall whatever the text, so the full list can lay out
    /// rows it has not drawn (hub/inboxView.ts).
    fixed?: boolean;
    onOpen: (row: InboxRow) => void;
  }
  let { row, where = null, fixed = false, onOpen }: Props = $props();
</script>

<button type="button" class="item kind-{row.kind}" class:fixed onclick={() => onOpen(row)}>
  <span class="head">
    <span class="kind">{kindLabel(row.kind)}</span>
    {#if where}
      <span class="where">{where}</span>
    {/if}
  </span>
  <span class="text">{row.text}</span>
</button>

<style>
  .item {
    display: flex;
    flex-direction: column;
    gap: var(--space-half);
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
    color: var(--text);
    text-align: left;
  }
  .item:active {
    background: var(--surface-hover);
  }
  .item:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    min-width: 0;
    line-height: 1.4;
    white-space: nowrap;
  }
  .kind {
    flex: 0 0 auto;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .kind-failed .kind,
  .kind-interrupted .kind {
    color: var(--danger-text);
  }
  .kind-waiting .kind,
  .kind-human-test .kind {
    color: var(--accent-text);
  }
  .kind-rail-stopped .kind {
    color: var(--warning-text);
  }
  .where {
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-overflow: ellipsis;
  }
  /* Two lines at most; a Human test's text runs to five. */
  .text {
    display: -webkit-box;
    overflow: hidden;
    font-size: 0.9375rem;
    line-height: 1.4;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .fixed .text {
    height: 2.8em;
  }
</style>
