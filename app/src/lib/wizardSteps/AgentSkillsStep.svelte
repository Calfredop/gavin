<script lang="ts">
  import { agentDefaultsStore, agentModelDefaultsStore, agentProfilesStore, layoutState, trustedAgentConfigs } from "$lib/core/layoutState";
  import { resolveAgentConfig } from "$lib/core/settings";
  import * as backend from "$lib/core/backend";
  import AgentSkillsControls from "$lib/agents/AgentSkillsControls.svelte";
  import { AGENT_SKILLS_NAME, type AgentSkillsMark, type AgentSkillsStatus } from "$lib/agents/agentSkills";

  interface Props {
    workspaceId: string;
    /// Owned by the wizard, because the stepper's tick for this step is
    /// derived from the same two values.
    status: AgentSkillsStatus | undefined;
    mark: AgentSkillsMark | undefined;
    onChanged: () => void;
    onDone: () => void;
    /// When set, the install/status probe uses this command instead of
    /// the workspace's currently resolved one. The agent-change wizard
    /// passes the PENDING profile's command so the skills are checked
    /// for the agent being switched to.
    agentCommand?: string;
    /// Arm THIS profile rather than the workspace's active agent.
    /// Fallback arming sets it so the install sets up the chain agent,
    /// not the workspace's own.
    profileId?: string;
  }
  let { workspaceId, status, mark, onChanged, onDone, agentCommand: agentCommandOverride, profileId }: Props =
    $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const agentCommand = $derived(
    agentCommandOverride ??
      resolveAgentConfig(
        $trustedAgentConfigs(workspaceId),
        $agentProfilesStore,
        $agentModelDefaultsStore,
        undefined,
        undefined,
        undefined,
        $agentDefaultsStore.defaultAgent
      ).command
  );

  let error = $state<string | null>(null);

  /// "Not now" is a decision, and recording it is what stops the Home
  /// banner asking again. Continuing without it leaves the step
  /// genuinely unfinished, which is the honest state for someone who
  /// just clicked past.
  async function notNow(): Promise<void> {
    if (!ws?.rootPath) {
      onDone();
      return;
    }
    error = null;
    try {
      await backend.setAgentSkillsMark(ws.rootPath, "skipped");
    } catch (e) {
      error = String(e);
      return;
    }
    onChanged();
    onDone();
  }
</script>

<h3>{AGENT_SKILLS_NAME}</h3>
<p class="hint">
  Small, composable engineering skills for your agent, built around grilling first: get questioned
  about what you want before anything is built (<code>/grill-with-docs</code>), drive the work
  test-first (<code>/tdd</code>), and find a bug by narrowing rather than guessing
  (<code>/diagnosing-bugs</code>). <code>/ask-matt</code> routes you to the right one. gavin's own
  cards and rails already cover the ticket side of Matt's flow. Optional: gavin works without them.
</p>
<p class="hint">
  <code>/setup-matt-pocock-skills</code> (issue tracker, triage labels, where docs go) is optional,
  and yours to run in your agent once they are installed.
</p>

{#if status}
  <AgentSkillsControls rootPath={ws?.rootPath ?? null} {agentCommand} {profileId} {status} {mark} {onChanged} />
  {#if error}
    <p class="warn">{error}</p>
  {/if}
  <div class="actions">
    <button type="button" class="ghost" onclick={() => void notNow()}>Not now</button>
    <button type="button" onclick={onDone}>Continue →</button>
  </div>
{:else}
  <p class="hint">Checking…</p>
{/if}

<style>
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .hint code {
    color: #bbb;
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
    background: none;
    color: #888;
  }
</style>
