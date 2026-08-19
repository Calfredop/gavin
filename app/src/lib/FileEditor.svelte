<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import {
    canEdit,
    defaultMode,
    modesFor,
    resolveExternalChange,
    setPathDirty,
    type EditorMode,
  } from "./fileEditing";
  import CodeMirrorView from "./CodeMirrorView.svelte";
  import * as backend from "./backend";

  interface Props {
    path: string;
    initialMode?: EditorMode;
  }
  let { path, initialMode }: Props = $props();

  const AUTOSAVE_MS = 1000;

  let mode = $state<EditorMode>(initialMode ?? defaultMode(path, "tab"));
  let buffer = $state("");
  let dirty = $state(false);
  let truncated = $state(false);
  let exists = $state(true);
  let error = $state<string | null>(null);
  let openError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  // Non-null while an external change is waiting on the user's choice;
  // holds their version of the content.
  let conflict = $state<string | null>(null);

  // Gates the editor's first render: CodeMirrorView takes `doc` as
  // INITIAL content only, so mounting it before the first read resolves
  // would leave an editor holding "" with no path back to the real file.
  let loaded = $state(false);
  let editor = $state<{ setDoc: (t: string) => void; measure: () => void } | null>(null);
  let unlisten: UnlistenFn | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const editable = $derived(canEdit({ truncated, error }));
  const availableModes = $derived(modesFor(path));
  // Never leave the user stranded in Edit on a file that can't be edited.
  const effectiveMode = $derived<EditorMode>(mode === "edit" && !editable ? "plain" : mode);

  const rendered = $derived.by(() => {
    if (error !== null || effectiveMode !== "formatted") return "";
    // Renders the BUFFER, so preview reflects unsaved edits.
    return DOMPurify.sanitize(marked.parse(buffer, { async: false }) as string);
  });

  export function measure(): void {
    editor?.measure();
  }

  async function load(): Promise<void> {
    try {
      const result = await backend.readFileForViewer(path);
      buffer = result.content;
      truncated = result.truncated;
      exists = result.exists;
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
    // warning about.
    if (conflict !== null) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  async function save(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!editable || !dirty) return;
    try {
      await backend.writeFileForEditor(path, buffer);
      saveError = null;
      exists = true;
      setDirty(false);
    } catch (e) {
      saveError = String(e instanceof Error ? e.message : e);
    }
  }

  // Cmd+S during a conflict means "keep mine": resolve, then write.
  function saveNow(): void {
    conflict = null;
    void save();
  }

  function switchMode(next: EditorMode): void {
    if (mode === "edit" && next !== "edit") void save();
    mode = next;
  }

  function keepMine(): void {
    conflict = null;
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
      await openPath(path);
    } catch (e) {
      openError = String(e instanceof Error ? e.message : e);
    }
  }

  async function handleExternalChange(): Promise<void> {
    let incoming: string;
    try {
      const result = await backend.readFileForViewer(path);
      incoming = result.content;
      truncated = result.truncated;
      exists = result.exists;
    } catch {
      // A transient read failure mid-write is not worth a banner; the
      // next event re-reads.
      return;
    }
    switch (resolveExternalChange({ incoming, buffer, dirty })) {
      case "ignore":
        return;
      case "reload":
        buffer = incoming;
        setDirty(false);
        editor?.setDoc(incoming);
        return;
      case "conflict":
        conflict = incoming;
        return;
    }
  }

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
    if (dirty && editable) void backend.writeFileForEditor(path, buffer).catch(() => {});
    setPathDirty(path, false);
    if (saveTimer) clearTimeout(saveTimer);
    void backend.unwatchFileForViewer(path).catch(() => {});
  });
</script>

<div class="pane">
  <div class="modes">
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

  {#if conflict !== null}
    <div class="notice error">
      This file changed on disk while you were editing.
      <button onclick={keepMine}>Keep mine</button>
      <button onclick={takeTheirs}>Take theirs</button>
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
    {#if !exists}
      <div class="notice">This file doesn't exist yet — saving will create it.</div>
    {/if}
    {#if effectiveMode === "formatted"}
      <div class="markdown">{@html rendered}</div>
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
    background: #1e1e1e;
    color: #eee;
    display: flex;
    flex-direction: column;
  }
  .modes {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    justify-content: flex-end;
    flex: 0 0 auto;
    border-bottom: 1px solid #2f2f2f;
  }
  .modes button {
    background: transparent;
    border: 1px solid transparent;
    color: #999;
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .modes button.active {
    background: #333;
    color: #eee;
  }
  .modes button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .dirty {
    color: #d9a648;
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
    flex: 0 0 auto;
  }
  .notice button {
    margin-top: 0;
    padding: 4px 10px;
  }
  .notice.error {
    background: #3a2020;
    color: #e0a0a0;
  }
  .markdown {
    flex: 1 1 auto;
    overflow: auto;
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
