<script lang="ts">
  import { get } from "svelte/store";
  import { BrushCleaning, ChevronDown, FolderGit2, Play, GitMerge, Trash2, Plus, Eraser } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { worktreeStaleIndicator } from "$lib/ui/indicators";
  import {
    agentProfilesStore,
    createSessionForCard,
    agentModelDefaultsStore,
    layoutState,
    trustedAgentConfigs,
  } from "$lib/layoutState";
  import { allSessionIdsInWorkspace } from "$lib/workspace";
  import { orchestrations } from "$lib/orchestration/orchestrationState";
  import { resolveAgentConfig } from "$lib/settings";
  import { askConfirmChecked, showAlert } from "$lib/dialog";
  import {
    gitStore,
    rootPathOf,
    switchWorktree,
    mergeBack,
    removeWorktree,
    pruneWorktrees,
    sweepFacts,
    sweepWorktrees,
    dismissError,
    noteError,
  } from "$lib/git/gitState";
  import {
    classifyWorktrees,
    nothingToSweepLines,
    sweepConfirm,
    type SweepVerdict,
  } from "$lib/git/worktreeSweep";
  import { splitPath, type WorktreeInfo } from "$lib/git/git";
  import { tooltip } from "$lib/tooltip";
  import GitForkDialog from "$lib/git/GitForkDialog.svelte";
  import GitDiscardDialog from "$lib/git/GitDiscardDialog.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const worktrees = $derived(view?.refs?.worktrees ?? []);
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const rootPath = $derived(view ? rootPathOf(view) : "");
  const rootBranch = $derived(worktrees.find((w) => w.isMain)?.branch ?? "main");
  // Match on git's canonical toplevel, not on the cwd string we were given.
  const current = $derived(worktrees.find((w) => w.path === view?.repo?.root) ?? worktrees.find((w) => w.path === view?.cwd) ?? null);
  const anyPrunable = $derived(worktrees.some((w) => w.prunable));
  const agentCommand = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(workspaceId),
      $agentProfilesStore,
      $agentModelDefaultsStore
    ).launchCommand
  );

  // Every rail in the app, not only this workspace's: a rail is bound to
  // a PATH, and nothing stops a second workspace's rail pointing at a
  // fork of this repo. Sweeping a checkout out from under it would be
  // the same accident either way.
  const railBindings = $derived(
    Object.values($orchestrations)
      .flatMap((o) => o.rails)
      .flatMap((r) => (r.worktreePath ? [{ name: r.name, worktreePath: r.worktreePath }] : []))
  );
  // Same reasoning for sessions, and read off the LAYOUT rather than
  // cwdBySessionId directly: that map is never pruned, so a session that
  // closed an hour ago still has a cwd in it and would keep its worktree
  // alive forever.
  const sessionCwds = $derived(
    $layoutState.workspaces
      .flatMap((w) => allSessionIdsInWorkspace(w))
      .flatMap((id) => {
        const cwd = $layoutState.cwdBySessionId[id];
        return cwd ? [cwd] : [];
      })
  );

  let open = $state(false);
  let fork = $state(false);
  // What git said last time we asked: which branches have landed, and
  // which of these folders still hold uncommitted work. Null until the
  // menu has been opened once -- with nothing to go on, no row claims to
  // be stale, which is the right way round for a delete button.
  let facts = $state<{ merged: Set<string>; dirty: Set<string> } | null>(null);
  // Supersession guard, not an identity check: `facts` is a $state proxy,
  // so comparing what came back against what we sent is always unequal
  // (see the app's Svelte 5 notes). A counter is what actually says
  // whether a slower answer belongs to an older question.
  let factsToken = 0;
  const verdicts = $derived<SweepVerdict[]>(
    facts === null
      ? []
      : classifyWorktrees(worktrees, {
          base: rootBranch,
          merged: facts.merged,
          dirty: facts.dirty,
          rails: railBindings,
          sessionCwds,
        })
  );
  const staleCount = $derived(verdicts.filter((v) => v.stale).length);
  const staleByPath = $derived(new Set(verdicts.filter((v) => v.stale).map((v) => v.path)));
  let confirm = $state<{
    title: string;
    body: string;
    label: string;
    cancel?: string;
    check?: string;
    run: (checked: boolean) => void;
  } | null>(null);

  function label(w: WorktreeInfo): string {
    const name = splitPath(w.path.replace(/\/+$/, "")).name || w.path;
    const ref = w.branch ?? `${w.head.slice(0, 7)} (detached)`;
    return `${name} · ${ref}`;
  }

  function spawnAgent(path: string, command: string): void {
    void createSessionForCard(workspaceId, path, command);
  }

  async function choose(w: WorktreeInfo): Promise<void> {
    open = false;
    if (w.path === view?.cwd) return;
    await switchWorktree(workspaceId, w.path);
  }

  async function onMergeBack(w: WorktreeInfo): Promise<void> {
    open = false;
    if (!w.branch) return;
    const branch = w.branch;
    const result = await mergeBack(workspaceId, rootPath, branch);
    if (result === "merged") {
      confirm = {
        title: `Merged ${branch} into ${rootBranch}.`,
        body: `Remove worktree ${w.path} and delete the branch ${branch}?`,
        label: "Remove & delete",
        cancel: "Keep",
        run: async () => {
          if (view?.cwd === w.path) await switchWorktree(workspaceId, rootPath);
          await removeWorktree(workspaceId, w.path, false, branch);
        },
      };
    } else if (result === "conflict") {
      // The root checkout now has MERGE_HEAD; the banner's Abort lives there.
      await switchWorktree(workspaceId, rootPath);
    }
  }

  function onRemove(w: WorktreeInfo): void {
    open = false;
    confirm = {
      title: `Remove worktree ${splitPath(w.path).name}?`,
      body: `${w.path}\n\nThe folder is deleted. Commits on ${w.branch ?? "its branch"} stay reachable.`,
      label: "Remove",
      check: w.branch ? `Also delete branch ${w.branch}` : undefined,
      run: async (alsoDelete) => {
        if (view?.cwd === w.path) await switchWorktree(workspaceId, rootPath);
        const ok = await removeWorktree(workspaceId, w.path, false, alsoDelete && w.branch ? w.branch : null);
        if (ok) return;
        const err = get(gitStore)[workspaceId]?.error ?? "";
        if (err.includes("modified or untracked")) {
          dismissError(workspaceId);
          confirm = {
            title: `${splitPath(w.path).name} has uncommitted changes. Force remove?`,
            body: `${w.path}\n\nUncommitted changes there will be lost. This cannot be undone.`,
            label: "Force remove",
            check: w.branch ? `Also delete branch ${w.branch}` : undefined,
            run: (again) => void removeWorktree(workspaceId, w.path, true, again && w.branch ? w.branch : null),
          };
        }
      },
    };
  }

  /// Re-reads the two git facts and returns the verdicts they imply.
  /// Awaited before the confirmation as well as on open, because the
  /// badge may have been drawn a minute ago and an agent can have dirtied
  /// a checkout since -- the list a human agrees to has to be the one git
  /// would give now, not the one that opened the menu.
  async function loadFacts(): Promise<SweepVerdict[]> {
    if (!rootPath || worktrees.length === 0) return [];
    const token = ++factsToken;
    const fresh = await sweepFacts(
      rootPath,
      rootBranch,
      worktrees.filter((w) => !w.prunable).map((w) => w.path)
    );
    if (token !== factsToken) return [];
    facts = fresh;
    return classifyWorktrees(worktrees, {
      base: rootBranch,
      merged: fresh.merged,
      dirty: fresh.dirty,
      rails: railBindings,
      sessionCwds,
    });
  }

  async function onSweep(): Promise<void> {
    open = false;
    const all = await loadFacts();
    const stale = all.filter((v) => v.stale);
    if (stale.length === 0) {
      // Not silence: an action that looked at every worktree and decided
      // against all of them has to say what it found, or it reads as
      // broken.
      await showAlert({ title: "Nothing to sweep.", lines: nothingToSweepLines(all), dismissLabel: "Close" });
      return;
    }
    const answer = await askConfirmChecked(sweepConfirm(stale, rootBranch));
    if (!answer.confirmed) return;
    // The tab may be POINTED at one of these, which is not a session and
    // so never blocked the sweep. Move it home before the folder goes.
    if (stale.some((v) => v.path === view?.cwd)) await switchWorktree(workspaceId, rootPath);
    await sweepWorktrees(
      workspaceId,
      stale.map((v) => ({ path: v.path, branch: v.branch })),
      answer.checked
    );
  }

  function runConfirm(checked: boolean): void {
    const c = confirm;
    confirm = null;
    c?.run(checked);
  }

  // Click-outside closes the menu; window-level so a click anywhere counts.
  function onWindowPointerDown(e: PointerEvent): void {
    if (!open) return;
    const el = e.target as HTMLElement | null;
    if (!el?.closest(".switcher")) open = false;
  }

  // Opening the menu is what asks git, so the badges are there to be read
  // rather than only after pressing Sweep. Keyed on the worktree list too:
  // a sweep, a fork or a prune changes the rows under an open menu, and
  // stale verdicts about worktrees that no longer exist are worse than
  // none.
  $effect(() => {
    const signature = worktrees.map((w) => w.path).join("\n");
    if (!open || signature === "") return;
    void loadFacts();
  });

  // A selected worktree that vanished on disk: fall back to the root.
  $effect(() => {
    const err = view?.error ?? "";
    if (view && err.includes("directory not found") && view.cwd !== rootPath && rootPath) {
      const gone = view.cwd;
      void switchWorktree(workspaceId, rootPath).then(() => noteError(workspaceId, `Worktree ${gone} is gone — back to the root checkout`));
    }
  });
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<span class="switcher">
  <button type="button" class="current" use:tooltip={current?.path ?? "Worktrees"} onclick={() => (open = !open)} aria-haspopup="menu" aria-expanded={open}>
    <FolderGit2 size={13} />
    <span class="name">{current ? label(current) : splitPath(view?.cwd ?? "").name}</span>
    <ChevronDown size={12} />
  </button>

  {#if open}
    <div class="menu" role="menu">
      {#each worktrees as w (w.path)}
        <div class="row" class:active={w.path === current?.path} class:prunable={w.prunable} role="menuitem" tabindex="-1">
          <button type="button" class="pick" onclick={() => choose(w)} disabled={locked || w.prunable}>
            <span class="dot">{w.path === current?.path ? "●" : ""}</span>
            <span class="lbl">{label(w)}{w.prunable ? " (missing)" : ""}{w.locked ? " 🔒" : ""}</span>
          </button>
          {#if staleByPath.has(w.path)}
            <StatusBadge
              indicator={worktreeStaleIndicator()}
              text="stale"
              class="stale"
              tip={`Merged into ${rootBranch}, nothing running in it, nothing uncommitted — Sweep stale removes it`}
            />
          {/if}
          <span class="acts">
            {#if !w.prunable}
              <IconButton icon={Play} label={`Open an agent in ${splitPath(w.path).name}`} size={11} disabled={locked} onclick={() => { open = false; spawnAgent(w.path, agentCommand); }} />
            {/if}
            {#if !w.isMain && !w.prunable && w.branch}
              <IconButton icon={GitMerge} label={`Merge ${w.branch} into ${rootBranch}`} size={11} disabled={locked} onclick={() => onMergeBack(w)} />
            {/if}
            {#if !w.isMain}
              <IconButton icon={Trash2} label="Remove worktree" tone="danger" size={11} disabled={locked} onclick={() => onRemove(w)} />
            {/if}
          </span>
        </div>
      {/each}
      <div class="foot">
        <button type="button" disabled={locked || !view?.refs} onclick={() => { open = false; fork = true; }}><Plus size={12} /> New worktree…</button>
        {#if worktrees.length > 1}
          <button
            type="button"
            disabled={locked}
            use:tooltip={"Remove the worktrees whose branch has landed and that nothing is using"}
            onclick={() => void onSweep()}
          >
            <BrushCleaning size={12} /> Sweep stale{staleCount > 0 ? ` (${staleCount})` : ""}
          </button>
        {/if}
        {#if anyPrunable}
          <button type="button" disabled={locked} use:tooltip={"git worktree prune"} onclick={() => { open = false; void pruneWorktrees(workspaceId); }}><Eraser size={12} /> Prune</button>
        {/if}
      </div>
    </div>
  {/if}
</span>

{#if fork}
  <GitForkDialog {workspaceId} {agentCommand} onRunInWorktree={spawnAgent} onClose={() => (fork = false)} />
{/if}

{#if confirm}
  <GitDiscardDialog
    title={confirm.title}
    body={confirm.body}
    offerSkip={confirm.check !== undefined}
    skipLabel={confirm.check ?? ""}
    confirmLabel={confirm.label}
    cancelLabel={confirm.cancel ?? "Cancel"}
    onConfirm={runConfirm}
    onCancel={() => (confirm = null)}
  />
{/if}

<style>
  .switcher {
    position: relative;
    display: inline-flex;
  }
  .current {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    font-weight: 600;
    padding: 3px 8px;
    cursor: pointer;
    max-width: 320px;
  }
  .current:hover {
    border-color: var(--border-strong);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    min-width: 340px;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
    font-weight: 400;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .row:hover {
    background: var(--surface-raised);
  }
  .row.active .lbl {
    color: var(--text);
    font-weight: 600;
  }
  .row.prunable .lbl {
    color: var(--text-subtle);
  }
  .pick {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 5px 6px;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .pick:disabled {
    cursor: default;
  }
  .dot {
    width: 8px;
    color: var(--success-text);
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Always visible, unlike .acts: the badge is the row's answer to
     "can this go?", and a fact you have to hover to learn is a fact
     nobody reads. */
  .row :global(.status-badge.stale) {
    font-size: 0.8em;
    padding-right: 4px;
    flex: 0 0 auto;
  }
  .acts {
    display: none;
    gap: 3px;
    padding-right: 4px;
  }
  .row:hover .acts {
    display: inline-flex;
  }
  .foot button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.95em;
    padding: 1px 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .foot button:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .foot button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .foot {
    display: flex;
    gap: 6px;
    padding: 6px 4px 2px;
    margin-top: 4px;
    border-top: 1px solid var(--border);
  }
</style>
