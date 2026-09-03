// Running one card on N agents at once: what a candidate IS, what git
// objects it needs, and what the human is told before any of it happens.
//
// The thesis is the visible one. Cursor's /best-of-n keeps its attempts
// inside a chat transcript; gavin's are N real terminals tiled on one
// page, each in its own worktree, each running the card's ordinary run
// prompt. So nothing here invents a second way to run a card -- the
// prompt, the launch command and the setup line are the ones the board's
// Run and the fork dialog already build. What this module owns is the
// part that is new: turning "three agents" into three branches, three
// folders and three labels, and saying what picking one destroys.
//
// Pure, and deliberately ignorant of the profile table, the layout and
// git. Everything it needs arrives as an argument so the naming and the
// copy can be tested without any of them.

import type { ConfirmCheck, ConfirmOptions } from "./dialog";
import type { AgentConfig } from "./gavin";
import { branchNameFrom, defaultWorktreePath, freeBranchNameFrom, splitPath } from "./git";
import { count } from "./railConfirm";

/// One entry in a run: the workspace's agent with a profile and/or a
/// model of its own. Both are plain strings rather than optionals --
/// every candidate names the profile it runs, because a row reading
/// "the workspace's agent" would be a fourth thing to resolve and would
/// stop meaning anything the moment the workspace's own profile changed
/// mid-run. An empty `model` is the real inherit: the profile's
/// app-wide default applies, exactly as it does for a workspace.
export interface Candidate {
  profileId: string;
  model: string;
}

/// A candidate with the git objects it will be given. Built before
/// anything is created, because this list IS the dialog: the human
/// agrees to these branch names and these folders, or changes them.
export interface CandidatePlan {
  candidate: Candidate;
  /// How this candidate is named everywhere -- the tab, the pick menu,
  /// the confirmation. Profile plus model, since either alone is
  /// ambiguous in a run that varies the other.
  label: string;
  branch: string;
  worktreePath: string;
}

/// A candidate that has been launched. The durable half (bestOfNState),
/// so it carries the session it owns and repeats the plan's fields
/// rather than pointing at one: a plan is rebuilt from live git and
/// live profiles, and a record has to survive both changing under it.
export interface RunCandidate {
  sessionId: string;
  label: string;
  profileId: string;
  model: string;
  branch: string;
  worktreePath: string;
  /// The line this candidate was launched with, and the conversation id
  /// gavin fixed for it. Carried so that PICKING one produces the same
  /// card binding a board Run would have: without them the winner would
  /// be a session the card points at but can never re-launch or resume,
  /// which is the one state the binding was built to avoid.
  command: string;
  conversationId: string | null;
}

/// One best-of-N run, from launch until a winner is picked or the run is
/// abandoned. `pageId` is the tiled page the candidates live on, kept so
/// the run can be found again from the page and so abandoning it knows
/// what to leave behind.
export interface BestOfNRun {
  cardPath: string;
  cardTitle: string;
  pageId: string;
  startedAt: number;
  candidates: RunCandidate[];
}

/// The candidate's own name for the launch, tab and menus. The model
/// alone would collide across profiles ("sonnet" under two CLIs), and
/// the profile alone collides in the commonest run of all -- one agent,
/// two models -- so both are shown whenever both are known.
export function candidateLabel(profileLabel: string, model: string): string {
  const chosen = model.trim();
  return chosen ? `${profileLabel} · ${chosen}` : profileLabel;
}

/// The branch suffix that tells this candidate from its siblings.
/// Profile and model both, for the same reason the label shows both --
/// and through `branchNameFrom`, so a model alias with a dot or a slash
/// in it (`gpt-5.1`, `anthropic/claude`) cannot produce a ref git
/// refuses.
export function candidateSlug(candidate: Candidate): string {
  return branchNameFrom([candidate.profileId, candidate.model].filter((s) => s.trim()).join("-"));
}

/// The agent config a candidate resolves through: the workspace's own,
/// with the candidate's profile and model laid over it.
///
/// The overlay is all-or-nothing on purpose. `command`, `file` and
/// `mcpFile` describe the binary the WORKSPACE chose -- a pinned wrapper
/// script, an absolute path, a hand-written MCP location -- and carrying
/// them onto a different profile is garbage in that profile's argv and a
/// config file written to the wrong place. So a candidate on the
/// workspace's own profile inherits everything (it really is the same
/// agent, only the model differs), and a candidate on any other profile
/// inherits nothing but the model it was given.
///
/// Returns an `AgentConfig` rather than a resolved agent so it can go
/// straight through `resolveAgentConfig`: the candidate then resolves by
/// the same rules, and the same fallbacks, as every other agent in the
/// app.
export function candidateAgentConfig(
  base: AgentConfig | null | undefined,
  candidate: Candidate
): AgentConfig {
  const model = candidate.model.trim() || null;
  const sameProfile = (base?.profile ?? "").trim() === candidate.profileId.trim();
  if (!sameProfile) {
    return { profile: candidate.profileId, file: null, command: null, mcpFile: null, model };
  }
  return {
    ...base,
    file: base?.file ?? null,
    command: base?.command ?? null,
    profile: candidate.profileId,
    model,
  };
}

/// The branches and folders a run would create, in the order the
/// candidates were given.
///
/// `taken` is every branch name the repo already has. Names are deduped
/// against it AND against each other as they are produced, so two
/// candidates that slug identically (the same profile twice, no models)
/// come out as `card-claude-code` and `card-claude-code-2` rather than
/// one name git would refuse the second time.
///
/// Flat names, not `card/candidate`: a hierarchical ref would group the
/// run nicely in the branch list, but git refuses `a/b` while a branch
/// `a` exists and vice versa, and a run that dies on its second `git
/// worktree add` for a reason the dialog never showed is worse than a
/// long name.
export function planCandidates(
  cardTitle: string,
  candidates: readonly Candidate[],
  labels: ReadonlyMap<string, string>,
  root: string,
  taken: Iterable<string>
): CandidatePlan[] {
  const cardSlug = branchNameFrom(cardTitle) || "run";
  const used = new Set(taken);
  return candidates.map((candidate) => {
    const slug = candidateSlug(candidate);
    const branch = freeBranchNameFrom(slug ? `${cardSlug}-${slug}` : cardSlug, used);
    used.add(branch);
    return {
      candidate,
      label: candidateLabel(labels.get(candidate.profileId) ?? candidate.profileId, candidate.model),
      branch,
      worktreePath: defaultWorktreePath(root, branch),
    };
  });
}

/// The commit every candidate forks from: the MAIN checkout's branch,
/// or its HEAD when that checkout is detached.
///
/// Stated rather than left to git, because `git worktree add` with no
/// start point forks from the HEAD of the repository the command runs
/// in -- and the command runs in whatever the Git tab is pointed at.
/// A human reading one fork's diff and then starting a best-of-N from
/// the board would silently get three candidates branched off that
/// fork's WIP. Comparing agents means starting them from the same
/// place, and the only defensible same place is the trunk the workspace
/// is checked out on.
///
/// A null ref falls back to git's own default, which is right for the
/// one case that produces it: a repository with no main worktree in the
/// list at all, where there is nothing better to name.
export function forkBase(
  worktrees: readonly { isMain: boolean; branch: string | null; head: string }[]
): { ref: string | null; label: string } {
  const main = worktrees.find((w) => w.isMain);
  if (!main) return { ref: null, label: "the current HEAD" };
  if (main.branch) return { ref: main.branch, label: main.branch };
  return { ref: main.head, label: `${main.head.slice(0, 7)} (detached)` };
}

/// The two rows the dialog opens with, so the commonest run is one
/// click away and nobody has to invent a comparison to get started.
///
/// The preferred pair is one profile at two models -- same agent, same
/// harness, one variable -- which is the comparison this feature is for.
/// Only when the workspace's agent has no second model worth pinning
/// does it reach for a second PROFILE, and then only one that takes a
/// prompt: a row the launch would refuse is not a default.
///
/// When neither exists the two rows are identical, which
/// `candidatesError` refuses. That is deliberate: two visibly identical
/// rows and a sentence saying so is a better opening than one row that
/// hides the fact a run needs two.
export function seedCandidates(
  profiles: readonly { id: string; models: string[]; promptArgs: string | null }[],
  workspaceProfileId: string,
  workspaceModel: string
): Candidate[] {
  const own = profiles.find((p) => p.id === workspaceProfileId);
  const models = own?.models ?? [];
  // The workspace's own model leads when it has one; otherwise the
  // profile's first preset, so the pair differs by something named
  // rather than by "inherited" versus "the thing inherit resolves to".
  const primary = workspaceModel.trim() || models[0] || "";
  const second = primary ? models.find((m) => m !== primary) : undefined;
  const first: Candidate = { profileId: workspaceProfileId, model: primary };
  if (second) return [first, { profileId: workspaceProfileId, model: second }];
  const other = profiles.find((p) => p.id !== workspaceProfileId && p.promptArgs !== null);
  if (other) return [first, { profileId: other.id, model: other.models[0] ?? "" }];
  return [first, { ...first }];
}

/// Why this set of candidates cannot be launched, or null. About the
/// SET, never about one agent: a candidate whose CLI takes no prompt is
/// refused by `noPromptReason` at the launch, in the sentence that names
/// the agent and where to change it.
export function candidatesError(candidates: readonly Candidate[]): string | null {
  if (candidates.length < 2) {
    return "A best-of-N run needs at least two candidates — one agent is just Run.";
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.profileId.trim()} ${c.model.trim()}`;
    if (seen.has(key)) {
      return "Two candidates are the same agent and model — give one a different profile or model.";
    }
    seen.add(key);
  }
  return null;
}

/// What a candidate is told on top of the card's ordinary run prompt.
///
/// Three things it cannot work out for itself, and each is a way the run
/// goes wrong without it:
///
///  - It is in a worktree of its own. An agent that wanders back to the
///    main checkout -- or switches branches to "get up to date" -- is
///    editing another candidate's work, or the human's.
///  - Its tab has to stay tellable from its siblings'. Every agent's
///    first move is `gavin_name_session`, and three agents given the
///    same card name their tabs almost identically; the label is the
///    only thing that says which pane is which model.
///  - The card's status is NOT its to write. The card prompt ends by
///    telling it to set the done column when finished, which is right
///    for one agent and wrong for N: the first to finish would move a
///    card the other two are still working, and the human's pick is
///    what actually decides this card's fate.
export function candidatePromptSuffix(label: string, total: number): string {
  return (
    `\n\nYou are one of ${total} agents running this card side by side, each in a git worktree ` +
    `of its own. You are “${label}”, and this shell already starts in your worktree — work only ` +
    `in it, and do not switch branches or merge: another candidate's work and the human's own ` +
    `checkout are what you would be editing.\n\n` +
    `Begin your tab name with “${label} ” so the panes stay tellable apart. Leave this card's ` +
    `status alone — a human compares the candidates and picks one, and that pick is what ` +
    `records the outcome.`
  );
}

export function composeCandidatePrompt(prompt: string, label: string, total: number): string {
  return prompt + candidatePromptSuffix(label, total);
}

/// The page the candidates are tiled on. Named for the card, because the
/// page is what the human looks for afterwards and "Best of 3" would be
/// indistinguishable from the next run.
export function runPageName(cardTitle: string): string {
  const collapsed = cardTitle.split(/\s+/).filter(Boolean).join(" ");
  return collapsed ? collapsed : "Best of N";
}

/// The candidates that lose when `winner` is picked -- everything else.
/// A winner that is not in the run leaves every candidate a loser, which
/// is the abandon case and is exactly what a stale session id should
/// degrade to rather than a half-cleanup.
export function losersOf(run: BestOfNRun, winnerSessionId: string | null): RunCandidate[] {
  return run.candidates.filter((c) => c.sessionId !== winnerSessionId);
}

/// One line per candidate being thrown away: the folder that disappears
/// and the agent that was running in it. The folder leads because that
/// is the thing on disk.
function line(candidate: RunCandidate): string {
  const name = splitPath(candidate.worktreePath.replace(/\/+$/, "")).name || candidate.worktreePath;
  return `${name} — ${candidate.label}`;
}

/// The label on the branch tick-box. One branch is named; several are
/// counted, because a prompt listing five branch names is a prompt
/// nobody reads to the end. Same rule, same words as the worktree
/// sweep's -- these two prompts delete the same kind of thing and must
/// not describe it differently.
export function discardBranchesLabel(losers: readonly RunCandidate[]): string {
  if (losers.length === 1) return `Also delete the branch ${losers[0].branch}`;
  return `Also delete the ${losers.length} branches`;
}

/// What the losing side costs, stated once and in full: every folder by
/// name, and the fact that this is not a sweep -- the losers were never
/// merged and are not being kept anywhere. `danger`, so the button is
/// red and Enter lands on the way out.
///
/// The tick-box defaults ON. The branches only exist because this run
/// created them minutes ago, and leaving five dead refs behind by
/// default is how a repo's branch list becomes unreadable -- but it is a
/// tick-box and not a fait accompli, because a human who spotted
/// something worth keeping in a loser needs one click to keep the ref
/// that reaches it.
export function pickConfirm(
  winner: RunCandidate,
  losers: readonly RunCandidate[]
): ConfirmOptions & { check: ConfirmCheck } {
  return {
    title: `Keep ${winner.label} and discard ${count(losers.length, "candidate")}?`,
    lines: [
      ...losers.map(line),
      `Their folders and any uncommitted work in them are deleted. ${winner.label} keeps ${winner.branch} and stays bound to the card — merging it is still yours to do.`,
    ],
    confirmLabel: `Keep ${winner.label}`,
    cancelLabel: "Keep watching",
    danger: true,
    check: { label: discardBranchesLabel(losers), default: true },
  };
}

/// Abandoning: the same deletion with nobody kept. Named as a separate
/// prompt rather than `pickConfirm(null, …)` because the sentence that
/// matters is different -- there is no winner to reassure the human
/// about, and the card goes back to having no run at all.
export function abandonConfirm(
  losers: readonly RunCandidate[]
): ConfirmOptions & { check: ConfirmCheck } {
  return {
    title: `Discard all ${count(losers.length, "candidate")}?`,
    lines: [
      ...losers.map(line),
      "Their folders and any uncommitted work in them are deleted. The card keeps the status it has.",
    ],
    confirmLabel: "Discard the run",
    cancelLabel: "Keep watching",
    danger: true,
    check: { label: discardBranchesLabel(losers), default: true },
  };
}
