<script lang="ts">
  import { onDestroy } from "svelte";
  import { createEditor, type EditorHandle } from "$lib/codeMirror";
  import type { FormatAction } from "$lib/markdownFormatting";
  import { themeState } from "$lib/ui/themeState.svelte";

  interface Props {
    // Initial content only: once mounted, the EDITOR owns the buffer.
    // Pushing `doc` back in on every change would fight the cursor --
    // the parent uses setDoc() for deliberate reloads instead.
    doc: string;
    path: string;
    readOnly: boolean;
    onChange: (value: string) => void;
    onSave: () => void;
  }
  let { doc, path, readOnly, onChange, onSave }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  // $state, not a plain let: the readOnly effect below must re-run once
  // the async mount resolves, otherwise a mode switch made while the
  // language pack was still loading is silently lost.
  let handle = $state<EditorHandle | null>(null);
  let destroyed = false;
  // Content handed to setDoc before the editor existed. Applied the
  // moment it does, so a reload or conflict resolution can never be
  // swallowed by a slow dynamic import.
  let pendingDoc: string | null = null;

  export function setDoc(text: string): void {
    if (handle) {
      handle.setDoc(text);
    } else {
      pendingDoc = text;
    }
  }

  export function measure(): void {
    handle?.measure();
  }

  export function format(action: FormatAction): void {
    handle?.format(action);
  }

  $effect(() => {
    if (!host || handle) return;
    const parent = host;
    const opts = { parent, doc, path, readOnly, theme: themeState.effective, onChange, onSave };
    void createEditor(opts).then((created) => {
      // The component may have been destroyed while the language pack
      // was still loading.
      if (destroyed) {
        created.destroy();
        return;
      }
      handle = created;
      if (pendingDoc !== null) {
        created.setDoc(pendingDoc);
        pendingDoc = null;
      }
    });
  });

  // Mode switches reconfigure the live editor rather than remounting it,
  // so scroll position and undo history survive.
  $effect(() => {
    const ro = readOnly;
    handle?.setReadOnly(ro);
  });

  // Same reconfigure-don't-remount rule for the theme.
  $effect(() => {
    const t = themeState.effective;
    handle?.setTheme(t);
  });

  onDestroy(() => {
    destroyed = true;
    handle?.destroy();
    handle = null;
  });
</script>

<div class="cm-host" bind:this={host}></div>

<style>
  .cm-host {
    height: 100%;
    overflow: hidden;
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
    font-size: 0.85em;
    /* Opt back out of the app-wide user-select: none -- editor text
       must stay selectable (and WebKit gates contenteditable on it). */
    -webkit-user-select: text;
    user-select: text;
  }
  .cm-host :global(.cm-scroller) {
    font-family: monospace;
  }
</style>
