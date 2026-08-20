<script lang="ts">
  import { GitBranch, RefreshCw } from "@lucide/svelte";
  import { layoutState, setGitViewPrefs } from "./layoutState";
  import { gitStore, ensureGitView, refresh, startWatching, dismissError, initRepo } from "./gitState";
  import { branchLabel, changedCount } from "./git";
  import { tooltip } from "./tooltip";
  import GitNav from "./GitNav.svelte";
  import GitChanges from "./GitChanges.svelte";
  import GitDiff from "./GitDiff.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const NAV_DEFAULT = 160;
  const LIST_DEFAULT = 340;
  const MIN_WIDTH = 120;

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const view = $derived($gitStore[workspaceId] ?? null);
  const busy = $derived(view?.busy != null);
  const repoName = $derived((view?.repo?.root ?? root ?? "").split("/").filter(Boolean).pop() ?? "");

  let navWidth = $state(NAV_DEFAULT);
  let listWidth = $state(LIST_DEFAULT);
  $effect(() => {
    navWidth = ws?.gitView?.navWidth ?? NAV_DEFAULT;
    listWidth = ws?.gitView?.listWidth ?? LIST_DEFAULT;
  });

  // Mount, workspace switch, or root rebinding: (re)create the view state,
  // refresh once, and hold the worktree watcher for as long as the tab is
  // on screen (spec §4). The effect's cleanup is the unmount path.
  $effect(() => {
    const r = root;
    const id = workspaceId;
    if (!r) return;
    ensureGitView(id, r);
    void refresh(id);
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

{#if !root}
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
    <div class="toolbar">
      <span class="repo">{repoName}</span>
      {#if view.repo}
        <span class="branch" class:detached={view.repo.detached}>
          <GitBranch size={12} />
          {branchLabel(view.repo)}
        </span>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="icon" use:tooltip={"Refresh"} onclick={() => refresh(workspaceId)} disabled={busy}>
        <RefreshCw size={13} />
      </button>
    </div>
    {#if view.repo?.inProgress}
      <div class="banner info">
        {view.repo.inProgress === "merge" ? "Merge" : "Rebase"} in progress — resolve conflicts and commit
      </div>
    {/if}
    {#if view.error}
      <div class="banner error">
        <span>{view.error}</span>
        <button type="button" use:tooltip={"Dismiss"} onclick={() => dismissError(workspaceId)}>✕</button>
      </div>
    {/if}
    <div class="panes" style:grid-template-columns="{navWidth}px 4px {listWidth}px 4px minmax(0, 1fr)">
      <div class="pane"><GitNav count={changedCount(view.status)} /></div>
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("nav", e)}></div>
      <div class="pane"><GitChanges {workspaceId} /></div>
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("list", e)}></div>
      <div class="pane"><GitDiff {workspaceId} /></div>
    </div>
  </div>
{/if}

<style>
  .git {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: monospace;
    color: #ccc;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-size: 0.8em;
  }
  .repo {
    color: #eee;
    font-weight: 600;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border: 1px solid #3a3a3a;
    border-radius: 10px;
    color: #bbb;
  }
  .branch.detached {
    border-color: #8a6d2b;
    color: #d9b45c;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    color: #bbb;
    padding: 3px 6px;
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    border-color: #555;
    color: #eee;
  }
  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    font-size: 0.75em;
  }
  .banner.info {
    background: #2a2417;
    color: #d9b45c;
    border-bottom: 1px solid #4a3d1f;
  }
  .banner.error {
    background: #2b1a1a;
    color: #e08a8a;
    border-bottom: 1px solid #4a2727;
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
    background: #2f2f2f;
  }
  .splitter:hover {
    background: #4a4a4a;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
  .empty code {
    color: #bbb;
  }
  .primary {
    background: #2d4a2d;
    border: 1px solid #3f6b3f;
    border-radius: 6px;
    color: #cfe8cf;
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
