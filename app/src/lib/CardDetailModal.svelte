<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { Card, Label, Priority, SessionLink } from "./kanban";
  import { linkSessionAction, unlinkSessionAction, updateSessionLinkAction } from "./kanbanState";
  import { layoutState, switchWorkspaceView, switchToSessionInPage, createSessionForCard } from "./layoutState";
  import { findSessionLocation, allSessionIdsInWorkspace } from "./workspace";
  import { sessionLabel } from "./paths";

  interface Props {
    card: Card;
    labels: Label[];
    workspaceId: string;
    onSave: (patch: { title: string; description: string; priority: Priority; labelIds: string[] }) => void;
    onClose: () => void;
  }
  let { card, labels, workspaceId, onSave, onClose }: Props = $props();

  let title = $state(card.title);
  let description = $state(card.description);
  let priority = $state<Priority>(card.priority);
  let labelIds = $state<string[]>([...card.labelIds]);

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

  function toggleLabel(labelId: string): void {
    labelIds = labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : [...labelIds, labelId];
  }

  function handleSave(): void {
    onSave({ title, description, priority, labelIds });
    onClose();
  }

  const workspaceSessionIds = $derived.by(() => {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return ws ? allSessionIdsInWorkspace(ws) : [];
  });

  function labelFor(sessionId: string): string {
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  let selectedExistingSessionId = $state("");
  let newSessionCwd = $state("");
  let newSessionCommand = $state("");

  async function linkExisting(): Promise<void> {
    if (!selectedExistingSessionId) return;
    const link: SessionLink = {
      sessionId: selectedExistingSessionId,
      cwd: $layoutState.cwdBySessionId[selectedExistingSessionId] ?? "",
      command: null,
    };
    await linkSessionAction(workspaceId, card.id, link);
    selectedExistingSessionId = "";
  }

  async function createAndLink(): Promise<void> {
    const cwd = newSessionCwd.trim();
    const command = newSessionCommand.trim() || null;
    const sessionId = await createSessionForCard(workspaceId, cwd, command);
    if (!sessionId) return;
    await linkSessionAction(workspaceId, card.id, { sessionId, cwd, command });
    newSessionCwd = "";
    newSessionCommand = "";
  }

  const linkedLocation = $derived(
    card.sessionLink ? findSessionLocation($layoutState, card.sessionLink.sessionId) : null
  );
  const linkedStatus = $derived(
    card.sessionLink && linkedLocation ? ($layoutState.sessionStatusById[card.sessionLink.sessionId] ?? "idle") : null
  );

  async function jumpToSession(): Promise<void> {
    if (!card.sessionLink || !linkedLocation) return;
    await switchWorkspaceView(linkedLocation.workspaceId, "terminal");
    await switchToSessionInPage(linkedLocation.workspaceId, linkedLocation.pageId, card.sessionLink.sessionId);
    onClose();
  }

  async function relaunchSession(): Promise<void> {
    if (!card.sessionLink) return;
    const sessionId = await createSessionForCard(workspaceId, card.sessionLink.cwd, card.sessionLink.command);
    if (!sessionId) return;
    await updateSessionLinkAction(workspaceId, card.id, sessionId);
  }

  async function unlinkSession(): Promise<void> {
    await unlinkSessionAction(workspaceId, card.id);
  }
</script>

<Modal {onClose}>
  <label class="field">
    Title
    <input type="text" bind:value={title} />
  </label>
  <label class="field">
    Description
    <textarea bind:value={description} rows="4"></textarea>
  </label>
  <label class="field">
    Priority
    <select bind:value={priority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if labels.length > 0}
    <div class="field">
      Labels
      <div class="labels">
        {#each labels as label (label.id)}
          <button
            type="button"
            class="label-chip"
            class:active={labelIds.includes(label.id)}
            style:border-color={label.color}
            onclick={() => toggleLabel(label.id)}
          >
            {label.name}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="field">
    Session
    {#if card.sessionLink}
      <div class="session-info">
        <span class="session-status" class:exited={!linkedLocation}>{linkedLocation ? linkedStatus : "exited"}</span>
        <span class="session-cwd">{card.sessionLink.cwd || "(default)"}</span>
      </div>
      <div class="session-actions">
        <button type="button" disabled={!linkedLocation} onclick={jumpToSession}>Jump to session</button>
        <button type="button" disabled={!!linkedLocation} onclick={relaunchSession}>Re-launch</button>
        <button type="button" onclick={unlinkSession}>Unlink</button>
      </div>
    {:else}
      <div class="session-link-existing">
        <select bind:value={selectedExistingSessionId}>
          <option value="">Select a session…</option>
          {#each workspaceSessionIds as sessionId (sessionId)}
            <option value={sessionId}>{labelFor(sessionId)}</option>
          {/each}
        </select>
        <button type="button" disabled={!selectedExistingSessionId} onclick={linkExisting}>Link existing session</button>
      </div>
      <div class="session-create-new">
        <input type="text" placeholder="Command (optional)" bind:value={newSessionCommand} />
        <input type="text" placeholder="Working directory (optional)" bind:value={newSessionCwd} />
        <button type="button" onclick={createAndLink}>Create new session</button>
      </div>
    {/if}
  </div>
  <div class="actions">
    <button type="button" onclick={onClose}>Cancel</button>
    <button type="button" onclick={handleSave}>Save</button>
  </div>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
    font-size: 0.85em;
  }
  input,
  textarea,
  select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .label-chip {
    background: transparent;
    border: 1px solid #666;
    color: #eee;
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 0.8em;
    cursor: pointer;
  }
  .label-chip.active {
    background: #3a3a3a;
    border-width: 2px;
  }
  .session-info {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.85;
  }
  .session-status.exited {
    opacity: 0.6;
  }
  .session-actions,
  .session-link-existing,
  .session-create-new {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .session-create-new {
    flex-direction: column;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
