import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

// The static pre-flight the card asks for: the strings a change relies
// on, grepped against the committed source. The rendered pass is the
// owner's, in the running app.
const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the Git tab's commit detail pane", () => {
  it("names the card, or the candidates, and opens it from the title", () => {
    const s = source("GitCommitDetail.svelte");
    expect(s).toContain('"Card:"');
    expect(s).toContain('"Possibly:"');
    expect(s).toContain("askCommitCardLink(workspaceId, sha, state,");
    expect(s).toContain("<CardDetailModal");
    expect(s).toContain("openCardPath = c.path");
  });

  it("asks about the selected commit only, never the log", () => {
    // The graph draws hundreds of rows; a request per row would be a
    // request for nothing the human is looking at.
    expect(source("GitGraph.svelte")).not.toMatch(/commitCardLink/);
    expect(source("gitState.ts")).not.toMatch(/commitCardLink/);
    const s = source("GitCommitDetail.svelte");
    expect(s).toContain("if (sha && commit && detail) {");
    expect(s).toContain("clearCommitCardLink(workspaceId)");
  });

  it("shows a slot only for the commit on screen, and never while pending", () => {
    const s = source("GitCommitDetail.svelte");
    expect(s).toContain('linkSlot.key === sha && linkSlot.entry.state === "read"');
  });
});

describe("the board's search", () => {
  it("offers the closest cards only under a board the search emptied", () => {
    const s = source("KanbanBoard.svelte");
    expect(s).toContain("Closest by meaning:");
    expect(s).toContain("!showingArchive && searching && view !== null && view.shown === 0");
    expect(s).toContain("(faceted?.shown ?? 0) > 0");
    expect(s).toContain("clearCardsByMeaning(workspaceId)");
    expect(s).toContain('meaningSlot?.key === search && meaningSlot.entry.state === "read"');
  });

  it("leaves the lexical matcher as the first and only answer", () => {
    // The lens itself is untouched: TypeSafe is asked after it answered
    // nothing, never beside what it found.
    expect(source("boardSearch.ts")).not.toMatch(/commitCardLink|typesafe/i);
    expect(source("search.ts")).not.toMatch(/commitCardLink|typesafe/i);
  });
});

describe("the settings copy", () => {
  it("says what the card link sends, where, and that it never writes a link", () => {
    const s = source("GlobalSettingsView.svelte");
    expect(s).toContain("The same switch links commits and searches to cards.");
    expect(s).toContain("commit's message and changed file paths");
    expect(s).toContain("title of every card on the board");
    expect(s).toContain("Never a diff, a card's body");
    expect(s).toContain("A link is shown, never written to a card or a commit.");
    // Findable by what it does, not only by the turn verdict's name.
    expect(s).toContain('"closest by meaning"');
    expect(s).toContain('"card link"');
  });
});

describe("the pure module", () => {
  it("pins the model through the one pin, keeps the E5 question verbatim, and never sends the request itself", () => {
    const s = source("commitCardLink.ts");
    expect(s).toContain('import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict"');
    expect(s).not.toContain('"jev-latest"');
    expect(s).toContain("CARD_LINK_MIN_CONFIDENCE = 0.75");
    expect(s).toContain("CANDIDATE_COUNT = 3");
    expect(s).toContain("MAX_CARD_OPTIONS = 254");
    expect(s).toContain("Which card was this commit made for?");
    expect(s).toContain("The commit does not belong to any of these cards.");
    expect(s).not.toMatch(/\bfetch\(|invoke\(|from "\$lib\/core\/backend"/);
  });

  it("sends titles and never a card's path or body", () => {
    const s = source("commitCardLink.ts");
    expect(s).toContain("criteria[o.key] = o.card.title;");
    expect(s).not.toMatch(/criteria\[[^\]]*\]\s*=\s*o\.card\.(path|body)/);
  });
});

describe("the driver", () => {
  it("is gated on the turn verdict's own switch and carries no second key", () => {
    const s = source("commitCardLinkState.ts");
    expect(s).toContain('from "$lib/agents/turnVerdictState"');
    expect(s).toContain("settings?.enabled === true && settings.hasKey === true");
    expect(s).toContain("backend.typesafeVerdict(");
    expect(s).not.toMatch(/apiKey|api_key/);
  });

  it("writes nothing the app persists", () => {
    // Suggest, never record: the two stores are plain writables and no
    // backend write is reachable from here.
    const s = source("commitCardLinkState.ts");
    expect(s).not.toMatch(/backend\.(?!typesafeVerdict\b)/);
    expect(s).not.toMatch(/setPlanField|writePlan|persist/);
  });
});
