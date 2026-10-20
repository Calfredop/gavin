<script lang="ts">
  // The "New agent tab" split button, beside a pane's "+": the face
  // opens a tab on the workspace's own agent, the chevron picks another
  // agent set up here. Policy lives in newAgentTab.ts.
  import { get } from "svelte/store";
  import {
    layoutState,
    addAgentTab,
    profilesForWorkspace,
    resolvedAgentFor,
  } from "$lib/core/layoutState";
  import { getActiveWorkspace } from "$lib/core/workspace";
  import { contextMenu, openMenuUnder } from "$lib/core/contextMenu";
  import { detectAgentBinaries } from "$lib/core/backend";
  import type { DetectedAgent } from "$lib/agents/agentDetect";
  import {
    agentTabChoices,
    newAgentTabEntries,
    NEW_AGENT_TAB_TITLE,
    PICK_AGENT_TITLE,
  } from "$lib/panes/newAgentTab";
  import { Bot, Plus, ChevronDown } from "@lucide/svelte";
  import IconButton from "$lib/ui/IconButton.svelte";

  let { target }: { target: string } = $props();

  // Same press/click dance as NewPageButton: the shared menu layer closes
  // on a pointerdown outside itself, before this click lands, so the
  // chevron that opened the menu could otherwise never close it.
  let dismissedMenu = false;

  function onPointerDown(): void {
    dismissedMenu = get(contextMenu) !== null;
  }

  // The PATH sweep runs at the moment of the pick, not once at mount: an
  // agent installed while the app was open should appear the next time
  // the menu does. It is a handful of PATH lookups; a failure offers
  // every profile rather than none (agentTabChoices).
  async function detected(): Promise<DetectedAgent[] | null> {
    try {
      return await detectAgentBinaries();
    } catch {
      return null;
    }
  }

  async function openMenu(event: MouseEvent): Promise<void> {
    const dismissed = dismissedMenu;
    dismissedMenu = false;
    if (dismissed) return;
    const anchor = event.currentTarget as HTMLElement;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return;
    const defaultId = resolvedAgentFor(ws.id).profileId;
    const choices = agentTabChoices(profilesForWorkspace(ws.id), await detected(), defaultId);
    openMenuUnder(
      anchor,
      newAgentTabEntries(choices, defaultId, (profileId) => void addAgentTab(target, profileId))
    );
  }
</script>

<span class="new-agent-tab">
  <IconButton icon={Bot} label={NEW_AGENT_TAB_TITLE} size={14} onclick={() => void addAgentTab(target)}>
    <span class="plus"><Plus size={9} strokeWidth={3} /></span>
  </IconButton>
  <IconButton
    icon={ChevronDown}
    label={PICK_AGENT_TITLE}
    size={12}
    class="chevron"
    onpointerdown={onPointerDown}
    onclick={(e: MouseEvent) => void openMenu(e)}
  />
</span>

<style>
  .new-agent-tab {
    display: inline-flex;
    align-items: center;
  }
  /* The "+" sits on the robot's shoulder rather than beside it, so the
     face reads as one glyph ("new agent") and not as two buttons. */
  .plus {
    position: absolute;
    right: 1px;
    top: 1px;
    display: inline-flex;
  }
  .new-agent-tab :global(.icon-button.chevron) {
    padding-left: 0;
    padding-right: 2px;
  }
</style>
