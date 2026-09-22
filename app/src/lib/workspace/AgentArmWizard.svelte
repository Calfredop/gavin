<script lang="ts">
  /// Setup-only arming for a fallback (or inherited default) agent.
  /// Integration and Superpowers run for the named profile; the workspace
  /// active agent and complexity table are not touched.
  import Modal from "$lib/core/Modal.svelte";
  import IntegrationStep from "$lib/wizardSteps/IntegrationStep.svelte";
  import SuperpowersStep from "$lib/wizardSteps/SuperpowersStep.svelte";
  import {
    agentDefaultsStore,
    agentModelDefaultsStore,
    agentProfilesStore,
    layoutState,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import { agentConfigWithAttribution } from "$lib/cards/complexity";
  import { resolveAgentConfig } from "$lib/core/settings";
  import * as backend from "$lib/core/backend";
  import {
    UNKNOWN_STATUS,
    type SuperpowersMark,
    type SuperpowersStatus,
  } from "$lib/agents/superpowers";
  import { AGENT_ARM_STEPS, nextAgentArmStep, type AgentArmStep } from "$lib/workspace/agentArm";
  import { sshLimitation } from "$lib/workspace/sshWorkspace";

  interface Props {
    workspaceId: string;
    profileId: string;
    onClose: () => void;
    onArmed: () => void;
  }
  let { workspaceId, profileId, onClose, onArmed }: Props = $props();

  const toLabel = $derived(
    $agentProfilesStore.find((p) => p.id === profileId)?.label ?? profileId
  );
  const pendingAgent = $derived(
    resolveAgentConfig(
      agentConfigWithAttribution($trustedAgentConfigs(workspaceId), {
        profile: profileId,
        model: "",
      }),
      $agentProfilesStore,
      $agentModelDefaultsStore,
      {
        command: $agentDefaultsStore.customCommand,
        modelFlag: $agentDefaultsStore.customModelFlag,
      }
    )
  );

  let current = $state<AgentArmStep>("integration");
  let superpowers = $state<SuperpowersStatus | undefined>(undefined);
  let superpowersMark = $state<SuperpowersMark | undefined>(undefined);
  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const sshBlocked = $derived(sshLimitation(ws));

  async function refreshSuperpowers(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    const [sp, marks] = await Promise.all([
      backend.superpowersStatus(root, pendingAgent.command, profileId).catch(() => UNKNOWN_STATUS),
      backend.getSuperpowersMarks().catch(() => ({}) as Record<string, SuperpowersMark>),
    ]);
    superpowers = sp;
    superpowersMark = marks[root];
  }

  $effect(() => {
    if (current !== "superpowers") return;
    void pendingAgent.command;
    void ws?.rootPath;
    void refreshSuperpowers();
  });

  function advance(): void {
    const next = nextAgentArmStep(current);
    if (!next) {
      onArmed();
      return;
    }
    current = next;
  }
</script>

<Modal wide onClose={onClose}>
  {#if sshBlocked}
    <!-- Arming writes MCP config and skills into the checkout on this
         machine; an ssh workspace's checkout is on the host. -->
    <div class="wizard">
      <p class="ssh-notice">{sshBlocked}</p>
      <div class="ssh-actions"><button type="button" onclick={onClose}>Close</button></div>
    </div>
  {:else}
  <div class="wizard">
    <header>
      <h2>Set up {toLabel} as a fallback</h2>
      <p class="hint">
        This does not change the workspace's agent. gavin writes MCP, skills and Superpowers for
        {toLabel} so it can run when the current agent's usage is spent.
      </p>
    </header>

    <ol class="steps">
      {#each AGENT_ARM_STEPS as step, i (step.id)}
        <li class:current={step.id === current} class:done={AGENT_ARM_STEPS.findIndex((s) => s.id === current) > i}>
          <span class="n">{i + 1}</span>
          {step.label}
        </li>
      {/each}
    </ol>

    <div class="body">
      {#if current === "integration"}
        <IntegrationStep
          {workspaceId}
          instructionsFile={pendingAgent.file}
          {profileId}
          onDone={advance}
        />
        <div class="actions below">
          <button type="button" class="ghost" onclick={onClose}>Cancel</button>
        </div>
      {:else}
        <SuperpowersStep
          {workspaceId}
          {profileId}
          status={superpowers}
          mark={superpowersMark}
          agentCommand={pendingAgent.command}
          onChanged={() => void refreshSuperpowers()}
          onDone={advance}
        />
        <div class="actions below">
          <button type="button" class="ghost" onclick={onArmed}>Skip remaining setup</button>
        </div>
      {/if}
    </div>
  </div>
  {/if}
</Modal>

<style>
  /* The one sentence shown in place of a surface an ssh workspace cannot
     use yet (sshWorkspace.ts's SSH_LIMITATION). */
  .ssh-notice {
    margin: 0 0 12px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-subtle);
  }
  .ssh-actions {
    display: flex;
    justify-content: flex-end;
  }
  .ssh-actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .wizard {
    width: 640px;
    max-width: 100%;
    min-width: 0;
  }
  header h2 {
    margin: 0 0 4px;
    font-size: 1.05em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    list-style: none;
    margin: 0 0 18px;
    padding: 0 0 12px;
    border-bottom: 1px solid #333;
    font-family: monospace;
    font-size: 0.8em;
    color: #777;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .steps li.current {
    color: #eee;
  }
  .steps li.done {
    color: #8bc98b;
  }
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid currentColor;
    font-size: 0.85em;
  }
  .body {
    min-height: 220px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .actions.below {
    margin-top: 8px;
    justify-content: flex-start;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.ghost {
    background: transparent;
    color: #888;
  }
</style>
