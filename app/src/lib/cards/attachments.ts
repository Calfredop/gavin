// Card attachments: the `attachments:` frontmatter line, the chips the
// UI draws from it, and the block it becomes inside an agent's prompt.
//
// Pure and unit-tested, so the two `.svelte` surfaces that own the
// gesture (the card detail modal and the ⌘N composer) stay templates.
// Everything here works on the RAW strings the daemon parsed out of the
// file -- relative inside the workspace root, absolute outside it -- and
// resolving them to real files is the Tauri host's job
// (`backend.attachmentStatus`), because only it can stat.

import { relativeToRoot } from "$lib/core/settings";

/// Where the host resolved and canonicalized an entry to. `"root"` and
/// `"extraContext"` are what gavin already trusts and reads exactly as
/// before. `"outside"` is a legal reference -- a screenshot on the
/// Desktop, a spec on a shared volume -- that is no longer read
/// silently: see `resolvedAttachmentPaths` / `withheldAttachmentPaths`.
/// `"refused"` is neither: a `..` traversal or a path under a directory
/// gavin never hands an agent (`~/Library`, `~/.ssh`, `~/.aws`,
/// `~/.config`), which no future confirmation can unlock.
export type AttachmentLocation = "root" | "extraContext" | "outside" | "refused";

/// One entry as the host resolved it. `absolutePath` is null only for a
/// `"refused"` entry -- gavin will not resolve it at all, which reads
/// the same as a file that moved: a broken chip, and a blocked run.
/// `refusedReason` names why, for exactly those entries; null otherwise.
export interface AttachmentStatus {
  path: string;
  absolutePath: string | null;
  exists: boolean;
  location: AttachmentLocation;
  refusedReason: string | null;
  /// The file's size in bytes, or null when gavin never stat'd it (a
  /// refused entry, or one whose path resolves to nothing). Read for the
  /// first-Run review sheet (`cardReview.ts`), which has to say how much
  /// a card is about to put in an agent's context -- "read this file"
  /// means something different for a 2 KB spec and a 40 MB log. Optional
  /// so a status object built by a test fixture, or returned by a host
  /// older than the field, still type-checks as one.
  sizeBytes?: number | null;
}

/// Splits the frontmatter line exactly as the daemon does
/// (`plan_file_info`): commas, trimmed, empties dropped. Kept in step
/// with that parser deliberately -- a card written by the composer and a
/// card read back off disk must produce the same chips.
export function parseAttachments(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

/// The line to write back. `set_plan_field` clears the whole line on an
/// empty value, which is what an empty list has to become: an
/// `attachments:` line with nothing after it is a card that still reads
/// as though it references a file.
export function formatAttachments(paths: string[]): string {
  return paths.join(", ");
}

/// Append unless it is already there. Duplicates are not an error worth
/// a message -- picking the same file twice is a slip, and the second
/// pick simply lands on the chip that already exists.
export function addAttachment(paths: string[], path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed || paths.includes(trimmed)) return paths;
  return [...paths, trimmed];
}

export function removeAttachment(paths: string[], path: string): string[] {
  return paths.filter((p) => p !== path);
}

/// What the OS dialog's absolute path is STORED as. Inside the workspace
/// root it becomes relative, so the card survives a clone into another
/// checkout -- and so a rail's worktree reads the worktree's copy rather
/// than reaching back into the original. Outside the root it stays
/// absolute, because there is nothing to be relative to: a screenshot on
/// the Desktop has no portable form.
///
/// `relativeToRoot` is the same function both config pickers use; the
/// only difference here is that its "outside the root" refusal is a
/// legal answer rather than an error.
export function attachmentFromPick(root: string, picked: string): string {
  const relative = relativeToRoot(root, picked);
  return "error" in relative ? picked : relative.path;
}

/// The chip's label: the file name alone. The full path is the chip's
/// tooltip -- a row of chips reading `docs/…/spec.md` truncated from the
/// left tells the human nothing that the name doesn't.
export function attachmentName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/// The block appended to a launched agent's prompt. `readablePaths` are
/// absolute, one per line, and are what the agent is told to read: the
/// agent's cwd is a rail's worktree or the card's context folder
/// depending on how it was launched, and a relative path would mean
/// something different in each. `withheldPaths` are the raw card entries
/// gavin resolved to a real, existing file OUTSIDE the workspace and did
/// NOT hand over -- named so the agent (and a human reading the prompt)
/// knows the card referenced them, without gavin having read them on
/// anyone's behalf. Empty string for no attachments at all, so the
/// composers can concatenate unconditionally.
export function attachmentPromptBlock(
  readablePaths: string[],
  withheldPaths: string[] = []
): string {
  if (readablePaths.length === 0 && withheldPaths.length === 0) return "";
  const sections: string[] = [];
  if (readablePaths.length > 0) {
    const list = readablePaths.map((p) => `- ${p}`).join("\n");
    sections.push(`Files attached to this card — read them before you start:\n${list}`);
  }
  if (withheldPaths.length > 0) {
    const list = withheldPaths.map((p) => `- ${p}`).join("\n");
    sections.push(
      `This card also names these files, but they live outside the workspace and gavin ` +
        `withheld them rather than read them automatically — it has not read them, and you ` +
        `should not assume they say what the card implies:\n${list}`
    );
  }
  return `\n\n${sections.join("\n\n")}`;
}

/// The absolute paths to hand an agent, in card order: entries the host
/// classified `root` or `extraContext` -- what gavin already trusts.
/// `outside` entries resolve to a real file too, but are withheld here
/// on purpose (`withheldAttachmentPaths` names them instead); `refused`
/// entries never got an absolute path at all. Everything not `exists`
/// is dropped, which is safe only because `missingAttachmentReason`
/// refuses the launch first.
export function resolvedAttachmentPaths(statuses: AttachmentStatus[]): string[] {
  return statuses
    .filter((s) => s.exists && s.absolutePath !== null && s.location !== "outside")
    .map((s) => s.absolutePath as string);
}

/// The raw card entries gavin resolved to a real file OUTSIDE the
/// workspace (or a registered extra context) and is withholding rather
/// than reading. The raw text, not the absolute path: it is what the
/// card actually says, and is what the first-Run review will list this
/// entry by once that confirmation exists (`sec-fix-first-run-review`).
export function withheldAttachmentPaths(statuses: AttachmentStatus[]): string[] {
  return statuses.filter((s) => s.exists && s.location === "outside").map((s) => s.path);
}

/// Why this card must not be launched, or null. A missing file and a
/// `refused` entry (a `..` traversal, or a path under a directory gavin
/// never hands an agent) both block the run -- board Run and rail step
/// alike -- rather than launching without it: an agent handed a dead
/// path burns a whole session before anyone notices, and the card is the
/// cheap thing to fix. The two get separate messages: a missing file is
/// a typo to go fix, a refused one never will be, confirmation included.
export function missingAttachmentReason(statuses: AttachmentStatus[]): string | null {
  const refused = statuses.filter((s) => s.location === "refused");
  if (refused.length > 0) {
    const noun = refused.length === 1 ? "Attachment" : "Attachments";
    const detail = refused.map((s) => `${s.path} (${s.refusedReason})`).join(", ");
    return `${noun} refused: ${detail} — fix or remove ${
      refused.length === 1 ? "it" : "them"
    } on the card before running.`;
  }
  const missing = statuses.filter((s) => !s.exists).map((s) => s.path);
  if (missing.length === 0) return null;
  const noun = missing.length === 1 ? "Attachment" : "Attachments";
  return `${noun} not found: ${missing.join(", ")} — fix or remove ${
    missing.length === 1 ? "it" : "them"
  } on the card before running.`;
}
