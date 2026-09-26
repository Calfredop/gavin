// WHOSE change is this? The pure half of TypeSafe change attribution.
//
// Gavin attributes a change to a card by baseline sha alone. In a
// checkout several sessions share -- this repository's normal state --
// that diff is every session's edits at once, and `next_baseline` in
// `runchanges.rs` says so of the one case it cannot bound: two runs
// launched from the same commit "are measured identically ... nothing
// here can say which of them wrote what". Measured on 86 cards and 592
// changed files labelled by git history
// (`docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`),
// a card's change list in a five-card tree is 17% its own files. One
// TypeSafe Choice per changed file -- the diff excerpt against the
// co-tenant cards' titles and plans -- names the right card for 85-91%
// of files, and at `confidence >= 0.75` the slice it names is 96-100%
// right while a foreign file is called nobody's 88-98% of the time.
//
// Four rules, and every function below is built to keep them:
//
//  - **A hint, never a filter.** Attribution ANNOTATES the list baseline
//    diffing produced. Nothing here removes a file from it and nothing
//    here is read by `discard_run`. Every failure -- an error, a timeout,
//    a missing key, `none`, a confidence under the floor, a card whose
//    title is gone -- comes out as `UNATTRIBUTED`, which is today's
//    answer. Turning the feature on can only add a label.
//
//  - **Only when there is a question to ask.** `coTenants` is empty for a
//    run alone in its worktree, and `attributionPlan` then asks nothing:
//    a lone run costs nothing and sends nothing.
//
//  - **The question is the E4 set, verbatim.** `ATTRIBUTION_INSTRUCTIONS`
//    and `NONE_CRITERION` are the spec's wording, the option keys are
//    neutral and shuffled per request so the model cannot read a card's
//    file name or the run's identity off them, and `TYPESAFE_MODEL` pins
//    `jev-1.13.0` -- every threshold here was measured on that pair.
//
//  - **Policy in code.** The floor, the excerpt bounds, the skip list and
//    the cap are named constants, and the raw answer (`AttributionAnswer`)
//    is kept distinct from the reading (`FileAttribution`) so a threshold
//    can be re-derived from stored judgments rather than guessed at.
//
// Pure. The request never leaves here -- `changeAttributionState.ts`
// fetches diffs and card bodies and posts through the Tauri host
// (`typesafe.rs`), because the key must never reach the frontend -- and no
// store is read, so every judgement is arguable in a test.

import type { CardSession } from "$lib/board/kanban";
import type { FileDiff, FileEntry } from "$lib/git/git";
import { WORKTREES_DIR } from "$lib/git/git";
import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import { stripFrontmatter } from "$lib/cards/planChecklist";

/// Below this a file is not attributed at all: today's answer stands.
///
/// Frozen on the dev scenarios before the test split ran. At this floor
/// the slice the model names is 96-100% right on the measured set and
/// holds 74-88% of a card's own files; the rest fall through to
/// "unattributed", which is what every file is today.
export const ATTRIBUTION_MIN_CONFIDENCE = 0.75;

/// How much of a file's diff goes with the request: the bounds the
/// experiment measured on. More is not better -- the excerpt is the whole
/// of the source code that leaves the machine, and the model was right
/// on this much.
export const EXCERPT_MAX_CHANGED_LINES = 70;
export const EXCERPT_MAX_CHARS = 2600;

/// How much of a card's body describes it to the model. The "plan"
/// condition in the experiment: the body up to here, cut at the first
/// after-the-fact heading, ticks cleared.
export const DESCRIPTION_MAX_CHARS = 600;

/// How many other cards a request may offer as options.
///
/// The experiment pooled five; the commit-link question offered 86 and
/// held up. Sixteen keeps a busy checkout's whole live set in one
/// request while bounding what a board with a long run history sends --
/// the peers launched from this run's own commit come first, because
/// they are the co-tenants that are certain.
export const MAX_CO_TENANTS = 16;

/// How many files one run is asked about. A cap on cost and time, not on
/// correctness: files past it stay unattributed, which is today's answer.
/// At ~$0.0001 and ~0.3s a file, this is under two cents and, at four in
/// flight, under a quarter of a minute.
export const MAX_FILES_PER_RUN = 150;

/// The E4 question, VERBATIM from the experiment record. `change` is
/// named in it because question ids are not sent to the model: the
/// instruction has to carry its own complete meaning.
export const ATTRIBUTION_INSTRUCTIONS =
  "`change` is one modified file from a git working tree in which several tasks are being worked on at the same time. Each option describes one of those tasks. Which task is this change part of?";

/// The one option that is not a card. An answer, not a gap in the list:
/// a foreign file is nobody's, and the model calling it that is the
/// direction that keeps a discard warning honest.
export const NONE_CRITERION = "The change is not part of any of these tasks.";

// ---- Which cards are in the same checkout ----------------------------------

/// The run a question is about: the card, the checkout git resolved for
/// it (`RunChanges.root`), where it started, and the peers that started
/// after it.
export interface AttributedRun {
  cardPath: string;
  /// The repository root, as `git rev-parse --show-toplevel` reports it.
  root: string;
  baseSha: string;
  /// Every peer baseline that DESCENDS from this one, as `runchanges.rs`
  /// found them: runs launched in this checkout after this run. A
  /// window bounded by the nearest of them contains none of their work,
  /// so they are not co-tenants of it. Empty for the unbounded question
  /// the per-run Changes view asks, where everything in the checkout is.
  laterBaselines: readonly string[];
}

/// Forward slashes, no trailing slash, and case folded where the path
/// carries a Windows drive letter -- because `RunChanges.root` comes from
/// git (`C:/Users/...`) and a binding's launch cwd from the OS
/// (`C:\Users\...`), and the two name one directory.
function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/// Whether a session launched in `dir` works in `root`'s checkout: the
/// root itself or any depth below it -- except inside a
/// `.gavin-worktrees` folder, which holds OTHER checkouts of the same
/// repository. Deeper in the tree is not the same working tree there,
/// and a run in one never edits this checkout's diff.
function isInside(dir: string, root: string): boolean {
  const d = normalizePath(dir);
  const r = normalizePath(root);
  if (d === r) return true;
  if (!d.startsWith(`${r}/`)) return false;
  return !d.slice(r.length + 1).split("/").includes(WORKTREES_DIR);
}

/// Every OTHER card run in this run's checkout whose window overlaps
/// this one's: launched in the same tree (at any depth), from this run's
/// commit or an older one, or from anywhere at all when this run's
/// window is unbounded. Empty for a lone run in its own worktree, which
/// is what makes a lone run free.
///
/// Peers launched from the SAME commit lead, and the list is capped at
/// `MAX_CO_TENANTS`. A binding with no baseline is not a run gavin
/// measured and cannot be placed.
export function coTenants(run: AttributedRun, bindings: readonly CardSession[]): CardSession[] {
  const later = new Set(run.laterBaselines);
  const seen = new Set<string>([run.cardPath]);
  const same: CardSession[] = [];
  const rest: CardSession[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.path)) continue;
    if (!binding.baseSha || later.has(binding.baseSha)) continue;
    if (!isInside(binding.launchCwd ?? binding.cwd, run.root)) continue;
    seen.add(binding.path);
    (binding.baseSha === run.baseSha ? same : rest).push(binding);
  }
  return [...same, ...rest].slice(0, MAX_CO_TENANTS);
}

// ---- What a card says about itself ------------------------------------------

/// Headings that open the part of a card written AFTER the work: what
/// landed, what was fixed, what was found. The experiment cut there
/// because a finished card describes the diff, and a description of the
/// diff is not what a running card looks like. A vocabulary rather than
/// "any heading" so a plan that opens with `## Goal` keeps its goal.
const AFTER_THE_FACT_HEADING =
  /^#{1,6}\s+(what (landed|changed|was (done|built|fixed))|landed|results?|the fix|fix(es)?|outcome|resume notes|findings|verification|follow-ups?|done)\b/im;

/// The card's body as the model sees it: frontmatter off, cut at the
/// first after-the-fact heading, ticks cleared so a half-done plan and a
/// finished one describe the same work, and at most
/// `DESCRIPTION_MAX_CHARS`.
export function cardDescription(body: string): string {
  let text = stripFrontmatter(body);
  const cut = text.match(AFTER_THE_FACT_HEADING);
  if (cut?.index !== undefined) text = text.slice(0, cut.index);
  text = text.replace(/^(\s*[-*+]\s+)\[[xX]\]/gm, "$1[ ]");
  return text.trim().slice(0, DESCRIPTION_MAX_CHARS).trim();
}

// ---- Which files, and how much of each -----------------------------------------

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "icns",
  "svg",
  "tif",
  "tiff",
  "avif",
  "heic",
  "psd",
]);

/// Why this path is not asked about, or null when it is. Decided in code
/// from the name alone, before any diff is read: a lockfile's diff says
/// nothing about intent and costs the most to send, and an image has no
/// text diff to judge.
export function excerptSkipReason(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (LOCKFILES.has(name) || name.endsWith(".lock")) return "a lockfile";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1))) return "an image";
  return null;
}

/// The diff as the model sees it: hunks in unified form, no file
/// headers, cut at `EXCERPT_MAX_CHANGED_LINES` changed lines or
/// `EXCERPT_MAX_CHARS`, whichever comes first, always on a line boundary.
/// Null when there is nothing to judge -- a binary, a diff too large to
/// have been parsed, or no hunks at all.
export function diffExcerpt(diff: FileDiff): string | null {
  if (diff.binary || diff.tooLarge || diff.hunks.length === 0) return null;
  const out: string[] = [];
  let chars = 0;
  let changed = 0;
  const push = (line: string): boolean => {
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (chars + cost > EXCERPT_MAX_CHARS) return false;
    out.push(line);
    chars += cost;
    return true;
  };
  for (const hunk of diff.hunks) {
    if (!push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)) break;
    for (const line of hunk.lines) {
      const isChange = line.kind !== "context";
      if (isChange && changed >= EXCERPT_MAX_CHANGED_LINES) return out.join("\n");
      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      if (!push(prefix + line.text)) return out.join("\n");
      if (isChange) changed++;
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

// ---- The request ----------------------------------------------------------------

/// One card as the model is offered it.
export interface AttributionOption {
  path: string;
  title: string;
  /// `cardDescription` of the body, or "" for a card with no body -- in
  /// which case only the title is sent (the experiment's title
  /// condition), never an empty description.
  description: string;
}

export interface AttributionRequest {
  model: string;
  state: { change: { path: string; diff: string } };
  questions: {
    owner: {
      type: "choice";
      instructions: string;
      criteria: Record<string, { title: string; description?: string } | string>;
    };
  };
}

/// `task_a`, `task_b`, ... `task_z`, `task_aa`, ... -- neutral, and
/// nothing about the card in them.
function optionKey(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `task_${s}`;
}

/// A Fisher-Yates permutation of 0..n-1.
function shuffledOrder(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/// The body of one request, exactly as it goes on the wire, and the map
/// from the keys it issued back to the cards -- kept OUT of the request,
/// because the whole point of a neutral key is that only this side knows
/// what it stands for.
///
/// `order` is the shuffle, injectable so a test can pin it; the default
/// draws a fresh permutation per request, so the same card is not always
/// `task_a`.
export function attributionRequest(
  change: { path: string; diff: string },
  options: readonly AttributionOption[],
  order: (n: number) => number[] = shuffledOrder
): { request: AttributionRequest; cardByKey: Record<string, string> } {
  const criteria: AttributionRequest["questions"]["owner"]["criteria"] = {};
  const cardByKey: Record<string, string> = {};
  order(options.length).forEach((optionIndex, keyIndex) => {
    const option = options[optionIndex];
    const key = optionKey(keyIndex);
    criteria[key] = option.description
      ? { title: option.title, description: option.description }
      : { title: option.title };
    cardByKey[key] = option.path;
  });
  criteria.none = NONE_CRITERION;
  return {
    request: {
      model: TYPESAFE_MODEL,
      state: { change: { path: change.path, diff: change.diff } },
      questions: { owner: { type: "choice", instructions: ATTRIBUTION_INSTRUCTIONS, criteria } },
    },
    cardByKey,
  };
}

// ---- The answer -------------------------------------------------------------------

/// The model's raw answer: the card it chose (null for `none`) and how
/// concentrated its distribution was. Kept whole, before any policy.
export interface AttributionAnswer {
  card: string | null;
  confidence: number;
}

/// The response, or null if it is not one this build can read. A key
/// this side never issued is a refusal rather than a guess, on
/// `parseVerdictAnswers`'s principle.
export function parseAttributionAnswer(
  body: unknown,
  cardByKey: Record<string, string>
): AttributionAnswer | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return null;
  const owner = (answers as Record<string, unknown>).owner;
  if (!owner || typeof owner !== "object") return null;
  const { choice, confidence } = owner as Record<string, unknown>;
  if (typeof choice !== "string") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (choice === "none") return { card: null, confidence };
  const card = cardByKey[choice];
  return card === undefined ? null : { card, confidence };
}

/// What one file's row is told. `unattributed` is today's answer and the
/// value of every failure; `card` carries the title so a surface can
/// name it without a second lookup against a board that may have moved.
export type FileAttribution =
  | { kind: "card"; card: string; title: string; confidence: number }
  | { kind: "unattributed" };

export const UNATTRIBUTED: FileAttribution = { kind: "unattributed" };

/// Root-relative path -> what it looks like.
export type RunAttribution = Readonly<Record<string, FileAttribution>>;

/// The policy, in one place: a file is somebody's only when the model
/// named a card this side still knows the title of, at or above the
/// floor. `none`, a low confidence, a failed request and a vanished card
/// are all the same unattributed.
export function readAttribution(
  answer: AttributionAnswer | null,
  titles: ReadonlyMap<string, string>
): FileAttribution {
  if (!answer || answer.card === null) return UNATTRIBUTED;
  if (answer.confidence < ATTRIBUTION_MIN_CONFIDENCE) return UNATTRIBUTED;
  const title = titles.get(answer.card);
  if (title === undefined) return UNATTRIBUTED;
  return { kind: "card", card: answer.card, title, confidence: answer.confidence };
}

// ---- Whether to ask at all -------------------------------------------------------

export type AttributionPlan =
  | { ask: false; reason: string }
  | { ask: true; peers: CardSession[]; files: FileEntry[] };

/// The whole decision, before any I/O: whom to offer and which files to
/// ask about. `ask: false` is the ordinary case for a run alone in its
/// worktree, and it sends nothing.
export function attributionPlan(
  run: AttributedRun,
  bindings: readonly CardSession[],
  files: readonly FileEntry[]
): AttributionPlan {
  const peers = coTenants(run, bindings);
  if (peers.length === 0) {
    return { ask: false, reason: "No other card has run in this checkout, so every change here is this run's." };
  }
  const asked = files.filter((f) => excerptSkipReason(f.path) === null).slice(0, MAX_FILES_PER_RUN);
  if (asked.length === 0) {
    return { ask: false, reason: "None of this run's files has a diff worth asking about." };
  }
  return { ask: true, peers, files: asked };
}

// ---- What the consumers say ----------------------------------------------------------

export interface ForeignGroup {
  card: string;
  title: string;
  paths: string[];
}

/// The files in this run's list that look like ANOTHER card's, by that
/// card, biggest group first. What the Changes view chips, the summary
/// counts and the discard prompt names.
export function foreignFiles(
  attribution: RunAttribution | null | undefined,
  selfCard: string
): ForeignGroup[] {
  if (!attribution) return [];
  const groups = new Map<string, ForeignGroup>();
  for (const [path, entry] of Object.entries(attribution)) {
    if (entry.kind !== "card" || entry.card === selfCard) continue;
    const group = groups.get(entry.card);
    if (group) group.paths.push(path);
    else groups.set(entry.card, { card: entry.card, title: entry.title, paths: [path] });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, paths: [...g.paths].sort() }))
    .sort((a, b) => b.paths.length - a.paths.length || a.title.localeCompare(b.title));
}

/// How many file names a sentence lists before it starts counting --
/// the same eight `discardPrompt` allows a line.
const MAX_LISTED = 8;

/// The discard prompt's line for one card's share: "3 of these look like
/// <card>'s work: a.ts, b.ts, c.ts".
export function foreignLine(group: ForeignGroup): string {
  const shown = group.paths.slice(0, MAX_LISTED);
  const rest = group.paths.length - shown.length;
  const n = group.paths.length;
  return `${n} of these ${n === 1 ? "looks" : "look"} like ${group.title}'s work: ${shown.join(", ")}${
    rest > 0 ? `, and ${rest} more` : ""
  }`;
}
