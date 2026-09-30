// What the Demo Workstation answers to the Files tab's commands and the
// editor's.
//
// The same names and argument shapes `backend.ts` sends to the desktop
// host (`app/src-tauri/src/fileviewer.rs`), over the demo's own disk
// (`DemoState.files`) -- the working trees its repositories report on, so
// a save here is a change on the Git surface. The host's two fences are
// kept: a listing never leaves the root it was given, and a read or a
// write never leaves every open workspace.
import { compareNodes, isUnder, joinPath } from "$lib/files/fileTree";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { announceFiles, announceRepo, repoHolding, unwatch, watch } from "$companion/demo/watches";

/// The host's list (`VIEWABLE_EXTENSIONS` in fileviewer.rs): what opens
/// in the app rather than in the desk's own application for it.
const VIEWABLE = [
  "txt", "md", "markdown", "rs", "ts", "js", "tsx", "jsx", "svelte", "py", "go", "rb", "java",
  "c", "h", "cpp", "hpp", "cs", "swift", "kt", "sh", "bash", "zsh", "fish", "toml", "yaml",
  "yml", "json", "xml", "html", "css", "scss", "sql", "graphql", "lua", "php", "pl", "r",
  "dockerfile", "gitignore", "env", "ini", "conf", "cfg", "log", "csv",
];

type Entry = Answer<"listDirectory">["entries"][number];

function atOrUnder(dir: string, path: string): boolean {
  return path === dir || isUnder(dir, path);
}

function roots(demo: DemoContext): string[] {
  return demo.state.workspaces.workspaces.flatMap((w) => (w.rootPath ? [w.rootPath] : []));
}

/// The host refuses any path outside every open workspace (AS-04).
function inAWorkspace(demo: DemoContext, path: string): string {
  if (!roots(demo).some((root) => atOrUnder(root, path))) {
    throw new DemoFailure(`${path} is outside every open workspace`);
  }
  return path;
}

function isDirectory(demo: DemoContext, path: string): boolean {
  const base = path.endsWith("/") ? path : `${path}/`;
  return roots(demo).includes(path) || Object.keys(demo.state.files).some((file) => file.startsWith(base));
}

function bytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

function listing(demo: DemoContext, dir: string): Entry[] {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  const entries = new Map<string, Entry>();
  for (const [path, content] of Object.entries(demo.state.files)) {
    if (!path.startsWith(base)) continue;
    const rest = path.slice(base.length);
    const cut = rest.indexOf("/");
    const name = cut === -1 ? rest : rest.slice(0, cut);
    if (cut === -1) entries.set(name, { name, isDir: false, size: bytes(content), symlink: false });
    else if (!entries.has(name)) entries.set(name, { name, isDir: true, size: 0, symlink: false });
  }
  // In the tree's own order, as the host sends it.
  return [...entries.values()].sort((a, b) =>
    compareNodes({ ...a, path: joinPath(dir, a.name) }, { ...b, path: joinPath(dir, b.name) })
  );
}

export const FILE_COMMANDS: Record<string, DemoCommand> = {
  viewable_extensions: (): Answer<"viewableExtensions"> => [...VIEWABLE],

  list_directory: (args, demo): Answer<"listDirectory"> => {
    const root = text(args, "root");
    const path = text(args, "path");
    if (!roots(demo).includes(root)) throw new DemoFailure(`${root} is not the root of an open workspace`);
    if (!atOrUnder(root, path)) throw new DemoFailure(`${path} is outside the workspace root`);
    if (path in demo.state.files) throw new DemoFailure(`${path} is not a directory`);
    if (!isDirectory(demo, path)) throw new DemoFailure(`${path}: No such file or directory (os error 2)`);
    return { entries: listing(demo, path), omitted: 0 };
  },

  // A path that is not there yet answers `exists: false` rather than an
  // error: the PRD and agent-file tabs open on files the first save
  // creates.
  read_file_for_viewer: (args, demo): Answer<"readFileForViewer"> => {
    const path = inAWorkspace(demo, text(args, "path"));
    if (isDirectory(demo, path)) throw new DemoFailure(`${path}: Is a directory (os error 21)`);
    const content = demo.state.files[path];
    return content === undefined
      ? { content: "", truncated: false, exists: false }
      : { content, truncated: false, exists: true };
  },

  write_file_for_editor: (args, demo) => {
    const path = inAWorkspace(demo, text(args, "path"));
    const content = text(args, "content");
    if (isDirectory(demo, path)) throw new DemoFailure(`${path}: Is a directory (os error 21)`);
    const before = { ...demo.state.files };
    demo.state.files[path] = content;
    announceFiles(demo, before);
    const repo = repoHolding(demo, path);
    if (repo) announceRepo(demo, repo);
    return null;
  },

  watch_file_for_viewer: (args, demo) => {
    watch(demo, "files", inAWorkspace(demo, text(args, "path")));
    return null;
  },
  unwatch_file_for_viewer: (args, demo) => {
    unwatch(demo, "files", inAWorkspace(demo, text(args, "path")));
    return null;
  },
};
