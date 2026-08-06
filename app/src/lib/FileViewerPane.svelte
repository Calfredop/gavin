<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import hljs from "highlight.js";
  import "highlight.js/styles/github-dark.css";
  import { fileLanguage, isMarkdown } from "./fileTypes";
  import * as backend from "./backend";

  let { path, visible }: { path: string; visible: boolean } = $props();

  let content = $state("");
  let truncated = $state(false);
  let error = $state<string | null>(null);
  // Kept separate from `error`: failing to hand the file to another app
  // says nothing about whether we could READ it, so it must not replace
  // perfectly good content with a "couldn't open this file" screen.
  let openError = $state<string | null>(null);
  let unlisten: UnlistenFn | null = null;

  // Pane.svelte's fitAll() calls fit() on every tab in a pane, terminal or
  // not. A file viewer has nothing to resize -- it reflows with CSS -- so
  // this exists purely so that shared loop needs no per-tab-kind branch.
  export function fit(): void {}

  async function load(): Promise<void> {
    try {
      const result = await backend.readFileForViewer(path);
      content = result.content;
      truncated = result.truncated;
      error = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const rendered = $derived.by(() => {
    if (error !== null) return "";
    if (isMarkdown(path)) {
      return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
    }
    const language = fileLanguage(path);
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(content, { language }).value;
    }
    // No known language: still viewable, just not colorized. Escaped
    // manually rather than guessed at via highlightAuto, which picks
    // wrongly on short files.
    return escapeHtml(content);
  });

  // Surfaces its failure rather than swallowing it: this is a
  // user-initiated action, and a silent no-op gives no clue why nothing
  // happened (exactly how the missing opener:allow-open-path capability
  // originally presented).
  async function openExternally(): Promise<void> {
    try {
      openError = null;
      await openPath(path);
    } catch (e) {
      openError = String(e instanceof Error ? e.message : e);
    }
  }

  onMount(async () => {
    await load();
    await backend.watchFileForViewer(path).catch(() => {});
    unlisten = await listen<string>("file-changed", (event) => {
      if (event.payload === path) void load();
    });
  });

  onDestroy(() => {
    unlisten?.();
    // Best-effort: the tab is going away regardless of whether the
    // watcher teardown succeeds. layoutState's close paths also unwatch
    // (see endTabs) -- unwatching twice is a documented no-op.
    void backend.unwatchFileForViewer(path).catch(() => {});
  });
</script>

<div class="pane" class:inactive={!visible}>
  {#if openError !== null}
    <div class="notice error">
      Couldn't open externally: {openError}
    </div>
  {/if}
  {#if error !== null}
    <div class="overlay">
      <p>Couldn't open this file.</p>
      <p class="detail">{error}</p>
      <button onclick={openExternally}>Open externally</button>
    </div>
  {:else}
    {#if truncated}
      <div class="notice">
        This file is too large to preview in full — showing the first part only.
        <button onclick={openExternally}>Open externally</button>
      </div>
    {/if}
    {#if isMarkdown(path)}
      <div class="markdown">{@html rendered}</div>
    {:else}
      <pre class="code"><code>{@html rendered}</code></pre>
    {/if}
  {/if}
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: #1e1e1e;
    color: #eee;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
  .overlay {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button,
  .notice button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: #3a3320;
    color: #e0d0a0;
    font-family: monospace;
    font-size: 0.85em;
  }
  .notice button {
    margin-top: 0;
    padding: 4px 10px;
  }
  .notice.error {
    background: #3a2020;
    color: #e0a0a0;
  }
  .code {
    margin: 0;
    padding: 12px;
    font-family: monospace;
    font-size: 0.85em;
    white-space: pre;
    user-select: text;
  }
  .markdown {
    padding: 16px 20px;
    max-width: 900px;
    line-height: 1.6;
    user-select: text;
    /* Prose reads better proportional; the app is otherwise monospace.
       Code blocks inside stay monospace via the :global(code) rule below. */
    font-family: sans-serif;
  }
  .markdown :global(pre) {
    background: #2a2a2a;
    padding: 10px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .markdown :global(code) {
    font-family: monospace;
    font-size: 0.9em;
  }
  .markdown :global(a) {
    color: #4a9eff;
  }
  .markdown :global(table) {
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid #444;
    padding: 4px 8px;
  }
</style>
