<script lang="ts">
  import Modal from "$lib/Modal.svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "$lib/files/markdown";
  import { pickPath } from "$lib/picker";
  import type { CardView } from "$lib/planBoard";
  import type { Column, Label, Priority } from "$lib/board/kanban";
  import { isArchivedCard, slugStatus } from "$lib/planBoard";
  import { childCards, parentCard } from "$lib/cards/cardRelations";
  import { parseChecklist, stripFrontmatter, type ChecklistItem } from "$lib/cards/planChecklist";
  import { requestedExplorerFile, slugFileName } from "$lib/files/planExplorer";
  import { patchPlanField, patchPlanCreated, patchPlanPath } from "$lib/gavinState";
  import type { PlanFileInfo } from "$lib/gavin";
  import {
    switchWorkspaceView,
    layoutState,
    daemonCompat,
    workspaceRootPath,
    openFileInSplit,
    resolvedAgents,
    liveSessionIds,
    agentDefaultsStore,
    agentProfilesStore,
    attentionStatusById,
    requireReviewDefault,
  } from "$lib/layoutState";
  import {
    COMPLEXITY_LABELS,
    COMPLEXITY_LEVELS,
    NO_COMPLEXITY,
  } from "$lib/cards/complexity";
  import CardAgentControls from "$lib/cards/CardAgentControls.svelte";
  import { cardAgentSummary } from "$lib/cards/cardAgent";
  import {
    addAttachment,
    attachmentFromPick,
    attachmentName,
    formatAttachments,
    removeAttachment,
    resolvedAttachmentPaths,
    withheldAttachmentPaths,
    type AttachmentStatus,
  } from "$lib/cards/attachments";
  import { autoCommitAppliesTo, hasAutoCommit, setAutoCommitInFile } from "$lib/git/autoCommit";
  import { isViewableInApp } from "$lib/files/fileTypes";
  import { ChevronDown, ChevronRight, Lock, SquareArrowOutUpRight } from "@lucide/svelte";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import {
    agentDevelopingIndicator,
    agentExitedIndicator,
    agentFailedIndicator,
    agentIndicator,
    agentQueuedIndicator,
    queuedBadgeText,
    agentInterruptedIndicator,
  } from "$lib/ui/indicators";
  import { bestOfNRequest, bestOfNRuns, candidateLiveness, runForCard, runSummary } from "$lib/cards/bestOfNState";
  import { pickCandidate, abandonRun } from "$lib/cards/bestOfNActions";
  import { kanbanState, cardSessionFor, unlinkCardSessionAction } from "$lib/board/kanbanState";
  import { cancelLaunch, launchGateVerdict, launchQueue, queuedForCard } from "$lib/launchQueue";
  import {
    runCard,
    resumeCard,
    relaunchCard,
    developCard,
    revealSession,
    revealDevelopingCard,
  } from "$lib/cards/cardRunActions";
  import { developingRunIn } from "$lib/cards/developingCards";
  import { cardSessionState } from "$lib/board/columnRunAction";
  import { composePlanPrompt, composeTaskPrompt, developAvailable, agentPromptBlocker } from "$lib/cards/cardRun";
  import { cardContentReviewed, resolveRequireReview } from "$lib/cards/cardReview";
  import { ensureCardReviewed } from "$lib/cards/cardReviewActions";
  import { resumeNoteFor } from "$lib/autoResume";
  import { runBaseline } from "$lib/cards/runChanges";
  import RunChangesModal from "$lib/cards/RunChangesModal.svelte";
  import { historyBlockedReason } from "$lib/cards/runHistory";
  import RunHistoryModal from "$lib/cards/RunHistoryModal.svelte";
  import { resumeTrail } from "$lib/autoResumeState";
  import { doneColumnOf, firstColumnOf, findCardPlacement, stepStateOf } from "$lib/orchestration";
  import { adoptMemory, isMemoryCard } from "$lib/cards/memoryCard";
  import {
    orchestrations,
    sendCardToRailAction,
    removeCardFromRailAction,
  } from "$lib/orchestrationState";
  import { deletionPlanFor, executeDeletion } from "$lib/cards/cardDelete";
  import { grantForAnsweredPrompt } from "$lib/confirmGate";
  import { breakOutChildren, guardCompletion, subjectFromCard } from "$lib/cards/cardCompletion";
  import { ARCHIVE_CANCELLED, executeArchive, executeUnarchive } from "$lib/files/archiveActions";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import { interruptedCardNote } from "$lib/sessions/orphan";
  import { endSessionOrphan } from "$lib/sessions/orphanActions";
  import ConfirmPrompt from "$lib/ConfirmPrompt.svelte";
  import { waitLabel } from "$lib/attentionInbox";
  import { nowStore } from "$lib/agentPauseState";
  import {
    cardSessionBar,
    loadSectionsOpen,
    railSummary,
    saveSectionsOpen,
    settingsSummary,
    type CardActionId,
    type CardSectionId,
    type CardSectionsOpen,
    type CardSituation,
  } from "$lib/cards/cardDetail";
  import * as backend from "$lib/backend";

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
    // Draw as a pane rather than as a dialog -- see Modal's own prop.
    inline?: boolean;
    // Take the human to this card on the board or on its rail. Only a
    // host that is NOT one of those surfaces passes it: the Kanban and
    // Orchestration tabs already ARE where it would go, so the action is
    // absent there rather than a no-op. This is the half of the old tab
    // chip that survives -- the chip now opens this panel in a pane, and
    // the jump to the hub tab lives here, one click further in.
    onGoToBoard?: (() => void) | null;
  }
  let {
    card,
    workspaceId,
    columns,
    labels,
    allCards,
    onClose,
    onOpenCard,
    onPathChange,
    inline = false,
    onGoToBoard = null,
  }: Props = $props();

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

  // The one escape from nesting, offered where the human is looking at
  // the children rather than only at the moment the plan is being filed
  // (cardCompletion.ts). It is a `status:` write and nothing else: the
  // child becomes a card of its own in the first column and KEEPS its
  // `parent:` link, which is what makes it different from "Un-parent"
  // right beside it.
  const breakOutTarget = $derived(firstColumnOf(columns));
  async function breakOutChild(child: CardView): Promise<void> {
    errorMessage = null;
    if (!breakOutTarget) return;
    const decision = await breakOutChildren(
      workspaceId,
      [{ path: child.id, title: child.title }],
      breakOutTarget.name
    );
    errorMessage = decision.error;
  }

  // --- field writes (surgical, patch-on-success) -----------------------
  async function writeField(
    key: "title" | "status" | "priority" | "labels" | "attachments" | "complexity" | "agent" | "model",
    value: string
  ): Promise<boolean> {
    errorMessage = null;
    try {
      const moved = await backend.setPlanFrontmatterField(card.id, key, value);
      patchPlanField(workspaceId, card.id, key, value);
      followMove(moved);
      return true;
    } catch (e) {
      errorMessage = String(e);
      return false;
    }
  }

  /// A status write can move the card's file (Done files it under
  /// `plans/done/`), and the host holds the OLD path as this modal's
  /// identity. Shared with the adopt action, which ends in exactly such
  /// a write but does not go through `writeField`.
  function followMove(moved: string): void {
    if (moved && moved !== card.id) {
      patchPlanPath(workspaceId, card.id, moved);
      onPathChange?.(moved);
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
  // Filing a plan carries its nested tasks with it, so the select owes
  // the human the same question the board's drag asks (cardCompletion.ts).
  // On any answer but "go", the select is put back: leaving it showing a
  // column the card is not in would be the modal telling a lie.
  async function commitStatus(): Promise<void> {
    if (statusChoice === (card.status ?? "")) return;
    const decision = await guardCompletion(workspaceId, subjectFromCard(card), statusChoice, columns);
    if (!decision.proceed) {
      errorMessage = decision.error;
      statusChoice = card.status ?? "";
      return;
    }
    await writeField("status", statusChoice);
  }

  let priority = $state<Priority>("none");
  $effect(() => {
    priority = card.priority ?? "none";
  });
  function commitPriority(): void {
    void writeField("priority", priority);
  }

  // --- complexity (which agent executes this card) ----------------------
  // A v30 daemon's set_plan_field allow-list has no `complexity`, so the
  // write would fail on change. Disabled with the reason instead: this
  // and the ⌘N composer are the two surfaces that can produce the
  // payload.
  const complexityBlocked = $derived(featureBlockedReason($daemonCompat, "complexity"));
  let complexity = $state<string>(NO_COMPLEXITY);
  $effect(() => {
    complexity = card.complexity ?? NO_COMPLEXITY;
  });
  function commitComplexity(): void {
    void writeField("complexity", complexity);
  }

  // --- the agent this card runs on --------------------------------------
  // `complexity:` above answers "which agent" by proxy: rate the work
  // once, let the table decide. These two lines answer it outright, for
  // the card that is not like its level -- and they win, whole, over
  // whatever the level would have picked (cardAgent.ts says why).
  //
  // A v31 daemon fails this in BOTH directions, which is why the gate
  // disables the controls rather than letting a change fail: it refuses
  // the two set_plan_field keys loudly, and it also never PARSES the two
  // lines, so a card that already carries an override reads back as
  // carrying none and runs at the workspace's default.
  const cardAgentBlocked = $derived(featureBlockedReason($daemonCompat, "cardAgent"));
  /// Read off `layoutState` rather than through `workspaceComplexityTable`,
  /// which is a one-shot `get()`: this is a component, and a table read
  /// once at mount would keep whatever the workspace said then.
  const workspaceTable = $derived(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.complexityAgents ?? {}
  );
  /// The complexity select's LIVE value, not the card's stored one, so
  /// the line below follows a level the human is still choosing.
  const agentFields = $derived({
    agent: card.agent ?? "",
    model: card.model ?? "",
    complexity,
  });
  /// What this card will actually launch, in one line under the row --
  /// the whole reason both fields exist, and the answer nobody should
  /// have to open two settings panels to find. It also names which of
  /// the two controls won, because a card can carry a level AND an
  /// override and the row would otherwise show two answers with no way
  /// to tell them apart. Null when the card says nothing at all, which
  /// is the ordinary case.
  const cardAgentLine = $derived(
    cardAgentSummary(
      agentFields,
      $agentDefaultsStore.complexity,
      workspaceTable,
      (id) => $agentProfilesStore.find((p) => p.id === id)?.label ?? id
    )
  );

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

  // What a chip reads as before the host has stat'd it, or when it
  // couldn't: unknown beats a confident lie, so it reads the same as a
  // `refused` entry -- broken, with no absolute path to open.
  function unresolvedAttachmentStatus(path: string): AttachmentStatus {
    return { path, absolutePath: null, exists: false, location: "refused", refusedReason: null };
  }

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
      attachmentStatuses = paths.map((path) => unresolvedAttachmentStatus(path));
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
          attachmentStatuses = paths.map((path) => unresolvedAttachmentStatus(path));
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
      const picked = await pickPath({
        directory: false,
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

  // A split needs a terminal session to anchor to; file, board and card
  // tabs are not sessions. Null means the app has no pane to split, and the
  // chip falls back to the OS's default application -- an honest second
  // choice, rather than a click that does nothing.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if (
        $layoutState.fileTabsById[focused] ||
        $layoutState.boardTabsById[focused] ||
        $layoutState.cardTabsById[focused]
      )
        return null;
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
      await backend.openPathExternally(path);
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
  /// Where this run started, or why nobody knows. Never "no changes":
  /// an absent baseline is a run nobody measured (runChanges.ts).
  const baseline = $derived(runBaseline(binding, $daemonCompat));
  let showingChanges = $state(false);
  /// Why the run history cannot be opened, or null when it can. An older
  /// daemon kept no history at all -- `card_sessions` was upserted, so
  /// every run but the last was overwritten -- and the panel must say
  /// that about the DAEMON rather than let it read as a card nobody ran.
  const historyBlocked = $derived(historyBlockedReason($daemonCompat));
  let showingHistory = $state(false);
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
          ? ($attentionStatusById[binding.sessionId] ?? "idle")
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
          ? agentIndicator($attentionStatusById[binding.sessionId])
          : agentExitedIndicator()
  );

  // A launch the wall is holding (launchQueue.ts). There is no session
  // yet -- that is the whole state -- so nothing above can report it,
  // and without this row the modal shows a card with a Run button and no
  // sign that Run was already pressed.
  //
  // `$launchQueue` is the dependency, not `queuedForCard`'s result: the
  // helper reads the store with `get`, which no derivation can see.
  const queued = $derived.by(() => {
    void $launchQueue;
    return queuedForCard(workspaceId, card.id);
  });
  const queuedHold = $derived($launchGateVerdict.reason ?? "ceiling");

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

  // The develop run this card is already under, if any. It replaces the
  // whole unbound block below rather than sitting beside it: an agent is
  // rewriting the file, so every launch there is refused
  // (developingCards.ts) and there is exactly one useful thing to do.
  const developing = $derived(developingRunIn($layoutState, workspaceId, card.id));

  async function handleJumpToDevelop(): Promise<void> {
    errorMessage = null;
    await revealDevelopingCard(workspaceId, card.id);
    onClose();
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
    const token = await grantForAnsweredPrompt(
      "delete_card_file",
      delPlan.files.map((f) => f.id)
    );
    const err = await executeDeletion(workspaceId, delPlan, token);
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

  // --- adopt a proposed memory (memoryCard.ts) --------------------------
  // An agent proposes a durable fact as a `memory` note; this is the one
  // action that makes it permanent. Named for the file it writes,
  // because that file is the whole point: after this, every agent the
  // workspace launches reads the fact without anyone re-teaching it.
  const isMemory = $derived(isMemoryCard(card));
  const instructionsFile = $derived($resolvedAgents(workspaceId).file);
  const done = $derived(doneColumnOf(columns));
  // Read off the store rather than through `workspaceRootPath`: that
  // one-shot `get` is right for a click handler and wrong for a control
  // whose enabled state has to follow the workspace being rooted.
  const adoptRoot = $derived(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath || null
  );
  // Both halves named rather than assumed: the instructions file hangs
  // off the root, and the last column is the human's to call whatever
  // they like -- adopting has to file the card into THAT one.
  const adoptBlocked = $derived(
    adoptRoot === null
      ? "This workspace has no root folder, so it has no instructions file to adopt into."
      : done === null
        ? "This board has no columns, so there is no done column to file the card into."
        : null
  );
  let adopting = $state(false);

  async function handleAdopt(): Promise<void> {
    errorMessage = null;
    if (adoptRoot === null || done === null) return;
    adopting = true;
    try {
      const result = await adoptMemory(card, `${adoptRoot}/${instructionsFile}`, done.name);
      if ("error" in result) {
        errorMessage = result.error;
        return;
      }
      // The card is Done now, so the board has to say so before the
      // watcher gets round to it -- and the file moved under the modal.
      patchPlanField(workspaceId, card.id, "status", done.name);
      followMove(result.movedTo);
      // Opens nothing, deliberately: adopting is a filing gesture, and
      // dropping the human into an editor would make them close it
      // again. The modal stays put so the card's new column is visible.
    } finally {
      adopting = false;
    }
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
      await backend.openPathExternally(card.id);
    } catch (e) {
      errorMessage = `Couldn't open externally: ${e}`;
    }
  }

  // --- what this card is asking of me, right now (cardDetail.ts) -------
  //
  // One situation, pinned above the scroller. The precedence is the same
  // one the panel used to spell out in nested {#if} branches, and it has
  // to stay that way: a best-of-N run replaces the binding block (there
  // is no binding until one is picked), and a develop run replaces every
  // launch (the file is being rewritten, so every launch is refused).
  const situation = $derived<CardSituation>(
    card.kind === "note"
      ? { kind: "none" }
      : bestOfNRun
        ? { kind: "best-of-n", summary: runSummary(bestOfNRun, liveIds) }
        : binding
          ? {
              kind: "bound",
              phase: bindingInterrupted
                ? "interrupted"
                : bindingFailed
                  ? "failed"
                  : bindingLive
                    ? "live"
                    : "exited",
              // The daemon's status describes whatever occupies the
              // session id NOW, so it is consulted only while the run is
              // live -- an interrupted id holds a bare shell.
              status: bindingLive
                ? ($attentionStatusById[binding.sessionId] ?? "idle")
                : null,
              orphan: bindingOrphan !== null,
            }
          : developing
            ? { kind: "developing" }
            : {
                kind: "unbound",
                cardKind: card.kind === "plan" ? "plan" : "task",
                canDevelop,
                runBlocked: runBlocked !== null,
              }
  );
  const bar = $derived(cardSessionBar(situation));

  /// The bar's glyph, from the app's one badge vocabulary. Null where
  /// there is no agent to describe: an unbound card has no state, and a
  /// best-of-N run's states are one per candidate row below.
  const barBadge = $derived(
    situation.kind === "bound"
      ? bindingBadge
      : situation.kind === "developing"
        ? agentDevelopingIndicator()
        : null
  );

  /// Which action gets the accent. The FIRST ENABLED one, not simply the
  /// first: an exited session leads with a disabled "Jump to session",
  /// and painting that as the primary would point the eye at the one
  /// button that cannot be pressed. A danger action is never the accent
  /// -- it already carries its own, louder, emphasis.
  const primaryActionId = $derived(bar?.actions.find((a) => a.enabled && !a.danger)?.id ?? null);

  /// How long the run has been waiting on a person. Shown only when it
  /// IS waiting: "working · 4m" is a fact nobody asked for, while
  /// "waiting for you · 40m" is the whole reason this bar is pinned.
  /// Rides the app-wide clock (agentPauseState) rather than a timer of
  /// its own, so an open panel costs nothing.
  const statusSince = $derived(
    binding ? ($layoutState.statusSinceById[binding.sessionId] ?? null) : null
  );
  const waited = $derived(
    bar?.wantsHuman && statusSince
      ? waitLabel(Math.max(0, $nowStore - statusSince.at), statusSince.watched)
      : null
  );

  async function runBarAction(id: CardActionId): Promise<void> {
    switch (id) {
      case "end-orphan":
        if (binding) await endSessionOrphan(binding.sessionId);
        return;
      case "resume":
        return handleResume();
      // One handler for both: `runCard` jumps to a live session rather
      // than spawning a second agent on the same card.
      case "jump":
      case "run":
        return handleRun();
      case "relaunch":
        return handleRelaunch();
      case "develop":
        return handleDevelop();
      case "best-of-n":
        startBestOfN();
        return;
      case "develop-jump":
        return handleJumpToDevelop();
    }
  }

  // --- first-Run review (cardReview.ts, AG-01) --------------------------
  // A card's body IS an agent's prompt, and `.gavin-root/plans/*.md`
  // ships with the repository -- so gavin will not hand a card to an
  // agent until a human has read it. Every launch asks at the click; this
  // is where the question can be answered WITHOUT one, which is what a
  // rail needs: a rail step stalls on an unreviewed card rather than
  // raising a modal into a window nobody may be watching, and the human
  // comes here, reads the body that is already on screen, and answers.
  //
  // Read through the pure predicate off the store rather than through
  // layoutState's one-shot helper, so the banner clears the instant the
  // stamp lands instead of at the next remount.
  const reviewWorkspace = $derived($layoutState.workspaces.find((w) => w.id === workspaceId));
  const reviewedCards = $derived(reviewWorkspace?.reviewedCards);
  // The workspace's own choice, else the app-wide one, else gavin's
  // default -- the same resolution `cardReviewed` (layoutState.ts) applies
  // at launch, read here too so the banner agrees with what a Run would
  // actually do.
  const requireReview = $derived(
    resolveRequireReview(reviewWorkspace?.requireReview, $requireReviewDefault)
  );
  const reviewContent = $derived({
    title: card.title,
    body: stripFrontmatter(content ?? "").trim(),
    attachments: [...attachments],
  });
  // Never for a note -- nothing executes one -- never before the file has
  // been read, since "not loaded yet" must not draw as "not reviewed", and
  // never when the gate itself is off for this workspace.
  const needsReview = $derived(
    card.kind !== "note" &&
      content !== null &&
      requireReview &&
      !cardContentReviewed(reviewContent, reviewedCards?.[card.id])
  );
  let reviewBusy = $state(false);

  async function handleReview(): Promise<void> {
    reviewBusy = true;
    try {
      // The same composer a launch would use, on the same resolved
      // attachments the chips above are drawn from -- a sheet showing a
      // different prompt from the one that will be sent is worse than no
      // sheet at all.
      const paths = resolvedAttachmentPaths(attachmentStatuses);
      const withheld = withheldAttachmentPaths(attachmentStatuses);
      await ensureCardReviewed({
        workspaceId,
        path: card.id,
        content: reviewContent,
        statuses: attachmentStatuses,
        prompt:
          card.kind === "task"
            ? composeTaskPrompt(card.id, card.title, reviewContent.body, paths, null, withheld)
            : composePlanPrompt(card.id, paths, null, withheld),
      });
    } finally {
      reviewBusy = false;
    }
  }

  // --- folded sections --------------------------------------------------
  // The two blocks a human comes here to CHANGE rather than to read
  // start folded, and say what they hold while folded so the fold is not
  // a second hunt.
  let sectionsOpen = $state<CardSectionsOpen>(loadSectionsOpen());
  function toggleSection(id: CardSectionId): void {
    sectionsOpen = { ...sectionsOpen, [id]: !sectionsOpen[id] };
    saveSectionsOpen(sectionsOpen);
  }

  const brokenAttachments = $derived(attachmentStatuses.filter((s) => !s.exists).length);
  const settingsLine = $derived(
    settingsSummary({
      labels: card.labels.length,
      attachments: attachments.length,
      brokenAttachments,
      autoCommit: autoCommitOn,
      autoCommitApplies,
    })
  );
  const railLine = $derived(
    railSummary({
      railCount: rails.length,
      railName: placedRail?.name ?? null,
      stageNumber: placement?.stageNumber ?? null,
      stageCount: placement?.stageCount ?? null,
      stepState: placedState,
    })
  );

  // The panel scrolls its middle, not the modal's own panel, so Modal's
  // `scrollKey` reset cannot reach it: the Tasks list and "Part of"
  // repoint this panel WITHOUT unmounting it, and the offset left behind
  // belongs to the card that just went.
  let scroller = $state<HTMLDivElement | null>(null);
  $effect(() => {
    void card.id;
    if (scroller) scroller.scrollTop = 0;
  });
</script>

<!-- The head and the foot are pinned; only the middle scrolls. That is
     the whole rework: what a card ASKS of you (its agent's state and the
     one button that reaches it) and what you can DO to the card must not
     move further away the more the human wrote in it. -->
{#snippet fold(id: CardSectionId, title: string, summary: string)}
  <button
    type="button"
    class="fold-head"
    aria-expanded={sectionsOpen[id]}
    onclick={() => toggleSection(id)}
  >
    {#if sectionsOpen[id]}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
    <span class="fold-title">{title}</span>
    <!-- A folded section still says what it holds: a fold that hides
         whether anything is in there just moves the hunt one click on. -->
    <span class="fold-summary">{summary}</span>
  </button>
{/snippet}

<Modal {onClose} scrollKey={card.id} {inline} wide innerScroll>
  <div class="card-detail" class:inline>
    <div class="head">
      <div class="ident">
        <span class="kind-badge kind-{card.kind}">{card.kind}</span>
        <!-- The absolute path used to have a line of its own under the
             title. It is a thing you copy, not a thing you read, so it
             rides the bubble here and gives the bar its row back. -->
        <span class="meta" title={card.id}>{card.contextName} · {card.fileName}</span>
        {#if onGoToBoard}
          <button type="button" class="go-to-board" onclick={() => onGoToBoard?.()}>
            <SquareArrowOutUpRight size={12} />
            Show on the board
          </button>
        {/if}
      </div>
      <input
        class="title"
        type="text"
        bind:value={titleDraft}
        onblur={commitTitle}
        onkeydown={(e) => e.key === "Enter" && commitTitle()}
      />
      <!-- Status and priority are the two fields a human changes from
           here, so they stay above the fold with the title. Everything
           else that edits the card is folded away below. -->
      <div class="fields">
        <label class="field">
          <span class="label">Status</span>
          <select bind:value={statusChoice} onchange={() => void commitStatus()}>
            {#if nested}
              <option value="">(nested in {card.parentTitle})</option>
            {:else if card.status === null}
              <option value="">(none — first column)</option>
            {:else if !statusMatchesColumn}
              <option value={card.status}>{card.status} (auto column)</option>
            {/if}
            {#each columns as col (col.id)}
              <option value={col.name} selected={slugStatus(col.name) === slugStatus(card.status ?? "")}
                >{col.name}</option
              >
            {/each}
          </select>
        </label>
        <label class="field">
          <span class="label">Priority</span>
          <select bind:value={priority} onchange={commitPriority}>
            {#each PRIORITIES as p (p)}
              <option value={p}>{p}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span class="label">Complexity</span>
          <select
            bind:value={complexity}
            disabled={Boolean(complexityBlocked)}
            title={complexityBlocked ?? ""}
            onchange={commitComplexity}
          >
            <!-- "Unrated" is not a sixth level: it is the absence of the
                 line, and it runs this workspace's own agent. Saying so
                 in the option keeps it from reading as "trivial". -->
            <option value={NO_COMPLEXITY}>unrated</option>
            {#each COMPLEXITY_LEVELS as level (level)}
              <option value={level} title={COMPLEXITY_LABELS[level].hint}
                >{COMPLEXITY_LABELS[level].label.toLowerCase()}</option
              >
            {/each}
          </select>
        </label>
        <CardAgentControls
          {workspaceId}
          profiles={$agentProfilesStore}
          card={agentFields}
          blocked={cardAgentBlocked}
          onChange={(key, value) => void writeField(key, value)}
        />
        {#if card.parent}
          <div class="field">
            <span class="label">Part of</span>
            {#if partOf}
              <button type="button" class="card-link" title={partOf.title} onclick={() => onOpenCard(partOf.id)}>
                {partOf.title}
              </button>
            {:else}
              <span class:broken={card.parentBroken}
                >{card.parentBroken ? `⚠ ${card.parent} (not found)` : card.parentTitle}</span
              >
            {/if}
          </div>
        {/if}
      </div>
      {#if complexityBlocked ?? cardAgentBlocked}
        <p class="warning">{complexityBlocked ?? cardAgentBlocked}</p>
      {:else if cardAgentLine}
        <p class="agent-line">{cardAgentLine}</p>
      {/if}
      {#if card.parseWarning}
        <p class="warning">This card's frontmatter has issues — some fields may not be readable.</p>
      {/if}
      <!-- A queued launch. Above the session bar rather than in it: the
           bar reports a SESSION, and the whole point of this state is
           that there is not one yet. The gate's sentence is written out
           rather than left to a tooltip -- there is room here, and this
           is the surface somebody opens to find out why nothing has
           started. -->
      {#if queued}
        <div class="queued-row">
          <StatusBadge
            indicator={agentQueuedIndicator(queuedHold, $launchGateVerdict.why)}
            size={12}
            text={queuedBadgeText(queuedHold)}
          />
          <span class="queued-why">{$launchGateVerdict.why ?? "waiting to start"}</span>
          <button type="button" class="queued-cancel" onclick={() => cancelLaunch(queued.id)}>
            Cancel
          </button>
        </div>
      {/if}
      <!-- The session bar. Pinned because the state it reports is the
           only thing on this panel that can be URGENT: an agent waiting
           for a human used to have its one button below a screenful of
           prompt text. -->
      {#if bar}
        <div class="session-bar tone-{bar.tone}" class:wants-human={bar.wantsHuman}>
          {#if barBadge}
            <StatusBadge indicator={barBadge} size={13} class="bar-badge" />
          {/if}
          <span class="bar-headline">{bar.headline}</span>
          <!-- An unwatched wait is a FLOOR, never a measurement: gavin can
               only time a state from the transition it saw, and a status
               already in place when the app attached was never watched
               beginning. The "≥" is the mark; this is where it is said. -->
          {#if waited}
            <span
              class="bar-waited"
              title={statusSince?.watched
                ? "How long it has been in this state"
                : "Already in this state when gavin attached, so the wait is a floor"}
            >
              {waited}
            </span>
          {/if}
          {#if bar.actions.length > 0}
            <div class="bar-actions">
              {#each bar.actions as action (action.id)}
                <button
                  type="button"
                  class="bar-action"
                  class:primary={action.id === primaryActionId}
                  class:danger={action.danger}
                  disabled={!action.enabled}
                  onclick={() => void runBarAction(action.id)}
                >
                  {action.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="scroll" bind:this={scroller}>
      <!-- What the bar could not fit: the paragraphs that explain the
           state, and the rows a best-of-N decision is actually made on.
           First in the scroller, so the explanation sits directly under
           the claim it explains. -->
      {#if card.kind !== "note"}
        {#if bestOfNRun}
          <div class="situation">
            <p class="quiet">
              {runSummary(bestOfNRun, liveIds)} — each in its own worktree. Picking one keeps its branch
              and closes the rest; merging is still yours.
            </p>
            {#each candidateRows as row (row.candidate.sessionId)}
              <div class="candidate-row">
                <StatusBadge
                  indicator={row.live
                    ? agentIndicator($attentionStatusById[row.candidate.sessionId])
                    : agentExitedIndicator()}
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
                <button type="button" class="pick" onclick={() => void handlePick(row.candidate.sessionId)}
                  >Keep this one</button
                >
              </div>
            {/each}
            <div class="session-actions">
              <button type="button" class="danger" onclick={() => void handleAbandon()}>Discard the run…</button>
            </div>
          </div>
        {:else if binding}
          {#if bindingFailed || resumeNote || bindingInterrupted || bindingOrphan}
            <div class="situation">
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
            </div>
          {/if}
        {:else if developing}
          <div class="situation">
            <p class="session-note">
              An agent is developing this card — rewriting its body, and possibly its
              kind and its nested tasks. Until it finishes, nothing else may run this
              card: a second agent would be executing a prompt that is about to be
              replaced, and writing its status into a file being rewritten.
            </p>
          </div>
        {:else if runBlocked}
          <!-- Inline rather than a tooltip: the bar's buttons are
               disabled, and a disabled button fires no mouseenter. -->
          <div class="situation">
            <p class="quiet">{runBlocked}</p>
          </div>
        {/if}
      {/if}

      {#if card.kind === "plan" && checklist.length > 0}
        <div class="section">
          <div class="section-title">Checklist · {card.checklistDone}/{card.checklistTotal}</div>
          {#each checklist as item (item.lineIndex)}
            <div class="check-item">
              <input type="checkbox" checked={item.checked} onchange={() => void toggleItem(item)} />
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
          <!-- Said once, above the list: a nested task has no status of its
               own, so nothing else on this modal can tell the human that
               finishing this plan finishes it too. -->
          {#if children.some((c) => c.status === null)}
            <p class="quiet">
              A nested task has no status of its own — it is done when this plan is, and travels
              into plans/done/ with it. Break one out to give it a column of its own; it keeps
              the link back here.
            </p>
          {/if}
          {#each children as child (child.id)}
            <div class="child-row">
              <button type="button" class="child-open" title="Open this task's card" onclick={() => onOpenCard(child.id)}>
                <span class="child-title" title={child.title}>{child.title}</span>
                <span class="child-status">{child.status ?? "(nested)"}</span>
              </button>
              <div class="child-actions">
                {#if child.status === null && breakOutTarget}
                  <button
                    type="button"
                    class="unparent"
                    title={`Give it its own card in ${breakOutTarget.name} — it stays part of this plan`}
                    onclick={() => void breakOutChild(child)}
                  >
                    Break out
                  </button>
                {/if}
                <button type="button" class="unparent" title="Detach from this plan" onclick={() => void unparentChild(child.id)}>
                  Un-parent
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- The card's own text, uncapped. It used to sit in a 200px box
           with a scrollbar of its own, above a session block nobody
           could reach: now the panel scrolls once and the text can be as
           long as it likes without pushing anything urgent out of view. -->
      {#if needsReview}
        <div class="review-banner" role="status">
          <Lock size={14} aria-hidden="true" />
          <span>
            Nobody has read this card's body yet, and a card's body is what an agent is given.
            gavin asks before the first run — and a rail holds its step until you answer.
          </span>
          <button type="button" disabled={reviewBusy} onclick={() => void handleReview()}>
            Review…
          </button>
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
        <!-- Evidence, not reach: where the run happened, what it changed,
             and every run this card has had. The buttons that REACH an
             agent are all in the bar; nothing here is time-critical, so
             it is the one place a fold costs nothing. -->
        <div class="section">
          {@render fold("session", "Session details", binding ? bindingStatus : "no session bound")}
          {#if sectionsOpen.session}
            <div class="fold-body">
              {#if binding}
                <div class="session-info">
                  <StatusBadge indicator={bindingBadge} size={12} text={bindingStatus} class="session-status" />
                  <span class="session-cwd" title={binding.cwd}>{binding.cwd}</span>
                </div>
                <!-- What this run has done to its checkout, from the commit it
                     started on. Its own row rather than another button in the
                     bar, because the interesting half is the SENTENCE when
                     there is no baseline: a Changes button that quietly diffs
                     against nothing is the one outcome this feature must not
                     have. -->
                <div class="changes-row">
                  {#if baseline.kind === "ready"}
                    <button type="button" onclick={() => (showingChanges = true)}>
                      Changes since {baseline.baseSha.slice(0, 7)}…
                    </button>
                  {:else}
                    <p class="quiet">{baseline.reason}</p>
                  {/if}
                </div>
              {:else}
                <p class="quiet">No session is bound to this card.</p>
              {/if}
              <!-- Outside the bound/unbound split on purpose. The Changes view
                   above is about the LIVE run and belongs to the binding; the
                   history is about every run the card has had, and a card whose
                   binding was unlinked -- or replaced, or never survived a
                   daemon restart -- is exactly the one whose history somebody
                   wants.
                   The reason rides the WRAPPER: a disabled control fires no
                   mouseenter, so a title on the button itself could never be
                   read. -->
              <div class="session-actions">
                <span title={historyBlocked ?? undefined}>
                  <button type="button" disabled={historyBlocked !== null} onclick={() => (showingHistory = true)}>
                    Run history…
                  </button>
                </span>
                {#if binding}
                  <button type="button" onclick={() => void handleUnlink()}>Unlink</button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Labels, the commit instruction and the attached files: three
           things a human comes here to CHANGE rather than to read, which
           is rarer than either of the two above. -->
      <div class="section">
        {@render fold("settings", "Card settings", settingsLine)}
        {#if sectionsOpen.settings}
          <div class="fold-body">
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
            <div class="sub-section" title={attachmentsBlocked ?? undefined}>
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
                  {@const refused = status !== null && status.location === "refused"}
                  {@const withheld = status !== null && !broken && status.location === "outside"}
                  <span class="attachment" class:broken class:withheld>
                    <button
                      type="button"
                      class="attachment-open"
                      disabled={status === null || broken}
                      title={refused
                        ? `${path} — refused: ${status?.refusedReason}. Remove it: gavin will never read this file.`
                        : broken
                          ? `${path} — not found. Fix or remove it: a missing attachment blocks every run of this card.`
                          : withheld
                            ? `${path} — outside the workspace. Gavin does not read this automatically; a launched agent is told the card named it, but not what it contains.`
                            : path}
                      onclick={() => status && void openAttachment(status)}
                    >
                      {broken ? "⚠ " : withheld ? "↗ " : ""}{attachmentName(path)}
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
          </div>
        {/if}
      </div>

      {#if card.kind !== "note"}
        <div class="section">
          {@render fold("rail", "Orchestration rail", railLine)}
          {#if sectionsOpen.rail}
            <div class="fold-body">
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
        </div>
      {/if}
    </div>

    <div class="foot">
      <!-- Pinned with the buttons that produce it: an error from Archive
           or Delete that scrolled away with the rest of the panel would
           be an action reporting into nowhere. -->
      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}
      <div class="actions">
        <button type="button" class="danger" onclick={() => (confirmingDelete = true)}>Delete</button>
        {#if isMemory}
          <button
            type="button"
            disabled={adoptBlocked !== null || adopting}
            title={adoptBlocked ??
              `Appends this note under “Learned” in ${instructionsFile} and files the card as done`}
            onclick={() => void handleAdopt()}
          >
            Adopt into {instructionsFile}
          </button>
        {/if}
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
    </div>
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

<!-- A second modal over this one rather than a section inside it: a
     file list and a diff need the room, and modalStack means Escape
     closes this one first and leaves the card open underneath. -->
{#if showingChanges && baseline.kind === "ready"}
  <RunChangesModal
    path={card.id}
    title={card.title}
    cwd={baseline.cwd}
    baseSha={baseline.baseSha}
    sessionIsLive={bindingLive}
    onClose={() => (showingChanges = false)}
  />
{/if}

<!-- Every run the card has had, not just the live one. Stacked over this
     modal like the Changes view, so Escape closes it and leaves the card
     open underneath. -->
{#if showingHistory}
  <RunHistoryModal
    path={card.id}
    title={card.title}
    {workspaceId}
    profileId={$resolvedAgents(workspaceId).profileId}
    onOpenSession={(sessionId) => void revealSession(sessionId)}
    onClose={() => (showingHistory = false)}
  />
{/if}

<style>
  /* Three bands: a head that never scrolls, a middle that does, a foot
     that never does. Modal's `innerScroll` makes the panel the flex
     column and hands the scrolling down here. */
  .card-detail {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }
  /* A hair wider than Modal's 480px default (which is why `wide` is
     passed and then narrowed again): this panel is a column of
     label/control rows AND a card's prose, and the prose was the half
     that suffered. Not the full `wide` cap -- an 880px measure of
     monospace body text is a wall. */
  .card-detail:not(.inline) {
    width: min(600px, 88vw);
  }
  .head {
    flex: 0 0 auto;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 2px 0 4px;
  }
  .foot {
    flex: 0 0 auto;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }

  .ident {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  /* Pushed to the far end of the header: it is the one control here that
     leaves this panel entirely, so it does not sit among the fields that
     edit the card. */
  .go-to-board {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    flex: none;
    padding: 2px 8px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.75em;
    cursor: pointer;
  }
  .go-to-board:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .kind-badge {
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: none;
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .warning {
    color: var(--warning-text);
    font-size: 0.8em;
    margin: 6px 0 0;
  }

  /* What this card will actually launch, level and override folded into
     one sentence. Quiet by design: it is an answer to a question the
     human already asked with the selects, not a warning about
     anything. */
  .agent-line {
    color: var(--text-subtle);
    font-size: 0.8em;
    margin: 6px 0 0;
  }

  /* One quiet row, not a banner: a queued launch is the feature working,
     not a fault. It reads as a note with an action on the end. */
  .queued-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .queued-why {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queued-cancel {
    flex: none;
  }

  /* Status, priority and the way back to the parent, on one wrapping
     row. They used to be three full-width rows with a 70px label gutter
     each -- ninety vertical pixels spent on two selects. */
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    margin-top: 8px;
    font-size: 0.85em;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .field .label {
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  .field select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: monospace;
    padding: 3px 6px;
    border-radius: 4px;
  }
  /* A picker a daemon version has taken away is `disabled`, and the rule
     above sets colour AND background explicitly -- which beats the UA's
     own greying, so the dead control rendered pixel-identical to the
     live ones beside it. The warning line below the group says why; this
     is what points at which control it is about. */
  .field select:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The session bar: the whole point of the rework. It sits in the
     pinned head, so the distance to "Jump to session" is the same on a
     one-line note-to-self and on a card carrying a page of prompt. */
  .session-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-top: 10px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-base);
    font-size: 0.85em;
  }
  /* Tone is the same five-colour vocabulary the badges speak
     (ui/indicators.ts): accent means motion, warning wants a human,
     danger is broken. Only the two that want something tint their
     ground -- a working agent is not an alert. */
  .session-bar.tone-warning {
    background: var(--surface-warning);
    border-color: var(--border-warning);
  }
  .session-bar.tone-danger {
    background: var(--surface-danger);
    border-color: var(--border-danger);
  }
  .session-bar.tone-accent {
    border-color: var(--border-accent);
  }
  .bar-headline {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-bar.wants-human .bar-headline {
    font-weight: bold;
  }
  .bar-waited {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  /* The actions travel together against the right edge, and wrap as a
     block rather than one button at a time. */
  .bar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-left: auto;
  }
  .bar-action {
    background: var(--surface-overlay);
    border: 1px solid transparent;
    color: var(--text);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.95em;
  }
  /* The first action is what this situation is FOR, so it is the one
     that reads as a button rather than as a choice among equals. */
  .bar-action.primary {
    background: var(--surface-accent);
    border-color: var(--border-accent);
    color: var(--accent-text);
  }
  .bar-action.danger {
    background: var(--surface-danger);
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .bar-action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .session-bar :global(.bar-badge) {
    flex: none;
  }

  /* The paragraphs that explain the bar, and the rows a best-of-N
     decision is made on: first in the scroller, directly under the
     claim they explain. */
  .situation {
    margin: 10px 0 4px;
  }

  /* A folded section: a chevron, what it is, and what it holds. */
  .fold-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: 0.8em;
    margin: 0 -4px;
    padding: 3px 4px;
    text-align: left;
  }
  .fold-head:hover {
    background: var(--surface-base);
    color: var(--text);
  }
  .fold-title {
    flex: none;
  }
  .fold-summary {
    color: var(--text-subtle);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fold-body {
    margin-top: 6px;
  }
  .sub-section {
    margin-top: 10px;
  }

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
  .attachment.withheld {
    border-style: dashed;
  }
  .attachment.withheld .attachment-open {
    color: var(--text-subtle);
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
  /* The same shape as ConfigTrustNotice's banner one level up: gavin is
     holding something the repository wrote until a person looks. */
  .review-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    margin-bottom: 12px;
    border: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--warning-text);
    border-radius: 6px;
    font-size: 0.85em;
  }
  .review-banner span {
    flex: 1;
    min-width: 0;
  }
  .review-banner button {
    flex: none;
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .review-banner button:disabled {
    opacity: 0.45;
    cursor: default;
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
  }
  /* The row's actions travel together against the right edge: with the
     margin on each button, a second one would push the first away from
     it rather than sit beside it. */
  .child-actions {
    display: flex;
    align-items: center;
    gap: 6px;
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
  /* No max-height on either: the panel scrolls once now, so a long
     prompt costs a flick of the wheel instead of a scrollbar inside a
     scrollbar. */
  .prompt {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    font-size: 0.8em;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .body-preview {
    -webkit-user-select: text;
    user-select: text;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 0.85em;
  }
  .error {
    color: var(--danger-text);
    font-size: 0.8em;
  }
  .foot .error {
    margin: 0 0 8px;
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
    font-size: 0.85em;
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
    align-items: center;
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
  .changes-row {
    margin-bottom: 8px;
  }
  .changes-row .quiet {
    margin: 0;
  }
  .changes-row button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.8em;
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
    flex-wrap: wrap;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.85em;
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
