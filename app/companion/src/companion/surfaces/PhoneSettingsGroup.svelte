<script lang="ts">
  // One section of a settings screen: a heading, and its settings stacked
  // under it. A phone scrolls one long column where the desk has a
  // navigator beside the body, so the heading is what a thumb scans for.
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    /// A line under the heading saying what the section is for.
    intro?: string | null;
    children: Snippet;
  }
  let { title, intro = null, children }: Props = $props();
</script>

<section class="group">
  <h2 class="title">{title}</h2>
  {#if intro}<p class="intro">{intro}</p>{/if}
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .group {
    padding: 0 max(14px, env(safe-area-inset-right)) 8px max(14px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
  }
  .title {
    margin: 0;
    padding: 18px 0 6px;
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .intro {
    margin: 0 0 8px;
    color: var(--text-subtle);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 10px;
  }
</style>
