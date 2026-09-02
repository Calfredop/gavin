<script lang="ts">
  import { layoutState, closeWizard, agentProfilesStore, agentModelDefaultsStore} from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig, resolvePrdPath } from "./settings";
  import { setupProgress, type SetupStep } from "./setupWizard";
  import { UNKNOWN_STATUS, type SuperpowersMark, type SuperpowersStatus } from "./superpowers";
  import * as backend from "./backend";
  import Modal from "./Modal.svelte";
  import AgentStep from "./wizardSteps/AgentStep.svelte";
  import IntegrationStep from "./wizardSteps/IntegrationStep.svelte";
  import PrdStep from "./wizardSteps/PrdStep.svelte";
  import SuperpowersStep from "./wizardSteps/SuperpowersStep.svelte";
  import LaunchStep from "./wizardSteps/LaunchStep.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const STEPS: Array<{ id: SetupStep; label: string }> = [
    { id: "agent", label: "Agent" },
    { id: "integration", label: "Integration" },
    { id: "superpowers", label: "Superpowers" },
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
  // machinery than the case deserves. undefined until the first read
  // lands -- null is already "no such file", and the step to open on is
  // decided once, so reading an unfinished load as an unfinished step
  // opened the wizard on the wrong one for good.
  let agentFileBody = $state<string | null | undefined>(undefined);
  let prdBody = $state<string | null | undefined>(undefined);
  // The Superpowers check joins them, undefined for the same reason: a
  // detector still running is not a detector that found nothing.
  let superpowers = $state<SuperpowersStatus | undefined>(undefined);
  let superpowersMark = $state<SuperpowersMark | undefined>(undefined);

  async function reread(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    const [agentFile, prd, sp, marks] = await Promise.all([
      backend.readFileForViewer(`${root}/${agentCfg.file}`).catch(() => null),
      backend.readFileForViewer(`${root}/${prdPath}`).catch(() => null),
      // A detector that threw still has to settle the pending flag, or
      // the wizard never renders at all. UNKNOWN_STATUS is the honest
      // stand-in: it offers no button and completes no step.
      backend.superpowersStatus(root).catch(() => UNKNOWN_STATUS),
      backend.getSuperpowersMarks().catch(() => ({}) as Record<string, SuperpowersMark>),
    ]);
    agentFileBody = agentFile?.exists ? agentFile.content : null;
    prdBody = prd?.exists ? prd.content : null;
    superpowers = sp;
    superpowersMark = marks[root];
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
      superpowers,
      superpowersMark,
    })
  );

  let current = $state<SetupStep>("agent");
  let started = $state(false);
  // Open at the first unfinished step -- once, so advancing through a
  // step does not immediately bounce you somewhere else. That one shot
  // has to wait for the reads: latching on a pending derivation is
  // latching on "nothing is done yet".
  $effect(() => {
    if (started || progress.pending) return;
    if (progress.next) current = progress.next;
    // Latched even when everything is done: the answer is settled, and a
    // reopened wizard on a complete workspace still has to land on a step.
    started = true;
  });

  function advance(): void {
    void reread();
    const i = STEPS.findIndex((s) => s.id === current);
    if (i < STEPS.length - 1) current = STEPS[i + 1].id;
    else closeWizard();
  }
</script>

<!-- Held until the reads settle: the modal's first frame is the one
     that picks the step, so showing it early shows the wrong step. -->
{#if ws && !progress.pending}
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
        {:else if current === "superpowers"}
          <SuperpowersStep
            {workspaceId}
            status={superpowers}
            mark={superpowersMark}
            onChanged={() => void reread()}
            onDone={advance}
          />
        {:else if current === "prd"}
          <!-- integrationDone comes from the same derivation the stepper
               draws, so a PRD repointed here rewrites the integration
               files exactly when there are files to rewrite. -->
          <PrdStep
            {workspaceId}
            {prdBody}
            {prdPath}
            integrationDone={progress.done.includes("integration")}
            onDone={advance}
          />
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
