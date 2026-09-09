<script lang="ts">
  // The hub tab row's window button: gives the workspace you are looking
  // at a window of its own, and afterwards is the way back to it.
  //
  // It sits before the "New page" +, which is the other thing on that row
  // that acts on the workspace as a whole rather than on what is inside
  // it. A thin template over appWindow.ts and layoutState's
  // handOffWorkspace -- every rule about where a workspace may be lives
  // there, not here.
  import { AppWindow } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tooltip } from "$lib/tooltip";
  import { layoutState, handOffWorkspace } from "$lib/layoutState";
  import { getActiveWorkspace } from "$lib/workspace";
  import { windowActionLabel } from "$lib/shell/appWindow";
  import { currentWindowLabel, workspaceWindows } from "$lib/shell/appWindowState";

  const activeWorkspace = $derived(getActiveWorkspace($layoutState));
  // `null` means there is nothing to offer -- this window IS that
  // workspace's window -- and the button withdraws rather than sitting
  // there doing nothing. Disabled would be worse: a tab row that keeps a
  // dead control is a row you stop reading.
  const label = $derived(
    activeWorkspace
      ? windowActionLabel($workspaceWindows, activeWorkspace.id, currentWindowLabel())
      : "Open in New Window"
  );
</script>

<!-- The tooltip hangs on the wrapper for the reason NewPageButton's does:
     a disabled element fires no mouseenter, so the button could never
     explain why it is disabled from the button itself. -->
{#if label}
  <span
    class="open-in-window"
    use:tooltip={activeWorkspace ? "" : "Open a workspace to give it a window"}
  >
    <IconButton
      icon={AppWindow}
      {label}
      size={14}
      disabled={!activeWorkspace}
      onclick={() => {
        if (activeWorkspace) void handOffWorkspace(activeWorkspace.id);
      }}
    />
  </span>
{/if}

<style>
  /* Inline-flex, not the default inline: the wrapper exists only to carry
     the tooltip, and must measure exactly like the button. */
  .open-in-window {
    display: inline-flex;
  }
</style>
