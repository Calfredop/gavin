<script lang="ts">
  import { get } from "svelte/store";
  import { ChevronDown, ChevronRight, Plus, FileDiff, GitBranch, Cloud, Archive, Trash2, GitMerge, LogIn, History } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { layoutState, setGitViewPrefs } from "$lib/layoutState";
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
  } from "$lib/gitState";
  import { changedCount } from "$lib/git";
  import { tooltip } from "$lib/tooltip";
  import GitPromptDialog from "$lib/GitPromptDialog.svelte";
  import GitDiscardDialog from "$lib/GitDiscardDialog.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import { filterBranches, filterRemotes, filterStashes } from "$lib/gitSearch";
  import { isSearching } from "$lib/search";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const refs = $derived(view?.refs ?? null);
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const nav = $derived(view?.navSelection ?? "changes");
  const collapsed = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.navCollapsed ?? {});

  // Ref search (gitSearch.ts). A repo with a hundred branches makes this
  // column unusable without it. While searching, sections OPEN whatever
  // their collapsed pref says -- a collapsed section would hide the very
  // ref the query just found.
  let query = $state("");
  const searching = $derived(isSearching(query));
  const branches = $derived(filterBranches(refs?.branches ?? [], query));
  const remotes = $derived(filterRemotes(refs?.remotes ?? [], query));
  const stashes = $derived(filterStashes(refs?.stashes ?? [], query));
  const hits = $derived(
    branches.length + remotes.reduce((n, r) => n + r.branches.length, 0) + stashes.length
  );
  function shut(section: string): boolean {
    return searching ? false : (collapsed[section] ?? false);
  }

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

  <div class="filter-bar">
    <SearchInput
      bind:value={query}
      label="Search branches, remotes and stashes"
      placeholder="Filter refs…"
    />
    {#if searching}
      <span class="hits" class:none={hits === 0}>{hits} {hits === 1 ? "match" : "matches"}</span>
    {/if}
  </div>

  <!-- Branches -->
  <div class="section">
    <div class="head">
      <button type="button" class="toggle" disabled={searching} title={searching ? "Sections stay open while the filter is set" : ""} onclick={() => toggle("branches")} aria-expanded={!shut("branches")}>
        {#if shut("branches")}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <GitBranch size={12} />
        <span>Branches</span>
      </button>
      <IconButton icon={Plus} label="New branch from HEAD" size={12} disabled={locked || !refs} onclick={() => (prompt = "branch")} />
    </div>
    {#if !shut("branches")}
      {#if view?.repo?.unborn}
        <div class="none">(no commits yet)</div>
      {:else if refs}
        {#if branches.length === 0}
          <div class="none">No match</div>
        {/if}
        {#each branches as b (b.name)}
          <div class="row" class:current={b.current} role="group" ondblclick={() => !b.current && !locked && checkout(workspaceId, b.name, null)}>
            <span class="dot">{b.current ? "●" : ""}</span>
            <span class="name" title={b.subject}>{b.name}</span>
            {#if b.upstream}
              <span class="track">{#if b.ahead}↑{b.ahead}{/if}{#if b.behind} ↓{b.behind}{/if}</span>
            {/if}
            {#if !b.current}
              <span class="acts">
                <IconButton icon={LogIn} label={`Checkout ${b.name}`} size={11} disabled={locked} onclick={() => checkout(workspaceId, b.name, null)} />
                <IconButton icon={GitMerge} label={`Merge ${b.name} into current`} size={11} disabled={locked} onclick={() => mergeBranch(workspaceId, b.name)} />
                <IconButton icon={Trash2} label="Delete branch" tone="danger" size={11} disabled={locked} onclick={() => onDeleteBranch(b.name)} />
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
      <button type="button" class="toggle" disabled={searching} title={searching ? "Sections stay open while the filter is set" : ""} onclick={() => toggle("remotes")} aria-expanded={!shut("remotes")}>
        {#if shut("remotes")}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <Cloud size={12} />
        <span>Remotes</span>
      </button>
      <IconButton icon={Plus} label="Add remote" size={12} disabled={locked || !refs} onclick={() => (prompt = "remote")} />
    </div>
    {#if !shut("remotes") && refs}
      {#if remotes.length === 0}
        <div class="none">{searching ? "No match" : "No remotes"}</div>
      {/if}
      {#each remotes as r (r.name)}
        <div class="row remote" role="group" use:tooltip={r.url}>
          <span class="dot"></span>
          <span class="name">{r.name}</span>
          <span class="acts">
            <IconButton icon={Trash2} label="Remove remote" tone="danger" size={11} disabled={locked} onclick={() => onRemoveRemote(r.name)} />
          </span>
        </div>
        {#each r.branches as rb (r.name + "/" + rb)}
          <div class="row sub" role="group" ondblclick={() => !locked && checkout(workspaceId, rb, r.name)}>
            <span class="dot"></span>
            <span class="name">{rb}</span>
            <span class="acts">
              <IconButton icon={LogIn} label={`Checkout ${r.name}/${rb}`} size={11} disabled={locked} onclick={() => checkout(workspaceId, rb, r.name)} />
            </span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <!-- Stashes -->
  <div class="section">
    <div class="head">
      <button type="button" class="toggle" disabled={searching} title={searching ? "Sections stay open while the filter is set" : ""} onclick={() => toggle("stashes")} aria-expanded={!shut("stashes")}>
        {#if shut("stashes")}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        <Archive size={12} />
        <span>Stashes</span>
        {#if refs && stashes.length > 0}<span class="count">{stashes.length}</span>{/if}
      </button>
    </div>
    {#if !shut("stashes") && refs}
      {#if stashes.length === 0}
        <div class="none">{searching ? "No match" : "No stashes"}</div>
      {/if}
      {#each stashes as s (s.index)}
        {@const active = typeof nav === "object" && nav.stash === s.index}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="row stash" class:active role="option" aria-selected={active} tabindex="-1" onclick={() => selectStash(workspaceId, s.index)}>
          <span class="dot"></span>
          <span class="name" title={s.message}>{s.message}</span>
          <span class="date">{s.date}</span>
          <span class="acts">
            <button type="button" use:tooltip={"Pop (apply and drop)"} disabled={locked} onclick={(e) => { e.stopPropagation(); void stashPop(workspaceId, s.index); }}>pop</button>
            <button type="button" use:tooltip={"Apply (keep the stash)"} disabled={locked} onclick={(e) => { e.stopPropagation(); void stashApply(workspaceId, s.index); }}>apply</button>
            <IconButton icon={Trash2} label="Drop" tone="danger" size={11} disabled={locked} onclick={(e) => { e.stopPropagation(); onDropStash(s.index, s.message); }} />
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
    background: var(--surface-sunken);
    border-right: 1px solid var(--border);
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
    color: var(--text-muted);
    cursor: pointer;
    text-align: left;
    font-family: monospace;
    font-size: 1em;
  }
  .item.active {
    background: var(--surface-raised);
    color: var(--text);
  }
  .label {
    flex: 1 1 auto;
  }
  .count {
    color: var(--success-text);
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
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: monospace;
    font-size: 0.9em;
    cursor: pointer;
    text-align: left;
  }
  .toggle:hover:not(:disabled) {
    color: var(--text);
  }
  .toggle:disabled {
    cursor: default;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px 2px 10px;
    border-radius: 4px;
    color: var(--text-muted);
    white-space: nowrap;
    user-select: none;
  }
  .row:hover {
    background: var(--surface-sunken);
  }
  .row.current {
    color: var(--text);
    font-weight: 600;
  }
  .row.sub {
    padding-left: 22px;
    color: var(--text-muted);
  }
  .row.stash {
    cursor: pointer;
  }
  .row.active {
    background: var(--surface-accent);
    color: var(--text);
  }
  .dot {
    width: 8px;
    color: var(--success-text);
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
    color: var(--text-subtle);
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
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.9em;
    padding: 0 4px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .acts button:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .acts button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .none {
    padding: 2px 10px;
    color: var(--text-subtle);
  }
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .hits {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 0.7em;
    font-variant-numeric: tabular-nums;
  }
  .hits.none {
    padding: 0;
    color: var(--warning-text);
  }
</style>
