<script lang="ts">
  // A card's body or a PRD, rendered: the desk's one markdown pass
  // (`renderMarkdown`, frontmatter left out), sanitized as the desk's card
  // detail sanitizes it, and set for reading on a phone.
  import DOMPurify from "dompurify";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { renderMarkdown } from "$lib/files/markdown";

  interface Props {
    content: string;
  }
  let { content }: Props = $props();

  const html = $derived(DOMPurify.sanitize(renderMarkdown(content)));

  // A link leaves the bundle through the shell, into the system browser:
  // the bundle's own webview navigates nowhere (ADR 0005).
  function follow(event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => {});
  }
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized above -->
<div class="markdown" role="presentation" onclick={follow}>{@html html}</div>

<style>
  .markdown {
    color: var(--text);
    font-size: 0.9375rem;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3) {
    margin: 1.1em 0 0.4em;
    line-height: 1.3;
  }
  .markdown :global(h1) {
    font-size: 1.25rem;
  }
  .markdown :global(h2) {
    font-size: 1.0625rem;
  }
  .markdown :global(h3) {
    font-size: 1rem;
  }
  .markdown :global(:first-child) {
    margin-top: 0;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 0.8em;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 1.3em;
  }
  .markdown :global(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--surface-sunken);
    font-size: 0.875em;
  }
  .markdown :global(pre) {
    padding: 10px;
    overflow-x: auto;
    border-radius: 6px;
    background: var(--surface-sunken);
  }
  .markdown :global(pre code) {
    padding: 0;
    background: none;
  }
  .markdown :global(a) {
    color: var(--accent-text);
  }
  .markdown :global(blockquote) {
    margin: 0 0 0.8em;
    padding-left: 10px;
    border-left: 3px solid var(--border-strong);
    color: var(--text-muted);
  }
</style>
