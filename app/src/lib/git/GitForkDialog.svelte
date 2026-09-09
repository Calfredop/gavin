<script lang="ts">
  import Modal from "$lib/Modal.svelte";
  import ConfigTrustNotice from "$lib/ConfigTrustNotice.svelte";
  import {
    gitStore,
    ensureGitView,
    forkWorktree,
    refresh as refreshGit,
    switchWorktree,
    rootPathOf,
  } from "$lib/git/gitState";
  import { gavinTrees, worktreeSetups } from "$lib/gavinState";
  import { configTrusts } from "$lib/layoutState";
  import { showAlert } from "$lib/dialog";
  import { defaultWorktreePath, validateBranchName } from "$lib/git/git";
  import { setupPlan, setupNotice } from "$lib/git/worktreeSetup";

  interface Props {
    workspaceId: string;
    /// The workspace's resolved agent command (same resolution as Home).
    agentCommand: string;
    /// Runs one command line in a visible session in the NEW worktree.
    /// Named for the session rather than for the agent because the line it
    /// is handed is the workspace's `[worktree] setup` with the agent
    /// chained onto the end — every caller has to provide it, including
    /// the ones that never offer to start an agent, or their worktree gets
    /// no setup.
    onRunInWorktree: (path: string, command: string) => void;
    onClose: () => void;
    /// Called with the created worktree's path. Set by callers that want
    /// the worktree for something other than starting an agent in it --
    /// an orchestration rail binding, for instance. AWAITED before the
    /// setup session is opened: a rail that is told about its worktree
    /// first gets the page that session lands on opened in the worktree
    /// too, rather than in the workspace root.
    onPicked?: (path: string) => void | Promise<void>;
    /// Offer "Start agent here". Off for rail binding: the rail's own
    /// Start is what launches agents there.
    allowSpawn?: boolean;
    /// Repoint the whole Git tab at the new worktree. Off for rail
    /// binding -- creating a rail's fork should not move the user's Git
    /// tab out from under them.
    switchAfter?: boolean;
    /// What the branch field opens with. Set by callers that already
    /// know what this worktree is FOR -- a rail binding seeds its rail's
    /// name -- so the folder default, which follows the branch, lands on
    /// something meaningful too. Read once at mount: the dialog is
    /// created fresh each time it is opened, and after that the field
    /// belongs to whoever is typing in it.
    branchSeed?: string;
  }
  let {
    workspaceId,
    agentCommand,
    onRunInWorktree,
    onClose,
    onPicked,
    allowSpawn = true,
    switchAfter = true,
    branchSeed = "",
  }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const root = $derived(view ? rootPathOf(view) : "");
  const localBranches = $derived(view?.refs?.branches.map((b) => b.name) ?? []);
  const checkedOut = $derived(new Set((view?.refs?.worktrees ?? []).map((w) => w.branch).filter((b): b is string => b !== null)));
  const freeBranches = $derived(localBranches.filter((b) => !checkedOut.has(b)));
  const currentHead = $derived(view?.refs?.headBranch ?? null);

  let mode = $state<"new" | "existing">("new");
  let branch = $state(branchSeed);
  let existing = $state("");
  let from = $state("HEAD");
  let folder = $state("");
  let folderTouched = $state(false);
  let startAgent = $state(true);
  let submitting = $state(false);
  /// What git said about the last Create press. Shown HERE rather than
  /// left to the Git tab's error banner: two of this dialog's three
  /// callers open it from a surface that banner is not on, which turned
  /// every refusal into a button that did nothing.
  let submitError = $state<string | null>(null);

  /// The workspace's `[worktree] setup`. Read off disk by the host, not
  /// fetched from the daemon, so a workspace whose daemon is mid-upgrade
  /// still gets its worktrees set up. `.gavin-root` sits at the WORKSPACE
  /// root, which is not always the git toplevel this dialog forks from.
  const gavinRoot = $derived($gavinTrees[workspaceId]?.rootPath ?? "");

  // The Git tab may never have been opened in this workspace -- a rail's
  // bind dialog and a card both reach this one without it -- and with no
  // view every mutation below is refused before it reaches git. Only
  // when there is none: `ensureGitView` resets a view whose cwd differs,
  // and the Git tab's own switcher opens this dialog pointed at whatever
  // worktree the human last chose. Reading the store makes this an HMR
  // repair too: re-executing gitState.ts empties it under an open
  // dialog, and the effect puts a view back.
  $effect(() => {
    if (!gavinRoot || $gitStore[workspaceId]) return;
    ensureGitView(workspaceId, gavinRoot);
    void refreshGit(workspaceId);
  });

  // Off the shared store rather than a read of its own: this is the copy
  // workspace trust hashed, so the line shown here cannot differ from the
  // one the new worktree runs.
  const setup = $derived($worktreeSetups[workspaceId] ?? []);
  const trust = $derived($configTrusts(workspaceId));

  /// What the new worktree's one session will run. Null means nothing is
  /// to be run and no session should open at all.
  const plan = $derived(
    setupPlan(setup, allowSpawn && startAgent ? agentCommand : null, trust.trusted)
  );

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

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /// A failure AFTER the worktree exists and this dialog has closed
  /// itself. There is no dialog left to put it in, and it must not be
  /// dropped: an alert is the only surface every caller shares. Fire and
  /// forget on purpose -- the setup session below must not wait behind a
  /// modal the human may not be at the keyboard for.
  function reportAfterCreate(path: string, what: string, e: unknown): void {
    void showAlert({
      title: "The worktree was created, but the step after it failed",
      lines: [path, `${what}: ${messageOf(e)}`],
    });
  }

  async function submit(): Promise<void> {
    if (!valid) return;
    submitting = true;
    submitError = null;
    const path = folder.trim();
    // Captured before the awaits below unmount this component: what the
    // human agreed to is the plan as it stood when they pressed Create.
    const run = plan;
    const forked = await forkWorktree(workspaceId, {
      path,
      branch: effectiveBranch,
      from: mode === "new" && from !== "HEAD" ? from : null,
      newBranch: mode === "new",
    });
    submitting = false;
    // Keep the dialog AND say why. This used to delegate to the Git
    // tab's error banner, which only one of the three callers has on
    // screen -- and a refusal with no view to file itself in said
    // nothing anywhere at all.
    if (!forked.ok) {
      submitError = forked.error;
      return;
    }
    onClose();
    // Everything below runs after the close, so each step is guarded
    // separately: a rejection here has no dialog left to show it, and
    // `void submit()` dropped it silently. The setup session is the one
    // thing that outlives this dialog, and a binding that failed must
    // not take it down with it.
    if (switchAfter) {
      try {
        await switchWorktree(workspaceId, path);
      } catch (e) {
        reportAfterCreate(path, "Couldn't point the Git tab at it", e);
      }
    }
    try {
      await onPicked?.(path);
    } catch (e) {
      reportAfterCreate(path, "Couldn't bind it to what asked for it", e);
    }
    // Last, and after the binding above has landed: the session is the
    // one thing here that outlives this dialog.
    if (run) onRunInWorktree(path, run.line);
  }

  /// A form handler can only `void` a promise, and what that did with a
  /// rejection was drop it -- the reason a fork that threw after the
  /// worktree existed read as a button that had done nothing. Nothing in
  /// `submit` should reject any more; this is the backstop that makes
  /// sure the next thing that does is still said out loud.
  function onFormSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void submit().catch((e) => {
      submitting = false;
      void showAlert({ title: "Couldn't create the worktree", lines: [messageOf(e)] });
    });
  }
</script>

<Modal onClose={onClose}>
  <form class="fork" onsubmit={onFormSubmit}>
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

    {#if allowSpawn}
      <label class="check">
        <input type="checkbox" bind:checked={startAgent} />
        Start agent here <span class="cmd">({agentCommand})</span>
      </label>
    {/if}

    <!-- Above the setup notice, because when the config is unapproved
         that notice is ABSENT: the human would otherwise cut a worktree
         believing the repo declared no setup. -->
    <ConfigTrustNotice {workspaceId} />

    <!-- Only where setup was actually declared: a plan carrying nothing
         but the agent command would just repeat the checkbox above it. -->
    {#if plan && plan.commands > 0}
      <div class="setup">
        <span>{setupNotice(plan)}</span>
        <code>{plan.line}</code>
      </div>
    {/if}

    <!-- git's own refusal, in the dialog that asked for it. -->
    {#if submitError}<div class="err" role="alert">{submitError}</div>{/if}

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
  .setup {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.78em;
    color: var(--text-muted);
    /* Both min-widths: a flex item's floor is its min-content width, and
       an unbroken command line's min-content width is the whole line. */
    min-width: 0;
  }
  .setup code {
    /* block, not inline: overflow does nothing to an inline box, so an
       inline <code> would widen the modal instead of scrolling. */
    display: block;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    padding: 5px 8px;
    /* The line is shown verbatim, and a long one must not widen the
       modal past the fields above it. */
    overflow-x: auto;
    white-space: pre;
    min-width: 0;
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
