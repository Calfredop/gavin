// What the Demo Workstation answers to the Git tab's commands.
//
// The same names and argument shapes `backend.ts` sends to the desktop
// host (`app/src-tauri/src/git`), each answering over repo.ts. A command
// that changes the repository streams what git would print as
// `git-op-progress` for the op that asked (when it carries an `opId`),
// and then tells every watcher, as the host's watchers do.
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import * as git from "$companion/demo/repo";
import type { DemoRepo, Progress } from "$companion/demo/repo";
import { announceFiles, announceRepo, repoHolding, unwatch, watch } from "$companion/demo/watches";

/// What `git_repo_info` says about a folder that is in no repository: an
/// answer, not an error, so the tab can offer to initialize one.
const NOT_A_REPO: Answer<"gitRepoInfo"> = {
  notARepo: true,
  root: null,
  branch: null,
  detached: false,
  unborn: false,
  author: null,
  headMessage: null,
  inProgress: null,
};

function repoAt(args: Record<string, unknown>, demo: DemoContext): DemoRepo {
  const cwd = text(args, "cwd");
  const repo = repoHolding(demo, cwd);
  if (!repo) throw new DemoFailure(`fatal: not a git repository: ${cwd}`);
  return repo;
}

function flag(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

function paths(args: Record<string, unknown>): string[] {
  const value = args.paths;
  if (!Array.isArray(value) || !value.every((p) => typeof p === "string")) {
    throw new DemoFailure('missing argument "paths"');
  }
  return value;
}

/// Runs one change to a repository the way the host runs a git command:
/// its progress to the op that asked, then the news to every watcher.
function change(
  args: Record<string, unknown>,
  demo: DemoContext,
  act: (repo: DemoRepo, files: Record<string, string>) => Progress | void
): null {
  const repo = repoAt(args, demo);
  const before = { ...demo.state.files };
  const progress = act(repo, demo.state.files) ?? [];
  const opId = args.opId;
  if (typeof opId === "string") {
    for (const line of progress) demo.emit("git-op-progress", { opId, line });
  }
  announceFiles(demo, before);
  announceRepo(demo, repo);
  return null;
}

export const GIT_COMMANDS: Record<string, DemoCommand> = {
  git_repo_info: (args, demo): Answer<"gitRepoInfo"> => {
    const repo = repoHolding(demo, text(args, "cwd"));
    return repo ? git.repoInfo(repo) : NOT_A_REPO;
  },
  git_status: (args, demo): Answer<"gitStatus"> => git.status(repoAt(args, demo), demo.state.files),
  git_refs: (args, demo): Answer<"gitRefs"> => git.refs(repoAt(args, demo)),
  git_diff: (args, demo): Answer<"gitDiff"> =>
    git.diff(repoAt(args, demo), demo.state.files, text(args, "path"), {
      staged: flag(args, "staged"),
      untracked: flag(args, "untracked"),
      rev: typeof args.rev === "string" ? args.rev : null,
    }),
  // The sidebar's chip for each session's checkout: null for a cwd in no
  // repository, as the host answers.
  get_git_baselines: (args, demo): Answer<"getGitBaselines"> =>
    (Array.isArray(args.cwds) ? args.cwds : []).map((cwd) => {
      const repo = typeof cwd === "string" ? repoHolding(demo, cwd) : null;
      return repo ? git.chip(repo, demo.state.files) : null;
    }),
  // No merge tool is configured on the demo's machine.
  git_merge_tool_name: (args, demo): Answer<"gitMergeToolName"> => {
    repoAt(args, demo);
    return null;
  },

  git_watch: (args, demo) => {
    watch(demo, "git", text(args, "cwd"));
    return null;
  },
  git_unwatch: (args, demo) => {
    unwatch(demo, "git", text(args, "cwd"));
    return null;
  },

  git_stage_files: (args, demo) => change(args, demo, (repo, files) => git.stage(repo, files, paths(args))),
  git_unstage_files: (args, demo) => change(args, demo, (repo) => git.unstage(repo, paths(args))),
  git_stage_all: (args, demo) => change(args, demo, (repo, files) => git.stageAll(repo, files)),
  git_unstage_all: (args, demo) => change(args, demo, (repo) => git.unstageAll(repo)),
  git_commit: (args, demo) =>
    change(args, demo, (repo) => git.commit(repo, text(args, "message"), flag(args, "amend"))),

  git_fetch: (args, demo) => change(args, demo, (repo) => git.fetch(repo, text(args, "remote"))),
  git_pull: (args, demo) => change(args, demo, (repo, files) => git.pull(repo, files)),
  git_push: (args, demo) => change(args, demo, (repo) => git.push(repo, text(args, "remote"))),
  // Every demo op has finished by the time its answer is sent, so there
  // is never one left to stop.
  git_cancel_op: (): Answer<"gitCancelOp"> => false,

  git_checkout: (args, demo) =>
    change(args, demo, (repo, files) =>
      git.checkout(repo, files, text(args, "name"), typeof args.trackRemote === "string" ? args.trackRemote : null)
    ),
  git_create_branch: (args, demo) =>
    change(args, demo, (repo, files) =>
      git.createBranch(
        repo,
        files,
        text(args, "name"),
        typeof args.from === "string" ? args.from : null,
        flag(args, "checkout")
      )
    ),
  git_merge: (args, demo) => change(args, demo, (repo, files) => git.merge(repo, files, text(args, "branch"))),
};
