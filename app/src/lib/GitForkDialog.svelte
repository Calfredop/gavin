<script lang="ts">
  import Modal from "./Modal.svelte";
  import { gitStore, forkWorktree, switchWorktree, rootPathOf } from "./gitState";
  import { defaultWorktreePath, validateBranchName } from "./git";

  interface Props {
    workspaceId: string;
    /// The workspace's resolved agent command (same resolution as Home).
    agentCommand: string;
    onSpawnAgent: (path: string, command: string) => void;
    onClose: () => void;
  }
  let { workspaceId, agentCommand, onSpawnAgent, onClose }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const root = $derived(view ? rootPathOf(view) : "");
  const localBranches = $derived(view?.refs?.branches.map((b) => b.name) ?? []);
  const checkedOut = $derived(new Set((view?.refs?.worktrees ?? []).map((w) => w.branch).filter((b): b is string => b !== null)));
  const freeBranches = $derived(localBranches.filter((b) => !checkedOut.has(b)));
  const currentHead = $derived(view?.refs?.headBranch ?? null);

  let mode = $state<"new" | "existing">("new");
  let branch = $state("");
  let existing = $state("");
  let from = $state("HEAD");
  let folder = $state("");
  let folderTouched = $state(false);
  let startAgent = $state(true);
  let submitting = $state(false);

  // The folder follows the branch name until the user edits it (G11).
  const effectiveBranch = $derived(mode === "new" ? branch : existing);
  $effect(() => {
    if (!folderTouched && root) folder = effectiveBranch ? defaultWorktreePath(root, effectiveBranch) : "";
  });
  $effect(() => {
    if (mode === "existing" && !existing && freeBranches.length > 0) existing = freeBranches[0];
  });

  const branchError = $derived.by(() => {
    if (mode === "existing") return existing ? null : "No free branch — every local branch is already checked out somewhere";
    const v = validateBranchName(branch);
    if (v) return v;
    if (localBranches.includes(branch)) return "Branch exists — switch to “existing branch” mode";
    return null;
  });
  const folderError = $derived(folder.trim() ? null : "Folder is required");
  const valid = $derived(!branchError && !folderError && !submitting);

  async function submit(): Promise<void> {
    if (!valid) return;
    submitting = true;
    const path = folder.trim();
    const ok = await forkWorktree(workspaceId, {
      path,
      branch: effectiveBranch,
      from: mode === "new" && from !== "HEAD" ? from : null,
      newBranch: mode === "new",
    });
    submitting = false;
    if (!ok) return; // the error banner shows git's message; keep the dialog
    onClose();
    await switchWorktree(workspaceId, path);
    if (startAgent) onSpawnAgent(path, agentCommand);
  }
</script>

<Modal onClose={onClose}>
  <form class="fork" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <h3>New worktree</h3>

    <div class="mode" role="radiogroup" aria-label="Branch mode">
      <button type="button" class:on={mode === "new"} role="radio" aria-checked={mode === "new"} onclick={() => (mode = "new")}>New branch</button>
      <button type="button" class:on={mode === "existing"} role="radio" aria-checked={mode === "existing"} onclick={() => (mode = "existing")}>Existing branch</button>
    </div>

    {#if mode === "new"}
      <label class="field">
        <span>Branch name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" bind:value={branch} placeholder="feature/thing" autofocus />
      </label>
      <label class="field">
        <span>From</span>
        <select bind:value={from}>
          <option value="HEAD">current HEAD{currentHead ? ` (${currentHead})` : ""}</option>
          {#each localBranches as b (b)}
            <option value={b}>{b}</option>
          {/each}
        </select>
      </label>
    {:else}
      <label class="field">
        <span>Branch</span>
        <select bind:value={existing}>
          {#each freeBranches as b (b)}
            <option value={b}>{b}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if branchError}<div class="err">{branchError}</div>{/if}

    <label class="field">
      <span>Folder</span>
      <input type="text" bind:value={folder} oninput={() => (folderTouched = true)} placeholder={root ? defaultWorktreePath(root, "branch") : ""} />
    </label>
    {#if folderError && folderTouched}<div class="err">{folderError}</div>{/if}

    <label class="check">
      <input type="checkbox" bind:checked={startAgent} />
      Start agent here <span class="cmd">({agentCommand})</span>
    </label>

    <div class="actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="submit" class="primary" disabled={!valid}>{submitting ? "Creating…" : "Create worktree"}</button>
    </div>
  </form>
</Modal>

<style>
  .fork {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 380px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    color: var(--text);
  }
  .mode {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    align-self: flex-start;
  }
  .mode button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.85em;
    padding: 3px 10px;
    cursor: pointer;
  }
  .mode button.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .field input,
  .field select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
  }
  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .err {
    color: var(--danger-text);
    font-size: 0.78em;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .cmd {
    color: var(--text-subtle);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .actions .primary {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .actions .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
