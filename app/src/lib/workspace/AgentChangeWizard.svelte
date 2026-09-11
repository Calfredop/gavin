<script lang="ts">
  /// Confirm mini-wizard for switching a workspace's agent profile.
  /// Complexity is chosen first; advancing from that step writes the new
  /// profile and the realigned complexity table. Integration and
  /// Superpowers then set up the new agent. Cancel before the write
  /// leaves config untouched; closing afterwards only skips leftover setup.
  import Modal from "$lib/core/Modal.svelte";
  import IntegrationStep from "$lib/wizardSteps/IntegrationStep.svelte";
  import SuperpowersStep from "$lib/wizardSteps/SuperpowersStep.svelte";
  import {
    agentDefaultsStore,
    agentModelDefaultsStore,
    agentProfilesStore,
    layoutState,
    setWorkspaceComplexityTable,
    trustedAgentConfigs,
    workspaceComplexityTable,
  } from "$lib/core/layoutState";
  import {
    agentConfigWithAttribution,
    recommendedComplexityAction,
    realignComplexityTable,
    type ComplexityRealignAction,
  } from "$lib/cards/complexity";
  import { resolveAgentConfig } from "$lib/core/settings";
  import * as backend from "$lib/core/backend";
  import {
    UNKNOWN_STATUS,
    type SuperpowersMark,
    type SuperpowersStatus,
  } from "$lib/agents/superpowers";
  import {
    AGENT_CHANGE_STEPS,
    agentChangeCommitsOnAdvance,
    nextAgentChangeStep,
    type AgentChangeStep,
  } from "$lib/workspace/agentChange";

  interface Props {
    workspaceId: string;
    /// Profile id currently written for this workspace.
    fromProfileId: string;
    /// Profile id the human just picked.
    toProfileId: string;
    onClose: () => void;
  }
  let { workspaceId, fromProfileId, toProfileId, onClose }: Props = $props();

  const fromLabel = $derived(
    $agentProfilesStore.find((p) => p.id === fromProfileId)?.label ?? fromProfileId
  );
  const toLabel = $derived(
    $agentProfilesStore.find((p) => p.id === toProfileId)?.label ?? toProfileId
  );
  const complexityTable = $derived(workspaceComplexityTable(workspaceId));
  const defaultAction = $derived(recommendedComplexityAction(complexityTable, fromProfileId));

  let current = $state<AgentChangeStep>("complexity");
  let action = $state<ComplexityRealignAction | null>(null);
  let committing = $state(false);
  let commitError = $state<string | null>(null);
  let committed = $state(false);

  // Superpowers probe for the PENDING agent. Owned here so the step can
  // refresh after Install / Not now without the init wizard's machinery.
  let superpowers = $state<SuperpowersStatus | undefined>(undefined);
  let superpowersMark = $state<SuperpowersMark | undefined>(undefined);

  /// Resolve the agent being switched TO: profile overlay drops the
  /// workspace's old command/file/mcp so setup targets the new CLI's
  /// defaults rather than the previous profile's leftovers.
  const pendingAgent = $derived(
    resolveAgentConfig(
      agentConfigWithAttribution($trustedAgentConfigs(workspaceId), {
        profile: toProfileId,
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

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);

  async function refreshSuperpowers(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    const [sp, marks] = await Promise.all([
      backend.superpowersStatus(root, pendingAgent.command).catch(() => UNKNOWN_STATUS),
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

  async function commitChange(): Promise<boolean> {
    const chosen = action ?? defaultAction;
    const root = ws?.rootPath;
    if (!root) {
      commitError = "Bind a root folder before switching agent.";
      return false;
    }
    committing = true;
    commitError = null;
    try {
      const nextTable = realignComplexityTable(
        complexityTable,
        chosen,
        fromProfileId,
        toProfileId
      );
      // Through the backend directly so a refused write surfaces here
      // rather than only on the global error banner — setAgentField
      // swallows the error. Profile is not a trust-gated key, so skipping
      // its stamp is fine.
      await backend.setRootConfigField(root, "profile", toProfileId);
      await setWorkspaceComplexityTable(workspaceId, nextTable);
      committed = true;
      return true;
    } catch (e) {
      commitError = String(e);
      return false;
    } finally {
      committing = false;
    }
  }

  async function advance(): Promise<void> {
    if (agentChangeCommitsOnAdvance(current) && !committed) {
      const ok = await commitChange();
      if (!ok) return;
    }
    const next = nextAgentChangeStep(current);
    if (!next) {
      onClose();
      return;
    }
    current = next;
  }

  function cancel(): void {
    // After the write, closing only skips leftover setup — the profile
    // change already landed. Before it, nothing was touched.
    onClose();
  }

  const chosenAction = $derived(action ?? defaultAction);
</script>

<Modal wide onClose={cancel}>
  <div class="wizard">
    <header>
      <h2>Switch agent to {toLabel}</h2>
      <p class="hint">
        From {fromLabel}. Complexity is realigned first; then gavin checks MCP, skills and
        Superpowers for the new agent.
      </p>
    </header>

    <ol class="steps">
      {#each AGENT_CHANGE_STEPS as step, i (step.id)}
        <li
          class:current={step.id === current}
          class:done={AGENT_CHANGE_STEPS.findIndex((s) => s.id === current) > i ||
            (committed && step.id === "complexity")}
        >
          <span class="n">{i + 1}</span>
          {step.label}
        </li>
      {/each}
    </ol>

    <div class="body">
      {#if current === "complexity"}
        <h3>Complexity</h3>
        <p class="hint">
          App-level pins still fall through for levels this workspace leaves alone. Choose what to
          do with this workspace's own complexity rows before the profile is written.
        </p>
        <fieldset class="choices">
          <label class="choice">
            <input
              type="radio"
              name="realign"
              checked={chosenAction === "remap"}
              onchange={() => (action = "remap")}
            />
            <span>
              <strong>Remap</strong> — rows that named {fromLabel} now name {toLabel}. Other pins
              stay.
              {#if defaultAction === "remap"}
                <em class="rec">Recommended</em>
              {/if}
            </span>
          </label>
          <label class="choice">
            <input
              type="radio"
              name="realign"
              checked={chosenAction === "clear"}
              onchange={() => (action = "clear")}
            />
            <span>
              <strong>Clear</strong> — drop every workspace override so unset levels mean this
              workspace's new agent (app pins still apply).
              {#if defaultAction === "clear"}
                <em class="rec">Recommended</em>
              {/if}
            </span>
          </label>
          <label class="choice">
            <input
              type="radio"
              name="realign"
              checked={chosenAction === "keep"}
              onchange={() => (action = "keep")}
            />
            <span>
              <strong>Keep</strong> — leave workspace complexity rows alone.
            </span>
          </label>
        </fieldset>
        {#if commitError}
          <p class="warn">{commitError}</p>
        {/if}
        <div class="actions">
          <button type="button" class="ghost" onclick={cancel}>Cancel</button>
          <button type="button" disabled={committing} onclick={() => void advance()}>
            {committing ? "Switching…" : "Switch agent →"}
          </button>
        </div>
      {:else if current === "integration"}
        <IntegrationStep
          {workspaceId}
          instructionsFile={pendingAgent.file}
          onDone={() => void advance()}
        />
        <div class="actions below">
          <button type="button" class="ghost" onclick={cancel}>Skip remaining setup</button>
        </div>
      {:else}
        <SuperpowersStep
          {workspaceId}
          status={superpowers}
          mark={superpowersMark}
          agentCommand={pendingAgent.command}
          onChanged={() => void refreshSuperpowers()}
          onDone={() => void advance()}
        />
        <div class="actions below">
          <button type="button" class="ghost" onclick={cancel}>Skip remaining setup</button>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
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
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .choices {
    border: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .choice {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-family: monospace;
    font-size: 0.85em;
    color: #ccc;
    cursor: pointer;
  }
  .choice strong {
    color: #eee;
  }
  .rec {
    margin-left: 6px;
    color: #8bc98b;
    font-style: normal;
    font-size: 0.9em;
  }
  .warn {
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
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
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
