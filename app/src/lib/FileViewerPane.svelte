<script lang="ts">
  import FileEditor from "$lib/FileEditor.svelte";
  import { defaultMode } from "$lib/fileEditing";

  let { path, visible }: { path: string; visible: boolean } = $props();

  let editor = $state<{ measure: () => void } | null>(null);

  // Pane.svelte's fitAll() calls fit() on every tab in a pane, terminal
  // or not. CodeMirror measures itself on mount, so a tab mounted while
  // hidden would render at zero height -- both this and the visibility
  // effect below exist to re-measure once it can actually be seen.
  export function fit(): void {
    editor?.measure();
  }

  $effect(() => {
    if (visible) editor?.measure();
  });
</script>

<div class="pane" class:inactive={!visible}>
  <FileEditor bind:this={editor} {path} initialMode={defaultMode(path, "tab")} />
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: var(--surface-base);
    color: var(--text);
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
</style>
