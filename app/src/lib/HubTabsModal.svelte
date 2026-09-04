<script lang="ts">
  // Which hub sections a strip draws, as a list of eyes. One component
  // for both scopes -- the app-wide default (opened from Settings) and
  // one workspace's own (opened from its Settings tab) -- because they
  // are the same question asked at two levels, and two components would
  // have drifted into two different answers about what "inherit" means.
  import { Eye, EyeOff } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { tooltip } from "./tooltip";
  import {
    canHideHubView,
    manageableHubViewIds,
    orderHubViewIds,
    toggleHubViewHidden,
  } from "./hubViewMeta";
  import { HUB_VIEWS } from "./workspaceViews";
  import {
    hubTabOrderByWorkspace,
    hubTabsHiddenByWorkspace,
    hubTabsHiddenDefault,
    setHubTabsHiddenDefault,
    setWorkspaceHubTabOrder,
    setWorkspaceHubTabsHidden,
    workspaceHasHubTabOrder,
    workspaceOverridesHubTabs,
  } from "./hubTabPrefs";
  import { agentModelDefaultsStore, agentProfilesStore } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig } from "./settings";
  import { hubLabel } from "./workspace";

  interface Props {
    /// The workspace whose strip this edits, or null/absent for the
    /// app-wide default every workspace that says nothing follows.
    workspaceId?: string | null;
    onClose: () => void;
  }
  let { workspaceId = null, onClose }: Props = $props();

  const overriding = $derived(
    workspaceId !== null && workspaceOverridesHubTabs(workspaceId, $hubTabsHiddenByWorkspace)
  );
  /// What this panel is editing right now. In the workspace scope that is
  /// the workspace's own list while it has one and the app-wide list
  /// while it does not -- the eyes show what the strip actually does, so
  /// the first click on an inheriting workspace starts from what it was
  /// already showing rather than from nothing hidden.
  const hidden = $derived(
    workspaceId === null
      ? $hubTabsHiddenDefault
      : ($hubTabsHiddenByWorkspace[workspaceId] ?? $hubTabsHiddenDefault)
  );
  const order = $derived(workspaceId === null ? null : ($hubTabOrderByWorkspace[workspaceId] ?? null));
  /// Listed in the order the strip draws them, so the panel and the row
  /// it edits read the same way round.
  const rows = $derived(
    orderHubViewIds(manageableHubViewIds(), order)
      .map((id) => HUB_VIEWS.find((v) => v.id === id))
      .filter((v): v is (typeof HUB_VIEWS)[number] => v !== undefined)
  );

  /// The CLAUDE.md tab is named after whatever the workspace's agent
  /// actually reads, so the row has to say what the tab says. The
  /// app-wide panel has no workspace and no agent, and falls back to the
  /// declared label.
  const agentFile = $derived(
    workspaceId === null
      ? "CLAUDE.md"
      : resolveAgentConfig(
          $gavinTrees[workspaceId]?.contexts.find((c) => c.kind === "root")?.agent ?? null,
          $agentProfilesStore,
          $agentModelDefaultsStore
        ).file
  );

  function toggle(id: string): void {
    const next = toggleHubViewHidden(hidden, id);
    if (workspaceId === null) setHubTabsHiddenDefault(next);
    else setWorkspaceHubTabsHidden(workspaceId, next);
  }

  /// Clears the workspace's entry rather than copying the default into
  /// it, so a later change to the default still reaches this workspace --
  /// absence IS the inheritance.
  function followDefault(): void {
    if (workspaceId !== null) setWorkspaceHubTabsHidden(workspaceId, null);
  }

  function resetOrder(): void {
    if (workspaceId !== null) setWorkspaceHubTabOrder(workspaceId, null);
  }
</script>

<Modal {onClose}>
  <div class="hub-tabs">
    <h2>Hub tabs</h2>
    <p class="hint">
      {#if workspaceId === null}
        Which sections every workspace offers, unless it keeps a list of its own. Hiding one takes
        its tab out of the row and out of ⌘-number; nothing in it is closed, and the sidebar's
        chips still reach it.
      {:else}
        Which sections this workspace's tab row offers. Hiding one takes its tab out of the row and
        out of ⌘-number; nothing in it is closed, and the sidebar's chips still reach it.
      {/if}
    </p>

    <ul class="views">
      {#each rows as view (view.id)}
        {@const off = hidden.includes(view.id)}
        {@const locked = !canHideHubView(hidden, view.id)}
        <!-- The reason hangs on the ROW, not on the button: a disabled
             button never fires mouseenter, so a tooltip on it is a
             control that cannot explain itself. -->
        <li
          class:off
          use:tooltip={locked ? "The last section left has to stay" : ""}
        >
          <view.icon size={14} />
          <span class="label">{hubLabel(view, agentFile)}</span>
          <IconButton
            icon={off ? EyeOff : Eye}
            label={off ? `Show ${hubLabel(view, agentFile)}` : `Hide ${hubLabel(view, agentFile)}`}
            size={14}
            disabled={locked}
            onclick={() => toggle(view.id)}
          />
        </li>
      {/each}
    </ul>

    {#if workspaceId !== null}
      <div class="scope">
        <span>{overriding ? "This workspace keeps its own list." : "Following the app-wide default."}</span>
        {#if overriding}
          <button type="button" onclick={followDefault}>Follow the default</button>
        {/if}
      </div>
      {#if workspaceHasHubTabOrder(workspaceId, $hubTabOrderByWorkspace)}
        <div class="scope">
          <span>These tabs have been rearranged.</span>
          <button type="button" onclick={resetOrder}>Reset the order</button>
        </div>
      {/if}
    {/if}

    <div class="actions">
      <button type="button" onclick={onClose}>Done</button>
    </div>
  </div>
</Modal>

<style>
  /* The same family as GlobalSettingsModal and SettingsHubView: one look
     for every panel that edits a preference. */
  .hub-tabs {
    display: flex;
    flex-direction: column;
    gap: 14px;
    font-size: 0.85em;
    min-width: 380px;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  .hint {
    color: var(--text-subtle);
    margin: 0;
  }
  .views {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .views li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 10px;
    color: var(--text);
  }
  .views li + li {
    border-top: 1px solid var(--border);
  }
  /* Dimmed, not struck through or moved: the row still says where the
     tab would sit if it came back. */
  .views li.off {
    color: var(--text-subtle);
  }
  .label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scope {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
</style>
