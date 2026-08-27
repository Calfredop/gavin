<script lang="ts">
  import { layoutState, closeWizard, agentProfilesStore, agentModelDefaultsStore} from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig, resolvePrdPath } from "./settings";
  import { setupProgress, type SetupStep } from "./setupWizard";
  import * as backend from "./backend";
  import Modal from "./Modal.svelte";
  import AgentStep from "./wizardSteps/AgentStep.svelte";
  import IntegrationStep from "./wizardSteps/IntegrationStep.svelte";
  import PrdStep from "./wizardSteps/PrdStep.svelte";
  import LaunchStep from "./wizardSteps/LaunchStep.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const STEPS: Array<{ id: SetupStep; label: string }> = [
    { id: "agent", label: "Agent" },
    { id: "integration", label: "Integration" },
    { id: "prd", label: "PRD" },
    { id: "launch", label: "Launch" },
  ];

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agentCfg = $derived(resolveAgentConfig(rootContext?.agent ?? null, $agentProfilesStore, $agentModelDefaultsStore));
  const prdPath = $derived(resolvePrdPath(rootContext));

  // The two file bodies the derivation needs. Re-read on demand rather
  // than watched: the wizard is short-lived, so a watcher would be more
  // machinery than the case deserves.
  let agentFileBody = $state<string | null>(null);
  let prdBody = $state<string | null>(null);

  async function reread(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    const [agentFile, prd] = await Promise.all([
      backend.readFileForViewer(`${root}/${agentCfg.file}`).catch(() => null),
      backend.readFileForViewer(`${root}/${prdPath}`).catch(() => null),
    ]);
    agentFileBody = agentFile?.exists ? agentFile.content : null;
    prdBody = prd?.exists ? prd.content : null;
  }

  $effect(() => {
    void agentCfg.file;
    void prdPath;
    void ws?.rootPath;
    void reread();
  });

  const progress = $derived(
    setupProgress({
      hasRoot: Boolean(ws?.rootPath),
      configCommand: rootContext?.agent?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
    })
  );

  let current = $state<SetupStep>("agent");
  let started = $state(false);
  // Open at the first unfinished step -- once, so advancing through a
  // step does not immediately bounce you somewhere else.
  $effect(() => {
    if (!started && progress.next) {
      current = progress.next;
      started = true;
    }
  });

  function advance(): void {
    void reread();
    const i = STEPS.findIndex((s) => s.id === current);
    if (i < STEPS.length - 1) current = STEPS[i + 1].id;
    else closeWizard();
  }
</script>

{#if ws}
  <Modal onClose={closeWizard}>
    <div class="wizard">
      <ol class="steps">
        {#each STEPS as step, i (step.id)}
          <li class:current={step.id === current} class:done={progress.done.includes(step.id)}>
            <span class="n">{i + 1}</span>
            {step.label}
          </li>
        {/each}
      </ol>

      <div class="body">
        {#if current === "agent"}
          <AgentStep {workspaceId} onDone={advance} />
        {:else if current === "integration"}
          <IntegrationStep {workspaceId} onDone={advance} />
        {:else if current === "prd"}
          <PrdStep {workspaceId} {prdBody} {prdPath} onDone={advance} />
        {:else}
          <LaunchStep {workspaceId} onDone={closeWizard} />
        {/if}
      </div>
    </div>
  </Modal>
{/if}

<style>
  .wizard {
    min-width: 520px;
    max-width: 640px;
  }
  .steps {
    display: flex;
    gap: 14px;
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
</style>
