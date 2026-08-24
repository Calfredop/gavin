<script lang="ts">
  import Modal from "./Modal.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "./markdown";
  import { openPath } from "@tauri-apps/plugin-opener";
  import type { CardView } from "./planBoard";
  import type { Column, Label, Priority } from "./kanban";
  import { isArchivedCard, slugStatus } from "./planBoard";
  import { parseChecklist, stripFrontmatter, type ChecklistItem } from "./planChecklist";
  import { requestedExplorerPath, slugFileName } from "./planExplorer";
  import { patchPlanField, patchPlanCreated, patchPlanPath } from "./gavinState";
  import type { PlanFileInfo } from "./gavin";
  import { switchWorkspaceView, layoutState, daemonCompat } from "./layoutState";
  import { kanbanState, cardSessionFor, unlinkCardSessionAction } from "./kanbanState";
  import { runCard, relaunchCard } from "./cardRunActions";
  import { findCardPlacement, stepStateOf } from "./orchestration";
  import {
    orchestrations,
    sendCardToRailAction,
    removeCardFromRailAction,
  } from "./orchestrationState";
  import { deletionPlanFor, executeDeletion } from "./cardDelete";
  import { ARCHIVE_CANCELLED, executeArchive, executeUnarchive } from "./archiveActions";
  import { featureBlockedReason } from "./daemonCompat";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import { findSessionLocation } from "./workspace";
  import * as backend from "./backend";

  interface Props {
    card: CardView;
    workspaceId: string;
    columns: Column[];
    labels: Label[];
    // Every card in the projection (nested included) -- used to list this
    // plan's free-standing children.
    allCards: CardView[];
    onClose: () => void;
    // Fires when a field write moved the card's file -- setting it Done
    // archives it into `plans/done/`. The host holds the open card's path
    // as identity, so it has to follow, or the modal vanishes mid-edit.
    onPathChange?: (path: string) => void;
  }
  let { card, workspaceId, columns, labels, allCards, onClose, onPathChange }: Props = $props();

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
  let errorMessage = $state<string | null>(null);

  // --- file content (body preview + checklist) -------------------------
  let content = $state<string | null>(null);
  // Read once, then kept live: the card's file changes under this modal
  // whenever an agent ticks a checklist item or the human edits the plan
  // in another editor, and a stale body preview is worse than no modal.
  // The Rust-side watch is refcounted, so watching a file an editor tab
  // already holds open leaves that tab's watch intact when this closes.
  $effect(() => {
    const path = card.id;
    let unlisten: UnlistenFn | null = null;
    let closed = false;
    const read = () =>
      void backend.readFileForViewer(path).then((r) => {
        if (!closed) content = r.exists ? r.content : null;
      });
    read();
    void backend.watchFileForViewer(path).catch(() => {});
    void listen<string>("file-changed", (event) => {
      if (event.payload === path) read();
    }).then((fn) => (closed ? fn() : (unlisten = fn)));
    return () => {
      closed = true;
      unlisten?.();
      void backend.unwatchFileForViewer(path).catch(() => {});
    };
  });
  const bodyHtml = $derived(
    content !== null ? DOMPurify.sanitize(renderMarkdown(content)) : null
  );
  const checklist = $derived<ChecklistItem[]>(
    card.kind === "plan" && content !== null ? parseChecklist(content) : []
  );
  let checklistError = $state<string | null>(null);

  async function reloadContent(): Promise<void> {
    const r = await backend.readFileForViewer(card.id);
    content = r.exists ? r.content : null;
  }

  async function toggleItem(item: ChecklistItem): Promise<void> {
    checklistError = null;
    try {
      await backend.setChecklistItem(card.id, item.lineIndex, item.rawText, !item.checked);
      await reloadContent();
    } catch (e) {
      // Concurrent agent edit: re-read so the next attempt targets the
      // real line, and say so instead of silently rewriting.
      await reloadContent();
      checklistError = `File changed — checklist re-read, try again. (${e})`;
    }
  }

  async function promoteItem(item: ChecklistItem): Promise<void> {
    checklistError = null;
    try {
      const path = await backend.promoteChecklistItem(card.id, item.rawText);
      const fileName = path.split("/").at(-1) ?? path;
      const created: PlanFileInfo = {
        path,
        fileName,
        title: item.text,
        status: null,
        priority: null,
        order: null,
        kind: "task",
        parent: card.fileName,
        labels: [],
        checklistDone: 0,
        checklistTotal: 0,
        parseWarning: false,
      };
      patchPlanCreated(workspaceId, card.contextFolder, created);
      await reloadContent();
    } catch (e) {
      await reloadContent();
      checklistError = String(e);
    }
  }

  async function unparentChild(childPath: string): Promise<void> {
    errorMessage = null;
    try {
      await backend.setPlanFrontmatterField(childPath, "parent", "");
      patchPlanField(workspaceId, childPath, "parent", "");
    } catch (e) {
      errorMessage = String(e);
    }
  }

  // --- field writes (surgical, patch-on-success) -----------------------
  async function writeField(key: "title" | "status" | "priority" | "labels", value: string): Promise<boolean> {
    errorMessage = null;
    try {
      const moved = await backend.setPlanFrontmatterField(card.id, key, value);
      patchPlanField(workspaceId, card.id, key, value);
      if (moved && moved !== card.id) {
        patchPlanPath(workspaceId, card.id, moved);
        onPathChange?.(moved);
      }
      return true;
    } catch (e) {
      errorMessage = String(e);
      return false;
    }
  }

  let titleDraft = $state("");
  $effect(() => {
    titleDraft = card.title;
  });
  function commitTitle(): void {
    const t = titleDraft.trim();
    if (t && t !== card.title) void writeField("title", t);
    else titleDraft = card.title;
  }

  const nested = $derived(card.parent !== null && card.status === null && !card.parentBroken);
  const statusMatchesColumn = $derived(
    card.status !== null && columns.some((c) => slugStatus(c.name) === slugStatus(card.status ?? ""))
  );
  let statusChoice = $state("");
  $effect(() => {
    statusChoice = card.status ?? "";
  });
  function commitStatus(): void {
    if (statusChoice !== (card.status ?? "")) void writeField("status", statusChoice);
  }

  let priority = $state<Priority>("none");
  $effect(() => {
    priority = card.priority ?? "none";
  });
  function commitPriority(): void {
    void writeField("priority", priority);
  }

  const activeLabelSlugs = $derived(new Set(card.labels.map(slugStatus)));
  async function toggleLabel(name: string): Promise<void> {
    const has = activeLabelSlugs.has(slugStatus(name));
    const next = has
      ? card.labels.filter((l) => slugStatus(l) !== slugStatus(name))
      : [...card.labels, name];
    await writeField("labels", next.join(", "));
  }

  // --- children of a plan ---------------------------------------------
  const freeChildren = $derived(
    card.kind === "plan"
      ? allCards.filter(
          (c) => c.parent === card.fileName && c.contextFolder === card.contextFolder && c.status !== null
        )
      : []
  );

  // --- session block (task/plan, card-model spec §3) -------------------
  const binding = $derived(cardSessionFor($kanbanState[workspaceId], card.id));
  const bindingLive = $derived(
    binding !== null && findSessionLocation($layoutState, binding.sessionId) !== null
  );
  const bindingStatus = $derived(
    binding && bindingLive ? ($layoutState.sessionStatusById[binding.sessionId] ?? "idle") : "exited"
  );

  async function handleRun(): Promise<void> {
    errorMessage = null;
    const err = await runCard(workspaceId, card);
    if (err) errorMessage = err;
    else if (!binding || bindingLive) onClose();
  }

  async function handleRelaunch(): Promise<void> {
    errorMessage = null;
    const err = await relaunchCard(workspaceId, card.id);
    if (err) errorMessage = err;
    else onClose();
  }

  async function handleUnlink(): Promise<void> {
    errorMessage = null;
    await unlinkCardSessionAction(workspaceId, card.id);
  }

  // --- orchestration rail (orchestration spec O2) ----------------------
  // A step is a REFERENCE to this card, so this block only says where the
  // reference sits and offers to move it; nothing about the card changes.
  const orch = $derived($orchestrations[workspaceId] ?? null);
  const rails = $derived([...(orch?.rails ?? [])].sort((a, b) => a.position - b.position));
  const placement = $derived(orch ? findCardPlacement(orch, card.id) : null);
  const placedRail = $derived(rails.find((r) => r.id === placement?.railId) ?? null);
  const placedState = $derived(orch && placement ? stepStateOf(orch, placement.stepId) : null);

  // A chip per rail rather than a picker with a confirm button: there is
  // no draft to hold, so nothing of the human's survives a plan update
  // badly, and one click is the whole gesture.
  async function sendToRail(railId: string): Promise<void> {
    errorMessage = null;
    const err = await sendCardToRailAction(workspaceId, railId, card.id);
    if (err) errorMessage = err;
  }

  async function takeOffRail(): Promise<void> {
    errorMessage = null;
    const err = await removeCardFromRailAction(workspaceId, card.id);
    if (err) errorMessage = err;
  }

  function openOrchestrationTab(): void {
    void switchWorkspaceView(workspaceId, "orchestration");
    onClose();
  }

  let confirmingDelete = $state(false);
  const delPlan = $derived(deletionPlanFor(card, allCards));

  async function confirmDelete(): Promise<void> {
    confirmingDelete = false;
    const err = await executeDeletion(workspaceId, delPlan);
    if (err) errorMessage = err;
    else onClose();
  }

  // --- archive / restore ------------------------------------------------
  // The same pair the card menu carries, on the surface the human is
  // most likely to be looking at when they want it: opening an archived
  // card is how you read it, and reading it is when you decide it comes
  // back.
  const archived = $derived(isArchivedCard(card.id));
  const archiveBlocked = $derived(featureBlockedReason($daemonCompat, "archive"));

  async function toggleArchive(): Promise<void> {
    errorMessage = null;
    const run = archived ? executeUnarchive : executeArchive;
    const err = await run(workspaceId, [card]);
    // Backed out of the "this will close N agents" prompt: the card is
    // exactly where it was, so this modal must be too.
    if (err === ARCHIVE_CANCELLED) return;
    if (err) {
      errorMessage = err;
      return;
    }
    // Closed, not followed: the move rewrote the card's path and the
    // host holds the OLD one as this modal's identity, so staying open
    // would leave the modal resolving nothing. Delete ends the same way.
    onClose();
  }

  function openInPlansTab(): void {
    requestedExplorerPath.set(card.id);
    void switchWorkspaceView(workspaceId, "plans");
    onClose();
  }

  async function openExternally(): Promise<void> {
    errorMessage = null;
    try {
      await openPath(card.id);
    } catch (e) {
      errorMessage = `Couldn't open externally: ${e}`;
    }
  }
</script>

<Modal {onClose}>
  <div class="header">
    <span class="kind-badge kind-{card.kind}">{card.kind}</span>
    <span class="meta">{card.contextName} · {card.fileName}</span>
  </div>
  <input class="title" type="text" bind:value={titleDraft} onblur={commitTitle} onkeydown={(e) => e.key === "Enter" && commitTitle()} />
  <div class="path">{card.id}</div>
  {#if card.parseWarning}
    <p class="warning">This card's frontmatter has issues — some fields may not be readable.</p>
  {/if}
  {#if card.parent}
    <div class="row">
      <span class="label">Part of</span>
      <span class:broken={card.parentBroken}>{card.parentBroken ? `⚠ ${card.parent} (not found)` : card.parentTitle}</span>
    </div>
  {/if}
  <label class="row">
    <span class="label">Status</span>
    <select bind:value={statusChoice} onchange={commitStatus}>
      {#if nested}
        <option value="">(nested in {card.parentTitle})</option>
      {:else if card.status === null}
        <option value="">(none — first column)</option>
      {:else if !statusMatchesColumn}
        <option value={card.status}>{card.status} (auto column)</option>
      {/if}
      {#each columns as col (col.id)}
        <option value={col.name} selected={slugStatus(col.name) === slugStatus(card.status ?? "")}>{col.name}</option>
      {/each}
    </select>
  </label>
  <label class="row">
    <span class="label">Priority</span>
    <select bind:value={priority} onchange={commitPriority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if labels.length > 0}
    <div class="row">
      <span class="label">Labels</span>
      <div class="chips">
        {#each labels as l (l.id)}
          <button
            type="button"
            class="chip"
            class:active={activeLabelSlugs.has(slugStatus(l.name))}
            style:border-color={l.color}
            onclick={() => void toggleLabel(l.name)}
          >
            {l.name}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  {#if card.kind === "plan" && checklist.length > 0}
    <div class="section">
      <div class="section-title">Checklist · {card.checklistDone}/{card.checklistTotal}</div>
      {#each checklist as item (item.lineIndex)}
        <div class="check-item">
          <input
            type="checkbox"
            checked={item.checked}
            onchange={() => void toggleItem(item)}
          />
          <span class="check-text" class:done={item.checked}>{item.text}</span>
          {#if item.promotedFile}
            <span class="promoted" title="Promoted to {item.promotedFile}">→ task</span>
          {:else if slugFileName(item.text)}
            <button type="button" class="promote" onclick={() => void promoteItem(item)}>Promote</button>
          {/if}
        </div>
      {/each}
      {#if checklistError}
        <p class="error">{checklistError}</p>
      {/if}
    </div>
  {/if}
  {#if card.kind === "plan" && (card.nestedChildren.length > 0 || freeChildren.length > 0)}
    <div class="section">
      <div class="section-title">Tasks</div>
      {#each [...card.nestedChildren, ...freeChildren] as child (child.id)}
        <div class="child-row">
          <span class="child-title">{child.title}</span>
          <span class="child-status">{child.status ?? "(nested)"}</span>
          <button type="button" class="unparent" title="Detach from this plan" onclick={() => void unparentChild(child.id)}>
            Un-parent
          </button>
        </div>
      {/each}
    </div>
  {/if}
  {#if card.kind === "task" && bodyHtml !== null}
    <div class="section">
      <div class="section-title">Prompt</div>
      <pre class="prompt">{stripFrontmatter(content ?? "").trim()}</pre>
    </div>
  {:else if bodyHtml !== null && stripFrontmatter(content ?? "").trim() !== ""}
    <div class="section">
      <div class="section-title">Body</div>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized above -->
      <div class="body-preview">{@html bodyHtml}</div>
    </div>
  {/if}
  {#if card.kind !== "note"}
    <div class="section">
      <div class="section-title">Agent session</div>
      {#if binding}
        <div class="session-info">
          <span class="session-status" class:exited={!bindingLive}>{bindingStatus}</span>
          <span class="session-cwd">{binding.cwd}</span>
        </div>
        <div class="session-actions">
          <button type="button" disabled={!bindingLive} onclick={() => void handleRun()}>Jump to session</button>
          <button type="button" disabled={bindingLive} onclick={() => void handleRelaunch()}>Re-launch</button>
          <button type="button" onclick={() => void handleUnlink()}>Unlink</button>
        </div>
      {:else}
        <div class="session-actions">
          <button type="button" onclick={() => void handleRun()}>
            ▶ Run {card.kind === "plan" ? "this plan" : "this task"} with the agent
          </button>
        </div>
      {/if}
    </div>
    <div class="section">
      <div class="section-title">Orchestration rail</div>
      {#if rails.length === 0}
        <p class="quiet">No rails yet — a rail is a column of stages, built on the Orchestration tab.</p>
      {:else if placement}
        <div class="session-info">
          <span class="rail-where">
            On “{placedRail?.name}” · stage {placement.stageNumber} of {placement.stageCount}
          </span>
          <span class="step-state">{placedState}</span>
        </div>
      {:else}
        <p class="quiet">Not on a rail — it won't run as part of any arrangement.</p>
      {/if}
      {#if rails.length > 0}
        <div class="chips rail-chips">
          {#each rails as rail (rail.id)}
            {@const here = rail.id === placement?.railId}
            <button
              type="button"
              class="chip"
              class:active={here}
              disabled={here}
              title={here ? "Already on this rail" : `Send to “${rail.name}” as its last stage`}
              onclick={() => void sendToRail(rail.id)}
            >
              {rail.name}
            </button>
          {/each}
        </div>
      {/if}
      <div class="session-actions">
        {#if placement}
          <button type="button" onclick={() => void takeOffRail()}>Take off rail</button>
        {/if}
        <button type="button" onclick={openOrchestrationTab}>Open Orchestration</button>
      </div>
    </div>
  {/if}
  {#if errorMessage}
    <p class="error">{errorMessage}</p>
  {/if}
  <div class="actions">
    <button type="button" class="danger" onclick={() => (confirmingDelete = true)}>Delete</button>
    <button
      type="button"
      disabled={archiveBlocked !== null}
      title={archiveBlocked ??
        (archived
          ? "Files the card back on the board by its status"
          : "Takes the card off the board — its agents and file tabs close with it")}
      onclick={() => void toggleArchive()}
    >
      {archived ? "Restore from archive" : "Archive"}
    </button>
    <button type="button" onclick={openInPlansTab}>Open in Plans tab</button>
    <button type="button" onclick={() => void openExternally()}>Open externally</button>
    <button type="button" onclick={onClose}>Close</button>
  </div>
</Modal>

{#if confirmingDelete}
  <ConfirmPrompt
    title={`Delete "${card.title}"?`}
    lines={[
      `Deletes ${card.fileName} permanently.`,
      ...(delPlan.files.length > 1 ? [`Also deletes ${delPlan.files.length - 1} nested ${delPlan.files.length - 1 === 1 ? "task" : "tasks"}.`] : []),
      ...(delPlan.unparent.length > 0 ? [`${delPlan.unparent.length} free-standing ${delPlan.unparent.length === 1 ? "task keeps" : "tasks keep"} their column (un-parented).`] : []),
      ...(binding ? ["The bound agent session keeps running on the Agents page."] : []),
    ]}
    choices={[{ label: "Delete", danger: true, onPick: () => void confirmDelete() }]}
    onCancel={() => (confirmingDelete = false)}
  />
{/if}

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .kind-badge {
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .kind-badge.kind-note {
    border: 1px solid var(--border-warning);
    color: var(--warning-text);
  }
  .kind-badge.kind-task {
    border: 1px solid var(--border-accent);
    color: var(--accent-text);
  }
  .kind-badge.kind-plan {
    border: 1px solid var(--border-success);
    color: var(--success-text);
  }
  .meta {
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .title {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1.05em;
    font-weight: bold;
    padding: 4px 6px;
    width: 100%;
    box-sizing: border-box;
  }
  .path {
    color: var(--text-subtle);
    font-size: 0.7em;
    margin: 4px 0 10px;
    word-break: break-all;
  }
  .warning {
    color: var(--warning-text);
    font-size: 0.8em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 0.85em;
  }
  .row .label {
    color: var(--text-muted);
    width: 70px;
    flex: 0 0 auto;
  }
  .row select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: monospace;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .broken {
    color: var(--warning-text);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    border-radius: 12px;
    padding: 1px 10px;
    font-size: 0.9em;
    cursor: pointer;
    font-family: monospace;
  }
  .chip.active {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .section {
    margin: 12px 0;
  }
  .section-title {
    color: var(--text-muted);
    font-size: 0.8em;
    margin-bottom: 6px;
  }
  .check-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.85em;
    padding: 2px 0;
  }
  .check-text.done {
    color: var(--text-subtle);
    text-decoration: line-through;
  }
  .promoted {
    color: var(--accent-text);
    font-size: 0.8em;
  }
  .promote,
  .unparent {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 0 6px;
    margin-left: auto;
  }
  .check-item input {
    accent-color: var(--success);
  }
  .child-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 0.85em;
    padding: 2px 0;
  }
  .child-status {
    color: var(--text-muted);
  }
  .prompt {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
  .body-preview {
    -webkit-user-select: text;
    user-select: text;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 0.85em;
    max-height: 240px;
    overflow-y: auto;
  }
  .error {
    color: var(--danger-text);
    font-size: 0.8em;
  }
  .session-info {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.85;
    margin-bottom: 6px;
  }
  .session-status.exited {
    opacity: 0.6;
  }
  .session-cwd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: 10px;
  }
  .session-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .session-actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.8em;
  }
  .session-actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rail-chips {
    margin-bottom: 8px;
  }
  .chip:disabled {
    cursor: default;
  }
  .quiet {
    margin: 0 0 6px;
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .rail-where {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-state {
    color: var(--text-muted);
    margin-left: 10px;
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
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.danger {
    background: var(--surface-danger);
    color: var(--danger-text);
    margin-right: auto;
  }
  /* Blocked by daemon skew: the title says why, so the row must read as
     unavailable rather than as an unresponsive button. */
  .actions button:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
</style>
