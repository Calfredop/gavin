<script lang="ts">
  import Modal from "./Modal.svelte";
  import GitForkDialog from "./GitForkDialog.svelte";
  import { gitStore } from "./gitState";
  import { gavinTrees } from "./gavinState";
  import { layoutState, createPage, resolvedAgentFor } from "./layoutState";
  import { bindRailAction } from "./orchestrationState";
  import { presetSingle } from "./layout";
  import type { Rail } from "./orchestration";

  interface Props {
    workspaceId: string;
    rail: Rail;
    onClose: () => void;
  }
  let { workspaceId, rail, onClose }: Props = $props();

  let forking = $state(false);

  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? []);
  const pages = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.pages ?? []);

  /// The checkout this rail's steps run in — its own worktree, or the
  /// workspace root when it has none. Spelled exactly as
  /// `executeToolLaunch` spells it, so a page made here opens where the
  /// rail's own Start would have opened it.
  const tree = $derived($gavinTrees[workspaceId]);
  const railCheckout = $derived(
    rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null)
  );

  /// The same page Start would spawn on its own (spec O16), made early:
  /// named after the rail, opened in the rail's checkout.
  async function bindNewPage(): Promise<void> {
    const pageId = await createPage(workspaceId, (ids) => presetSingle(ids[0]), 1, rail.name, {
      cwd: railCheckout ?? undefined,
    });
    if (pageId) await bindRailAction(workspaceId, rail.id, { pageId });
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
