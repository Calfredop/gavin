// "Review with agent": one visible review session, launched the same way
// from the Git tab and from a card's menu, whose output is CARDS on the
// board rather than a paragraph in a terminal.
//
// Visible, not hidden like "Commit via agent". The two runs differ in
// what a human might want to do halfway through: a commit run has one
// right answer and nothing to say to anybody, while a review is a
// conversation the human may want to steer ("ignore the generated
// files") and a long one they may want to watch. A hidden review would
// also have nowhere to report a gavin tool that refused.
//
// The request/confirm split exists because both surfaces need the same
// question asked -- what to compare against -- and neither is a good
// place to own a modal: the card menu is built by a pure module that
// three different boards mount. So this holds the pending request in a
// module-level store, ReviewDialog.svelte draws it once at the app root,
// and the same family (dialog.ts, contextMenu.ts, tooltip.ts) already
// does exactly this.

import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/backend";
import {
  resolvedAgentFor,
  armFailureDetection,
  handleAgentSessionSpawned,
  setSessionName,
  workspaceRootPath,
} from "$lib/layoutState";
import { gavinTrees } from "$lib/gavinState";
import { kanbanState, cardSessionFor } from "$lib/board/kanbanState";
import { revealSession } from "$lib/cardRunActions";
import { buildRunCommand, provisionalSessionName } from "$lib/cardRun";
import {
  composeReviewPrompt,
  defaultReviewBase,
  plansFolderPath,
  reviewBlocker,
  reviewRulesPath,
  REVIEW_RULES_STARTER,
  type ReviewedCard,
} from "$lib/review/codeReview";
import type { CardView } from "$lib/planBoard";
import { holdOrQueue, type ReviewIntent } from "$lib/launchQueue";

/// A review the human has been asked to confirm the base for. Everything
/// the prompt needs except the base itself, resolved when the dialog
/// OPENS: the context to file findings into cannot change while a modal
/// is up, and resolving it here is what lets the dialog say where the
/// cards will land.
export interface ReviewRequest {
  workspaceId: string;
  /// Where the review agent runs -- the checkout under review.
  cwd: string;
  /// The seed for the dialog's field, not the final answer.
  base: string;
  rulesPath: string;
  /// Whether the rules file was there when the dialog opened. Only ever
  /// used to offer creating it; the prompt names the path either way.
  rulesExist: boolean;
  contextFolder: string;
  plansFolder: string;
  card: ReviewedCard | null;
  /// What the dialog says this review is about to look at.
  subject: string;
}

const pending = writable<ReviewRequest | null>(null);

/// The review awaiting a base, or null. Read-only: the answer goes
/// through confirmReview so one dialog cannot launch twice.
export const reviewRequest: Readable<ReviewRequest | null> = { subscribe: pending.subscribe };

export function cancelReview(): void {
  pending.set(null);
}

/// The gavin context a review's findings are filed into: the card's own
/// when a card started it, the workspace's root context otherwise.
///
/// Null when this workspace has no gavin context at all, which is the
/// one case a review genuinely cannot run in -- the findings would have
/// nowhere to go, and a review whose output vanishes is worse than no
/// review, because it costs a session to find that out.
function contextFor(
  workspaceId: string,
  contextFolder: string | null
): { folder: string; kind: "root" | "context" } | null {
  const contexts = get(gavinTrees)[workspaceId]?.contexts ?? [];
  if (contextFolder) {
    const own = contexts.find((c) => c.folderPath === contextFolder);
    if (own) return { folder: own.folderPath, kind: own.kind };
  }
  const root = contexts.find((c) => c.kind === "root");
  if (root) return { folder: root.folderPath, kind: root.kind };
  // A rooted workspace whose tree has not arrived yet still has a root
  // folder, and it is where `.gavin-root` would be. Better than refusing
  // a review because a scan is in flight.
  const rootPath = workspaceRootPath(workspaceId);
  return rootPath ? { folder: rootPath, kind: "root" } : null;
}

/// The rules file is workspace-wide even for a card in a nested context
/// (see codeReview.ts), so it always resolves against the ROOT.
function rulesPathFor(workspaceId: string): string | null {
  const root = contextFor(workspaceId, null);
  return root ? reviewRulesPath(root.folder) : null;
}

/// The base to seed the dialog with, read from the checkout itself. A
/// repository that cannot answer (not a repo, git missing) falls back to
/// the conventional trunk rather than refusing: the field is free text,
/// and a wrong seed costs one edit where a refusal costs the feature.
async function seedBase(cwd: string): Promise<string> {
  try {
    const refs = await backend.gitRefs(cwd);
    return defaultReviewBase(refs.branches);
  } catch {
    return defaultReviewBase([]);
  }
}

async function open(
  workspaceId: string,
  input: {
    cwd: string;
    contextFolder: string | null;
    card: ReviewedCard | null;
    subject: string;
  }
): Promise<string | null> {
  const context = contextFor(workspaceId, input.contextFolder);
  const agent = resolvedAgentFor(workspaceId);
  const blocked = reviewBlocker({
    promptArgs: agent.promptArgs,
    agentLabel: agent.label,
    contextFolder: context?.folder ?? null,
  });
  if (blocked || !context) return blocked;

  const rulesPath = rulesPathFor(workspaceId) ?? reviewRulesPath(context.folder);
  let rulesExist = false;
  try {
    rulesExist = (await backend.readFileForViewer(rulesPath)).exists;
  } catch {
    // Unreadable is not absent: offering to CREATE a file that is there
    // but unreadable would overwrite it. Treated as present, so the
    // dialog offers nothing and the agent goes and looks for itself.
    rulesExist = true;
  }
  pending.set({
    workspaceId,
    cwd: input.cwd,
    base: await seedBase(input.cwd),
    rulesPath,
    rulesExist,
    contextFolder: context.folder,
    plansFolder: plansFolderPath(context.folder, context.kind),
    card: input.card,
    subject: input.subject,
  });
  return null;
}

/// The Git tab's button: review the checkout the tab is pointed at.
/// `cwd` comes from the view rather than the workspace root, because the
/// tab may be showing a linked worktree and that is the branch the human
/// is looking at.
export function requestBranchReview(workspaceId: string, cwd: string): Promise<string | null> {
  return open(workspaceId, {
    cwd,
    contextFolder: null,
    card: null,
    subject: "the changes on this branch",
  });
}

/// A card's menu entry: review the work that card produced.
///
/// The checkout is the one its agent RAN in (`launchCwd`), not the
/// card's context folder: a card worked in a worktree left its changes
/// there, and reviewing the context folder would review somebody else's
/// branch. `cwd` on the binding is not used -- it follows the session's
/// OSC 7 reports and drifts wherever the agent last cd'd.
export function requestCardReview(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return Promise.resolve("Notes have no work to review");
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  return open(workspaceId, {
    cwd: binding?.launchCwd ?? card.contextFolder,
    contextFolder: card.contextFolder,
    card: { path: card.id, fileName: card.fileName, title: card.title, kind: card.kind },
    subject: `the work done for “${card.title}”`,
  });
}

/// Writes the starter rules file and marks the pending request as having
/// one. Returns an error string, or null.
///
/// Offered only when the file is absent, so this never overwrites: the
/// starter is a scaffold with no rules in it, and dropping it over
/// somebody's real rules would be the worst thing this feature could do.
export async function createReviewRules(): Promise<string | null> {
  const request = get(pending);
  if (!request || request.rulesExist) return null;
  try {
    await backend.writeFileForEditor(request.rulesPath, REVIEW_RULES_STARTER);
  } catch (e) {
    return `Couldn't create the rules file: ${e instanceof Error ? e.message : e}`;
  }
  pending.update((r) => (r ? { ...r, rulesExist: true } : r));
  return null;
}

/// Launches the review the dialog was asking about, against `base`.
/// Returns an error string (the dialog stays up and shows it), or null
/// (the dialog is closed and the human is looking at the session).
export async function confirmReview(base: string): Promise<string | null> {
  const request = get(pending);
  if (!request) return null;
  const trimmed = base.trim();
  if (!trimmed) return "Name a branch, tag or commit to compare against";

  // The launch wall. Queued rather than refused, and the dialog closes
  // either way: the human has answered the only question it was asking,
  // and holding a modal open until memory frees would be a modal nobody
  // can dismiss without losing the answer.
  if (
    holdOrQueue({
      kind: "review",
      workspaceId: request.workspaceId,
      label: request.card ? `review: ${request.card.title}` : "review",
      cwd: request.cwd,
      base: trimmed,
      rulesPath: request.rulesPath,
      contextFolder: request.contextFolder,
      plansFolder: request.plansFolder,
      card: request.card,
    })
  ) {
    pending.set(null);
    return null;
  }
  return launchReview({ ...request, base: trimmed });
}

/// The launch itself, shared by the dialog and by the queue's drain.
/// Takes everything it needs rather than reading the pending store, so
/// an intent that waited out a hold can run with no dialog on screen.
async function launchReview(request: {
  workspaceId: string;
  cwd: string;
  base: string;
  rulesPath: string;
  contextFolder: string;
  plansFolder: string;
  card: ReviewedCard | null;
}): Promise<string | null> {
  const trimmed = request.base;
  const agent = resolvedAgentFor(request.workspaceId);
  const prompt = composeReviewPrompt({
    base: trimmed,
    rulesPath: request.rulesPath,
    contextFolder: request.contextFolder,
    plansFolder: request.plansFolder,
    card: request.card,
  });
  // No conversation id, for the same reason a develop run has none: a
  // review binds to nothing, so there is no record for one to outlive
  // and nothing that could ever resume it.
  const command = buildRunCommand(agent.launchCommand, agent.promptArgs, prompt);
  if (command === null) {
    return reviewBlocker({
      promptArgs: agent.promptArgs,
      agentLabel: agent.label,
      contextFolder: request.contextFolder,
    });
  }

  let sessionId: string;
  try {
    sessionId = await backend.createSession(request.cwd, command);
  } catch (e) {
    return `Couldn't start the review: ${e instanceof Error ? e.message : e}`;
  }
  pending.set(null);
  void armFailureDetection(sessionId, agent.failurePatterns);
  handleAgentSessionSpawned(request.workspaceId, sessionId);
  // A review writes NO status and binds to NO card -- deliberately, and
  // for the reasons develop does: the card is not being worked, and a
  // binding would turn its menu entry into "Re-launch agent" and drop it
  // out of the To Do column's "Start all". The findings are the record.
  //
  // Revealed for the same reason too: nothing on the board would
  // otherwise show that a review is running, and the agent's first
  // question would be asked in a tab nobody is looking at.
  await revealSession(sessionId);
  const name = provisionalSessionName(
    request.card ? `review: ${request.card.title}` : "review"
  );
  if (name) await setSessionName(sessionId, name);
  return null;
}

/// The queue's way back in: run a review intent that has already cleared
/// the gate. Nothing is re-resolved -- unlike a card or a tool, a review
/// is a question about a checkout at a base the human typed, and both of
/// those are exactly as true after the wait as before it.
export async function launchQueuedReview(intent: ReviewIntent): Promise<void> {
  await launchReview(intent);
}
