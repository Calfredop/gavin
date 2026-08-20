<script lang="ts">
  import { get } from "svelte/store";
  import { ChevronDown, FolderGit2, Play, GitMerge, Trash2, Plus, Eraser } from "@lucide/svelte";
  import { agentProfilesStore, createSessionForCard } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig } from "./settings";
  import {
    gitStore,
    rootPathOf,
    switchWorktree,
    mergeBack,
    removeWorktree,
    pruneWorktrees,
    dismissError,
    noteError,
  } from "./gitState";
  import { splitPath, type WorktreeInfo } from "./git";
  import { tooltip } from "./tooltip";
  import GitForkDialog from "./GitForkDialog.svelte";
  import GitDiscardDialog from "./GitDiscardDialog.svelte";

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
  const tree = $derived($gavinTrees[workspaceId]);
  const agentCommand = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore).command
  );

  let open = $state(false);
  let fork = $state(false);
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
          <span class="acts">
            {#if !w.prunable}
              <button type="button" use:tooltip={`Open an agent in ${splitPath(w.path).name}`} disabled={locked} onclick={() => { open = false; spawnAgent(w.path, agentCommand); }}><Play size={11} /></button>
            {/if}
            {#if !w.isMain && !w.prunable && w.branch}
              <button type="button" use:tooltip={`Merge ${w.branch} into ${rootBranch}`} disabled={locked} onclick={() => onMergeBack(w)}><GitMerge size={11} /></button>
            {/if}
            {#if !w.isMain}
              <button type="button" class="danger" use:tooltip={"Remove worktree"} disabled={locked} onclick={() => onRemove(w)}><Trash2 size={11} /></button>
            {/if}
          </span>
        </div>
      {/each}
      <div class="foot">
        <button type="button" disabled={locked || !view?.refs} onclick={() => { open = false; fork = true; }}><Plus size={12} /> New worktree…</button>
        {#if anyPrunable}
          <button type="button" disabled={locked} use:tooltip={"git worktree prune"} onclick={() => { open = false; void pruneWorktrees(workspaceId); }}><Eraser size={12} /> Prune</button>
        {/if}
      </div>
    </div>
  {/if}
</span>

{#if fork}
  <GitForkDialog {workspaceId} {agentCommand} onSpawnAgent={spawnAgent} onClose={() => (fork = false)} />
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
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    font-weight: 600;
    padding: 3px 8px;
    cursor: pointer;
    max-width: 320px;
  }
  .current:hover {
    border-color: #555;
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
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
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
    background: #262626;
  }
  .row.active .lbl {
    color: #eee;
    font-weight: 600;
  }
  .row.prunable .lbl {
    color: #666;
  }
  .pick {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    color: #bbb;
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
    color: #8bc98b;
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .acts {
    display: none;
    gap: 3px;
    padding-right: 4px;
  }
  .row:hover .acts {
    display: inline-flex;
  }
  .acts button,
  .foot button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    font-family: monospace;
    font-size: 0.95em;
    padding: 1px 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .acts button:hover:not(:disabled),
  .foot button:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .acts button:disabled,
  .foot button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .acts .danger:hover:not(:disabled) {
    border-color: #7a3030;
    color: #f0c0c0;
  }
  .foot {
    display: flex;
    gap: 6px;
    padding: 6px 4px 2px;
    margin-top: 4px;
    border-top: 1px solid #2f2f2f;
  }
</style>
