<script lang="ts">
  import Modal from "./Modal.svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { openPath } from "@tauri-apps/plugin-opener";
  import type { CardView } from "./planBoard";
  import type { Column, Label, Priority } from "./kanban";
  import { slugStatus } from "./planBoard";
  import { parseChecklist, stripFrontmatter, type ChecklistItem } from "./planChecklist";
  import { requestedExplorerPath, slugFileName } from "./planExplorer";
  import { patchPlanField, patchPlanCreated } from "./gavinState";
  import type { PlanFileInfo } from "./gavin";
  import { switchWorkspaceView, layoutState } from "./layoutState";
  import { kanbanState, cardSessionFor, unlinkCardSessionAction } from "./kanbanState";
  import { runCard, relaunchCard } from "./cardRunActions";
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
  }
  let { card, workspaceId, columns, labels, allCards, onClose }: Props = $props();

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
  let errorMessage = $state<string | null>(null);

  // --- file content (body preview + checklist) -------------------------
  let content = $state<string | null>(null);
  $effect(() => {
    const path = card.id;
    void backend.readFileForViewer(path).then((r) => {
      if (path === card.id) content = r.exists ? r.content : null;
    });
  });
  const bodyHtml = $derived(
    content !== null ? DOMPurify.sanitize(marked.parse(stripFrontmatter(content), { async: false }) as string) : null
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
      await backend.setPlanFrontmatterField(card.id, key, value);
      patchPlanField(workspaceId, card.id, key, value);
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
  {/if}
  {#if errorMessage}
    <p class="error">{errorMessage}</p>
  {/if}
  <div class="actions">
    <button type="button" onclick={openInPlansTab}>Open in Plans tab</button>
    <button type="button" onclick={() => void openExternally()}>Open externally</button>
    <button type="button" onclick={onClose}>Close</button>
  </div>
</Modal>

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
    border: 1px solid #8a7d55;
    color: #b8a978;
  }
  .kind-badge.kind-task {
    border: 1px solid #4a5568;
    color: #7ea8d8;
  }
  .kind-badge.kind-plan {
    border: 1px solid #4c584c;
    color: #8bc98b;
  }
  .meta {
    color: #999;
    font-size: 0.8em;
  }
  .title {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1.05em;
    font-weight: bold;
    padding: 4px 6px;
    width: 100%;
    box-sizing: border-box;
  }
  .path {
    color: #666;
    font-size: 0.7em;
    margin: 4px 0 10px;
    word-break: break-all;
  }
  .warning {
    color: #d9a648;
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
    color: #999;
    width: 70px;
    flex: 0 0 auto;
  }
  .row select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .broken {
    color: #e0b08a;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    background: transparent;
    border: 1px solid #666;
    color: #999;
    border-radius: 12px;
    padding: 1px 10px;
    font-size: 0.9em;
    cursor: pointer;
    font-family: monospace;
  }
  .chip.active {
    background: #3a3a3a;
    color: #eee;
  }
  .section {
    margin: 12px 0;
  }
  .section-title {
    color: #999;
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
    color: #777;
    text-decoration: line-through;
  }
  .promoted {
    color: #7ea8d8;
    font-size: 0.8em;
  }
  .promote,
  .unparent {
    background: transparent;
    border: 1px solid #444;
    border-radius: 4px;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 0 6px;
    margin-left: auto;
  }
  .check-item input {
    accent-color: #8bc98b;
  }
  .child-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 0.85em;
    padding: 2px 0;
  }
  .child-status {
    color: #999;
  }
  .prompt {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 8px;
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
  .body-preview {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 0.85em;
    max-height: 240px;
    overflow-y: auto;
  }
  .error {
    color: #e0524a;
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
    background: #3a3a3a;
    border: none;
    color: #eee;
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
