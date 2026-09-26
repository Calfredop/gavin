# Worktrees live in `.gavin-worktrees`, inside the workspace

For the `feat-gavin-worktrees` card. Supersedes G11
(`brainstorms/2026-08-20-git-tab-brainstorm.md`), which put every fork in a
sibling folder `../<repo>-<branch>` and recorded no reason beyond "recommended".

## Why the sibling default had to go

A worktree per rail is cheap, so a workspace that has run for a week leaves a
dozen `<repo>-<branch>` folders in whatever directory the repo sits in, mixed
in with the human's other projects. That folder belongs to the human, not to
the workspace: gavin cannot sweep it and nothing on screen explains it.

## Decision

Every worktree gavin cuts lands at `<workspace root>/.gavin-worktrees/<folder>`,
where `<folder>` is the branch with each `/` written as `-`. The workspace
root, not the git root: they differ for a monorepo opened at a package folder,
and the forks belong inside the folder the human opened (`worktreesAnchor`,
`app/src/lib/git/git.ts`). The fork dialog, which rail binding and the Git
tab's switcher share, and Best-of-N all propose it. The orchestrate skill cuts
there by hand.

## Keeping it out of git: the folder ignores itself

Before the first `git worktree add` into it, the host writes
`.gavin-worktrees/.gitignore` holding `*` (`prepare_worktrees_dir`,
`app/src-tauri/src/git/commands.rs`). The skill's snippet writes the same
file. `*` matches the `.gitignore` itself too, so the folder vanishes from
`git status`.

Without it the enclosing checkout lists `.gavin-worktrees/` as untracked, and
`git add -A` stages each worktree as an embedded repository: a gitlink the next
commit hands to everyone (verified: git prints "adding embedded git
repository").

Rejected:

- **A line in the root `.gitignore`.** That file is tracked, so the line is a
  change on every branch that lacks it. It is the pollution the card names.
- **`.git/info/exclude`.** Repository state outside the folder. It outlives the
  folder, and an agent cutting a worktree by hand would have to locate the
  common git dir first.

The folder's own file holds on every branch and at any depth, changes nothing
tracked, and is deleted with the folder. An existing one is never rewritten.

Over ssh it is written on the host through `read_repo_file`/`write_repo_file`,
the same route `ignore.rs` uses.

## Keeping it out of the watchers

- **The `.gavin*` tree watcher** needs nothing. `scan_root` and
  `tree_relevant` match `.gavin` and `.gavin-root` exactly and skip every
  other dot directory. So a nested worktree's own `.gavin-root` is never
  listed as a second copy of every card, and never rescans the tree. The
  name starts with `.gavin` because the folder is gavin's, and a
  `starts_with(".gavin")` in either function would break both guarantees.
  `a_nested_worktree_is_neither_scanned_nor_tree_relevant` pins it.
- **The git watchers** (`is_relevant`, desktop and daemon copies) skip a
  `.gavin-worktrees` component at any depth. Otherwise every build an agent
  runs in a worktree would refresh the main checkout's Git tab. A worktree
  gets its own watcher when a Git tab looks at it.
- **Change attribution** (`coTenants`) stops counting a session inside
  `.gavin-worktrees` as a tenant of the checkout above it. Deeper in the tree
  is not the same working tree.
- **The daemon's RepoPoller** (`setup_filesystem_watch`, `server.rs`) skips
  the folder when it registers watches and drops batches made only of its
  churn, so the sidebar's git status doesn't recheck on every worktree build.

## Keeping it out of the card gates

`is_plans_dir`, `confine_card_path` and promote used to accept any parent
named `.gavin*`. A worktree folder for a branch called `plans`, `docs` or
`specs` would have made its whole checkout card-shaped, so a status write
could file its README under `done/`. They now match the two marker names
exactly (`is_marker_dir`), the same as the scan.

If the self-ignore ever goes missing, git reports a worktree as one
untracked entry of the main checkout. Run changes never lists such an
entry, and Discard skips one it is handed and reports it rather than
trashing it.

## Known consequences

- **Claude Code reads the workspace's `CLAUDE.md` in a worktree agent too**
  (card `fix-worktree-agents-load-the-workspace-claude-md`).
  Its memory walk goes from the cwd up to `/`, so an agent in
  `<root>/.gavin-worktrees/x` loads its branch's `CLAUDE.md` and the main
  checkout's. A sibling worktree never saw the second one. Codex, Gemini and
  opencode stop at the git root, which for a linked worktree is the worktree
  itself. Claude Code's own `--worktree` nests at `.claude/worktrees/` and has
  the same double load. The documented escape is `claudeMdExcludes` in the
  worktree's `.claude/settings.local.json`. That is a Claude-specific file in
  every worktree, and it only stays out of `git status` where the machine's
  global ignore covers it, so it is filed as its own card, not done here.
- **Node module resolution walks up too.** In a repo with a root-level
  `node_modules`, a worktree whose setup has not run yet resolves packages
  from the main checkout's. This repo keeps them in `app/`, so it is not
  affected. `[worktree] setup` is the answer.
- **On Linux** the main checkout's recursive git watches still register an
  inotify watch for every directory under the folder, even though they drop
  its events (card `perf-linux-git-watch-registers-nested-worktrees`).
- **The removal wizard and the Files tab** treat the folder as ordinary
  content (card `fix-workspace-surfaces-ignore-gavin-worktrees`).
- **`git clean -fdx` in the main checkout** skips each worktree ("Would skip
  repository") but deletes `.gavin-worktrees/.gitignore`, so the worktrees
  show as untracked until the next fork writes it back. `git clean -ffdx`
  deletes the worktrees too, the same as for Claude Code's nested ones.
