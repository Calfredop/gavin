<script lang="ts">
  import {
    layoutState,
    agentProfilesStore,
    agentModelDefaultsStore,
    startMainAgentWithPrompt,
  } from "./../layoutState";
  import { gavinTrees } from "./../gavinState";
  import { resolveAgentConfig } from "./../settings";
  import { applyPrdSections, agentFlowAvailable } from "./../setupWizard";
  import * as backend from "./../backend";

  interface Props {
    workspaceId: string;
    prdBody: string | null;
    /// The workspace's PRD, relative to its root. Passed down rather than
    /// re-derived so the step writes back to the same file the wizard
    /// read from -- they must not resolve it independently.
    prdPath: string;
    onDone: () => void;
  }
  let { workspaceId, prdBody, prdPath, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const agentCfg = $derived(
    resolveAgentConfig(
      tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );
  const profile = $derived($agentProfilesStore.find((p) => p.id === agentCfg.profileId));
  const canAsk = $derived(agentFlowAvailable(profile) && !ws?.mainSessionId);

  let vision = $state("");
  let focus = $state("");
  let outOfScope = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function saveMine(): Promise<void> {
    if (!ws?.rootPath || prdBody === null) return onDone();
    busy = true;
    error = null;
    try {
      const next = applyPrdSections(prdBody, { vision, focus, outOfScope });
      if (next !== prdBody) {
        await backend.writeFileForEditor(`${ws.rootPath}/${prdPath}`, next);
      }
      onDone();
    } catch (e) {
      error = String(e);
    }
    busy = false;
  }

  async function askAgent(): Promise<void> {
    if (!ws?.rootPath) return;
    busy = true;
    error = null;
    try {
      const prompt = await backend.composeAgentPrompt(ws.rootPath, "prd");
      await startMainAgentWithPrompt(workspaceId, prompt);
      onDone();
    } catch (e) {
      error = String(e);
    }
    busy = false;
  }
</script>

<h3>The PRD</h3>
<p class="hint">
  The lead document for this workspace. Your agent reads it first; plans trace back to it. Anything
  you leave blank keeps its placeholder.
</p>

<label class="field">
  <span>Vision — what are we building, for whom, and why?</span>
  <textarea bind:value={vision} rows="3"></textarea>
</label>
<label class="field">
  <span>Current focus</span>
  <textarea bind:value={focus} rows="2"></textarea>
</label>
<label class="field">
  <span>Out of scope</span>
  <textarea bind:value={outOfScope} rows="2"></textarea>
</label>

{#if error}
  <p class="warn">{error}</p>
{/if}

<div class="actions">
  <button type="button" onclick={onDone}>Skip</button>
  {#if canAsk}
    <button type="button" disabled={busy} onclick={() => void askAgent()}>Ask the agent →</button>
  {/if}
  <button type="button" disabled={busy} onclick={() => void saveMine()}>Continue →</button>
</div>
{#if profile && !profile.promptArg}
  <p class="hint">“Ask the agent” isn’t available for {profile.label} yet.</p>
{/if}

<style>
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 14px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .field {
    display: block;
    margin-bottom: 10px;
    font-family: monospace;
    font-size: 0.8em;
    color: #999;
  }
  .field span {
    display: block;
    margin-bottom: 4px;
  }
  .field textarea {
    width: 100%;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
    resize: vertical;
  }
  .warn {
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
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
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
