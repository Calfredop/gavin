<script lang="ts">
  import { get } from "svelte/store";
  import { ChevronDown, ChevronRight, Plus, FileDiff, GitBranch, Cloud, Archive, Trash2, GitMerge, LogIn, History } from "@lucide/svelte";
  import { layoutState, setGitViewPrefs } from "./layoutState";
  import {
    gitStore,
    selectChanges,
    selectCommits,
    selectStash,
    checkout,
    createBranch,
    deleteBranch,
    mergeBranch,
    addRemote,
    removeRemote,
    stashPop,
    stashApply,
    stashDrop,
    dismissError,
  } from "./gitState";
  import { changedCount } from "./git";
  import { tooltip } from "./tooltip";
  import GitPromptDialog from "./GitPromptDialog.svelte";
  import GitDiscardDialog from "./GitDiscardDialog.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const refs = $derived(view?.refs ?? null);
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const nav = $derived(view?.navSelection ?? "changes");
  const collapsed = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.navCollapsed ?? {});

  function toggle(section: string): void {
    void setGitViewPrefs(workspaceId, { navCollapsed: { ...collapsed, [section]: !collapsed[section] } });
  }

  // One small modal at a time: a prompt (new branch / add remote) or a
  // destructive confirm (delete branch / remove remote / drop stash).
  let prompt = $state<"branch" | "remote" | null>(null);
  let confirm = $state<{ title: string; body: string; label: string; run: () => void } | null>(null);

  async function onDeleteBranch(name: string): Promise<void> {
    confirm = {
      title: `Delete branch ${name}?`,
      body: "The branch ref is removed; its commits stay reachable from other refs, if any.",
      label: "Delete",
      run: async () => {
        const done = await deleteBranch(workspaceId, name, false);
        if (done) return;
        const err = get(gitStore)[workspaceId]?.error ?? "";
        if (err.includes("not fully merged")) {
          dismissError(workspaceId);
          confirm = {
            title: `Branch ${name} isn't fully merged. Force delete?`,
            body: "Commits only reachable from this branch will be lost.",
            label: "Force delete",
            run: () => void deleteBranch(workspaceId, name, true),
          };
        }
      },
    };
  }

  function onRemoveRemote(name: string): void {
    confirm = {
      title: `Remove remote ${name}?`,
      body: "Its remote-tracking branches are deleted locally; nothing on the server changes.",
      label: "Remove",
      run: () => void removeRemote(workspaceId, name),
    };
  }

  function onDropStash(index: number, message: string): void {
    confirm = {
      title: `Drop stash@{${index}}?`,
      body: `${message}\n\nThis cannot be undone.`,
      label: "Drop",
      run: () => void stashDrop(workspaceId, index),
    };
  }

  function runConfirm(): void {
    const c = confirm;
    confirm = null;
    c?.run();
  }
</script>

<!-- Fork's left rail: collapsible sections. Branches/Remotes rows act on
     the repo; only Local Changes and a stash change the middle column. -->
<nav class="nav">
  <button type="button" class="item top" class:active={nav === "changes"} onclick={() => selectChanges(workspaceId)}>
    <FileDiff size={13} />
    <span class="label">Local Changes</span>
    {#if view?.status}{@const n = changedCount(view.status)}{#if n > 0}<span class="count">{n}</span>{/if}{/if}
  </button>
  <button type="button" class="item top" class:active={nav === "commits"} onclick={() => selectCommits(workspaceId)}>
    <History size={13} />
    <span class="label">All Commits</span>
  </button>

  <!-- Branches -->
  <div class="section">
    <div class="head">
      <button type="button" class="toggle" onclick={() => toggle("branches")} aria-expanded={!collapsed.branches}>
        {#if collapsed.branches}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <GitBranch size={12} />
        <span>Branches</span>
      </button>
      <button type="button" class="plus" use:tooltip={"New branch from HEAD"} disabled={locked || !refs} onclick={() => (prompt = "branch")}>
        <Plus size={12} />
      </button>
    </div>
    {#if !collapsed.branches}
      {#if view?.repo?.unborn}
        <div class="none">(no commits yet)</div>
      {:else if refs}
        {#each refs.branches as b (b.name)}
          <div class="row" class:current={b.current} role="group" ondblclick={() => !b.current && !locked && checkout(workspaceId, b.name, null)}>
            <span class="dot">{b.current ? "●" : ""}</span>
            <span class="name" title={b.subject}>{b.name}</span>
            {#if b.upstream}
              <span class="track">{#if b.ahead}↑{b.ahead}{/if}{#if b.behind} ↓{b.behind}{/if}</span>
            {/if}
            {#if !b.current}
              <span class="acts">
                <button type="button" use:tooltip={`Checkout ${b.name}`} disabled={locked} onclick={() => checkout(workspaceId, b.name, null)}><LogIn size={11} /></button>
                <button type="button" use:tooltip={`Merge ${b.name} into current`} disabled={locked} onclick={() => mergeBranch(workspaceId, b.name)}><GitMerge size={11} /></button>
                <button type="button" class="danger" use:tooltip={"Delete branch"} disabled={locked} onclick={() => onDeleteBranch(b.name)}><Trash2 size={11} /></button>
              </span>
            {/if}
          </div>
        {/each}
      {/if}
    {/if}
  </div>

  <!-- Remotes -->
  <div class="section">
    <div class="head">
      <button type="button" class="toggle" onclick={() => toggle("remotes")} aria-expanded={!collapsed.remotes}>
        {#if collapsed.remotes}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <Cloud size={12} />
        <span>Remotes</span>
      </button>
      <button type="button" class="plus" use:tooltip={"Add remote"} disabled={locked || !refs} onclick={() => (prompt = "remote")}>
        <Plus size={12} />
      </button>
    </div>
    {#if !collapsed.remotes && refs}
      {#if refs.remotes.length === 0}
        <div class="none">No remotes</div>
      {/if}
      {#each refs.remotes as r (r.name)}
        <div class="row remote" role="group" use:tooltip={r.url}>
          <span class="dot"></span>
          <span class="name">{r.name}</span>
          <span class="acts">
            <button type="button" class="danger" use:tooltip={"Remove remote"} disabled={locked} onclick={() => onRemoveRemote(r.name)}><Trash2 size={11} /></button>
          </span>
        </div>
        {#each r.branches as rb (r.name + "/" + rb)}
          <div class="row sub" role="group" ondblclick={() => !locked && checkout(workspaceId, rb, r.name)}>
            <span class="dot"></span>
            <span class="name">{rb}</span>
            <span class="acts">
              <button type="button" use:tooltip={`Checkout ${r.name}/${rb}`} disabled={locked} onclick={() => checkout(workspaceId, rb, r.name)}><LogIn size={11} /></button>
            </span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <!-- Stashes -->
  <div class="section">
    <div class="head">
      <button type="button" class="toggle" onclick={() => toggle("stashes")} aria-expanded={!collapsed.stashes}>
        {#if collapsed.stashes}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <Archive size={12} />
        <span>Stashes</span>
        {#if refs && refs.stashes.length > 0}<span class="count">{refs.stashes.length}</span>{/if}
      </button>
    </div>
    {#if !collapsed.stashes && refs}
      {#if refs.stashes.length === 0}
        <div class="none">No stashes</div>
      {/if}
      {#each refs.stashes as s (s.index)}
        {@const active = typeof nav === "object" && nav.stash === s.index}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="row stash" class:active role="option" aria-selected={active} tabindex="-1" onclick={() => selectStash(workspaceId, s.index)}>
          <span class="dot"></span>
          <span class="name" title={s.message}>{s.message}</span>
          <span class="date">{s.date}</span>
          <span class="acts">
            <button type="button" use:tooltip={"Pop (apply and drop)"} disabled={locked} onclick={(e) => { e.stopPropagation(); void stashPop(workspaceId, s.index); }}>pop</button>
            <button type="button" use:tooltip={"Apply (keep the stash)"} disabled={locked} onclick={(e) => { e.stopPropagation(); void stashApply(workspaceId, s.index); }}>apply</button>
            <button type="button" class="danger" use:tooltip={"Drop"} disabled={locked} onclick={(e) => { e.stopPropagation(); onDropStash(s.index, s.message); }}><Trash2 size={11} /></button>
          </span>
        </div>
      {/each}
    {/if}
  </div>
</nav>

{#if prompt === "branch"}
  <GitPromptDialog
    title="New branch"
    fields={[{ key: "name", label: "Branch name", value: "", placeholder: "feature/thing", required: true }]}
    checkbox={{ label: "Checkout after creating", checked: true }}
    primary="Create"
    onSubmit={(values, checked) => {
      prompt = null;
      void createBranch(workspaceId, values.name, null, checked);
    }}
    onCancel={() => (prompt = null)}
  />
{:else if prompt === "remote"}
  <GitPromptDialog
    title="Add remote"
    fields={[
      { key: "name", label: "Name", value: "", placeholder: "upstream", required: true },
      { key: "url", label: "URL", value: "", placeholder: "git@github.com:org/repo.git", required: true },
    ]}
    primary="Add"
    onSubmit={(values) => {
      prompt = null;
      void addRemote(workspaceId, values.name, values.url);
    }}
    onCancel={() => (prompt = null)}
  />
{/if}

{#if confirm}
  <GitDiscardDialog title={confirm.title} body={confirm.body} offerSkip={false} confirmLabel={confirm.label} onConfirm={runConfirm} onCancel={() => (confirm = null)} />
{/if}

<style>
  .nav {
    height: 100%;
    padding: 8px 6px;
    box-sizing: border-box;
    background: #161616;
    border-right: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.78em;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #bbb;
    cursor: pointer;
    text-align: left;
    font-family: monospace;
    font-size: 1em;
  }
  .item.active {
    background: #252525;
    color: #eee;
  }
  .label {
    flex: 1 1 auto;
  }
  .count {
    color: #8bc98b;
  }
  .section {
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: center;
  }
  .toggle {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    background: transparent;
    border: 0;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: monospace;
    font-size: 0.9em;
    cursor: pointer;
    text-align: left;
  }
  .toggle:hover {
    color: #ddd;
  }
  .plus {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .plus:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .plus:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px 2px 10px;
    border-radius: 4px;
    color: #bbb;
    white-space: nowrap;
    user-select: none;
  }
  .row:hover {
    background: #222;
  }
  .row.current {
    color: #eee;
    font-weight: 600;
  }
  .row.sub {
    padding-left: 22px;
    color: #999;
  }
  .row.stash {
    cursor: pointer;
  }
  .row.active {
    background: #2a3a4a;
    color: #eee;
  }
  .dot {
    width: 8px;
    color: #8bc98b;
    flex: 0 0 auto;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .track,
  .date {
    color: #777;
    font-size: 0.9em;
  }
  .acts {
    display: none;
    gap: 3px;
  }
  .row:hover .acts {
    display: inline-flex;
  }
  .acts button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    color: #bbb;
    font-family: monospace;
    font-size: 0.9em;
    padding: 0 4px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .acts button:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .acts button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .acts .danger:hover:not(:disabled) {
    border-color: #7a3030;
    color: #f0c0c0;
  }
  .none {
    padding: 2px 10px;
    color: #666;
  }
</style>
