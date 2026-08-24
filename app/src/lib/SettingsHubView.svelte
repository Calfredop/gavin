<script lang="ts">
  import {
    layoutState,
    renameWorkspace,
    setWorkspaceColor,
    setNotifyFlag,
    setAgentField,
    agentProfilesStore,
    restartDaemonInPlace,
  } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig, validateAgentFileName, renameDecision, DEFAULT_ACCENT } from "./settings";
  import * as backend from "./backend";
  import WorkspaceRootControl from "./WorkspaceRootControl.svelte";
  import ColourPicker from "./ColourPicker.svelte";
  import Modal from "./Modal.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agent = $derived(resolveAgentConfig(rootContext?.agent ?? null, $agentProfilesStore));
  const configWarning = $derived(Boolean(rootContext?.configWarning));
  const hasRoot = $derived(Boolean(ws?.rootPath));
  const profileLabel = $derived(
    $agentProfilesStore.find((p) => p.id === agent.profileId)?.label ?? agent.profileId
  );

  // Drafts exist so a watcher push cannot overwrite a field mid-type
  // (spec §5.2): a focused input keeps its draft, everything else follows
  // the store.
  let nameDraft = $state("");
  let commandDraft = $state("");
  let fileDraft = $state("");
  let focused = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let pendingMove = $state<{ from: string; to: string } | null>(null);

  // --- daemon ----------------------------------------------------------
  let confirmingRestart = $state(false);
  let restarting = $state(false);
  let restartError = $state<string | null>(null);
  let restartedAt = $state<string | null>(null);

  async function restartDaemon(): Promise<void> {
    confirmingRestart = false;
    restarting = true;
    restartError = null;
    restartedAt = null;
    try {
      await restartDaemonInPlace();
      restartedAt = new Date().toLocaleTimeString();
    } catch (e) {
      restartError = String(e instanceof Error ? e.message : e);
    } finally {
      restarting = false;
    }
  }

  $effect(() => {
    const name = ws?.name ?? "";
    if (focused !== "name") nameDraft = name;
  });
  $effect(() => {
    const command = agent.command;
    if (focused !== "command") commandDraft = command;
  });
  $effect(() => {
    const file = agent.file;
    if (focused !== "file") fileDraft = file;
  });

  function commitName(): void {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== ws?.name) void renameWorkspace(workspaceId, trimmed);
  }

  function commitCommand(): void {
    const trimmed = commandDraft.trim();
    if (trimmed && trimmed !== agent.command) void setAgentField(workspaceId, "command", trimmed);
  }

  async function commitFile(): Promise<void> {
    fileError = null;
    const next = fileDraft.trim();
    const problem = validateAgentFileName(next);
    if (problem) {
      fileError = problem;
      return;
    }
    if (!ws?.rootPath || next === agent.file) return;
    const [oldExists, targetExists] = await Promise.all([
      backend
        .readFileForViewer(`${ws.rootPath}/${agent.file}`)
        .then((r) => r.exists)
        .catch(() => false),
      backend
        .readFileForViewer(`${ws.rootPath}/${next}`)
        .then((r) => r.exists)
        .catch(() => false),
    ]);
    const decision = renameDecision(agent.file, next, oldExists, targetExists);
    if (decision === "error") {
      fileError = "That file name can't be used.";
      return;
    }
    if (decision === "prompt") {
      pendingMove = { from: agent.file, to: next };
      return;
    }
    await setAgentField(workspaceId, "file", next);
  }

  async function confirmMove(move: boolean): Promise<void> {
    const pending = pendingMove;
    pendingMove = null;
    if (!pending || !ws?.rootPath) return;
    if (move) {
      try {
        await backend.moveAgentFile(ws.rootPath, pending.from, pending.to);
      } catch (e) {
        fileError = String(e);
        return;
      }
    }
    await setAgentField(workspaceId, "file", pending.to);
  }
</script>

{#if ws}
  <div class="settings">
    <section>
      <h3>Workspace</h3>
      <label class="row">
        <span>Name</span>
        <input
          bind:value={nameDraft}
          onfocus={() => (focused = "name")}
          onblur={() => {
            focused = null;
            commitName();
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </label>
      <div class="row">
        <span>Colour</span>
        <ColourPicker
          value={ws.color ?? DEFAULT_ACCENT}
          onChange={(c) => void setWorkspaceColor(workspaceId, c)}
        />
      </div>
      <div class="row">
        <span>Root</span>
        <WorkspaceRootControl workspace={ws} variant="settings" />
      </div>
    </section>

    <section>
      <h3>Notifications</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyNeedsInput ?? true}
          onchange={(e) => void setNotifyFlag(workspaceId, "notifyNeedsInput", e.currentTarget.checked)}
        />
        When a session needs my input
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyFinished ?? true}
          onchange={(e) => void setNotifyFlag(workspaceId, "notifyFinished", e.currentTarget.checked)}
        />
        When a session finishes working
      </label>
      <p class="hint">Never shown while the gavin window is focused.</p>
    </section>

    <section>
      <h3>Agent</h3>
      {#if !hasRoot}
        <p class="hint">Bind a root folder to configure the agent.</p>
      {:else if configWarning}
        <p class="hint warn">
          This root's config.toml can't be parsed — fix it to edit these settings.
        </p>
      {:else}
        <label class="row">
          <span>Profile</span>
          <select
            value={agent.profileId}
            onchange={(e) => void setAgentField(workspaceId, "profile", e.currentTarget.value)}
          >
            {#each $agentProfilesStore as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </label>
        <label class="row">
          <span>Command</span>
          <input
            bind:value={commandDraft}
            spellcheck="false"
            onfocus={() => (focused = "command")}
            onblur={() => {
              focused = null;
              commitCommand();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <label class="row">
          <span>Agent file</span>
          <input
            bind:value={fileDraft}
            spellcheck="false"
            onfocus={() => (focused = "file")}
            onblur={() => {
              focused = null;
              void commitFile();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        {#if fileError}
          <p class="hint warn">{fileError}</p>
        {/if}
        {#if agent.mcpSupported}
          <p class="hint">
            MCP integration is available for this profile — set it up from the Root row above.
          </p>
        {:else}
          <p class="hint">MCP integration isn't available for {profileLabel} yet.</p>
        {/if}
      {/if}
    </section>

    <section>
      <h3>Daemon</h3>
      <p class="hint">
        gavin-daemon owns every terminal session and watches your plan files. Restart it after
        rebuilding it, or if sessions and file watching have stopped responding.
      </p>
      <div class="row">
        <button type="button" disabled={restarting} onclick={() => (confirmingRestart = true)}>
          {restarting ? "Restarting…" : "Restart daemon"}
        </button>
        {#if restartedAt}
          <span class="hint">Restarted at {restartedAt}.</span>
        {/if}
      </div>
      {#if restartError}
        <p class="hint warn">Couldn't restart the daemon: {restartError}</p>
      {/if}
    </section>
  </div>

  {#if confirmingRestart}
    <ConfirmPrompt
      title="Restart gavin-daemon?"
      lines={[
        "Every terminal session restarts as a fresh shell at its current folder.",
        "Any agent that is running right now is stopped.",
        "Scrollback in open terminals is lost.",
        "The window stays open — plans, boards and git keep working.",
      ]}
      choices={[{ label: "Restart daemon", danger: true, onPick: () => void restartDaemon() }]}
      onCancel={() => (confirmingRestart = false)}
    />
  {/if}

  {#if pendingMove}
    <Modal onClose={() => void confirmMove(false)}>
      <p>Move <code>{pendingMove.from}</code>?</p>
      <p class="detail">
        Move it to <code>{pendingMove.to}</code>, or point gavin at <code>{pendingMove.to}</code> and
        leave the old file where it is?
      </p>
      <div class="actions">
        <button type="button" onclick={() => void confirmMove(false)}>Leave it</button>
        <button type="button" onclick={() => void confirmMove(true)}>Move file</button>
      </div>
    </Modal>
  {/if}
{/if}

<style>
  .settings {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
    color: var(--text);
    font-family: monospace;
    font-size: 0.85em;
  }
  h3 {
    margin: 0 0 10px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .row > span:first-child {
    width: 90px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .row input,
  .row select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 240px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .hint.warn {
    color: var(--warning-text);
  }
  .detail {
    opacity: 0.75;
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .row button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .row button:disabled {
    opacity: 0.55;
    cursor: default;
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
</style>
