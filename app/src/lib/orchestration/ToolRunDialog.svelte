<script lang="ts">
  // The parameters a tool run was asked for, in one small modal. Drawn
  // once at the Tools tab's root and fed by workspaceToolsActions'
  // pending store, the way ReviewDialog is fed by codeReviewActions --
  // the tab's list re-renders under a search box, and a modal owned by a
  // row would go with the row.
  import Modal from "$lib/core/Modal.svelte";
  import { toolRunRequest, confirmToolRun, cancelToolRun } from "$lib/workspace/workspaceToolsActions";

  // A local copy of the request's seeds, so Cancel really cancels and a
  // second open starts from the tool's own defaults again rather than
  // from whatever the last run typed.
  let values = $state<Record<string, string>>({});
  let error = $state<string | null>(null);
  let running = $state(false);
  let seeded: string | null = null;

  $effect(() => {
    const request = $toolRunRequest;
    if (!request) {
      seeded = null;
      return;
    }
    // Seeded once per opening. Keyed on the tool id rather than on the
    // object, because `$state` proxies everything it touches and the
    // request would never be identity-equal to itself.
    if (seeded === request.tool.id) return;
    seeded = request.tool.id;
    values = { ...request.values };
    error = null;
    running = false;
  });

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    const failure = await confirmToolRun(values);
    running = false;
    error = failure;
  }
</script>

{#if $toolRunRequest}
  {@const request = $toolRunRequest}
  <Modal onClose={cancelToolRun}>
    <div class="tool-run">
      <header>
        <h3>{request.tool.name}</h3>
        {#if request.tool.description}
          <p class="desc">{request.tool.description}</p>
        {/if}
      </header>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      {#each request.tool.params as param (param.name)}
        <label>
          <span class="field">{param.label || param.name}</span>
          <input
            bind:value={values[param.name]}
            spellcheck="false"
            placeholder={param.default}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
          />
        </label>
      {/each}

      <!-- Which checkout is the question a human asks before pressing
           Run on something that commits, so the answer is on the dialog
           rather than a tooltip away. -->
      <p class="where">Runs in <code>{request.cwd}</code></p>

      <footer>
        <span class="spacer"></span>
        <button type="button" class="ghost" onclick={cancelToolRun}>Cancel</button>
        <button type="button" class="primary" disabled={running} onclick={() => void run()}>
          {running ? "Starting…" : "Run"}
        </button>
      </footer>
    </div>
  </Modal>
{/if}

<style>
  .tool-run {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 380px;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field {
    color: var(--text-muted);
    font-size: 11px;
  }
  input {
    padding: 5px 7px;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 12px;
  }
  .where {
    margin: 0;
    color: var(--text-muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .where code {
    font-size: 11px;
  }
  .error {
    margin: 0;
    padding: 6px 8px;
    background: var(--surface-danger);
    border: 1px solid var(--border-danger);
    border-radius: 5px;
    color: var(--danger-text);
    font-size: 12px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  footer button {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    font-size: 12px;
    cursor: pointer;
  }
  .ghost {
    background: var(--surface-raised);
    color: var(--text);
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg, #fff);
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
