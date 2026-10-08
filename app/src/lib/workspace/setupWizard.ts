import type { AgentSkillsMark, AgentSkillsStatus } from "$lib/agents/agentSkills";
import { agentSkillsDone } from "$lib/agents/agentSkills";
import {
  headroomStepDone,
  headroomStepSettled,
  type HeadroomReading,
} from "$lib/agents/headroomSetup";
import { memoryStepDone, memoryStepSettled, type MemoryReading } from "$lib/cards/memoryIndex";
import type { PlaywrightMark, PlaywrightReading } from "$lib/agents/playwrightSetup";

export type SetupStep =
  | "agent"
  | "integration"
  | "agentSkills"
  | "headroom"
  | "memory"
  | "playwright"
  | "git"
  | "review"
  | "prd"
  | "launch";

export interface SetupProgress {
  done: SetupStep[];
  /// The first step not yet done, or null when everything is.
  next: SetupStep | null;
  complete: boolean;
  /// Every step a workspace can be BADLY SET UP for -- everything but
  /// `launch`, `git`, `review`, `headroom` and `memory`. The rest are configuration that stays
  /// configured; launch's evidence is a live process, so it is the only
  /// step that can un-happen, and it is optional besides (W2). A nag must
  /// read this, never `complete`: keyed off `complete`, pressing Stop on
  /// the home tab's agent panel -- or the agent simply exiting -- reads as
  /// a finished workspace coming undone (design §5.4: an unlaunched
  /// workspace does not nag).
  ///
  /// `git` is out for a different reason: an unanswered git question is
  /// not a broken workspace. Tracking is on by default and already in
  /// force, so the only thing missing is that nobody has been ASKED --
  /// and every workspace that existed before the step did is in exactly
  /// that state. Nagging them all would be a banner about a question,
  /// not about a problem. `review` and `headroom` are out for the same
  /// reason: compression is off by default, and off is a workspace set up
  /// the way it always was. `memory` too: a workspace with no index is
  /// one whose agents read `### Learned` the way they always did.
  ///
  /// `playwright` is IN, deliberately, the way agent skills is: optional,
  /// but a step every workspace that existed before it was added is meant
  /// to be asked once (the Playwright spec, "Init and catchup"). The
  /// banner is how it is asked, and "not now" is an answer that ends it --
  /// so it nags until answered, never for ever.
  configured: boolean;
  /// True while an input the derivation needs has not been read yet.
  /// Every other field then describes only the evidence seen so far and
  /// must not be acted on: a caller that renders "setup unfinished"
  /// while this is true is really rendering "the reads are not back".
  pending: boolean;
}

/// Verbatim from PRD_TEMPLATE in crates/daemon/src/gavin.rs. Matching
/// these strings IS the contract -- if the template changes, these change
/// with it or the PRD step silently stops being detectable.
export const PRD_PLACEHOLDERS = {
  vision: "_What are we building, for whom, and why?_",
  focus: "_The active goals, roughly ordered._",
  outOfScope: "_Explicit non-goals._",
} as const;

const MARKER_START = "<!-- gavin:start -->";

export interface SetupInput {
  hasRoot: boolean;
  /// config.toml's [agent].command. The scaffold writes only `profile`,
  /// so a command can only have come from a person.
  configCommand: string | null;
  /// The resolved agent file's content; null when it does not exist,
  /// undefined while the read is still in flight. Those two are NOT the
  /// same answer, and collapsing them is how "not read yet" turns into
  /// "step not done" for the length of a round trip.
  agentFileBody: string | null | undefined;
  prdBody: string | null | undefined;
  mainSessionId: string | null;
  /// The agent skills detector's answer, `undefined` while the check is
  /// still running. Same distinction the two file bodies draw, and for
  /// the same reason: a check in flight is not a check that found
  /// nothing, and reading it as one opens the wizard on a finished step.
  agentSkills: AgentSkillsStatus | undefined;
  /// What the human has said about agent skills for this root, if
  /// anything. `undefined` is "not asked yet", never "not now" -- the
  /// step's second completion route depends on telling those apart.
  agentSkillsMark: AgentSkillsMark | undefined;
  /// Whether the human has answered the git question for this workspace
  /// (`Workspace.gitTrackingAsked`).
  ///
  /// The only step whose evidence is a recorded word rather than a state
  /// on disk, and it has to be: both answers are legitimate, and the
  /// repository cannot tell "tracked, deliberately" from "nobody has
  /// decided". Deriving it from the ignore rule would leave every
  /// workspace that wants the default permanently unfinished. Read off
  /// the workspace record, so it costs no round trip and never joins
  /// `pending`.
  gitTrackingAsked: boolean;
  /// Whether the human has answered the require-review question for this
  /// workspace (`Workspace.requireReviewAsked`). Same shape as
  /// `gitTrackingAsked` and for the same reason: both answers are
  /// legitimate, and the gate's default (on) is indistinguishable on disk
  /// from nobody having decided yet.
  requireReviewAsked: boolean;
  /// Headroom as the local daemon reported it, for this workspace
  /// (`workspaceHeadroomReading`), `undefined` while the ask is out.
  /// Not the same answer as "absent", for the file bodies' reason: a
  /// reading still in flight read as a missing Headroom opens the wizard
  /// on a step with an Install button for something that is there.
  headroomReading: HeadroomReading | undefined;
  /// Whether the human has answered the compression question for this
  /// workspace (`Workspace.headroomAsked`). Same shape as
  /// `requireReviewAsked`: off, the default, is indistinguishable on disk
  /// from nobody having decided.
  headroomAsked: boolean;
  /// This root's memory index as the local daemon reported it
  /// (`workspaceMemoryReading`), `undefined` while the ask is out -- the
  /// Headroom reading's rule, for its reason.
  memoryReading: MemoryReading | undefined;
  /// Whether the human said "not now" to the Memory step for this root
  /// (`loadMemorySkipped`). Read synchronously, so it never joins
  /// `pending` on its own.
  memorySkipped: boolean;
  /// Playwright's three checks for this root (`agent_playwright.rs`, via
  /// `workspacePlaywrightReading`), `undefined` while the ask is out --
  /// the file bodies' rule, for their reason.
  playwright: PlaywrightReading | undefined;
  /// What the human said about Playwright for this root, if anything
  /// (`loadPlaywrightMark`): "not now", or "I've set it up" where gavin
  /// could not check. Read synchronously.
  playwrightMark: PlaywrightMark | undefined;
}

/// Whether the Playwright step is finished: the three checks found it
/// set up, the human gave an answer -- "not now" or "I've set it up" --
/// or the step cannot serve this workspace from this machine (an ssh
/// workspace). Like agent skills, an `unavailable` reading on its own is
/// NOT done: gavin failing to look is not the human deciding, and taking
/// it for one would finish the step for every custom agent before its
/// owner saw it.
export function playwrightStepDone(
  reading: PlaywrightReading | undefined,
  mark: PlaywrightMark | undefined
): boolean {
  if (mark) return true;
  if (reading?.kind === "elsewhere") return true;
  return reading?.kind === "status" && reading.status.state === "verified";
}

/// Whether the step's answer is known. A recorded answer settles it on
/// its own: no check in flight can undo the human having answered.
export function playwrightStepSettled(
  reading: PlaywrightReading | undefined,
  mark: PlaywrightMark | undefined
): boolean {
  return Boolean(mark) || reading !== undefined;
}

/// agent skills sits third (spec S2): it is agent tooling, so it belongs
/// beside Integration, and PRD and Launch stay last. Headroom is agent
/// tooling too, and follows agent skills (the Headroom spec, "The switch");
/// Memory follows Headroom, and Playwright follows Memory, the last of the
/// tooling (the Playwright spec, "Init and catchup"). Exported because
/// every surface that counts steps must count THIS list -- the Home hub's
/// banner said "of 4" as a literal and would have gone on saying it.
///
/// Git sits fourth, between the tooling steps and the content ones: it
/// asks about the files gavin has by then created, and it is settled
/// BEFORE the PRD step writes into one of them. Review sits fifth, right
/// after it: the same shape of question (a machine-local preference, both
/// answers legitimate), settled before the workspace's first real card
/// exists to be run.
export const SETUP_STEPS: SetupStep[] = [
  "agent",
  "integration",
  "agentSkills",
  "headroom",
  "memory",
  "playwright",
  "git",
  "review",
  "prd",
  "launch",
];

const ORDER: SetupStep[] = SETUP_STEPS;

/// Derived, never stored (W1): a step configured by hand -- or by an
/// agent -- counts the moment its evidence lands on disk, so no progress
/// record can disagree with reality.
export function setupProgress(input: SetupInput): SetupProgress {
  if (!input.hasRoot) {
    // Every later step writes under the root, so without one nothing can
    // be done yet -- whatever else happens to be true. Settled, not
    // pending: no pending read could change this answer.
    return { done: [], next: "agent", complete: false, configured: false, pending: false };
  }
  const done: SetupStep[] = [];
  if (input.configCommand?.trim()) done.push("agent");
  if (input.agentFileBody?.includes(MARKER_START)) done.push("integration");
  // S6: a check that found it, the human's word, or their "not now".
  // The third route is why declining once stops the nagging.
  if (agentSkillsDone(input.agentSkills, input.agentSkillsMark)) done.push("agentSkills");
  // The question was put, or there is none to put: Headroom cannot serve
  // this workspace on this machine. Never on an unknown reading.
  if (headroomStepDone(input.headroomReading, input.headroomAsked)) done.push("headroom");
  // The model is here and the index matches `### Learned`, the human said
  // "not now", or this machine can do nothing for the workspace.
  if (memoryStepDone(input.memoryReading, input.memorySkipped)) done.push("memory");
  // Set up, answered, or out of this machine's reach. Never on an unknown
  // reading, and never on gavin being unable to look.
  if (playwrightStepDone(input.playwright, input.playwrightMark)) done.push("playwright");
  // A recorded answer and nothing else -- see `gitTrackingAsked`. Both
  // answers finish the step; which one they gave lives in the repo.
  if (input.gitTrackingAsked) done.push("git");
  // Same shape, same reason -- see `requireReviewAsked`.
  if (input.requireReviewAsked) done.push("review");
  // At least one placeholder replaced, not all three: filling only Vision
  // is a real PRD, and requiring all three would never complete.
  const prd = input.prdBody;
  if (prd != null && Object.values(PRD_PLACEHOLDERS).some((p) => !prd.includes(p))) {
    done.push("prd");
  }
  if (input.mainSessionId) done.push("launch");

  const ordered = ORDER.filter((s) => done.includes(s));
  const next = ORDER.find((s) => !done.includes(s)) ?? null;
  // The agent skills check joins the same rule the two file reads follow.
  // A settled marker answers on its own, though: once the human has said
  // "not now", no in-flight detector can change whether the step is done,
  // and waiting on one would hold the whole wizard for a round trip that
  // cannot matter.
  const agentSkillsSettled = Boolean(input.agentSkillsMark) || input.agentSkills !== undefined;
  // The Headroom reading the same way: out is pending, and a recorded
  // answer settles it whatever the reading.
  const headroomSettled = headroomStepSettled(input.headroomReading, input.headroomAsked);
  const memorySettled = memoryStepSettled(input.memoryReading, input.memorySkipped);
  const playwrightSettled = playwrightStepSettled(input.playwright, input.playwrightMark);
  const pending =
    input.agentFileBody === undefined ||
    input.prdBody === undefined ||
    !agentSkillsSettled ||
    !headroomSettled ||
    !memorySettled ||
    !playwrightSettled;
  // Five steps sit outside the nag, for two different reasons. Launch's
  // evidence is a live process rather than a file or a marker, so it is
  // the one step that can un-happen, and it is optional besides (W2).
  // Git's, Review's, Headroom's and Memory's are questions nobody has been asked
  // yet, which is not the same as a workspace set up wrong -- see
  // `configured`. What
  // is left is what the Home banner is allowed to read; `complete` still
  // means all of them, which is what the wizard opens on. Playwright is
  // not on the list: it is the catch-up `configured` describes.
  const configured = ORDER.every(
    (s) =>
      s === "launch" ||
      s === "git" ||
      s === "review" ||
      s === "headroom" ||
      s === "memory" ||
      done.includes(s)
  );
  return { done: ordered, next, complete: next === null, configured, pending };
}

export interface PrdSections {
  vision: string;
  focus: string;
  outOfScope: string;
}

/// Replaces each placeholder line with the given prose. Blank values are
/// left alone, so skipping a section keeps its placeholder -- and a
/// section already filled has no placeholder left to replace, which makes
/// this idempotent rather than duplicating.
export function applyPrdSections(body: string, sections: PrdSections): string {
  let out = body;
  const pairs: Array<[string, string]> = [
    [PRD_PLACEHOLDERS.vision, sections.vision],
    [PRD_PLACEHOLDERS.focus, sections.focus],
    [PRD_PLACEHOLDERS.outOfScope, sections.outOfScope],
  ];
  for (const [placeholder, value] of pairs) {
    if (value.trim()) out = out.replace(placeholder, value.trim());
  }
  return out;
}

/// The agent-driven option is offered only where the positional-prompt
/// convention is verified (spec §7.2); elsewhere the step says so rather
/// than risking a launch with garbage in the agent's argv.
export function agentFlowAvailable(
  profile: { promptArgs: string | null } | undefined
): boolean {
  // `promptArgs` is a PREFIX, and "" is the bare positional -- a working
  // profile, not an absent one. Only null means the agent takes no
  // prompt, so this compares rather than coerces: `Boolean("")` would
  // hide the flow from claude-code, codex and gemini alike.
  return profile !== undefined && profile.promptArgs !== null;
}

/// Whether the PRD still carries a placeholder for the three section
/// fields to write into. A document the human pointed the workspace at --
/// their own, already-written PRD -- has none, so those fields would
/// replace nothing and Continue would save nothing; the step swaps them
/// for a note instead of offering a form that cannot act.
///
/// Unknown counts as "yes", deliberately: absent (the file is not there)
/// and undefined (the read is still in flight) are both states the form
/// is the right default for, and a body that arrives already authored
/// simply swaps it out then.
export function prdHasPlaceholders(body: string | null | undefined): boolean {
  if (typeof body !== "string") return true;
  return Object.values(PRD_PLACEHOLDERS).some((p) => body.includes(p));
}
