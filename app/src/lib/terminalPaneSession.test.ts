import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// TerminalPane binds its session ONCE, in onMount: that is where it asks
// the registry for the session's Terminal and appends the registry's
// long-lived container into its own mount point. Nothing re-reads
// `sessionId` afterwards, by design -- the container has to survive a
// tree-shape remount with its scrollback intact, which is the whole
// reason the registry outlives the panes.
//
// The consequence is a contract every call site owes it: a TerminalPane
// must be RECREATED when the session it shows changes, never handed a new
// id in place. Hand it a new id and the pane keeps the old session's
// terminal on screen while `fit()` reports that terminal's measurements
// to the new session -- the second workspace's agent resized to a
// geometry its program never drew for, repainting over the first one's
// screen.
//
// Nothing in the type system says that, and the failure renders
// perfectly: both call sites compile, and the one that is wrong looks
// exactly like the one that is right until two sessions exist at once.
// So the rule is pinned here, on the sources, the way hubTabBar.test.ts
// and autoCommitSurfaces.test.ts pin theirs.

const SOURCES = svelteSources();

/// The open block tags enclosing `index`, outermost first, as written --
/// `each leaf.tabs as sessionId (sessionId)`, `key sessionId`, `if x`.
/// A real stack rather than "look at the preceding 400 characters":
/// what makes a call site safe is the block it is INSIDE, and a
/// `{#key sessionId}` that closed above it reads the same to a
/// neighbourhood grep while doing nothing at all.
function enclosingBlocks(source: string, index: number): string[] {
  const stack: string[] = [];
  const tag = /\{([#/])(\w+)([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(source)) !== null) {
    if (m.index >= index) break;
    if (m[1] === "#") stack.push(`${m[2]}${m[3]}`.trim());
    else stack.pop();
  }
  return stack;
}

/// Whether a block re-creates its contents when `sessionId` changes: a
/// `{#key sessionId}`, or an `{#each}` keyed by it (Svelte destroys and
/// rebuilds a keyed item when its key changes).
function rebuildsOnSessionChange(block: string): boolean {
  return /^key\s+sessionId$/.test(block) || /^each\b.*\(sessionId\)$/.test(block);
}

function callSites(): { file: string; index: number }[] {
  const sites: { file: string; index: number }[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (path.endsWith("/TerminalPane.svelte")) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf("<TerminalPane", from);
      if (at === -1) break;
      sites.push({ file: path.replace("./", ""), index: at });
      from = at + 1;
    }
  }
  return sites;
}

describe("every TerminalPane call site", () => {
  it("exists -- a rule with nothing to check has stopped being a rule", () => {
    expect(callSites().length).toBeGreaterThan(0);
  });

  it("is rebuilt when the session it shows changes", () => {
    const unkeyed = callSites().filter(({ file, index }) => {
      const blocks = enclosingBlocks(SOURCES[file], index);
      return !blocks.some(rebuildsOnSessionChange);
    });
    expect(unkeyed.map((s) => s.file)).toEqual([]);
  });
});
