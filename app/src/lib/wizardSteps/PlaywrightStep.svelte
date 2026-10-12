<script lang="ts">
  import { layoutState } from "$lib/core/layoutState";
  import * as backend from "$lib/core/backend";
  import { RESTART_NOTE } from "$lib/agents/agentSkills";
  import {
    PLAYWRIGHT_NAME,
    playwrightActionLabel,
    playwrightStepView,
    savePlaywrightMark,
    type PlaywrightMark,
    type PlaywrightReading,
  } from "$lib/agents/playwrightSetup";

  interface Props {
    workspaceId: string;
    /// Owned by the wizard, because the stepper's tick for this step is
    /// derived from the same two values.
    reading: PlaywrightReading | undefined;
    mark: PlaywrightMark | undefined;
    onChanged: () => void;
    onDone: () => void;
  }
  let { workspaceId, reading, mark, onChanged, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath || null);
  // The install's own answer, kept over the wizard's reread: it carries
  // the install's output for the drawer, which a fresh check would not.
  let installed = $state<PlaywrightReading | null>(null);
  const shown = $derived(installed ?? reading);
  const view = $derived(shown ? playwrightStepView(shown, mark) : null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let showOutput = $state(false);

  /// Installs what is missing. Takes back an earlier "not now": the human
  /// just said yes, and an install that fails should ask again.
  async function install(replace: boolean): Promise<void> {
    if (!root) return;
    busy = true;
    error = null;
    try {
      const status = await backend.playwrightInstall(root, replace);
      installed = { kind: "status", status };
      if (mark === "skipped") savePlaywrightMark(root, null);
      onChanged();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  /// "Not now" is a decision, recorded per machine and root, and it is
  /// what finishes the step without Playwright -- never a fake "ready".
  function notNow(): void {
    if (root) savePlaywrightMark(root, "skipped");
    onChanged();
    onDone();
  }

  /// The human's word, where gavin could not look for itself.
  function vouch(): void {
    if (root) savePlaywrightMark(root, "installed");
    onChanged();
  }
</script>

<h3>{PLAYWRIGHT_NAME}</h3>
<p class="hint">
  A real browser for your agents to check their own UI work in, through Playwright's MCP server
  (<code>browser_navigate</code>, <code>browser_click</code>, <code>browser_snapshot</code>, …). Each
  agent session gets a headless Chromium of its own, started on its first browser call and closed
  with the session. Install downloads Chrome Headless Shell (about 200 MB) into Playwright's cache and
  adds a <code>playwright</code> server to this agent's MCP config. Needs Node.js. Optional.
</p>

{#if !view}
  <p class="hint">Checking…</p>
{:else}
  <div class="row">
    <span class="label tone-{view.tone}">{view.label}</span>
    <span class="line">{view.line}</span>
  </div>

  {#if view.checks.length > 0}
    <ul class="checks">
      {#each view.checks as check (check.id)}
        <li class:ok={check.ok === true} class:missing={check.ok === false}>
          <span class="mark">{check.ok === true ? "✓" : check.ok === false ? "✗" : "–"}</span>
          {check.line}
        </li>
      {/each}
    </ul>
  {/if}

  {#if view.conflict && view.action === "replace"}
    <p class="hint">
      Replace removes <code>{[view.conflict.command, ...view.conflict.args].join(" ")}</code> from
      <code>{view.conflict.file}</code>.
    </p>
  {/if}

  {#if view.manualCommand}
    <p class="hint">To install the browser yourself: <code>{view.manualCommand}</code></p>
  {/if}

  {#if view.output}
    <button type="button" class="link" onclick={() => (showOutput = !showOutput)}>
      {showOutput ? "Hide output" : "Show output"}
    </button>
    {#if showOutput}
      <pre class="output">{view.output}</pre>
    {/if}
  {/if}

  {#if error}
    <p class="warn">{error}</p>
  {/if}
  <p class="hint">{RESTART_NOTE}</p>

  <div class="actions">
    <button type="button" class="ghost" onclick={notNow}>Not now</button>
    {#if view.assert}
      <button type="button" onclick={vouch}>I've set it up</button>
    {/if}
    {#if view.action}
      {@const action = view.action}
      <button type="button" disabled={busy} onclick={() => void install(action === "replace")}>
        {busy ? "Installing…" : playwrightActionLabel(action)}
      </button>
    {/if}
    <button type="button" onclick={onDone}>Continue →</button>
  </div>
{/if}

<style>
  /* On the theme's text roles and surfaces rather than the literal greys
     the older steps carry, which the light theme reads at 3.5:1 or
     worse (theme-text-on-fills-and-literal-colours-contrast.md). */
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: var(--text);
  }
  .hint {
    margin: 0 0 16px;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.8em;
  }
  .hint code {
    color: var(--text-muted);
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
  }
  .label {
    flex: none;
    font-weight: bold;
  }
  .tone-on {
    color: var(--success-text);
  }
  .tone-claimed,
  .tone-off {
    color: var(--warning-text);
  }
  .tone-unknown {
    color: var(--text-subtle);
  }
  .line {
    min-width: 0;
  }
  .checks {
    list-style: none;
    margin: 10px 0 16px;
    padding: 0;
    font-family: monospace;
    font-size: 0.8em;
    color: var(--text-subtle);
  }
  .checks li {
    display: flex;
    gap: 8px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .checks li.ok .mark {
    color: var(--success-text);
  }
  .checks li.missing .mark {
    color: var(--warning-text);
  }
  .mark {
    flex: none;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    margin: 0 0 12px;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.8em;
    text-decoration: underline;
    cursor: pointer;
  }
  .output {
    max-height: 200px;
    overflow: auto;
    margin: 0 0 16px;
    padding: 8px 10px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 0.75em;
    white-space: pre-wrap;
  }
  .warn {
    color: var(--warning-text);
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
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions button.ghost {
    background: none;
    color: var(--text-subtle);
  }
</style>
