<script lang="ts">
  // The bar above every surface: where you are, and the way back.
  import type { Snippet } from "svelte";
  import { ChevronLeft, Settings } from "@lucide/svelte";

  interface Props {
    title: string;
    /// Where the back control leads, in its own words ("Workspaces"), or
    /// null where there is nowhere to go back to.
    back?: string | null;
    onBack?: (() => void) | null;
    /// A short word beside the title: "demo".
    tag?: string | null;
    /// What this screen can do, at the bar's end.
    actions?: Snippet;
    /// A badge before the title: what the thing titled is doing.
    status?: Snippet;
    /// Opens the Workstation's settings, where the header offers them.
    onSettings?: (() => void) | null;
  }
  let { title, back = null, onBack = null, tag = null, actions, status, onSettings = null }: Props = $props();
</script>

<header class="bar">
  {#if back && onBack}
    <button type="button" class="back" onclick={onBack}>
      <ChevronLeft size={18} />
      <span>{back}</span>
    </button>
  {/if}
  {@render status?.()}
  <h1 class="title">{title}</h1>
  {#if tag}
    <span class="tag">{tag}</span>
  {/if}
  {@render actions?.()}
  {#if onSettings}
    <button type="button" class="settings" aria-label="Workstation settings" onclick={onSettings}>
      <Settings size={20} />
    </button>
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    /* Zero where a line above the header has taken the notch's inset
       already: the page's offline line. */
    padding: var(--header-inset-top, env(safe-area-inset-top)) 12px 0;
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--border);
  }
  .back {
    display: inline-flex;
    /* At a large text size the label gives way before the title does,
       and is cut short rather than drawn over it. */
    flex: 0 1 auto;
    max-width: 40%;
    overflow: hidden;
    align-items: center;
    gap: 2px;
    /* A thumb's worth, whatever the label's own size. */
    min-height: 44px;
    margin-left: -6px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--accent-text);
    font-size: 0.875rem;
  }
  .back span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .back :global(svg) {
    flex: 0 0 auto;
  }
  .back:active {
    background: var(--surface-hover);
  }
  .back:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 1rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .settings {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-right: -10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
  }
  .settings:active {
    background: var(--surface-hover);
  }
  .settings:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .tag {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid var(--border-warning);
    border-radius: 4px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
