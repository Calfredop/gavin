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
  // and tabs -- but one. The stores are what the desktop's components
  // read, and the handlers only record what the Workstation said. The
  // launch helpers are what a new session is made of at the desk -- the
  // agent a workspace resolves to, the profile a launch names, the
  // failure patterns it arms -- and save nothing; placing the session is
  // the action, and that is the desk's. The one action is the review
  // stamp: it saves a workspace SETTING (which cards the human has read),
  // which the Remote role may write (ADR 0006), never the layout.
  const ALLOWED = [
    // stores
    "layoutState",
    "attentionStatusById",
    "agentProfilesStore",
    "agentModelDefaultsStore",
    "agentDefaultsStore",
    "customResumeArgsDefault",
    "requireReviewDefault",
    // handlers
    "handleSessionStatusChanged",
    "handleCwdChanged",
    // launch helpers
    "resolvedAgentFor",
    "profileIdForLaunch",
    "armFailureDetection",
    // a workspace setting
    "stampCardReview",
  ];

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
    expect(importedFrom(companionSource("companion/state/sessions.ts"), "$lib/core/layoutState").sort()).toEqual(
      [
        "agentDefaultsStore",
        "agentModelDefaultsStore",
        "agentProfilesStore",
        "armFailureDetection",
        "customResumeArgsDefault",
        "layoutState",
        "profileIdForLaunch",
        "requireReviewDefault",
        "resolvedAgentFor",
      ]
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

describe("acting on a card", () => {
  const cards = () => codeOf(companionSource("companion/state/cards.ts"));

  it("launches only with the Device's host, which places nothing at the desk", () => {
    // Without a host the desk's launch flow places the session as a tab,
    // jumps the desk's view to it and queues in the desk's queue -- the
    // desk's layout and duties, from a phone.
    const calls = [...cards().matchAll(/\b(runCard|resumeCard|relaunchCard)\(([^;]*?)\);/gs)];
    expect(calls.map((c) => c[1]).sort()).toEqual(["relaunchCard", "resumeCard", "runCard"]);
    for (const [call] of calls) expect(call).toContain("DEVICE_LAUNCH_HOST");
  });

  it("archives with its own ender, which leaves the desk's tabs to the desk", () => {
    expect(cards()).toMatch(/executeArchive\([^)]*,\s*endAway\)/);
  });

  it("is reached from the phone's surfaces only through this module", () => {
    for (const [name, text] of Object.entries(companionSources())) {
      if (name === "companion/state/cards.ts" || name.endsWith(".test.ts")) continue;
      for (const module of ["cardRunActions", "archiveActions", "decisionsActions", "cardCompletion"]) {
        expect(codeOf(text), `${name} imports ${module}`).not.toContain(`/${module}"`);
      }
    }
  });

  it("answers an item with the Decisions tab's own row", () => {
    const page = codeOf(companionSource("companion/surfaces/PhoneCard.svelte"));
    expect(page).toContain('import DecisionsItemRow from "$lib/decisions/DecisionsItemRow.svelte"');
    expect(page).toContain("<DecisionsItemRow");
  });
});

describe("the terminal surface", () => {
  const terminal = () => codeOf(companionSource("companion/surfaces/PhoneTerminal.svelte"));

  it("draws the desktop's own terminal, on the desktop's registry", () => {
    expect(terminal()).toContain('import TerminalPane from "$lib/terminal/TerminalPane.svelte"');
    expect(terminal()).toContain("<TerminalPane");
  });

  it("types through the dock's modules, not bytes of its own", () => {
    expect(terminal()).not.toMatch(/\\x1b|\\u001b|\\r/);
    expect(terminal()).not.toContain("backend.writeInput");
  });

  it("lets its terminal go when it closes, so no screen nobody sees keeps streaming", () => {
    expect(terminal()).toContain("destroyTerminal(sessionId)");
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
