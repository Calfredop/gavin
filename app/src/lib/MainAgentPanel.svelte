<script lang="ts">
  import TerminalPane from "./TerminalPane.svelte";
  import {
    layoutState,
    startMainAgent,
    stopMainAgent,
    setAgentField,
    resolvedAgentFor,
    terminalFontSizeDefault,
  } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveTerminalFontSize } from "./terminalFont";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const sessionId = $derived(ws?.mainSessionId ?? null);
  // Resolved against THIS workspace rather than through layoutState's
  // active-workspace store: the panel is handed a workspaceId, and a panel
  // that reads the size of whichever workspace happens to be on screen
  // would be right only by coincidence.
  const fontSize = $derived(
    resolveTerminalFontSize(ws?.terminalFontSize, $terminalFontSizeDefault)
  );

  let commandDraft = $state("");
  let draftFor = $state<string | null>(null);
  $effect(() => {
    if (draftFor !== workspaceId) {
      // Resolved from config.toml + the profile table (D41), the same
      // value Settings edits. Reading $gavinTrees keeps this reactive to
      // an external config.toml edit.
      void $gavinTrees;
      commandDraft = resolvedAgentFor(workspaceId).command;
      draftFor = workspaceId;
    }
  });

  let pane = $state<{ fit: () => void } | null>(null);
  // The terminal measures itself on mount; a pane mounted in a hidden or
  // just-resized grid cell needs a nudge (the same trap CodeMirror has).
  export function fit(): void {
    pane?.fit();
  }

  function start(): void {
    void setAgentField(workspaceId, "command", commandDraft).then(() => startMainAgent(workspaceId));
  }
</script>

<div class="agent">
  <div class="head">
    <span class="label">Main agent</span>
    {#if sessionId}
      <button type="button" onclick={() => void stopMainAgent(workspaceId)}>Stop</button>
    {/if}
  </div>
  {#if sessionId}
    <div class="terminal">
      <!-- Keyed, because nothing above this panel is rebuilt when the
           workspace changes: the hub renders <activeViewDef.component>,
           which is the same HomeHubView value for every workspace, so
           switching between two workspaces that both have an agent
           running only updates props all the way down to here. A
           TerminalPane binds its session in onMount and never re-reads
           it, so without the key the pane would keep the previous
           workspace's terminal on screen while fit() reported that
           terminal's measurements to THIS workspace's session --
           resizing an agent to a geometry its program never drew for.
           Pane.svelte owes the same contract and pays it with an {#each}
           keyed by sessionId. -->
      {#key sessionId}
        <TerminalPane bind:this={pane} {sessionId} visible={true} focused={false} {fontSize} />
      {/key}
    </div>
  {:else}
    <div class="idle">
      <p>No agent running in this workspace.</p>
      <div class="launcher">
        <input
          bind:value={commandDraft}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === "Enter") start();
          }}
        />
        <button type="button" onclick={start}>Start main agent</button>
      </div>
      <p class="hint">Runs at the workspace root. Nothing starts on its own.</p>
    </div>
  {/if}
</div>

<style>
  .agent {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-family: monospace;
    font-size: 0.75em;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .head button,
  .launcher button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
    text-transform: none;
  }
  .terminal {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .idle {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
    padding: 16px;
    text-align: center;
  }
  .launcher {
    display: flex;
    gap: 6px;
  }
  .launcher input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 220px;
  }
  .hint {
    font-size: 0.9em;
    opacity: 0.7;
  }
</style>
