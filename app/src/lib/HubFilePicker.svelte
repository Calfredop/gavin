<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";

  interface Props {
    /// The path this tab is editing, relative to the workspace root.
    /// Shown as-is: it is what config.toml holds, and a user comparing
    /// the tab against the file needs to see the same string.
    current: string;
    /// Absolute, and where the dialog opens.
    root: string;
    /// The OS dialog's title, e.g. "Choose the PRD file".
    title: string;
    /// Non-null disables the button and states why (a daemon too old to
    /// resolve the choice). Carried as a native `title` on the strip as
    /// well as the button: tooltip.ts binds mouseenter, which a disabled
    /// element never fires, and this tab is the wrong place for a
    /// permanent banner -- the Settings row states it in full.
    blockedReason?: string | null;
    /// Takes the absolute path the dialog returned and either commits it
    /// or returns the reason it cannot be used.
    onPick: (absolutePath: string) => Promise<string | null>;
  }
  let { current, root, title, blockedReason = null, onPick }: Props = $props();

  let error = $state<string | null>(null);
  let busy = $state(false);

  async function pick(): Promise<void> {
    error = null;
    busy = true;
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        defaultPath: root,
        title,
      });
      // A cancelled dialog is not an error, and must not clear the
      // message from the pick before it.
      if (typeof picked === "string") error = await onPick(picked);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="strip" title={blockedReason ?? undefined}>
  <!-- The &lrm; bookends are load-bearing — see .path below. -->
  <span class="path" title={`${root}/${current}`}>&lrm;{current}&lrm;</span>
  <button
    type="button"
    disabled={busy || Boolean(blockedReason)}
    title={blockedReason ?? "Point this tab at a file already in the repo"}
    onclick={() => void pick()}>Pick…</button
  >
</div>
{#if error}
  <p class="warn">{error}</p>
{/if}

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
    font-family: monospace;
    font-size: 0.75em;
    color: var(--text-subtle);
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Ellipsis on the LEFT, matching the root chip: a path's tail is its
       informative end. The &lrm; bookends keep the slashes inside the
       LTR run so a leading one doesn't detach and park on the right. */
    direction: rtl;
  }
  button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .warn {
    margin: 0;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.75em;
  }
</style>
