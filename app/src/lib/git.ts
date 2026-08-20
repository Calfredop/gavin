// Types crossing from app/src-tauri/src/git/types.rs (serde camelCase) and
// the small pure helpers the Git tab's components share.

export type FileStatus = "M" | "A" | "D" | "R" | "C" | "?" | "U";
export type Area = "unstaged" | "staged";
export type LineKind = "context" | "add" | "del";
export type DiffLayout = "unified" | "split";
export type ApplyMode = "stage" | "unstage" | "discard";

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
}

export interface StatusResult {
  unstaged: FileEntry[];
  staged: FileEntry[];
}

export interface Line {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewline?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Line[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  binary: boolean;
  tooLarge: boolean;
  hunks: Hunk[];
}

export interface Author {
  name: string;
  email: string;
}

export interface RepoInfo {
  notARepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  author: Author | null;
  headMessage: string | null;
  inProgress: "merge" | "rebase" | null;
}

// ---- SP2/SP3: refs snapshot ------------------------------------------------

export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  sha: string;
  subject: string;
}

export interface RemoteInfo {
  name: string;
  url: string;
  branches: string[];
}

export interface StashInfo {
  index: number;
  message: string;
  date: string;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface RefsSnapshot {
  branches: BranchInfo[];
  remotes: RemoteInfo[];
  stashes: StashInfo[];
  worktrees: WorktreeInfo[];
  headBranch: string | null;
}

export type NavSelection = "changes" | { stash: number };
export type InProgressKind = "merge" | "rebase";

/// Hunks longer than this render collapsed (spec §3).
export const LARGE_HUNK_LINES = 500;
/// Per-list display cap (spec §1).
export const LIST_DISPLAY_CAP = 1000;

// Selection ids are "<hunkIndex>:<lineIndex>" — layout-independent, so a
// selection survives switching unified <-> split (spec §3).
export function lineId(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

export function parseLineId(id: string): { hunk: number; line: number } {
  const [h, l] = id.split(":");
  return { hunk: Number(h), line: Number(l) };
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function branchLabel(repo: RepoInfo): string {
  const name = repo.branch ?? "HEAD";
  if (repo.detached) return `${name} · detached`;
  if (repo.unborn) return `${name} (no commits)`;
  return name;
}

export function changedCount(status: StatusResult | null): number {
  if (!status) return 0;
  const paths = new Set<string>();
  for (const e of status.unstaged) paths.add(e.path);
  for (const e of status.staged) paths.add(e.path);
  return paths.size;
}

// ---- SP3: worktrees --------------------------------------------------------

/// Default fork location (G11): a sibling of the repo named
/// `<repo>-<branch>`, with `/` in the branch flattened to `-`.
export function defaultWorktreePath(root: string, branch: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  const parent = i <= 0 ? "" : trimmed.slice(0, i);
  const name = trimmed.slice(i + 1);
  return `${parent}/${name}-${branch.replace(/\//g, "-")}`;
}

/// A subset of git-check-ref-format, enough to catch typos before git does.
export function validateBranchName(name: string): string | null {
  if (!name.trim()) return "Branch name is required";
  if (/\s/.test(name)) return "No spaces allowed";
  if (name.includes("..")) return "'..' is not allowed";
  if (name.startsWith("-")) return "Cannot start with '-'";
  if (name.endsWith(".lock")) return "Cannot end with '.lock'";
  if (/[~^:?*\[\\]/.test(name) || name.includes("@{")) return "Contains a forbidden character (~ ^ : ? * [ \\ @{)";
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return "Cannot start or end with '/' or end with '.'";
  return null;
}
