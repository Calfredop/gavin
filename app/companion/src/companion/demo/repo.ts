// A Git repository, as small as the Demo Workstation needs one to be.
//
// Enough of git that the Git surface can do everything on it that it does
// on a real Workstation -- status, diffs, staging, commits, branches, a
// merge, a push -- with the answers a real host would give, refusals
// included. Its working tree is the demo's own files (`DemoState.files`),
// so a file edited in the Files surface is a change in the Git one, the
// way it is on a machine.
//
// What it leaves out it leaves out loudly: a merge whose two sides touch
// the same file is refused rather than half-done, because a conflict is a
// state the demo would then have to carry through a resolution it has no
// way to offer.
import type {
  Author,
  BranchInfo,
  FileDiff,
  FileEntry,
  RefsSnapshot,
  RepoInfo,
  StatusResult,
} from "$lib/git/git";
import { validateBranchName } from "$lib/git/git";
import type { GitStatus } from "$lib/core/workspace";
import { DemoFailure } from "$companion/demo/answer";
import { lineDiff } from "$companion/demo/lineDiff";

/// Every file of one snapshot, by path from the repository's root.
export type Tree = Record<string, string>;

export interface DemoCommit {
  sha: string;
  parents: string[];
  /// The whole message: subject, then a blank line and the body if any.
  message: string;
  tree: Tree;
}

export interface DemoRemote {
  name: string;
  url: string;
  /// Where each of its branches points, by name without the remote.
  branches: Record<string, string>;
}

export interface DemoRepo {
  root: string;
  author: Author;
  commits: Record<string, DemoCommit>;
  /// Local branches, by name, to the commit each points at.
  branches: Record<string, string>;
  /// Each local branch's upstream, as `<remote>/<branch>`.
  upstreams: Record<string, string>;
  /// The branch checked out. The demo never detaches.
  head: string;
  /// The staged snapshot: what the next commit records.
  index: Tree;
  remote: DemoRemote;
}

/// What a mutation printed that a human watching it would read: git's
/// progress on stderr, which the host streams as `git-op-progress`.
export type Progress = string[];

// ---- Paths and snapshots ---------------------------------------------------

/// The repository-relative path of `path`, or null when it is outside.
export function relativeTo(root: string, path: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

/// Whether `path` is the repository's root or anywhere under it.
export function contains(repo: DemoRepo, path: string): boolean {
  return path === repo.root || relativeTo(repo.root, path) !== null;
}

/// The working tree: the demo's files that are under this root.
export function workingTree(repo: DemoRepo, files: Record<string, string>): Tree {
  const tree: Tree = {};
  for (const [path, content] of Object.entries(files)) {
    const rel = relativeTo(repo.root, path);
    if (rel !== null) tree[rel] = content;
  }
  return tree;
}

function absolute(repo: DemoRepo, rel: string): string {
  return `${repo.root}/${rel}`;
}

/// Writes one path of the working tree, or removes it.
function writeWorking(repo: DemoRepo, files: Record<string, string>, rel: string, content: string | undefined): void {
  if (content === undefined) delete files[absolute(repo, rel)];
  else files[absolute(repo, rel)] = content;
}

export function headSha(repo: DemoRepo): string {
  return repo.branches[repo.head];
}

function headTree(repo: DemoRepo): Tree {
  return repo.commits[headSha(repo)].tree;
}

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}

function pathsOf(...trees: Tree[]): string[] {
  return [...new Set(trees.flatMap((t) => Object.keys(t)))].sort();
}

/// A new commit's id: forty hex digits, the same for the same history,
/// so a suite can name what it expects.
function nextSha(repo: DemoRepo, message: string, parents: string[]): string {
  let out = "";
  for (let salt = 0; out.length < 40; salt++) {
    // FNV-1a over the salt, the parents and the message.
    let h = 0x811c9dc5;
    for (const ch of `${salt}:${parents.join(",")}:${message}:${Object.keys(repo.commits).length}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

// ---- History ---------------------------------------------------------------

/// Every commit reachable from `sha`, itself included.
function ancestry(repo: DemoRepo, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [sha];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next) || !repo.commits[next]) continue;
    seen.add(next);
    queue.push(...repo.commits[next].parents);
  }
  return seen;
}

function isAncestor(repo: DemoRepo, maybe: string, of: string): boolean {
  return ancestry(repo, of).has(maybe);
}

/// The nearest commit both sides descend from.
function mergeBase(repo: DemoRepo, ours: string, theirs: string): string | null {
  const mine = ancestry(repo, ours);
  const queue = [theirs];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (mine.has(next)) return next;
    if (seen.has(next) || !repo.commits[next]) continue;
    seen.add(next);
    queue.push(...repo.commits[next].parents);
  }
  return null;
}

function aheadBehind(repo: DemoRepo, local: string, upstream: string): { ahead: number; behind: number } {
  const mine = ancestry(repo, local);
  const theirs = ancestry(repo, upstream);
  return {
    ahead: [...mine].filter((sha) => !theirs.has(sha)).length,
    behind: [...theirs].filter((sha) => !mine.has(sha)).length,
  };
}

/// A branch, a remote branch (`origin/x`) or a commit id, as git would
/// resolve the name; null when it names nothing.
function resolve(repo: DemoRepo, name: string): string | null {
  if (repo.branches[name]) return repo.branches[name];
  const prefix = `${repo.remote.name}/`;
  if (name.startsWith(prefix) && repo.remote.branches[name.slice(prefix.length)]) {
    return repo.remote.branches[name.slice(prefix.length)];
  }
  return repo.commits[name] ? name : null;
}

// ---- Reading ---------------------------------------------------------------

export function repoInfo(repo: DemoRepo): RepoInfo {
  return {
    notARepo: false,
    root: repo.root,
    branch: repo.head,
    detached: false,
    unborn: false,
    author: { ...repo.author },
    headMessage: repo.commits[headSha(repo)].message,
    inProgress: null,
  };
}

/// What `git status` sees: the index against HEAD, and the working tree
/// against the index, where a file the index has never held is untracked.
export function status(repo: DemoRepo, files: Record<string, string>): StatusResult {
  const head = headTree(repo);
  const index = repo.index;
  const work = workingTree(repo, files);
  const staged: FileEntry[] = [];
  for (const path of pathsOf(head, index)) {
    if (head[path] === index[path]) continue;
    staged.push({ path, status: head[path] === undefined ? "A" : index[path] === undefined ? "D" : "M" });
  }
  const unstaged: FileEntry[] = [];
  for (const path of pathsOf(index, work)) {
    if (index[path] === work[path]) continue;
    unstaged.push({ path, status: index[path] === undefined ? "?" : work[path] === undefined ? "D" : "M" });
  }
  return { unstaged, staged };
}

export function refs(repo: DemoRepo): RefsSnapshot {
  const remote = repo.remote;
  const branches: BranchInfo[] = Object.keys(repo.branches)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sha = repo.branches[name];
      const upstream = repo.upstreams[name] ?? null;
      const upstreamSha = upstream ? remote.branches[upstream.slice(remote.name.length + 1)] : undefined;
      const { ahead, behind } = upstreamSha ? aheadBehind(repo, sha, upstreamSha) : { ahead: 0, behind: 0 };
      return {
        name,
        current: name === repo.head,
        upstream,
        ahead,
        behind,
        sha,
        subject: subjectOf(repo.commits[sha].message),
      };
    });
  return {
    branches,
    remotes: [{ name: remote.name, url: remote.url, branches: Object.keys(remote.branches).sort() }],
    stashes: [],
    worktrees: [
      {
        path: repo.root,
        head: headSha(repo),
        branch: repo.head,
        isMain: true,
        locked: false,
        prunable: false,
      },
    ],
    headBranch: repo.head,
  };
}

/// What the sidebar's git chip says about the checkout a session sits in:
/// the host's `get_git_baselines` answer for one cwd.
export function chip(repo: DemoRepo, files: Record<string, string>): GitStatus {
  const branch = refs(repo).branches.find((b) => b.current);
  const changed = status(repo, files);
  return {
    repoRoot: repo.root,
    branch: repo.head,
    dirty: changed.staged.length + changed.unstaged.length > 0,
    ahead: branch?.ahead ?? 0,
    behind: branch?.behind ?? 0,
    hasUpstream: Boolean(branch?.upstream),
  };
}

/// Files a Workstation holds as bytes rather than text. The host reports
/// them as binary, which the diff view says in words.
const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|ico)$/i;

/// `git diff` for one path: the staged change, the unstaged one, an
/// untracked file whole, or what a commit (`rev`) changed.
export function diff(
  repo: DemoRepo,
  files: Record<string, string>,
  path: string,
  opts: { staged: boolean; untracked: boolean; rev: string | null }
): FileDiff {
  let before: string | undefined;
  let after: string | undefined;
  if (opts.rev !== null) {
    const commit = repo.commits[opts.rev];
    if (!commit) throw new DemoFailure(`fatal: bad revision '${opts.rev}'`);
    const parent = commit.parents[0] ? repo.commits[commit.parents[0]].tree : {};
    before = parent[path];
    after = commit.tree[path];
  } else if (opts.staged) {
    before = headTree(repo)[path];
    after = repo.index[path];
  } else {
    before = opts.untracked ? undefined : repo.index[path];
    after = workingTree(repo, files)[path];
  }
  if (BINARY.test(path)) return { path, binary: true, tooLarge: false, hunks: [] };
  return lineDiff(path, before ?? null, after ?? null);
}

// ---- Staging ---------------------------------------------------------------

function known(repo: DemoRepo, files: Record<string, string>, rel: string): boolean {
  return rel in workingTree(repo, files) || rel in repo.index || rel in headTree(repo);
}

export function stage(repo: DemoRepo, files: Record<string, string>, paths: string[]): void {
  const work = workingTree(repo, files);
  for (const path of paths) {
    if (!known(repo, files, path)) {
      throw new DemoFailure(`fatal: pathspec '${path}' did not match any files`);
    }
  }
  for (const path of paths) {
    if (path in work) repo.index[path] = work[path];
    else delete repo.index[path];
  }
}

export function unstage(repo: DemoRepo, paths: string[]): void {
  const head = headTree(repo);
  for (const path of paths) {
    if (path in head) repo.index[path] = head[path];
    else delete repo.index[path];
  }
}

export function stageAll(repo: DemoRepo, files: Record<string, string>): void {
  repo.index = workingTree(repo, files);
}

export function unstageAll(repo: DemoRepo): void {
  repo.index = { ...headTree(repo) };
}

// ---- Commits ---------------------------------------------------------------

function sameTree(a: Tree, b: Tree): boolean {
  return pathsOf(a, b).every((path) => a[path] === b[path]);
}

export function commit(repo: DemoRepo, message: string, amend: boolean): Progress {
  if (!message.trim()) throw new DemoFailure("Aborting commit due to empty commit message.");
  const head = repo.commits[headSha(repo)];
  if (!amend && sameTree(repo.index, head.tree)) {
    throw new DemoFailure("nothing added to commit but untracked files present (use \"git add\" to track)");
  }
  const parents = amend ? head.parents : [head.sha];
  const sha = nextSha(repo, message, parents);
  repo.commits[sha] = { sha, parents, message: message.trim(), tree: { ...repo.index } };
  repo.branches[repo.head] = sha;
  // git prints the summary on stdout; stderr, which is all a commit's op
  // streams, carries only what its hooks say -- and the demo has none.
  return [];
}

// ---- Moving between trees ----------------------------------------------------

/// Moves the index and the working tree from HEAD's snapshot to `target`,
/// carrying local changes across the way git does: a path nobody touched
/// takes the target's version, and a touched path is refused only when
/// the target would change it too. Nothing is written unless nothing is
/// refused.
function moveTo(repo: DemoRepo, files: Record<string, string>, target: Tree, verb: string): void {
  const head = headTree(repo);
  const work = workingTree(repo, files);
  const clobbered: string[] = [];
  const clean: string[] = [];
  for (const path of pathsOf(head, repo.index, work, target)) {
    const touched = repo.index[path] !== head[path] || work[path] !== repo.index[path];
    if (!touched) clean.push(path);
    else if (head[path] !== target[path]) clobbered.push(path);
  }
  if (clobbered.length > 0) {
    throw new DemoFailure(
      [
        `error: Your local changes to the following files would be overwritten by ${verb}:`,
        ...clobbered.map((path) => `\t${path}`),
        `Please commit your changes or stash them before you ${verb === "checkout" ? "switch branches" : "merge"}.`,
        "Aborting",
      ].join("\n")
    );
  }
  for (const path of clean) {
    if (target[path] === undefined) delete repo.index[path];
    else repo.index[path] = target[path];
    writeWorking(repo, files, path, target[path]);
  }
}

export function checkout(
  repo: DemoRepo,
  files: Record<string, string>,
  name: string,
  trackRemote: string | null
): Progress {
  if (trackRemote !== null) {
    if (trackRemote !== repo.remote.name || !repo.remote.branches[name]) {
      throw new DemoFailure(`fatal: '${trackRemote}/${name}' is not a commit and a branch '${name}' cannot be created from it`);
    }
    if (repo.branches[name]) throw new DemoFailure(`fatal: a branch named '${name}' already exists`);
    const sha = repo.remote.branches[name];
    moveTo(repo, files, repo.commits[sha].tree, "checkout");
    repo.branches[name] = sha;
    repo.upstreams[name] = `${trackRemote}/${name}`;
    repo.head = name;
    return [
      `branch '${name}' set up to track '${trackRemote}/${name}'.`,
      `Switched to a new branch '${name}'`,
    ];
  }
  const sha = repo.branches[name];
  if (!sha) throw new DemoFailure(`error: pathspec '${name}' did not match any file(s) known to git`);
  if (name === repo.head) return [`Already on '${name}'`];
  moveTo(repo, files, repo.commits[sha].tree, "checkout");
  repo.head = name;
  return [`Switched to branch '${name}'`];
}

export function createBranch(
  repo: DemoRepo,
  files: Record<string, string>,
  name: string,
  from: string | null,
  checkoutAfter: boolean
): Progress {
  const invalid = validateBranchName(name);
  if (invalid) throw new DemoFailure(`fatal: '${name}' is not a valid branch name`);
  if (repo.branches[name]) throw new DemoFailure(`fatal: a branch named '${name}' already exists`);
  const start = from === null ? headSha(repo) : resolve(repo, from);
  if (start === null) throw new DemoFailure(`fatal: not a valid object name: '${from}'`);
  if (checkoutAfter) moveTo(repo, files, repo.commits[start].tree, "checkout");
  repo.branches[name] = start;
  if (!checkoutAfter) return [];
  repo.head = name;
  return [`Switched to a new branch '${name}'`];
}

/// Merges `branch` into the branch checked out: nothing when it is
/// already in, a fast-forward when HEAD is behind it, and otherwise a
/// merge commit -- unless both sides changed one file, which the demo
/// refuses rather than leaving a conflict it cannot see through.
export function merge(repo: DemoRepo, files: Record<string, string>, branch: string): Progress {
  const theirs = resolve(repo, branch);
  if (theirs === null) throw new DemoFailure(`merge: ${branch} - not something we can merge`);
  const ours = headSha(repo);
  if (isAncestor(repo, theirs, ours)) return ["Already up to date."];
  if (isAncestor(repo, ours, theirs)) {
    moveTo(repo, files, repo.commits[theirs].tree, "merge");
    repo.branches[repo.head] = theirs;
    return [`Updating ${short(ours)}..${short(theirs)}`, "Fast-forward"];
  }
  const baseSha = mergeBase(repo, ours, theirs);
  const base = baseSha ? repo.commits[baseSha].tree : {};
  const mine = repo.commits[ours].tree;
  const other = repo.commits[theirs].tree;
  const merged: Tree = {};
  const conflicted: string[] = [];
  for (const path of pathsOf(base, mine, other)) {
    const [b, o, t] = [base[path], mine[path], other[path]];
    const result = o === t ? o : o === b ? t : t === b ? o : null;
    if (result === null) conflicted.push(path);
    else if (result !== undefined) merged[path] = result;
  }
  if (conflicted.length > 0) {
    throw new DemoFailure(
      [
        ...conflicted.map((path) => `CONFLICT (content): Merge conflict in ${path}`),
        "The Demo Workstation does not merge changes that conflict, so nothing was changed.",
      ].join("\n")
    );
  }
  moveTo(repo, files, merged, "merge");
  const into = repo.head === "main" || repo.head === "master" ? "" : ` into ${repo.head}`;
  const message = `Merge branch '${branch}'${into}`;
  const sha = nextSha(repo, message, [ours, theirs]);
  repo.commits[sha] = { sha, parents: [ours, theirs], message, tree: merged };
  repo.branches[repo.head] = sha;
  return ["Merge made by the 'ort' strategy."];
}

// ---- The remote --------------------------------------------------------------

function knownRemote(repo: DemoRepo, remote: string): void {
  if (remote !== repo.remote.name) {
    throw new DemoFailure(`fatal: '${remote}' does not appear to be a git repository`);
  }
}

export function push(repo: DemoRepo, remote: string): Progress {
  knownRemote(repo, remote);
  const branch = repo.head;
  const local = headSha(repo);
  const theirs = repo.remote.branches[branch];
  if (theirs === local) return ["Everything up-to-date"];
  if (theirs && !isAncestor(repo, theirs, local)) {
    throw new DemoFailure(
      [
        `To ${repo.remote.url}`,
        ` ! [rejected]        ${branch} -> ${branch} (fetch first)`,
        `error: failed to push some refs to '${repo.remote.url}'`,
      ].join("\n")
    );
  }
  const sent = theirs ? aheadBehind(repo, local, theirs).ahead : ancestry(repo, local).size;
  const objects = sent * 3;
  repo.remote.branches[branch] = local;
  repo.upstreams[branch] = `${remote}/${branch}`;
  return [
    `Enumerating objects: ${objects}, done.`,
    `Counting objects: 100% (${objects}/${objects}), done.`,
    `Writing objects: 100% (${objects}/${objects}), done.`,
    `To ${repo.remote.url}`,
    theirs
      ? `   ${short(theirs)}..${short(local)}  ${branch} -> ${branch}`
      : ` * [new branch]      ${branch} -> ${branch}`,
  ];
}

/// Nothing moves on the demo's remote by itself, so a fetch finds what
/// the repository already knows.
export function fetch(repo: DemoRepo, remote: string): Progress {
  knownRemote(repo, remote);
  return [`From ${repo.remote.url}`];
}

export function pull(repo: DemoRepo, files: Record<string, string>): Progress {
  const upstream = repo.upstreams[repo.head];
  if (!upstream) {
    throw new DemoFailure(
      `There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.`
    );
  }
  return [`From ${repo.remote.url}`, ...merge(repo, files, upstream)];
}
