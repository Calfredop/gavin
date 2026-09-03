<script lang="ts">
  import Modal from "./Modal.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "./markdown";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { CardView } from "./planBoard";
  import type { Column, Label, Priority } from "./kanban";
  import { isArchivedCard, slugStatus } from "./planBoard";
  import { childCards, parentCard } from "./cardRelations";
  import { parseChecklist, stripFrontmatter, type ChecklistItem } from "./planChecklist";
  import { requestedExplorerFile, slugFileName } from "./planExplorer";
  import { patchPlanField, patchPlanCreated, patchPlanPath } from "./gavinState";
  import type { PlanFileInfo } from "./gavin";
  import {
    switchWorkspaceView,
    layoutState,
    daemonCompat,
    workspaceRootPath,
    openFileInSplit,
    resolvedAgents,
    liveSessionIds,
  } from "./layoutState";
  import {
    addAttachment,
    attachmentFromPick,
    attachmentName,
    formatAttachments,
    removeAttachment,
    type AttachmentStatus,
  } from "./attachments";
  import { autoCommitAppliesTo, hasAutoCommit, setAutoCommitInFile } from "./autoCommit";
  import { isViewableInApp } from "./fileTypes";
  import StatusBadge from "./ui/StatusBadge.svelte";
  import {
    agentExitedIndicator,
    agentFailedIndicator,
    agentIndicator,
    agentInterruptedIndicator,
  } from "./ui/indicators";
  import { bestOfNRequest, bestOfNRuns, candidateLiveness, runForCard, runSummary } from "./bestOfNState";
  import { pickCandidate, abandonRun } from "./bestOfNActions";
  import { kanbanState, cardSessionFor, unlinkCardSessionAction } from "./kanbanState";
  import { runCard, resumeCard, relaunchCard, developCard, revealSession } from "./cardRunActions";
  import { cardSessionState } from "./columnRunAction";
  import { developAvailable, agentPromptBlocker } from "./cardRun";
  import { resumeNoteFor } from "./autoResume";
  import { resumeTrail } from "./autoResumeState";
  import { findCardPlacement, stepStateOf } from "./orchestration";
  import {
    orchestrations,
    sendCardToRailAction,
    removeCardFromRailAction,
  } from "./orchestrationState";
  import { deletionPlanFor, executeDeletion } from "./cardDelete";
  import { ARCHIVE_CANCELLED, executeArchive, executeUnarchive } from "./archiveActions";
  import { featureBlockedReason } from "./daemonCompat";
  import { interruptedCardNote } from "./orphan";
  import { endSessionOrphan } from "./orphanActions";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
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
    // Swap the modal onto a related card -- a child in the Tasks list,
    // or the plan in "Part of". The host owns the open path, so this is
    // the same write it makes when the board opens a card. Required: a
    // detail modal that cannot reach the cards it names is the bug this
    // exists to fix, so every surface has to answer the question.
    onOpenCard: (path: string) => void;
    // Fires when a field write moved the card's file -- setting it Done
    // archives it into `plans/done/`. The host holds the open card's path
    // as identity, so it has to follow, or the modal vanishes mid-edit.
    onPathChange?: (path: string) => void;
  }
  let { card, workspaceId, columns, labels, allCards, onClose, onOpenCard, onPathChange }: Props =
    $props();

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
    // The Tasks list and "Part of" repoint this modal at another card
    // WITHOUT unmounting it, so everything held about the old one has to
    // go now: a stale body under the new title reads as that card's, and
    // a stale error accuses it of a failure it never had.
    content = null;
    errorMessage = null;
    checklistError = null;
    attachmentsError = null;
    autoCommitError = null;
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
  async function writeField(
    key: "title" | "status" | "priority" | "labels" | "attachments",
    value: string
  ): Promise<boolean> {
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

  // --- auto commit (does this card ask its agent to commit?) ------------
  // The state is a fenced block in the card's BODY, not a frontmatter
  // field, so it travels to every agent that reads the card without
  // anything being wired up per launch route -- and so it needs no
  // protocol bump to work. That means writing the FILE rather than a
  // field: `setPlanFrontmatterField` cannot reach the body.
  //
  // Task and plan only: nothing ever executes a note, so the instruction
  // would be text no agent reads, on a card with nothing to finish.
  const autoCommitApplies = $derived(autoCommitAppliesTo(card.kind));
  const autoCommitOn = $derived(hasAutoCommit(content));
  let autoCommitBusy = $state(false);
  let autoCommitError = $state<string | null>(null);

  async function toggleAutoCommit(on: boolean): Promise<void> {
    autoCommitError = null;
    autoCommitBusy = true;
    try {
      // Re-read first, and splice THAT. `content` is a watched snapshot
      // behind a 500ms debounce, so an agent's edit can be seconds old by
      // the time the box is clicked -- and this write replaces the whole
      // file, so splicing the stale copy would silently undo that edit.
      const current = await backend.readFileForViewer(card.id);
      if (!current.exists) {
        autoCommitError = "The card's file is gone.";
        await reloadContent();
        return;
      }
      const next = setAutoCommitInFile(current.content, on);
      // Unchanged means the frontmatter never closes, so there is no body
      // to splice -- setAutoCommitInFile refuses rather than guessing.
      if (next === current.content) {
        content = current.content;
        if (hasAutoCommit(next) !== on) {
          autoCommitError =
            "This card's frontmatter block is never closed, so gavin can't tell where the body starts. Fix the --- lines and try again.";
        }
        return;
      }
      await backend.writeFileForEditor(card.id, next);
      // Set now rather than waiting for the watcher: the box would
      // otherwise sit in its old position for the debounce and read as a
      // click that did nothing.
      content = next;
    } catch (e) {
      autoCommitError = String(e instanceof Error ? e.message : e);
      await reloadContent();
    } finally {
      autoCommitBusy = false;
    }
  }

  // --- attachments (files the card points an agent at) ------------------
  // Every kind, notes included: a note is a fine place to park a
  // reference. Only task and plan cards put them in a prompt.
  const attachments = $derived(card.attachments ?? []);
  const attachmentsBlocked = $derived(featureBlockedReason($daemonCompat, "attachments"));
  let attachmentStatuses = $state<AttachmentStatus[]>([]);
  let attachmentsError = $state<string | null>(null);
  let attachmentsBusy = $state(false);

  // Stat'd HERE rather than on scan: the daemon never touches these
  // paths, so the board card face can only show a count and this modal
  // is the first place brokenness can be seen at all.
  //
  // The token counter is the supersession guard (a $state proxy makes
  // identity comparison useless): removing a chip fires this again while
  // the previous stat is still in flight, and the older answer must not
  // land on top of the newer one.
  let statToken = 0;
  $effect(() => {
    const paths = attachments;
    const root = workspaceRootPath(workspaceId);
    const mine = ++statToken;
    if (paths.length === 0) {
      attachmentStatuses = [];
      return;
    }
    if (root === null) {
      attachmentStatuses = paths.map((path) => ({ path, absolutePath: null, exists: false }));
      return;
    }
    void backend
      .attachmentStatus(root, [...paths])
      .then((r) => {
        if (mine === statToken) attachmentStatuses = r;
      })
      .catch(() => {
        // Unknown beats a confident lie: an unresolved chip reads
        // broken, which is also what the run gate will say.
        if (mine === statToken) {
          attachmentStatuses = paths.map((path) => ({ path, absolutePath: null, exists: false }));
        }
      });
  });

  async function writeAttachments(next: string[]): Promise<void> {
    attachmentsError = null;
    attachmentsBusy = true;
    try {
      // formatAttachments([]) is "", which is what clears the whole
      // line -- an empty `attachments:` would leave a card still
      // reading as though it references a file.
      await writeField("attachments", formatAttachments(next));
    } finally {
      attachmentsBusy = false;
    }
  }

  // The PRD/agent pickers' dialog -> validate -> commit shape
  // (HubFilePicker), with one difference: a file OUTSIDE the root is a
  // legal answer here rather than an error, and is stored absolute.
  async function pickAttachment(): Promise<void> {
    attachmentsError = null;
    const root = workspaceRootPath(workspaceId);
    if (root === null) {
      attachmentsError = "This workspace has no root folder, so an attachment has nothing to be relative to.";
      return;
    }
    attachmentsBusy = true;
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        defaultPath: root,
        title: "Attach a file to this card",
      });
      // A cancelled dialog is not an error, and must not clear the
      // message from the pick before it.
      if (typeof picked !== "string") return;
      await writeAttachments(addAttachment(attachments, attachmentFromPick(root, picked)));
    } catch (e) {
      attachmentsError = String(e instanceof Error ? e.message : e);
    } finally {
      attachmentsBusy = false;
    }
  }

  // A split needs a terminal session to anchor to; file and board tabs
  // are not sessions. Null means the app has no pane to split, and the
  // chip falls back to the OS's default application -- an honest second
  // choice, rather than a click that does nothing.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if ($layoutState.fileTabsById[focused] || $layoutState.boardTabsById[focused]) return null;
    return focused;
  });

  async function openAttachment(status: AttachmentStatus): Promise<void> {
    attachmentsError = null;
    if (!status.exists || status.absolutePath === null) return;
    const path = status.absolutePath;
    try {
      if (anchorSessionId && (await isViewableInApp(path))) {
        await switchWorkspaceView(workspaceId, "terminal");
        await openFileInSplit(anchorSessionId, path);
        onClose();
        return;
      }
      await openPath(path);
    } catch (e) {
      attachmentsError = `Couldn't open ${attachmentName(path)}: ${e instanceof Error ? e.message : e}`;
    }
  }

  // --- the cards around this one (cardRelations.ts) --------------------
  const children = $derived(childCards(card, allCards));
  // The way back out of a child, and the only one: nothing else on this
  // modal leads to the plan a task belongs to.
  const partOf = $derived(parentCard(card, allCards));

  // --- session block (task/plan, card-model spec §3) -------------------
  const binding = $derived(cardSessionFor($kanbanState[workspaceId], card.id));
  const sessionState = $derived(cardSessionState($layoutState, binding));
  const bindingLive = $derived(sessionState === "live");
  const bindingInterrupted = $derived(sessionState === "interrupted");
  // The process this binding's agent left running, if the daemon found
  // one. Read straight off the store rather than through
  // `cardSessionState`, deliberately: that function answers "can this
  // card be jumped to / re-run", which an orphan does not change --
  // the tab still holds the same bare shell. This is a separate fact
  // about a process, and folding it into the liveness enum would make
  // every consumer of that enum re-decide something none of them ask.
  const bindingOrphan = $derived(
    binding ? ($layoutState.orphanBySessionId[binding.sessionId] ?? null) : null
  );
  const bindingFailed = $derived(sessionState === "failed");
  /// The agent's own account of what broke, when something did.
  const failureReason = $derived(
    binding ? ($layoutState.failureReasonById[binding.sessionId] ?? null) : null
  );

  /// What gavin did to this run without being asked. The detail comes
  /// from the in-memory trail while the window that watched it is open;
  /// the persisted attempt count keeps the FACT after a reload.
  const resumeNote = $derived(
    binding ? resumeNoteFor($resumeTrail[binding.path], binding.resumeAttempts) : null
  );
  // The daemon's status describes whatever occupies the session id NOW,
  // which for an interrupted run is the bare shell that replaced the
  // agent -- so it is not consulted at all there.
  const bindingStatus = $derived(
    bindingInterrupted
      ? "interrupted"
      : bindingFailed
        ? "stopped — something broke"
        : binding && bindingLive
          ? ($layoutState.sessionStatusById[binding.sessionId] ?? "idle")
          : "exited"
  );
  // The same badge the board card, the terminal tab and the sidebar row
  // draw for this very session -- the detail modal used to say the state
  // in a bare word, which is accurate but shares nothing with the three
  // surfaces the human just came from.
  // Interrupted and failed come first for the same reason bindingStatus
  // puts them first: the daemon's status is not the run's.
  const bindingBadge = $derived(
    bindingInterrupted
      ? agentInterruptedIndicator()
      : bindingFailed
        ? agentFailedIndicator(failureReason)
        : binding && bindingLive
          ? agentIndicator($layoutState.sessionStatusById[binding.sessionId])
          : agentExitedIndicator()
  );

  async function handleRun(): Promise<void> {
    errorMessage = null;
    const err = await runCard(workspaceId, card);
    if (err) errorMessage = err;
    else if (!binding || bindingLive) onClose();
  }

  // The answer to an interrupted run, and the reason it gets its own
  // button rather than reusing Re-launch: Re-launch replays the ORIGINAL
  // command, which is the from-scratch second attempt this whole flow
  // exists to prevent. Resume composes the gavin-resume prompt instead,
  // which tells the new agent to find the work already done first.
  async function handleResume(): Promise<void> {
    errorMessage = null;
    const err = await resumeCard(workspaceId, card);
    if (err) errorMessage = err;
    else onClose();
  }

  // Same rule as the board's context menu (developAvailable): a thin To
  // Do card gets an interview before it gets an agent.
  const canDevelop = $derived(developAvailable(card.kind, card.status, binding !== null));

  // Both buttons below build the agent's command line, so both are
  // blocked by an agent that takes no prompt -- and for a reason that is
  // about the WORKSPACE, not this card. Re-launch is deliberately not
  // gated: it replays the command the first launch stored, and never
  // builds one.
  const runBlocked = $derived(
    agentPromptBlocker($resolvedAgents(workspaceId).promptArgs, $resolvedAgents(workspaceId).label)
  );

  async function handleDevelop(): Promise<void> {
    errorMessage = null;
    const err = await developCard(workspaceId, card);
    if (err) errorMessage = err;
    else onClose();
  }

  // --- best-of-N ------------------------------------------------------
  // A run is the card's agent situation while it lasts: N sessions, no
  // binding, and one decision to make. It replaces the binding block
  // above rather than sitting beside it.
  const bestOfNRun = $derived(runForCard($bestOfNRuns[workspaceId], card.id));
  const liveIds = $derived(liveSessionIds($layoutState));
  const candidateRows = $derived(bestOfNRun ? candidateLiveness(bestOfNRun, liveIds) : []);

  function startBestOfN(): void {
    // Closed first: both are fixed layers at the same z-index, and this
    // modal is mounted inside whichever board is showing, so tree order
    // would otherwise draw the dialog behind it.
    onClose();
    bestOfNRequest.set({ workspaceId, card });
  }

  async function handlePick(sessionId: string): Promise<void> {
    errorMessage = null;
    if (!bestOfNRun) return;
    const err = await pickCandidate(workspaceId, bestOfNRun, sessionId);
    if (err) errorMessage = err;
  }

  async function handleAbandon(): Promise<void> {
    errorMessage = null;
    if (!bestOfNRun) return;
    const err = await abandonRun(workspaceId, bestOfNRun);
    if (err) errorMessage = err;
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

  // Lands on the Plans tab with this card's file selected and its editor
  // in Edit mode: the action is named for the editor, so the human
  // arrives ready to type rather than one mode-click away from it.
  function openInCardEditor(): void {
    requestedExplorerFile.set({ path: card.id, mode: "edit" });
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

<Modal {onClose} scrollKey={card.id}>
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
      {#if partOf}
        <button type="button" class="card-link" title={partOf.title} onclick={() => onOpenCard(partOf.id)}>
          {partOf.title}
        </button>
      {:else}
        <span class:broken={card.parentBroken}>{card.parentBroken ? `⚠ ${card.parent} (not found)` : card.parentTitle}</span>
      {/if}
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
  {#if autoCommitApplies}
    <label class="row auto-commit">
      <span class="label">Auto commit</span>
      <input
        type="checkbox"
        checked={autoCommitOn}
        disabled={autoCommitBusy || content === null}
        onchange={(e) => void toggleAutoCommit(e.currentTarget.checked)}
      />
      <span class="auto-commit-hint">
        <!-- Unknown is not the same answer as off. Until the read lands
             the box is disabled and says so, rather than showing an
             unticked box for a card that does carry the block. -->
        {content === null
          ? "Reading the card…"
          : autoCommitOn
            ? "This card asks its agent to commit when it finishes."
            : "This card says nothing about committing."}
      </span>
    </label>
    {#if autoCommitError}
      <p class="error">{autoCommitError}</p>
    {/if}
  {/if}
  <!-- The blocked reason rides the SECTION, not the button: tooltip.ts
       binds mouseenter, which a disabled element never fires, so a
       reason hung on the disabled control alone can never be read. -->
  <div class="section" title={attachmentsBlocked ?? undefined}>
    <div class="section-title">
      Attachments{attachments.length > 0 ? ` · ${attachments.length}` : ""}
    </div>
    {#if attachments.length === 0}
      <p class="quiet">
        No files attached. An attached file is handed to every agent this card launches.
      </p>
    {/if}
    <div class="chips attachment-chips">
      {#each attachments as path (path)}
        {@const status = attachmentStatuses.find((s) => s.path === path) ?? null}
        {@const broken = status !== null && !status.exists}
        <span class="attachment" class:broken>
          <button
            type="button"
            class="attachment-open"
            disabled={status === null || broken}
            title={broken
              ? `${path} — not found. Fix or remove it: a missing attachment blocks every run of this card.`
              : path}
            onclick={() => status && void openAttachment(status)}
          >
            {broken ? "⚠ " : ""}{attachmentName(path)}
          </button>
          <button
            type="button"
            class="attachment-remove"
            aria-label={`Remove ${attachmentName(path)}`}
            disabled={attachmentsBusy || attachmentsBlocked !== null}
            title={attachmentsBlocked ?? "Take this file off the card"}
            onclick={() => void writeAttachments(removeAttachment(attachments, path))}
          >
            ✕
          </button>
        </span>
      {/each}
    </div>
    <div class="session-actions">
      <button
        type="button"
        disabled={attachmentsBusy || attachmentsBlocked !== null}
        title={attachmentsBlocked ??
          "Pick a file for this card — inside the root it is stored relative, outside it absolute"}
        onclick={() => void pickAttachment()}
      >
        Pick…
      </button>
    </div>
    {#if attachmentsError}
      <p class="error">{attachmentsError}</p>
    {/if}
  </div>
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
  {#if children.length > 0}
    <div class="section">
      <div class="section-title">Tasks</div>
      {#each children as child (child.id)}
        <div class="child-row">
          <button type="button" class="child-open" title="Open this task's card" onclick={() => onOpenCard(child.id)}>
            <span class="child-title" title={child.title}>{child.title}</span>
            <span class="child-status">{child.status ?? "(nested)"}</span>
          </button>
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
      <div class="section-title">{bestOfNRun ? `Best of ${bestOfNRun.candidates.length}` : "Agent session"}</div>
      {#if bestOfNRun}
        <!-- A run replaces the binding block entirely: the card has N
             agents and no binding at all until one is picked, so every
             control here is about deciding between them. -->
        <p class="quiet">{runSummary(bestOfNRun, liveIds)} — each in its own worktree. Picking one keeps its
          branch and closes the rest; merging is still yours.</p>
        {#each candidateRows as row (row.candidate.sessionId)}
          <div class="candidate-row">
            <StatusBadge
              indicator={row.live ? agentIndicator($layoutState.sessionStatusById[row.candidate.sessionId]) : agentExitedIndicator()}
              size={12}
              text={row.live ? "running" : "stopped"}
            />
            <span class="candidate-label" title={row.candidate.worktreePath}>{row.candidate.label}</span>
            <code class="candidate-branch">{row.candidate.branch}</code>
            <button
              type="button"
              title="Jump to this candidate's terminal"
              disabled={!row.live}
              onclick={() => void revealSession(row.candidate.sessionId)}>Watch</button
            >
            <button type="button" class="pick" onclick={() => void handlePick(row.candidate.sessionId)}>Keep this one</button>
          </div>
        {/each}
        <div class="session-actions">
          <button type="button" class="danger" onclick={() => void handleAbandon()}>Discard the run…</button>
        </div>
      {:else if binding}
        <div class="session-info">
          <StatusBadge indicator={bindingBadge} size={12} text={bindingStatus} class="session-status" />
          <span class="session-cwd">{binding.cwd}</span>
        </div>
        {#if bindingFailed}
          <p class="session-note">
            This agent stopped because something broke, not because it finished{failureReason
              ? ` — ${failureReason}`
              : ""}. The process is still sitting at its prompt and whatever it had
            already written is still in the checkout. Resume picks the work up — where
            this agent supports it, by reopening the same conversation rather than
            starting a new one.
          </p>
        {/if}
        {#if resumeNote}
          <!-- A run gavin put back by itself. Without this the card
               reads as one that never broke -- which is the whole point
               of the trail: coming back to finished work, you have to be
               able to find out it was not finished all along. -->
          <p class="session-note">Recovered on its own: {resumeNote}.</p>
        {/if}
        {#if bindingInterrupted || bindingOrphan}
          <!-- One paragraph for both, from orphan.ts: the interrupted
               wording splits on whether the daemon PROBED, and the orphan
               case says the agent did not stop at all. -->
          <p class="session-note" class:orphaned={bindingOrphan !== null}>
            {interruptedCardNote({ orphan: bindingOrphan, compat: $daemonCompat })}
          </p>
        {/if}
        <div class="session-actions">
          <!-- First, and ahead of Resume: resuming beside an agent that
               never stopped is the second-agent-in-one-checkout outcome
               this card exists to prevent, and it is reached from the
               button right next to this one. -->
          {#if bindingOrphan && binding}
            <button
              type="button"
              class="danger"
              onclick={() => void endSessionOrphan(binding.sessionId)}
              >End the running process</button
            >
          {/if}
          {#if bindingInterrupted || bindingFailed}
            <button type="button" onclick={() => void handleResume()}>Resume this card</button>
          {/if}
          <button type="button" disabled={!bindingLive} onclick={() => void handleRun()}>Jump to session</button>
          <button type="button" disabled={bindingLive} onclick={() => void handleRelaunch()}>Re-launch</button>
          <button type="button" onclick={() => void handleUnlink()}>Unlink</button>
        </div>
      {:else}
        <!-- Stacked, not side by side: both labels are sentences rather
             than verbs, so on one row they wrap mid-label and the two
             actions read as one ragged block. -->
        <div class="session-actions stacked">
          {#if canDevelop}
            <button
              type="button"
              disabled={runBlocked !== null}
              onclick={() => void handleDevelop()}
            >
              Develop into a plan…
            </button>
          {/if}
          <button type="button" disabled={runBlocked !== null} onclick={() => void handleRun()}>
            ▶ Run {card.kind === "plan" ? "this plan" : "this task"} with the agent
          </button>
          <!-- The same card on several agents at once. The modal closes
               as it opens the dialog: both are fixed layers at one
               z-index, so tree order decides, and this one is mounted
               inside whichever board is showing. -->
          <button type="button" disabled={runBlocked !== null} onclick={() => startBestOfN()}>
            Run it on several agents…
          </button>
        </div>
        <!-- Inline rather than a tooltip: a disabled button fires no
             mouseenter, and this modal has the room to just say it. -->
        {#if runBlocked}
          <p class="quiet">{runBlocked}</p>
        {/if}
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
    <button
      type="button"
      title="Opens this card's file on the Plans tab, ready to edit"
      onclick={openInCardEditor}
    >
      Open in card editor
    </button>
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
  .attachment-chips {
    margin-bottom: 6px;
  }
  .attachment {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .attachment.broken {
    border-color: var(--border-warning);
  }
  .attachment-open,
  .attachment-remove {
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.75em;
    padding: 2px 8px;
  }
  .attachment.broken .attachment-open {
    color: var(--warning-text);
  }
  .attachment-open:disabled {
    cursor: default;
  }
  .attachment-remove {
    color: var(--text-subtle);
    padding-left: 2px;
  }
  .attachment-remove:disabled {
    opacity: 0.4;
    cursor: default;
  }
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
  .auto-commit {
    cursor: pointer;
  }
  /* The only label here longer than the 70px column the other rows share
     ("Priority", the previous longest, is three characters shorter). A
     fixed width would push it into the control beside it, so this row
     alone takes the width it needs and keeps 70px as the floor -- the
     shorter rows stay aligned with each other. */
  .auto-commit .label {
    width: auto;
    min-width: 70px;
    white-space: nowrap;
  }
  .auto-commit input:disabled {
    cursor: default;
  }
  .auto-commit-hint {
    color: var(--text-subtle);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 0.85em;
    padding: 2px 0;
  }
  /* A link to another card, not a control: activating it swaps this
     modal onto that card, which is the same move clicking the card on
     the board makes. Styled as text so the Tasks list still reads as a
     list, with the row only lighting up under the pointer. */
  .child-open {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    margin: 0 -4px;
    padding: 1px 4px;
    text-align: left;
  }
  .child-open:hover {
    background: var(--surface-base);
  }
  .child-open:hover .child-title,
  .card-link:hover {
    text-decoration: underline;
  }
  .child-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .child-status {
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  /* The "Part of" link, same navigation the other way: a nested task's
     only route back to the plan it belongs to. */
  .card-link {
    background: transparent;
    border: none;
    color: var(--accent-text);
    cursor: pointer;
    font: inherit;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  /* Positioning only -- the badge owns its own tone, exited included
     (a neutral, struck-through circle). */
  .session-info :global(.session-status) {
    flex: 0 0 auto;
  }
  .session-note.orphaned {
    color: var(--danger-text);
  }
  .session-actions button.danger {
    border-color: var(--danger);
    color: var(--danger-text);
  }
  .session-note {
    margin: 6px 0 8px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .session-cwd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: 10px;
  }
  /* One row per candidate: state, who it is, its branch, and the two
     things there are to do with it. The label takes the slack and
     ellipsizes, because the branch beside it is the shorter, more
     identifying half once two candidates share a profile. */
  .candidate-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(0, auto) auto auto;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 0.85em;
  }
  .candidate-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .candidate-branch {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .candidate-row button {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.95em;
    padding: 3px 9px;
  }
  .candidate-row button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .candidate-row button.pick {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }

  .session-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  /* Each button keeps its own row and stays sized to its label -- a
     stretched button would read as a banner, not as an action. */
  .session-actions.stacked {
    flex-direction: column;
    align-items: flex-start;
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
