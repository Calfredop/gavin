import { describe, it, expect } from "vitest";
import {
  CANDIDATE_COUNT,
  CARD_LINK_MIN_CONFIDENCE,
  COMMIT_BODY_CHARS,
  COMMIT_FILE_PATHS,
  COMMIT_INSTRUCTIONS,
  COMMIT_NONE,
  MAX_CARD_OPTIONS,
  SEARCH_INSTRUCTIONS,
  SEARCH_NONE,
  cardOptions,
  commitLinkRequest,
  commitState,
  linkableCards,
  linkedCards,
  parseCardAnswer,
  readCardLink,
  searchLinkRequest,
  type CardOption,
  type LinkableCard,
} from "$lib/git/commitCardLink";
import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";

function plan(path: string, title: string, modifiedAt?: number | null): PlanFileInfo {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    title,
    status: null,
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    modifiedAt,
  };
}

function tree(plans: PlanFileInfo[], rootMissing = false): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing,
    contexts: [
      {
        folderPath: "/ws/.gavin-root",
        kind: "root",
        name: "root",
        plans,
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function card(path: string, title: string, modifiedAt: number | null = null): LinkableCard {
  return { path, title, modifiedAt };
}

const GIT_TAB = card("/ws/.gavin-root/plans/git-tab.md", "Git tab: history graph", 30);
const LOGIN = card("/ws/.gavin-root/plans/done/login.md", "Fix the login flow", 20);
const KANBAN = card("/ws/.gavin-root/plans/kanban-drag.md", "Kanban drag bug", 10);
const THREE = [GIT_TAB, LOGIN, KANBAN];

// A response body in TypeSafe's own shape, so every policy test goes
// through the real parser rather than hand-building the normalised
// answer.
function body(choice: string, confidence: number, probabilities?: Record<string, number>) {
  return {
    model: TYPESAFE_MODEL,
    answers: {
      card: {
        type: "choice",
        choice,
        ...(probabilities ? { probabilities } : {}),
        confidence,
      },
    },
    usage: { input_tokens: 2412, output_tokens: 9 },
  };
}

function read(choice: string, confidence: number, probabilities?: Record<string, number>, options: CardOption[] = cardOptions(THREE)) {
  return readCardLink(parseCardAnswer(body(choice, confidence, probabilities), options), options);
}

describe("linkableCards", () => {
  it("lists the open board and plans/done/, never plans/archive/", () => {
    const cards = linkableCards(
      tree([
        plan("/ws/.gavin-root/plans/a.md", "Open card", 3),
        plan("/ws/.gavin-root/plans/done/b.md", "Done card", 2),
        plan("/ws/.gavin-root/plans/archive/c.md", "Archived card", 1),
      ])
    );
    expect(cards).toEqual([
      { path: "/ws/.gavin-root/plans/a.md", title: "Open card", modifiedAt: 3 },
      { path: "/ws/.gavin-root/plans/done/b.md", title: "Done card", modifiedAt: 2 },
    ]);
  });

  it("is empty with no tree or a missing root", () => {
    expect(linkableCards(undefined)).toEqual([]);
    expect(linkableCards(tree([plan("/ws/.gavin-root/plans/a.md", "A")], true))).toEqual([]);
  });

  it("normalises an undated card to null", () => {
    const [only] = linkableCards(tree([plan("/ws/.gavin-root/plans/a.md", "A")]));
    expect(only.modifiedAt).toBeNull();
  });
});

describe("cardOptions", () => {
  it("keys the cards card_01.. in board order", () => {
    expect(cardOptions(THREE)).toEqual([
      { key: "card_01", card: GIT_TAB },
      { key: "card_02", card: LOGIN },
      { key: "card_03", card: KANBAN },
    ]);
  });

  it("never uses the key the none option holds", () => {
    expect(cardOptions(THREE).map((o) => o.key)).not.toContain("none");
  });

  it("widens the key past 99 cards so the numbering stays aligned", () => {
    const many = Array.from({ length: 120 }, (_, i) => card(`/p/${i}.md`, `Card ${i}`, i));
    const keys = cardOptions(many).map((o) => o.key);
    expect(keys[0]).toBe("card_001");
    expect(keys[119]).toBe("card_120");
  });

  it("holds at most 254 cards, keeping the most recently modified and dropping undated ones first", () => {
    // 255 options is the Choice's ceiling and `none` takes one, so at
    // 254 cards plus one more something has to go: the card nobody has
    // touched in longest.
    const many = Array.from({ length: MAX_CARD_OPTIONS + 1 }, (_, i) => card(`/p/${i}.md`, `Card ${i}`, i + 1));
    many[7] = card("/p/undated.md", "Undated", null);
    const kept = cardOptions(many).map((o) => o.card);
    expect(kept).toHaveLength(MAX_CARD_OPTIONS);
    expect(kept.find((c) => c.path === "/p/undated.md")).toBeUndefined();
    expect(kept.find((c) => c.path === "/p/0.md")).toBeDefined();
    expect(MAX_CARD_OPTIONS).toBe(254);
  });

  it("keeps board order after the cap rather than re-sorting the survivors by date", () => {
    const many = Array.from({ length: MAX_CARD_OPTIONS + 2 }, (_, i) =>
      card(`/p/${i}.md`, `Card ${i}`, (i * 7919) % 1000)
    );
    const kept = cardOptions(many).map((o) => o.card.path);
    const survivors = many.filter((c) => kept.includes(c.path)).map((c) => c.path);
    expect(kept).toEqual(survivors);
  });
});

describe("commitState", () => {
  it("drops the subject line from the message body and keeps the rest", () => {
    const st = commitState("fix(git): a thing", "fix(git): a thing\n\nBecause of a reason.\n", ["a.ts"]);
    expect(st).toEqual({ subject: "fix(git): a thing", body: "Because of a reason.", files: ["a.ts"] });
  });

  it("leaves a body that does not open with the subject alone", () => {
    expect(commitState("subject", "something else entirely", []).body).toBe("something else entirely");
  });

  it("cuts the body at 500 characters and the file list at 12 paths", () => {
    const long = "x".repeat(COMMIT_BODY_CHARS + 50);
    const files = Array.from({ length: COMMIT_FILE_PATHS + 5 }, (_, i) => `f${i}.ts`);
    const st = commitState("s", `s\n\n${long}`, files);
    expect(st.body).toHaveLength(COMMIT_BODY_CHARS);
    expect(st.files).toHaveLength(COMMIT_FILE_PATHS);
    expect(st.files[0]).toBe("f0.ts");
    expect(COMMIT_BODY_CHARS).toBe(500);
    expect(COMMIT_FILE_PATHS).toBe(12);
  });
});

describe("commitLinkRequest", () => {
  it("pins the measured model and names the commit as state", () => {
    const req = commitLinkRequest(commitState("s", "s\n\nb", ["a.ts"]), cardOptions(THREE));
    expect(req.model).toBe("jev-1.13.0");
    expect(req.state).toEqual({ commit: { subject: "s", body: "b", files: ["a.ts"] } });
  });

  it("asks the E5 question verbatim, one criterion per card plus none", () => {
    const req = commitLinkRequest(commitState("s", "s", []), cardOptions(THREE));
    expect(req.questions.card.type).toBe("choice");
    expect(req.questions.card.instructions).toBe(COMMIT_INSTRUCTIONS);
    expect(COMMIT_INSTRUCTIONS).toBe(
      "Each option is a card on a kanban board: a piece of planned work. `commit` is a git commit from the same project. Which card was this commit made for?"
    );
    expect(req.questions.card.criteria).toEqual({
      card_01: "Git tab: history graph",
      card_02: "Fix the login flow",
      card_03: "Kanban drag bug",
      none: COMMIT_NONE,
    });
    expect(COMMIT_NONE).toBe("The commit does not belong to any of these cards.");
  });

  it("sends titles only: no path, no body, no status", () => {
    const req = commitLinkRequest(commitState("s", "s", []), cardOptions(THREE));
    const wire = JSON.stringify(req);
    expect(wire).not.toContain(".gavin-root");
    expect(wire).not.toContain(".md");
  });
});

describe("searchLinkRequest", () => {
  it("is the same Choice over the same options with the query as state", () => {
    const options = cardOptions(THREE);
    const req = searchLinkRequest("history of commits", options);
    expect(req.model).toBe("jev-1.13.0");
    expect(req.state).toEqual({ search_query: "history of commits" });
    expect(req.questions.card.type).toBe("choice");
    expect(req.questions.card.instructions).toBe(SEARCH_INSTRUCTIONS);
    expect(req.questions.card.criteria).toEqual({
      ...commitLinkRequest(commitState("s", "s", []), options).questions.card.criteria,
      none: SEARCH_NONE,
    });
    expect(SEARCH_INSTRUCTIONS).toContain("`search_query`");
  });
});

describe("readCardLink", () => {
  it("links one card at or above the confidence floor", () => {
    expect(read("card_02", 0.9, { card_01: 0.05, card_02: 0.9, card_03: 0.03, none: 0.02 })).toEqual({
      kind: "card",
      card: LOGIN,
      confidence: 0.9,
    });
    expect(read("card_02", CARD_LINK_MIN_CONFIDENCE)?.kind).toBe("card");
    expect(CARD_LINK_MIN_CONFIDENCE).toBe(0.75);
  });

  it("offers the top three cards by probability below the floor, with none left out", () => {
    const link = read("card_03", 0.4, { card_01: 0.3, card_02: 0.05, card_03: 0.35, none: 0.3 });
    expect(link).toEqual({ kind: "candidates", cards: [KANBAN, GIT_TAB, LOGIN] });
    expect(CANDIDATE_COUNT).toBe(3);
  });

  it("offers fewer than three when the rest have no probability at all", () => {
    const link = read("card_01", 0.5, { card_01: 0.5, card_02: 0, card_03: 0, none: 0.5 });
    expect(link).toEqual({ kind: "candidates", cards: [GIT_TAB] });
  });

  it("offers only the chosen card when the answer carries no distribution", () => {
    expect(read("card_01", 0.5)).toEqual({ kind: "candidates", cards: [GIT_TAB] });
  });

  it("shows nothing for none, however confident or unsure", () => {
    expect(read("none", 0.99, { card_01: 0.01, card_02: 0, card_03: 0, none: 0.99 })).toBeNull();
    expect(read("none", 0.3, { card_01: 0.3, card_02: 0.2, card_03: 0.1, none: 0.4 })).toBeNull();
  });

  it("refuses a choice this build did not offer", () => {
    // A key the request never sent cannot be a card; acting on it would
    // be a guess wearing a title.
    expect(read("card_09", 0.95)).toBeNull();
    expect(read("", 0.95)).toBeNull();
  });

  it("refuses a body with no readable answer", () => {
    const options = cardOptions(THREE);
    expect(parseCardAnswer(null, options)).toBeNull();
    expect(parseCardAnswer({}, options)).toBeNull();
    expect(parseCardAnswer({ answers: {} }, options)).toBeNull();
    expect(parseCardAnswer({ answers: { card: { choice: "card_01" } } }, options)).toBeNull();
    expect(parseCardAnswer({ answers: { card: { choice: "card_01", confidence: NaN } } }, options)).toBeNull();
    expect(readCardLink(null, options)).toBeNull();
  });

  it("ignores probabilities that are not numbers rather than ranking on them", () => {
    const link = read("card_01", 0.5, { card_01: 0.5, card_02: "high" as unknown as number, card_03: 0.2, none: 0.3 });
    expect(link).toEqual({ kind: "candidates", cards: [GIT_TAB, KANBAN] });
  });
});

describe("linkedCards", () => {
  it("is the one card, the candidates, or nothing", () => {
    expect(linkedCards({ kind: "card", card: LOGIN, confidence: 0.9 })).toEqual([LOGIN]);
    expect(linkedCards({ kind: "candidates", cards: [KANBAN, GIT_TAB] })).toEqual([KANBAN, GIT_TAB]);
    expect(linkedCards(null)).toEqual([]);
  });
});
