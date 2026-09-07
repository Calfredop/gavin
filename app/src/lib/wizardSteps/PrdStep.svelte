<script lang="ts">
  import { pickPath } from "../picker";
  import {
    layoutState,
    daemonCompat,
    agentProfilesStore,
    agentModelDefaultsStore,
    setPrdPath,
    startMainAgentWithPrompt,
  } from "./../layoutState";
  import { gavinTrees } from "./../gavinState";
  import { featureBlockedReason } from "./../daemonCompat";
  import { resolveAgentConfig, prdPathFromPick } from "./../settings";
  import { applyPrdSections, agentFlowAvailable, prdHasPlaceholders } from "./../setupWizard";
  import * as backend from "./../backend";

  interface Props {
    workspaceId: string;
    /// null when the file is not there, undefined while the wizard's read
    /// is still in flight -- the same distinction setupProgress draws.
    prdBody: string | null | undefined;
    /// The workspace's PRD, relative to its root. Passed down rather than
    /// re-derived so the step writes back to the same file the wizard
    /// read from -- they must not resolve it independently.
    prdPath: string;
    /// Whether the Integration step's files are already on disk. They
    /// name the PRD path, so repointing it here has to rewrite them --
    /// but only once they exist, or the pick would run the step early.
    integrationDone: boolean;
    onDone: () => void;
  }
  let { workspaceId, prdBody, prdPath, integrationDone, onDone }: Props = $props();

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

  const prdBlocked = $derived(featureBlockedReason($daemonCompat, "prdPath"));
  // A document that still has placeholders is the scaffold, and the three
  // fields have somewhere to write. One that has none was written by
  // somebody -- almost always the file the human just pointed at -- so the
  // form would replace nothing and Continue would save nothing.
  const authored = $derived(!prdHasPlaceholders(prdBody));
  // Never offered over a document somebody already wrote: the flow
  // interviews the owner and writes the PRD, which is the opposite of
  // what pointing at an existing one asked for.
  const canAsk = $derived(agentFlowAvailable(profile) && !ws?.mainSessionId && !authored);

  let vision = $state("");
  let focus = $state("");
  let outOfScope = $state("");
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let busy = $state(false);

  /// Points the workspace at a PRD the repo already has. The integration
  /// files name the PRD path, so a repoint after they were written leaves
  /// the agent reading a document that is not the one that leads the
  /// workspace -- re-running the (idempotent, merge-aware) writer is what
  /// keeps step 2's output true, and the note says it happened.
  async function pickPrd(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    error = null;
    note = null;
    busy = true;
    try {
      const picked = await pickPath({
        directory: false,
        defaultPath: root,
        title: "Choose the PRD file",
      });
      // A cancelled dialog is not an error, and must not clear the
      // message from the pick before it.
      if (typeof picked !== "string") return;
      const result = prdPathFromPick(root, picked);
      if ("error" in result) {
        error = result.error;
        return;
      }
      if (result.path === prdPath) return;
      await setPrdPath(workspaceId, result.path);
      note = `Now leading this workspace: ${result.path}.`;
      if (integrationDone) {
        await backend.setupAgentIntegration(root);
        note = `${note} The integration files were rewritten to name it.`;
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }

  async function saveMine(): Promise<void> {
    if (!ws?.rootPath || typeof prdBody !== "string") return onDone();
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
  The lead document for this workspace. Your agent reads it first; plans trace back to it.
</p>

<div class="file" title={prdBlocked ?? undefined}>
  <span class="label">File</span>
  <!-- The &lrm; bookends are load-bearing — see .path below. -->
  <span class="path" title={ws?.rootPath ? `${ws.rootPath}/${prdPath}` : prdPath}
    >&lrm;{prdPath}&lrm;</span
  >
  <button
    type="button"
    class="pick"
    disabled={busy || Boolean(prdBlocked)}
    title={prdBlocked ?? "Point this workspace at a PRD it already has"}
    onclick={() => void pickPrd()}>Pick…</button
  >
</div>
{#if prdBlocked}
  <p class="warn">{prdBlocked}</p>
{:else if note}
  <p class="note">{note}</p>
{/if}

{#if authored}
  <p class="hint">
    This document is already written — gavin left it exactly as it is. Edit it any time from the PRD
    tab.
  </p>
{:else}
  <p class="hint">Anything you leave blank keeps its placeholder.</p>

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
{/if}

{#if error}
  <p class="warn">{error}</p>
{/if}

<div class="actions">
  {#if !authored}
    <button type="button" onclick={onDone}>Skip</button>
  {/if}
  {#if canAsk}
    <button type="button" disabled={busy} onclick={() => void askAgent()}>Ask the agent →</button>
  {/if}
  <button type="button" disabled={busy} onclick={() => void saveMine()}>Continue →</button>
</div>
{#if profile && !agentFlowAvailable(profile) && !authored}
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
  /* The same strip HubFilePicker draws on the PRD tab, sized for a modal
     row rather than a pane header. */
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
    font-family: monospace;
    font-size: 0.85em;
  }
  .file .label {
    width: 80px;
    flex: 0 0 auto;
    color: #999;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Ellipsis on the LEFT, as in HubFilePicker: a path's tail is its
       informative end. The &lrm; bookends keep the slashes inside the
       LTR run so a leading one doesn't detach and park on the right. */
    direction: rtl;
    color: #eee;
  }
  .pick {
    background: #2f2f2f;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    cursor: pointer;
  }
  .pick:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .note {
    margin: 0 0 12px 90px;
    color: #8bc98b;
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
