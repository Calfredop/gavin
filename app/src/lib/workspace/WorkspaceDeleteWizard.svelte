<script lang="ts">
  /// Renders `workspaceDelete.ts`'s machine. Every decision -- which
  /// screens exist, what each answer means, what the plan adds up to --
  /// lives in that module; this file is the template over it, and the
  /// one thing it decides on its own is which screen is on screen.
  ///
  /// Nothing is removed until Delete on the last screen. Back always
  /// works, and every answer is a stored boolean until then.
  import Modal from "$lib/core/Modal.svelte";
  import { layoutState } from "$lib/core/layoutState";
  import { allSessionIdsInWorkspace } from "$lib/core/workspace";
  import { sessionTabsOnly } from "$lib/panes/layout";
  import * as backend from "$lib/core/backend";
  import {
    applicableSteps,
    defaultAnswers,
    stepTitle,
    stepQuestion,
    summaryLines,
    confirmationMatches,
    ROWS_DECLINE_NOTE,
    type DeleteAnswers,
    type GavinFootprint,
  } from "$lib/workspace/workspaceDelete";
  import { executeWorkspaceDelete, type DeleteResult } from "$lib/workspace/workspaceDeleteActions";
  import { grantForAnsweredPrompt } from "$lib/core/confirmGate";
  import { sshLimitation } from "$lib/workspace/sshWorkspace";

  interface Props {
    workspaceId: string;
    onClose: () => void;
  }
  let { workspaceId, onClose }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const sshBlocked = $derived(sshLimitation(ws));
  const sessionCount = $derived(
    ws
      ? sessionTabsOnly(
          allSessionIdsInWorkspace(ws),
          $layoutState.fileTabsById,
          $layoutState.boardTabsById,
          $layoutState.cardTabsById
        ).length
      : 0
  );

  let footprint = $state<GavinFootprint | null>(null);
  let scanError = $state<string | null>(null);
  let answers = $state<DeleteAnswers | null>(null);
  let index = $state(0);
  let typed = $state("");
  let running = $state(false);
  let result = $state<DeleteResult | null>(null);

  const steps = $derived(footprint ? applicableSteps(footprint) : []);
  const step = $derived(steps[index] ?? null);

  // Scanned once, on open. The wizard is a read followed by six
  // questions; re-scanning between screens would let the ground move
  // under an answer already given -- and the remover re-scans anyway,
  // which is where a genuinely stale plan is caught.
  $effect(() => {
    const root = ws?.rootPath;
    if (!root || footprint || scanError) return;
    void backend
      .scanGavinFootprint(root)
      .then((found) => {
        footprint = found;
        answers = defaultAnswers(found);
      })
      .catch((e) => (scanError = String(e)));
  });

  function toggleContext(path: string, on: boolean): void {
    if (!answers) return;
    answers.contexts = on
      ? [...answers.contexts, path]
      : answers.contexts.filter((p) => p !== path);
  }

  async function runDelete(): Promise<void> {
    if (!footprint || !answers) return;
    running = true;
    try {
      // The six screens and the typed name ARE this command's
      // confirmation; the grant is what makes the host agree.
      const token = await grantForAnsweredPrompt("remove_gavin_footprint", [footprint.root]);
      result = await executeWorkspaceDelete(workspaceId, footprint, answers, token);
    } finally {
      running = false;
    }
    // A clean run has already taken the workspace out of the app, so
    // there is nothing left for this modal to be about.
    if (result?.removed) onClose();
  }

  // A failed run leaves the workspace in place on purpose. Rescanning is
  // what makes "try again" mean "finish what is left" rather than
  // "attempt the same removals a second time".
  function retry(): void {
    result = null;
    footprint = null;
    answers = null;
    scanError = null;
    index = 0;
    typed = "";
  }
</script>

<Modal onClose={running ? () => {} : onClose}>
  {#if sshBlocked}
    <!-- The wizard scans and trashes gavin's files on this machine's
         disk; an ssh workspace's are on the host. Closing the workspace
         (the sidebar's menu) still works: that removes only the row. -->
    <p class="ssh-notice">{sshBlocked}</p>
    <div class="ssh-actions"><button type="button" onclick={onClose}>Close</button></div>
  {:else}
  <div class="head">
    <span class="title">Delete workspace</span>
    <!-- `steps` is derived from the footprint, so a step exists only
         once the scan has landed; the null check is for the compiler,
         not for a state that occurs. -->
    {#if footprint && step && step !== "confirm"}
      <span class="progress">
        Step {index + 1} of {steps.length} · {stepTitle(step, footprint)}
      </span>
    {:else if footprint && step}
      <span class="progress">{stepTitle(step, footprint)}</span>
    {/if}
  </div>

  {#if !ws}
    <p class="body">This workspace is no longer open.</p>
    <div class="actions"><button type="button" onclick={onClose}>Close</button></div>
  {:else if scanError}
    <p class="body warn">Couldn't read this workspace's folder: {scanError}</p>
    <div class="actions"><button type="button" onclick={onClose}>Close</button></div>
  {:else if result}
    <!-- Only ever a failed run: a clean one closed the modal. -->
    <p class="body warn">
      Some of it didn't go through, so the workspace is still here and you can run it again.
    </p>
    <ul class="lines">
      {#each result.failed as [what, why], i (i)}
        <li class="warn"><code>{what}</code> — {why}</li>
      {/each}
    </ul>
    {#if result.done.length > 0}
      <p class="hint">What did land:</p>
      <ul class="lines">
        {#each result.done as line, i (i)}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button type="button" onclick={onClose}>Close</button>
      <button type="button" onclick={retry}>Start over</button>
    </div>
  {:else if !footprint || !answers}
    <p class="body">Reading {ws.rootPath}…</p>
  {:else if step === "confirm"}
    <p class="body">{stepQuestion(step, footprint)}</p>
    <ul class="lines">
      {#each summaryLines(footprint, answers, sessionCount) as line, i (i)}
        <li>{line}</li>
      {/each}
    </ul>
    <label class="confirm">
      <span>Type <b>{ws.name}</b></span>
      <input bind:value={typed} disabled={running} placeholder={ws.name} />
    </label>
    <div class="actions">
      <button type="button" disabled={running} onclick={() => (index -= 1)}>Back</button>
      <button
        type="button"
        class="danger"
        disabled={running || !confirmationMatches(typed, ws.name)}
        onclick={() => void runDelete()}
      >
        {running ? "Deleting…" : "Delete"}
      </button>
    </div>
  {:else if step}
    <p class="body">{stepQuestion(step, footprint)}</p>

    {#if step === "plans" && footprint.gavinRoot}
      <ul class="lines">
        <li><code>{footprint.gavinRoot.path}</code></li>
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={answers.plans} />
        Remove it
      </label>
    {:else if step === "skills"}
      <ul class="lines">
        {#each footprint.skills as path (path)}
          <li><code>{path}</code></li>
        {/each}
        <!-- Last, and labelled: it is not a skill, and a bare path in
             this list would read as one. -->
        {#if footprint.agentFile}
          <li><code>{footprint.agentFile}</code> — the commit agent's permissions</li>
        {/if}
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={answers.skills} />
        Remove them
      </label>
    {:else if step === "mcp" && footprint.mcp}
      <ul class="lines">
        <li><code>{footprint.mcp.path}</code> — the <code>{footprint.mcp.serverKey}</code> server</li>
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={answers.mcp} />
        Remove the entry
      </label>
    {:else if step === "instructions" && footprint.instructions}
      <ul class="lines">
        <li><code>{footprint.instructions}</code></li>
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={answers.instructions} />
        Cut the block
      </label>
    {:else if step === "contexts"}
      {#each footprint.contexts.filter((c) => !c.outside) as ctx (ctx.path)}
        <label class="check">
          <input
            type="checkbox"
            checked={answers.contexts.includes(ctx.path)}
            onchange={(e) => toggleContext(ctx.path, e.currentTarget.checked)}
          />
          <code>{ctx.path}</code>
        </label>
      {/each}
      {#if footprint.contexts.some((c) => c.outside)}
        <!-- Outside the root, and unticked by default: these belong to
             other checkouts that merely registered themselves here. -->
        <p class="hint warn">
          These are outside this workspace's folder. They belong to other checkouts that registered
          themselves here — removing one deletes that project's plans too.
        </p>
        {#each footprint.contexts.filter((c) => c.outside) as ctx (ctx.path)}
          <label class="check outside">
            <input
              type="checkbox"
              checked={answers.contexts.includes(ctx.path)}
              onchange={(e) => toggleContext(ctx.path, e.currentTarget.checked)}
            />
            <code>{ctx.path}</code>
          </label>
        {/each}
      {/if}
    {:else if step === "rows"}
      <label class="check">
        <input type="checkbox" bind:checked={answers.rows} />
        Clear them
      </label>
      {#if !answers.rows}
        <p class="hint warn">{ROWS_DECLINE_NOTE}</p>
      {/if}
    {/if}

    <div class="actions">
      {#if index > 0}
        <button type="button" onclick={() => (index -= 1)}>Back</button>
      {:else}
        <button type="button" onclick={onClose}>Cancel</button>
      {/if}
      <button type="button" onclick={() => (index += 1)}>Next</button>
    </div>
  {/if}
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
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .title {
    font-size: 1.05em;
  }
  .progress {
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .body {
    margin: 0 0 12px;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .lines {
    margin: 0 0 12px;
    padding-left: 18px;
    font-size: 0.8em;
    line-height: 1.6;
  }
  .lines code {
    word-break: break-all;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8em;
    margin-bottom: 6px;
  }
  .check.outside {
    color: var(--warning-text);
  }
  .hint {
    color: var(--text-muted);
    font-size: 0.75em;
    line-height: 1.5;
    margin: 8px 0;
  }
  .warn {
    color: var(--warning-text);
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.8em;
    margin: 14px 0 0;
  }
  .confirm input {
    flex: 1;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    padding: 4px 8px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.85em;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .actions button.danger {
    color: var(--warning-text);
  }
</style>
