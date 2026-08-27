// Card attachments: the `attachments:` frontmatter line, the chips the
// UI draws from it, and the block it becomes inside an agent's prompt.
//
// Pure and unit-tested, so the two `.svelte` surfaces that own the
// gesture (the card detail modal and the ⌘N composer) stay templates.
// Everything here works on the RAW strings the daemon parsed out of the
// file -- relative inside the workspace root, absolute outside it -- and
// resolving them to real files is the Tauri host's job
// (`backend.attachmentStatus`), because only it can stat.

import { relativeToRoot } from "./settings";

/// One entry as the host resolved it. `absolutePath` is null when gavin
/// refuses to resolve the entry at all (a `..` traversal), which reads
/// the same as a file that moved: a broken chip, and a blocked run.
export interface AttachmentStatus {
  path: string;
  absolutePath: string | null;
  exists: boolean;
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

/// The block appended to a launched agent's prompt. Absolute paths, one
/// per line: the agent's cwd is a rail's worktree or the card's context
/// folder depending on how it was launched, and a relative path would
/// mean something different in each. Empty string for no attachments, so
/// the composers can concatenate unconditionally.
export function attachmentPromptBlock(absolutePaths: string[]): string {
  if (absolutePaths.length === 0) return "";
  const list = absolutePaths.map((p) => `- ${p}`).join("\n");
  return (
    `\n\nFiles attached to this card — read them before you start:\n${list}`
  );
}

/// The absolute paths to hand an agent, in card order. Entries the host
/// could not resolve are dropped, which is safe only because
/// `missingAttachmentReason` refuses the launch first.
export function resolvedAttachmentPaths(statuses: AttachmentStatus[]): string[] {
  return statuses
    .filter((s) => s.exists && s.absolutePath !== null)
    .map((s) => s.absolutePath as string);
}

/// Why this card must not be launched, or null. A missing attachment
/// blocks the run -- board Run and rail step alike -- rather than
/// launching without it: an agent handed a dead path burns a whole
/// session before anyone notices, and the card is the cheap thing to
/// fix. Names the files, because "an attachment is missing" sends the
/// human back to the card to work out which.
export function missingAttachmentReason(statuses: AttachmentStatus[]): string | null {
  const missing = statuses.filter((s) => !s.exists).map((s) => s.path);
  if (missing.length === 0) return null;
  const noun = missing.length === 1 ? "Attachment" : "Attachments";
  return `${noun} not found: ${missing.join(", ")} — fix or remove ${
    missing.length === 1 ? "it" : "them"
  } on the card before running.`;
}
