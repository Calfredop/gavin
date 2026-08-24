<script lang="ts">
  import Modal from "./Modal.svelte";
  import GitForkDialog from "./GitForkDialog.svelte";
  import { gitStore, createBranch } from "./gitState";
  import { gavinTrees } from "./gavinState";
  import { layoutState, createPage, resolvedAgentFor } from "./layoutState";
  import { bindRailAction } from "./orchestrationState";
  import { presetSingle } from "./layout";
  import { validateBranchName } from "./git";
  import type { Rail } from "./orchestration";

  interface Props {
    workspaceId: string;
    rail: Rail;
    onClose: () => void;
  }
  let { workspaceId, rail, onClose }: Props = $props();

  let forking = $state(false);

  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? []);
  const branches = $derived($gitStore[workspaceId]?.refs?.branches ?? []);
  const headBranch = $derived($gitStore[workspaceId]?.refs?.headBranch ?? null);
  const pages = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.pages ?? []);

  /// Where each branch is currently checked out, so the list can say so.
  /// A branch checked out in ANOTHER worktree is the one binding git
  /// refuses at switch time, and the human deserves to see that here
  /// rather than in a stall reason.
  const checkedOutIn = $derived(
    new Map(
      worktrees
        .filter((w) => w.branch !== null)
        .map((w) => [w.branch as string, w.path] as const)
    )
  );

  /// The checkout this rail's branch applies to — its own worktree, or
  /// the workspace root when it has none. What the section's note names,
  /// and what decides whether a branch reads as "here" or "elsewhere".
  /// Spelled exactly as `conflictCheckout` spells it, so the dialog can
  /// never name a different checkout than the scheduler switches.
  const tree = $derived($gavinTrees[workspaceId]);
  const railCheckout = $derived(
    rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null)
  );

  let naming = $state(false);
  let draftBranch = $state("");
  let draftFrom = $state("HEAD");
  let creating = $state(false);

  const draftError = $derived.by(() => {
    const v = validateBranchName(draftBranch);
    if (v) return v;
    if (branches.some((b) => b.name === draftBranch)) return "Branch already exists — pick it above";
    return null;
  });

  /// The same page Start would spawn on its own (spec O16), made early:
  /// named after the rail, opened in the rail's checkout.
  async function bindNewPage(): Promise<void> {
    const pageId = await createPage(
      workspaceId,
      (ids) => presetSingle(ids[0]),
      1,
      rail.name,
      railCheckout ?? undefined
    );
    if (pageId) await bindRailAction(workspaceId, rail.id, { pageId });
  }

  /// Creates the branch WITHOUT checking it out: the rail's own Start is
  /// what moves a checkout, once, when the human arms it.
  async function createAndBind(): Promise<void> {
    if (draftError || creating) return;
    creating = true;
    const name = draftBranch;
    const ok = await createBranch(workspaceId, name, draftFrom === "HEAD" ? null : draftFrom, false);
    creating = false;
    if (!ok) return; // the Git tab's error banner carries git's message
    await bindRailAction(workspaceId, rail.id, { branch: name });
    naming = false;
    draftBranch = "";
  }
</script>

{#if forking}
  <GitForkDialog
    {workspaceId}
    agentCommand={resolvedAgentFor(workspaceId).command}
    onSpawnAgent={() => {}}
    allowSpawn={false}
    switchAfter={false}
    onPicked={(path) => {
      void bindRailAction(workspaceId, rail.id, { worktreePath: path });
      forking = false;
      onClose();
    }}
    onClose={() => (forking = false)}
  />
{:else}
  <Modal {onClose}>
    <div class="bind">
      <h3>Bind “{rail.name}”</h3>

      <section>
        <h4>Worktree</h4>
        <p class="note">
          Where this rail's steps run. Re-binding affects steps started from now on.
        </p>
        <ul>
          <li>
            <button
              type="button"
              class:on={rail.worktreePath === null}
              onclick={() => void bindRailAction(workspaceId, rail.id, { worktreePath: null })}
            >
              <span class="path">None — each card's own folder</span>
            </button>
          </li>
          {#each worktrees as wt (wt.path)}
            <li>
              <button
                type="button"
                class:on={rail.worktreePath === wt.path}
                onclick={() => void bindRailAction(workspaceId, rail.id, { worktreePath: wt.path })}
              >
                <span class="path">{wt.path}</span>
                <span class="branch">
                  {wt.branch ?? "detached"}{wt.isMain ? " · main checkout" : ""}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <button type="button" class="secondary" onclick={() => (forking = true)}>New worktree…</button>
      </section>

      <section>
        <h4>Branch</h4>
        <p class="note">
          Which branch that checkout sits on. Gavin switches
          {railCheckout ?? "the checkout"} before the rail's first step, and refuses while it has
          uncommitted changes.
        </p>
        <ul>
          <li>
            <button
              type="button"
              class:on={!rail.branch}
              onclick={() => void bindRailAction(workspaceId, rail.id, { branch: null })}
            >
              <span class="path">None — whatever is checked out</span>
            </button>
          </li>
          {#each branches as b (b.name)}
            {@const where = checkedOutIn.get(b.name) ?? null}
            <li>
              <button
                type="button"
                class:on={rail.branch === b.name}
                onclick={() => void bindRailAction(workspaceId, rail.id, { branch: b.name })}
              >
                <span class="path">{b.name}</span>
                {#if where === railCheckout && where !== null}
                  <span class="branch">already checked out here</span>
                {:else if where}
                  <!-- git refuses to check a branch out twice, so this
                       binding stalls at Start until the other checkout
                       moves. Better said here than in a stall reason. -->
                  <span class="branch warn">checked out at {where} — gavin cannot switch to it</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
        <!-- Without this the list simply shows nothing selected, which
             reads as "unbound" rather than "bound to something gone". -->
        {#if rail.branch && !branches.some((b) => b.name === rail.branch)}
          <p class="err">Bound to {rail.branch}, which this repo no longer has.</p>
        {/if}
        {#if naming}
          <form class="new-branch" onsubmit={(e) => { e.preventDefault(); void createAndBind(); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input type="text" bind:value={draftBranch} placeholder="feature/thing" autofocus />
            <select bind:value={draftFrom}>
              <option value="HEAD">from HEAD{headBranch ? ` (${headBranch})` : ""}</option>
              {#each branches as b (b.name)}
                <option value={b.name}>from {b.name}</option>
              {/each}
            </select>
            <div class="row">
              <button type="button" class="secondary" onclick={() => (naming = false)}>Cancel</button>
              <button type="submit" class="secondary" disabled={!!draftError || creating}>
                {creating ? "Creating…" : "Create and bind"}
              </button>
            </div>
            {#if draftError && draftBranch}<div class="err">{draftError}</div>{/if}
          </form>
        {:else}
          <button type="button" class="secondary" onclick={() => (naming = true)}>New branch…</button>
        {/if}
      </section>

      <section>
        <h4>Page</h4>
        <p class="note">
          Where this rail's agent sessions land. Unbound, Start gives the rail a page of its own,
          named after it.
        </p>
        <ul>
          <li>
            <button
              type="button"
              class:on={rail.pageId === null}
              onclick={() => void bindRailAction(workspaceId, rail.id, { pageId: null })}
            >
              <span class="path">None — a page of its own, made at Start</span>
            </button>
          </li>
          {#each pages as page (page.id)}
            <li>
              <button
                type="button"
                class:on={rail.pageId === page.id}
                onclick={() => void bindRailAction(workspaceId, rail.id, { pageId: page.id })}
              >
                <span class="path">{page.name}</span>
              </button>
            </li>
          {/each}
        </ul>
        <!-- Same honesty the branch list above shows: a binding to
             something gone reads as "unbound" otherwise, since nothing
             in the list is selected. -->
        {#if rail.pageId && !pages.some((p) => p.id === rail.pageId)}
          <p class="note">
            Bound to a page that has since been closed — Start will make a new one.
          </p>
        {/if}
        <button type="button" class="secondary" onclick={() => void bindNewPage()}>
          New page “{rail.name}”
        </button>
      </section>

      <div class="actions">
        <button type="button" onclick={onClose}>Done</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .bind {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 380px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  h4 {
    margin: 0 0 2px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .note {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--text-subtle);
  }
  ul {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    max-height: 30vh;
    overflow-y: auto;
  }
  li button {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 5px 7px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:hover {
    background: var(--surface-hover);
  }
  li button.on {
    border-color: var(--border-focus);
    background: var(--surface-accent);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch {
    color: var(--text-subtle);
    font-size: 10px;
  }
  .branch.warn {
    color: var(--warning-text);
  }
  .new-branch {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .new-branch input,
  .new-branch select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-family: monospace;
    font-size: 12px;
    padding: 4px 7px;
  }
  .new-branch input:focus,
  .new-branch select:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .new-branch .row {
    display: flex;
    gap: 6px;
  }
  .new-branch .secondary:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .err {
    color: var(--danger-text);
    font-size: 11px;
  }
  .secondary {
    align-self: flex-start;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
