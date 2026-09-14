// Critical review launch: the side-effecting half of criticalReview.ts.
//
// Same shape as codeReviewActions (pending request in a module store,
// one dialog at the app root) plus Best-of-N's N-candidate tiled page —
// but every session shares one cwd, and there is no worktree, branch, or
// pick-winner step. Findings are cards, via composeCriticalReviewPrompt.

import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import {
  agentProfilesStore,
  candidateAgentFor,
  armFailureDetection,
  createTiledPage,
  conversationIdForLaunch,
  resolvedAgentFor,
  setSessionName,
  switchWorkspaceView,
  workspaceRootPath,
} from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { kanbanState, cardSessionFor } from "$lib/board/kanbanState";
import { buildRunCommand, provisionalSessionName } from "$lib/cards/cardRun";
import { mustPromptBody } from "$lib/agents/actionPromptsState";
import { candidateLabel, type Candidate } from "$lib/cards/bestOfN";
import {
  composeCriticalReviewPrompt,
  criticalReviewPageName,
  cardSubjectLabel,
  railSubjectLabel,
  reviewersError,
  seedCriticalReviewBase,
  type CriticalReviewSubjectKind,
} from "$lib/review/criticalReview";
import {
  defaultReviewBase,
  plansFolderPath,
  reviewBlocker,
  reviewRulesPath,
  REVIEW_RULES_STARTER,
  type ReviewedCard,
} from "$lib/review/codeReview";
import type { CardView } from "$lib/core/planBoard";
import type { Rail } from "$lib/orchestration/orchestration";
import { putRun } from "$lib/review/criticalReviewState";

/// A critical review waiting on the dialog. Everything the launch needs
/// except the human's base, reviewer rows, and findings-rail toggle.
export interface CriticalReviewRequest {
  workspaceId: string;
  cwd: string;
  base: string;
  rulesPath: string;
  rulesExist: boolean;
  contextFolder: string;
  plansFolder: string;
  subjectKind: CriticalReviewSubjectKind;
  subject: string;
  card: ReviewedCard | null;
  /// Rail id when the subject is a rail — kept so a later findings-rail
  /// build can name where the review came from. Null for a card.
  railId: string | null;
  railName: string | null;
}

const pending = writable<CriticalReviewRequest | null>(null);

export const criticalReviewRequest: Readable<CriticalReviewRequest | null> = {
  subscribe: pending.subscribe,
};

export function cancelCriticalReview(): void {
  pending.set(null);
}

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
  const rootPath = workspaceRootPath(workspaceId);
  return rootPath ? { folder: rootPath, kind: "root" } : null;
}

function rulesPathFor(workspaceId: string): string | null {
  const root = contextFor(workspaceId, null);
  return root ? reviewRulesPath(root.folder) : null;
}

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
    subjectKind: CriticalReviewSubjectKind;
    subject: string;
    card: ReviewedCard | null;
    railId: string | null;
    railName: string | null;
    /// Optional override for the dialog seed (rail fork point / step sha).
    baseSeed?: string | null;
  }
): Promise<string | null> {
  const context = contextFor(workspaceId, input.contextFolder);
  // Gate on the workspace agent the way the single review does: if THAT
  // agent cannot take a prompt, the feature is unusable here regardless
  // of which rows the dialog later picks. Per-row prompt gates run at
  // launch.
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
    rulesExist = true;
  }

  const defaultBase = await seedBase(input.cwd);
  const base = input.baseSeed?.trim() || defaultBase;

  pending.set({
    workspaceId,
    cwd: input.cwd,
    base,
    rulesPath,
    rulesExist,
    contextFolder: context.folder,
    plansFolder: plansFolderPath(context.folder, context.kind),
    subjectKind: input.subjectKind,
    subject: input.subject,
    card: input.card,
    railId: input.railId,
    railName: input.railName,
  });
  return null;
}

/// Card menu / Review tab: critique the work that card produced.
export function requestCardCriticalReview(
  workspaceId: string,
  card: CardView
): Promise<string | null> {
  if (card.kind === "note") return Promise.resolve("Notes have no work to review");
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  return open(workspaceId, {
    cwd: binding?.launchCwd ?? card.contextFolder,
    contextFolder: card.contextFolder,
    subjectKind: "card",
    subject: cardSubjectLabel(card.title),
    card: { path: card.id, fileName: card.fileName, title: card.title, kind: card.kind },
    railId: null,
    railName: null,
  });
}

/// Rail menu / Review tab (rails-as-subjects): critique the whole rail's
/// checkout as one subject.
export function requestRailCriticalReview(
  workspaceId: string,
  rail: Pick<Rail, "id" | "name" | "worktreePath">,
  options: {
    /// Worktree fork point when known; otherwise leave null and the
    /// earliest step baseSha / trunk default apply.
    worktreeForkPoint?: string | null;
    stepBaseShas?: readonly (string | null | undefined)[];
    /// Root fallback when the rail has no worktree binding.
    rootPath?: string | null;
  } = {}
): Promise<string | null> {
  const cwd =
    rail.worktreePath ??
    options.rootPath ??
    workspaceRootPath(workspaceId);
  if (!cwd) {
    return Promise.resolve(
      "This rail has no checkout to review — bind a worktree, or open a workspace with a root"
    );
  }
  return (async () => {
    const defaultBase = await seedBase(cwd);
    const baseSeed = seedCriticalReviewBase({
      worktreeForkPoint: options.worktreeForkPoint ?? null,
      stepBaseShas: options.stepBaseShas ?? [],
      defaultBase,
    });
    return open(workspaceId, {
      cwd,
      contextFolder: null,
      subjectKind: "rail",
      subject: railSubjectLabel(rail.name),
      card: null,
      railId: rail.id,
      railName: rail.name,
      baseSeed,
    });
  })();
}

export async function createCriticalReviewRules(): Promise<string | null> {
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

export interface CriticalReviewLaunchOptions {
  base: string;
  reviewers: readonly Candidate[];
  /// Per-run toggle; default off. Stored for the findings-rail card;
  /// the prompt mentions it when on.
  alsoBuildFindingsRail?: boolean;
}

/// Everything needed to start N reviewers once the subject and checkout
/// are known — dialog confirm and the rail step both call this.
export interface CriticalReviewLaunchInput {
  workspaceId: string;
  cwd: string;
  base: string;
  rulesPath: string;
  contextFolder: string;
  plansFolder: string;
  subjectKind: CriticalReviewSubjectKind;
  subjectLabel: string;
  card: ReviewedCard | null;
  railId: string | null;
  railName: string | null;
  reviewers: readonly Candidate[];
  alsoBuildFindingsRail: boolean;
  /// Rail step that owns this run, or null for a dialog launch.
  stepId?: string | null;
  /// Switch the hub to the terminal view after launch (dialog does;
  /// an unattended rail step does not yank the human off Orchestration).
  switchToTerminal?: boolean;
}

/// Launch N parallel review sessions. Returns an error string, or null.
export async function launchCriticalReviewSessions(
  input: CriticalReviewLaunchInput
): Promise<string | null> {
  const trimmed = input.base.trim();
  if (!trimmed) return "Name a branch, tag or commit to compare against";

  const setError = reviewersError(input.reviewers);
  if (setError) return setError;

  const profiles = get(agentProfilesStore);
  const labels = new Map(profiles.map((p) => [p.id, p.label]));
  const agents = input.reviewers.map((c) => candidateAgentFor(input.workspaceId, c));
  const blocked = agents.findIndex((a) => a.promptArgs === null);
  if (blocked !== -1) {
    const label =
      labels.get(input.reviewers[blocked].profileId) ?? input.reviewers[blocked].profileId;
    return reviewBlocker({
      promptArgs: null,
      agentLabel: label,
      contextFolder: input.contextFolder,
    });
  }

  const alsoBuild = input.alsoBuildFindingsRail === true;
  const launches = input.reviewers.map((candidate, i) => {
    const agent = agents[i];
    const label = candidateLabel(
      labels.get(candidate.profileId) ?? candidate.profileId,
      candidate.model
    );
    const prompt = composeCriticalReviewPrompt({
      base: trimmed,
      rulesPath: input.rulesPath,
      contextFolder: input.contextFolder,
      plansFolder: input.plansFolder,
      card: input.card,
      reviewerLabel: label,
      reviewerTotal: input.reviewers.length,
      alsoBuildFindingsRail: alsoBuild,
      template: mustPromptBody("action:code-review", input.workspaceId),
      nameTabBase: mustPromptBody("action:name-tab-first", input.workspaceId),
      suffixTemplate: mustPromptBody("action:critical-review-suffix", input.workspaceId),
    });
    const conversationId = conversationIdForLaunch(agent);
    const command = buildRunCommand(
      agent.launchCommand,
      agent.promptArgs,
      prompt,
      agent.sessionIdArgs,
      conversationId
    );
    return { candidate, agent, label, conversationId, command };
  });

  const nullCommand = launches.find((l) => l.command === null);
  if (nullCommand) {
    return reviewBlocker({
      promptArgs: nullCommand.agent.promptArgs,
      agentLabel: nullCommand.label,
      contextFolder: input.contextFolder,
    });
  }

  const pageTitle = input.card?.title ?? input.railName ?? input.subjectLabel;
  const page = await createTiledPage(
    input.workspaceId,
    criticalReviewPageName(pageTitle),
    launches.map((l) => ({ cwd: input.cwd, command: l.command as string }))
  );
  if (!page) return "Couldn't start the reviewers' sessions";

  for (const [i, launch] of launches.entries()) {
    const sessionId = page.sessionIds[i];
    void armFailureDetection(sessionId, launch.agent.failurePatterns);
    const name = provisionalSessionName(launch.label);
    if (name) await setSessionName(sessionId, name);
  }

  putRun(input.workspaceId, {
    pageId: page.pageId,
    startedAt: Date.now(),
    subjectKind: input.subjectKind,
    subjectLabel: input.card?.title ?? input.railName ?? input.subjectLabel,
    cardPath: input.card?.path ?? null,
    railId: input.railId,
    alsoBuildFindingsRail: alsoBuild,
    sessionIds: page.sessionIds,
    stepId: input.stepId ?? null,
  });

  if (input.switchToTerminal) {
    await switchWorkspaceView(input.workspaceId, "terminal");
  }
  return null;
}

/// Launch N parallel review sessions on the pending request's cwd.
/// Returns an error string (dialog stays up), or null (dialog closes).
export async function confirmCriticalReview(
  options: CriticalReviewLaunchOptions
): Promise<string | null> {
  const request = get(pending);
  if (!request) return null;

  const err = await launchCriticalReviewSessions({
    workspaceId: request.workspaceId,
    cwd: request.cwd,
    base: options.base,
    rulesPath: request.rulesPath,
    contextFolder: request.contextFolder,
    plansFolder: request.plansFolder,
    subjectKind: request.subjectKind,
    subjectLabel: request.subject,
    card: request.card,
    railId: request.railId,
    railName: request.railName,
    reviewers: options.reviewers,
    alsoBuildFindingsRail: options.alsoBuildFindingsRail === true,
    stepId: null,
    switchToTerminal: true,
  });
  if (err) return err;
  pending.set(null);
  return null;
}
