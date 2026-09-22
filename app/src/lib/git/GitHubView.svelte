<script lang="ts">
  import { layoutState, setGitViewPrefs } from "$lib/core/layoutState";
  import {
    gitStore,
    ensureGitView,
    refresh,
    startWatching,
    dismissError,
    initRepo,
    abortInProgress,
    continueInProgress,
  } from "$lib/git/gitState";
  import { tooltip } from "$lib/core/tooltip";
  import GitToolbar from "$lib/git/GitToolbar.svelte";
  import GitOpBar from "$lib/git/GitOpBar.svelte";
  import GitWorktreeSwitcher from "$lib/git/GitWorktreeSwitcher.svelte";
  import GitNav from "$lib/git/GitNav.svelte";
  import GitChanges from "$lib/git/GitChanges.svelte";
  import GitDiff from "$lib/git/GitDiff.svelte";
  import GitConflictView from "$lib/git/GitConflictView.svelte";
  import GitGraph from "$lib/git/GitGraph.svelte";
  import GitCommitDetail from "$lib/git/GitCommitDetail.svelte";
  import GitIgnoreEditor from "$lib/git/GitIgnoreEditor.svelte";
  import type { IgnoreKind } from "$lib/git/gitIgnore";
  import { sshTabBlocked } from "$lib/workspace/sshWorkspace";
  import { sshLinks } from "$lib/workspace/sshLinkState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let ignoreEditorKind = $state<IgnoreKind | null>(null);

  const NAV_DEFAULT = 160;
  const LIST_DEFAULT = 340;
  const MIN_WIDTH = 120;

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  // An ssh workspace's git runs on the host through the daemon (v40).
  // The tab works once the link is up and the host is new enough; until
  // then it is "no root" (nothing ensured, watched or refreshed) and the
  // empty state names why. The network sync buttons are the follow-up and
  // stay disabled even when the tab works (GitToolbar).
  const sshBlocked = $derived(sshTabBlocked(ws, $sshLinks));
  const root = $derived(sshBlocked ? null : (ws?.rootPath ?? null));
  // SP3: the tab may be pointed at a linked worktree; the selection is
  // persisted and reapplied on mount (falls back to the root if it's gone).
  const cwdTarget = $derived(ws?.gitView?.worktree ?? root);
  const view = $derived($gitStore[workspaceId] ?? null);
  const viewCwd = $derived(view?.cwd ?? null);
  const busy = $derived(view?.busy != null || view?.op != null);
  const repoName = $derived((view?.repo?.root ?? root ?? "").split("/").filter(Boolean).pop() ?? "");

  let navWidth = $state(NAV_DEFAULT);
  let listWidth = $state(LIST_DEFAULT);
  $effect(() => {
    navWidth = ws?.gitView?.navWidth ?? NAV_DEFAULT;
    listWidth = ws?.gitView?.listWidth ?? LIST_DEFAULT;
  });

  // Mount, workspace switch, or root rebinding: (re)create the view state
  // for the target cwd and refresh once (spec §4).
  $effect(() => {
    const target = cwdTarget;
    const id = workspaceId;
    if (!target) return;
    ensureGitView(id, target);
    void refresh(id);
  });

  // The watcher follows the view's cwd (a worktree switch restarts it); its
  // cleanup is the unmount path.
  $effect(() => {
    const cwd = viewCwd;
    const id = workspaceId;
    if (!cwd) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startWatching(id).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  // Splitters: window-level listeners with a buttons===0 bail-out, because
  // WKWebView drops pointerup when the pointerdown target leaves the DOM.
  function startDrag(which: "nav" | "list", e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = which === "nav" ? navWidth : listWidth;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      const w = Math.max(MIN_WIDTH, startW + ev.clientX - startX);
      if (which === "nav") navWidth = w;
      else listWidth = w;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      void setGitViewPrefs(workspaceId, which === "nav" ? { navWidth } : { listWidth });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
</script>

{#if sshBlocked}
  <div class="empty">{sshBlocked}</div>
{:else if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else if !view || (!view.repo && !view.gitMissing && !view.error)}
  <div class="empty">Loading…</div>
{:else if view.gitMissing}
  <div class="empty">
    <b>git was not found on PATH</b>
    <span>Install git (on macOS: <code>xcode-select --install</code>), then reopen this tab.</span>
  </div>
{:else if view.repo?.notARepo}
  <div class="empty">
    <span>Not a git repository</span>
    <button type="button" class="primary" onclick={() => initRepo(workspaceId)} disabled={busy}>Initialize repository</button>
  </div>
{:else}
  <div class="git">
    <GitToolbar {workspaceId} {repoName} onOpenIgnoreEditor={(k) => (ignoreEditorKind = k)}>
      {#snippet leading()}
        <GitWorktreeSwitcher {workspaceId} />
      {/snippet}
    </GitToolbar>
    <GitOpBar {workspaceId} />
    {#if view.repo?.inProgress}
      {@const kind = view.repo.inProgress}
      {@const conflictCount = view.status?.unstaged.filter((e) => e.status === "U").length ?? 0}
      {@const conflicts = conflictCount > 0}
      {@const label = kind === "merge" ? "Merge" : kind === "rebase" ? "Rebase" : kind === "cherry-pick" ? "Cherry-pick" : "Revert"}
      <div class="banner info">
        <span>
          {label} in progress —
          {#if conflicts}{conflictCount} file{conflictCount === 1 ? "" : "s"} conflicted; resolve {conflictCount === 1 ? "it" : "them"} and {kind === "merge" ? "commit" : "continue"}{:else}no conflicts left — {kind === "merge" ? "commit" : "continue"} when ready{/if}
        </span>
        {#if kind !== "merge"}
          <button
            type="button"
            class="banner-act"
            disabled={busy || conflicts}
            use:tooltip={conflicts ? "Resolve the conflicted files first" : `git ${kind} --continue`}
            onclick={() => continueInProgress(workspaceId, kind)}
          >Continue</button>
        {/if}
        <button type="button" class="banner-act danger" disabled={busy} onclick={() => abortInProgress(workspaceId, kind)}>
          Abort {kind}
        </button>
      </div>
    {/if}
    {#if view.error}
      <div class="banner error">
        <span>{view.error}</span>
        <button type="button" use:tooltip={"Dismiss"} onclick={() => dismissError(workspaceId)}>✕</button>
      </div>
    {/if}
    <div class="panes" style:grid-template-columns="{navWidth}px 4px {listWidth}px 4px minmax(0, 1fr)">
      <div class="pane"><GitNav {workspaceId} /></div>
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("nav", e)}></div>
      {#if view.navSelection === "commits"}
        <div class="pane"><GitGraph {workspaceId} /></div>
        <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("list", e)}></div>
        <div class="pane"><GitCommitDetail {workspaceId} /></div>
      {:else}
        <div class="pane"><GitChanges {workspaceId} onOpenIgnoreEditor={(k) => (ignoreEditorKind = k)} /></div>
        <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("list", e)}></div>
        <div class="pane">
          {#if view.selected && view.status?.unstaged.some((e) => e.status === "U" && e.path === view.selected?.path && view.selected.area === "unstaged")}
            <GitConflictView {workspaceId} />
          {:else}
            <GitDiff {workspaceId} />
          {/if}
        </div>
      {/if}
    </div>
  </div>
  {#if ignoreEditorKind}
    <GitIgnoreEditor {workspaceId} kind={ignoreEditorKind} onClose={() => (ignoreEditorKind = null)} />
  {/if}
{/if}

<style>
  .git {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: monospace;
    color: var(--text);
  }
  .banner .banner-act {
    background: transparent;
    border: 1px solid var(--border-warning);
    border-radius: 4px;
    color: inherit;
    font-family: monospace;
    font-size: 1em;
    padding: 1px 8px;
    cursor: pointer;
  }
  .banner .banner-act:hover:not(:disabled) {
    border-color: var(--border-warning);
  }
  .banner .banner-act:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .banner .banner-act.danger {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    font-size: 0.75em;
  }
  .banner.info {
    background: var(--surface-warning);
    color: var(--warning-text);
    border-bottom: 1px solid var(--border-warning);
  }
  .banner.error {
    background: var(--surface-danger);
    color: var(--danger-text);
    border-bottom: 1px solid var(--border-danger);
  }
  .banner span {
    flex: 1 1 auto;
    white-space: pre-wrap;
  }
  .banner button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .panes {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .splitter {
    cursor: col-resize;
    background: var(--surface-raised);
  }
  .splitter:hover {
    background: var(--surface-selected);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
  }
  .empty code {
    color: var(--text-muted);
  }
  .primary {
    background: var(--surface-success);
    border: 1px solid var(--border-success);
    border-radius: 6px;
    color: var(--success-text);
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
