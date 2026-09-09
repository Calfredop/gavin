import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// Both dialogs that cut git a branch or a worktree used to hand a
// refusal to the Git tab's error banner and keep themselves open:
//
//     if (!ok) return; // the error banner shows git's message
//
// That banner is on screen for exactly one of the fork dialog's three
// callers. From an orchestration rail, or from a card, git's refusal
// reached nobody and the button read as dead -- which is why the real
// throw fixed in 6840202 went unseen for as long as it did.
//
// A `$state` error line, an `$effect` and a try/catch around a callback
// are none of them reachable from the pure suite, so this pins the
// wiring in the source the way railBranchSeed.test.ts does.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const FORK = "GitForkDialog.svelte";
const BIND = "RailBindDialog.svelte";

describe("the fork dialog says why it failed", () => {
  it("shows git's message itself instead of delegating to a banner", () => {
    const s = source(FORK);
    expect(s).toContain("let submitError = $state<string | null>(null);");
    expect(s).toMatch(/if \(!forked\.ok\) \{\s*submitError = forked\.error;\s*return;\s*\}/);
    expect(s).toContain('{#if submitError}<div class="err" role="alert">{submitError}</div>{/if}');
    // The comment that stated the old assumption, and the assumption.
    expect(s).not.toContain("the error banner shows git's message");
  });

  it("clears the last message when a new attempt starts", () => {
    // Otherwise a second Create shows the first one's refusal for as
    // long as git takes to answer.
    expect(source(FORK)).toMatch(/submitting = true;\s*submitError = null;/);
  });

  it("guarantees its own git view rather than only reporting the lack of one", () => {
    const s = source(FORK);
    // No view means every mutation is refused before it reaches git, and
    // that refusal has nowhere to file itself -- the one path that used
    // to say nothing anywhere.
    expect(s).toContain("ensureGitView(workspaceId, gavinRoot);");
    expect(s).toContain("void refreshGit(workspaceId);");
    // Only when there is none: the Git tab's own switcher opens this
    // dialog pointed at whatever worktree the human last chose, and
    // ensureGitView resets a view whose cwd differs.
    expect(s).toMatch(/if \(!gavinRoot \|\| \$gitStore\[workspaceId\]\) return;/);
  });

  it("lets the setup session run even when the step before it rejects", () => {
    const s = source(FORK);
    // `void submit()` dropped a rejection, which is how a fork could
    // leave a worktree with no binding AND no setup session. The catch
    // is around the callback alone; the session is outside it.
    expect(s).toMatch(
      /try \{\s*await onPicked\?\.\(path\);\s*\} catch \(e\) \{\s*reportAfterCreate\([^)]*\);\s*\}\s*\/\/[^]*?if \(run\) onRunInWorktree\(path, run\.line\);/
    );
    // Nothing on screen to put it in by then -- the dialog closed itself
    // before these ran -- so it goes to an alert, unawaited so the
    // session does not wait behind a modal.
    expect(s).toContain("void showAlert({");
    expect(s).not.toContain("await showAlert(");
  });

  it("keeps a backstop on the one call that can only void the promise", () => {
    expect(source(FORK)).toMatch(/void submit\(\)\.catch\(\(e\) => \{/);
    expect(source(FORK)).not.toContain("e.preventDefault(); void submit(); }");
  });
});

describe("the rail bind dialog's own branch form", () => {
  it("shows git's refusal in the form rather than in a tab nobody is on", () => {
    const s = source(BIND);
    expect(s).toContain("let createError = $state<string | null>(null);");
    expect(s).toMatch(/if \(!created\.ok\) \{\s*createError = created\.error;\s*return;\s*\}/);
    expect(s).toContain('{#if createError}<div class="err" role="alert">{createError}</div>{/if}');
    expect(s).not.toContain("the Git tab's error banner carries git's message");
  });

  it("reports a branch that was made but could not be bound", () => {
    // Half done is not done: closing the form here would report the
    // binding as landed when only the branch exists.
    expect(source(BIND)).toMatch(/catch \(e\) \{[^]*?createError = `Created \$\{name\}, but binding it/);
  });

  it("opens the form on a clean slate", () => {
    expect(source(BIND)).toMatch(/function startNaming\(\): void \{\s*draftBranch = seedBranch;\s*createError = null;/);
  });
});
