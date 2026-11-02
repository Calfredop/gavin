<script lang="ts">
  /// The last resort when gavin's own search for `npx` (`npx.rs`: PATH,
  /// the usual Node.js install places, the login shell) found nothing:
  /// the human tells it where. Mounted only on that final failure
  /// (`npxLocate.ts`), never as a setting someone has to think about
  /// first. The host checks the path runs before keeping it.
  import * as backend from "$lib/core/backend";
  import { currentPlatform } from "$lib/core/platform";
  import { npxPathProblem, whereCommand, type NpxReport } from "$lib/agents/npxLocate";

  interface Props {
    /// The path was kept and runs; the caller re-checks or retries.
    onSaved: (report: NpxReport) => void;
  }
  let { onSaved }: Props = $props();

  let path = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);
  const lookup = whereCommand(currentPlatform() === "windows");

  async function save(): Promise<void> {
    const problem = npxPathProblem(path);
    if (problem) {
      error = problem;
      return;
    }
    saving = true;
    error = null;
    try {
      onSaved(await backend.setNpxPath(path.trim()));
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="npx-path">
  <p class="note">
    If npx works in your terminal, run <code>{lookup}</code> there and paste the path it prints:
  </p>
  <div class="field">
    <input
      type="text"
      bind:value={path}
      placeholder="/path/to/npx"
      spellcheck="false"
      autocomplete="off"
      aria-label="Path to npx"
      onkeydown={(e) => {
        if (e.key === "Enter") void save();
      }}
    />
    <button type="button" disabled={saving} onclick={() => void save()}>
      {saving ? "Checking…" : "Use this npx"}
    </button>
  </div>
  {#if error}
    <p class="warn">{error}</p>
  {/if}
</div>

<style>
  .npx-path {
    margin-top: 10px;
    font-family: monospace;
    font-size: 0.8em;
  }
  .note {
    margin: 0 0 6px;
    color: var(--text-subtle);
  }
  .note code {
    color: var(--text-muted);
  }
  .field {
    display: flex;
    gap: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 5px 8px;
    font-family: monospace;
    font-size: 1em;
  }
  button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
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
    margin: 6px 0 0;
    color: var(--warning-text);
  }
</style>
