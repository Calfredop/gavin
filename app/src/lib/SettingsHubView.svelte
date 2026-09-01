<script lang="ts">
  import {
    layoutState,
    renameWorkspace,
    setWorkspaceColor,
    setWorkspaceFlag,
    setAgentField,
    setPrdPath,
    agentProfilesStore,
    agentModelDefaultsStore,
    restartDaemonInPlace,
    mcpFormatsStore,
    daemonCompat,
  } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { featureBlockedReason, restartOutcome } from "./daemonCompat";
  import { modelOptions, CUSTOM_MODEL } from "./agentModel";
  import {
    resolveAgentConfig,
    validateAgentFileName,
    validateMcpConfigPath,
    validatePrdPath,
    resolvePrdPath,
    DEFAULT_PRD_PATH,
    prdPathFromPick,
    agentFileFromPick,
    renameDecision,
    DEFAULT_ACCENT,
  } from "./settings";
  import { open } from "@tauri-apps/plugin-dialog";
  import * as backend from "./backend";
  import WorkspaceRootControl from "./WorkspaceRootControl.svelte";
  import ColourPicker from "./ColourPicker.svelte";
  import Modal from "./Modal.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import WorkspaceDeleteWizard from "./WorkspaceDeleteWizard.svelte";
  import { tooltip } from "./tooltip";
  import { UNFILED_WORKSPACE_ID } from "./workspace";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agent = $derived(resolveAgentConfig(rootContext?.agent ?? null, $agentProfilesStore, $agentModelDefaultsStore));
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
  let mcpFileDraft = $state("");
  let prdDraft = $state("");
  let focused = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let mcpFileError = $state<string | null>(null);
  let prdError = $state<string | null>(null);
  let pendingMove = $state<{ from: string; to: string } | null>(null);

  // --- danger zone -----------------------------------------------------
  let deleting = $state(false);

  // Why Delete is unavailable, or null when it is available. A wizard
  // with no root has nothing to scan, and the Scratchpad is pinned --
  // there is no such thing as removing it.
  const deleteBlockedReason = $derived(
    workspaceId === UNFILED_WORKSPACE_ID
      ? "The Scratchpad is always here — it can't be deleted."
      : !hasRoot
        ? "Bind a root folder first — there is nothing on disk to delete until then."
        : null
  );

  // --- daemon ----------------------------------------------------------
  let confirmingRestart = $state(false);
  let restarting = $state(false);
  let restartError = $state<string | null>(null);
  let restartedAt = $state<string | null>(null);
  // "Restarted at 12:21" is true and useless when the daemon came back at
  // the version it left at: the human reads a success line while every
  // gated feature stays gated. This carries the same verdict the compat
  // banner's note does, so both surfaces that offer the restart report
  // what it actually achieved.
  let restartNote = $state<string | null>(null);

  async function restartDaemon(): Promise<void> {
    confirmingRestart = false;
    restarting = true;
    restartError = null;
    restartedAt = null;
    restartNote = null;
    const before = $daemonCompat?.daemonVersion ?? null;
    try {
      restartNote = restartOutcome(before, await restartDaemonInPlace());
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
  $effect(() => {
    const mcpFile = rootContext?.agent?.mcpFile ?? "";
    if (focused !== "mcpFile") mcpFileDraft = mcpFile;
  });

  /// Only `custom` gets these: every other profile's layout is verified
  /// in the Rust table, and a box that could override it would be a box
  /// for writing gavin's config to the wrong place.
  const isCustom = $derived(agent.profileId === "custom");
  const mcpFormat = $derived(rootContext?.agent?.mcpFormat ?? $mcpFormatsStore[0]?.id ?? "");

  // --- model ------------------------------------------------------------
  /// The profile row itself, for its flag and presets. `agent` above is
  /// the RESOLVED config, which carries neither.
  const profileInfo = $derived($agentProfilesStore.find((p) => p.id === agent.profileId) ?? null);
  /// What this workspace has set of its OWN, which is not agent.model:
  /// that one has already fallen back to the app-wide default, and the
  /// picker has to be able to tell "inheriting" from "chose the same
  /// value deliberately".
  const ownModel = $derived(rootContext?.agent?.model ?? "");
  const globalModel = $derived($agentModelDefaultsStore[agent.profileId] ?? "");
  /// A v13 daemon refuses the `model` key outright, so the control is
  /// disabled with the reason instead of failing on blur. This is the
  /// only surface that can produce a `model` payload -- the global panel
  /// writes config.json through Tauri and never asks the daemon.
  const modelBlocked = $derived(featureBlockedReason($daemonCompat, "agentModel"));

  // --- the lead document ------------------------------------------------
  /// Which file leads this workspace. Not an agent key: it lives at the
  /// root of config.toml and survives a change of CLI.
  const prdPath = $derived(resolvePrdPath(rootContext));
  /// A v16 daemon's SetRootConfigField allow-list has no `prd`, and it
  /// keeps resolving the PRD against the hard-coded path regardless of
  /// what is written -- so the row is disabled with the reason rather
  /// than accepting a choice nothing downstream would honour.
  const prdBlocked = $derived(featureBlockedReason($daemonCompat, "prdPath"));
  $effect(() => {
    const prd = prdPath;
    if (focused !== "prd") prdDraft = prd;
  });

  async function commitPrd(): Promise<void> {
    prdError = null;
    const next = prdDraft.trim();
    // Emptied deliberately: that is how a workspace goes back to the
    // scaffolded default, and the daemon removes the key rather than
    // blanking it.
    if (!next) {
      if (rootContext?.prd) await setPrdPath(workspaceId, "");
      return;
    }
    if (next === prdPath) return;
    prdError = validatePrdPath(next);
    if (prdError) return;
    await setPrdPath(workspaceId, next);
  }

  async function pickPrd(): Promise<void> {
    prdError = null;
    if (!ws?.rootPath) return;
    const picked = await open({
      directory: false,
      multiple: false,
      defaultPath: ws.rootPath,
      title: "Choose the PRD file",
    });
    if (typeof picked !== "string") return;
    const result = prdPathFromPick(ws.rootPath, picked);
    if ("error" in result) {
      prdError = result.error;
      return;
    }
    prdDraft = result.path;
    await setPrdPath(workspaceId, result.path);
  }

  /// Points the workspace at an instructions file it already has. The
  /// rename flow below is a different intent -- it moves gavin's file to
  /// a new name -- so a pick never offers to move anything.
  async function pickAgentFile(): Promise<void> {
    fileError = null;
    if (!ws?.rootPath) return;
    const picked = await open({
      directory: false,
      multiple: false,
      defaultPath: ws.rootPath,
      title: "Choose the agent instructions file",
    });
    if (typeof picked !== "string") return;
    const result = agentFileFromPick(ws.rootPath, picked);
    if ("error" in result) {
      fileError = result.error;
      return;
    }
    fileDraft = result.file;
    if (result.file !== agent.file) await setAgentField(workspaceId, "file", result.file);
  }

  let modelCustomOpen = $state(false);
  let modelDraft = $state("");
  $effect(() => {
    const model = ownModel;
    if (focused !== "model") modelDraft = model;
  });

  const modelIsCustom = $derived(
    modelCustomOpen || (ownModel !== "" && !(profileInfo?.models ?? []).includes(ownModel))
  );

  function pickModel(value: string): void {
    if (value === CUSTOM_MODEL) {
      modelCustomOpen = true;
      modelDraft = ownModel;
      return;
    }
    modelCustomOpen = false;
    void setAgentField(workspaceId, "model", value);
  }

  function commitModel(): void {
    const trimmed = modelDraft.trim();
    if (trimmed === ownModel) return;
    // "" is a real value here, not a no-op: it removes the key and puts
    // the workspace back on the app-wide default.
    void setAgentField(workspaceId, "model", trimmed);
  }

  function commitMcpFile(): void {
    mcpFileError = null;
    const trimmed = mcpFileDraft.trim();
    if (!trimmed || trimmed === (rootContext?.agent?.mcpFile ?? "")) return;
    mcpFileError = validateMcpConfigPath(trimmed);
    if (mcpFileError) return;
    void setAgentField(workspaceId, "mcp_file", trimmed);
  }

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
          onchange={(e) => void setWorkspaceFlag(workspaceId, "notifyNeedsInput", e.currentTarget.checked)}
        />
        When a session needs my input
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyFinished ?? true}
          onchange={(e) => void setWorkspaceFlag(workspaceId, "notifyFinished", e.currentTarget.checked)}
        />
        When a session finishes working
      </label>
      <p class="hint">
        Not shown while the gavin window is focused — except a commit agent's verdict, which stays quiet only while its
        Git tab is the one on screen.
      </p>
    </section>

    <section>
      <h3>Confirmations</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.confirmTabClose ?? true}
          onchange={(e) => void setWorkspaceFlag(workspaceId, "confirmTabClose", e.currentTarget.checked)}
        />
        Close confirm
      </label>
      <p class="hint">
        Ask before closing a tab. Off closes tabs straight away — including the last tab in a pane,
        which takes the pane with it.
      </p>
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
        {#if profileInfo && profileInfo.modelFlag}
          <div class="row model-row">
            <span>Model</span>
            <select
              value={modelIsCustom ? CUSTOM_MODEL : ownModel}
              disabled={Boolean(modelBlocked)}
              title={modelBlocked ?? ""}
              onchange={(e) => pickModel(e.currentTarget.value)}
            >
              {#each modelOptions(profileInfo, globalModel) as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if modelIsCustom}
              <input
                bind:value={modelDraft}
                spellcheck="false"
                placeholder="model name"
                disabled={Boolean(modelBlocked)}
                title={modelBlocked ?? ""}
                onfocus={() => (focused = "model")}
                onblur={() => {
                  focused = null;
                  commitModel();
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
          {#if modelBlocked}
            <p class="hint warn">{modelBlocked}</p>
          {:else if agent.model}
            <p class="hint">Launches as <code>{agent.launchCommand}</code>.</p>
          {/if}
        {:else if profileInfo}
          <p class="hint">
            Set the model in Command — gavin knows no model flag for {profileLabel}.
          </p>
        {/if}
        <div class="row">
          <label for="agent-file-{workspaceId}">Agent file</label>
          <input
            id="agent-file-{workspaceId}"
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
          <button type="button" onclick={() => void pickAgentFile()}>Pick…</button>
        </div>
        {#if fileError}
          <p class="hint warn">{fileError}</p>
        {:else}
          <p class="hint">
            Typing a new name offers to rename gavin's file; Pick… points the workspace at one this
            repo already has.
          </p>
        {/if}
        <div class="row">
          <label for="prd-file-{workspaceId}">PRD file</label>
          <input
            id="prd-file-{workspaceId}"
            bind:value={prdDraft}
            spellcheck="false"
            disabled={Boolean(prdBlocked)}
            title={prdBlocked ?? ""}
            placeholder={DEFAULT_PRD_PATH}
            onfocus={() => (focused = "prd")}
            onblur={() => {
              focused = null;
              void commitPrd();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            disabled={Boolean(prdBlocked)}
            title={prdBlocked ?? ""}
            onclick={() => void pickPrd()}>Pick…</button
          >
        </div>
        {#if prdBlocked}
          <p class="hint warn">{prdBlocked}</p>
        {:else if prdError}
          <p class="hint warn">{prdError}</p>
        {:else}
          <p class="hint">
            The lead document — the PRD tab edits it, and every file gavin writes for an agent names
            it. Empty means <code>{DEFAULT_PRD_PATH}</code>.
          </p>
        {/if}
        {#if isCustom}
          <label class="row">
            <span>MCP config</span>
            <input
              bind:value={mcpFileDraft}
              spellcheck="false"
              placeholder=".myagent/mcp.json"
              onfocus={() => (focused = "mcpFile")}
              onblur={() => {
                focused = null;
                commitMcpFile();
              }}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          {#if mcpFileError}
            <p class="hint warn">{mcpFileError}</p>
          {/if}
          <label class="row">
            <span>MCP format</span>
            <select
              value={mcpFormat}
              onchange={(e) => void setAgentField(workspaceId, "mcp_format", e.currentTarget.value)}
            >
              {#each $mcpFormatsStore as format (format.id)}
                <option value={format.id}>{format.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if agent.mcpSupported}
          <p class="hint">
            MCP integration writes <code>{agent.mcpConfigFile}</code> — set it up from the Root row
            above.
          </p>
        {:else}
          <p class="hint">
            Name the file {profileLabel} reads MCP config from, and gavin can write itself into it.
          </p>
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
      {:else if restartNote}
        <p class="hint warn">{restartNote}</p>
      {/if}
    </section>

    <section>
      <h3>Danger zone</h3>
      <p class="hint">
        Remove gavin from this workspace's folder: its plans, skills, MCP entry and instructions
        block, plus the board and rails the daemon holds. You are asked about each one, and nothing
        is removed until you confirm.
      </p>
      <!-- The reason hangs on the wrapper, not the button: a disabled
           element fires no mouseenter, so a tooltip on it can never open
           and the control would refuse to explain itself. -->
      <div class="row" use:tooltip={deleteBlockedReason ?? ""}>
        <button
          type="button"
          class="danger"
          disabled={deleteBlockedReason !== null}
          onclick={() => (deleting = true)}
        >
          Delete workspace…
        </button>
        {#if deleteBlockedReason}
          <span class="hint">{deleteBlockedReason}</span>
        {/if}
      </div>
    </section>
  </div>

  {#if deleting}
    <WorkspaceDeleteWizard {workspaceId} onClose={() => (deleting = false)} />
  {/if}

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
  .row > span:first-child,
  .row > label:first-child {
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
  /* The only row with two controls side by side: the shared 240px floor
     would push it past a narrow pane. */
  .model-row select {
    min-width: 160px;
  }
  .model-row input {
    min-width: 0;
    flex: 1 1 auto;
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
    /* Sits beside the input rather than stretching with it -- the two
       Pick… rows are the ones with something to compete for. */
    flex: 0 0 auto;
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
  .row button.danger {
    color: var(--warning-text);
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
