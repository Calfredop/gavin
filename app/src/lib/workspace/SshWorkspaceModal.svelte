<script lang="ts">
  /// The ssh workspace form: a host, the root ON THAT HOST, and where
  /// `gavin-daemon` is there when it is not on the host's PATH. Makes a
  /// new workspace (`workspaceId` null) or re-points an existing one, then
  /// connects, then asks the host daemon whether the root is a gavin root
  /// -- the same init-or-bind fork a local folder gets, asked of the right
  /// disk.
  ///
  /// The workspace is kept when the connect fails. A local "Open" creates
  /// nothing until the answer is known, but an ssh connect can take ten
  /// seconds and fail on a typo in the host; keeping the row, with its
  /// banner naming ssh's own words and a Reconnect, beats retyping three
  /// fields. The error line says so.
  import { untrack } from "svelte";
  import { get } from "svelte/store";
  import Modal from "$lib/core/Modal.svelte";
  import * as backend from "$lib/core/backend";
  import { createWorkspace, layoutState, markGitTrackingAsked, setWorkspaceSsh } from "$lib/core/layoutState";
  import { nameForRoot } from "$lib/workspace/workspaceOpen";
  import { closeSshForm, connectSshWorkspace } from "$lib/workspace/sshLinkState";
  import { validateSshInput } from "$lib/workspace/sshWorkspace";

  interface Props {
    /// The workspace being re-pointed, or null to make a new one.
    workspaceId: string | null;
  }
  let { workspaceId }: Props = $props();

  // Read once at mount (untracked on purpose; the mount is keyed on the
  // id): the fields are the human's from here on, and a store update
  // mid-typing must not overwrite them.
  const initialId = untrack(() => workspaceId);
  const existing = initialId ? (get(layoutState).workspaces.find((w) => w.id === initialId) ?? null) : null;
  let host = $state(existing?.ssh?.host ?? "");
  let rootPath = $state(existing?.ssh ? (existing.rootPath ?? "") : "");
  let daemonPath = $state(existing?.ssh?.daemonPath ?? "");

  type Phase = "form" | "connecting" | "init-question" | "initializing";
  let phase = $state<Phase>("form");
  let error = $state<string | null>(null);
  // The workspace the form is acting on once one exists -- the prop for
  // an edit, the id minted on the first submit for a creation, so a
  // second submit after a failed connect re-points that one rather than
  // making another.
  let targetId = $state<string | null>(initialId);
  let targetRoot = $state("");

  async function submit(): Promise<void> {
    error = null;
    const verdict = validateSshInput({ host, rootPath, daemonPath });
    if (!verdict.ok) {
      error = verdict.error;
      return;
    }
    phase = "connecting";
    let id = targetId;
    if (!id) {
      await createWorkspace(nameForRoot(verdict.rootPath));
      id = get(layoutState).activeWorkspaceId;
      if (!id) {
        error = "Couldn't create the workspace.";
        phase = "form";
        return;
      }
      targetId = id;
    }
    await setWorkspaceSsh(id, verdict.ssh, verdict.rootPath);
    targetRoot = verdict.rootPath;
    const failure = await connectSshWorkspace(id, verdict.ssh.host);
    if (failure) {
      error = `${failure} — the workspace was kept; fix the host or path and connect again.`;
      phase = "form";
      return;
    }
    let exists: boolean;
    try {
      exists = await backend.gavinRootExists(verdict.rootPath);
    } catch (e) {
      error = String(e);
      phase = "form";
      return;
    }
    if (exists) {
      closeSshForm();
      return;
    }
    phase = "init-question";
  }

  async function initialize(): Promise<void> {
    if (!targetId) return;
    phase = "initializing";
    try {
      await backend.initGavinRoot(targetRoot, existing?.name ?? nameForRoot(targetRoot));
    } catch (e) {
      error = `Couldn't initialize gavin on the host: ${e}`;
      phase = "init-question";
      return;
    }
    // No ignore rule is written: `.gitignore` there is a file on the
    // host, which this machine's git cannot reach. Marked asked so the
    // setup wizard does not put a question the app cannot act on.
    await markGitTrackingAsked(targetId);
    closeSshForm();
  }

  /// Bound as it is: a repo can be a workspace for its terminals long
  /// before anyone wants a board in it, on a host as at home.
  function bindWithoutInit(): void {
    closeSshForm();
  }

  const busy = $derived(phase === "connecting" || phase === "initializing");
</script>

<Modal onClose={closeSshForm}>
  {#if phase === "init-question" || phase === "initializing"}
    <p>Initialize gavin in this folder on {host}?</p>
    <p class="detail">{targetRoot}</p>
    <p class="detail">
      Creates .gavin-root/ there with a PRD template, config, and plans/docs/specs folders. Nothing
      existing is overwritten.
    </p>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" disabled={busy} onclick={initialize}>
        {phase === "initializing" ? "Initializing…" : "Initialize"}
      </button>
      <button type="button" disabled={busy} onclick={bindWithoutInit}>Bind without initializing</button>
      <button type="button" disabled={busy} onclick={closeSshForm}>Cancel</button>
    </div>
  {:else}
    <h2>{existing?.ssh ? `Edit “${existing.name}” over ssh` : "Open a workspace over ssh"}</h2>
    <p class="detail">
      The repository stays on the other machine; gavin's daemon runs there and this window drives it.
      The host needs an ssh login without a password prompt and `gavin-daemon` installed.
    </p>
    <label>
      <span>Host</span>
      <input type="text" bind:value={host} placeholder="box, or me@box, or an alias from ~/.ssh/config" disabled={busy} />
    </label>
    <label>
      <span>Root on the host</span>
      <input type="text" bind:value={rootPath} placeholder="/home/me/repo, or C:/Users/me/repo" disabled={busy} />
    </label>
    <label>
      <span>Daemon path</span>
      <input type="text" bind:value={daemonPath} placeholder="gavin-daemon on the host's PATH (optional)" disabled={busy} />
    </label>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" disabled={busy} onclick={closeSshForm}>Cancel</button>
      <button type="button" class="primary" disabled={busy} onclick={submit}>
        {phase === "connecting" ? "Connecting…" : "Connect"}
      </button>
    </div>
  {/if}
</Modal>

<style>
  h2 {
    margin: 0 0 6px;
    font-size: 1em;
    font-family: monospace;
    color: var(--text);
  }
  p {
    margin: 0 0 10px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
  }
  .detail {
    color: var(--text-subtle);
    font-size: 0.8em;
    word-break: break-all;
  }
  .error {
    color: var(--warning-text);
    font-size: 0.8em;
  }
  label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
  }
  label > span {
    width: 120px;
    flex: 0 0 auto;
    color: var(--text-subtle);
  }
  input {
    flex: 1;
    min-width: 0;
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 4px 8px;
    font-family: monospace;
    font-size: 1em;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
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
  }
  .actions button.primary {
    background: var(--accent, #3a3a3a);
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
