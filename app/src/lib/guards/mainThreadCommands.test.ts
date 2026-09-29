import { describe, it, expect } from "vitest";

// Commands that must not run on the main thread.
//
// Tauri gives a plain `fn` command a blocking execution context: it runs
// inline on the thread that draws the window and takes its input. So a
// command that waits on a child process or the network freezes the whole
// app for as long as it waits -- the cursor spins, typing into a terminal
// stalls and replays afterwards -- while every suite stays green, because
// nothing here runs under Tauri. Measured 2026-09-26: `pr_status`'s `gh`
// round trips held the main thread 12 s of every minute, in unbroken runs
// of up to 9.5 s, and `git_run_changes` about a second per call.
//
// Each one listed is `async` and either hands its work to the blocking
// pool, the shape `get_git_baselines` documents -- directly, or through
// git/run.rs's `off_main_thread`, which is that same call in one line --
// or queues a daemon request on a command lane and awaits the reply
// (command_lane.rs). The list is not exhaustive: it is the commands
// measured or known to wait on something slow, so none of them can
// quietly go back to a plain `fn`. The daemon commands are covered whole
// by the structural check at the bottom as well.

const RUST = import.meta.glob("../../../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rust(file: string): string {
  const found = Object.entries(RUST).find(([path]) => path.endsWith(`/${file}`));
  if (!found) throw new Error(`${file} not found`);
  return found[1];
}

/// [file under src-tauri/src, command, what it waits on]
const OFF_MAIN_THREAD: [file: string, command: string, waitsOn: string][] = [
  ["pull_request.rs", "pr_status", "`gh`, a GitHub round trip"],
  ["git/runchanges.rs", "git_run_changes", "several `git` processes"],
  ["git/commands.rs", "get_git_baselines", "`git status` per session, on the load path"],
  ["typesafe.rs", "typesafe_verdict", "an HTTPS request"],
  ["typesafe.rs", "typesafe_attribution", "an HTTPS request"],
  // Per profile in use, every 180 s poll: `security`, `claude --version`
  // and up to three curls at a 10 s timeout each. Measured at 1.1-1.6 s
  // of main thread a minute with four profiles.
  ["agent_usage.rs", "agent_usage", "Keychain reads and curl to each agent's usage endpoint"],
  // The Git view's refresh and what it chains: 14 processes a refresh
  // then, measured at 6-7 s of main thread a minute with one view open.
  ["git/commands.rs", "git_repo_info", "five `git` processes, every refresh"],
  ["git/commands.rs", "git_status", "`git status` over the whole checkout, every refresh"],
  ["git/commands.rs", "git_refs", "five `git` processes, every refresh"],
  ["git/conflict.rs", "git_merge_tool_name", "`git config`, every refresh"],
  ["git/commands.rs", "git_diff", "`git diff` of the selected file, every refresh"],
  ["git/commands.rs", "git_log", "`git log`, every refresh while History shows"],
  ["git/commands.rs", "git_commit_detail", "`git show` + `git diff-tree`"],
  ["git/runchanges.rs", "git_diff_since", "`git diff` against a run's baseline"],
  // The Git tab's actions. Each is its own git plus the refresh after it,
  // 0.7-1.3 s a click with no hooks at all; the ones that run hooks, sign
  // or check files out through a filter wait on whatever those do -- a
  // pre-commit suite, a pinentry or Touch ID prompt, an LFS download.
  ["git/commands.rs", "git_commit", "hooks and commit signing"],
  ["git/commands.rs", "git_merge", "hooks, signing and LFS smudge"],
  ["git/commands.rs", "git_revert", "hooks and commit signing"],
  ["git/commands.rs", "git_cherry_pick", "hooks and commit signing"],
  ["git/commands.rs", "git_continue_in_progress", "hooks and commit signing"],
  ["git/commands.rs", "git_continue_rebase", "hooks and commit signing"],
  ["git/commands.rs", "git_checkout", "post-checkout hook and LFS smudge; the rail's branch switch too"],
  ["git/commands.rs", "git_checkout_commit", "post-checkout hook and LFS smudge"],
  ["git/commands.rs", "git_create_branch", "a checkout, when it switches to the branch"],
  ["git/commands.rs", "git_abort_in_progress", "a checkout of the pre-merge tree"],
  ["git/commands.rs", "git_reset", "a checkout, for --hard"],
  ["git/commands.rs", "git_stash_push", "`stash push`: an add and a hard reset"],
  ["git/commands.rs", "git_stash_pop", "a merge into the working tree"],
  ["git/commands.rs", "git_stash_apply", "a merge into the working tree"],
  ["git/commands.rs", "git_stash_drop", "`git stash drop`"],
  ["git/commands.rs", "git_stage_files", "`git add`, and its clean filters"],
  ["git/commands.rs", "git_unstage_files", "`git restore --staged`"],
  ["git/commands.rs", "git_stage_all", "`git add -A` over the whole checkout"],
  ["git/commands.rs", "git_unstage_all", "`git reset`"],
  ["git/commands.rs", "git_apply_patch", "`git apply`"],
  ["git/commands.rs", "git_discard_files", "`git checkout` and `git clean`"],
  ["git/commands.rs", "git_delete_branch", "`git branch -d`"],
  ["git/commands.rs", "git_add_remote", "`git remote add`"],
  ["git/commands.rs", "git_remove_remote", "`git remote remove`, which rewrites refs"],
  ["git/commands.rs", "git_init", "`git init`"],
  ["git/runchanges.rs", "git_discard_run", "`reset --hard` and a Trash move per untracked file"],
  // Worktrees: a checkout of the whole tree, or a delete of one with its
  // build output -- 30k files and 4-6.6 GB in this repo's, 2.7 s to
  // unlink. Best-of-N adds N in a row and a sweep removes N in a row.
  ["git/commands.rs", "git_worktree_add", "a checkout of the whole tree, post-checkout hook and LFS smudge"],
  ["git/commands.rs", "git_worktree_remove", "deleting the whole tree, build output included, then watchman"],
  // Conflict resolution. The read re-runs on every refresh while a `U`
  // path is selected and after every resolve click, which is its own git
  // plus that refresh: 1.5-2.5 s a click, measured on the main thread.
  ["git/conflict.rs", "git_conflict", "`ls-files -u`, a `show` per stage, the side labels' reads"],
  ["git/conflict.rs", "git_mark_resolved", "`git add`, and its clean filters"],
  ["git/conflict.rs", "git_resolve_whole", "`checkout --ours/--theirs` and `git add`"],
  ["git/conflict.rs", "git_resolve_deleted", "`git rm`, or a checkout and `git add`"],
  ["git/conflict.rs", "git_restore_conflict", "`checkout -m`"],
  // The memory poll reads watchman every 30 s per window, and Drop roots
  // forgets one root at a time: a `watchman` CLI each, 170-200 ms, or
  // the 5 s deadline when the server is wedged. Measured at 0.2-1.2 s
  // of main thread a minute.
  ["memory.rs", "watchman_status", "the `watchman watch-list` CLI, every 30 s poll"],
  ["memory.rs", "watchman_forget", "the `watchman watch-del` CLI, once per dropped root"],
  // Every Settings visit, every workspace or profile change there, a Home
  // visit with no recorded answer, and the wizards' Superpowers step:
  // `claude plugin list`, a Node start, measured at 0.48-0.90 s. The
  // Install button held the window for the whole network install.
  ["superpowers.rs", "superpowers_status", "`claude plugin list`, on every Settings visit"],
  ["superpowers.rs", "superpowers_install", "`claude plugin install` over the network, up to 180 s"],
  // Once per launch, from bootstrap, in the same first seconds as the
  // first usage poll and watchman read: `opencode models`, a start that
  // alone takes 0.41-0.85 s, under a 15 s deadline.
  ["agent_models.rs", "agent_model_catalog", "`opencode models`, at startup, up to 15 s"],
  // Neither waits on a process, but both re-run without anyone asking:
  // the read on every `file-changed` for an open editor tab or card
  // modal, the listing for every remembered open folder on every Files
  // visit. One folder of 60,052 entries was 0.6-1.1 s of stat.
  ["fileviewer.rs", "read_file_for_viewer", "a disk read (an ssh round trip on a remote workspace), on every watch event"],
  ["fileviewer.rs", "list_directory", "a readdir and a stat per entry, per open folder, on every Files visit"],
  // Run history reads one transcript per conversation on every open and
  // refresh, and a live run's is re-read every time: whole files, up to
  // 29 MB here. The resume check resolves through the same readdir of
  // every project directory (or a codex walk of up to 4,000 files), on
  // every resume and review launch, auto-resume included.
  ["agent_tokens.rs", "card_run_tokens", "a whole agent transcript read and parsed, per conversation"],
  ["agent_tokens.rs", "conversation_log", "a readdir of every project directory, on every resume"],
  // The delete wizard's scan walks the whole root twelve deep for
  // `.gavin/` folders -- 150k entries in a large repo, 2-7 s cold -- and
  // the remover walks it again before it trashes anything.
  ["workspace_delete.rs", "scan_gavin_footprint", "a walk of the whole workspace root"],
  ["workspace_delete.rs", "remove_gavin_footprint", "the same walk again, then a Trash move per item"],
  // The daemon's request/reply commands. They shared one blocking
  // connection with no read timeout, so any of them could hold the main
  // thread for as long as a handler took; they moved off it together,
  // onto command lanes, because moving one would have made the others
  // wait on the main thread behind it. Measured before: set_orchestration
  // 0.26 s a minute, list_managed_sessions 0.1-0.2 s (polled every 2-5 s
  // by three surfaces), get_board 0.1 s.
  ["session.rs", "get_board", "a daemon round trip, on every tree push"],
  ["session.rs", "set_board", "a daemon round trip"],
  ["session.rs", "card_session", "a daemon round trip (a whole board, against a daemon before v43)"],
  ["session.rs", "card_runs", "a daemon round trip"],
  ["session.rs", "get_orchestration", "a daemon round trip"],
  ["session.rs", "set_orchestration", "a daemon round trip that pushes the whole plan first"],
  ["session.rs", "set_rail_run", "a daemon round trip, every scheduler pass"],
  ["session.rs", "set_step_run", "a daemon round trip, every scheduler pass"],
  ["session.rs", "get_gavin_tree", "a tree read that can wait on a rescan"],
  ["session.rs", "list_managed_sessions", "two daemon round trips, polled every 2-5 s"],
  ["session.rs", "get_session_baselines", "a round trip to every daemon, on every load"],
  ["session.rs", "tool_runs", "a daemon round trip"],
  ["session.rs", "set_plan_frontmatter_field", "a card write through the daemon"],
  ["session.rs", "archive_card", "a card move through the daemon"],
  ["session.rs", "end_orphan", "SIGTERM and a 2 s grace, on a connection of its own"],
  ["session.rs", "kill_session", "a daemon round trip"],
  ["session.rs", "create_session", "a PTY spawn in the daemon"],
  // Turning the last workspace's compression off has the daemon stop
  // Headroom and wait for it to be gone: SIGTERM, then up to 10 s.
  ["session.rs", "set_headroom_workspaces", "a daemon round trip that waits on Headroom stopping"],
  // Settings polls the status every few seconds while it is open, and
  // the first ask of a daemon's lifetime runs detection. Check again and
  // Locate… run `headroom --version`, a Python start.
  ["session.rs", "get_headroom_status", "a daemon round trip, polled while Settings is open"],
  ["session.rs", "detect_headroom", "`headroom --version` in the daemon, a Python start"],
  ["session.rs", "install_headroom", "a daemon round trip"],
  ["session.rs", "session_screen", "a daemon round trip, per turn verdict"],
  ["session.rs", "gavin_root_exists", "a root scan on an ssh host"],
  // Explicit actions, but unbounded: the stop waits up to ~0.9 s, the
  // respawn up to 3 s, then the version probe, both Hellos, an Attach per
  // session and a watch per workspace -- from the error overlay a whole
  // bootstrap. The streaming connection refuses input meanwhile.
  ["session.rs", "restart_daemon", "stopping, respawning and re-handshaking the daemon"],
  ["session.rs", "stop_daemon", "a Shutdown, then SIGTERM, with up to ~0.9 s of waiting"],
  // On an ssh workspace each of these is a round trip to the host, and a
  // host that has stopped answering holds it for a whole deadline: the
  // editor's autosave on every typing pause, the attachment check on
  // every card modal, a dozen in a row for an agent integration run. The
  // "commands that wait on an ssh host" check below finds the file and
  // agent ones by what they call; these rows name them all the same.
  ["fileviewer.rs", "write_file_for_editor", "an ssh round trip, on every autosave"],
  ["fileviewer.rs", "attachment_status", "an ssh round trip, on every card modal open"],
  ["fileviewer.rs", "create_file", "an ssh round trip"],
  ["fileviewer.rs", "create_directory", "an ssh round trip"],
  ["fileviewer.rs", "rename_path", "an ssh round trip"],
  ["fileviewer.rs", "trash_entry", "an ssh round trip, or a local Trash move"],
  ["agent_setup.rs", "setup_agent_integration", "a dozen ssh round trips in a row"],
  ["git/commands.rs", "git_merged_branches", "`git branch --merged`, on every worktree sweep"],
  ["git/commands.rs", "git_stash_files", "`git stash show`"],
  ["git/commands.rs", "git_worktree_prune", "`git worktree prune`"],
  ["git/ignore.rs", "git_read_ignore_file", "a `git rev-parse` and a file read"],
  ["git/ignore.rs", "git_write_ignore_file", "a `git rev-parse` and a file write"],
  ["git/ignore.rs", "git_add_ignore_pattern", "a `git rev-parse`, a read and a write"],
  ["git/runchanges.rs", "git_head_sha", "`git rev-parse HEAD`, on every card launch"],
  ["git/tracking.rs", "gavin_git_tracking", "`git check-ignore`, on every Settings visit"],
  ["git/tracking.rs", "set_gavin_git_tracking", "`git check-ignore`, and `git rm --cached` to untrack"],
  ["git/ops.rs", "git_cancel_op", "an ssh round trip, for an op running on a host"],
];

/// The command's text from its `#[tauri::command]` line to the first
/// line that closes a top-level item. Attributes and doc comments may sit
/// between the two, as `#[allow(clippy::too_many_arguments)]` does on a
/// command with many arguments.
function commandBody(file: string, command: string): string {
  const text = rust(file);
  const at = text.search(
    new RegExp(`#\\[tauri::command\\]\\s*(#\\[[^\\]]*\\]\\s*|///[^\\n]*\\n\\s*)*pub (async )?fn ${command}\\(`)
  );
  expect(at, `${command} is not a command in ${file}`).toBeGreaterThan(-1);
  return text.slice(at, text.indexOf("\n}\n", at));
}

/// A command that queues its daemon request on a lane and awaits the
/// reply: it names the lanes it sends on, and awaits.
const WORKER_QUEUE = /(lanes_for\(|\.lanes\()[\s\S]*\.await/;

describe("commands that wait on something slow", () => {
  for (const [file, command, waitsOn] of OFF_MAIN_THREAD) {
    it(`${command} (${waitsOn}) runs off the main thread`, () => {
      const body = commandBody(file, command);
      expect(body).toContain(`pub async fn ${command}(`);
      if (!/spawn_blocking|off_main_thread\(/.test(body)) expect(body).toMatch(WORKER_QUEUE);
    });
  }

  // The helper is only worth trusting while it IS the blocking pool: an
  // `async fn` that ran the work inline would pass the check above and
  // block a runtime worker instead of the main thread.
  it("git/run.rs's off_main_thread hands its work to the blocking pool", () => {
    const text = rust("git/run.rs");
    const at = text.search(/pub async fn off_main_thread</);
    expect(at, "off_main_thread is not an async fn in git/run.rs").toBeGreaterThan(-1);
    expect(text.slice(at, text.indexOf("\n}\n", at))).toContain("tauri::async_runtime::spawn_blocking(");
  });

  // The same for the worker queue. A lane is only off the main thread
  // while its `request` AWAITS the worker's reply -- one that waited on
  // this thread would block a runtime worker instead -- and while
  // enqueueing never blocks, which is what lets it run on the first poll.
  it("command_lane.rs's request awaits the worker, and enqueueing never blocks", () => {
    const text = rust("command_lane.rs");
    const request = text.slice(text.search(/pub async fn request\(/), text.indexOf("\n    }\n", text.search(/pub async fn request\(/)));
    expect(request).toContain(".await");
    expect(request).not.toMatch(/\.wait\(|blocking_recv|\.ask\(/);
    const fnBody = (name: string): string => {
      const at = text.search(new RegExp(`fn ${name}\\(`));
      expect(at, `${name} is not a fn in command_lane.rs`).toBeGreaterThan(-1);
      return text.slice(at, text.indexOf("\n    }\n", at));
    };
    expect(fnBody("admit")).toContain("crate::session::gate(");
    expect(fnBody("submit")).toContain("self.submit_within(");
    const submit = fnBody("submit_within");
    expect(submit).toContain("self.admit(");
    expect(submit).toContain(".send(Job::Ask");
    expect(submit).not.toMatch(/\.lock\(|\.wait\(|blocking_recv|\.recv\(/);
    // A request that goes apart dials its own connection and waits out a
    // 2 s grace on it: both belong to the thread it spawns, never to the
    // caller.
    const apart = fnBody("submit_apart");
    expect(apart).toContain("self.admit(");
    const onThread = apart.indexOf(".spawn(move ||");
    expect(onThread, "submit_apart does not hand its round trip to a thread").toBeGreaterThan(-1);
    expect(apart.slice(0, onThread)).not.toMatch(/round_trip|redial\(|connect\(|\.lock\(|\.wait\(|\.recv\(/);
  });
});

/// Every `#[tauri::command]` in a file, as [name, text].
function commands(file: string): [string, string][] {
  const text = rust(file);
  const found: [string, string][] = [];
  const re = /#\[tauri::command\]\s*(?:#\[[^\]]*\]\s*|\/\/\/[^\n]*\n\s*)*pub (?:async )?fn (\w+)\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found.push([m[1], text.slice(m.index, text.indexOf("\n}\n", m.index))]);
  }
  return found;
}

// Why the daemon commands moved as ONE unit: they share each lane, so a
// command left as a plain `fn` would wait on the main thread for every
// request queued ahead of it -- the freeze moves to it rather than going
// away. So no command that reaches a lane may be a plain `fn`, and none
// may wait on the lane with the blocking `ask`.
describe("the daemon's command lanes", () => {
  const onLane = /CommandConnection|lanes_for\(|\.lanes\(/;
  const reaching = commands("session.rs").filter(([, text]) => onLane.test(text));

  it("are reached by the daemon commands at all", () => {
    expect(reaching.length).toBeGreaterThan(40);
  });

  for (const [name, text] of reaching) {
    it(`${name} awaits its lane rather than holding the main thread`, () => {
      expect(text).toContain(`pub async fn ${name}(`);
      expect(text).toMatch(WORKER_QUEUE);
      expect(text).not.toMatch(/\.ask\(|\.wait\(/);
    });
  }
});

/// Every `#[tauri::command]` in src-tauri, as [file, name, text].
function everyCommand(): [string, string, string][] {
  return Object.keys(RUST).flatMap((path) => {
    const file = path.slice(path.indexOf("/src-tauri/src/") + "/src-tauri/src/".length);
    return commands(file).map(([name, text]): [string, string, string] => [file, name, text]);
  });
}

// Building a window from a plain `fn` command deadlocks on Windows -- Tauri
// documents it on every builder, a WebView2 limitation, and names `async`
// commands as the remedy -- while on macOS the same code opens a window in
// 100-300 ms, so nothing on the machine this was written on would show it.
// Event handlers deadlock the same way, which is why this reads every
// builder in src-tauri rather than every command: one may only sit inside
// an async command. (`setup` is safe too; a window built there needs its
// own exemption here.)
describe("building a window", () => {
  const BUILDER = /\b(?:WebviewWindowBuilder|WindowBuilder|WebviewBuilder)::(?:new|from_config)\(/g;
  const COMMAND = /#\[tauri::command\]\s*(?:#\[[^\]]*\]\s*|\/\/\/[^\n]*\n\s*)*pub (async )?fn (\w+)\(/g;

  /// [file, line, the command the builder sits in (if any), whether it is async]
  const builders = Object.entries(RUST).flatMap(([path, text]) => {
    const file = path.slice(path.indexOf("/src-tauri/src/") + "/src-tauri/src/".length);
    return [...text.matchAll(BUILDER)].map((b): [string, number, string | undefined, boolean] => {
      const at = b.index;
      const line = text.slice(0, at).split("\n").length;
      const around = [...text.matchAll(COMMAND)].find((c) => c.index < at && at < text.indexOf("\n}\n", c.index));
      return [file, line, around?.[2], Boolean(around?.[1])];
    });
  });

  it("is found by reading every source file", () => {
    expect(builders.map(([, , command]) => command)).toContain("open_workspace_window");
  });

  for (const [file, line, command, isAsync] of builders) {
    it(`${file}'s ${command ?? `line ${line}`} builds its window inside an async command`, () => {
      expect(command, `the builder at ${file}:${line} is not inside a #[tauri::command]`).toBeDefined();
      expect(isAsync, `${command} builds a window as a plain \`fn\`, which deadlocks on Windows`).toBe(true);
    });
  }

  // The other half of the fix, and the half that must NOT move: an async
  // command runs on a runtime worker, and the chrome is AppKit.
  // `setWantsLayer` off the main thread leaves the new window blank.
  it("open_workspace_window still applies its AppKit chrome on the main thread", () => {
    const body = commandBody("workspace_window.rs", "open_workspace_window");
    const hop = body.indexOf("run_on_main_thread(move ||");
    expect(hop, "open_workspace_window no longer hops onto the main thread").toBeGreaterThan(-1);
    expect(body.indexOf("round_window_corners(")).toBeGreaterThan(hop);
    expect(body.indexOf("install_edge_double_click(")).toBeGreaterThan(hop);
  });
});

/// A command that hands its wait to the blocking pool -- itself, through
/// `off_main_thread`, or through git/ops.rs's `spawn_op`, the network ops'
/// one-line form of it -- or to a command lane.
function offMainThread(text: string): boolean {
  return /spawn_blocking|off_main_thread\(|spawn_op\(/.test(text) || WORKER_QUEUE.test(text);
}

// An ssh workspace's files, git and agent setup live on the host, and a
// command reaches them through a `RemoteLink` method that waits for the
// host's answer. On the main thread that is a network round trip per
// call -- and a whole deadline when the host has stopped answering, with
// the window frozen for all of it. The asking methods are read from
// remote.rs, so one added there is covered the day it is written.
describe("commands that wait on an ssh host", () => {
  const remote = rust("remote.rs");
  const asking = [...remote.matchAll(/\n    pub fn (\w+)\(\s*&self[\s\S]*?\n    \}\n/g)]
    .filter(([body]) => /self\.ask(_within)?\(/.test(body))
    .map(([, name]) => name);

  it("are found by reading remote.rs", () => {
    expect(asking).toEqual(expect.arrayContaining(["read_file", "write_file", "stat_paths", "run_git", "trash_path"]));
  });

  const reachesHost = (text: string) =>
    text.includes("RemoteFiles") ||
    (/Route::Remote\(/.test(text) && asking.some((method) => text.includes(`.${method}(`)));
  const reaching = everyCommand().filter(([, , text]) => reachesHost(text));

  it("include the file and agent commands", () => {
    expect(reaching.map(([, name]) => name)).toEqual(
      expect.arrayContaining(["write_file_for_editor", "attachment_status", "trash_entry", "setup_agent_integration"])
    );
  });

  for (const [file, name, text] of reaching) {
    it(`${file}'s ${name} waits for the host off the main thread`, () => {
      expect(text).toContain(`pub async fn ${name}(`);
      expect(offMainThread(text), `${name} is async but does its waiting inline`).toBe(true);
    });
  }

  // The Git tab's commands reach the host from underneath: `git::run`
  // routes a cwd on a host to it (`remote::run_git_over_link`), so no
  // command body says so. Every one of them is off the main thread, then,
  // but the two that only WRITE to the host's streaming connection and
  // never wait for an answer.
  const WRITE_ONLY = new Set(["git_watch", "git_unwatch"]);
  const git = everyCommand().filter(([file, name]) => file.startsWith("git/") && !WRITE_ONLY.has(name));

  it("include every git command", () => {
    expect(git.length).toBeGreaterThan(50);
  });

  // Trusted above only while it IS the blocking pool, like
  // `off_main_thread`.
  it("git/ops.rs's spawn_op hands its op to the blocking pool", () => {
    const text = rust("git/ops.rs");
    const at = text.search(/async fn spawn_op\(/);
    expect(at, "spawn_op is not an async fn in git/ops.rs").toBeGreaterThan(-1);
    expect(text.slice(at, text.indexOf("\n}\n", at))).toContain("tauri::async_runtime::spawn_blocking(");
  });

  for (const [file, name, text] of git) {
    it(`${file}'s ${name} runs its git off the main thread`, () => {
      expect(text).toContain(`pub async fn ${name}(`);
      expect(offMainThread(text), `${name} is async but runs its git inline`).toBe(true);
    });
  }
});
