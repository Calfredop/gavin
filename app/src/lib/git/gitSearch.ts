// The Git tab's list filters. Thin projections over search.ts -- they
// exist so the fields each list is searchable ON are stated once, in
// one testable place, rather than inline in four components.

import { filterList, matchesFields, queryTokens } from "$lib/core/search";
import type { BranchInfo, FileEntry, RemoteInfo, StashInfo } from "$lib/git/git";

/// Changed files. A rename matches on BOTH of its paths -- searching for
/// where a file used to live has to find it.
export function filterFiles(files: FileEntry[], query: string): FileEntry[] {
  return filterList(files, query, (f) => [f.path, f.oldPath]);
}

export function filterBranches(branches: BranchInfo[], query: string): BranchInfo[] {
  return filterList(branches, query, (b) => [b.name, b.upstream, b.subject]);
}

/// A remote whose own name or url matches keeps all of its branches; one
/// that matches only through a branch narrows to those branches. Same
/// rule the board uses for a plan and its nested children.
export function filterRemotes(remotes: RemoteInfo[], query: string): RemoteInfo[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return remotes;
  const out: RemoteInfo[] = [];
  for (const remote of remotes) {
    if (matchesFields(tokens, [remote.name, remote.url])) {
      out.push(remote);
      continue;
    }
    const branches = remote.branches.filter((b) => matchesFields(tokens, [`${remote.name}/${b}`]));
    if (branches.length > 0) out.push({ ...remote, branches });
  }
  return out;
}

export function filterStashes(stashes: StashInfo[], query: string): StashInfo[] {
  return filterList(stashes, query, (s) => [s.message, `stash@{${s.index}}`]);
}
