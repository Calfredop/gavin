/// The first-Run review (security report R2, findings AG-01/AG-02): what
/// a human is shown before a card's content reaches an agent, and the
/// marker that records they were shown it.
///
/// A card's body IS the prompt. `composeTaskPrompt` inlines it verbatim,
/// a plan agent is told to go and read the file, a rail step and the
/// workspace's main agent get the same bytes — and the board card shows
/// the TITLE and nothing else. `.gavin-root/plans/*.md` ships with the
/// repository, so a clone from anywhere arrives with cards whose
/// frontmatter puts an innocuous title on the board and whose body is an
/// instruction to an agent that runs unsandboxed as the human. The
/// `attachments:` line rides along, naming files to read before starting,
/// and the auto-commit block is fenced in HTML comments so a plan card's
/// rendered preview shows it as nothing at all.
///
/// gavin's accepted design trusts the Run click on a card the human
/// WROTE. It explicitly does not trust a cloned repo's cards reaching an
/// agent on that same click, and until this module existed the two were
/// one code path with no provenance.
///
/// So: once per card, before the first launch, show exactly what the
/// agent will receive and require a deliberate yes. Never again for that
/// content — a gate that asks on every Run is a gate that gets clicked
/// through.
///
/// Sibling of `workspaceTrust.ts` in every structural respect (a digest
/// of the values, stored per workspace in config.json, re-stamped by
/// gavin's own writers so a human's own edits never trip it), because it
/// is the same question one level down: config.toml names what gavin
/// runs, a card body names what an AGENT runs.

import { sha256Hex } from "$lib/core/sha256";
import { hasAutoCommit } from "$lib/git/autoCommit";
import type { AttachmentStatus } from "$lib/cards/attachments";

/// The repo-controlled content of one card: everything a launch takes
/// from the card FILE and hands to an agent.
///
/// Deliberately not the composed prompt, though the panel shows that.
/// The prompt also carries gavin's own framing — the tab-naming line, the
/// status instruction, the decoy note a rail's worktree earns — and that
/// framing differs by route: a board Run, a rail step in a worktree and a
/// resume produce three different strings for one unchanged card. Hashing
/// the whole prompt would ask the human again for each of them, teaching
/// exactly the reflex click this gate cannot afford. What a human is
/// being asked to vouch for is the part the repository wrote, and that is
/// this.
export interface CardContent {
  title: string;
  /// The body as it sits on disk, frontmatter stripped and trimmed —
  /// HTML comments, auto-commit block and all. Never a rendered or
  /// sanitised form: a comment markdown draws as nothing is precisely
  /// what this exists to put in front of a person.
  body: string;
  /// The `attachments:` entries, raw, in card order.
  attachments: string[];
}

/// A version-tagged digest of exactly that content.
///
/// Over a JSON encoding rather than a joined string so no value can
/// impersonate the delimiter — a body containing the separator would
/// otherwise hash the same as a different title/body split. Version
/// tagged so that widening `CardContent` later cannot silently collide
/// with a marker approved under today's fields.
///
/// The attachments' RESOLUTION is not in here, and does not need to be:
/// where an entry lands is a function of its own text and the workspace
/// root, so an entry that reads the same resolves the same. The one way
/// that can shift under a fixed root is a symlink inside the root being
/// re-pointed outside it — which makes gavin strictly more cautious (an
/// `outside` attachment is withheld, not read), never less.
export function cardContentDigest(content: CardContent): string {
  return sha256Hex(
    `gavin-card-review/1\n${JSON.stringify({
      title: content.title,
      body: content.body,
      attachments: content.attachments,
    })}`
  );
}

/// Whether this exact content is what the human reviewed for this card.
///
/// Fails CLOSED in every uncertain case: no marker, a marker from
/// different content, an empty string. There is no "nothing to review"
/// shortcut of the kind `configTrusted` has — a card with an empty body
/// and no attachments still carries a title the agent is handed, and more
/// to the point a shortcut here would be a shape a hostile card could aim
/// for.
export function cardContentReviewed(
  content: CardContent,
  approvedDigest: string | null | undefined
): boolean {
  const approved = (approvedDigest ?? "").trim();
  return approved !== "" && approved === cardContentDigest(content);
}

/// Whether the gate above applies at all: a workspace's own choice, else
/// the app-wide one, else gavin's default (require it) -- the security
/// round's original always-on behaviour. Same three-level shape as
/// `resolveAutoCommit`, and deliberately separate from
/// `cardContentReviewed`: that predicate stays a pure "was THIS content
/// approved" question with no shortcut, and this is the layer above it
/// that decides whether the question is even being asked. `cardReviewed`
/// (layoutState.ts) is the one place that combines the two, so every
/// launch, the rail stall and the card detail banner agree.
export const DEFAULT_REQUIRE_REVIEW = true;

/// A stored setting, or null for "nothing chosen here" -- what both an
/// absent value and an unusable one mean. Null rather than the default so
/// a workspace with no setting of its own still falls through to the
/// app-wide one instead of jumping straight past it.
export function normalizeRequireReview(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function resolveRequireReview(workspaceValue: unknown, appValue: unknown): boolean {
  return (
    normalizeRequireReview(workspaceValue) ??
    normalizeRequireReview(appValue) ??
    DEFAULT_REQUIRE_REVIEW
  );
}

/// The `<select>` vocabulary, matching `autoCommitOptions`'s shape: "" is
/// the inherit row, and every writer reads it as "clear my override".
export const REQUIRE_REVIEW_INHERIT = "";
export const REQUIRE_REVIEW_ON = "on";
export const REQUIRE_REVIEW_OFF = "off";

export function requireReviewFromSelect(value: string): boolean | null {
  if (value === REQUIRE_REVIEW_ON) return true;
  if (value === REQUIRE_REVIEW_OFF) return false;
  return null;
}

export function requireReviewToSelect(value: unknown): string {
  const normalized = normalizeRequireReview(value);
  if (normalized === null) return REQUIRE_REVIEW_INHERIT;
  return normalized ? REQUIRE_REVIEW_ON : REQUIRE_REVIEW_OFF;
}

export interface RequireReviewOption {
  value: string;
  label: string;
}

export function requireReviewOptions(inherited: boolean): RequireReviewOption[] {
  return [
    { value: REQUIRE_REVIEW_INHERIT, label: `Default (${inherited ? "on" : "off"})` },
    { value: REQUIRE_REVIEW_ON, label: "On" },
    { value: REQUIRE_REVIEW_OFF, label: "Off" },
  ];
}

/// One attachment as the review sheet names it. Everything here is what
/// gavin RESOLVED, not what the card said: the card says `../../x` or
/// `/Users/you/.ssh/id_rsa`, and the reader needs to know where that
/// actually landed and how big it is before agreeing an agent may read
/// it.
export interface ReviewedAttachment {
  /// The raw frontmatter entry — what the card says, verbatim.
  path: string;
  /// Where gavin resolved it to, or null for a refused entry.
  absolutePath: string | null;
  /// Size in bytes, or null when gavin did not stat it (a refused or
  /// missing entry).
  sizeBytes: number | null;
  location: AttachmentStatus["location"];
  exists: boolean;
}

export function reviewedAttachments(statuses: readonly AttachmentStatus[]): ReviewedAttachment[] {
  return statuses.map((s) => ({
    path: s.path,
    absolutePath: s.absolutePath,
    sizeBytes: s.sizeBytes ?? null,
    location: s.location,
    exists: s.exists,
  }));
}

/// A size a person can weigh at a glance. Binary units, because the
/// question this answers is "is that the spec, or is it the whole
/// database" and nobody resolves it on three significant figures.
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/// Where an attachment lies, in the words the sheet uses. The point of
/// the line: `root` and `extraContext` are places gavin already reads
/// from, `outside` is a file on this machine that the card reached for
/// and gavin is holding back, `refused` is one it will not resolve at
/// all.
export function locationNote(item: ReviewedAttachment): string {
  switch (item.location) {
    case "root":
      return "inside the workspace";
    case "extraContext":
      return "in a registered extra context";
    case "outside":
      return "OUTSIDE the workspace — named to the agent, not read";
    case "refused":
      return "refused — gavin will not resolve this path";
  }
}

/// One line per attachment: what the card asked for, where it landed,
/// how big it is. The absolute path is shown whenever it differs from the
/// raw entry, because a relative entry and a symlink both hide where the
/// bytes actually come from, and that is the whole question.
export function attachmentReviewLine(item: ReviewedAttachment): string {
  const where = item.absolutePath && item.absolutePath !== item.path ? ` → ${item.absolutePath}` : "";
  const size = item.exists ? formatBytes(item.sizeBytes) : "not found";
  return `${item.path}${where} — ${size}, ${locationNote(item)}`;
}

/// The sheet's consequence lines: what this card is about to do beyond
/// the prompt text itself.
///
/// The auto-commit line exists because that block is the one instruction
/// a human can read a card and still miss. It is fenced in HTML comments,
/// so a plan card's rendered preview draws it as nothing — and it tells
/// the agent to commit. Named here in plain words, above the prompt the
/// reader may skim.
export function reviewLines(
  content: CardContent,
  attachments: readonly ReviewedAttachment[]
): string[] {
  const lines: string[] = [];
  lines.push(
    "This card came with the repository. Its body is the prompt, and the board only ever showed you its title."
  );
  if (hasAutoCommit(content.body)) {
    lines.push("It carries the auto-commit block: the agent is told to commit its work when it is done.");
  }
  if (attachments.length === 0) {
    lines.push("No attachments.");
  } else {
    lines.push(attachments.length === 1 ? "It attaches 1 file:" : `It attaches ${attachments.length} files:`);
    for (const item of attachments) lines.push(`  ${attachmentReviewLine(item)}`);
  }
  lines.push("Read the whole prompt below before you run it — it is what the agent receives, verbatim.");
  return lines;
}

/// The sheet's heading. Names the card, because a human who pressed Run
/// on a board of twenty needs to know which one is asking.
export function reviewTitle(title: string): string {
  return `Run “${title}”? Read what the agent will receive`;
}

/// The button. Names the action, never "OK": after a mis-click that
/// label is the only record of what was agreed to.
export const REVIEW_CONFIRM_LABEL = "Run this";
export const REVIEW_CANCEL_LABEL = "Don't run";

/// What an UNATTENDED launch says instead of asking. Auto-resume runs
/// with nobody watching — a modal raised from it would sit unanswered
/// behind whatever window is in front, holding a recovery the human never
/// asked to supervise. So an unreviewed card refuses there and says where
/// the answer lives.
///
/// It only ever fires when the card's content CHANGED since the human
/// approved it: an automatic resume is by definition continuing a run
/// that was approved to start.
export const UNREVIEWED_UNATTENDED =
  "this card's content has changed since you last read it — open the card and review it before " +
  "gavin resumes on its own";

/// The stall a rail step takes instead of launching an unreviewed card.
///
/// A constant rather than a sentence composed at the call site, because
/// `stepAttentions` matches on it to mark the step: the reason string is
/// the only thing a stalled run row carries, and adding a field to
/// `StepRun` would be a protocol bump for a fact the app already knows.
/// Both sides import this, so the two can never drift.
export const UNREVIEWED_STALL =
  "this card has not been reviewed — open it and read what the agent would receive";

/// The rail's own refusal, naming the card. `UNREVIEWED_STALL` is the
/// part that identifies it; the title is what makes the chip readable.
export function unreviewedStallReason(title: string): string {
  return `${UNREVIEWED_STALL} (“${title}”)`;
}

/// Whether a stalled step's recorded reason is this gate. Prefix rather
/// than equality, so `unreviewedStallReason`'s title suffix still
/// matches — and so a row written by an older build, which stored the
/// bare constant, still reads as the same wait.
export function isUnreviewedStall(reason: string | null | undefined): boolean {
  return (reason ?? "").startsWith(UNREVIEWED_STALL);
}
