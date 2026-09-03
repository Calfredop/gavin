// The loop-until step, as pure data and pure functions. No Svelte, no
// Tauri, no I/O -- orchestration.ts decides with it and
// orchestrationState.ts performs the effects, exactly as every other
// scheduler rule is split.
//
// `builtin:until` is a step that runs a CHECK and, when the check fails,
// sends the rail BACKWARDS: the step before it is re-armed and runs
// again, up to a budget. It is the one tool whose verdict is not simply
// "done" or "stalled", which is why it needs a kind of its own (see
// ToolKind) rather than a branch on its id -- a duplicate of it, or a
// tool a newer gavin ships, has to behave the same way.
//
// Three things are load-bearing here and each has a comment where it
// lives:
//
//  - The budget is PERSISTED on the run row, not counted in memory.
//  - The check's output is captured to a FILE, so the retry prompt and
//    the failure reason can quote it without depending on a terminal
//    the human may never have looked at.
//  - The prompt prefix is DERIVED from persisted state at launch time,
//    never carried in a variable, so a reload mid-loop does not silently
//    drop it.

import { shellQuote } from "./cardRun";
// Types only -- erased at compile time, so orchestration.ts is free to
// import this module's VALUES without a runtime cycle.
import type { Orchestration, Rail, Step } from "./orchestration";
import type { ToolKind } from "./orchestrationTools";

/// The built-in that loops. Nothing here branches on it -- the KIND is
/// what the scheduler reads, so a duplicate under another id behaves the
/// same -- but the id is what the tests and the drawer name the shipped
/// one by, and one spelling of it beats three.
export const UNTIL_TOOL_ID = "builtin:until";

/// Retries, not total runs: the check runs once on the step's own turn,
/// and this is how many times after that the work may be re-done. Five
/// is the shipped default; the step's `max` param overrides it.
export const DEFAULT_UNTIL_MAX = 5;

/// A ceiling on whatever the human types. `max` is a text field, so it
/// can say `1000` -- and a rail that re-runs an agent a thousand times
/// unattended is not a loop, it is a bill. The cap is generous enough
/// that nobody meets it by accident and low enough that meeting it costs
/// an afternoon rather than a weekend.
export const UNTIL_MAX_CEILING = 25;

/// How much of the check's output opens the retried agent's prompt.
export const RETRY_TAIL_LINES = 40;

/// How much of it goes in the STALL REASON when the budget runs out.
/// Shorter than the prompt's tail on purpose: a reason is rendered in a
/// chip's tooltip and on the step card, where forty lines of test output
/// is not a message, it is a wall. The full run is one click away in the
/// rail's page, which is where the human reads it.
export const REASON_TAIL_LINES = 10;

/// The tool fields the budget is read from. Deliberately structural: the
/// scheduler holds `ToolSummary`s and the rail header holds whole
/// `Tool`s, and both answer this question.
export interface UntilParams {
  params?: readonly { name: string; default: string }[];
}

/// One declared param's effective value: the step's override, else the
/// tool's own default, else "".
///
/// `resolveToolParam` in orchestrationTools.ts answers the same question
/// over a whole `Tool`; this answers it over the summary shape the
/// scheduler carries, and gives the same answer for the same reason -- an
/// override for a param the tool no longer declares is IGNORED, so a
/// stale override cannot outlive the parameter it was typed into.
export function summaryParam(
  tool: UntilParams | undefined,
  overrides: Record<string, string>,
  name: string
): string {
  const declared = tool?.params?.find((p) => p.name === name);
  if (!declared) return "";
  return overrides[name] ?? declared.default;
}

/// The step's budget: its `max` override, else the tool's own default,
/// else the shipped one. Anything unparseable reads as the default
/// rather than as zero -- a typo in a text field must never turn a loop
/// into a step that gives up on its first failure.
///
/// An override for a param the tool no longer declares is IGNORED, the
/// same answer resolveToolParam gives: a stale override must not outlive
/// the parameter it was typed into.
export function untilMax(tool: UntilParams | undefined, overrides: Record<string, string>): number {
  const raw = summaryParam(tool, overrides, "max").trim();
  // Whole digits only, deliberately stricter than parseInt: `2.7.1` and
  // `5x` are typos, and reading a prefix out of one silently runs a
  // budget the human did not write.
  if (!/^\d+$/.test(raw)) return DEFAULT_UNTIL_MAX;
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) return DEFAULT_UNTIL_MAX;
  return Math.min(parsed, UNTIL_MAX_CEILING);
}

// ---- The check's output -----------------------------------------------------

/// Where a check step tees its output.
///
/// A FILE rather than the session's scrollback, because the scrollback
/// may not exist: an xterm `Terminal` is built by the pane that shows it,
/// and a rail's page is very often one the human never opened. The
/// retried agent's prompt and the exhausted step's reason both have to
/// quote what failed, so the check writes it somewhere both can read.
///
/// Deterministic from the step id, so nothing has to be remembered
/// between the launch that writes it and the tick that reads it -- which
/// is what makes the whole loop survive an app reload.
export function untilLogPath(stepId: string): string {
  return `/tmp/gavin-until-${stepId.replace(/[^A-Za-z0-9_-]/g, "")}.log`;
}

/// The check, wrapped so it stays VISIBLE and still says what it did.
///
/// `tee` keeps the output on screen -- this is a shell session in the
/// rail's page like any other tool step, not a hidden probe -- while
/// leaving a copy behind. `pipefail` is what makes the pipeline's exit
/// status the CHECK's rather than tee's, which is always 0; without it
/// every check would pass. Both are bash features and this string is
/// only ever run through `bash -c` (buildToolCommand's `script` shape),
/// never through the human's login shell, which on this machine is zsh.
export function buildUntilScript(check: string, logPath: string): string {
  return ["set -o pipefail", "{", check, `} 2>&1 | tee ${shellQuote(logPath)}`].join("\n");
}

/// The last `lines` lines of the check's output, trailing blanks
/// dropped. Empty in, empty out -- callers treat "" as "nothing to
/// quote" rather than quoting an empty block.
export function checkTail(output: string, lines: number = RETRY_TAIL_LINES): string {
  const trimmed = output.replace(/\s+$/, "");
  if (!trimmed) return "";
  const all = trimmed.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/// What opens the retried agent's prompt. The check's own words, fenced,
/// then the instruction -- an agent that is handed a failure and not
/// told what to do with it writes a report instead of a fix.
export function retryPromptPrefix(output: string): string {
  return (
    "The previous attempt failed this check:\n" +
    "```\n" +
    `${checkTail(output)}\n` +
    "```\n" +
    "Fix it, then finish."
  );
}

/// The prompt an agent step is actually launched with. `null` output
/// means this launch is not a retry at all, and the prompt is untouched
/// -- the common case, and the one that must stay byte-identical.
export function withRetryPrefix(prompt: string, output: string | null): string {
  if (output === null || !checkTail(output)) return prompt;
  return `${retryPromptPrefix(output)}\n\n${prompt}`;
}

/// The stall reason a spent budget leaves behind: what happened, how
/// many tries it took, and the check's own last words -- which are the
/// part the human acts on.
export function exhaustedReason(max: number, output: string): string {
  const tries = `${max} ${max === 1 ? "retry" : "retries"}`;
  const tail = checkTail(output, REASON_TAIL_LINES);
  const said = tail ? ` — ${tail}` : "";
  return `the check still failed after ${tries}${said}`;
}

/// The rail header's line while a loop is going round.
export function retryLabel(attempt: number, max: number): string {
  return `retry ${attempt} of ${max}`;
}

// ---- Walking the rail -------------------------------------------------------

/// Every step of a rail in the order it RUNS: stages by position, then
/// steps by position inside each. A parallel stage has no true order,
/// but it has a stable one, and "the step before" has to mean something
/// definite even there.
export function flatSteps(rail: Rail): Step[] {
  return [...rail.stages]
    .sort((a, b) => a.position - b.position)
    .flatMap((stage) => [...stage.steps].sort((a, b) => a.position - b.position));
}

/// The step immediately before this one on its rail, or null when it is
/// the very first -- an `until` step with nothing in front of it has
/// nothing to re-run, and says so rather than looping over itself.
export function stepBefore(rail: Rail, stepId: string): Step | null {
  const steps = flatSteps(rail);
  const at = steps.findIndex((s) => s.id === stepId);
  return at > 0 ? steps[at - 1] : null;
}

/// The step immediately after this one, or null.
export function stepAfter(rail: Rail, stepId: string): Step | null {
  const steps = flatSteps(rail);
  const at = steps.findIndex((s) => s.id === stepId);
  return at >= 0 && at < steps.length - 1 ? steps[at + 1] : null;
}

/// The stage that holds a step, by id.
export function stageIdOfStep(rail: Rail, stepId: string): string | null {
  return rail.stages.find((s) => s.steps.some((t) => t.id === stepId))?.id ?? null;
}

/// Whether a step runs the `until` tool. Null tools means the library is
/// still loading, which must never read as "no step loops" -- the same
/// cold-start rule launchBlocker follows. An unknown tool id answers
/// false for the same reason it does in agentTurnEnded: a tool that
/// cannot be identified must not be assumed to be this one.
export function isUntilStep(step: Step, kinds: Map<string, ToolKind> | null): boolean {
  if (!step.toolId || !kinds) return false;
  return kinds.get(step.toolId) === "until";
}

/// Whether a step runs the `pr` tool -- the wait on a pull request. Its
/// verdict comes from GitHub rather than from an exit code, but what it
/// does with a failure is this module's loop exactly.
export function isPrStep(step: Step, kinds: Map<string, ToolKind> | null): boolean {
  if (!step.toolId || !kinds) return false;
  return kinds.get(step.toolId) === "pr";
}

/// Whether a step can send its rail BACKWARDS. Two kinds can, and every
/// rule about the loop itself -- the budget, the retry label, what opens
/// the re-run's prompt -- is about this predicate rather than about
/// either kind, because the loop is one mechanism with two ways in.
export function isLoopingStep(step: Step, kinds: Map<string, ToolKind> | null): boolean {
  return isUntilStep(step, kinds) || isPrStep(step, kinds);
}

// ---- The budget -------------------------------------------------------------
//
// Counted on the until step's OWN run row, in `StepRun.resumeAttempts`.
//
// That field was minted for auto-resume, and this is a deliberate reuse
// rather than a second mechanism: it is the only persisted integer a run
// row has, and adding another would be a protocol bump this change is
// explicitly not making. The two can never collide, because auto-resume
// acts on a run with a CONVERSATION id and a `failed` agent behind it,
// and an until step is a shell with neither (autoResumeDecision skips it
// on `conversationId` alone).
//
// Persisted rather than counted in memory for the reason
// MAX_AUTO_RESUME_ATTEMPTS gives: an app reload and a daemon restart are
// ordinary events during a loop that re-runs an agent five times, and an
// in-memory counter is an unbounded loop wearing the costume of a limit.
//
// The count is cleared wherever a run starts over -- resetRail,
// retryStep, and the stall a spent budget writes. It is NOT cleared when
// the check finally passes: the only ways to run the step again all go
// through one of those three.

/// What to do about an `until` step whose check session has ended.
///
/// `unwitnessed` is not a verdict of its own doing: it means the app was
/// not running when the check ended, so nobody saw the exit code, and
/// the caller falls back to the rule it already had for that (a stall,
/// never a pass -- see toolStepOutcome).
export type UntilVerdict =
  | { kind: "pass" }
  | { kind: "unwitnessed" }
  | { kind: "retry"; previousStepId: string; attempt: number; max: number }
  | { kind: "exhausted"; max: number }
  | { kind: "stuck"; reason: string };

export function untilVerdict(input: {
  /// The check session's exit code, or undefined when nobody saw it.
  exitCode: number | undefined;
  /// `StepRun.resumeAttempts` -- retries already spent. Absent is zero.
  attempts: number | null | undefined;
  max: number;
  /// The step this loop re-runs, or null when the until step is first on
  /// its rail.
  previousStepId: string | null;
}): UntilVerdict {
  if (input.exitCode === 0) return { kind: "pass" };
  if (input.exitCode === undefined) return { kind: "unwitnessed" };
  if (!input.previousStepId) {
    return {
      kind: "stuck",
      reason: "nothing runs before this step, so the check has nothing to send the rail back to",
    };
  }
  const used = Math.max(0, input.attempts ?? 0);
  if (used >= input.max) return { kind: "exhausted", max: input.max };
  return {
    kind: "retry",
    previousStepId: input.previousStepId,
    attempt: used + 1,
    max: input.max,
  };
}

/// The step a rail is currently looping on, or null. A loop is in flight
/// exactly when that step is back to `pending` with retries already spent
/// -- which is the state loopBack leaves behind, and one no other path
/// can produce (every launch of a looping step preserves the count, and
/// every fresh start zeroes it).
export function loopingUntilStep(
  rail: Rail,
  orch: Orchestration,
  kinds: Map<string, ToolKind> | null
): { step: Step; attempt: number } | null {
  for (const step of flatSteps(rail)) {
    if (!isLoopingStep(step, kinds)) continue;
    const run = orch.stepRuns.find((r) => r.stepId === step.id);
    if (!run || run.state !== "pending") continue;
    const attempt = run.resumeAttempts ?? 0;
    if (attempt >= 1) return { step, attempt };
  }
  return null;
}

/// "retry 2 of 5" for the rail header, or null when nothing is looping.
export function railRetryLabel(
  rail: Rail,
  orch: Orchestration,
  tools: readonly (UntilParams & { id: string; kind: ToolKind })[] | null
): string | null {
  const kinds = tools ? new Map(tools.map((t) => [t.id, t.kind])) : null;
  const looping = loopingUntilStep(rail, orch, kinds);
  if (!looping) return null;
  const tool = tools?.find((t) => t.id === looping.step.toolId);
  return retryLabel(looping.attempt, untilMax(tool, looping.step.toolParams ?? {}));
}

/// WHERE the failure that must open THIS step's prompt is to be read
/// from, or null when this launch is not a retry.
///
/// Derived, never remembered. The loop's re-arm writes two run rows and
/// nothing else; a note held in a variable would be lost by the reload
/// that this whole family of features exists to survive. So the launch
/// asks the plan instead: am I the step immediately before a LOOPING step
/// that is mid-loop? If so, that step knows what failed.
///
/// Which is a different place per kind, and that is the whole reason this
/// returns a source rather than a path. An `until` step tee'd its check
/// to a file; a `pr` step read GitHub, and its failing checks are in the
/// live report rather than on disk. Neither is remembered between the
/// re-arm and the launch.
export type RetrySource = { kind: "log"; path: string } | { kind: "pr"; stepId: string };

export function retrySourceFor(
  rail: Rail,
  stepId: string,
  orch: Orchestration,
  kinds: Map<string, ToolKind> | null
): RetrySource | null {
  const next = stepAfter(rail, stepId);
  if (!next || !isLoopingStep(next, kinds)) return null;
  const run = orch.stepRuns.find((r) => r.stepId === next.id);
  if (!run || run.state !== "pending" || (run.resumeAttempts ?? 0) < 1) return null;
  return isPrStep(next, kinds)
    ? { kind: "pr", stepId: next.id }
    : { kind: "log", path: untilLogPath(next.id) };
}

/// The `until` case of retrySourceFor, kept because the shape a caller
/// wants there is a path. Null for anything that is not a log.
export function retryLogFor(
  rail: Rail,
  stepId: string,
  orch: Orchestration,
  kinds: Map<string, ToolKind> | null
): string | null {
  const source = retrySourceFor(rail, stepId, orch, kinds);
  return source?.kind === "log" ? source.path : null;
}
