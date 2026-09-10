import { shareFromSize } from "$lib/panes/splitShare";

// The Files tab's directory tree, as data.
//
// Everything the tab decides lives here: what a node is, which
// directories are open, what order rows come in, what a filter narrows
// to, and how the tree is patched after a create, rename or delete.
// FilesHubView.svelte only reads rows out and hands events back, the way
// PlanTree does over planExplorer.ts.
//
// Two rules shape all of it:
//
//   - The tree is LAZY. A directory's contents are unknown until it is
//     opened, one `list_directory` per open, and there is no watcher on
//     the repo tree at all -- the daemon's `.gavin*` watcher exists
//     because that folder is small, while arming an FSEvents stream over
//     a 3000-folder repo took minutes and stalled the streaming thread.
//     So a directory here is in one of three states (never opened,
//     opened and read, opened and failed) and the difference matters:
//     "we have not looked" is not "there is nothing there".
//
//   - Nothing is hidden. No `.gitignore` filter and no dotfile rule --
//     `target/` and `node_modules/` sit at the top level like anything
//     else, and cost nothing until someone opens them.
//
// State is treated as immutable: every function returns a new object
// rather than mutating, so a Svelte 5 `$state` holder can assign the
// result and get a re-render without anyone reasoning about proxy
// identity (`$state` proxies objects, so `next !== previous` is true
// whether or not anything changed).

/// One entry of a listed directory, as the tree holds it. `path` is
/// absolute; the host reports the rest.
///
/// `isDir` is false for a symlink even when it points at a directory --
/// the host reads symlink metadata precisely so the tree never offers to
/// walk through a link. A link is a leaf that says it is one.
export interface FileNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  symlink: boolean;
}

/// What the host's `list_directory` returns, before a path is attached.
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  symlink: boolean;
}

export interface FileTreeState {
  /// Absolute path of the workspace root. The tree never leaves it.
  root: string;
  /// Children of every directory that has been READ. A key that is
  /// absent means "never opened", which is why this is a map rather
  /// than a field on the node: the root has no node of its own to hang
  /// it off, and a collapsed directory keeps its listing so re-opening
  /// it is instant.
  children: Record<string, FileNode[]>;
  /// Directories the human has opened, as a set. A record rather than a
  /// Set so it round-trips through JSON into localStorage unchanged.
  expanded: Record<string, true>;
  /// The message from a directory whose read failed, keyed by path. Kept
  /// rather than thrown away so the row can say why it is empty --
  /// "permission denied" and "empty folder" look identical otherwise.
  errors: Record<string, string>;
}

export function emptyTree(root: string): FileTreeState {
  return { root, children: {}, expanded: {}, errors: {} };
}

// ---- path arithmetic --------------------------------------------------
//
// Plain string work on absolute POSIX paths. The app is macOS-only and
// every path in play comes from the Rust host already absolute, so there
// is nothing to normalize here -- and a helper that tried would be a
// second, quieter authority on containment next to the host's real one.

/// A directory's child path. Tolerates a trailing slash on the parent so
/// a root of "/" cannot produce "//name".
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/// The containing directory, or "" for a path with no parent.
export function parentPath(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return cut === 0 ? "/" : "";
  return trimmed.slice(0, cut);
}

/// Strictly inside: `isUnder("/a", "/a")` is false, and "/ab" is not
/// under "/a" -- the separator is required, which is the whole reason
/// this is not a bare `startsWith`.
export function isUnder(dir: string, path: string): boolean {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return path !== dir && path.startsWith(base);
}

/// Where `path` ends up when `from` is renamed to `to` -- the path
/// itself, or anything that was under it when `from` was a directory.
/// Unchanged for a path the rename does not touch.
///
/// Shared by the tree's own reconcile and by the retarget of open file
/// tabs, so a renamed folder can never move the tree's rows and leave a
/// tab pointing into the folder that no longer exists.
export function retargetPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (isUnder(from, path)) return to + path.slice(from.length);
  return path;
}

/// Every directory between `root` and `path`, root first, excluding
/// `path` itself. Empty when `path` is not under `root` at all -- a
/// remembered selection from a root that has since moved restores
/// nothing rather than opening folders outside it.
export function ancestorsWithin(root: string, path: string): string[] {
  if (!isUnder(root, path)) return [];
  const out: string[] = [root];
  const rest = path.slice(root.endsWith("/") ? root.length : root.length + 1);
  const parts = rest.split("/").filter(Boolean);
  // The last part is the entry itself, not a directory to open.
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = joinPath(current, part);
    out.push(current);
  }
  return out;
}

// ---- ordering ---------------------------------------------------------

/// Directories first, then by name. Case-insensitive so `README` and
/// `app` sit where a human looks for them rather than in ASCII order
/// (which would put every capital ahead of every lowercase), with a
/// case-sensitive tiebreak so two names differing only in case still
/// have a stable order.
export function compareNodes(a: FileNode, b: FileNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const lowered = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return lowered !== 0 ? lowered : a.name.localeCompare(b.name);
}

export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort(compareNodes);
}

/// The host's entries turned into nodes of `dir`.
export function nodesFrom(dir: string, entries: DirEntry[]): FileNode[] {
  return sortNodes(
    entries.map((e) => ({
      path: joinPath(dir, e.name),
      name: e.name,
      isDir: e.isDir,
      size: e.size,
      symlink: e.symlink,
    }))
  );
}

// ---- reading a directory ----------------------------------------------

/// Records a successful read. Clears any error the directory carried, so
/// a folder that failed once and then read stops explaining itself.
export function withChildren(
  state: FileTreeState,
  dir: string,
  entries: DirEntry[]
): FileTreeState {
  const errors = { ...state.errors };
  delete errors[dir];
  return { ...state, children: { ...state.children, [dir]: nodesFrom(dir, entries) }, errors };
}

/// Records a failed read. The directory stays open and stays unloaded --
/// re-opening it is what retries.
export function withError(state: FileTreeState, dir: string, message: string): FileTreeState {
  return { ...state, errors: { ...state.errors, [dir]: message } };
}

export function isExpanded(state: FileTreeState, dir: string): boolean {
  return state.expanded[dir] === true;
}

export function isLoaded(state: FileTreeState, dir: string): boolean {
  return state.children[dir] !== undefined;
}

export function expandDir(state: FileTreeState, dir: string): FileTreeState {
  if (isExpanded(state, dir)) return state;
  return { ...state, expanded: { ...state.expanded, [dir]: true } };
}

/// Collapsing keeps the listing. Re-opening a folder should not cost a
/// second read of a directory nothing has been told changed -- and
/// Refresh is the deliberate way to ask again.
export function collapseDir(state: FileTreeState, dir: string): FileTreeState {
  if (!isExpanded(state, dir)) return state;
  const expanded = { ...state.expanded };
  delete expanded[dir];
  return { ...state, expanded };
}

export function toggleDir(state: FileTreeState, dir: string): FileTreeState {
  return isExpanded(state, dir) ? collapseDir(state, dir) : expandDir(state, dir);
}

/// Forgets one directory's listing so the next open re-reads it. Used by
/// Refresh, which drops the whole tree's listings but keeps what is
/// open.
export function forgetChildren(state: FileTreeState, dirs: string[]): FileTreeState {
  const children = { ...state.children };
  const errors = { ...state.errors };
  for (const dir of dirs) {
    delete children[dir];
    delete errors[dir];
  }
  return { ...state, children, errors };
}

/// Every directory currently loaded -- what Refresh forgets.
export function loadedDirs(state: FileTreeState): string[] {
  return Object.keys(state.children);
}

/// The node at `path`, found through its parent's listing, or null when
/// that listing has not been read. The root has no node of its own; use
/// `rootNode`.
export function nodeAt(state: FileTreeState, path: string): FileNode | null {
  const siblings = state.children[parentPath(path)];
  return siblings?.find((n) => n.path === path) ?? null;
}

export function rootNode(state: FileTreeState): FileNode {
  return { path: state.root, name: baseName(state.root), isDir: true, size: 0, symlink: false };
}

// ---- rows -------------------------------------------------------------

export interface TreeRow {
  node: FileNode;
  /// Indent level. The root is 0.
  depth: number;
  expanded: boolean;
  /// Directories only: whether the listing is known. A directory that is
  /// open and unloaded is being read (or failed) -- the row says so
  /// rather than rendering as empty.
  loaded: boolean;
  /// Entries in a loaded directory. 0 on a file, and on a directory
  /// nobody has read -- which is why `loaded` has to be consulted first:
  /// "empty" and "not looked at" are the two things this tree must never
  /// say interchangeably.
  childCount: number;
  error: string | null;
}

export interface TreeView {
  rows: TreeRow[];
  /// True when a filter is narrowing the rows -- the empty state and the
  /// match count are only honest to show while it is.
  filtering: boolean;
  shown: number;
  /// While filtering, the population the filter actually searched: every
  /// node the tree has LOADED, open or not. Not "rows on screen before
  /// you typed" -- filtering ignores the open/closed state, so counting
  /// against it would report a match out of a smaller number than the
  /// matches themselves.
  total: number;
}

/// What the tab says when a filter matches nothing.
///
/// Never a bare "No match": this filter only ever sees the directories
/// that have been opened, because finding an unopened match would mean
/// the recursive walk the whole lazy tree exists to avoid. Saying so is
/// the difference between "your file is not in this repo" and "open the
/// folder it is in".
export const NO_MATCH_MESSAGE = "No match in the folders you have opened.";

function rowFor(state: FileTreeState, node: FileNode, depth: number): TreeRow {
  return {
    node,
    depth,
    expanded: node.isDir && isExpanded(state, node.path),
    loaded: !node.isDir || isLoaded(state, node.path),
    childCount: node.isDir ? (state.children[node.path]?.length ?? 0) : 0,
    error: state.errors[node.path] ?? null,
  };
}

function walkPlain(state: FileTreeState, dir: string, depth: number, out: TreeRow[]): void {
  for (const node of state.children[dir] ?? []) {
    out.push(rowFor(state, node, depth));
    if (node.isDir && isExpanded(state, node.path)) walkPlain(state, node.path, depth + 1, out);
  }
}

function nameMatches(name: string, needle: string): boolean {
  return name.toLowerCase().includes(needle);
}

/// Emits the matching rows under `dir` and returns whether it found any.
/// A directory is emitted when it matches OR when something beneath it
/// does -- that is what keeps a matched file's ancestors on screen
/// instead of leaving it floating at depth 0.
///
/// Expansion is ignored while filtering: a match three folders down is
/// useless if the human has to open the folders to see it, and every
/// folder considered here has already been read, so showing it costs no
/// listing.
function walkFiltered(
  state: FileTreeState,
  dir: string,
  depth: number,
  needle: string,
  out: TreeRow[]
): boolean {
  let found = false;
  for (const node of state.children[dir] ?? []) {
    if (node.isDir) {
      const sub: TreeRow[] = [];
      const subFound = walkFiltered(state, node.path, depth + 1, needle, sub);
      if (subFound || nameMatches(node.name, needle)) {
        // Forced open: a directory shown because of what is inside it
        // must not render with a closed chevron over visible children.
        out.push({ ...rowFor(state, node, depth), expanded: subFound });
        out.push(...sub);
        found = true;
      }
    } else if (nameMatches(node.name, needle)) {
      out.push(rowFor(state, node, depth));
      found = true;
    }
  }
  return found;
}

/// The rows to render, root first.
///
/// The root row is always present, filter or not: it is the tree's
/// anchor -- the thing right-clicked to create at the top level, and the
/// one row that still says which folder this is when everything under it
/// is filtered away.
export function visibleRows(state: FileTreeState, query = ""): TreeView {
  const needle = query.trim().toLowerCase();
  const root = rowFor(state, rootNode(state), 0);

  if (needle === "") {
    const plain: TreeRow[] = [];
    if (isExpanded(state, state.root)) walkPlain(state, state.root, 1, plain);
    return { rows: [root, ...plain], filtering: false, shown: plain.length, total: plain.length };
  }
  const matched: TreeRow[] = [];
  walkFiltered(state, state.root, 1, needle, matched);
  return {
    // The root always renders open while filtering -- it is holding the
    // matches.
    rows: [{ ...root, expanded: true }, ...matched],
    filtering: true,
    shown: matched.length,
    total: loadedNodeCount(state),
  };
}

/// Every node the tree has read, anywhere under the root. The filter's
/// denominator, and the honest measure of how much of the repo this tab
/// has actually looked at.
export function loadedNodeCount(state: FileTreeState): number {
  let count = 0;
  const seen = new Set<string>();
  const walk = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const node of state.children[dir] ?? []) {
      count += 1;
      if (node.isDir) walk(node.path);
    }
  };
  walk(state.root);
  return count;
}

// ---- reconciling after a mutation -------------------------------------
//
// The tree has no watcher, so a create, rename or delete is patched in
// rather than re-read. Re-reading the parent would work for a create,
// but a rename can move a whole open subtree and re-reading it would
// close every folder inside -- the human's own action would fold up the
// tree they were working in.

/// A file or directory that has just appeared. A no-op when the parent
/// has not been read: the entry will be there when it is.
export function afterCreate(state: FileTreeState, path: string, isDir: boolean): FileTreeState {
  const parent = parentPath(path);
  const siblings = state.children[parent];
  if (!siblings) return state;
  if (siblings.some((n) => n.path === path)) return state;
  const node: FileNode = { path, name: baseName(path), isDir, size: 0, symlink: false };
  const children = { ...state.children, [parent]: sortNodes([...siblings, node]) };
  // A new directory is born empty and KNOWN to be -- it was just made,
  // so opening it must not sit on "reading…" waiting for a listing that
  // can only come back empty.
  if (isDir) children[path] = [];
  return { ...state, children };
}

/// An entry that has gone. Drops it from its parent's listing and
/// forgets everything the tree knew about it and its subtree -- leaving
/// those keys behind would resurrect stale children under a path
/// recreated later with the same name.
export function afterDelete(state: FileTreeState, path: string): FileTreeState {
  const parent = parentPath(path);
  const children = { ...state.children };
  const expanded = { ...state.expanded };
  const errors = { ...state.errors };
  if (children[parent]) children[parent] = children[parent].filter((n) => n.path !== path);
  for (const key of Object.keys(children)) {
    if (key === path || isUnder(path, key)) delete children[key];
  }
  for (const key of Object.keys(expanded)) {
    if (key === path || isUnder(path, key)) delete expanded[key];
  }
  for (const key of Object.keys(errors)) {
    if (key === path || isUnder(path, key)) delete errors[key];
  }
  return { ...state, children, expanded, errors };
}

/// An entry that moved. Both ends are patched and the subtree is
/// RE-KEYED rather than forgotten, so a renamed folder keeps the
/// listings and the open/closed state it had a moment ago.
///
/// A rename whose source the tree never listed still patches the
/// destination: the source may have been in a directory nobody opened,
/// while the destination is usually the one on screen.
export function afterRename(state: FileTreeState, from: string, to: string): FileTreeState {
  const moved = nodeAt(state, from);
  const fromParent = parentPath(from);
  const toParent = parentPath(to);
  const children: Record<string, FileNode[]> = {};
  const expanded: Record<string, true> = {};
  const errors: Record<string, string> = {};

  const rekey = (key: string) => retargetPath(key, from, to);
  const rekeyNode = (node: FileNode): FileNode => {
    const moved = rekey(node.path);
    return moved === node.path ? node : { ...node, path: moved, name: baseName(moved) };
  };

  for (const [dir, nodes] of Object.entries(state.children)) {
    children[rekey(dir)] = nodes.map(rekeyNode);
  }
  for (const key of Object.keys(state.expanded)) expanded[rekey(key)] = true;
  for (const [key, message] of Object.entries(state.errors)) errors[rekey(key)] = message;

  const node: FileNode = moved
    ? { ...moved, path: to, name: baseName(to) }
    : { path: to, name: baseName(to), isDir: false, size: 0, symlink: false };

  // Remove from the old parent, add to the new. When both are the same
  // directory this is one filter and one insert over the same list, which
  // is exactly what an in-place rename needs.
  if (children[fromParent]) {
    children[fromParent] = children[fromParent].filter((n) => n.path !== from && n.path !== to);
  }
  if (children[toParent]) {
    children[toParent] = sortNodes([...children[toParent].filter((n) => n.path !== to), node]);
  }
  return { ...state, children, expanded, errors };
}

// ---- restoring the tab ------------------------------------------------
//
// `+page.svelte` renders one hub view at a time and DESTROYS it on every
// tab switch, so without this the tree would fold shut and forget the
// open file on each visit. Same answer the Plans tab reached
// (planExplorer.ts): localStorage, per workspace, because this is a
// per-human view preference rather than workspace data -- and it carries
// across a reload as a bonus.

export interface FilesTabMemory {
  /// The file in the editor pane, or null.
  selected: string | null;
  /// Directories left open.
  expanded: string[];
  /// The tree pane's share of the split (see splitShare.ts for why a
  /// share and never a px width).
  treeShare: number;
}

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// Roughly a quarter of the pane: enough for a path two or three folders
/// deep without taking the editor's column.
export const DEFAULT_TREE_SHARE = 0.28;
/// Enough for a chevron, an icon and a short name.
export const MIN_TREE_PX = 180;
/// The band a stored share has to fall in to be believed. Same guard as
/// homeSplit.ts: localStorage is hand-editable, and a share of 5 would
/// push the divider off the pane with nothing left on screen to drag it
/// back with.
export const MIN_TREE_SHARE = 0.12;
export const MAX_TREE_SHARE = 0.6;
/// The grab area between the panes.
export const DIVIDER_PX = 6;

export function emptyMemory(): FilesTabMemory {
  return { selected: null, expanded: [], treeShare: DEFAULT_TREE_SHARE };
}

/// The share a drag wanting the tree pane `desired` px wide should
/// store, given the pair's combined width.
export function treeShareFromWidth(desired: number, total: number, min = MIN_TREE_PX): number {
  return shareFromSize(desired, total, min, DEFAULT_TREE_SHARE);
}

export function resolveTreeShare(stored: number | null | undefined): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return DEFAULT_TREE_SHARE;
  if (stored < MIN_TREE_SHARE || stored > MAX_TREE_SHARE) return DEFAULT_TREE_SHARE;
  return stored;
}

/// The grid template for tree | divider | editor. Rounded to the four
/// decimals a dragged share carries, so no drag can write `0.30000000004fr`.
export function filesGridColumns(share: number): string {
  const left = Math.round(share * 1e4) / 1e4;
  const right = Math.round((1 - left) * 1e4) / 1e4;
  return `${left}fr ${DIVIDER_PX}px ${right}fr`;
}

/// Per workspace: each has a Files tab of its own, over a different root.
export function filesMemoryKey(workspaceId: string): string {
  return `gavin.filesTab.${workspaceId}`;
}

/// Anything but a well-formed record reads as nothing remembered.
/// Forgetting is the only acceptable failure mode for a view preference,
/// so a corrupt or hand-edited value opens a default tab rather than a
/// broken one.
export function loadFilesMemory(
  workspaceId: string,
  storage: MaybeStorage = defaultStorage()
): FilesTabMemory {
  try {
    const raw = storage?.getItem(filesMemoryKey(workspaceId));
    if (!raw) return emptyMemory();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyMemory();
    const { selected, expanded, treeShare } = parsed as {
      selected?: unknown;
      expanded?: unknown;
      treeShare?: unknown;
    };
    return {
      selected: typeof selected === "string" && selected !== "" ? selected : null,
      expanded: Array.isArray(expanded) ? expanded.filter((e): e is string => typeof e === "string") : [],
      treeShare: resolveTreeShare(typeof treeShare === "number" ? treeShare : null),
    };
  } catch {
    return emptyMemory();
  }
}

export function saveFilesMemory(
  workspaceId: string,
  memory: FilesTabMemory,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    // Field by field: the caller's object is a `$state` proxy carrying
    // whatever else it has grown.
    storage?.setItem(
      filesMemoryKey(workspaceId),
      JSON.stringify({
        selected: memory.selected,
        expanded: [...memory.expanded],
        treeShare: memory.treeShare,
      })
    );
  } catch {
    // Best-effort: a full or blocked storage must never break the tab.
  }
}

/// What the tab has to read on restore, root first and parents before
/// children -- the remembered open directories, plus every ancestor of
/// the remembered selection, so the selected file is actually on screen
/// rather than buried in a folded folder.
///
/// Anything not under the current root is dropped: a workspace whose
/// root moved must not send the tree reading outside it.
export function restoreTargets(root: string, memory: FilesTabMemory): string[] {
  const wanted = new Set<string>([root]);
  for (const dir of memory.expanded) {
    if (dir === root || isUnder(root, dir)) wanted.add(dir);
  }
  if (memory.selected) for (const dir of ancestorsWithin(root, memory.selected)) wanted.add(dir);
  // Shortest first: a parent is a prefix of its children, so length order
  // is depth order, and every read finds its parent already listed.
  return [...wanted].sort((a, b) => a.length - b.length);
}

/// Whether the tree can vouch for a restored selection yet.
///
/// "unknown" is the answer that matters: until the containing directory
/// has actually been read, a missing file means "we have not looked",
/// and clearing the selection then would silently drop the human's open
/// file on every visit to the tab.
export function verifyRestored(
  state: FileTreeState,
  path: string
): "present" | "missing" | "unknown" {
  if (!isUnder(state.root, path)) return "missing";
  const parent = parentPath(path);
  if (!isLoaded(state, parent)) return "unknown";
  return nodeAt(state, path) ? "present" : "missing";
}

// ---- display ----------------------------------------------------------

/// A file size in the shortest honest form. Bytes exactly under 1 KB,
/// one decimal above it, and never for a directory (whose size the host
/// reports as 0 on purpose).
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
