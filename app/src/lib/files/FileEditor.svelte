<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "$lib/files/markdown";
  import {
    canEdit,
    classifyExternalRead,
    defaultMode,
    modesFor,
    resolveExternalChange,
    setPathDirty,
    type EditorMode,
  } from "$lib/files/fileEditing";
  import CodeMirrorView from "$lib/files/CodeMirrorView.svelte";
  import MarkdownToolbar from "$lib/files/MarkdownToolbar.svelte";
  import { isMarkdown } from "$lib/files/fileTypes";
  import type { FormatAction } from "$lib/files/markdownFormatting";
  import * as backend from "$lib/backend";

  interface Props {
    path: string;
    initialMode?: EditorMode;
    /// Fired when the human switches mode. The mode is this editor's own
    /// state, read from `initialMode` once at creation; a host that has
    /// to remember it across a remount (the Plans tab) hears about
    /// changes here rather than reaching in.
    onModeChange?: (mode: EditorMode) => void;
    /// How the text sits in the pane. "fill" (the default) is a file
    /// tab: the editor runs edge to edge and Formatted caps itself at
    /// 900px, left-aligned. "document" is the PRD and agent-file hub
    /// tabs: the pane still spans the viewport, but the text -- prose
    /// and editor lines alike -- sits in a centred A4-ish column, the
    /// way a Google Doc sits on its canvas, and the prose is set smaller.
    layout?: "fill" | "document";
  }
  let { path, initialMode, onModeChange, layout = "fill" }: Props = $props();

  const AUTOSAVE_MS = 1000;

  let mode = $state<EditorMode>(initialMode ?? defaultMode(path, "tab"));
  let buffer = $state("");
  // What this editor last read from or wrote to `path`. The conflict
  // check runs against THIS, not the buffer: our own write comes back
  // through the watcher's 500ms debounce, by which point the buffer has
  // almost always moved on. Not $state -- nothing renders from it.
  let onDisk = "";
  let dirty = $state(false);
  let truncated = $state(false);
  let exists = $state(true);
  let error = $state<string | null>(null);
  let openError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  // Non-null while an external change is waiting on the user's choice;
  // holds their version of the content.
  let conflict = $state<string | null>(null);
  // The file was on disk and no longer is -- deleted, renamed or moved
  // while this editor held it open. Distinct from `!exists`, which is the
  // ordinary "not created yet" state of the PRD and agent-file hub tabs.
  let deleted = $state(false);

  // Gates the editor's first render: CodeMirrorView takes `doc` as
  // INITIAL content only, so mounting it before the first read resolves
  // would leave an editor holding "" with no path back to the real file.
  let loaded = $state(false);
  let editor = $state<{
    setDoc: (t: string) => void;
    measure: () => void;
    format: (action: FormatAction) => void;
  } | null>(null);
  let unlisten: UnlistenFn | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const editable = $derived(canEdit({ truncated, error }));
  const availableModes = $derived(modesFor(path));
  // Never leave the user stranded in Edit on a file that can't be edited.
  const effectiveMode = $derived<EditorMode>(mode === "edit" && !editable ? "plain" : mode);
  // The formatting bar belongs to markdown in Edit and nowhere else: a
  // .rs file has no bold, and Plain is read-only by definition.
  const showFormatBar = $derived(isMarkdown(path) && effectiveMode === "edit");

  const rendered = $derived.by(() => {
    if (error !== null || effectiveMode !== "formatted") return "";
    // Renders the BUFFER, so preview reflects unsaved edits.
    return DOMPurify.sanitize(renderMarkdown(buffer));
  });

  export function measure(): void {
    editor?.measure();
  }

  // Lets an outside writer (the plan metadata panel) land the buffer
  // before it rewrites one frontmatter line of the same file -- without
  // this, the panel's write trips the external-change conflict banner
  // against the user's own unsaved edits.
  export async function flush(): Promise<void> {
    await save();
  }

  async function load(): Promise<void> {
    try {
      const result = await backend.readFileForViewer(path);
      buffer = result.content;
      onDisk = result.content;
      truncated = result.truncated;
      exists = result.exists;
      deleted = false;
      error = null;
      setDirty(false);
      editor?.setDoc(result.content);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loaded = true;
    }
  }

  function setDirty(next: boolean): void {
    dirty = next;
    setPathDirty(path, next);
  }

  function handleChange(value: string): void {
    buffer = value;
    setDirty(true);
    // Autosave stays suspended while a conflict is unresolved -- else the
    // next keystroke would silently overwrite the change the banner is
    // warning about -- and while the file is deleted, where it would
    // silently recreate the file someone just removed.
    if (conflict !== null || deleted) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  async function save(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!editable || !dirty) return;
    const written = buffer;
    // Claimed BEFORE the await, not after: the watcher event for this
    // write can outrun the invoke's own resolution, and an echo that
    // arrives while `onDisk` still names the previous content is exactly
    // the false conflict this tracking exists to stop. If the write then
    // fails, `onDisk` is optimistic -- correctly so, since the next event
    // reads back content we did not put there and reports the divergence.
    onDisk = written;
    try {
      await backend.writeFileForEditor(path, written);
      saveError = null;
      exists = true;
      // Only clean if the buffer is still what we wrote. A keystroke
      // landing during the write re-arms the autosave timer, and clearing
      // the flag unconditionally made that timer no-op on `!dirty` --
      // stranding those characters until the next edit, and letting
      // onDestroy skip them entirely on a tab close.
      if (buffer === written) setDirty(false);
    } catch (e) {
      saveError = String(e instanceof Error ? e.message : e);
    }
  }

  // Cmd+S during a conflict means "keep mine": resolve, then write. On a
  // deleted file it means "put it back", same as the banner's button.
  function saveNow(): void {
    conflict = null;
    if (deleted) {
      restore();
      return;
    }
    void save();
  }

  function switchMode(next: EditorMode): void {
    if (mode === "edit" && next !== "edit") void save();
    mode = next;
    onModeChange?.(next);
  }

  function keepMine(): void {
    conflict = null;
    void save();
  }

  // Writing a deleted file back is always an explicit act -- never
  // autosave. setDirty first because save() no-ops on a clean buffer, and
  // after a delete the buffer usually IS clean.
  function restore(): void {
    deleted = false;
    setDirty(true);
    void save();
  }

  function takeTheirs(): void {
    const theirs = conflict ?? "";
    conflict = null;
    buffer = theirs;
    setDirty(false);
    editor?.setDoc(theirs);
  }

  async function openExternally(): Promise<void> {
    try {
      openError = null;
      await backend.openPathExternally(path);
    } catch (e) {
      openError = String(e instanceof Error ? e.message : e);
    }
  }

  async function handleExternalChange(): Promise<void> {
    let result: Awaited<ReturnType<typeof backend.readFileForViewer>>;
    try {
      result = await backend.readFileForViewer(path);
    } catch {
      // A transient read failure mid-write is not worth a banner; the
      // next event re-reads.
      return;
    }
    if (classifyExternalRead({ existsNow: result.exists, existedBefore: exists }) === "deleted") {
      // NEVER reload this as "the file is now empty": the buffer on
      // screen is the only copy left. Autosave stops too (handleChange),
      // so nothing recreates the file behind the human's back.
      deleted = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      return;
    }
    // Back on disk (restored, or a rename landed back on this path), or
    // still uncreated -- either way this is an ordinary read again.
    deleted = false;
    truncated = result.truncated;
    exists = result.exists;
    const verdict = resolveExternalChange({ incoming: result.content, buffer, onDisk, dirty });
    // Whatever we do about it, the read just told us what is on disk --
    // so a repeat event carrying the same content is no longer news.
    onDisk = result.content;
    switch (verdict) {
      case "ignore":
        return;
      case "reload":
        buffer = result.content;
        setDirty(false);
        editor?.setDoc(result.content);
        return;
      case "conflict":
        conflict = result.content;
        return;
    }
  }

  // The only thing that moves a MOUNTED editor's path is a rename of the
  // file it is holding: the Files tab renames on disk and then retargets
  // every tab and pane pointing at the old path.
  //
  // Following the move in place, rather than letting the host remount on
  // a new path, is what makes that safe. A remount runs onDestroy, whose
  // last-chance write would land on the path that has just stopped
  // existing -- resurrecting the file the human renamed away, with the
  // unsaved buffer inside it. So the buffer, its dirty flag and the mode
  // all stay put; only the watch and the dirty-path bookkeeping move.
  //
  // Plain `let`, not $state: it is read inside the effect that writes it,
  // and the initial value is exactly what is wanted -- the effect below
  // is what tracks every later one.
  // svelte-ignore state_referenced_locally
  let watchedPath = path;
  $effect(() => {
    const next = path;
    if (next === watchedPath) return;
    const previous = watchedPath;
    watchedPath = next;
    // The pending autosave was aimed at the old path's content; the one
    // re-armed below writes the same buffer to the new one.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    setPathDirty(previous, false);
    setPathDirty(next, dirty);
    void backend.unwatchFileForViewer(previous).catch(() => {});
    void backend.watchFileForViewer(next).catch(() => {});
    // A rename moves the file whole, so what sits at the new path is
    // what `onDisk` already holds -- there is nothing to re-read, and
    // re-reading would throw away a dirty buffer.
    deleted = false;
    exists = true;
    if (dirty) saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
  });

  onMount(async () => {
    await load();
    await backend.watchFileForViewer(path).catch(() => {});
    unlisten = await listen<string>("file-changed", (event) => {
      if (event.payload === path) void handleExternalChange();
    });
  });

  onDestroy(() => {
    unlisten?.();
    // Fire-and-forget: the component is going away, but an unsaved
    // buffer must still reach disk. Autosave caps the loss at ~1s anyway.
    // Never for a deleted file -- closing the tab would resurrect it.
    if (dirty && editable && !deleted) void backend.writeFileForEditor(path, buffer).catch(() => {});
    setPathDirty(path, false);
    if (saveTimer) clearTimeout(saveTimer);
    void backend.unwatchFileForViewer(path).catch(() => {});
  });
</script>

<div class="pane" class:document={layout === "document"}>
  <div class="modes">
    {#if showFormatBar}
      <MarkdownToolbar onFormat={(action) => editor?.format(action)} />
    {/if}
    <div class="segments">
      {#each availableModes as m (m)}
        <button
          type="button"
          class:active={effectiveMode === m}
          disabled={m === "edit" && !editable}
          title={m === "edit" && !editable ? "This file can't be edited" : ""}
          onclick={() => switchMode(m)}
        >
          {m === "formatted" ? "Formatted" : m === "plain" ? "Plain" : "Edit"}
        </button>
      {/each}
      {#if dirty}
        <span class="dirty" title="Unsaved changes">●</span>
      {/if}
    </div>
  </div>

  {#if conflict !== null}
    <div class="notice error">
      This file changed on disk while you were editing.
      <button onclick={keepMine}>Keep mine</button>
      <button onclick={takeTheirs}>Take theirs</button>
    </div>
  {/if}
  {#if deleted}
    <div class="notice error">
      This file was deleted on disk. Your copy is still here and nothing will be written back
      unless you say so.
      <button onclick={restore}>Save it back</button>
    </div>
  {/if}
  {#if saveError !== null}
    <div class="notice error">Couldn't save: {saveError}</div>
  {/if}
  {#if openError !== null}
    <div class="notice error">Couldn't open externally: {openError}</div>
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
        This file is too large to preview in full — showing the first part only, and editing is
        disabled so saving can't truncate it.
        <button onclick={openExternally}>Open externally</button>
      </div>
    {/if}
    {#if !exists && !deleted}
      <div class="notice">This file doesn't exist yet — saving will create it.</div>
    {/if}
    {#if effectiveMode === "formatted"}
      <div class="markdown"><div class="prose">{@html rendered}</div></div>
    {:else if loaded}
      <div class="editor">
        <CodeMirrorView
          bind:this={editor}
          doc={buffer}
          {path}
          readOnly={effectiveMode !== "edit"}
          onChange={handleChange}
          onSave={saveNow}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  .pane {
    width: 100%;
    height: 100%;
    background: var(--surface-base);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }
  /* One strip: the formatting bar (markdown in Edit only) at the left,
     the mode switch at the right. Wrapping, so a narrow split pane puts
     the switch on a second row rather than clipping the bar. */
  .modes {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px 8px;
    padding: 4px 8px;
    justify-content: flex-end;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .segments {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .segments button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .segments button.active {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .segments button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .dirty {
    color: var(--warning-text);
    font-size: 0.7em;
    margin-left: 4px;
  }
  .editor {
    flex: 1 1 auto;
    min-height: 0;
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
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.85em;
    flex: 0 0 auto;
  }
  .notice button {
    margin-top: 0;
    padding: 4px 10px;
  }
  .notice.error {
    background: var(--surface-danger);
    color: var(--danger-text);
  }
  .markdown {
    flex: 1 1 auto;
    overflow: auto;
    padding: 16px 20px;
    max-width: 900px;
    line-height: 1.6;
    -webkit-user-select: text;
    user-select: text;
    /* Prose reads better proportional; the app is otherwise monospace.
       Code blocks inside stay monospace via the :global(code) rule below. */
    font-family: sans-serif;
  }
  /* Document layout. The scroll container keeps the whole pane -- so its
     bar sits at the pane's edge and a click anywhere lands in the text --
     and only the column the text occupies is capped and centred. A4 is
     794px at 96dpi; the column is 800px INCLUDING its side gutters, so
     the measure is 720px, and the editor's lines wrap at that same 720px
     so that switching modes does not re-flow the text. */
  .document {
    --document-column: 800px;
    --document-gutter: 40px;
  }
  .document .markdown {
    max-width: none;
    padding: 0;
  }
  .document .prose {
    box-sizing: border-box;
    max-width: var(--document-column);
    margin: 0 auto;
    padding: 24px var(--document-gutter) 48px;
    /* 14px against the 16px a file tab's Formatted view inherits: prose
       at the app's chrome scale rather than the browser's reading one. */
    font-size: 0.875em;
  }
  /* CodeMirror lays the line-number gutter and the content out as a
     flex row inside its scroller. Auto margins on the row's two ends
     absorb the free width equally, so the pair is centred as one block;
     the content's cap is what makes there be free width at all. */
  .document .editor :global(.cm-gutters) {
    margin-left: auto;
  }
  .document .editor :global(.cm-content) {
    max-width: calc(var(--document-column) - 2 * var(--document-gutter));
    margin-right: auto;
  }
  .markdown :global(pre) {
    background: var(--surface-raised);
    padding: 10px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .markdown :global(code) {
    font-family: monospace;
    font-size: 0.9em;
  }
  .markdown :global(a) {
    color: var(--accent-text);
  }
  .markdown :global(table) {
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 4px 8px;
  }
</style>
