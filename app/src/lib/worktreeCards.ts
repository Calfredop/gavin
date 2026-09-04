// The decoy card, and how gavin spots one.
//
// This repo tracks `.gavin-root/` in git, so every rail worktree carries
// a full copy of the board as it stood at its branch point. A rail step
// hands its agent a worktree cwd and an ABSOLUTE card path in the main
// checkout -- two different files with the same name, one of them inside
// the agent's own cwd. An agent that resolves the card relatively writes
// the wrong one, and gets no error and no signal of any kind: the board
// never moves, the step never completes, and the divergence rides the
// branch to become a merge conflict.
//
// `recover_moved_card_paths` cannot help. From the watched workspace's
// tree the card never moved, because the file that moved was in a
// checkout nobody watches.
//
// So the copy is caught the only way an unwatched file can be: by asking
// git what the RUN changed in its own checkout, against the commit that
// checkout sat on when the agent started. A card file in that list was
// written by this rail's agent -- nothing else edits a worktree -- and an
// agent has no legitimate reason to touch the board there at all.
//
// Two cheaper answers were tried and are wrong. Comparing the two files'
// CONTENTS fires constantly: a worktree branched off main days ago
// legitimately holds older copies of half the board. And a plain `git
// status` in the worktree is right only until the agent commits the
// decoy -- which is what happened in the observed case, since the
// divergence rode the branch -- and then goes quiet while the rail stays
// just as wedged. A baseline survives the commit; a working tree does
// not.
//
// Pure and path-only. The git call and the store live in
// orchestrationState.ts; everything that decides anything is here.

import { isToolStep, type Rail, type Step } from "./orchestration";

/// `path` expressed relative to `dir`, or null when it is not inside it.
///
/// String comparison, not normalisation: both sides come from the same
/// places (the gavin tree's absolute card paths, a workspace's bound
/// root) and are already absolute and already clean. A `..` walk would
/// be a caller bug worth failing on rather than quietly resolving.
export function relativeTo(path: string, dir: string): string | null {
  const base = trimSlashes(dir);
  if (!base || !path.startsWith(base + "/")) return null;
  const rest = path.slice(base.length + 1);
  return rest.length > 0 ? rest : null;
}

/// Where a rail worktree's own copy of a card lives, absolute, or null
/// when there is no such copy to speak of -- an unbound rail, or a card
/// filed outside the workspace root.
///
/// Answers the path a decoy WOULD have, not whether one exists: nothing
/// here touches the disk, and a caller that wants existence has to ask
/// git or the file host.
export function mirrorCardPath(
  cardPath: string,
  rootPath: string | null | undefined,
  worktreePath: string | null | undefined
): string | null {
  if (!rootPath || !worktreePath) return null;
  const rel = relativeTo(cardPath, rootPath);
  if (rel === null) return null;
  return `${trimSlashes(worktreePath)}/${rel}`;
}

function trimSlashes(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/// The identity of a card WITHIN its gavin context, ignoring which of
/// the context's three folders it currently sits in.
///
/// `plans/`, `plans/done/` and `plans/archive/` are one card's three
/// possible homes, and moving between them is what a status write does.
/// An agent that finished the decoy typically MOVED it -- git reports
/// that as a rename, or as a delete plus an untracked add -- so a match
/// on the literal path would miss the exact case this exists to catch.
/// Collapsing the folder keeps the match on the fact that matters: this
/// context's copy of this card file was written.
///
/// Null for a path with no `plans/` segment at all, which is not a card
/// and which the caller compares literally instead.
export function cardKey(rel: string): string | null {
  const at = rel.lastIndexOf("/plans/");
  if (at === -1) return null;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return base ? `${rel.slice(0, at)}/${base}` : null;
}

/// One changed path from a run's own checkout, in whichever spellings it
/// carries: a rename reports both the name the file had and the name it
/// now has, and only the OLD one matches the card the step was launched
/// on. Structurally `FileEntry` from git.ts, named for what it means
/// here so this module needs nothing from the Git tab's types.
export interface DirtyPath {
  path: string;
  oldPath?: string;
}

/// The step ids of `rail` whose card this rail's own worktree has been
/// written in -- the decoy edit, caught.
///
/// `dirty` is what this run changed in that checkout, repo-relative --
/// `git_run_changes` against the run's baseline, so committed and
/// uncommitted alike. Which of the two it is says nothing about the
/// mistake, only about how far the agent got.
///
/// Fails CLOSED at every unknown. No worktree, no root, a card filed
/// outside the root, a workspace root that is not the repo root -- each
/// of those simply matches nothing, because a false "your agent edited
/// the wrong file" would send the human hunting for a write that never
/// happened.
export function decoyEditedSteps(
  rail: Rail,
  rootPath: string | null | undefined,
  dirty: readonly DirtyPath[]
): Set<string> {
  const out = new Set<string>();
  if (!rail.worktreePath || !rootPath || dirty.length === 0) return out;
  // A rail bound to the MAIN checkout has no decoy: `git worktree list`
  // includes the main working tree, so this binding is offered, and in
  // it the card the agent edits IS the card. Without this the one
  // correct thing an agent can do to a card would be reported as the
  // mistake.
  if (trimSlashes(rail.worktreePath) === trimSlashes(rootPath)) return out;
  const written = new Set<string>();
  for (const entry of dirty) {
    for (const spelling of [entry.path, entry.oldPath]) {
      if (!spelling) continue;
      written.add(spelling);
      const key = cardKey(spelling);
      if (key) written.add(key);
    }
  }
  for (const step of railSteps(rail)) {
    if (isToolStep(step)) continue;
    const rel = relativeTo(step.cardPath, rootPath);
    if (rel === null) continue;
    if (written.has(rel) || written.has(cardKey(rel) ?? rel)) out.add(step.id);
  }
  return out;
}

function railSteps(rail: Rail): Step[] {
  return rail.stages.flatMap((stage) => stage.steps);
}

/// Whether a launch in `cwd` hands its agent a card that lives somewhere
/// else -- the arrangement that makes a decoy possible at all.
///
/// The question the prompt asks before it warns, and the reason the
/// warning costs nothing on a board Run: a card run in its own context
/// folder has no second copy anywhere near it, so there is nothing to
/// warn about and nothing is said.
export function cardIsOutside(cardPath: string, cwd: string | null | undefined): boolean {
  return Boolean(cwd) && relativeTo(cardPath, cwd as string) === null;
}
