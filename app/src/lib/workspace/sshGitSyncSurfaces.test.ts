import { describe, it, expect } from "vitest";
import { allSources } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

// `FEATURE_MIN_VERSION.sshGitSync` gates the parts of the Git tab and
// Files tree that need the HOST daemon to run a git op of its own, watch
// its own worktree, or change its own tree (v42,
// `2026-09-23-ssh-git-sync-and-conflicts-design.md`).
//
// An entry with no consumer is a dead gate -- the trap daemonCompat.ts's
// own comments keep returning to -- and here the failure is loud in one
// direction and silent in the other. A sync button left enabled against
// a v41 host sends a request that daemon answers `Unsupported`, which is
// an error the human can read. A tree that offers New file and gets the
// same is the same. What nothing would catch is the OPPOSITE mistake:
// reading the tab gate and the sync gate as one, which would close a
// working Git tab on a v41 host or hide the ignore action that now
// works. So both halves of the split are asserted.
//
// Reads sources rather than the rendered DOM, following the other
// surface guards here: mounting the Git tab needs a daemon, a link and a
// repository.

const SOURCES = allSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the entry itself", () => {
  it("is the protocol version the streaming and tree requests landed in", () => {
    expect(FEATURE_MIN_VERSION.sshGitSync).toBe(42);
    // Strictly above the tab gate: that is the whole point of a second
    // entry, and equal numbers would make one of them unnecessary.
    expect(FEATURE_MIN_VERSION.sshGitSync).toBeGreaterThan(FEATURE_MIN_VERSION.sshGitFiles);
  });

  it("is read through sshSyncBlocked, which shares the other gates' evidence", () => {
    const text = source("sshWorkspace.ts");
    expect(text).toContain("export function sshSyncBlocked");
    // Through the shared helper, so the link-down and version wording is
    // one sentence for all three gates rather than three.
    expect(text).toContain("FEATURE_MIN_VERSION.sshGitSync");
    expect(text).toMatch(/sshSyncBlocked[\s\S]{0,200}sshFeatureBlocked\(ws, links, FEATURE_MIN_VERSION\.sshGitSync/);
  });
});

describe("the Git toolbar's sync buttons", () => {
  const TOOLBAR = "GitToolbar.svelte";

  it("disables fetch, pull and push on the gate rather than on being remote", () => {
    const text = source(TOOLBAR);
    expect(text).toContain("sshSyncBlocked(");
    // All three buttons, and the tip says why rather than going blank.
    expect(text.match(/disabled=\{locked \|\| !sync\.\w+ \|\| syncBlocked !== null\}/g)).toHaveLength(3);
    expect(text.match(/tip=\{syncBlocked \?\?/g)).toHaveLength(3);
  });

  it("no longer claims the ops are unavailable, because they are not", () => {
    // The hard-coded sentence the Git-tab card left behind. It outlived
    // its truth the moment RunGitStreaming landed, and a stale "not
    // available yet" on a working button is worse than no message.
    expect(source(TOOLBAR)).not.toContain("aren't available yet");
  });
});

describe("the two surfaces that set GIT_EDITOR", () => {
  // Cherry-pick and `<op> --continue` are the only callers of
  // `run_git_env`, which is its own request (`RunGitEnv`, v42) precisely
  // so a v41 host cannot drop the environment and hang the op on an
  // editor. That makes them the one part of the Git tab that needs the
  // newer host while everything around them does not.

  it("greys out cherry-pick with the reason rather than failing on click", () => {
    const text = source("GitGraph.svelte");
    expect(text).toContain("sshSyncBlocked(");
    expect(text).toContain("disabled: locked || c.isHead || syncBlocked !== null");
    // The label carries the reason: a context-menu item has no tooltip
    // to put it in.
    expect(text).toContain("syncBlocked ? `Cherry-pick onto ${cur} — ${syncBlocked}`");
  });

  it("greys out Continue with the reason, and leaves Abort alone", () => {
    const text = source("GitHubView.svelte");
    expect(text).toContain("const syncBlocked = $derived(sshSyncBlocked(ws, $sshLinks));");
    expect(text).toContain("disabled={busy || conflicts || syncBlocked !== null}");
    expect(text).toContain("use:tooltip={syncBlocked ??");
    // Abort is a plain `run_git`, so it works wherever the tab does.
    expect(text).toContain('<button type="button" class="banner-act danger" disabled={busy}');
  });
});

describe("the Files tree's menu", () => {
  const FILES = "FilesHubView.svelte";

  it("keeps new, rename and trash behind the v42 gate", () => {
    const text = source(FILES);
    expect(text).toContain("sshSyncBlocked(wsForSsh, $sshLinks) !== null");
    for (const callback of ["onNewFile", "onNewFolder", "onRename", "onTrash"]) {
      expect(text).toMatch(new RegExp(`${callback}: sshReadOnly`));
    }
  });

  it("offers the ignore action wherever the tab itself works", () => {
    // It reaches `ignore.rs`, which routes through the v40 file requests
    // -- so it needs nothing the rest of the tab does not already have.
    // The 2026-09-22 audit filed this as an ungated action; the fix was
    // the routing, not a gate.
    expect(source(FILES)).toContain("onIgnore: (kind, pattern) =>");
  });

  it("still renders its content on a host the sync gate blocks", () => {
    // The tab's own gate is the tab's own: reading the sync one here
    // would black out a Git tab that works.
    const text = source(FILES);
    expect(text).toContain("sshTabBlocked(wsForSsh, $sshLinks)");
    expect(text).toContain("{#if sshBlocked}");
  });
});
