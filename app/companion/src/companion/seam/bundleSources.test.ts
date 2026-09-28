// What the bundle's own code may not do, read off its source.
//
// The wire suites prove what is never SENT. These keep the code from
// reaching for the means in the first place, and they cover the one part
// no suite mounts: the templates. Like the desktop's own surface guards
// they read text, because drawing a surface needs a page.
import { describe, expect, it } from "vitest";
import { codeOf, companionSource, companionSources } from "$companion/testing/companionSources";

/// What `import { ... } from "<module>"` names in one source.
function importedFrom(text: string, module: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${module.replace(/[$/]/g, "\\$&")}"`, "g");
  for (const match of text.matchAll(pattern)) {
    for (const name of match[2].split(",")) {
      const bare = name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (bare) names.push(bare);
    }
  }
  return names;
}

describe("what the bundle takes from the desktop's layout state", () => {
  // Every ACTION that module exports ends in a save of the desk's pages
  // and tabs. The stores are what the desktop's components read, and the
  // two handlers only record what the Workstation said.
  const ALLOWED = ["layoutState", "attentionStatusById", "handleSessionStatusChanged"];

  it("is its stores and its handlers, never its actions", () => {
    const taken = Object.entries(companionSources()).flatMap(([name, text]) =>
      importedFrom(codeOf(text), "$lib/core/layoutState")
        .filter((imported) => !ALLOWED.includes(imported))
        .map((imported) => `${name}: ${imported}`)
    );
    expect(taken).toEqual([]);
  });

  it("is never the whole module", () => {
    const whole = Object.entries(companionSources())
      .filter(([, text]) => /import\s+\*\s+as\s+\w+\s+from\s+"\$lib\/core\/layoutState"/.test(codeOf(text)))
      .map(([name]) => name);
    expect(whole).toEqual([]);
  });

  it("is read by this guard in the file that takes the most", () => {
    expect(importedFrom(companionSource("companion/state/workstation.ts"), "$lib/core/layoutState").sort()).toEqual(
      ["handleSessionStatusChanged", "layoutState"]
    );
  });
});

describe("what the bundle builds when its modules load", () => {
  // The card's second trap: a module-level `derived` over a layoutState
  // export is evaluated at import, so every suite that mocks that module
  // partially breaks on a store it did not supply. The surfaces derive in
  // the component instead, where the store is only read once it is drawn.
  it("is no store derived from the desktop's", () => {
    const derivers = Object.entries(companionSources())
      .filter(([name]) => name.endsWith(".ts"))
      .filter(([, text]) => /\bderived\s*\(/.test(codeOf(text)))
      .map(([name]) => name);
    expect(derivers).toEqual([]);
  });
});

describe("the board surface", () => {
  const board = () => codeOf(companionSource("companion/surfaces/PhoneBoard.svelte"));

  it("draws the desktop's own card", () => {
    expect(board()).toContain('import BoardCard from "$lib/board/BoardCard.svelte"');
    expect(board()).toContain("<BoardCard");
  });

  it("gives the card no workspace, which is what gives it no controls", () => {
    // With a workspace id the desk's card draws its session badge as a
    // button that jumps to the session -- moving the desk's tabs -- and
    // offers Run. Without one it is the card the desk draws in previews.
    expect(board()).toContain("workspaceId={null}");
  });

  it.each(["onRun", "onSendToAgent", "onDelete", "onContextMenu"])("hands the card no %s", (prop) => {
    expect(board()).not.toMatch(new RegExp(`\\b${prop}\\b`));
  });

  it("takes nothing from the modules that act on a card", () => {
    for (const module of ["cardRunActions", "cardDelete", "kanbanDragGlue", "archiveActions"]) {
      expect(board()).not.toContain(module);
    }
  });
});

describe("the page", () => {
  const page = () => codeOf(companionSource("routes/+page.svelte"));

  it("connects through the bundle's own way in", () => {
    expect(page()).toContain("connectWorkstation(");
    expect(page()).toContain("openChannel(");
  });

  it("draws under a boundary, so a surface that throws says so", () => {
    // A throw while a branch is created leaves the OLD branch on screen
    // and logs nothing (the desktop's viewBoundary guard has the whole
    // story). On a phone there is no console to look in either.
    expect(page()).toContain("<svelte:boundary");
    expect(page()).toContain("{#snippet failed(");
  });
});
